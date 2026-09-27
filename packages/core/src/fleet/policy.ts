/**
 * The tailnet policy file, as far as hermetic is concerned: three entries the
 * fleet cannot work without, kept in the operator's own document.
 *
 * Everything a hermetic agent needs from Tailscale is one `tagOwners` line, one
 * `ssh` rule and one `acls` rule (§4.7 step 4). Until now the only way to get
 * them in was to paste them: `aclSnippet()` printed the block and the operator
 * merged it by eye, which meant every fleet's policy drifted from every other
 * fleet's, and a port added here — 7434, when hermeticd grew an RPC — reached
 * nobody's tailnet until they read the release note.
 *
 * So hermetic manages them itself, through `POST /api/v2/tailnet/-/acl`, and it
 * manages *only* them: `hujson.ts` splices text into and out of the byte ranges
 * between two `// hermetic:managed` markers and returns every other byte in the
 * file unchanged. That is the whole safety argument, and the rest of this module
 * is the ceremony around it — validate before writing, `If-Match` so a policy
 * edited in the console between the plan and the apply is a refusal rather than
 * an overwrite, a diff the operator confirms, and a run-log entry afterwards.
 *
 * Three things stay the operator's, on purpose:
 *
 *  - The `tagOwners` line, when they already wrote it. They have to: the OAuth
 *    client form only offers tags that already have an owner, so the line
 *    precedes the credential hermetic would need to write it with. A second
 *    `"tag:hermetic"` key in the same object is invalid HuJSON, not a fix, so
 *    the block is skipped and the plan says why.
 *  - Everything outside the markers. Comments, key order, their own grants.
 *  - The decision. `plan.policy` returns a plan; `apply` executes it (§3.2 r3).
 *
 * The scope this needs — `policy_file` — is the one scope Tailscale will not
 * restrict to a tag: it is tailnet-wide by construction. That is a real cost and
 * it is paid deliberately; §5 "Tailnet policy" lists what is done about it.
 */
import {
  HERMETIC_BLOCK_BEGIN,
  HERMETIC_BLOCK_END,
  applyManagedBlocks,
  locateManagedBlocks,
  parseHujson,
  readManagedBlocks,
  topLevelMembers,
  type ManagedBlock,
} from "./hujson.ts";
import { probePolicyScope } from "./policy-scope.ts";
import { HermeticError } from "../errors.ts";
import { FLEET_KEY, HERMETICD_RPC_PORT } from "../schema/index.ts";
import type {
  OpEvent,
  Plan,
  PlanPolicyInput,
  PlanSummary,
  PolicyBlockReport,
  PolicyReport,
} from "../schema/index.ts";
import { NO_POLICY_WRITE_SCOPE, TAILSCALE_TAG } from "../aws/tailscale.ts";
import type { Backend } from "../backend/types.ts";
import type { OpOptions } from "../hermetic.ts";
import { evt } from "../events.ts";
import { checkAbort } from "../abort.ts";
import type { CoreContext } from "../context.ts";

/** The top-level policy keys hermetic has an opinion about, in write order. */
export type PolicyKey = "tagOwners" | "ssh" | "acls";

/** The HTTPS port every agent publishes its dashboard on (`tailscale serve`). */
const SERVE_PORT = 443;

/**
 * SSH. The `ssh` policy block says *who* may `tailscale ssh` to a tagged node,
 * but Tailscale checks the network ACL first: with no `acls` rule opening 22,
 * an operator who has been granted SSH by the `ssh` block still gets a refused
 * connection. The two entries are one grant and have to be written together —
 * this port was missing, and its absence is exactly the class of drift §5.2
 * exists to stop.
 */
const SSH_PORT = 22;

/**
 * The one source of truth for hermetic's policy content. Both spellings below —
 * the managed block hermetic writes through the API, and the paste-ready snippet
 * a head prints for anyone who keeps their policy in git — are rendered from
 * these objects, so the two cannot disagree about a port again.
 */
interface PolicyEntry {
  key: PolicyKey;
  container: "object" | "array";
  /** What it grants, in one line, for a head to label the block with. */
  purpose: string;
  /**
   * The entry itself. An `object` container contributes one member (`member`
   * names the key); an `array` container contributes one element.
   */
  member?: string;
  value: unknown;
}

function entries(): PolicyEntry[] {
  return [
    {
      key: "tagOwners",
      container: "object",
      purpose: `who may tag nodes ${TAILSCALE_TAG} — the OAuth client cannot be created until this exists`,
      member: TAILSCALE_TAG,
      value: ["autogroup:admin"],
    },
    {
      key: "ssh",
      container: "array",
      purpose: `who may \`tailscale ssh\` to ${TAILSCALE_TAG} nodes`,
      value: {
        action: "accept",
        src: ["autogroup:member"],
        dst: [TAILSCALE_TAG],
        users: ["autogroup:nonroot", "root"],
      },
    },
    {
      key: "acls",
      container: "array",
      purpose: `who may reach ${TAILSCALE_TAG} nodes: SSH (${SSH_PORT}), each agent's Serve URL (${SERVE_PORT}) and hermeticd RPC (${HERMETICD_RPC_PORT})`,
      value: {
        action: "accept",
        src: ["autogroup:member"],
        dst: [
          `${TAILSCALE_TAG}:${SSH_PORT}`,
          `${TAILSCALE_TAG}:${SERVE_PORT}`,
          `${TAILSCALE_TAG}:${HERMETICD_RPC_PORT}`,
        ],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Rendering: one entry, two spellings
// ---------------------------------------------------------------------------

/**
 * JSON on one line, with the spaces a human would put in. `JSON.stringify` packs
 * it to `{"action":"accept",…}`, which is correct and unreadable — and this text
 * lands in somebody's policy file, where it will be read far more often than it
 * is written.
 */
function compact(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(compact).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const members = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${JSON.stringify(k)}: ${compact(v)}`,
    );
    return `{ ${members.join(", ")} }`;
  }
  return JSON.stringify(value);
}

/**
 * The same value over several lines, keys padded into a column. This is the
 * hand-merge spelling: someone reading it in a pull request should be able to
 * see at a glance which rule changed.
 */
function expanded(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return compact(value);
  const members = Object.entries(value as Record<string, unknown>);
  const width = Math.max(...members.map(([k]) => JSON.stringify(k).length + 1));
  const lines = members.map(
    ([k, v], i) =>
      `  ${`${JSON.stringify(k)}:`.padEnd(width, " ")} ${compact(v)}${i === members.length - 1 ? "" : ","}`,
  );
  return ["{", ...lines, "}"].join("\n");
}

/** The body of one managed block: the entry, comma-terminated, unindented. */
function blockBody(entry: PolicyEntry): string {
  return entry.member === undefined
    ? `${compact(entry.value)},`
    : `${JSON.stringify(entry.member)}: ${compact(entry.value)},`;
}

/**
 * One entry the tailnet policy needs, addressed by the top-level key it goes
 * under. The policy file is HuJSON with fixed top-level keys, so an operator
 * cannot paste a whole object — each entry has to be spliced into a key that
 * already exists. Heads show the parts separately so the splice is three small
 * pastes rather than a hand merge (§4.7 step 4).
 */
export interface AclSnippetPart {
  /** The top-level policy key this belongs under. */
  key: PolicyKey;
  /** What it grants, in one line, for the head to label the block with. */
  purpose: string;
  /** The entry itself, indented as it would sit inside `key`. */
  body: string;
}

/**
 * The tailnet policy the fleet needs, one part per top-level key — the manual
 * fallback, for an operator whose policy lives in git or whose OAuth client
 * carries no `policy_file` scope. Rendered from the same entries the managed
 * blocks are, so the paste and the write can never say different things.
 */
export function aclSnippetParts(): AclSnippetPart[] {
  return entries().map((entry) => ({
    key: entry.key,
    purpose: entry.purpose,
    body:
      entry.member === undefined
        ? expanded(entry.value)
        : `${JSON.stringify(entry.member)}: ${compact(entry.value)}`,
  }));
}

const indent = (text: string, by: string): string =>
  text
    .split("\n")
    .map((line) => by + line)
    .join("\n");

/**
 * The same policy as one object, for printing after `init --create` and for
 * anyone who prefers to merge by eye. Assembled from `aclSnippetParts()` so the
 * two can never disagree.
 */
export function aclSnippet(): string {
  const parts = aclSnippetParts();
  const block = (key: PolicyKey): string => {
    const part = parts.find((p) => p.key === key) as AclSnippetPart;
    return key === "tagOwners"
      ? `  "${key}": {\n${indent(part.body, "    ")}\n  }`
      : `  "${key}": [\n${indent(part.body, "    ")}\n  ]`;
  };
  return [
    "// hermetic — add these to your tailnet policy file (§4.7 step 4).",
    "{",
    `${block("tagOwners")},`,
    `${block("ssh")},`,
    block("acls"),
    "}",
  ].join("\n");
}

/** The three blocks hermetic would write, in the order it writes them. */
export function hermeticBlocks(): ManagedBlock[] {
  return entries().map((entry) => ({
    key: entry.key,
    container: entry.container,
    body: blockBody(entry),
  }));
}

/** Every top-level key hermetic keeps a block in — what `teardown` removes. */
export const POLICY_KEYS: readonly PolicyKey[] = entries().map((e) => e.key);

/**
 * Why the `tagOwners` block is left alone when the operator already owns the
 * tag. Prose rather than a code because it is the whole of what a head has to
 * say, and because it is not a problem: this is the expected shape.
 */
export const TAG_OWNER_IS_YOURS = `\`${TAILSCALE_TAG}\` is already owned outside hermetic's block — left exactly as you wrote it, because two entries for one tag would be invalid`;

/**
 * What each block says when the file itself could not be read. Two words, the
 * same two on every line, because the state of every block is the same single
 * unknown — the sentence about *why* is on the report once (`scope`), not three
 * times down a table.
 */
export const POLICY_UNREADABLE = "policy unreadable";

/** The note an OAuth client with no policy scope at all gets (§4.7). */
export const NO_POLICY_SCOPE_NOTE = `the client cannot read the tailnet policy file: hermetic's ACL and SSH rules stay yours to paste and to keep in step; create a client with the policy_file scope and run hermetic secrets push _fleet --tailscale-oauth`;

/** The note a client that can read the policy but not write it gets. */
export const READ_ONLY_POLICY_NOTE = `the client can read the tailnet policy file but not write it: \`hermetic policy\` will report drift and \`hermetic apply\` will be refused; create a client with the policy_file scope (write) and run hermetic secrets push _fleet --tailscale-oauth`;

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/** Above this many lines the LCS table is not worth building; see `managedDiff`. */
const DIFF_LINE_LIMIT = 4000;

function lcsTable(a: readonly string[], b: readonly string[]): Int32Array {
  const w = b.length + 1;
  const table = new Int32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * w + j] =
        a[i] === b[j]
          ? table[(i + 1) * w + j + 1]! + 1
          : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
    }
  }
  return table;
}

interface DiffOp {
  op: " " | "-" | "+";
  line: string;
}

function diffOps(a: readonly string[], b: readonly string[]): DiffOp[] {
  const w = b.length + 1;
  const table = lcsTable(a, b);
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ op: " ", line: a[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) {
      ops.push({ op: "-", line: a[i]! });
      i += 1;
    } else {
      ops.push({ op: "+", line: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) ops.push({ op: "-", line: a[i++]! });
  while (j < b.length) ops.push({ op: "+", line: b[j++]! });
  return ops;
}

/** The lines of one managed block, markers included, or undefined when absent. */
function blockText(text: string, key: string): string | undefined {
  const range = locateManagedBlocks(text).find((b) => b.key === key);
  return range === undefined ? undefined : text.slice(range.start, range.end).replace(/\r?\n$/, "");
}

/** `@@ …` plus the ops under it; the markers are the context, being unchanged. */
function hunk(header: string, before: string[], after: string[]): string[] {
  if (before.length + after.length > DIFF_LINE_LIMIT) {
    return [header, `(the block is ${before.length} lines; too large to diff here)`];
  }
  return [header, ...diffOps(before, after).map((op) => `${op.op}${op.line}`)];
}

/**
 * What a write would change, and *only* what a write would change.
 *
 * This used to be a unified diff of the whole document with three lines of
 * context, which was wrong in the one way this feature cannot afford to be
 * wrong: the result travels — into `PolicyReport.diff`, a plan warning, an
 * HTTP response and whatever the head prints — and a policy file names people
 * (a `groups` entry is a list of email addresses). Three lines of context
 * around a block is three lines of somebody else's rules.
 *
 * So the diff is assembled per key from the byte ranges `hujson.ts` owns: the
 * current block against the new one, markers included, and nothing outside
 * them. A block that does not exist yet has no range to diff against, so its
 * hunk names the insertion point instead and the body is all additions. Keys
 * hermetic is skipping contribute nothing, because nothing about them changes.
 *
 * Empty string when the managed ranges say the same thing in both documents —
 * which, since `applyManagedBlocks` touches nothing else, means the write is a
 * no-op.
 */
export function managedDiff(before: string, after: string, keys: readonly string[]): string {
  const out: string[] = [];
  for (const key of keys) {
    const current = blockText(before, key);
    const next = blockText(after, key);
    if (current === next) continue;
    if (next === undefined) {
      out.push(...hunk(`@@ ${key} (block removed) @@`, current!.split("\n"), []));
      continue;
    }
    if (current === undefined) {
      out.push(...hunk(`@@ ${key} (new block at end of container) @@`, [], next.split("\n")));
      continue;
    }
    out.push(...hunk(`@@ ${key} @@`, current.split("\n"), next.split("\n")));
  }
  if (out.length === 0) return "";
  return ["--- tailnet policy (current)", "+++ tailnet policy (after apply)", ...out].join("\n");
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

/** The tailnet policy needs nothing beyond the shared context. */
export interface PolicyDeps {
  ctx: CoreContext;
}

/**
 * Does anything but a hermetic block own `tag:hermetic`?
 *
 * Asked of the parse tree, not of the text. The text version — "count the lines
 * mentioning the key, minus a `//` comment" — was wrong both ways round: it cut
 * a line at the first `//`, so a URL in a neighbouring value truncated real
 * code, and it never stripped block comments, so an operator's commented-out
 * `"tag:hermetic"` counted as an owner and hermetic silently declined to write
 * a tag nobody actually owned. `topLevelMembers` knows where each member really
 * begins and ends, and which of them is inside hermetic's own block.
 */
function tagOwnedOutsideBlock(text: string): boolean {
  return topLevelMembers(text, "tagOwners").some(
    (member) => member.key === TAILSCALE_TAG && !member.inManagedBlock,
  );
}

/** Same body, ignoring the indentation `applyManagedBlocks` would impose. */
function sameBody(a: string, b: string): boolean {
  const norm = (text: string): string =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");
  return norm(a) === norm(b);
}

/**
 * A block body as a value.
 *
 * A body is a run of *entries*, not a document: `{ … },` inside an array, or
 * `"tag:hermetic": [ … ],` inside an object. Putting the container's brackets
 * back around it is what makes it parseable, and it is exactly the container
 * `applyManagedBlocks` would splice it into, so nothing is being guessed here.
 */
function blockValue(body: string, container: "object" | "array"): unknown {
  const [open, close] = container === "object" ? ["{", "}"] : ["[", "]"];
  return parseHujson(`${open}\n${body}\n${close}`);
}

/**
 * A value's meaning as a string: JSON with object keys in sorted order, so two
 * spellings of the same rule compare equal however either one was formatted.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The one thing a block can be drifted *for* that is not a difference of rules. */
export const BLOCK_UNPARSABLE = "hermetic's block does not parse";

/**
 * Does this block already say what hermetic would say?
 *
 * Asked of the meaning, never of the bytes. Tailscale does not store the policy
 * file the way it was posted: it saves what it parsed, re-printed in its own
 * house style — one member per line, tab-indented, values aligned into a column
 * — so hermetic's own block never reads back as the single line it wrote. A
 * textual comparison called that drift, the next `plan policy` proposed the
 * identical rule again, the write came back reformatted again, and the fleet
 * churned ETags for ever without either side being wrong about anything.
 *
 * So the two bodies are parsed and compared canonically. A body that will not
 * parse is drift with a reason rather than a crash: it is somebody's hand edit
 * gone wrong between the markers, and the answer to it is the rewrite `apply`
 * already offers (§5.2 — what is inside the markers is hermetic's).
 */
export function sameManagedEntry(
  body: string,
  block: ManagedBlock,
): { same: boolean; reason: string | null } {
  if (sameBody(body, block.body)) return { same: true, reason: null };
  let current: unknown;
  try {
    current = blockValue(body, block.container);
  } catch {
    return { same: false, reason: BLOCK_UNPARSABLE };
  }
  const same = canonical(current) === canonical(blockValue(block.body, block.container));
  return { same, reason: null };
}

/**
 * Every block's state, and the subset of them a write would actually touch.
 *
 * One pass, because the two answers have to agree: a block reported `current`
 * that still ends up in the write set is the churn above, and a block reported
 * `drifted` that is left out of it is a report of a fix that never comes.
 * `status`, `plan`, the diff and `apply` all read this.
 */
function planBlocks(text: string): {
  reports: PolicyBlockReport[];
  write: ManagedBlock[];
  skipped: Set<PolicyKey>;
} {
  const existing = readManagedBlocks(text);
  const skipped = new Set<PolicyKey>();
  if (tagOwnedOutsideBlock(text)) skipped.add("tagOwners");
  const write: ManagedBlock[] = [];
  const reports = hermeticBlocks().map((block): PolicyBlockReport => {
    if (skipped.has(block.key as PolicyKey)) {
      return { key: block.key, state: "skipped", reason: TAG_OWNER_IS_YOURS };
    }
    const body = existing[block.key];
    if (body === undefined) {
      write.push(block);
      return { key: block.key, state: "absent", reason: null };
    }
    const verdict = sameManagedEntry(body, block);
    if (verdict.same) return { key: block.key, state: "current", reason: null };
    write.push(block);
    return { key: block.key, state: "drifted", reason: verdict.reason };
  });
  return { reports, write, skipped };
}

export function createPolicy(deps: PolicyDeps) {
  const { appendEvent, backend, guardAccount, nowIso } = deps.ctx;

  /** §4.8: which fleet this plan belongs to, so `apply` can refuse it elsewhere. */
  function fleetSummary(): PlanSummary {
    const config = deps.ctx.requireConfig();
    return {
      account_id: config.account_id,
      region: config.region,
      fleet_id: config.fleet_id,
      stack_id: null,
    };
  }

  /**
   * Which scope the client carries, asked the way `preflight.ts` asks
   * everything: by doing it, and through the one helper both of them share so
   * the two can never answer differently about the same tailnet
   * (`policy-scope.ts`). A policy that comes back proves `policy_file:read`;
   * only a 200 from validating that same policy *unchanged* proves the write
   * scope. Anything else is unproven, and unproven is reported as `read`.
   */
  async function scopeOf(text: string) {
    return probePolicyScope({
      read: async () => text,
      validate: async (candidate) => {
        const check = await backend.tailscale.validatePolicy(candidate);
        return check.ok
          ? { ok: true as const }
          : {
              ok: false as const,
              forbidden: check.message === NO_POLICY_WRITE_SCOPE,
              message: check.message,
            };
      },
    });
  }

  /** `absent`/`current`/`drifted` for the file as a whole; skipped blocks abstain. */
  function overall(blocks: readonly PolicyBlockReport[]): PolicyReport["managed"] {
    const states = blocks.filter((b) => b.state !== "skipped").map((b) => b.state);
    if (states.length === 0 || states.every((s) => s === "current")) return "current";
    if (states.every((s) => s === "absent")) return "absent";
    return "drifted";
  }

  /**
   * §4.7: what the tailnet policy says about hermetic today, and what a write
   * would change. A pure read — it validates, which changes nothing, and never
   * writes.
   */
  async function status(): Promise<PolicyReport> {
    await guardAccount();
    const current = await backend.tailscale.getPolicy();
    if (current === null) {
      /**
       * No read scope, or an unreachable API. Reported as `unavailable` rather
       * than as an empty report for the same reason `doctor` distinguishes an
       * unchecked device list from a clean one: the two look identical from the
       * outside and only one of them is fine.
       */
      return {
        scope: "none",
        scope_reason: null,
        managed: "unavailable",
        /**
         * Said once, not three times. Every block carries the same two-word
         * state because the same one thing is true of all of them, and the
         * sentence explaining it belongs on the report — repeated on each line
         * it reads as three separate problems, which is how a head ends up
         * printing the whole paragraph three times over.
         */
        blocks: hermeticBlocks().map((b) => ({
          key: b.key,
          state: "skipped" as const,
          reason: POLICY_UNREADABLE,
        })),
        etag: null,
        diff: null,
      };
    }
    const { scope, reason } = await scopeOf(current.text);
    /**
     * Only the blocks that need writing go into `applyManagedBlocks`, and
     * therefore only they can appear in the diff. A block whose text Tailscale
     * reformatted but whose meaning is hermetic's is left out of both, so it
     * stays byte for byte as the tailnet has it and the operator is not shown a
     * change that is not one.
     */
    const { reports, write } = planBlocks(current.text);
    const next = applyManagedBlocks(current.text, write);
    return {
      scope,
      scope_reason: reason,
      managed: overall(reports),
      blocks: reports,
      etag: current.etag,
      diff: next.changed
        ? managedDiff(
            current.text,
            next.text,
            write.map((b) => b.key),
          )
        : null,
    };
  }

  /**
   * §3.2 rule 3: the dry run. One step per block plus the write itself, which is
   * the destructive one — not because it removes anything, but because it is a
   * `POST` against a document the whole tailnet obeys, and the operator
   * confirming it should see that in the same column every other irreversible
   * step appears in.
   */
  async function plan(_input: PlanPolicyInput = {}): Promise<Plan> {
    const report = await status();
    const unreadable = report.managed === "unavailable";
    /**
     * An ETag hermetic did not get is one it cannot send back, and a write with
     * no `If-Match` is the overwrite this whole path exists to avoid — so the
     * empty string is not carried into the plan, and `apply` refuses a plan
     * without one rather than posting unconditionally.
     */
    const etag = report.etag === null || report.etag.length === 0 ? null : report.etag;
    const steps = report.blocks.map((block) => ({
      id: block.key,
      description:
        block.state === "skipped"
          ? `skip "${block.key}": ${block.reason ?? "left as you wrote it"}`
          : block.state === "current"
            ? `"${block.key}" is already what hermetic would write`
            : `${block.state === "absent" ? "add" : "update"} hermetic's block in "${block.key}"`,
      destructive: false,
    }));
    steps.push({
      id: "write",
      description: unreadable
        ? "nothing to write: the policy file could not be read"
        : report.diff === null
          ? "nothing to write: the policy already says what hermetic would say"
          : etag === null
            ? "cannot write: tailscale returned no ETag for the policy file, so the write cannot be made conditional — retry, and if it persists apply the entries by hand"
            : `POST the policy back with If-Match ${etag} — validated first, refused if the file has moved`,
      destructive: report.diff !== null && etag !== null,
    });

    const warnings: string[] = [
      `hermetic edits only the lines between its \`${HERMETIC_BLOCK_BEGIN}\` / \`${HERMETIC_BLOCK_END}\` markers; every other byte of the policy — comments, key order, your own rules — is written back byte for byte`,
    ];
    if (report.scope === "none") {
      warnings.push(NO_POLICY_SCOPE_NOTE);
    } else if (report.scope === "read") {
      warnings.push(report.scope_reason ?? READ_ONLY_POLICY_NOTE);
    }
    /**
     * Block reasons, except when the report is `unavailable`: there the reason
     * is one fact about the whole file, already said once above, and repeating
     * it per block is how the same paragraph ended up in four warnings.
     */
    if (!unreadable) {
      for (const block of report.blocks) {
        if (block.state === "skipped" && block.reason !== null) warnings.push(block.reason);
      }
    }
    if (report.diff !== null) {
      warnings.push(
        `the change, as a unified diff:\n${report.diff
          .split("\n")
          .map((line) => `      ${line}`)
          .join("\n")}`,
      );
    }

    return {
      kind: "policy",
      target: "tailnet",
      // Carried as data: `apply` re-reads the policy and compares this, so a
      // plan reviewed against one file cannot be applied to another (§3.2 r3).
      options: etag === null ? {} : { etag },
      steps,
      // One warning per thing that is true, however many blocks it is true of.
      warnings: [...new Set(warnings)],
      /**
       * §4.8. The tailnet policy is one file per *tailnet*, not per fleet — but
       * which blocks hermetic writes into it is decided by the fleet this home
       * is open on, so a plan reviewed on one fleet is not a plan for another.
       * `stack_id` is null: nothing here reads the stack.
       */
      summary: fleetSummary(),
    };
  }

  /**
   * Execute a `plan.policy`. Read, render, validate, write — in that order,
   * because a policy Tailscale would reject must not be sent, and a policy that
   * has moved since the plan must not be overwritten.
   */
  async function* apply(planned: Plan, opts: OpOptions = {}): AsyncIterable<OpEvent> {
    await guardAccount();
    /**
     * The `If-Match` is not an optimisation, it is the whole safety argument
     * (§4.7): without it the write is an unconditional overwrite of a document
     * hermetic read at some unknown earlier time. A plan made when the policy
     * could not be read — or when Tailscale answered without an `ETag` header —
     * carries none, and there is no safe way to execute it.
     */
    const expected = planned.options.etag;
    if (typeof expected !== "string" || expected.length === 0) {
      throw new HermeticError(
        "VALIDATION",
        "this plan carries no policy ETag; run `hermetic plan policy` again",
        { kind: planned.kind },
      );
    }
    checkAbort(opts.signal, "fetch");
    yield evt("fetch", 0.1, "reading the tailnet policy file", nowIso(), undefined, "start");
    const current = await backend.tailscale.getPolicy();
    if (current === null) {
      throw new HermeticError("FORBIDDEN", NO_POLICY_SCOPE_NOTE, { scope: "none" });
    }
    if (expected !== current.etag) {
      throw new HermeticError(
        "CONFLICT",
        "the policy file changed since the plan was made; run `hermetic plan policy` again",
        { planned: expected, observed: current.etag },
      );
    }
    yield evt("fetch", 0.2, `read the policy (etag ${current.etag})`, nowIso(), undefined, "done");

    checkAbort(opts.signal, "render");
    const { write, skipped } = planBlocks(current.text);
    const next = applyManagedBlocks(current.text, write);
    const written = write.map((b) => b.key).join(", ");
    if (!next.changed) {
      yield evt(
        "done",
        1,
        `the tailnet policy already says what hermetic would say${written.length > 0 ? ` (${written})` : ""}`,
        nowIso(),
      );
      return;
    }
    yield evt(
      "render",
      0.4,
      `rendering hermetic's blocks: ${written}${skipped.size > 0 ? `; leaving ${[...skipped].join(", ")} as you wrote it` : ""}`,
      nowIso(),
    );

    checkAbort(opts.signal, "validate");
    const check = await backend.tailscale.validatePolicy(next.text);
    if (!check.ok) {
      throw new HermeticError(
        check.message === NO_POLICY_WRITE_SCOPE ? "FORBIDDEN" : "VALIDATION",
        check.message === NO_POLICY_WRITE_SCOPE ? forbiddenNote() : check.message,
      );
    }
    yield evt("validate", 0.6, "tailscale validated the new policy", nowIso());

    checkAbort(opts.signal, "write");
    const outcome = await backend.tailscale.setPolicy(next.text, current.etag);
    if (outcome.kind === "conflict") {
      throw new HermeticError(
        "CONFLICT",
        "the policy file changed since the plan was made; run `hermetic plan policy` again",
        { planned: current.etag },
      );
    }
    if (outcome.kind === "forbidden") throw new HermeticError("FORBIDDEN", forbiddenNote());
    if (outcome.kind === "invalid") throw new HermeticError("VALIDATION", outcome.message);

    // The etags and never the text: the policy can name people (§8.3).
    await appendEvent(
      FLEET_KEY,
      "policy.apply",
      `wrote hermetic's blocks (${written}) to the tailnet policy; etag ${current.etag} → ${outcome.etag}`,
    );
    yield evt(
      "done",
      1,
      `wrote hermetic's blocks to the tailnet policy: ${written}${skipped.size > 0 ? `; ${[...skipped].join(", ")} left as you wrote it` : ""}`,
      nowIso(),
    );
  }

  return { status, plan, apply };
}

function forbiddenNote(): string {
  return "the OAuth client lacks policy_file; recreate it with the scope and run `hermetic secrets push _fleet --tailscale-oauth`";
}

/**
 * `init`'s half (§4.7 step 4): put hermetic's blocks in, right after the OAuth
 * secret lands in SSM and before anything else needs the tailnet.
 *
 * Written as a function rather than reusing `createPolicy` because `init` has
 * no frozen config yet and therefore no `guardAccount` to run — and because
 * nothing here may fail the op: an OAuth client without `policy_file` is the
 * state every fleet is in today, and the answer to it is the paste-ready
 * snippet the heads have always printed, not a refusal.
 */
export async function writeHermeticPolicy(
  backend: Backend,
): Promise<
  | { kind: "written"; keys: string[]; skipped: string[] }
  | { kind: "current" }
  | { kind: "manual"; reason: string }
> {
  try {
    const current = await backend.tailscale.getPolicy();
    if (current === null) return { kind: "manual", reason: NO_POLICY_SCOPE_NOTE };
    const { write, skipped } = planBlocks(current.text);
    const next = applyManagedBlocks(current.text, write);
    if (!next.changed) return { kind: "current" };
    const check = await backend.tailscale.validatePolicy(next.text);
    if (!check.ok) {
      return {
        kind: "manual",
        reason: check.message === NO_POLICY_WRITE_SCOPE ? READ_ONLY_POLICY_NOTE : check.message,
      };
    }
    const outcome = await backend.tailscale.setPolicy(next.text, current.etag);
    if (outcome.kind === "written") {
      return { kind: "written", keys: write.map((b) => b.key), skipped: [...skipped] };
    }
    if (outcome.kind === "forbidden") return { kind: "manual", reason: READ_ONLY_POLICY_NOTE };
    if (outcome.kind === "invalid") return { kind: "manual", reason: outcome.message };
    return { kind: "manual", reason: "the policy file was edited while init was writing it" };
  } catch (e) {
    return { kind: "manual", reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * What `teardown` says about the tailnet policy instead of editing it (§5.2).
 *
 * hermetic installs and updates its managed entries but never takes them back
 * out on its own: the tailnet outlives any one foundation, and the rules a
 * fleet wrote may be the rules another fleet is still reached through. So a
 * teardown leaves the whole policy file untouched — with `--purge` as much as
 * without it — and says so, in the plan, in the event stream and on the
 * receipt.
 *
 * One exported string rather than three sentences that agree today, because
 * the three places quote it verbatim and an operator comparing the plan they
 * confirmed against the receipt they kept has to read the same words. It costs
 * no policy read and no policy write, which is the other half of the rule: a
 * client with no `policy_file` scope, and a Tailscale API that is down
 * altogether, both produce exactly this notice rather than a manual step.
 */
export const POLICY_RETAINED_NOTICE =
  "Tailnet policy left unchanged; managed rules may serve other fleets. Review them manually in the Tailscale admin console if cleanup is desired.";
