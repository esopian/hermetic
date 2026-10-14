import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { abortableSleep } from "../abort.ts";
import { agentParamPath } from "../backend/constants.ts";
import type { CoreContext } from "../context.ts";
import { HermeticError } from "../errors.ts";
import { evt } from "../events.ts";
import {
  type FileRequest,
  type FilesFulfilResult,
  FilesPutInput,
  type FilesPutEvent,
  type FilesPutProgressEvent,
} from "../schema/index.ts";
import {
  FILES_LIMITS,
  acceptMatches,
  encodeSecretEnvelope,
  envSecretSlot,
  fileSecretSlot,
  looksLikeKeyMaterial,
  requestFileName,
  secretEnvelopeFits,
  secretTextSlug,
  sniffMime,
} from "../shared/files.ts";
import { validateName } from "../shared/naming.ts";
import { parseSecretEnv } from "../shared/secret-env.ts";
import { requestStateRefusal, secretTextRefusal } from "./errors.ts";
import {
  aborted,
  fileChunks,
  formatBytes,
  nameFor,
  pump,
  readError,
  readHead,
  statFile,
  throttled,
} from "./stage.ts";
import { collectStream, peekHead } from "./stream-source.ts";
import type { UploadRegistry } from "./uploads.ts";

/**
 * `files.put` (§9): answer a request the agent opened — `request_file` with a
 * file, `request_secret` with text — from a path on this laptop or an upload
 * the registry holds (a webview drop, the native dialog, the CLI's stdin).
 *
 * The slot is read from the box first, so what the box will accept decides
 * what this sends, never the agent's own description of it. Then one of four
 * lanes:
 *
 * - **text secret, durable**: parsed here with the same parser the box runs,
 *   refused before anything leaves if it fails (D10: an unrequested key is an
 *   error, not something dropped), and the *canonical* `KEY="…"` form written
 *   to the agent's `env-<slug>` SSM slot; the box is then told to read it.
 * - **text secret, just this once**: parsed here too, but the operator's
 *   original bytes go to the box with the "Treat as" header; the box parses
 *   them authoritatively into its tmpfs.
 * - **file secret, durable**: the file's bytes to a `file-<slug>` SSM slot, in
 *   the envelope the box decodes; too large for one is refused, with the
 *   advice to send it just this once.
 * - **anything else**: uploaded to the box, which puts a secret (asked for, or
 *   forced by a key-shaped head, D6) in its tmpfs drop and a file in the inbox.
 *
 * Every buffer that held secret bytes is zeroed once it is done with, success
 * or failure, and the registry entry it came from is forgotten — also when the
 * put fails before the source is read (the box unreachable, the slot closed),
 * and whenever the source is text this process held (`registerBytes`). A plain
 * file's upload alone stays registered after a failure, so it can be retried.
 * A durable secret written to SSM that the box then refuses is deleted again
 * when the write created the parameter and the box conclusively did not take
 * it (a stop or a lost answer can come after the box took it, or while it is
 * still `receiving`: then the put waits a bounded while, and keeps the
 * parameter unless the slot is `open` again, declined, expired or answered
 * from another slot); when it replaced one, the refusal says so, since the box loads that slot at
 * its next apply or boot. A slot that already holds a secret is replaced only
 * when the put says so (`replace`); otherwise the put is refused with
 * `CONFLICT` and `replace_required` before anything is written, and a native
 * pick's upload (a path, no bytes) is kept for the retry. A secret sent just this once that the box files as
 * anything but a secret is deleted from the box and refused. A JS string —
 * the envelope handed to SSM, a parsed value — cannot be zeroed; those are
 * dropped and left to the collector.
 *
 * No message or progress event names the file or repeats a value.
 */

export interface PutDeps {
  ctx: CoreContext;
  uploads: UploadRegistry;
  /**
   * How often, and for how long, a durable secret's request is re-read after
   * the box's answer was lost while the slot is still `receiving`
   * (`settleSecret`). Defaults to `SECRET_SETTLE_INTERVAL_MS` and
   * `SECRET_SETTLE_TIMEOUT_MS`; a test shortens both.
   */
  secretSettle?: { intervalMs: number; timeoutMs: number };
}

/** Between two reads of a request the box is still `receiving`. */
export const SECRET_SETTLE_INTERVAL_MS = 250;
/**
 * The most a failed or stopped durable put waits for the box to finish with a
 * request it is `receiving`. The box's part is one SSM read and one tmpfs
 * write, so it settles well inside this; past it, the parameter stays.
 */
export const SECRET_SETTLE_TIMEOUT_MS = 10_000;

/**
 * What became of a durable secret whose `/secret` call failed or was stopped:
 * `taken` (the box holds the request fulfilled from this slot), `refused` (the
 * box conclusively did not take it: the slot is `open` again, declined,
 * expired, or answered from another slot), `pending` (still `receiving` when
 * the wait ran out), `unknown` (the slot could not be read).
 */
type SecretSettle = "taken" | "refused" | "pending" | "unknown";

/** What a put reads, once resolved. */
type Source =
  | { kind: "bytes"; name: string; size: number; bytes: Uint8Array }
  | { kind: "path"; name: string; size: number; path: string }
  | { kind: "stream"; name: string; size: number; body: AsyncIterable<Uint8Array> };

function parseInput(input: unknown): FilesPutInput {
  const result = FilesPutInput.safeParse(input);
  if (!result.success) {
    throw new HermeticError("VALIDATION", "files put input does not validate", {
      issues: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    });
  }
  const parsed = result.data;
  if (parsed.not_secret && parsed.secret) {
    throw new HermeticError("VALIDATION", "a file cannot be both a secret and not a secret");
  }
  if (parsed.not_secret && parsed.ephemeral) {
    throw new HermeticError("VALIDATION", "only a secret can be sent just this once");
  }
  return parsed;
}

/** A small file read whole: a secret, which is never streamed past this process. */
async function readWhole(src: Source, limit: number, instance: string): Promise<Uint8Array> {
  if (src.size > limit) throw tooLarge(instance, src.size, limit);
  if (src.kind === "bytes") return src.bytes;
  if (src.kind === "stream") return await collectStream(src.body, src.size);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(src.path));
  } catch (e) {
    throw readError(e);
  }
  if (bytes.byteLength !== src.size) {
    bytes.fill(0);
    throw new HermeticError("CONFLICT", "the file changed while it was being read; send it again");
  }
  return bytes;
}

function tooLarge(instance: string, size: number, limit: number, advice = ""): HermeticError {
  return new HermeticError(
    "FILE_TOO_LARGE",
    `${instance}: the file is ${formatBytes(size)}; this request takes at most ${formatBytes(limit)}${advice}`,
    { name: instance, size, limit },
  );
}

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The slot's text-secret stem: the box's `slug`, or (a slot from before slugs) what it derives. */
function textSlug(slot: FileRequest): string {
  return slot.slug ?? secretTextSlug(slot.keys ?? []);
}

/** Whether a put's source and slot make it a secret: its upload is never kept for a retry. */
interface Lane {
  secret: boolean;
}

/**
 * The box refused a durable secret after its envelope reached SSM. A parameter
 * the write created is deleted, so the box does not load at its next boot what
 * the operator was told failed; one the write replaced cannot be put back (the
 * old value is never read), so the refusal says the stored secret changed.
 */
function afterSsmRefusal(
  e: unknown,
  outcome: "removed" | "replaced" | "kept" | "taken" | "pending" | "unknown",
): unknown {
  if (outcome === "removed") return e;
  const note = {
    replaced: "; the stored secret was replaced, and the box loads it at its next apply or boot",
    taken: "; the box had already taken the secret, so it stays stored in SSM",
    pending:
      "; the box was still taking the secret, so it may have been delivered; it stays stored in SSM, and the box loads it at its next apply or boot",
    unknown:
      "; whether the box took the secret could not be checked, so it stays stored in SSM, and the box loads it at its next apply or boot",
    kept: "; the secret could not be removed from SSM, and the box loads it at its next apply or boot",
  }[outcome];
  const base = e instanceof HermeticError ? e : null;
  return new HermeticError(
    base?.code ?? "INTERNAL",
    `${base?.message ?? "the box did not take the secret"}${note}`,
    { ...(base?.details ?? {}), ssm: outcome },
  );
}

/**
 * A durable secret's slot already holds one, and the put did not say to
 * replace it. Names the slot only — never the dropped file's name, never a
 * value — and `replace_required` tells a head to ask before it sends again.
 * The message is head-neutral: each head adds how to say yes (the CLI's
 * `--replace`, the app's Replace button).
 */
function replaceRequired(instance: string, ssmSlot: string): HermeticError {
  return new HermeticError(
    "CONFLICT",
    `A stored secret ${ssmSlot} already exists on ${instance}. Replace it?`,
    { ssm_slot: ssmSlot, replace_required: true },
  );
}

export function createFilesPut(deps: PutDeps) {
  const { ctx, uploads } = deps;
  const settle = deps.secretSettle ?? {
    intervalMs: SECRET_SETTLE_INTERVAL_MS,
    timeoutMs: SECRET_SETTLE_TIMEOUT_MS,
  };

  async function resolve(input: FilesPutInput): Promise<Source> {
    if ("path" in input.source) {
      const path = input.source.path;
      const size = await statFile(path);
      return { kind: "path", name: nameFor(basename(path)), size, path };
    }
    const source = uploads.take(input.source.chunk_upload_id);
    if (source.kind === "path") {
      return {
        kind: "path",
        name: nameFor(source.name),
        size: source.size,
        path: source.path,
      };
    }
    if (source.kind === "stream") {
      return { kind: "stream", name: nameFor(source.name), size: source.size, body: source.body };
    }
    return {
      kind: "bytes",
      name: nameFor(source.name),
      size: source.size,
      bytes: source.bytes,
    };
  }

  function progress(phase: string, at: number, message: string): FilesPutProgressEvent {
    return { type: "progress", ...evt(phase, at, message, ctx.nowIso()) };
  }

  /**
   * Write a durable secret's envelope to the agent's slot, then have the box
   * read it. A slot that already holds a secret is written over only when the
   * operator said so (`replace`): the old value is never read, so it cannot be
   * put back, and the box loads the new one at its next apply or boot.
   */
  async function viaSsm(
    instance: string,
    slot: FileRequest,
    ssmSlot: string,
    name: string,
    bytes: Uint8Array,
    signal: AbortSignal,
    replace: boolean,
    format?: "raw" | "dotenv",
  ): Promise<FilesFulfilResult> {
    const path = agentParamPath(ctx.fleetId(), instance, ssmSlot);
    // Names only (no decryption): whether this replaces a stored secret, and
    // whether a refusal below may delete what it wrote.
    const existed = await ctx.backend.secrets.exists(path);
    if (existed && !replace) throw replaceRequired(instance, ssmSlot);
    aborted(signal);
    const envelope = encodeSecretEnvelope({ name, bytes, sha256: sha256Of(bytes) });
    // Without `replace`, SSM refuses a slot written since the check above, so
    // a secret stored between the two is still asked about, never written over.
    try {
      await ctx.backend.secrets.put(path, envelope, { overwrite: replace });
    } catch (e) {
      if (!replace && e instanceof HermeticError && e.details?.["already_exists"] === true) {
        throw replaceRequired(instance, ssmSlot);
      }
      throw e;
    }
    try {
      return await ctx.backend.files.secret(
        instance,
        slot.request_id,
        { ssm_slot: ssmSlot, name, ...(format ? { format } : {}) },
        { signal },
      );
    } catch (thrown) {
      // A stop is reported as one here, so the note below survives `put`'s own mapping.
      const e =
        signal.aborted && !(thrown instanceof HermeticError && thrown.code === "ABORTED")
          ? new HermeticError("ABORTED", "the file transfer was stopped")
          : thrown;
      if (existed) throw afterSsmRefusal(e, "replaced");
      // A stop, or an answer lost on the way back, may come after the box
      // already took the secret, or while it is still taking it (the box does
      // not stop its own work when the call is dropped): then the parameter
      // is what backs its tmpfs copy at the next apply or boot, and stays.
      // Only a box that conclusively did not take it lets the parameter go.
      const settled = await settleSecret(instance, slot.request_id, ssmSlot);
      if (settled !== "refused") throw afterSsmRefusal(e, settled);
      let outcome: "removed" | "kept" = "removed";
      try {
        await ctx.backend.secrets.delete(path);
      } catch {
        outcome = "kept";
      }
      throw afterSsmRefusal(e, outcome);
    }
  }

  /**
   * What the box made of a durable secret whose `/secret` answer never came
   * back (`SecretSettle`). A slot still `receiving` is read again every
   * `intervalMs` until it leaves that state or `timeoutMs` runs out.
   *
   * The wait runs on its own deadline, never the put's signal: that signal may
   * be the very stop being cleaned up after, and the box does not see it, so
   * the stop does not change what the box does. The deadline bounds a stopped
   * put's wait as well as a failed one's, and each read is cut off with it. A
   * read that fails ends the wait at once (the box is likely unreachable, and
   * another read would only fail again); either way the parameter stays.
   */
  async function settleSecret(
    instance: string,
    requestId: string,
    ssmSlot: string,
  ): Promise<SecretSettle> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), settle.timeoutMs);
    let seenReceiving = false;
    try {
      for (;;) {
        let now: FileRequest;
        try {
          now = await ctx.backend.files.request(instance, requestId, { signal: deadline.signal });
        } catch {
          return seenReceiving ? "pending" : "unknown";
        }
        if (now.state !== "open" && now.fulfilled?.ssm_slot === ssmSlot) return "taken";
        if (now.state !== "receiving") return "refused";
        seenReceiving = true;
        await abortableSleep(settle.intervalMs, deadline.signal);
        if (deadline.signal.aborted) return "pending";
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A secret sent just this once must land in the box's tmpfs drop. Should the
   * box have filed it as anything else — in the inbox, on the data volume —
   * the entry is deleted again and the put refused: key material is never
   * left there on the strength of a success.
   */
  async function onlyAsSecret(
    instance: string,
    slot: FileRequest,
    result: FilesFulfilResult,
  ): Promise<FilesFulfilResult> {
    if (result.class === "secret") return result;
    let removed = false;
    try {
      const listed = await ctx.backend.files.list(instance, {});
      const filed = listed.inbox.find(
        (e) => e.path === result.path || (e.request_id === slot.request_id && e.dir === "inbox"),
      );
      if (filed) {
        await ctx.backend.files.remove(instance, filed.id, {});
        removed = true;
      }
    } catch {
      removed = false;
    }
    throw new HermeticError(
      "INTERNAL",
      removed
        ? `${instance}: the box filed the secret as a normal file; it was deleted again. Ask ${instance} to request it again.`
        : `${instance}: the box filed the secret as a normal file, and it could not be deleted; remove it from the agent's inbox. Ask ${instance} to request it again.`,
      { name: instance, removed },
    );
  }

  /** `request_secret`: parse first, then SSM (durable) or the box's own parse (just this once). */
  async function* putText(
    instance: string,
    input: FilesPutInput,
    slot: FileRequest,
    src: Source,
    held: Uint8Array[],
    signal: AbortSignal,
  ): AsyncGenerator<FilesPutEvent, { result: FilesFulfilResult; ssm_slot?: string }> {
    yield progress("read", 0, "reading the secret");
    const bytes = await readWhole(src, FILES_LIMITS.secretTextBytes, instance);
    held.push(bytes);
    const keys = slot.keys ?? [];
    const parsed = parseSecretEnv(
      bytes,
      { keys, optional_keys: slot.optional_keys ?? [], maxBytes: FILES_LIMITS.secretTextBytes },
      input.as ?? "auto",
    );
    // D10: refused here, before a byte reaches SSM or the box.
    if (!parsed.ok) throw secretTextRefusal(instance, parsed.errors);
    const name = `${textSlug(slot)}.env`;
    const durable = slot.durable && input.ephemeral !== true;
    aborted(signal);
    if (!durable) {
      yield progress("upload", 0.5, `sending ${parsed.entries.length} key(s) for this once`);
      const result = await ctx.backend.files.fulfil(
        instance,
        slot.request_id,
        { fileName: name, size: bytes.byteLength, body: bytes, sha256: sha256Of(bytes) },
        { signal, ...(input.as ? { secretAs: input.as } : {}) },
      );
      return { result };
    }
    const canonical = new TextEncoder().encode(parsed.canonical);
    held.push(canonical);
    if (!secretEnvelopeFits(name, canonical.byteLength)) {
      throw tooLarge(
        instance,
        canonical.byteLength,
        FILES_LIMITS.secretDurableBytes,
        "; send it just this once instead (--ephemeral)",
      );
    }
    const ssm_slot = envSecretSlot(textSlug(slot));
    yield progress("ssm", 0.5, `storing ${parsed.entries.length} key(s) in SSM`);
    const result = await viaSsm(
      instance,
      slot,
      ssm_slot,
      name,
      canonical,
      signal,
      input.replace === true,
      parsed.format,
    );
    return { result, ssm_slot };
  }

  /** `request_file`: a secret to SSM or the tmpfs drop, anything else uploaded with progress. */
  async function* putFile(
    instance: string,
    input: FilesPutInput,
    slot: FileRequest,
    resolved: Source,
    held: Uint8Array[],
    controller: AbortController,
    lane: Lane,
  ): AsyncGenerator<FilesPutEvent, { result: FilesFulfilResult; ssm_slot?: string }> {
    const signal = controller.signal;
    // A streamed body is read only as far as the checks need: the page's
    // request stays blocked behind them, and a secret is collected whole below
    // from a body that replays what was read.
    let src = resolved;
    let head: Uint8Array;
    if (resolved.kind === "stream") {
      const peeked = await peekHead(resolved.body, FILES_LIMITS.sniffBytes);
      src = { ...resolved, body: peeked.body };
      head = peeked.head;
    } else if (resolved.kind === "bytes") {
      head = resolved.bytes.subarray(0, FILES_LIMITS.sniffBytes);
    } else {
      head = await readHead(resolved.path);
    }
    const mime = sniffMime(head, src.name);
    const keyLike = looksLikeKeyMaterial(head, src.name);
    const secret =
      slot.sensitivity === "secret" || input.secret === true || (keyLike && input.not_secret !== true);
    // Before any refusal below: key material (D6) is forgotten on failure too.
    if (secret) lane.secret = true;
    if (!acceptMatches(slot.accept, src.name, mime)) {
      throw new HermeticError(
        "FILE_TYPE_REJECTED",
        `${instance}: this request accepts ${slot.accept.join(" ")}; the file is ${mime}`,
        { name: instance, mime },
      );
    }
    // A secret slot's own `durable` decides: `durable: false` is the agent
    // asking for a secret that does not outlive the request, and the box
    // refuses such a slot an SSM fulfil. A normal slot is never durable, but
    // the operator may still keep what they send to it (`--secret`).
    const durable =
      input.ephemeral !== true &&
      (slot.sensitivity === "secret" ? slot.durable : input.secret === true || slot.durable);
    // The name the box files it under: the slot's hint when it agrees with the
    // dropped file on what was checked above (`requestFileName`), else the dropped name.
    const stored = requestFileName(slot, src.name, mime);
    if (input.ephemeral === true && !secret) {
      throw new HermeticError("VALIDATION", "only a secret can be sent just this once; add --secret", {
        name: instance,
      });
    }

    if (secret && durable) {
      if (!secretEnvelopeFits(stored, src.size)) {
        throw tooLarge(
          instance,
          src.size,
          FILES_LIMITS.secretDurableBytes,
          "; send it just this once instead (--ephemeral)",
        );
      }
      yield progress("read", 0, "reading the secret");
      const bytes = await readWhole(src, FILES_LIMITS.secretDurableBytes, instance);
      held.push(bytes);
      const ssm_slot = fileSecretSlot(stored);
      yield progress("ssm", 0.5, "storing the secret in SSM");
      const result = await viaSsm(
        instance,
        slot,
        ssm_slot,
        stored,
        bytes,
        signal,
        input.replace === true,
      );
      return { result, ssm_slot };
    }

    if (secret) {
      // Just this once: the box keeps a secret out of the data volume only when
      // the slot is a secret one or the bytes look like a key (D6). Anything
      // else it would file in the inbox, which is not what the operator chose.
      if (slot.sensitivity !== "secret" && !keyLike) {
        throw new HermeticError(
          "VALIDATION",
          `${instance}: this request is for a normal file; to keep it as a secret, store it durably (drop --ephemeral)`,
          { name: instance },
        );
      }
      yield progress("read", 0, "reading the secret");
      const bytes = await readWhole(
        src,
        Math.min(slot.max_bytes, FILES_LIMITS.secretEphemeralBytes),
        instance,
      );
      held.push(bytes);
      yield progress("upload", 0.5, "sending the secret for this once");
      const result = await ctx.backend.files.fulfil(
        instance,
        slot.request_id,
        { fileName: stored, size: bytes.byteLength, body: bytes, sha256: sha256Of(bytes) },
        { signal },
      );
      return { result: await onlyAsSecret(instance, slot, result) };
    }

    if (src.size > slot.max_bytes) throw tooLarge(instance, src.size, slot.max_bytes);
    // A streamed body has no digest ahead of its bytes: the box hashes it.
    let sha256: string | undefined;
    if (src.kind === "stream") {
      sha256 = undefined;
    } else if (src.kind === "bytes") {
      sha256 = sha256Of(src.bytes);
    } else {
      const path = src.path;
      sha256 = yield* pump(controller, async (emit) => {
        const step = throttled(emit, "hash", 0, 0.2, src.size, "checked", ctx.nowIso);
        const hash = createHash("sha256");
        let seen = 0;
        for await (const chunk of fileChunks(path, src.size, signal)) {
          hash.update(chunk);
          seen += chunk.byteLength;
          step(seen);
        }
        return hash.digest("hex");
      });
    }
    const from = src.kind === "path" ? 0.2 : 0;
    const result: FilesFulfilResult = yield* pump(controller, async (emit) => {
      const step = throttled(emit, "upload", from, 1, src.size, "sent", ctx.nowIso);
      step(0);
      return await ctx.backend.files.fulfil(
        instance,
        slot.request_id,
        {
          fileName: stored,
          size: src.size,
          body:
            src.kind === "stream"
              ? src.body
              : src.kind === "bytes"
                ? src.bytes
                : fileChunks(src.path, src.size, signal),
          ...(sha256 !== undefined ? { sha256 } : {}),
        },
        { signal, onProgress: step, ...(input.not_secret ? { notSecret: true } : {}) },
      );
    });
    return { result };
  }

  /**
   * `files.put`. Input is checked before the stream is returned, so a head gets
   * a `VALIDATION` refusal rather than a stream that fails on its first read.
   */
  function put(input: unknown, opts: { signal?: AbortSignal } = {}): AsyncIterable<FilesPutEvent> {
    const parsed = parseInput(input);
    validateName(parsed.instance);
    const instance = parsed.instance;
    // Taken up front, so a put that fails before the source is read can still
    // forget an upload that may hold a secret.
    const upload_id = "chunk_upload_id" in parsed.source ? parsed.source.chunk_upload_id : null;
    const origin = upload_id === null ? null : uploads.origin(upload_id);
    return (async function* (): AsyncGenerator<FilesPutEvent> {
      const controller = new AbortController();
      const onOuterAbort = (): void => controller.abort();
      opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
      if (opts.signal?.aborted) controller.abort();
      const signal = controller.signal;
      // Every buffer that held secret bytes, zeroed on the way out. A plain
      // file's bytes are not in here: its upload stays retryable.
      const held: Uint8Array[] = [];
      // Bytes this process held (the CLI's stdin) are text the operator typed
      // or pasted: treated as a secret from the start, whatever the slot says.
      const lane: Lane = { secret: origin === "held" || origin === "secret_text" };
      let slot: FileRequest | null = null;
      let src: Source | null = null;
      let ok = false;
      let replaceAsked = false;
      try {
        aborted(signal);
        await ctx.guardFleet();
        await ctx.getAgent(instance);
        slot = await ctx.backend.files.request(instance, parsed.request_id, { signal });
        if (slot.kind === "secret_text" || slot.sensitivity === "secret" || parsed.secret === true) {
          lane.secret = true;
        }
        if (slot.state !== "open") throw requestStateRefusal(slot.state, instance);
        if (origin === "secret_text" && slot.kind !== "secret_text") {
          throw new HermeticError(
            "VALIDATION",
            "text input can only answer a text secret request; use a file for this request",
            { name: instance },
          );
        }
        src = await resolve(parsed);
        const done =
          slot.kind === "secret_text"
            ? yield* putText(instance, parsed, slot, src, held, signal)
            : yield* putFile(instance, parsed, slot, src, held, controller, lane);
        ok = true;
        yield {
          type: "fulfilled",
          result: done.result,
          ...(done.ssm_slot ? { ssm_slot: done.ssm_slot } : {}),
        };
      } catch (e) {
        if (signal.aborted && !(e instanceof HermeticError && e.code === "ABORTED")) {
          throw new HermeticError("ABORTED", "the file transfer was stopped");
        }
        replaceAsked = e instanceof HermeticError && e.details?.["replace_required"] === true;
        throw e;
      } finally {
        opts.signal?.removeEventListener("abort", onOuterAbort);
        // A plain file's upload stays registered after a failure so it can be
        // retried, as with `files.stage`. Anything secret — or anything whose
        // slot was never read, so it may have been — is forgotten either way,
        // and the copy `take` handed over zeroed. One exception: a native
        // pick holds no bytes, only where the file is, so when the put stopped
        // to ask before replacing a stored secret it stays registered for the
        // head's "Replace" to send again (its "Cancel" discards it).
        const sensitive = slot === null || lane.secret || held.length > 0;
        const keptToAsk = replaceAsked && origin === "path";
        if (upload_id !== null && (ok || sensitive || origin === "stream") && !keptToAsk)
          uploads.discard(upload_id);
        if (sensitive && src?.kind === "bytes") src.bytes.fill(0);
        for (const b of held) b.fill(0);
      }
    })();
  }

  return { put };
}
