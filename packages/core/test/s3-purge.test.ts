import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  S3Client,
  type DeleteObjectsCommandInput,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { S3Artifacts } from "../src/aws/s3.ts";
import { MemoryBackend } from "../src/backend/memory.ts";
import { HermeticError } from "../src/errors.ts";

/**
 * `purgeByPrefix` is the version-aware delete: in a versioned bucket (§5) a
 * plain delete only writes a marker, and the lifecycle rule keeps the three
 * newest noncurrent versions of every key for good. These pin the parts that
 * make it a purge — every version *and* every delete marker, across listing
 * pages, in batches S3 will accept — and that a per-key refusal is not
 * reported as success.
 */

const s3 = mockClient(S3Client);
const BUCKET = "hermetic-bucket";

beforeEach(() => s3.reset());
afterAll(() => s3.restore());

function artifacts(): S3Artifacts {
  return new S3Artifacts(new S3Client({ region: "us-west-2" }), BUCKET);
}

function deleted(): Array<{ Key?: string; VersionId?: string }> {
  return s3
    .commandCalls(DeleteObjectsCommand)
    .flatMap((c) => (c.args[0].input as DeleteObjectsCommandInput).Delete?.Objects ?? []);
}

describe("S3Artifacts.purgeByPrefix", () => {
  test("deletes every version and delete marker under the prefix, by VersionId", async () => {
    s3.on(ListObjectVersionsCommand).resolves({
      IsTruncated: false,
      Versions: [
        { Key: "config/atlas/config.tar.gz", VersionId: "v3" },
        { Key: "config/atlas/config.tar.gz", VersionId: "v2" },
        { Key: "config/atlas/config.tar.gz", VersionId: "v1" },
      ],
      DeleteMarkers: [{ Key: "config/atlas/config.tar.gz", VersionId: "dm1" }],
    });
    s3.on(DeleteObjectsCommand).resolves({});

    expect(await artifacts().purgeByPrefix("config/atlas/")).toBe(4);

    const list = s3.commandCalls(ListObjectVersionsCommand)[0]?.args[0].input;
    expect(list).toMatchObject({ Bucket: BUCKET, Prefix: "config/atlas/" });
    expect(deleted()).toEqual([
      { Key: "config/atlas/config.tar.gz", VersionId: "v3" },
      { Key: "config/atlas/config.tar.gz", VersionId: "v2" },
      { Key: "config/atlas/config.tar.gz", VersionId: "v1" },
      { Key: "config/atlas/config.tar.gz", VersionId: "dm1" },
    ]);
  });

  test("follows KeyMarker/VersionIdMarker across pages and batches at 1000", async () => {
    const page1 = Array.from({ length: 1500 }, (_, i) => ({
      Key: `config/atlas/k${i}`,
      VersionId: `a${i}`,
    }));
    s3.on(ListObjectVersionsCommand)
      .resolvesOnce({
        IsTruncated: true,
        NextKeyMarker: "config/atlas/k1499",
        NextVersionIdMarker: "a1499",
        Versions: page1,
      })
      .resolvesOnce({
        IsTruncated: false,
        DeleteMarkers: [{ Key: "config/atlas/k0", VersionId: "dm0" }],
      });
    s3.on(DeleteObjectsCommand).resolves({});

    expect(await artifacts().purgeByPrefix("config/atlas/")).toBe(1501);

    const lists = s3.commandCalls(ListObjectVersionsCommand).map((c) => c.args[0].input);
    expect(lists).toHaveLength(2);
    expect(lists[0]).not.toHaveProperty("KeyMarker");
    expect(lists[1]).toMatchObject({
      KeyMarker: "config/atlas/k1499",
      VersionIdMarker: "a1499",
    });
    const batches = s3
      .commandCalls(DeleteObjectsCommand)
      .map((c) => (c.args[0].input as DeleteObjectsCommandInput).Delete?.Objects?.length);
    expect(batches).toEqual([1000, 500, 1]);
  });

  test("never deletes a key outside the prefix, even if the listing returns one", async () => {
    s3.on(ListObjectVersionsCommand).resolves({
      IsTruncated: false,
      Versions: [
        { Key: "config/atlas/config.tar.gz", VersionId: "v1" },
        { Key: "config/atlas2/config.tar.gz", VersionId: "v1" },
        { Key: "manifest.json", VersionId: "m1" },
      ],
    });
    s3.on(DeleteObjectsCommand).resolves({});

    expect(await artifacts().purgeByPrefix("config/atlas/")).toBe(1);
    expect(deleted()).toEqual([{ Key: "config/atlas/config.tar.gz", VersionId: "v1" }]);
  });

  test("a per-key Errors entry in a 200 response is a HermeticError, not a success", async () => {
    s3.on(ListObjectVersionsCommand).resolves({
      IsTruncated: false,
      Versions: [
        { Key: "config/atlas/config.tar.gz", VersionId: "v2" },
        { Key: "config/atlas/config.tar.gz", VersionId: "v1" },
      ],
    });
    s3.on(DeleteObjectsCommand).resolves({
      Errors: [
        {
          Key: "config/atlas/config.tar.gz",
          VersionId: "v1",
          Code: "AccessDenied",
          Message: "Access Denied",
        },
      ],
    });

    const err = await artifacts()
      .purgeByPrefix("config/atlas/")
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(HermeticError);
    const he = err as HermeticError;
    expect(he.code).toBe("INTERNAL");
    expect(he.message).toContain("AccessDenied");
    expect(he.details).toMatchObject({
      aws_error: "AccessDenied",
      removed: 1,
      failed: [{ key: "config/atlas/config.tar.gz", version_id: "v1", code: "AccessDenied" }],
    });
  });

  test("a listing that throws is a HermeticError carrying the AWS name", async () => {
    s3.on(ListObjectVersionsCommand).rejects(
      Object.assign(new Error("denied"), { name: "AccessDenied" }),
    );
    const err = await artifacts()
      .purgeByPrefix("config/atlas/")
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(HermeticError);
    expect((err as HermeticError).details).toMatchObject({ aws_error: "AccessDenied" });
    expect(s3.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
  });
});

describe("MemoryBackend artifacts.purgeByPrefix", () => {
  test("removes exactly the objects under the prefix and counts them", async () => {
    const backend = new MemoryBackend();
    const bytes = new Uint8Array([1]);
    await backend.artifacts.putObject("config/atlas/config.tar.gz", bytes);
    await backend.artifacts.putObject("config/atlas/extra", bytes);
    await backend.artifacts.putObject("config/atlas2/config.tar.gz", bytes);

    expect(await backend.artifacts.purgeByPrefix("config/atlas/")).toBe(2);
    expect(await backend.artifacts.exists("config/atlas/config.tar.gz")).toBe(false);
    expect(await backend.artifacts.exists("config/atlas2/config.tar.gz")).toBe(true);
    expect(backend.mutations).toContain("artifacts.purgeByPrefix");
    expect(await backend.artifacts.purgeByPrefix("config/atlas/")).toBe(0);
  });
});
