/**
 * Request slots: the agent asks for a file (`request_file`), a human answers.
 *
 *     open ──PUT──▶ receiving ──digest ✓ accept ✓──▶ fulfilled ──consume──▶ consumed
 *       ▲               │
 *       └──rejected─────┘   (digest ✗ / type ✗ / size ✗: the slot stays open)
 *     open ──decline──▶ declined        open ──ttl──▶ expired
 *
 * Only the plugin socket opens a slot, and only the tailnet fills or declines
 * one, so the agent can never answer its own request: a request always ends
 * with a human. `receiving` is the lock that makes one slot one file — a
 * second upload while the first is in flight is refused, not raced.
 *
 * The lock is backed by a claim on the slot's id (`FilesStore.claim`), whose
 * signal the upload reads under. A slot `receiving` for longer than
 * `FILES_TTL.receivingMax`, or with no live claim behind it, is reclaimed: the
 * upload is aborted and the slot is `open` again (`reclaimStalled`). With the
 * per-read idle timeout (`MeteredBody`) that bounds how long one client can
 * hold a slot, however slowly it sends.
 */
import type {
  FileRequest,
  FileWaitResult,
  OpenFileRequestBody,
  OpenSecretRequestBody,
} from "@hermetic/core/schema";
import {
  FILES_LIMITS,
  FILES_TTL,
  SECRET_TEXT_MAX_KEYS,
  newRequestId,
  secretTextSlug,
} from "@hermetic/core/shared";
import { FilesError } from "./errors.ts";
import { type FilesCtx, isDue, isoAfter, nowIso, waitResult } from "./context.ts";
import type { Claim, FilesIndex } from "./store.ts";

/**
 * The byte cap a slot's class allows: 1 MiB for an ephemeral secret, the
 * fleet's `files.max_bytes` (`fileCap`, the 256 MiB default unless a fleet
 * lowered it) otherwise.
 */
export function classCap(
  sensitivity: FileRequest["sensitivity"],
  fileCap: number = FILES_LIMITS.fileBytes,
): number {
  return sensitivity === "secret" ? FILES_LIMITS.secretEphemeralBytes : fileCap;
}

function find(index: FilesIndex, id: string): FileRequest {
  const request = index.requests.find((r) => r.request_id === id);
  if (!request) throw new FilesError("FILE_NOT_FOUND", "no such request on this box");
  return request;
}

/**
 * Mark a slot `expired` if its TTL has passed and nothing has filled it.
 * `true` when it changed, so the caller wakes the slot's waiters.
 */
export function expireIfDue(ctx: FilesCtx, request: FileRequest): boolean {
  // Only an `open` slot expires. One mid-upload is left to finish; its own
  // completion is what decides it.
  if (request.state !== "open" || !isDue(ctx.host, request.expires_at)) return false;
  request.state = "expired";
  return true;
}

/**
 * Reopen a `receiving` slot whose upload is gone or has run too long: past
 * `FILES_TTL.receivingMax`, its claim is reclaimed (the upload's body read
 * aborts, and its own cleanup unlinks the part); with no claim at all the
 * upload died without unwinding. Call inside `mutate`. `true` when it changed.
 */
export function reclaimStalled(ctx: FilesCtx, request: FileRequest): boolean {
  if (request.state !== "receiving") return false;
  const held = ctx.store.claimed(request.request_id);
  if (held && ctx.host.now().getTime() - held.since < FILES_TTL.receivingMax * 1000) return false;
  if (held) ctx.store.reclaim(request.request_id);
  request.state = "open";
  request.rejected = {
    code: "VALIDATION",
    message: "the upload stalled and was stopped; send it again",
    at: nowIso(ctx.host),
  };
  return true;
}

/** Open or mid-upload: a slot still waiting for its file. */
function isLive(request: FileRequest): boolean {
  return request.state === "open" || request.state === "receiving";
}

/** What a slot's own fields are, before the state machine takes over. */
type SlotFields = Omit<FileRequest, "request_id" | "state" | "created_at" | "expires_at">;

function fileSlot(body: OpenFileRequestBody, fileCap: number): SlotFields {
  const sensitivity = body.sensitivity ?? "normal";
  const cap = classCap(sensitivity, fileCap);
  return {
    kind: "file",
    purpose: body.purpose,
    ...(body.name_hint ? { name_hint: body.name_hint } : {}),
    accept: body.accept ?? [],
    max_bytes: Math.min(body.max_bytes ?? cap, cap),
    sensitivity,
    durable: body.durable ?? sensitivity === "secret",
    ...(body.session_id ? { session_id: body.session_id } : {}),
    ...(body.task_id ? { task_id: body.task_id } : {}),
  };
}

/**
 * A `request_secret` slot: key names only, always the secret class, durable
 * unless the agent said otherwise, and capped at `secretTextBytes`. The names
 * are the contract the box parses the operator's text against (D10), so a
 * name given twice, or as both required and optional, or more than
 * `SECRET_TEXT_MAX_KEYS` in all, is refused here rather than at fulfil time.
 */
function secretTextSlot(body: OpenSecretRequestBody): SlotFields {
  const optional = body.optional_keys ?? [];
  const all = [...body.keys, ...optional];
  if (all.length > SECRET_TEXT_MAX_KEYS) {
    throw new FilesError(
      "VALIDATION",
      `a secret request names at most ${SECRET_TEXT_MAX_KEYS} keys, required and optional together`,
    );
  }
  const twice = all.find((key, i) => all.indexOf(key) !== i);
  if (twice !== undefined) throw new FilesError("VALIDATION", `${twice} is named twice`);
  return {
    kind: "secret_text",
    purpose: body.purpose,
    accept: [],
    max_bytes: FILES_LIMITS.secretTextBytes,
    sensitivity: "secret",
    durable: body.durable ?? true,
    keys: [...body.keys],
    ...(optional.length > 0 ? { optional_keys: [...optional] } : {}),
    slug: secretTextSlug(body.keys, body.slug),
    input: body.input ?? "auto",
    ...(body.session_id ? { session_id: body.session_id } : {}),
    ...(body.task_id ? { task_id: body.task_id } : {}),
  };
}

/** The longest slug a slot takes (`ENV_SECRET_SLOT_RE`). */
const SLUG_MAX = 48;

/** A text secret's key names, required and optional, order-insensitive. */
function keySet(request: FileRequest): string {
  return [...(request.keys ?? []), ...(request.optional_keys ?? [])].sort().join(",");
}

/**
 * Whether a stored text secret is the one `slot` asks for: every required key
 * stored, and every stored key a required one. An optional key does not
 * count: a fulfil that leaves it out would write over the stored value of a
 * key this request does not insist on, and lose it.
 */
function storedKeysFit(stored: readonly string[], slot: FileRequest): boolean {
  const required = slot.keys ?? [];
  return required.every((k) => stored.includes(k)) && stored.every((k) => required.includes(k));
}

/**
 * The slug a new text-secret slot is stored under. Two different requests can
 * land on one slug (`GITHUB_TOKEN` and `GITHUB_API_KEY` both derive `github`,
 * and the agent may give any slug), and a durable fulfil writes `env-<slug>`
 * and `<slug>.env` over whatever was there. So a slug already held for another
 * secret moves on to `<slug>-2`, `-3`, …: by a live text-secret slot with a
 * different key set, or by a durable secret entry named `<slug>.env` whose
 * stored keys (`FileEntry.keys`, recorded when it was placed) are not exactly
 * this request's required keys (`storedKeysFit`). The same secret keeps its
 * slug — that is how it is rotated, however long ago the sweeper pruned the
 * request that stored it. An
 * entry with no keys recorded falls back to its request's key set, and when
 * that is gone too (or it is a file secret) counts as another secret.
 */
function freeSlug(index: FilesIndex, slot: FileRequest): string {
  const base = slot.slug ?? secretTextSlug(slot.keys ?? []);
  const mine = keySet(slot);
  /** Per slug: whether each holder is this same secret. */
  const held = new Map<string, boolean[]>();
  const hold = (slug: string, same: boolean): void => {
    held.set(slug, [...(held.get(slug) ?? []), same]);
  };
  for (const r of index.requests) {
    if (r.kind === "secret_text" && isLive(r)) {
      hold(r.slug ?? secretTextSlug(r.keys ?? []), keySet(r) === mine);
    }
  }
  for (const e of index.entries) {
    if (e.dir !== "secret" || !e.name.endsWith(".env")) continue;
    let same: boolean;
    if (e.keys) same = storedKeysFit(e.keys, slot);
    else {
      const from = index.requests.find((r) => r.request_id === e.request_id);
      same = from?.kind === "secret_text" && keySet(from) === mine;
    }
    hold(e.name.slice(0, -".env".length), same);
  }
  const clashes = (slug: string): boolean => (held.get(slug) ?? []).some((same) => !same);
  if (!clashes(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!clashes(candidate)) return candidate;
  }
}

/**
 * Open a slot (socket `POST /requests`): a file (`request_file`) or, with
 * `kind: "secret_text"`, a text secret (`request_secret`), its slug moved off
 * one another secret holds (`freeSlug`). Refused with
 * `CONFLICT` once `FILES_LIMITS.openRequests` slots are live, of either kind:
 * the socket is the agent's, and an agent in a loop must not be able to grow
 * the index without bound.
 */
export async function openRequest(
  ctx: FilesCtx,
  body: OpenFileRequestBody | OpenSecretRequestBody,
): Promise<FileRequest> {
  const fields =
    "kind" in body && body.kind === "secret_text"
      ? secretTextSlot(body)
      : fileSlot(body, ctx.settings().max_bytes);
  const request: FileRequest = {
    request_id: newRequestId(),
    ...fields,
    state: "open",
    created_at: nowIso(ctx.host),
    expires_at: isoAfter(ctx.host, FILES_TTL.request),
  };
  const woken: string[] = [];
  await ctx.store.mutate((index) => {
    for (const r of index.requests) if (expireIfDue(ctx, r)) woken.push(r.request_id);
    if (index.requests.filter(isLive).length >= FILES_LIMITS.openRequests) {
      throw new FilesError(
        "CONFLICT",
        `this box already has ${FILES_LIMITS.openRequests} requests waiting for a file; ` +
          "wait for one to be answered, declined or expire before asking again",
      );
    }
    if (request.kind === "secret_text") request.slug = freeSlug(index, request);
    index.requests.push(request);
  });
  for (const id of woken) ctx.store.wake(id);
  return request;
}

/** One slot, its TTL applied. */
export async function getRequest(ctx: FilesCtx, id: string): Promise<FileRequest> {
  const current = find(ctx.store.read(), id);
  if (expireIfDue(ctx, { ...current })) {
    await ctx.store.mutate((index) => {
      if (expireIfDue(ctx, find(index, id))) ctx.store.wake(id);
    });
  }
  return find(ctx.store.read(), id);
}

/** Every slot, each with its TTL applied. */
export async function listRequests(ctx: FilesCtx): Promise<FileRequest[]> {
  const due = ctx.store.read().requests.filter((r) => expireIfDue(ctx, { ...r }));
  if (due.length > 0) {
    await ctx.store.mutate((index) => {
      for (const r of index.requests) if (expireIfDue(ctx, r)) ctx.store.wake(r.request_id);
    });
  }
  return ctx.store.read().requests;
}

/**
 * The long-poll: answer as soon as the slot leaves `open`, or after `seconds`
 * with whatever it is then. `signal` is the client hanging up.
 */
export async function waitForRequest(
  ctx: FilesCtx,
  id: string,
  seconds: number,
  signal?: AbortSignal,
): Promise<FileWaitResult> {
  let request = await getRequest(ctx, id);
  if (seconds <= 0 || (request.state !== "open" && request.state !== "receiving")) {
    return waitResult(ctx.name, request);
  }
  const stop = new AbortController();
  const onAbort = (): void => stop.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const deadline = ctx.host.now().getTime() + seconds * 1000;
    const timer = ctx.delay(seconds * 1000, stop.signal).then(() => "timeout" as const);
    for (;;) {
      const outcome = await Promise.race([
        ctx.store.changed(id, stop.signal).then(() => "changed" as const),
        timer,
      ]);
      request = await getRequest(ctx, id);
      if (request.state !== "open" && request.state !== "receiving") break;
      if (outcome === "timeout" || stop.signal.aborted || ctx.host.now().getTime() >= deadline) break;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    stop.abort();
  }
  return waitResult(ctx.name, request);
}

/**
 * Take the slot's lock for an upload: the slot `receiving`, and a claim on its
 * id whose signal the upload reads under. The caller releases the claim when
 * the upload ends, either way. Refuses a slot that is not `open`: 410 once
 * expired, 409 when filled, in flight, declined or consumed.
 */
export async function beginReceiving(
  ctx: FilesCtx,
  id: string,
): Promise<{ slot: FileRequest; claim: Claim }> {
  // The claim is taken inside the mutation, beside the state it backs, so a
  // `receiving` slot is never persisted — or seen by the sweeper's
  // `reclaimStalled` — without a live claim behind it.
  const held: { claim: Claim | null } = { claim: null };
  try {
    const slot = await ctx.store.mutate((index) => {
      const request = find(index, id);
      if (reclaimStalled(ctx, request)) ctx.store.wake(id);
      if (expireIfDue(ctx, request)) ctx.store.wake(id);
      const taken = takeSlot(request);
      // Only this function claims a slot's id, and only once `takeSlot` moved
      // the slot to `receiving`, which it refuses to do twice — so the id is free.
      held.claim = ctx.store.claim(id);
      if (held.claim === null) {
        throw new FilesError(
          "FILE_REQUEST_FULFILLED",
          "an upload for this request is already in flight",
        );
      }
      return taken;
    });
    return { slot, claim: held.claim as Claim };
  } catch (e) {
    // The mutation threw after claiming, or the index would not save: the slot
    // is not `receiving`, so nothing may hold its id.
    held.claim?.release();
    throw e;
  }
}

function takeSlot(request: FileRequest): FileRequest {
  switch (request.state) {
    case "open":
      request.state = "receiving";
      return { ...request };
    case "expired":
      throw new FilesError(
        "FILE_REQUEST_EXPIRED",
        "this request has expired; ask the agent to request it again",
      );
    case "receiving":
      throw new FilesError("FILE_REQUEST_FULFILLED", "an upload for this request is already in flight");
    case "fulfilled":
      throw new FilesError("FILE_REQUEST_FULFILLED", "this request has already been fulfilled");
    default:
      throw new FilesError("FILE_REQUEST_CLOSED", `this request was ${request.state}`);
  }
}

/**
 * An upload failed its checks: back to `open`, the refusal recorded for the
 * card. With `claim`, only while that claim still holds the slot — an upload
 * the slot was reclaimed from must not reopen a newer upload's lock.
 */
export async function rejectReceiving(
  ctx: FilesCtx,
  id: string,
  error: unknown,
  claim?: Claim,
): Promise<void> {
  const code = error instanceof FilesError ? error.code : "INTERNAL";
  const message = error instanceof FilesError ? error.message : "the upload failed";
  await ctx.store.mutate((index) => {
    const request = index.requests.find((r) => r.request_id === id);
    if (request?.state !== "receiving") return;
    if (claim && ctx.store.claimed(id) !== claim) return;
    request.state = "open";
    request.rejected = { code, message, at: nowIso(ctx.host) };
  });
  ctx.store.wake(id);
}

/**
 * The upload landed: `fulfilled`, with where it is and who sent it. Refuses
 * (`CONFLICT`) when `claim` no longer holds the slot — it was reclaimed while
 * the bytes were being written.
 */
export function markFulfilled(
  ctx: FilesCtx,
  index: FilesIndex,
  id: string,
  claim: Claim,
  fulfilled: Omit<NonNullable<FileRequest["fulfilled"]>, "at">,
): void {
  const request = find(index, id);
  if (request.state !== "receiving" || ctx.store.claimed(id) !== claim) {
    throw new FilesError("CONFLICT", "this upload was stopped before it landed; send it again");
  }
  request.state = "fulfilled";
  request.fulfilled = { ...fulfilled, at: nowIso(ctx.host) };
  delete request.rejected;
}

/** The operator said no (`POST /files/requests/:id/decline`). */
export async function declineRequest(ctx: FilesCtx, id: string, reason?: string): Promise<FileRequest> {
  const out = await ctx.store.mutate((index) => {
    const request = find(index, id);
    expireIfDue(ctx, request);
    if (request.state === "expired") {
      throw new FilesError("FILE_REQUEST_EXPIRED", "this request has already expired");
    }
    if (request.state === "fulfilled" || request.state === "receiving") {
      throw new FilesError(
        "FILE_REQUEST_FULFILLED",
        "this request has already been answered with a file",
      );
    }
    if (request.state !== "open")
      throw new FilesError("FILE_REQUEST_CLOSED", `this request was ${request.state}`);
    request.state = "declined";
    request.declined = { ...(reason ? { reason } : {}), at: nowIso(ctx.host) };
    return { ...request };
  });
  ctx.store.wake(id);
  return out;
}
