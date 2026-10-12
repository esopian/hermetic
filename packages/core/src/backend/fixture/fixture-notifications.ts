/**
 * The fixture inbox, as data (§4.9).
 *
 * `bun run dev:fixture` is the whole dev loop for the portal, so every state a
 * notification row can be in has to be reachable there: each of the four kinds,
 * each of the five classes, a read row and an unread one, a muted source, a
 * held advisory of every family a scan can raise, and an action
 * pointing at each target a head has to route. A renderer developed against an inbox containing only failures is a
 * renderer nobody has seen handle a recovery.
 *
 * It lives here rather than in `open.ts` for the reason `fixture-agents.ts`
 * does: it is a *table*, nothing about it is behaviour, and the file that wires
 * fixtures together is the one that keeps growing.
 *
 * Seeded once per fixture home, keyed by fixed ids — a second open finds the
 * rows already there and writes nothing, so acking one in the portal and
 * reloading does not resurrect it.
 */
import { sourceMuteTarget } from "../../schema/index.ts";
import type { NotificationInsert, NotificationStore } from "../../chat/notifications.ts";

/** Fixed, so re-seeding is a no-op and `inbox ack <id>` can be typed twice. */
export const FIXTURE_NOTIFICATION_IDS = [
  "fxn000000001",
  "fxn000000002",
  "fxn000000003",
  "fxn000000004",
  "fxn000000005",
  "fxn000000006",
  "fxn000000007",
  "fxn000000008",
  "fxn000000009",
  "fxn000000010",
  "fxn000000011",
  "fxn000000012",
] as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Relative to the seed moment rather than absolute, so the fixture inbox always
 * reads as "this afternoon" — a fixed date would be a month stale by the time
 * anybody looked at it, and retention (30 days) would eventually delete it.
 */
interface FixtureRow extends Omit<NotificationInsert, "id" | "at" | "fleet" | "read_at"> {
  /** How long before now the row was raised. */
  ago_ms: number;
  /** How long before now it was read; absent on the rows that are still unread. */
  read_at_ago_ms?: number;
  /**
   * Set on a row whose condition is already gone: the seed resolves it as it
   * writes it, so the cleared rendering is in `inbox --fixture` from the first
   * listing rather than only after a scan has run and closed something.
   */
  resolved?: true;
  /**
   * Set on a row the operator has already taken out of the inbox, so the
   * History view has something in it from the first open (§4.9).
   */
  cleared?: true;
  /** Set on a row snoozed until this long after the seed, for the Snoozed view. */
  snoozed_for_ms?: number;
}

const ROWS: readonly FixtureRow[] = [
  {
    ago_ms: 4 * MINUTE_MS,
    source: "agent",
    kind: "agent.health",
    class: "bad",
    title: "heron went error",
    detail: "last heartbeat 6m12s ago - failing: hermes",
    agent: "heron",
    actions: [
      { label: "Probe", target: "agent", ref: "heron" },
      { label: "Logs", target: "agent", ref: "heron" },
    ],
  },
  {
    ago_ms: 21 * MINUTE_MS,
    source: "operation",
    kind: "operation.failed",
    class: "bad",
    title: "create failed - quill",
    // §8.3: a code and a message, never a value. This is what a real row holds.
    detail: "STAGE_FAILED - stage 03-hermes exited 1",
    agent: "quill",
    ref: "fxr000000002",
    actions: [
      { label: "Details", target: "run", ref: "fxr000000002" },
      { label: "Open quill", target: "agent", ref: "quill" },
    ],
  },
  {
    ago_ms: 40 * MINUTE_MS,
    source: "agent",
    kind: "agent.health",
    class: "warn",
    title: "ember is degraded",
    detail: "failing: disk",
    agent: "ember",
    actions: [{ label: "Probe", target: "agent", ref: "ember" }],
  },
  {
    /**
     * The advisory that is *held*, not fired: it carries a `key`, so every
     * scan while the foundation is behind finds this row instead of writing a
     * second one (§4.9). Acking it does not resolve it.
     */
    ago_ms: 3 * HOUR_MS,
    source: "fleet",
    kind: "fleet.advisory",
    class: "needs_action",
    title: "Foundation update available",
    detail: "on v6, this build ships v7",
    key: "fleet.advisory:foundation_update",
    actions: [{ label: "Review", target: "foundation" }],
  },
  {
    /**
     * A model the fixture fleet's stack does not grant. A demo row rather than
     * a live one: the fixture fleet grants everything its profiles name, so the
     * first `foundation status` resolves this — which is the *other* half of
     * §4.9 on screen, and worth being able to watch happen.
     */
    ago_ms: 4 * HOUR_MS,
    source: "fleet",
    kind: "fleet.advisory",
    class: "needs_action",
    title: "Bedrock model anthropic.claude-3-5-haiku-20241022-v1:0 is not granted",
    detail:
      "this fleet's instance role cannot invoke it; `hermetic foundation update` reconciles the grant",
    ref: "anthropic.claude-3-5-haiku-20241022-v1:0",
    key: "fleet.advisory:bedrock_grant:anthropic.claude-3-5-haiku-20241022-v1:0",
    actions: [{ label: "Review", target: "foundation" }],
  },
  {
    /**
     * One row per volume, not one row per scan (§4.9): deleting one loose
     * volume resolves that volume's row and leaves the others asking. This is
     * the volume `seedFixtureVolumes` leaves in group `no_agent`, so a real
     * `volume ls` against the fixture finds the same condition and holds the
     * row rather than writing a second one.
     */
    ago_ms: 5 * HOUR_MS,
    source: "fleet",
    kind: "fleet.advisory",
    class: "info",
    title: "vol-fixture0000000dorado has no agent",
    detail: "500 GiB in us-west-2a - free for 140d - $40.00/mo",
    ref: "vol-fixture0000000dorado",
    key: "fleet.advisory:loose_volume:vol-fixture0000000dorado",
    actions: [{ label: "Volumes", target: "volumes" }],
  },
  {
    /**
     * Live in the fixture: `atlas` sits on the Bedrock profile at r1 while the
     * profile itself is at r2, so `agent ps` recomputes this condition every
     * scan and finds this row instead of raising another.
     */
    ago_ms: 6 * HOUR_MS,
    source: "fleet",
    kind: "fleet.advisory",
    class: "info",
    title: "atlas is on an older provider profile revision",
    detail: "profile bedrock-role is at r2; atlas is on r1",
    agent: "atlas",
    key: "fleet.advisory:profile_revision:atlas",
    actions: [{ label: "Open atlas", target: "agent", ref: "atlas" }],
  },
  {
    ago_ms: 7 * HOUR_MS,
    source: "operation",
    kind: "operation.done",
    class: "ok",
    title: "granite create finished",
    detail: "7m41s",
    agent: "granite",
    ref: "fxr000000001",
    read_at_ago_ms: 6 * HOUR_MS,
    actions: [
      { label: "Details", target: "run", ref: "fxr000000001" },
      { label: "Open granite", target: "agent", ref: "granite" },
    ],
  },
  {
    ago_ms: 26 * HOUR_MS,
    source: "agent",
    kind: "agent.health",
    class: "ok",
    title: "atlas recovered",
    detail: "was unreachable",
    agent: "atlas",
    read_at_ago_ms: 25 * HOUR_MS,
    actions: [{ label: "Open", target: "agent", ref: "atlas" }],
  },
  {
    /**
     * A condition that has since gone away: this volume was deleted, so the
     * next scan found nothing to report and closed the row (§4.9). Seeded
     * already resolved, and appended rather than placed in time order so the
     * ids above stay bound to the rows they already name, because `inbox
     * --fixture` lists without scanning — without this row the cleared
     * rendering, and the fact that resolved and read are different facts, are
     * offline only for somebody willing to wait for a scan to clear something.
     */
    ago_ms: 9 * HOUR_MS,
    source: "fleet",
    kind: "fleet.advisory",
    class: "info",
    title: "vol-fixture000000pelican has no agent",
    detail: "300 GiB in us-west-2b - free for 96d - $24.00/mo",
    ref: "vol-fixture000000pelican",
    key: "fleet.advisory:loose_volume:vol-fixture000000pelican",
    resolved: true,
    actions: [{ label: "Volumes", target: "volumes" }],
  },
  {
    /**
     * Snoozed until tomorrow: out of the inbox and the counts, listed under
     * `--view snoozed`, and back on its own once the moment passes. Appended
     * for the same reason as the row above.
     */
    ago_ms: 50 * MINUTE_MS,
    source: "operation",
    kind: "operation.done",
    class: "ok",
    title: "ember reboot finished",
    detail: "48s",
    agent: "ember",
    ref: "fxr000000002",
    snoozed_for_ms: 20 * HOUR_MS,
    actions: [{ label: "Details", target: "run", ref: "fxr000000002" }],
  },
  {
    /** Read and cleared: the History view's only row that was never a condition. */
    ago_ms: 30 * HOUR_MS,
    source: "operation",
    kind: "operation.done",
    class: "ok",
    title: "corvid stop finished",
    detail: "12s",
    agent: "corvid",
    ref: "fxr000000003",
    read_at_ago_ms: 29 * HOUR_MS,
    cleared: true,
    actions: [{ label: "Details", target: "run", ref: "fxr000000003" }],
  },
];

/**
 * Writes the fixture inbox into whatever store the fixture session opened.
 *
 * Idempotent through the fixed ids: a row that is already there is returned
 * rather than rewritten, so an operator's `ack` survives the next `bun run
 * dev:fixture`. Never throws — a fixture home that cannot be written still gets
 * a working fleet, and an inbox is the least of what it would be missing.
 */
export function seedFixtureNotifications(
  store: NotificationStore,
  fleet: string,
  now: () => number = Date.now,
): void {
  try {
    /**
     * Only on the *first* open of a fixture home, the same rule
     * `seedFixtureFleets` follows. After that the inbox is the operator's: a
     * re-seed would re-apply the muted source somebody had just cleared, and
     * `bun run dev:fixture` is a loop somebody runs twenty times an hour.
     */
    // `all`, not the default `inbox`: an operator who has cleared every row
    // still has a seeded home, and must not be handed the seed again.
    if (store.list({ limit: 1, view: "all" }, fleet).length > 0) return;
    const at = now();
    ROWS.forEach((row, i) => {
      const { ago_ms, read_at_ago_ms: read, resolved, cleared, snoozed_for_ms, ...rest } = row;
      const id = FIXTURE_NOTIFICATION_IDS[i] as string;
      store.insert({
        ...rest,
        id,
        at: new Date(at - ago_ms).toISOString(),
        fleet,
        ...(read === undefined ? {} : { read_at: new Date(at - read).toISOString() }),
      });
      /**
       * The store stamps `resolved_at` itself, so a pre-resolved row is written
       * and then closed rather than inserted closed: it reads as raised hours
       * ago and cleared at this seed, which is what a scan finding the
       * condition gone would have left behind. `read_at` stays null - the world
       * closing a condition is not the operator having read about it (§4.9).
       */
      if (resolved === true && rest.key != null) store.resolve(rest.key);
      if (cleared === true) store.clear({ ids: [id] }, fleet);
      if (snoozed_for_ms !== undefined) {
        store.snooze({ ids: [id], until: new Date(at + snoozed_for_ms).toISOString() }, fleet);
      }
    });
    /**
     * One source muted, so the mute filter and the "muted" styling are both on
     * screen without anybody having to run `inbox mute` first. `fleet` is the
     * least noisy thing to silence: the advisories above stay in the list and
     * simply stop asking for attention.
     */
    store.mute(sourceMuteTarget("fleet"));
  } catch {
    /* an unwritable fixture home still gets a working fleet (§4.6) */
  }
}
