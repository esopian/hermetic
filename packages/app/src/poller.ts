/**
 * The fleet poller (§3.4). One scan a minute into an in-memory snapshot,
 * diffed by the fields the UI actually renders. Clients get a `snapshot` on
 * connect and then only what changed — the decision in §11.2 not to do
 * incremental sync is what makes this cheap enough to be the only source of
 * live state.
 */
import type { AgentView, Hermetic, Notification } from "@hermetic/core";

/**
 * The fleet tick. A minute, not seconds: every tick is a real DynamoDB scan
 * (and the EC2 reads behind `agents.list`) on a real account, the rows it
 * reads are written by a 30s heartbeat, and nothing an operator does waits on
 * it — an op in flight reports through its own stream (`ops.subscribe`), not
 * through this. The page's staleness thresholds are multiples of the same
 * number (`POLL_INTERVAL_MS` in `packages/ui/src/logic/loading.ts`).
 */
export const POLL_INTERVAL_MS = 60_000;

/**
 * Whether a slower tick riding the fleet tick is due. Half a fleet tick of
 * slack, because the fleet tick is what carries it: `now` is read after the
 * scan resolves, so two ticks sixty seconds apart can stamp 59.8s apart, and
 * a strict comparison against an interval that is a whole number of fleet
 * ticks would skip every other one on that jitter alone.
 */
function due(elapsed: number, interval: number): boolean {
  return elapsed >= interval - POLL_INTERVAL_MS / 2;
}

/**
 * How often the poller also runs the reads that reconcile `fleet.advisory`
 * rows (§4.9). Equal to the fleet tick today, so they run on every one; kept
 * as its own number because it is a separate decision, and a faster fleet tick
 * must not drag these AWS reads along with it.
 *
 * An advisory is a condition, and a condition is only closed by the scan that
 * computes it — `foundation.status` for the foundation update and the Bedrock
 * grant, `volumes.list` for a loose volume. The fleet tick calls neither, so
 * without this the only thing that resolves three of the four advisories is an
 * operator happening to open that view, and the bell goes on reporting a
 * condition that was fixed days ago.
 *
 * One minute, because these are *real* AWS reads on a real account (a DynamoDB
 * scan, an EC2 `DescribeVolumes`) and none of the four conditions can change
 * without a person doing something — running `foundation update`, deleting a
 * volume, granting a model. A minute of staleness on a condition that takes
 * minutes to fix is invisible; seconds of it would be an abusive amount of
 * traffic for the same answer.
 */
export const ADVISORY_INTERVAL_MS = 60_000;

/**
 * How often the roster is read so that core's `chat.message` source can run
 * (§4.9).
 *
 * A reply that arrives without this portal having driven the turn — a cron
 * routine, a messaging channel, a peer bot, another Hermes client — is only
 * visible as a transcript that has moved on, so `chat.swarms` is where core
 * raises the row and something has to make that read happen on a schedule. This
 * is that something, and it belongs here for the same reason the advisory tick
 * does: a source nobody ticks delivers nothing, and the browser is the wrong
 * place to own the clock. A tick in the chat view's own provider fires only
 * while that view is open, which is precisely when the operator does not need
 * telling; a tick in the inbox provider fires only while a browser is pointed
 * at the portal at all.
 *
 * Two minutes rather than the advisory minute, because this read is a *fan-out
 * over the tailnet* — one HTTPS round trip per box — rather than two AWS calls.
 * §9.2's one saving grace is that reading a roster does not take one of a
 * gateway's ~3 warm backend slots, so the cost is bandwidth and latency and not
 * a bot that cannot be talked to.
 */
export const CHAT_INTERVAL_MS = 120_000;

export type FleetEvent =
  /**
   * `scanned` is false for the snapshot a client gets when it connects before
   * the poller's first scan has come back: the agent list is empty because
   * nothing has been read yet, not because the fleet is empty. Without it the
   * dashboard cannot tell "no agents" from "no answer yet" and says the wrong
   * one on every cold start.
   */
  | { type: "snapshot"; at: string; agents: AgentView[]; scanned: boolean }
  | { type: "agent"; at: string; agent: AgentView }
  | { type: "removed"; at: string; name: string }
  | { type: "poll"; at: string }
  /**
   * A scan that threw. Deliberately not named `error`: a frame is delivered to
   * a reader by its own name, and every transport that has carried these
   * already spends `error` on "this feed is gone" — so a scan failure under
   * that name reads as a dead channel and triggers a reconnect nothing needed
   * (`packages/ui/src/api/streams.ts` makes the same distinction on its side).
   */
  | { type: "scan_error"; at: string; message: string }
  /**
   * §4.9: one row the inbox has gained since the last tick. Carried
   * on the fleet stream rather than on a feed of its own — one subscription per
   * window, one reconnect path, and the stream a page already has open is the
   * stream a toast should arrive on.
   *
   * Only rows raised *after* the poller started: a page connecting to a
   * month-old inbox must not be handed thirty days of toasts. The centre reads
   * `notifications.list` for the backlog.
   */
  | { type: "notification"; at: string; notification: Notification }
  /**
   * The badge. Emitted when either count moves — including *down*, which an
   * `ack` in another tab is the usual cause of and which no `notification`
   * frame would ever report.
   */
  | { type: "notifications"; at: string; unread: number; needs_action: number };

/**
 * The identity of an agent's rendered state; a change in any of it is an upsert.
 *
 * `version` covers every field an *operator's* write touches, which is why the
 * list is this short. Everything after it is a fact `version` cannot see:
 *
 * `display_status` and `heartbeat_age_ms` are computed from the clock, and
 * `update_available` is computed from the *fleet's* settings (§8.3) — a profile
 * rotated in another tab moves it without touching a single agent row, so a
 * fingerprint of `version` alone would leave every connected browser showing
 * "up to date" until something else happened to write the row. `pending` and
 * `profile_revision` are named beside it because they are what the drawer
 * renders that annotation against, and a fingerprint that agreed with the view
 * on two of the three would be a subtler version of the same bug.
 *
 * `bootstrap` is the same argument for the one view that moves fastest. The box
 * writes its stage board with `setBootstrap`, which deliberately bumps no
 * `version` — a stage finishing is an observation, and §4.4 will not let an
 * observation fail an operator's CAS write. But the row's `version`,
 * `display_status` (`bootstrapping` throughout) and `heartbeat_age_ms` (null
 * until the box's first heartbeat, which is after the bootstrap) are all
 * constant for the whole boot, so without this every stage completing was
 * invisible to a connected browser: the board sat on whatever stage it had when
 * the drawer opened and only a reload — a fresh `snapshot`, read from the row —
 * moved it.
 */
function fingerprint(a: AgentView): string {
  return [
    a.name,
    a.version,
    a.display_status,
    a.heartbeat_age_ms ?? "null",
    a.update_available === true ? "update" : "current",
    a.profile_revision ?? "null",
    a.pending?.profile_id ?? "null",
    a.pending?.profile_revision ?? "null",
    bootstrapPrint(a),
  ].join("|");
}

/**
 * The stage board reduced to what the drawer draws from it: which stage is
 * running, and the state of each square.
 *
 * `attempt` is in there because a `rerun` resumes a failed stage in place — the
 * id and the status both come back to what they already were, and a board that
 * did not notice would leave a red square red while the box was retrying it.
 * The timestamps are deliberately *not*: `updated_at` moves on every write the
 * runner makes, which would make this fingerprint change on nothing an operator
 * can see and push an event to every browser on every tick for the whole
 * boot.
 */
function bootstrapPrint(a: AgentView): string {
  const b = a.bootstrap;
  if (!b) return "no-bootstrap";
  return [b.current ?? "between", ...b.stages.map((s) => `${s.id}:${s.status}:${s.attempt}`)].join(",");
}

export class FleetPoller {
  private readonly listeners = new Set<(e: FleetEvent) => void>();
  private agents = new Map<string, AgentView>();
  private prints = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private at = new Date(0).toISOString();
  /** Flipped by the first scan that comes back at all, error or not. */
  private scanned = false;
  /**
   * The high-water mark of what has been pushed to clients: rows at or before
   * it have been delivered (or predate this process, which is the same thing
   * for a live stream). Starts at *now* rather than at the epoch so a portal
   * booting onto a month-old inbox opens with a quiet screen.
   */
  private notifiedThrough = new Date().toISOString();
  /** Last counts sent, so the badge frame goes out on a change and not on a tick. */
  private counts: { unread: number; needs_action: number } | null = null;
  /**
   * When the advisory reads last ran. Zero, not "now", so the first fleet tick
   * runs them: an operator opening the portal is owed an inbox that is current
   * as of the moment they opened it, not one that catches up a minute later.
   */
  private advisoriesAt = 0;
  /**
   * When the roster read last ran. Zero for `advisoriesAt`'s reason — the first
   * tick after a portal starts establishes the watermarks every later tick
   * diffs against, and deferring it two minutes defers the first notification
   * by the same amount.
   */
  private chatAt = 0;
  /**
   * The tick in flight, or null.
   *
   * A tick is every minute and its slowest half is a tailnet fan-out,
   * so a slow one used to be overlapped by the next — two `agents.list` reads
   * racing to write one `agents` map, two roster sweeps against one box. Polls
   * are serial instead: a caller that arrives while one is running is handed
   * that one rather than starting a second. The route that forces a scan
   * therefore still awaits a scan, and the interval's tick is skipped.
   */
  private inFlight: Promise<void> | null = null;
  /**
   * Aborted by `stop()`. Passed to every core call in a tick that takes a
   * signal, and read after every await so a poll that was in the air when the
   * portal shut down emits nothing and advances no watermark.
   */
  private aborter = new AbortController();
  /** `stop()` is terminal; nothing here starts again afterwards. */
  private halted = false;

  constructor(
    private readonly hermetic: Hermetic,
    /** Injectable so a test can drive the advisory cadence without a real minute. */
    private readonly now: () => number = Date.now,
  ) {}

  start(): this {
    // `stop()` is terminal: it aborts the signal every read in a tick carries
    // and silences `emit`, and neither is rebuilt. Re-arming the interval here
    // would put a poller on the clock that scans and says nothing, forever.
    // A fleet switch replaces the poller rather than restarting one
    // (`getPoller`), so refusing costs no caller anything.
    if (this.halted || this.timer) return this;
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    // Do not keep the process alive for the sake of polling.
    this.timer.unref?.();
    void this.poll();
    return this;
  }

  stop(): void {
    this.halted = true;
    // The reads a tick is in the middle of, ended. Clearing the interval alone
    // left an in-flight poll running to completion after the shutdown, still
    // emitting to listeners and still moving `notifiedThrough` past rows no
    // browser was told about.
    this.aborter.abort();
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): FleetEvent & { type: "snapshot" } {
    return {
      type: "snapshot",
      at: this.at,
      agents: [...this.agents.values()],
      scanned: this.scanned,
    };
  }

  subscribe(listener: (e: FleetEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: FleetEvent): void {
    // A stopped poller says nothing. A tick can be several awaits deep when the
    // portal shuts down, and a frame delivered after that is a listener the
    // shutdown believed it had already finished with.
    if (this.halted) return;
    for (const l of [...this.listeners]) l(event);
  }

  /**
   * One tick. The interval calls this, and so does anything that wants a scan
   * driven by hand rather than by the clock — a fleet switch, and the tests.
   *
   * Serial: while a tick is in flight this hands back that tick rather than
   * starting a second one over the same state. A caller is therefore promised
   * *a* completed scan, not one that began after it asked; nothing in the
   * server needs the stronger promise, and a follow-up scan queued behind
   * every overlapping call would put the overlap back under another name.
   */
  poll(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const run = this.scan().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async scan(): Promise<void> {
    if (this.halted) return;
    const at = new Date().toISOString();
    let rows: AgentView[];
    try {
      rows = await this.hermetic.agents.list();
    } catch (e) {
      if (this.halted) return;
      this.at = at;
      this.scanned = true;
      this.emit({ type: "scan_error", at, message: e instanceof Error ? e.message : String(e) });
      return;
    }
    // The read came back after the portal let go: nothing it says is worth
    // recording, and the snapshot a late reader would take of it is nobody's.
    if (this.halted) return;
    this.at = at;
    this.scanned = true;

    const seen = new Set<string>();
    for (const agent of rows) {
      seen.add(agent.name);
      const print = fingerprint(agent);
      if (this.prints.get(agent.name) !== print) {
        this.prints.set(agent.name, print);
        this.agents.set(agent.name, agent);
        this.emit({ type: "agent", at, agent });
      } else {
        this.agents.set(agent.name, agent);
      }
    }
    for (const name of [...this.agents.keys()]) {
      if (seen.has(name)) continue;
      this.agents.delete(name);
      this.prints.delete(name);
      this.emit({ type: "removed", at, name });
    }
    await this.pollAdvisories();
    if (this.halted) return;
    await this.pollChat();
    if (this.halted) return;
    await this.pollNotifications(at);
    this.emit({ type: "poll", at });
  }

  /**
   * The slow half of a tick: the two reads whose only job here is to let their
   * own advisory observers run (§4.9, `observeAdvisories`). Their
   * results are thrown away — `foundation.status` and `volumes.list` write the
   * rows on the way past, and the fleet stream already carries them out through
   * `pollNotifications`.
   *
   * Placed after the early return on a failed `agents.list`, which is the guard
   * that answers "is there a fleet to scan": a poller only exists once a fleet
   * is installed (`AppState.#install`), and one whose scan is throwing —
   * an account gone, a teardown in flight — spends nothing further on advisories
   * until it comes back.
   *
   * Runs before `pollNotifications` so a row raised by this tick reaches the
   * browser on this tick rather than the next.
   *
   * Each read is wrapped on its own: an unreachable account degrades how fresh
   * an advisory is and never the fleet view, and a foundation read that throws
   * must not also cost the volume reconciliation.
   */
  private async pollAdvisories(): Promise<void> {
    const now = this.now();
    if (!due(now - this.advisoriesAt, ADVISORY_INTERVAL_MS)) return;
    // Stamped before the reads, not after, so a slow scan cannot make the next
    // one land an interval after it *finished* and drift the cadence out.
    this.advisoriesAt = now;
    try {
      // `hermes: false`: the upstream release check is a GitHub request, it is
      // not one of the four conditions, and nothing here would render it.
      await this.hermetic.foundation.status({}, { hermes: false });
    } catch {
      /* an advisory is a courtesy; an unreadable foundation never fails a poll */
    }
    try {
      await this.hermetic.volumes.list({});
    } catch {
      /* likewise: a volume read that throws costs the advisory, not the fleet */
    }
  }

  /**
   * The chat source's tick (§4.9).
   *
   * It reads the roster and throws the answer away. The roster is the chat
   * view's data and the browser holds its own copy; what this call is for is
   * the side effect core performs while answering it — diffing each bot's last
   * message against a stored watermark and writing a `chat.message` row for
   * anything that moved. The row leaves on the fleet stream like every other.
   *
   * **It asks nothing when nothing can answer.** `chat.swarms` fans out over
   * the tailnet and a box that is stopped does not refuse, it times out, so a
   * fleet that is switched off would spend a full timeout sweep every two
   * minutes for an answer that is known in advance. The gate is the fleet scan
   * this tick already did: at least one box has to be in a state where a
   * dashboard could plausibly reply. It is deliberately not "the box answered
   * last time" — a box coming back up has to be asked once before it can prove
   * it is back.
   *
   * A laptop that is off the tailnet still costs one sweep per tick, because
   * from here that is indistinguishable from a fleet that is up; the chat view
   * is the surface that diagnoses that (§9.2) and this is not.
   */
  private async pollChat(): Promise<void> {
    const now = this.now();
    if (!due(now - this.chatAt, CHAT_INTERVAL_MS)) return;
    const reachable = [...this.agents.values()].some(
      (a) => a.display_status === "ready" || a.display_status === "degraded",
    );
    if (!reachable) return;
    // Stamped before the read, like the advisory tick, so a slow fan-out cannot
    // drift the cadence out by however long it took.
    this.chatAt = now;
    try {
      // The one read in a tick that takes a signal, and the one that makes a
      // shutdown wait: a tailnet fan-out at a box that is not answering costs a
      // full timeout, and `stop()` should not have to sit through it.
      await this.hermetic.chat.swarms({}, { signal: this.aborter.signal });
    } catch {
      /* a roster the tailnet would not answer costs the notification, not the poll */
    }
  }

  /**
   * The inbox half of a tick (§4.9). A read of the laptop's own
   * SQLite — no AWS, no event bus in core — so it costs a scan of at most the
   * rows written since the last tick.
   *
   * Runs *after* the agent diff, because `agents.list` is what writes the
   * `agent.health` rows: reading first would deliver every health transition one
   * tick late, which on a one-minute poll is the difference between a toast
   * and a toast that arrives after the row it is about has already moved.
   *
   * Never throws: an unreadable inbox degrades the badge, never the fleet view.
   */
  private async pollNotifications(at: string): Promise<void> {
    try {
      const result = await this.hermetic.notifications.list({ since: this.notifiedThrough });
      // The watermark says "delivered", so a read that lands after the portal
      // stopped delivering must not move it: the next process would open on a
      // quiet screen with rows nobody was ever shown behind it.
      if (this.halted) return;
      // Oldest first, so a burst arrives in the order it was raised.
      for (const notification of [...result.notifications].reverse()) {
        if (notification.at > this.notifiedThrough) this.notifiedThrough = notification.at;
        // A muted row still reaches the centre through the REST read; what it
        // must not do is interrupt, and an undelivered frame is the only
        // reliable way to promise that of every head at once.
        if (notification.muted) continue;
        this.emit({ type: "notification", at, notification });
      }
      const counts = { unread: result.unread, needs_action: result.needs_action };
      if (
        this.counts === null ||
        this.counts.unread !== counts.unread ||
        this.counts.needs_action !== counts.needs_action
      ) {
        this.counts = counts;
        this.emit({ type: "notifications", at, ...counts });
      }
    } catch {
      /* the inbox is a courtesy; an unreadable one never fails a poll */
    }
  }
}

interface PollerSlot {
  key: string;
  hermetic: Hermetic;
  poller: FleetPoller;
}

/**
 * `bun --hot` re-runs module top-level code, so the poller has to be a guarded
 * singleton or every save leaks another interval (§3.5). The guard is keyed on
 * *which fleet* it is polling — a reload that switches between the fixture fleet
 * and a real account, or between accounts, must not keep scanning the old one —
 * and on *which instance* it reads: the same fleet reopened (a re-adopt after a
 * teardown, an attach to the fleet already served) is a new `Hermetic`, and a
 * poller left reading the old one reports a world nothing else is looking at.
 * Replacing it still stops the old interval, so neither case leaks one.
 */
export function getPoller(hermetic: Hermetic, key: string): FleetPoller {
  const g = globalThis as typeof globalThis & { __hermeticPoller?: PollerSlot };
  const existing = g.__hermeticPoller;
  if (existing && existing.key === key && existing.hermetic === hermetic) return existing.poller;
  existing?.poller.stop();
  const slot: PollerSlot = { key, hermetic, poller: new FleetPoller(hermetic).start() };
  g.__hermeticPoller = slot;
  return slot.poller;
}
