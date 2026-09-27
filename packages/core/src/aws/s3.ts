import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ArtifactsApi } from "../backend/types.ts";
import { accountGuardOf, asHermeticError, awsStatusCode, isAwsError } from "./client.ts";
import { HermeticError } from "../errors.ts";

/** One hour, matching the bootstrap fetch window of §6.2 step 7. */
export const PRESIGN_TTL_SECONDS = 3600;

/**
 * S3 holds versioned `hermeticd` binaries and the rendered per-agent config
 * tarballs (§4.1) — the only source for hermetic's own code (§1). The instance
 * reads them through the gateway endpoint with the instance role; the single
 * presigned URL exists because a stock Ubuntu image cannot sign a request yet.
 */
export class S3Artifacts implements ArtifactsApi {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async putObject(key: string, body: Uint8Array, contentType?: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );
  }

  /**
   * Server-side copy, for the §6.6 recovery archive. `CopySource` is
   * `<bucket>/<key>` and must be URL-encoded: a config tarball's key carries the
   * agent name and a slash, and an unencoded one is how a copy silently lands
   * under the wrong key.
   */
  async copy(fromKey: string, toKey: string): Promise<void> {
    try {
      await this.s3.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: toKey,
          CopySource: `${this.bucket}/${fromKey}`.split("/").map(encodeURIComponent).join("/"),
        }),
      );
    } catch (e) {
      throw asHermeticError(e, `could not copy s3://${this.bucket}/${fromKey} to ${toKey}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (e) {
      if (isAwsError(e, "NotFound", "NoSuchKey") || awsStatusCode(e) === 404) return false;
      throw asHermeticError(e, `could not stat s3://${this.bucket}/${key}`);
    }
  }

  /** Small text objects only — the fleet manifest at the root of the bucket (§1). */
  async getText(key: string): Promise<string | null> {
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = out.Body as { transformToString?: () => Promise<string> } | undefined;
      if (!body?.transformToString) return null;
      return await body.transformToString();
    } catch (e) {
      if (isAwsError(e, "NoSuchKey", "NotFound") || awsStatusCode(e) === 404) return null;
      throw asHermeticError(e, `could not read s3://${this.bucket}/${key}`);
    }
  }

  /**
   * The bytes of one object, for the one caller that needs them: `upgrade
   * --hermeticd V` recomputing the digests of a release it did not push (§3.1).
   */
  async getObject(key: string): Promise<Uint8Array | null> {
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = out.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
      if (!body?.transformToByteArray) return null;
      return await body.transformToByteArray();
    } catch (e) {
      if (isAwsError(e, "NoSuchKey", "NotFound") || awsStatusCode(e) === 404) return null;
      throw asHermeticError(e, `could not read s3://${this.bucket}/${key}`);
    }
  }

  /** Every key under a prefix, paginated. */
  async list(prefix: string): Promise<string[]> {
    return this.listKeys(prefix);
  }

  private async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const out = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = out.NextContinuationToken;
    } while (token);
    return keys;
  }

  async deleteByPrefix(prefix: string): Promise<string[]> {
    const keys = await this.listKeys(prefix);
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
    return keys;
  }

  /**
   * `deleteByPrefix`, for callers that mean it: every *version* and every delete
   * marker under the prefix, not just a new delete marker over the current one.
   *
   * The bucket is versioned (§5), so a plain `DeleteObjects` hides an object
   * and frees nothing — which is exactly wrong for the two callers that prune
   * to reclaim space: the recovery archive keeps one previous version, and the
   * release prune keeps two. Both of them "kept exactly one" while the bucket
   * grew forever. `deleteByPrefix` stays as it is for `destroy`, whose config
   * tarballs are meant to stay recoverable from their versions.
   */
  async purgeByPrefix(prefix: string): Promise<number> {
    let removed = 0;
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      const out = await this.s3.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(keyMarker ? { KeyMarker: keyMarker } : {}),
          ...(versionMarker ? { VersionIdMarker: versionMarker } : {}),
        }),
      );
      const doomed = [...(out.Versions ?? []), ...(out.DeleteMarkers ?? [])]
        .filter(
          (v): v is { Key: string; VersionId: string } =>
            typeof v.Key === "string" &&
            typeof v.VersionId === "string" &&
            // `Prefix` is honoured by the API, but a mistake here would delete
            // the fleet's bucket, so it is checked rather than trusted.
            v.Key.startsWith(prefix),
        )
        .map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
      for (let i = 0; i < doomed.length; i += 1000) {
        await this.s3.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: doomed.slice(i, i + 1000), Quiet: true },
          }),
        );
      }
      removed += doomed.length;
      keyMarker = out.IsTruncated ? out.NextKeyMarker : undefined;
      versionMarker = out.IsTruncated ? out.NextVersionIdMarker : undefined;
    } while (keyMarker !== undefined || versionMarker !== undefined);
    return removed;
  }

  /**
   * §5: the bucket is versioned, so deleting the objects is not enough —
   * `DeleteStack` refuses on `BucketNotEmpty` while any version or delete marker
   * remains. Teardown calls this, and only teardown.
   *
   * `onPage` is the caller's heartbeat, awaited once per page: the sweep runs
   * under the fleet lock and a bucket with enough versions in it pages for long
   * enough to outlive the lock's TTL (§4.4). It is awaited *before* each page's
   * deletes, so a heartbeat that throws stops the sweep with that page's
   * versions still there rather than after removing them without the lock.
   */
  async emptyBucket(onPage?: () => Promise<void>): Promise<number> {
    let removed = 0;
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      await onPage?.();
      const out = await this.s3.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          ...(keyMarker ? { KeyMarker: keyMarker } : {}),
          ...(versionMarker ? { VersionIdMarker: versionMarker } : {}),
        }),
      );
      const doomed = [...(out.Versions ?? []), ...(out.DeleteMarkers ?? [])]
        .filter(
          (v): v is { Key: string; VersionId: string } =>
            typeof v.Key === "string" && typeof v.VersionId === "string",
        )
        .map((v) => ({ Key: v.Key, VersionId: v.VersionId }));

      for (let i = 0; i < doomed.length; i += 1000) {
        await this.s3.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: doomed.slice(i, i + 1000), Quiet: true },
          }),
        );
      }
      removed += doomed.length;
      keyMarker = out.IsTruncated ? out.NextKeyMarker : undefined;
      versionMarker = out.IsTruncated ? out.NextVersionIdMarker : undefined;
    } while (keyMarker !== undefined || versionMarker !== undefined);
    return removed;
  }

  async presign(key: string, expiresInSeconds: number = PRESIGN_TTL_SECONDS): Promise<string> {
    /**
     * `getSignedUrl` signs from the client's credentials and config directly; it
     * never calls `send`, so the proxy `aws.client()` wraps `send` in cannot see
     * it. A presigned URL is a bearer credential for an object in *some*
     * account, and minting one for the wrong account and pasting it into
     * user-data is exactly what §4.7 exists to prevent — so the guard is awaited
     * here explicitly rather than assumed to have run already.
     */
    const guard = accountGuardOf(this.s3);
    if (!guard) {
      throw new HermeticError(
        "INTERNAL",
        "the S3 client was not built by aws.client(); it carries no account guard",
        {},
      );
    }
    await guard();

    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.s3 as never, command as never, { expiresIn: expiresInSeconds });
  }
}
