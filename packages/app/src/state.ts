/**
 * What the routes read, and how it changes underneath them.
 *
 * `hermetic-portal` has to start on a laptop that has never run `init` — that is
 * the whole point of the browser wizard — so the server can boot in one of three
 * states, and the state can change while it is running:
 *
 * - **initialized**: `openHermetic()` succeeded; every route works.
 * - **uninitialized**: `openHermetic()` answered `NOT_INITIALIZED`, so the
 *   server holds core's pre-init instance instead (`openForInit`). Only
 *   `init.listProfiles` / `init.resolveIdentity` / `init` are callable on it;
 *   everything else refuses, which is exactly what the wizard needs.
 * - **uninitialized against the fixture backend**, for developing the wizard
 *   without an AWS account.
 * - **no fleet selected** (§4.8): this home has fleets but names none — the
 *   default was torn down and two others remain, or `HERMETIC_FLEET` points at
 *   one that is gone. It looks like the uninitialized state (an `openForInit`
 *   session, so `init --attach` still works) but carries a `fleetError`, and
 *   `POST /api/fleets/switch` is what resolves it. `hermetic-portal` must
 *   *start* in this state rather than die of it: the fleet switcher is the
 *   thing best placed to fix it.
 *
 * When the wizard's `init` op finishes, the server reopens core and swaps the
 * instance in place. Handlers therefore read `state.hermetic` per request rather
 * than closing over an instance at build time — a captured reference would keep
 * serving `NOT_INITIALIZED` forever.
 */
import {
  HermeticError,
  createFixtureAccount,
  fleetTargetOf,
  hasCode,
  isHermeticError,
  openForInit,
  openHermetic,
} from "@hermetic/core";
import type {
  FixtureOptions,
  FleetsListResult,
  FleetTarget,
  Hermetic,
  LocalConfig,
  RunTarget,
} from "@hermetic/core";
import { type FleetPoller, getPoller } from "./poller.ts";

/**
 * §4.8: the two ways a home with fleets in it can still fail to name one, and
 * the reason neither may take `hermetic-portal` down.
 *
 * `FLEET_REQUIRED` is what a laptop looks like after `teardown --reset-local`
 * removed the fleet that was the default and left two others behind;
 * `NOT_FOUND` is a `HERMETIC_FLEET` that names a fleet this home no longer has.
 * Both are *choices the operator has not made yet*, and the portal is the thing
 * that exists to let them make it — so the server boots into a "pick a fleet"
 * state and `POST /api/fleets/switch` is how it leaves.
 */
export const RECOVERABLE_FLEET_CODES = ["FLEET_REQUIRED", "NOT_FOUND"] as const;

/** Why this server has no fleet selected, when that is a choice rather than an absence. */
export interface FleetError {
  code: string;
  message: string;
}

/** How long `/api/meta` may reuse a `fleets.list()` answer (§4.8). */
export const FLEETS_CACHE_MS = 5000;

/**
 * A `reopen` for a state built around one instance somebody else constructed
 * (`openState({ hermetic })`, which is how the tests build one). It can
 * hand that instance back, and it must not pretend to be able to hand back a
 * different fleet: a switch that silently returned the same instance would move
 * the label on the dashboard and nothing else.
 */
export function fixedInstance(hermetic: Hermetic): (fleet?: string) => Promise<Hermetic> {
  return (fleet?: string) => {
    if (fleet === undefined) return Promise.resolve(hermetic);
    return Promise.reject(
      new HermeticError(
        "UNSUPPORTED",
        "this head was built around a single core instance and cannot switch fleets; open the Hermetic app",
        { fleet },
      ),
    );
  };
}

/** The pre-init half of core, whichever way it was obtained. */
export interface InitSessionLike {
  /** Pre-init instance: `init.listProfiles`, `init.resolveIdentity`, `init`. */
  hermetic: Hermetic;
  /** Rebinds core to a chosen profile so `init` can run against it. */
  bind(input: { profile: string; region: string; accountId: string }): Hermetic;
  /** Credential env vars that are set and ignored (§4.7). */
  envOverrides: readonly string[];
  /** Set when an unreadable `hermetic.db` was renamed aside on open. */
  corruptedTo: string | null;
  /**
   * Rebuild the initialized core instance from what `init` just froze. Real
   * mode reopens the actual home; fixture mode returns an instance over the
   * same in-memory backend and config store the wizard wrote to, so `adopt()`
   * sees the operator's posted region/tailnet rather than a fresh fixture.
   */
  reopen(): Promise<Hermetic>;
  close(): void;
}

/**
 * Recorded when a teardown op finishes `ok` with `reset_local: true` (see
 * `AppState.resetToUninitialized`). The wizard shows this once — it survives
 * until the next `init` op adopts, at which point `adopt()` clears it, because a
 * freshly (re)initialized fleet has nothing left to tell the operator about the
 * one it just walked away from.
 */
export interface LastTeardown {
  at: string;
  account_id: string;
  region: string;
  fleet_id: string;
  /** Leftovers teardown does not reach — e.g. Tailscale admin console entries. */
  manual_steps: string[];
}

export interface AppStateOptions {
  fixture: boolean;
  /**
   * The fixture knobs every open from this state carries, including the one
   * fake account they all stand in (§4.8): a fleet switch rebuilds the backend
   * and must still see the same fleet list. Ignored in real mode.
   */
  fixtureOptions?: FixtureOptions;
  home: string;
  /**
   * Reopens core: once `init` has frozen a config, and — given a fleet id or
   * display alias — against a *different* frozen fleet (§4.8). One function
   * rather than two because a switch and an adopt want the same thing
   * (`openHermetic` over this home) and differ only in whether they name a
   * fleet.
   */
  reopen: (fleet?: string) => Promise<Hermetic>;
  /** Absent when the state is already initialized. */
  session?: InitSessionLike | null;
  hermetic?: Hermetic | null;
  /** The fleet `hermetic` was opened as (§4.8); `config.show().fleet_id`. */
  fleetId?: string | null;
  /**
   * The whole of that fleet's immutable identity (§4.7): the account, the
   * region and the `fleet_id`. What every fleet-scoped mutation is checked
   * against (`target.ts`). Absent only where there is nothing to check against:
   * an uninitialized head. A state built around a single instance takes it
   * from that instance's own `target` — it cannot switch fleets, but the page
   * talking to it can still name one, so it is guarded.
   */
  target?: FleetTarget | null;
  /**
   * Set instead of `hermetic` when this home has fleets but none was selected
   * (§4.8). The state is uninitialized-*like* — it holds an `openForInit`
   * session, so `init --attach` still works — but `GET /api/fleets` lists real
   * rows and `POST /api/fleets/switch` is what resolves it.
   */
  fleetError?: FleetError | null;
  poller?: FleetPoller | null;
  /** Keys the poller singleton; see `getPoller`. */
  pollerKey?: (config: LocalConfig & { stack_id: string | null }) => string;
}

/**
 * The poller singleton's key (§4.8). The fleet name is in it because a home may
 * hold several fleets in one account and region: without it, switching from
 * `main` to `staging` would find the existing slot, keep the old poller, and
 * the dashboard would go on rendering the fleet the operator just left.
 */
export function pollerKeyFor(
  config: LocalConfig & { stack_id: string | null },
  fixture: boolean,
): string {
  return `${fixture ? "fixture" : "aws"}:${config.account_id}:${config.region}:${config.fleet_id}`;
}

export class AppState {
  readonly fixture: boolean;
  readonly fixtureOptions: FixtureOptions;
  readonly home: string;
  #hermetic: Hermetic | null;
  #poller: FleetPoller | null;
  #session: InitSessionLike | null;
  #reopen: (fleet?: string) => Promise<Hermetic>;
  #pollerKey: (config: LocalConfig & { stack_id: string | null }) => string;
  /**
   * Which fleet `#hermetic` was opened as (§4.8), by `fleet_id`; null while
   * uninitialized. Never the display alias: a fleet may have none, and two
   * aliasless fleets keyed by `name ?? ""` would share a poller, an op-registry
   * scope and a resume filter.
   */
  #fleetId: string | null;
  /**
   * The account, region and `fleet_id` of `#hermetic`, read from its own config
   * when it was installed (§4.7). `#fleetId` is the third of those three and is
   * kept separately because it keys the poller, the op registry and the resume
   * filter; this is the whole triple, and it is what a request has to name
   * before this server will mutate anything.
   */
  #target: FleetTarget | null;
  /** Why no fleet is selected, when fleets exist and the operator has not chosen (§4.8). */
  #fleetError: FleetError | null;
  /**
   * Held across `switchFleet`'s reopen-and-install. The ops-running check and
   * the install are separated by two awaits, and without a latch an
   * `agents.create` could be accepted in that gap and run against the instance
   * the switch is in the middle of replacing.
   */
  #switching = false;
  /**
   * §4.8: `/api/meta` wants the fleet list on every call and a directory Scan
   * on every call is not what that is worth. Five seconds — long enough that a
   * dashboard's burst of reads costs one read, short enough that a `fleet use`
   * from a terminal shows up on its own; and every write that could change it
   * (`fleets.use`, a switch, an adopt, a teardown reset) drops it explicitly.
   */
  #fleetsCache: { at: number; value: FleetsListResult } | null = null;
  /** The op id of an in-flight `POST /api/init`; single-flights the wizard's init op. */
  #initOpId: string | null = null;
  /** Set when `init` finished but `adopt()` (the reopen + swap) failed. */
  #adoptError: string | null = null;
  /** The op id of an in-flight `POST /api/teardown`; guards mutating routes while it runs. */
  #teardownOpId: string | null = null;
  /**
   * The op id of an in-flight `POST /api/foundation/update` (§6.6). Same job as
   * `#teardownOpId`: the fleet lock core takes would refuse an agent mutation
   * anyway, but only after a round trip to DynamoDB — and for a streaming
   * method, only after a 202 the browser has already started following.
   */
  #foundationUpdateOpId: string | null = null;
  /** Set by `resetToUninitialized()`; cleared by the next successful `adopt()`. */
  #lastTeardown: LastTeardown | null = null;

  constructor(options: AppStateOptions) {
    this.fixture = options.fixture;
    this.fixtureOptions = options.fixtureOptions ?? {};
    this.home = options.home;
    this.#hermetic = options.hermetic ?? null;
    this.#poller = options.poller ?? null;
    this.#session = options.session ?? null;
    this.#reopen = options.reopen;
    this.#fleetId = options.fleetId ?? null;
    this.#target = options.target ?? null;
    this.#fleetError = options.fleetError ?? null;
    this.#pollerKey = options.pollerKey ?? ((config) => pollerKeyFor(config, options.fixture));
  }

  /** True once a config row exists and core is serving from it. */
  get initialized(): boolean {
    return this.#hermetic !== null;
  }

  /**
   * The instance routes use. Before init that is the pre-init instance, whose
   * every non-init method refuses — so an uninitialized server answers
   * `NOT_INITIALIZED` (409) rather than crashing.
   */
  get hermetic(): Hermetic {
    const found = this.#hermetic ?? this.#session?.hermetic;
    if (!found) throw new Error("server state has neither an instance nor an init session");
    return found;
  }

  get session(): InitSessionLike | null {
    return this.#session;
  }

  /**
   * The `fleet_id` this server is currently serving (§4.8), or null while it is
   * uninitialized. Read by `/api/meta`, by the op registry (every run this
   * server records says which fleet it was against) and by `resumePendingOps`,
   * which must not replay another fleet's interrupted create.
   */
  get fleetId(): string | null {
    return this.#fleetId;
  }

  /**
   * Why this server is serving no fleet, when that is the operator's unmade
   * choice rather than an uninitialized home (§4.8). Null in every other state,
   * including a genuinely fresh laptop — that one is `initialized: false` with
   * nothing frozen, and the wizard, not the switcher, is its answer.
   */
  get fleetError(): FleetError | null {
    return this.#fleetError;
  }

  /**
   * The immutable identity of the fleet this server is serving (§4.7), or null
   * when it is serving none. Read synchronously by `requireTarget` on every
   * fleet-scoped mutation.
   */
  get target(): FleetTarget | null {
    return this.#target;
  }

  /**
   * What every run the op registry opens is recorded against (§4.6): the whole
   * target — account, region, `fleet_id` and the alias at the time — read off
   * the open instance, so the row this head writes and the row a CLI writes say
   * the same thing about the same fleet. Null while uninitialized: the only ops
   * started then are the wizard's own, against a fleet that does not exist yet.
   */
  get runTarget(): RunTarget | null {
    return this.#hermetic?.target ?? null;
  }

  /** True while `switchFleet` is between its guard and its install. */
  get switching(): boolean {
    return this.#switching;
  }

  get poller(): FleetPoller | null {
    return this.#poller;
  }

  /**
   * `fleets.list()`, at most once every `FLEETS_CACHE_MS` (§4.8). `/api/meta`
   * reads it on every call and would otherwise Scan the directory every time;
   * `GET /api/fleets` deliberately does not go through here, because a list an
   * operator asked for is a list they want to be true right now.
   *
   * `null` on any failure, for the same reason `/api/meta`'s `foundation` and
   * `settings` are: the route the whole UI boots from must not be the one an
   * unreachable directory can stop. (Core does not throw here in practice — it
   * reports an unreachable directory through `directory_error` — but a route
   * that boots the UI does not get to assume that.)
   */
  async fleetsSummary(now: number = Date.now()): Promise<FleetsListResult | null> {
    const cached = this.#fleetsCache;
    if (cached !== null && now - cached.at < FLEETS_CACHE_MS) return cached.value;
    try {
      const value = await this.hermetic.fleets.list();
      this.#fleetsCache = { at: now, value };
      return value;
    } catch {
      return null;
    }
  }

  /** Records a list somebody else just read, so a fresh read also warms the cache. */
  cacheFleets(value: FleetsListResult, now: number = Date.now()): void {
    this.#fleetsCache = { at: now, value };
  }

  /** Drops the cached list. Called by every write that could have changed it. */
  invalidateFleets(): void {
    this.#fleetsCache = null;
  }

  /** The op id of the currently-running init op, or `null` when none is in flight. */
  get initOpId(): string | null {
    return this.#initOpId;
  }

  /** Claims the single init-op slot. Callers must clear it with `endInit()`. */
  beginInit(opId: string): void {
    this.#initOpId = opId;
  }

  /** Releases the init-op slot, whether the op ended `ok`, `error`, or never started. */
  endInit(): void {
    this.#initOpId = null;
  }

  /** Set when a finished init op could not be adopted; cleared by a successful `adopt()`. */
  get adoptError(): string | null {
    return this.#adoptError;
  }

  /** The op id of the currently-running teardown op, or `null` when none is in flight. */
  get teardownOpId(): string | null {
    return this.#teardownOpId;
  }

  /** Claims the teardown-op slot. Callers must clear it with `endTeardown()`. */
  beginTeardown(opId: string): void {
    this.#teardownOpId = opId;
  }

  /** Releases the teardown-op slot, whether the op ended `ok`, `error`, or never started. */
  endTeardown(): void {
    this.#teardownOpId = null;
  }

  /** The op id of the currently-running foundation update, or `null` when none is in flight. */
  get foundationUpdateOpId(): string | null {
    return this.#foundationUpdateOpId;
  }

  /** Claims the foundation-update slot. Callers must clear it with `endFoundationUpdate()`. */
  beginFoundationUpdate(opId: string): void {
    this.#foundationUpdateOpId = opId;
  }

  /** Releases the slot, whether the op ended `ok`, `error`, or never started. */
  endFoundationUpdate(): void {
    this.#foundationUpdateOpId = null;
  }

  /** What the wizard shows once, after a teardown reset this server to uninitialized. */
  get lastTeardown(): LastTeardown | null {
    return this.#lastTeardown;
  }

  /**
   * Called when the wizard's `init` op finishes `ok`: reopen core, swap it in,
   * and start the poller that uninitialized mode had no fleet to run.
   *
   * A failure here leaves the server uninitialized with its session intact —
   * `init` itself already succeeded, so the fleet exists either way — but it
   * must not silently re-offer the wizard as if nothing had happened. The
   * failure is recorded in `adoptError` so `/api/meta` and `/api/init*` can
   * surface it instead.
   */
  /**
   * Put an instance in place: read what fleet it is, swap it in, and hand the
   * poller singleton a key that names that fleet. Shared by `adopt()` (after
   * `init`) and `switchFleet()` (§4.8) so there is one description of "this is
   * now the fleet this server serves" rather than two that can drift.
   *
   * `config.show()` is read *before* anything is replaced: an instance that
   * cannot say what it is has not arrived yet, and the caller keeps what it had.
   */
  async #install(hermetic: Hermetic): Promise<void> {
    const config = await hermetic.config.show();
    const previous = this.#poller;
    this.#hermetic = hermetic;
    this.#fleetId = config.fleet_id;
    this.#target = fleetTargetOf(config);
    const poller = getPoller(hermetic, this.#pollerKey(config));
    // `getPoller` stops the singleton it replaces, but a state holding a poller
    // that was never the singleton (a test, or an app built around a bare
    // `Hermetic`) would otherwise leave it ticking against the old fleet.
    if (previous !== null && previous !== poller) previous.stop();
    this.#poller = poller;
    // A different fleet is a different `current`, and possibly a different
    // `default`: whatever `/api/meta` last cached is about the fleet before this
    // one.
    this.invalidateFleets();
  }

  async adopt(): Promise<void> {
    try {
      // The session, when there is one, knows how to rebuild the *exact*
      // instance `init` just froze — for the fixture backend that means the
      // same in-memory store the wizard wrote its posted region/tailnet into,
      // not a fresh `FIXTURE_CONFIG`. `this.#reopen` (an `openHermetic` call)
      // is only the fallback for the no-session case, which `adopt()` should
      // never actually reach.
      const hermetic = this.#session ? await this.#session.reopen() : await this.#reopen();
      await this.#install(hermetic);
      const session = this.#session;
      this.#session = null;
      this.#adoptError = null;
      // `init` froze a fleet — and, when this home had none, made it the default.
      this.#fleetError = null;
      // A fleet that just (re)initialized has nothing left to say about the one
      // teardown walked away from; the wizard has shown it exactly once.
      this.#lastTeardown = null;
      session?.close();
    } catch (e) {
      this.#adoptError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  /**
   * §4.8: point this server at another fleet frozen in the same home, without
   * restarting it. The switch is *local* — it reopens core, swaps the instance
   * and re-keys the poller — and deliberately changes nothing else: the ops
   * registry, the run log and the pending log are properties of this laptop,
   * not of the fleet, and an op that was streaming keeps streaming against the
   * instance it captured.
   *
   * Refused while anything is in flight. A create against `main` that is still
   * waiting for a box to boot would otherwise finish against an instance that
   * is no longer the one the dashboard is showing, and a teardown, an init or a
   * foundation update would be mid-sentence about a fleet the server had walked
   * away from. `opsRunning` is the ops registry's half of that question; the
   * caller supplies it because the registry belongs to the app, not the state.
   *
   * Nothing is replaced until the new instance has opened *and* answered
   * `config.show()`: a fleet that is not frozen here throws `NOT_FOUND` from
   * core and this server is exactly where it was. `fleet` may be a `fleet_id`
   * or a display alias — core's one resolver decides, and what lands here is
   * always the id.
   */
  async switchFleet(fleet: string, options: { opsRunning?: boolean } = {}): Promise<void> {
    const inFlight =
      options.opsRunning === true ||
      this.#switching ||
      this.#initOpId !== null ||
      this.#teardownOpId !== null ||
      this.#foundationUpdateOpId !== null;
    if (inFlight) {
      throw new HermeticError(
        "CONFLICT",
        "an operation is in flight; wait for it to finish before switching fleets",
        { fleet, ...(this.#fleetId !== null ? { current: this.#fleetId } : {}) },
      );
    }
    /**
     * §4.8: a server with no fleet selected but fleets to select *is* switchable
     * — that state exists precisely so this call can resolve it. A home with
     * nothing frozen is a different thing and wants the wizard.
     */
    if (!this.initialized && this.#fleetError === null) {
      throw new HermeticError(
        "NOT_INITIALIZED",
        "this hermetic home has no frozen fleet to switch away from; run `hermetic init`",
        { fleet },
      );
    }
    if (this.initialized && fleet === this.#fleetId) return;
    // Set before the first await, which is what makes it a latch rather than a
    // second read of the same race: from here the mutating routes refuse
    // (`switchBlocked` in `app.ts`) until the install has landed or failed.
    this.#switching = true;
    try {
      await this.#install(await this.#reopen(fleet));
      // Whatever was unchosen has now been chosen.
      const session = this.#session;
      this.#session = null;
      this.#fleetError = null;
      session?.close();
    } finally {
      this.#switching = false;
    }
  }

  /**
   * Called when a teardown op finishes `ok` with `reset_local: true`: stop the
   * poller, drop the instance whose foundation has just been deleted, and then
   * work out what this laptop still has — a surviving fleet to serve, fleets it
   * can no longer choose between, or nothing at all, which is the only one of
   * the three the init wizard is the answer to (`#adoptSurvivingFleet`).
   *
   * Ops started before the teardown are untouched: they keep streaming from the
   * `OpRegistry`, which does not hold a reference to `state.hermetic`.
   */
  async resetToUninitialized(lastTeardown: LastTeardown): Promise<void> {
    this.#poller?.stop();
    this.#poller = null;
    this.#hermetic = null;
    this.#fleetId = null;
    this.#target = null;
    this.#adoptError = null;
    // The fleet whose row this teardown removed is gone from the list too.
    this.#fleetError = null;
    this.invalidateFleets();
    this.#lastTeardown = lastTeardown;
    /**
     * §4.6: `teardown --reset-local` drops *that fleet's* row and no other, and
     * returns the home to uninitialized only when no fleet row is left. This
     * server has to follow the same rule, because it is the thing an operator
     * is looking at when it happens: dropping a two-fleet home into the init
     * wizard says the laptop has nothing frozen, which is false, and leaves the
     * fleet switcher — the one control that would fix it — behind a screen that
     * exists for a laptop in a different state entirely.
     *
     * So selection runs again. A survivor is adopted; a home that has fleets
     * but can no longer name one becomes the picker (`#fleetError`, the state
     * `POST /api/fleets/switch` resolves); only a home with nothing left gets
     * the wizard.
     */
    if (await this.#adoptSurvivingFleet(lastTeardown.fleet_id)) return;
    const session = await openForInit({
      fixture: this.fixture,
      fixtureOptions: this.fixtureOptions,
      home: this.home,
    });
    this.#session = session;
  }

  /**
   * Re-runs core's fleet selection after a teardown and installs what it
   * answers, or records why it could not (§4.8).
   *
   * Two answers are refusals rather than failures. A `FLEET_REQUIRED` or
   * `NOT_FOUND` is this home holding fleets and naming none — carried as the
   * recoverable selection state, exactly as it is at boot. An instance that
   * comes back still pointed at the fleet that was just torn down is not a
   * survivor at all: a server built around a single core instance cannot
   * reopen, and adopting the foundation this teardown deleted would be the
   * worst answer available.
   */
  async #adoptSurvivingFleet(destroyed: string): Promise<boolean> {
    try {
      const hermetic = await this.#reopen();
      const config = await hermetic.config.show();
      if (config.fleet_id === destroyed) return false;
      await this.#install(hermetic);
      return true;
    } catch (e) {
      if (isHermeticError(e) && (RECOVERABLE_FLEET_CODES as readonly string[]).includes(e.code)) {
        this.#fleetError = { code: e.code, message: e.message };
      }
      return false;
    }
  }
}

export interface OpenStateOptions {
  fixture?: boolean;
  /** The fixture's knobs (`fixture-env.ts`); the account is filled in here if absent. */
  fixtureOptions?: FixtureOptions;
  /**
   * Force the wizard path when this home has no config; `HERMETIC_UNINIT=1`.
   * Does **not** mask an already-initialized real home: the flag only ever
   * substitutes for "no config found", never for a genuine one (see
   * `openState`).
   */
  uninitialized?: boolean;
  home?: string;
  /** Injected by tests. */
  hermetic?: Hermetic;
}

/**
 * The one place that decides which of the three states the server boots in.
 * `openHermetic` throwing `NOT_INITIALIZED` is a normal outcome here, not an
 * error: it is how a fresh laptop looks.
 */
export async function openState(options: OpenStateOptions = {}): Promise<AppState> {
  const fixture = options.fixture ?? process.env["HERMETIC_FIXTURE"] === "1";
  const forceUninit = options.uninitialized ?? process.env["HERMETIC_UNINIT"] === "1";
  /**
   * §4.8: one fake account for the life of this state. Every open below — the
   * boot, a fleet switch, the wizard, the post-teardown reopen — stands in it,
   * so a backend rebuilt for another fleet lists the same fleets and a fleet
   * the wizard just created is the one a later switch finds.
   */
  const fixtureOptions: FixtureOptions = fixture
    ? { ...options.fixtureOptions, account: options.fixtureOptions?.account ?? createFixtureAccount() }
    : {};
  /**
   * §4.8: `fleet` is how `AppState.switchFleet` asks for a *different* frozen
   * fleet in this home. Absent, core's own selection rule decides, exactly as it
   * does for a bare CLI command.
   */
  const reopen =
    options.hermetic !== undefined
      ? fixedInstance(options.hermetic)
      : (fleet?: string) =>
          openHermetic({
            fixture,
            fixtureOptions,
            ...(options.home !== undefined ? { home: options.home } : {}),
            ...(fleet !== undefined ? { fleet } : {}),
          });

  /**
   * Set when the open failed because no fleet was *selected* rather than
   * because none exists (§4.8). It is carried onto the state below, so the
   * server boots into a "pick a fleet" screen instead of not booting.
   */
  let fleetError: FleetError | null = null;

  const tryInitialized = async (): Promise<AppState | null> => {
    try {
      const hermetic = options.hermetic ?? (await reopen());
      const config = await hermetic.config.show();
      fleetError = null;
      return new AppState({
        fixture,
        fixtureOptions,
        home: options.home ?? hermeticHomeHint(options.home),
        reopen,
        hermetic,
        fleetId: config.fleet_id,
        target: fleetTargetOf(config),
        poller: getPoller(hermetic, pollerKeyFor(config, fixture)),
      });
    } catch (e) {
      /**
       * `hermetic-portal` must start. A home that has fleets but names none —
       * `teardown --reset-local` took the default away and left two behind, or
       * `HERMETIC_FLEET` points at one that is gone — used to take the process
       * down with the very error the portal is best placed to fix, since it is
       * the thing with a fleet switcher in it. Recorded and carried instead.
       */
      if (isHermeticError(e) && (RECOVERABLE_FLEET_CODES as readonly string[]).includes(e.code)) {
        fleetError = { code: e.code, message: e.message };
        return null;
      }
      // Anything other than that, or "this home has no config", is a real failure.
      if (!hasCode(e, "NOT_INITIALIZED")) throw e;
      return null;
    }
  };

  if (!forceUninit) {
    const initialized = await tryInitialized();
    if (initialized) return initialized;
  } else {
    // `--uninitialized` / `HERMETIC_UNINIT=1` exists to develop the wizard on a
    // laptop that would otherwise boot straight to the dashboard. It must not
    // let an already-initialized *real* home bypass the "already initialized"
    // 409s on `/api/init*` (§4.6's retarget guard lives behind those) — so
    // before honoring the flag, open the pre-init session anyway and check
    // whether this home actually has a frozen config. Only a genuinely
    // uninitialized home is forceable into the wizard against a live instance
    // (fixture mode never has an `existingConfig`, so this is a no-op there).
    const probe = await openForInit({
      fixture,
      fixtureOptions,
      ...(options.home !== undefined ? { home: options.home } : {}),
    });
    if (probe.existingConfig !== null) {
      probe.close();
      const initialized = await tryInitialized();
      if (initialized) return initialized;
      // Fell through: the config vanished or failed to open between the probe
      // and the real open. Genuinely uninitialized after all — open fresh below.
    } else {
      return new AppState({
        fixture,
        fixtureOptions,
        home: probe.home,
        reopen,
        session: probe,
        fleetError,
      });
    }
  }

  // Core's fixture mode gives an in-memory session with a fake profile list, so
  // the wizard can be developed and verified without an AWS account.
  const session = await openForInit({
    fixture,
    fixtureOptions,
    ...(options.home !== undefined ? { home: options.home } : {}),
  });
  return new AppState({
    fixture,
    fixtureOptions,
    home: session.home,
    reopen,
    session,
    // §4.8: null on a fresh laptop (the wizard's case), set when this home has
    // fleets and the operator has not said which — the switcher's case.
    fleetError,
  });
}

function hermeticHomeHint(home?: string): string {
  return home ?? process.env["HERMETIC_HOME"] ?? "~/.hermetic";
}
