/**
 * Durable file secrets: SSM SecureString slots → tmpfs files the agent can read.
 *
 * The laptop stores a durable secret (`github-app.pem`, or a `KEY=value` text
 * secret) in this agent's own SSM prefix as `file-<slug>` or `env-<slug>`, its
 * value a JSON envelope carrying the original file name, the bytes and their
 * SHA-256 (`decodeSecretEnvelope`, `@hermetic/core/shared`). hermeticd reads the
 * slot with the instance role — which can already read its own prefix, so no
 * IAM change is involved — and writes the bytes to `/run/hermetic/files/<name>`,
 * 0600 and owned by `hermes`, so Hermes can open the file by its path and
 * nothing else on the box can.
 *
 * Never under `/data`. The data volume is snapshotted nightly and outlives the
 * instance; tmpfs is gone at the next reboot, which is why the files are
 * re-materialised at boot and on every apply, the same as `secrets.env`.
 *
 * The write is root's, into a directory only root can write to
 * (`FILES_SECRET_DIR`, root 0711), and the file is handed to `hermes` with a
 * `chown` afterwards. The account cannot plant a symlink at the name first,
 * because it cannot create anything in that directory — which is the reason the
 * file is not written as `hermes` the way the account's own directories are
 * (`installAccountDir`).
 *
 * Nothing here logs a secret value or a file name: a name can itself be
 * sensitive (`acme-prod-root.pem`). Failures are reported by slot name, which is
 * a lossy slug the laptop already shows in the run log.
 *
 * The real host holds an OS file lock from SSM read through placement and
 * sweep, shared by the daemon and `hermeticd apply`. Within this process every
 * write and removal also runs under one lock
 * (`exclusive`): the stale-file sweep in `materialiseAllFileSecrets` lists the
 * directory and removes what no slot claimed, and a secret placed by a route
 * in the middle of that would be swept the moment it landed. The sweep also
 * skips dot-prefixed names, which are `writeAtomically`'s staging files.
 *
 * SSM is read outside the in-process lock, and every read is bounded
 * (`SSM_TIMEOUT_MS`): a hung call must not wedge the process queue. Tickets
 * also preserve freshness among concurrent reads within one process: each
 * read takes a ticket when it starts,
 * each placement records its ticket by name, and the bulk pass neither
 * overwrites nor sweeps a name placed from a read that started after its
 * listing did (that value is the fresher one).
 */
import { createHash } from "node:crypto";
import {
  FILES_SECRET_DIR,
  HERMES_ACCOUNT,
  decodeSecretEnvelope,
  isEnvSecretSlot,
  isFileSecretSlot,
  readCanonicalSecretEnv,
  sanitizeFileName,
  secretSlotFileName,
} from "@hermetic/core/shared";
import { SECRETS_ENV_DIR, SECRETS_ENV_DIR_MODE } from "../apply/secrets.ts";
import type { Aws } from "../aws.ts";
import { AgentdError } from "../errors.ts";
import { paramPath } from "../fleet.ts";
import type { Host } from "../host.ts";
import { must } from "../host.ts";
import { FilesError } from "./errors.ts";

/** The tail of the chain every write and removal here queues on. */
let lockTail: Promise<unknown> = Promise.resolve();

/** The ticket the next SSM read takes; later reads take larger ones. */
let nextTicket = 0;

/** By file name: the ticket of the read whose value is on tmpfs now. */
const placedAt = new Map<string, number>();

/** How long one SSM call may take before the read is given up. */
export const SSM_TIMEOUT_MS = 30_000;

const FILE_SECRETS_LOCK = `${SECRETS_ENV_DIR}/file-secrets.lock`;

function withProcessLock<T>(host: Host, work: () => Promise<T>): Promise<T> {
  return host.withFileLock ? host.withFileLock(FILE_SECRETS_LOCK, work) : work();
}

/**
 * `promise`, or an `INTERNAL` naming `what` after `ms`. The SSM call itself is
 * not cancelled (the `Aws` wrapper takes no signal); it is only no longer
 * waited for, which is what keeps it from holding anything up.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AgentdError("INTERNAL", `${what} did not answer in ${Math.round(ms / 1000)} s`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Run `fn` after every earlier `exclusive` call in this process has settled. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = lockTail.then(fn);
  lockTail = run.catch(() => undefined);
  return run;
}

/**
 * `FILES_SECRET_DIR`'s mode: root's, and traversable without being listable.
 * `hermes` needs the execute bit to open `/run/hermetic/files/<name>`; without
 * read it cannot enumerate what else is there, and without write it cannot
 * create, rename or replace anything in it.
 */
export const FILES_SECRET_DIR_MODE = "0711";

/** One durable secret on tmpfs. `bytes` is the size; the content is never returned. */
export interface MaterialisedSecret {
  readonly slot: string;
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface FileSecretDeps {
  readonly host: Host;
  readonly aws: Aws;
  /** This agent's own SSM prefix, `/hermes/<fleet>/<agent>/` (`agentParamPrefix`). */
  readonly paramPrefix: string;
  /** Where a per-slot failure is reported. Slot names only, never a value or a file name. */
  readonly log?: (message: string) => void;
  /** The bound on each SSM call; `SSM_TIMEOUT_MS` unless a test says otherwise. */
  readonly ssmTimeoutMs?: number;
}

/** A slot's envelope, decoded and checked, ready to write. */
interface Prepared {
  readonly slot: string;
  readonly name: string;
  readonly path: string;
  readonly content: Uint8Array;
  readonly sha256: string;
}

function isSecretSlot(slot: string): boolean {
  return isFileSecretSlot(slot) || isEnvSecretSlot(slot);
}

function requireSecretSlot(slot: string): void {
  if (!isSecretSlot(slot)) {
    throw new AgentdError(
      "USAGE",
      `${slot} is not a durable file secret slot (file-<slug>, env-<slug>)`,
      {
        slot,
      },
    );
  }
}

/** The tmpfs path for a sanitized name, refusing anything that would land outside the directory. */
function secretPath(name: string): string {
  const path = `${FILES_SECRET_DIR}/${name}`;
  if (!path.startsWith(FILES_SECRET_DIR + "/") || name.includes("/") || name === "." || name === "..") {
    throw new AgentdError("INTERNAL", "a secret file name resolved outside the secret directory");
  }
  return path;
}

/**
 * Whether `content` is a text secret in the one form the box stores
 * (`canonicalSecretEnv`): valid UTF-8, exactly `KEY="escaped"` lines.
 */
function isCanonicalTextSecret(content: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    return false;
  }
  return readCanonicalSecretEnv(text) !== null;
}

/**
 * Decode, check and place one slot's value. Throws, naming the slot only, on an
 * envelope that does not decode, a digest that does not match its bytes, or an
 * `env-*` slot that is not `<slug>.env` (`secretSlotFileName`: the slot and the
 * file the agent was told about are one name) or whose bytes are not the
 * canonical `KEY="…"` form — a text secret is sourced by the agent's shell
 * (`secretTextLoad`), so anything else stays off the box. The last is a
 * `FilesError` (`VALIDATION`, 422), so a route placing it can say why.
 */
function prepare(slot: string, value: string): Prepared {
  requireSecretSlot(slot);
  const envelope = decodeSecretEnvelope(value);
  if (envelope === null) {
    throw new AgentdError("INTERNAL", `SSM slot ${slot} does not hold a valid secret envelope`, {
      slot,
    });
  }
  // `decodeSecretEnvelope` already refuses a name the sanitizer would change;
  // checked again here because this is the line that turns it into a path.
  const clean = sanitizeFileName(envelope.name);
  if (!clean.ok || clean.name !== envelope.name) {
    throw new AgentdError("INTERNAL", `SSM slot ${slot} names an unsafe file`, { slot });
  }
  // A text secret is read as `KEY=value` lines; a file not named for that is a
  // laptop writing the wrong shape into the slot, not something to guess at.
  if (isEnvSecretSlot(slot) && envelope.name !== secretSlotFileName(slot)) {
    throw new AgentdError(
      "INTERNAL",
      `SSM slot ${slot} is a text secret but does not name its own .env file`,
      {
        slot,
      },
    );
  }
  const digest = createHash("sha256").update(envelope.bytes).digest("hex");
  if (digest !== envelope.sha256.toLowerCase()) {
    throw new AgentdError("CHECKSUM_MISMATCH", `SSM slot ${slot} does not match its recorded SHA-256`, {
      slot,
    });
  }
  if (isEnvSecretSlot(slot) && !isCanonicalTextSecret(envelope.bytes)) {
    throw new FilesError(
      "VALIDATION",
      `SSM slot ${slot} does not hold a text secret in canonical KEY="value" form`,
      422,
    );
  }
  return {
    slot,
    name: envelope.name,
    path: secretPath(envelope.name),
    content: envelope.bytes,
    sha256: digest,
  };
}

/**
 * `/run/hermetic` and `/run/hermetic/files`, both root 0711. `mkdir` alone
 * leaves an existing directory's mode as it was (a box whose `/run/hermetic`
 * was made 0700 before files existed), so each is chmod'd explicitly.
 */
async function ensureSecretDir(host: Host): Promise<void> {
  await host.mkdir(SECRETS_ENV_DIR, SECRETS_ENV_DIR_MODE);
  await host.chmod(SECRETS_ENV_DIR, SECRETS_ENV_DIR_MODE);
  await host.mkdir(FILES_SECRET_DIR, FILES_SECRET_DIR_MODE);
  await host.chmod(FILES_SECRET_DIR, FILES_SECRET_DIR_MODE);
}

function describeSecret(prepared: Prepared): MaterialisedSecret {
  return {
    slot: prepared.slot,
    name: prepared.name,
    path: prepared.path,
    sha256: prepared.sha256,
    bytes: prepared.content.length,
  };
}

async function place(host: Host, prepared: Prepared): Promise<MaterialisedSecret> {
  await ensureSecretDir(host);
  // As root, at its final mode from the first byte (`writeAtomically` creates
  // the staged file 0600 and refuses a symlink at the target), then handed to
  // the account. `--` so no name can be read as an option.
  await host.writeBytes(prepared.path, prepared.content, "0600");
  await must(host, ["chown", `${HERMES_ACCOUNT}:${HERMES_ACCOUNT}`, "--", prepared.path]);
  return describeSecret(prepared);
}

/** Checks a slot's decoded bytes before they are written; throws to refuse them. */
export type SecretContentCheck = (content: Uint8Array) => void;

/**
 * Read one `file-*`/`env-*` slot from SSM and write it to tmpfs. With
 * `expectName`, an envelope naming any other file is refused (`VALIDATION`)
 * before anything is written: the route that asks knows which name it was
 * promised, and a different one could land on another slot's file. `check`,
 * when given, sees the decoded bytes before the write too: the route a text
 * secret arrives by re-parses them against the request's keys there.
 */
export async function materialiseFileSecret(
  deps: FileSecretDeps,
  slot: string,
  expectName?: string,
  check?: SecretContentCheck,
): Promise<MaterialisedSecret> {
  return withProcessLock(deps.host, () => materialiseFileSecretUnlocked(deps, slot, expectName, check));
}

async function materialiseFileSecretUnlocked(
  deps: FileSecretDeps,
  slot: string,
  expectName?: string,
  check?: SecretContentCheck,
): Promise<MaterialisedSecret> {
  const first = await materialiseOnce(deps, slot, expectName, check);
  if (first !== null) return first;
  // A read that began after this one placed the file while this one waited on
  // SSM: its value is newer, so writing ours would put a stale secret back.
  // Read again, once, and let a second loss stand as written by the newer read.
  const again = await materialiseOnce(deps, slot, expectName, check);
  if (again !== null) return again;
  const prepared = prepare(slot, await readSlot(deps, slot));
  check?.(prepared.content);
  return describeSecret(prepared);
}

function readSlot(deps: FileSecretDeps, slot: string): Promise<string> {
  return withTimeout(
    deps.aws.getParameter(paramPath(deps.paramPrefix, slot)),
    deps.ssmTimeoutMs ?? SSM_TIMEOUT_MS,
    `SSM slot ${slot}`,
  );
}

/** One read-then-place; `null` when a newer read already placed the same name. */
async function materialiseOnce(
  deps: FileSecretDeps,
  slot: string,
  expectName?: string,
  check?: SecretContentCheck,
): Promise<MaterialisedSecret | null> {
  requireSecretSlot(slot);
  const ticket = nextTicket++;
  const prepared = prepare(slot, await readSlot(deps, slot));
  if (expectName !== undefined && prepared.name !== expectName) {
    throw new FilesError("VALIDATION", "the secret slot names a different file than the request said");
  }
  check?.(prepared.content);
  return exclusive(async () => {
    if (placedSince(prepared.name, ticket)) return null;
    const placed = await place(deps.host, prepared);
    placedAt.set(prepared.name, ticket);
    return placed;
  });
}

/** Whether `name` on tmpfs came from a read that started after the one holding `ticket`. */
function placedSince(name: string, ticket: number): boolean {
  return (placedAt.get(name) ?? -1) > ticket;
}

/**
 * Every durable file secret this agent has in SSM, onto tmpfs; and every file
 * on tmpfs no current slot produced, removed — a slot the operator deleted
 * must not live on on the box until the next reboot.
 *
 * One `GetParametersByPath` (paged), and the values it returned are the ones
 * written: no second read per slot. Best-effort per slot: one bad envelope is
 * logged by its slot name and the rest still land. The listing itself failing
 * throws, and nothing is swept — an empty answer from a failed call must not
 * read as "the operator deleted everything".
 *
 * Two slots naming the same file: the first by slot name wins and the other is
 * logged. A slot whose write failed still holds its name, so a transient
 * failure leaves the previous copy in place rather than sweeping it.
 */
export async function materialiseAllFileSecrets(deps: FileSecretDeps): Promise<MaterialisedSecret[]> {
  return withProcessLock(deps.host, () => materialiseAllFileSecretsUnlocked(deps));
}

async function materialiseAllFileSecretsUnlocked(deps: FileSecretDeps): Promise<MaterialisedSecret[]> {
  // `paramPath(prefix, slot)` is `<prefix>/<slot>` with exactly one slash, so
  // the slots are the parameters directly under the prefix without its
  // trailing slash: the hierarchy SSM's own examples name.
  const base = paramPath(deps.paramPrefix, "");
  const listPath = base.length > 1 ? base.slice(0, -1) : base;
  const ticket = nextTicket++;
  const listed = await withTimeout(
    deps.aws.getParametersByPath(listPath),
    deps.ssmTimeoutMs ?? SSM_TIMEOUT_MS,
    "the SSM listing",
  );
  return exclusive(() => materialiseAll(deps, base, listed, ticket));
}

async function materialiseAll(
  deps: FileSecretDeps,
  base: string,
  listed: ReadonlyArray<{ name: string; value: string }>,
  ticket: number,
): Promise<MaterialisedSecret[]> {
  const log = deps.log ?? (() => {});

  const slots = listed
    .filter((p) => p.name.startsWith(base))
    .map((p) => ({ slot: p.name.slice(base.length), value: p.value }))
    .filter((p) => isSecretSlot(p.slot))
    .sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));

  const claimed = new Map<string, string>();
  const out: MaterialisedSecret[] = [];
  for (const { slot, value } of slots) {
    let prepared: Prepared;
    try {
      prepared = prepare(slot, value);
    } catch (e) {
      const code = e instanceof AgentdError || e instanceof FilesError ? e.code : "INTERNAL";
      log(`file secret ${slot}: ${code}; skipped`);
      continue;
    }
    const owner = claimed.get(prepared.name);
    if (owner !== undefined) {
      log(`file secret ${slot}: its file name is already taken by ${owner}; skipped`);
      continue;
    }
    claimed.set(prepared.name, slot);
    // A route placed this name from a read that began after this listing:
    // its value is the fresher one, so it stays.
    if (placedSince(prepared.name, ticket)) continue;
    try {
      out.push(await place(deps.host, prepared));
      placedAt.set(prepared.name, ticket);
    } catch (e) {
      log(
        `file secret ${slot}: could not be written (${e instanceof AgentdError ? e.code : "INTERNAL"})`,
      );
    }
  }

  for (const entry of await deps.host.readdir(FILES_SECRET_DIR)) {
    // Never a sanitized name (the sanitizer refuses a leading dot), and so
    // possibly a write in progress: `writeAtomically` stages beside its target.
    if (claimed.has(entry) || entry.startsWith(".")) continue;
    // Placed from a read that began after this listing: not stale, just newer.
    if (placedSince(entry, ticket)) continue;
    await deps.host.remove(`${FILES_SECRET_DIR}/${entry}`);
    // A tombstone, not a delete: an older pass still in flight must not
    // re-place what this newer listing found gone from SSM.
    placedAt.set(entry, ticket);
  }
  return out;
}

/** Remove one materialised secret from tmpfs by its file name. A missing file is not an error. */
export async function removeFileSecret(host: Host, name: string): Promise<void> {
  const clean = sanitizeFileName(name);
  if (!clean.ok || clean.name !== name) {
    throw new AgentdError("USAGE", "not a valid secret file name");
  }
  await withProcessLock(host, () =>
    exclusive(async () => {
      await host.remove(secretPath(clean.name));
      placedAt.set(clean.name, nextTicket++);
    }),
  );
}
