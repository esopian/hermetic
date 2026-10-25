/**
 * The paired fleet: the pairing link, the live view from hermeticd's
 * `GET /fleet`, and which agents this phone listens to. Not React:
 * `FleetProvider.tsx` subscribes to it.
 *
 * What is persisted, and where (§9.4):
 * - the link, the listening choice and the primary instance, in the keychain (`hermetic.fleet.v2`,
 *   SecureStore). SecureStore values are capped near 2 KB and a link may be up
 *   to 2,900 characters, so the record is split across numbered keys;
 * - the last fleet view, as a JSON file in the document directory. It is a
 *   cache of what any box will say again, not a secret.
 *
 * `refresh()` asks up to three listened boxes at once and takes the first
 * answer. When none answers — no box reachable, or a foundation that does not
 * grant the agent role its scan yet (`FLEET_LIST_UNAVAILABLE`, a fleet before
 * foundation 16) — the snapshot stays, the state says `stale`, and the boxes
 * are asked for their own `/healthz` instead (`fromBoxes`): every listened box,
 * plus up to `HEALTHZ_OTHERS` of the rest in turn, so a large fleet is not
 * swept on every refresh. A box answers `ready` where hermeticd answered ok,
 * `unreachable` where it did not, and nothing where the off-tunnel gate refused
 * to ask (`TUNNEL_UNVERIFIED`); a box not asked this time keeps its last answer.
 *
 * Listening starts empty. A new pairing listens to nothing until the operator
 * picks one primary instance (`setPrimary`, `needsPrimary`); from then on the
 * phone listens to that one, and to any other the operator opts into. No
 * answer from a box widens or narrows the choice. The link's agent list
 * is the floor: an agent the link names and `/fleet` does not is still listed
 * (with no status), and where both name it the view wins, except that a fresher
 * `/healthz` answer wins over a cached view.
 */
import type { MobileFleetAgent, MobileFleetView } from "@hermetic/core/schema";
import { MobileFleetView as MobileFleetViewSchema } from "@hermetic/core/schema";
import { reasonOf } from "../client/errors.ts";
import type { RosterPrefs, RosterPrefsStorage } from "../client/roster-store.ts";
import { agentHost, type FleetHosts } from "../gateway/client.ts";
import { type FetchLike, fetchHealthz, firstFleetView } from "../gateway/hermeticd.ts";
import { type PairedLink, readPairingLink } from "./pairing.ts";

/* ── persistence seams ──────────────────────────────────────────────────── */

/** A string key-value store: SecureStore in the app, a Map in tests. */
export interface KvStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** One file's text: the fleet-view cache. */
export interface TextFile {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
  remove(): Promise<void>;
}

/** In-memory stand-ins, for tests and fixture mode. */
export function memoryKv(seed: Record<string, string> = {}): KvStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => {
      map.set(key, value);
    },
    remove: async (key) => {
      map.delete(key);
    },
  };
}

export function memoryFile(initial: string | null = null): TextFile & { text: () => string | null } {
  let text = initial;
  return {
    text: () => text,
    read: async () => text,
    write: async (next) => {
      text = next;
    },
    remove: async () => {
      text = null;
    },
  };
}

/** `kv` under `prefix`: fixture mode keeps its pairing beside, never over, a real one. */
export function prefixedKv(kv: KvStorage, prefix: string): KvStorage {
  return {
    get: (key) => kv.get(`${prefix}${key}`),
    set: (key, value) => kv.set(`${prefix}${key}`, value),
    remove: (key) => kv.remove(`${prefix}${key}`),
  };
}

/**
 * Where home keeps its pins and folds, per fleet. An older save's extra fields
 * (a `primary` bot, from before home showed every pin) are dropped on load.
 */
export function rosterPrefsStorage(kv: KvStorage): RosterPrefsStorage {
  return {
    async load(fleetId) {
      const raw = await kv.get(`hermetic.rail.${fleetId}`).catch(() => null);
      if (!raw) return null;
      try {
        const v = JSON.parse(raw) as Partial<RosterPrefs>;
        const strings = (x: unknown) =>
          Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
        return {
          pinned: strings(v.pinned),
          folded: strings(v.folded),
        };
      } catch {
        return null;
      }
    },
    save: (fleetId, prefs) => kv.set(`hermetic.rail.${fleetId}`, JSON.stringify(prefs)),
  };
}

export const FLEET_KEY_PREFIX = "hermetic.fleet.v2";
/** One paired fleet's record, beside the others (`fleets.ts` keeps the list). */
export const fleetRecordKey = (fleetId: string): string => `${FLEET_KEY_PREFIX}.${fleetId}`;
/** Under SecureStore's ~2 KB value cap with room for multi-byte characters. */
export const SECURE_CHUNK = 1_800;
const MAX_CHUNKS = 8;

/** Write `text` under `key`, split into `key.0`, `key.1`, … and a count at `key`. */
export async function saveChunked(kv: KvStorage, key: string, text: string): Promise<void> {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += SECURE_CHUNK) parts.push(text.slice(i, i + SECURE_CHUNK));
  if (parts.length > MAX_CHUNKS) throw new Error("the pairing record is too large to keep");
  for (const [i, part] of parts.entries()) await kv.set(`${key}.${i}`, part);
  for (let i = parts.length; i < MAX_CHUNKS; i++) await kv.remove(`${key}.${i}`);
  await kv.set(key, String(parts.length));
}

export async function loadChunked(kv: KvStorage, key: string): Promise<string | null> {
  const count = Number(await kv.get(key));
  if (!Number.isInteger(count) || count < 1 || count > MAX_CHUNKS) return null;
  let text = "";
  for (let i = 0; i < count; i++) {
    const part = await kv.get(`${key}.${i}`);
    if (part === null) return null;
    text += part;
  }
  return text;
}

export async function removeChunked(kv: KvStorage, key: string): Promise<void> {
  await kv.remove(key);
  for (let i = 0; i < MAX_CHUNKS; i++) await kv.remove(`${key}.${i}`);
}

/* ── state ──────────────────────────────────────────────────────────────── */

export type Listening = ReadonlySet<string> | "all";

export interface FleetState {
  /** The pairing, or `null` before one (or after sign out). */
  link: PairedLink | null;
  /** The last `GET /fleet` answer, or `null` when no box has answered yet. */
  view: MobileFleetView | null;
  listening: Listening;
  /**
   * The instance home is built around, chosen after pairing; `null` until the
   * operator picks one. It stays primary when its listening is switched off.
   */
  primary: string | null;
  /** When the view was last refreshed from a box (ISO), else `null`. */
  refreshed_at: string | null;
  /** The last refresh failed: what is shown is the snapshot. */
  stale: boolean;
  refreshing: boolean;
  /** Why the last refresh failed (`FLEET_LIST_UNAVAILABLE`, `HERMETICD_UNAVAILABLE`, …). */
  error: { code: string; message: string } | null;
  /**
   * Per-agent status read from each box's `/healthz` after `/fleet` failed, or
   * `null` while `/fleet` answers (or before any fallback ran).
   */
  fromBoxes: Readonly<Record<string, BoxStatus>> | null;
}

/** What a box's own `/healthz` says about it, when `/fleet` could not. */
export type BoxStatus = "ready" | "unreachable";

/** An agent's status as the phone shows it: the view's, or a `/healthz` fallback's. */
export type FleetAgentStatus = MobileFleetAgent["status"] | "unreachable";

/** One agent as the phone lists it: the link's floor, with the view's facts when it has them. */
export interface FleetAgent {
  name: string;
  /** MagicDNS name the phone dials. */
  host: string;
  status: FleetAgentStatus | null;
  tailscale_ip: string | null;
  version: string | null;
  health: MobileFleetAgent["health"] | null;
  /** Named by `/fleet` (not only by the link). */
  live: boolean;
}

interface Persisted {
  link: string;
  /** `"all"`, or the agent names. */
  listening: string[] | "all";
  /**
   * The primary instance, or `null` before one is picked. A record from before
   * the field takes its listened list's first name (sorted), else `null`.
   */
  primary: string | null;
}

export interface FleetStoreDeps {
  secure: KvStorage;
  /**
   * Where this fleet's record lives (`fleetRecordKey`): `FLEET_KEY_PREFIX`, the
   * one-fleet key, when absent; `null` before any pairing (nothing to load).
   */
  recordKey?: string | null;
  viewCache: TextFile;
  fetch: FetchLike;
  /** ISO-8601 now. */
  now: () => string;
  /** A tailnet besides `*.ts.net` this build trusts. */
  operatorTailnet?: string | null;
  /** Per-box `/fleet` timeout. */
  timeoutMs?: number;
  /** One box's `/healthz` (the pre-v17 fallback); defaults to `fetchHealthz` over `fetch`. */
  healthz?: (host: string) => Promise<{ ok: boolean; error?: { code: string } | null }>;
}

/** How many boxes one refresh asks at once. */
export const REFRESH_FAN_OUT = 3;
/** How many unlistened boxes one pre-v17 refresh asks for `/healthz`, beside the listened ones. */
export const HEALTHZ_OTHERS = 3;

const EMPTY: FleetState = {
  link: null,
  view: null,
  listening: new Set(),
  primary: null,
  refreshed_at: null,
  stale: false,
  refreshing: false,
  error: null,
  fromBoxes: null,
};

export class FleetStore {
  private state: FleetState = EMPTY;
  /** `state.view` is a `/fleet` answer read by this store's own refresh, not a cache or nothing. */
  private viewFresh = false;
  private readonly listeners = new Set<() => void>();
  private gen = 0;
  /** Where the next pre-v17 refresh starts in the unlistened boxes. */
  private othersCursor = 0;

  constructor(private readonly deps: FleetStoreDeps) {}

  getState(): FleetState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Restore the pairing and the cached view. `false` when there is no pairing.
   * A keychain read that fails throws instead: iOS refuses reads while a
   * background launch runs on a locked phone, and that is not "unpaired".
   */
  async load(): Promise<boolean> {
    if (this.deps.recordKey === null) {
      this.set(EMPTY);
      return false;
    }
    const raw = await loadChunked(this.deps.secure, this.key());
    const stored = parsePersisted(raw);
    const proposal = stored ? readPairingLink(stored.link, this.opts()) : null;
    if (!stored || !proposal?.ok) {
      this.set(EMPTY);
      return false;
    }
    const link = proposal.link;
    const view = await this.readCache(link.payload.fleet_id);
    this.viewFresh = false;
    this.set({
      ...EMPTY,
      link,
      view,
      listening: stored.listening === "all" ? "all" : new Set(stored.listening),
      primary: stored.primary,
      refreshed_at: view?.read_at ?? null,
    });
    return true;
  }

  /**
   * Keep a confirmed pairing, replacing any before it. Another fleet listens to
   * nothing and has no primary: the operator picks one (`setPrimary`) before
   * home. The same fleet again (a re-scanned QR) keeps the listening choice,
   * the primary and the cached view, less any agent the new link no longer
   * names: the link lists every live agent, so one it leaves out was destroyed.
   * A dropped primary leaves `needsPrimary` true, and the picker shows again.
   *
   * A link may be trimmed: `encodeMobileLink` drops agents off the end to stay
   * under `MOBILE_LINK_MAX_LENGTH`, and then says how many the fleet has
   * (`agents_total`). A trimmed link drops nothing; the next `/fleet` answer is
   * what lists the fleet.
   */
  async pair(link: PairedLink): Promise<void> {
    this.gen += 1;
    const fleetId = link.payload.fleet_id;
    const replacing = this.state.link?.payload.fleet_id !== fleetId;
    this.viewFresh = false;
    if (replacing) {
      await this.deps.viewCache.remove().catch(() => {});
      this.set({ ...EMPTY, link });
    } else {
      const { listening, primary } = this.state;
      const view = this.state.view ?? (await this.readCache(fleetId));
      const named = new Set(link.payload.agents.map((a) => a.name));
      const trimmed = (link.payload.agents_total ?? 0) > named.size;
      const kept = (name: string) => trimmed || named.has(name);
      this.set({
        ...EMPTY,
        link,
        view,
        refreshed_at: this.state.refreshed_at ?? view?.read_at ?? null,
        listening: listening === "all" ? "all" : new Set([...listening].filter(kept)),
        primary: primary !== null && kept(primary) ? primary : null,
      });
    }
    await this.persist();
  }

  /** Forget the pairing, the cache and the listening choice. */
  async signOut(): Promise<void> {
    this.gen += 1;
    this.viewFresh = false;
    this.set(EMPTY);
    await removeChunked(this.deps.secure, this.key()).catch(() => {});
    await this.deps.viewCache.remove().catch(() => {});
  }

  /** Ask up to three listened boxes for the fleet; the first answer wins. */
  async refresh(): Promise<boolean> {
    const link = this.state.link;
    if (!link) return false;
    const gen = ++this.gen;
    this.set({ refreshing: true });
    const hosts = this.refreshHosts();
    try {
      const { view } = await firstFleetView(this.deps.fetch, hosts, link.payload.fleet_id, {
        ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
      });
      if (gen !== this.gen) return false;
      this.viewFresh = true;
      this.set({
        view,
        refreshed_at: this.deps.now(),
        stale: false,
        refreshing: false,
        error: null,
        fromBoxes: null,
      });
      await this.deps.viewCache.write(JSON.stringify(view)).catch(() => {});
      return true;
    } catch (error) {
      if (gen !== this.gen) return false;
      const reason = reasonOf(error);
      // No box served `/fleet`: ask each one about itself instead.
      const fromBoxes = await this.readBoxes();
      if (gen !== this.gen) return false;
      this.set({ stale: true, refreshing: false, error: reason, fromBoxes });
      return false;
    }
  }

  /**
   * The listened boxes' `/healthz`, plus up to `HEALTHZ_OTHERS` unlistened ones
   * in turn, at once: `ready`, `unreachable`, or left out when the gate refused.
   * A box not asked this time keeps its last answer.
   */
  private async readBoxes(): Promise<Record<string, BoxStatus> | null> {
    const healthz = this.deps.healthz ?? ((host: string) => fetchHealthz(host, this.deps.fetch));
    const all = this.agents();
    if (all.length === 0) return null;
    const listened = all.filter((a) => this.isListening(a.name));
    const others = all.filter((a) => !this.isListening(a.name));
    const start = others.length > 0 ? this.othersCursor % others.length : 0;
    const turn = [...others.slice(start), ...others.slice(0, start)].slice(0, HEALTHZ_OTHERS);
    this.othersCursor = start + turn.length;
    const agents = [...listened, ...turn];
    const answers = await Promise.all(
      agents.map(async (a): Promise<[string, BoxStatus | null]> => {
        let answer: { ok: boolean; error?: { code: string } | null };
        try {
          answer = await healthz(a.host);
        } catch (error) {
          answer = { ok: false, error: reasonOf(error) };
        }
        if (answer.ok) return [a.name, "ready"];
        // The gate did not ask: that says nothing about the box.
        return [a.name, answer.error?.code === "TUNNEL_UNVERIFIED" ? null : "unreachable"];
      }),
    );
    const asked = new Set(agents.map((a) => a.name));
    const kept = Object.entries(this.state.fromBoxes ?? {}).filter(([name]) => !asked.has(name));
    const known = answers.filter((e): e is [string, BoxStatus] => e[1] !== null);
    const merged = [...kept, ...known];
    return merged.length > 0 ? Object.fromEntries(merged) : null;
  }

  /* ── reading ──────────────────────────────────────────────────────────── */

  /** The names the gateway client dials by, for `boxAddress`. */
  hosts(): FleetHosts | null {
    const link = this.state.link;
    if (!link) return null;
    const viewed = new Map((this.state.view?.agents ?? []).map((a) => [a.name, a.tailscale_dns_name]));
    const names = new Set([...link.payload.agents.map((a) => a.name), ...viewed.keys()]);
    return {
      fleet_id: link.payload.fleet_id,
      tailnet: link.payload.tailnet,
      agents: [...names].map((name) => ({
        name,
        host: viewed.get(name) ?? link.payload.agents.find((a) => a.name === name)?.host ?? null,
      })),
    };
  }

  /** The MagicDNS name of `name`'s box. */
  hostOf(name: string): string | null {
    const hosts = this.hosts();
    return hosts ? agentHost(hosts, name) : null;
  }

  /** Every agent, name-sorted: the link's, merged with the view's (the view wins). */
  agents(): FleetAgent[] {
    const hosts = this.hosts();
    if (!hosts) return [];
    const viewed = new Map((this.state.view?.agents ?? []).map((a) => [a.name, a]));
    const boxes = this.state.fromBoxes;
    return hosts.agents
      .map(({ name }) => {
        const v = viewed.get(name);
        return {
          name,
          host: agentHost(hosts, name),
          status: boxes?.[name] ?? v?.status ?? null,
          tailscale_ip: v?.tailscale_ip ?? null,
          version: v?.version ?? null,
          health: v?.health ?? null,
          live: v !== undefined,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The agents this phone listens to, name-sorted. */
  listened(): string[] {
    const listening = this.state.listening;
    const names = this.agents().map((a) => a.name);
    return listening === "all" ? names : names.filter((n) => listening.has(n));
  }

  /** Paired, and no primary instance picked yet: the picker comes before home. */
  needsPrimary(): boolean {
    return this.state.link !== null && this.state.primary === null;
  }

  /**
   * Make `name` the primary instance and listen to it (others stay as they
   * are). Throws for a name this fleet does not list.
   */
  async setPrimary(name: string): Promise<void> {
    if (!this.agents().some((a) => a.name === name))
      throw new Error(`${name} is not an agent in this fleet`);
    const current = this.state.listening;
    const listening = current === "all" ? "all" : new Set([...current, name]);
    this.set({ primary: name, listening });
    await this.persist();
  }

  /**
   * `name` is gone by this store's own `/fleet` answer: the view a refresh read
   * does not name it, or names it `destroyed`. Always `false` before a refresh
   * answered, since a cached view may predate an agent the link names.
   */
  isGone(name: string): boolean {
    if (!this.viewFresh || !this.state.view) return false;
    const agent = this.state.view.agents.find((a) => a.name === name);
    return agent === undefined || agent.status === "destroyed";
  }

  isListening(name: string): boolean {
    const listening = this.state.listening;
    return listening === "all" || listening.has(name);
  }

  /**
   * Listen to one agent or stop; answers the new listened list. Stopping the
   * primary is allowed: it stays primary (home still shows it).
   */
  async setListening(name: string, on: boolean): Promise<string[]> {
    const current = this.state.listening;
    const base = current === "all" ? new Set(this.agents().map((a) => a.name)) : new Set(current);
    if (on) base.add(name);
    else base.delete(name);
    this.set({ listening: base });
    await this.persist();
    return this.listened();
  }

  async setListeningAll(): Promise<void> {
    this.set({ listening: "all" });
    await this.persist();
  }

  /* ── internals ────────────────────────────────────────────────────────── */

  /** Up to three listened boxes, ready ones first; the link's agents when none is listened. */
  private refreshHosts(): string[] {
    const agents = this.agents();
    const listened = new Set(this.listened());
    const pool = agents.filter((a) => listened.has(a.name));
    const candidates = (pool.length > 0 ? pool : agents).sort(
      (a, b) => Number(b.status === "ready") - Number(a.status === "ready"),
    );
    return candidates.slice(0, REFRESH_FAN_OUT).map((a) => a.host);
  }

  private async readCache(fleetId: string): Promise<MobileFleetView | null> {
    try {
      const text = await this.deps.viewCache.read();
      if (!text) return null;
      const parsed = MobileFleetViewSchema.safeParse(JSON.parse(text));
      return parsed.success && parsed.data.fleet.fleet_id === fleetId ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async persist(): Promise<void> {
    const link = this.state.link;
    if (!link) return;
    const listening = this.state.listening;
    const record: Persisted = {
      link: link.link,
      listening: listening === "all" ? "all" : [...listening].sort(),
      primary: this.state.primary,
    };
    await saveChunked(this.deps.secure, this.key(), JSON.stringify(record));
  }

  private key(): string {
    return this.deps.recordKey ?? FLEET_KEY_PREFIX;
  }

  private opts(): { operatorTailnet?: string | null } {
    return this.deps.operatorTailnet !== undefined
      ? { operatorTailnet: this.deps.operatorTailnet }
      : {};
  }

  private set(patch: Partial<FleetState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }
}

/**
 * What the app badge counts (`InboxStore.badgeCount`): entries about an agent
 * this phone listens to. Shared by the provider and the background wake.
 */
export function listenedEntry(
  fleet: Pick<FleetStore, "listened">,
): (entry: { instance: string }) => boolean {
  const listened = new Set(fleet.listened());
  return (entry) => listened.has(entry.instance);
}

function parsePersisted(raw: string | null): Persisted | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Persisted>;
    if (typeof v.link !== "string") return null;
    const listening =
      v.listening === "all"
        ? "all"
        : Array.isArray(v.listening)
          ? v.listening.filter((x): x is string => typeof x === "string")
          : [];
    const primary =
      typeof v.primary === "string"
        ? v.primary
        : v.primary === undefined && Array.isArray(listening)
          ? ([...listening].sort()[0] ?? null)
          : null;
    return { link: v.link, listening, primary };
  } catch {
    return null;
  }
}
