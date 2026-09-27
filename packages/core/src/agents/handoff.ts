/**
 * `create`'s handoff (§6.2 step 8, §6.3): the write that releases the row to
 * the box, and the wait that follows it. Split out the way `attach.ts` is —
 * one subject, explicit deps objects, no share of the SDK closure.
 *
 * The write is `commitHandoff` at the foot of this file; the wait is
 * `watchHandoff`, and the rest of this comment is about the wait.
 *
 * Why it exists. `create`'s last act is to release the lock and let hermeticd
 * take over, and for a long time the op simply ended there — at 100%, on the
 * word `done`. That reads as success, and it is not: everything the operator
 * actually cares about (the tailnet address, the stages, the agent loop) has
 * not happened yet, and if the box never reports there is nothing on screen
 * that says so. A create against a foundation whose IAM denied hermeticd every
 * row write reported `ok` in under twelve seconds and then sat, silent, for
 * hours.
 *
 * So the op stays open for a bounded window and watches the row for the box's
 * first word. It is a *read* loop and it holds no lock: the row was unlocked
 * before this started, which is what lets a second operator, `rerun` or the
 * agent itself act while an operator is still watching.
 *
 * A window that expires is not a failure. The resources exist, the row names
 * them, and a slow boot is not a broken one — the watch says so with a warning
 * that names the one command that can still see the box (`logs --console`) and
 * lets the op finish `ok`.
 */
import type { Agent, OpEvent } from "../schema/index.ts";
import type { AgentPatch } from "../backend/types.ts";
import { isHermeticError } from "../errors.ts";
import { evt } from "../events.ts";

/** How long `create` watches for hermeticd's first row write before giving up. */
export const HANDOFF_WATCH_MS = 5 * 60_000;
/** How often it looks. The row is a single `GetItem`; this is not expensive. */
export const HANDOFF_POLL_MS = 10_000;

export interface HandoffDeps {
  /** Read-only: the watch never writes the row it is watching. */
  getAgent: (name: string) => Promise<Agent | null>;
  now: () => number;
  /**
   * Zero disables the watch outright, which is the right default anywhere
   * there is no real box to wait for — every fixture create, and every test
   * that is not about this loop.
   */
  budgetMs: number;
  pollMs: number;
  /** Injected so a test does not spend real seconds. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface HandoffOptions {
  signal?: AbortSignal;
  /** Progress the yielded events carry, start and finish. */
  progress?: { waiting: number; done: number };
  /**
   * The tailnet name this create asked the box to take — `<fleet id>-<agent>`
   * since v4 (`cloudName`), fully qualified. Given, the watch checks the box's
   * own account of its name against it the moment the row carries one.
   *
   * Optional because a caller that does not know the tailnet cannot honestly
   * compare (`agentHostnameMismatch` makes the same refusal), and because every
   * fixture create passes nothing.
   */
  expectHostname?: string;
}

function elapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
}

/**
 * The box has said *something*: hermeticd writes `bootstrap` before it runs its
 * first stage, so the mere presence of the key is first contact. A row that has
 * already moved past `creating` counts too — a fast box can be `bootstrapping`
 * or even `ready` before the first poll lands.
 */
export function hasReported(agent: Agent | null): boolean {
  if (!agent) return false;
  if (agent.bootstrap !== null && agent.bootstrap !== undefined) return true;
  return agent.status !== "creating";
}

/**
 * The name the box reported, when it is one this create did not ask for — else
 * `null`, which covers every case where the question cannot be answered: no
 * expectation given, no row, and (the common one) a first report that has landed
 * before stage 01 has said what the tailnet admitted this node as.
 *
 * The trailing root dot Tailscale includes is not a difference of names.
 */
function misnamed(agent: Agent | null, expect: string | undefined): string | null {
  if (!expect || !agent) return null;
  const real = agent.tailscale_dns_name?.replace(/\.$/, "") ?? null;
  return real !== null && real !== expect ? real : null;
}

/**
 * Watch until the box reports, the budget runs out, or the caller aborts.
 * Yields at most one event per poll, so a five-minute wait is thirty lines and
 * not thirty thousand.
 */
export async function* watchHandoff(
  deps: HandoffDeps,
  name: string,
  opts: HandoffOptions = {},
): AsyncIterable<OpEvent> {
  const { waiting, done } = opts.progress ?? { waiting: 0.94, done: 0.99 };
  if (deps.budgetMs <= 0) return;

  const startedMs = deps.now();
  const deadline = startedMs + deps.budgetMs;
  const at = (): string => new Date(deps.now()).toISOString();

  yield evt("handoff", waiting, "waiting for hermeticd's first report", at(), undefined, "start");

  while (!opts.signal?.aborted) {
    // Read first, sleep second: a box that reported during `attach` should not
    // cost a poll interval of silence before the op notices.
    const agent = await deps.getAgent(name).catch(() => null);
    if (hasReported(agent)) {
      /**
       * The one moment this is free: the row is in hand, and it either carries
       * the name the box took or it does not yet. A create that asked for
       * `k7m2x9qa-atlas` and got `atlas` did not fail — the box is up and
       * reachable — but it did not do what the plan said either, and every
       * screen from here on will show a name the operator did not choose.
       *
       * The cause is a release, not a box: the spelling is asked for by the
       * hermeticd and the stages the *fleet publishes*, so a fleet whose release
       * predates the naming rule builds new nodes under the old one. Nothing on
       * this box can be renamed (a hostname is fixed at boot), so the remedy is
       * to publish and rebuild, and the warning says exactly that.
       */
      const wrong = misnamed(agent, opts.expectHostname);
      if (wrong) {
        yield evt(
          "handoff",
          done,
          `${name} came up as ${wrong} rather than ${opts.expectHostname}: the release this fleet ` +
            `publishes is older than the naming rule this hermetic uses. A hostname is fixed at ` +
            "boot, so run `hermetic artifacts push`, then `hermetic agent recreate " +
            `${name}\` to adopt it`,
          at(),
          "warn",
        );
      }
      yield evt(
        "handoff",
        done,
        `hermeticd reported after ${elapsed(deps.now() - startedMs)}`,
        at(),
        undefined,
        "done",
      );
      return;
    }
    if (deps.now() >= deadline) break;
    await deps.sleep(Math.min(deps.pollMs, Math.max(0, deadline - deps.now())), opts.signal);
  }

  if (opts.signal?.aborted) return;
  yield evt(
    "handoff",
    done,
    `no report from the box after ${elapsed(deps.now() - startedMs)}; ` +
      `the instance exists and is billing — read its serial console with \`hermetic logs ${name} --console\``,
    at(),
    "warn",
    "done",
  );
}

/**
 * How many times the handoff write is retried against a row that moved under
 * it. Three, because each retry costs one `GetItem` and the only writer that
 * can plausibly race it is the box itself, whose first transition happens once.
 */
export const HANDOFF_COMMIT_ATTEMPTS = 3;

/** What the handoff *write* needs: the row, and the conditional update itself. */
export interface HandoffCommitDeps {
  getAgent: (name: string) => Promise<Agent | null>;
  update: (name: string, version: number, patch: AgentPatch) => Promise<Agent>;
}

/** Who this run is, and what it launched — the two things the merge checks. */
export interface HandoffClaim {
  /** The TTL lock owner `create` took at the start of the run (§4.4). */
  owner: string;
  /** The instance this run launched or adopted, and is about to hand off to. */
  instance_id: string;
}

/**
 * Whether the row as it stands now is still the one this run was writing to.
 *
 * Two questions, and they are different. The *lock* answers who is allowed to
 * write: still ours (live or expired — an expiry does not hand the row to
 * anybody in particular), or released and held by nobody, and the merge is
 * safe; held by another owner and another operator has taken the agent over,
 * which is a real `CONFLICT` however tempting the retry looks.
 *
 * The *instance id* answers whether the row still describes this run's work. It
 * is normally already ours, written before the attach. An id naming some other
 * instance means a second run built a different box and got there first, and
 * overwriting it would strand that box: billing, booting, and named by nothing.
 */
function stillOurs(latest: Agent, claim: HandoffClaim): boolean {
  if (latest.lock && latest.lock.owner !== claim.owner) return false;
  const recorded = latest.resources.instance_id ?? latest.instance_id ?? null;
  return recorded === null || recorded === claim.instance_id;
}

/**
 * `create`'s last write: record the instance and the volume, release the lock.
 *
 * It is version-conditional like every other row write, and unlike the others
 * it races a writer that is not an operator at all. The box hermeticd boots on
 * moves the row to `bootstrapping` the moment its stage runner starts, which
 * bumps the version — and a box that boots fast does that while the laptop is
 * still waiting for `AttachVolume` to report. The plain conditional write then
 * failed `CONFLICT`, the lock stayed on the row, and the create reported
 * failure over an agent that was coming up perfectly well.
 *
 * §4.5 already says what to do: a conflict where the store has simply moved on
 * is a stale picture, not a wrong request, and "the part of a patch that is a
 * record of what this run *built* … is true whoever moved the status". So the
 * write is retried against the row as it now stands, and the box's status move
 * is preserved because the patch never mentions `status`. What is *not* retried
 * is a row another operator has locked, or one naming an instance this run did
 * not launch: those are the conflicts the code is for.
 */
export async function commitHandoff(
  deps: HandoffCommitDeps,
  agent: Agent,
  /**
   * Built from the row the write is conditioned on rather than passed in flat:
   * a patch that spreads `resources` must spread the *current* ones, or a retry
   * would put this run's minutes-old copy back over whatever has landed since.
   */
  patch: (row: Agent) => AgentPatch,
  claim: HandoffClaim,
): Promise<Agent> {
  let row = agent;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await deps.update(row.name, row.version, patch(row));
    } catch (e) {
      const last = attempt >= HANDOFF_COMMIT_ATTEMPTS;
      if (last || !isHermeticError(e) || e.code !== "CONFLICT") throw e;
      // A re-read that itself fails must not replace the classified error the
      // caller is owed, exactly as `adopt` treats one (`hermetic.ts`).
      const latest = await deps.getAgent(row.name).catch(() => null);
      if (!latest || !stillOurs(latest, claim)) throw e;
      row = latest;
    }
  }
}
