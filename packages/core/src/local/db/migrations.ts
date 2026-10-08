import type { Database } from "bun:sqlite";
import { PREF_DEFAULT_FLEET } from "./config.ts";

/**
 * How far this build's migration list reaches. A high-water mark for display
 * and nothing else: what a database actually contains is decided by the
 * migration *names* recorded in `schema_migrations` (see `MIGRATIONS`), because
 * two branches can and do reach the same number by different routes.
 */
export const SCHEMA_VERSION = 13;

/**
 * A migration this branch may assume ran when a bare *number* is all the ledger
 * records. See `LEGACY_LAST_VERSION` for why the answer can only ever be the
 * five that shipped on `origin/master`.
 */
interface Migration {
  /**
   * The identity. Unique, and frozen the moment it ships — see the rule above
   * `MIGRATIONS`.
   */
  name: string;
  /** Ordering only. Two branches may hold the same number; that is the bug. */
  version: number;
  /**
   * Set only on the migrations that exist on `origin/master`, where a bare
   * numbered row in an old ledger is proof *this* migration is what ran. Never
   * set on a migration written on a branch. `legacyNameFor` additionally caps
   * the window at `LEGACY_LAST_VERSION`, so the flag alone cannot extend it.
   */
  legacy?: true;
  statements: string[];
  /**
   * Columns to add, declared rather than written as SQL, because SQLite has no
   * `ADD COLUMN IF NOT EXISTS` and every migration above `LEGACY_LAST_VERSION`
   * has to survive being re-run (see `MIGRATIONS`). `migrate` reads
   * `PRAGMA table_info` and adds only what is missing, so a ledger that lost
   * this migration's name to a sibling branch's number replays it harmlessly.
   */
  columns?: Array<{ table: string; column: string; type: string }>;
}

/**
 * The last migration whose content is agreed across every branch of this
 * repository, and therefore the last version number that means anything on its
 * own.
 *
 * `origin/master` ends at 5. Every checkout that has ever written a `5` into a
 * ledger wrote the same five migrations, so a row saying `5` is a fact about
 * what the database contains. From 6 onwards it is not: this machine carries
 * eight worktrees of this repository, and two of them independently claimed 6,
 * 7, 8 and 9 for migrations that have nothing to do with the ones here. They
 * all share one `~/.hermetic/hermetic.db`, so the first branch to write a `6`
 * made every other branch's `6` look applied forever — which is how the
 * notification inbox came to be silently missing on a laptop whose ledger
 * claimed to have it.
 *
 * The window is also what keeps the *non-idempotent* migrations safe. Migration
 * 5 moves rows (`INSERT INTO fleets SELECT … FROM fleets_by_name`) and then
 * drops the table it read them from, and migration 4 drops `config` and adds
 * columns that would already exist; re-running either against a migrated
 * database throws. Both sit inside 1–5, where a numbered row is trusted, so
 * neither can ever be re-run. Nothing above 5 is trusted by number, so nothing
 * above 5 may be written in that style: a migration added from here on must be
 * safe to run twice, because a contested number is exactly what this scheme
 * re-runs on purpose.
 */
const LEGACY_LAST_VERSION = 5;

/**
 * **The name is the identity.** A migration is recorded, and skipped, by its
 * `name` — never by its number. When you add one:
 *
 * - Give it a short, unique slug saying what it does. Once it has shipped the
 *   name must never be reused for anything else and never edited, because the
 *   name in a ledger on somebody's laptop is the only record that this exact
 *   migration ran there.
 * - `version` is an ordering hint and nothing more. Two branches may both pick
 *   the next free number and both be right; that costs nothing now.
 * - Write every statement so running it twice is harmless — `CREATE TABLE IF
 *   NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. A branch's migration *will* be
 *   re-run on a database where a sibling branch already claimed its number, and
 *   it must also leave that sibling's tables completely alone.
 * - Do not set `legacy`. It marks the five migrations that predate this scheme.
 */
const MIGRATIONS: Migration[] = [
  {
    name: "initial-config-prefs-runs",
    version: 1,
    legacy: true,
    statements: [
      // A single row, frozen by init. `id = 1` is the whole of the constraint.
      `CREATE TABLE IF NOT EXISTS config (
         id             INTEGER PRIMARY KEY CHECK (id = 1),
         schema_version INTEGER NOT NULL,
         fleet_id       TEXT    NOT NULL,
         account_id     TEXT    NOT NULL,
         account_alias  TEXT,
         org_id         TEXT,
         profile        TEXT    NOT NULL,
         region         TEXT    NOT NULL,
         frozen_at      TEXT    NOT NULL,
         frozen_by      TEXT    NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS prefs (
         key   TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS runs (
         id          TEXT PRIMARY KEY,
         command     TEXT    NOT NULL,
         args        TEXT    NOT NULL,
         agent       TEXT,
         started_at  TEXT    NOT NULL,
         finished_at TEXT,
         exit_code   INTEGER,
         log         TEXT    NOT NULL DEFAULT ''
       )`,
      `CREATE INDEX IF NOT EXISTS runs_started_at ON runs (started_at DESC)`,
      `CREATE INDEX IF NOT EXISTS runs_agent ON runs (agent)`,
      // `init --reset` archives rather than deletes (§4.7).
      `CREATE TABLE IF NOT EXISTS runs_archive (
         id          TEXT PRIMARY KEY,
         command     TEXT    NOT NULL,
         args        TEXT    NOT NULL,
         agent       TEXT,
         started_at  TEXT    NOT NULL,
         finished_at TEXT,
         exit_code   INTEGER,
         log         TEXT    NOT NULL DEFAULT '',
         archived_at TEXT    NOT NULL
       )`,
    ],
  },
  {
    /**
     * §4.6: the permanent record of every teardown. Deliberately outside both
     * `clear()` and `archiveRuns()` — `--reset-local` returns the home to
     * uninitialized, and that is precisely the moment the operator most needs to
     * be able to read what was removed and what is still in the account.
     *
     * `receipt` is the whole `TeardownReceipt` as JSON, event log included; the
     * columns beside it exist to list and find one without parsing every row.
     */
    name: "teardown-receipts",
    version: 2,
    legacy: true,
    statements: [
      `CREATE TABLE IF NOT EXISTS teardowns (
         id          TEXT PRIMARY KEY,
         at          TEXT    NOT NULL,
         fleet_id    TEXT    NOT NULL,
         account_id  TEXT    NOT NULL,
         region      TEXT    NOT NULL,
         stack_name  TEXT    NOT NULL,
         outcome     TEXT    NOT NULL,
         receipt     TEXT    NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS teardowns_at ON teardowns (at DESC)`,
    ],
  },
  {
    /**
     * §4.6: the ops this laptop had in flight when it last stopped. A row is
     * written when a resumable op starts and deleted the moment it settles, so
     * anything still here at boot is an op whose process died — a closed laptop
     * mid-`agent create`, a `--hot` reload, a crash. `input` is the op's own
     * validated request, re-validated on the way back out (`REQUEST_SCHEMAS`),
     * and only methods that carry no secret are ever recorded (`init` is not
     * one of them).
     *
     * Nothing here mirrors DynamoDB (§4.5): the row says *that* an op was
     * running, never what it had done. Where it got to is read back out of AWS
     * by the resumed op itself.
     */
    name: "pending-ops",
    version: 3,
    legacy: true,
    statements: [
      `CREATE TABLE IF NOT EXISTS pending_ops (
         id         TEXT PRIMARY KEY,
         method     TEXT    NOT NULL,
         target     TEXT,
         input      TEXT    NOT NULL,
         started_at TEXT    NOT NULL,
         attempts   INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE INDEX IF NOT EXISTS pending_ops_started_at ON pending_ops (started_at)`,
    ],
  },
  {
    /**
     * §4.8: a home may be frozen to more than one fleet, so the single `config`
     * row becomes a `fleets` table keyed by the fleet's *name* — the same name
     * it carries in the account-global directory.
     *
     * The legacy row is named **`main`**. `config` has a single-row primary key
     * (`id = 1`), so there is exactly one fleet to name and no collision to
     * invent: this home's only fleet becomes the account's `main`, which is what
     * `init --create` would have called it and what every later command prints.
     * Naming it after its own `fleet_id` — eight characters an operator has
     * never seen and cannot guess — made the header line, the fleet switcher
     * and every `--fleet` argument read like machine output on a home that only
     * ever had one fleet.
     *
     * The directory stays the register of record for the label; v5 below
     * re-keys this table on `fleet_id`, which is what the label is a label
     * *of*.
     *
     * `default_fleet` is seeded from that row so a laptop that had exactly one
     * fleet before this migration keeps running every command against it with
     * nothing typed.
     */
    name: "fleets-by-name",
    version: 4,
    legacy: true,
    statements: [
      `CREATE TABLE IF NOT EXISTS fleets (
         name           TEXT PRIMARY KEY,
         schema_version INTEGER NOT NULL,
         fleet_id       TEXT    NOT NULL UNIQUE,
         account_id     TEXT    NOT NULL,
         account_alias  TEXT,
         org_id         TEXT,
         profile        TEXT    NOT NULL,
         region         TEXT    NOT NULL,
         frozen_at      TEXT    NOT NULL,
         frozen_by      TEXT    NOT NULL
       )`,
      `INSERT OR IGNORE INTO fleets
         (name, schema_version, fleet_id, account_id, account_alias, org_id, profile, region, frozen_at, frozen_by)
       SELECT 'main', schema_version, fleet_id, account_id, account_alias, org_id, profile, region, frozen_at, frozen_by
         FROM config WHERE id = 1`,
      `INSERT OR IGNORE INTO prefs (key, value)
         SELECT '${PREF_DEFAULT_FLEET}', 'main' FROM config WHERE id = 1`,
      `DROP TABLE config`,
      // Which fleet an op was against, so a portal booted on one fleet does not
      // replay another's pending work (§4.6). Nullable: rows written before this
      // belong to whatever the default resolves to.
      `ALTER TABLE pending_ops ADD COLUMN fleet TEXT`,
      `ALTER TABLE runs ADD COLUMN fleet TEXT`,
      `ALTER TABLE runs_archive ADD COLUMN fleet TEXT`,
    ],
  },
  {
    /**
     * §4.6: identity moves off the fleet's name and onto its `fleet_id`.
     *
     * Two halves, and the order matters. First every *reference* to a fleet is
     * rewritten from the label to the id — `prefs.default_fleet`, and the
     * `fleet` column on `runs`, `runs_archive` and `pending_ops` — while the
     * `fleets` table still holds the mapping that makes the rewrite possible.
     * Only then is the table itself re-keyed. Doing it the other way round
     * would throw away the lookup the first half needs.
     *
     * `COALESCE(..., value)` leaves anything that resolves to no fleet exactly
     * as it was: a run recorded against a fleet this home has since forgotten
     * is history, not a row to blank.
     *
     * The new table's `name` carries **no** `UNIQUE` constraint, deliberately.
     * It is a cache of a label the account's directory owns, and two rows may
     * hold the same one for as long as it takes this laptop to notice that
     * another has moved it — SQLite arbitrating that would turn a stale cache
     * into a failed write. An index, so a lookup by label is still cheap; not a
     * constraint, because the constraint lives in DynamoDB (§4.8).
     */
    name: "fleets-by-id",
    version: 5,
    legacy: true,
    statements: [
      `UPDATE prefs SET value = COALESCE((SELECT fleet_id FROM fleets WHERE name = prefs.value), value) WHERE key = '${PREF_DEFAULT_FLEET}'`,
      ...["runs", "runs_archive", "pending_ops"].map(
        (table) =>
          `UPDATE ${table} SET fleet = COALESCE((SELECT fleet_id FROM fleets WHERE name = ${table}.fleet), fleet) WHERE fleet IS NOT NULL`,
      ),
      `ALTER TABLE fleets RENAME TO fleets_by_name`,
      `CREATE TABLE fleets (
         fleet_id TEXT PRIMARY KEY,
         name TEXT,
         schema_version INTEGER NOT NULL,
         account_id TEXT NOT NULL,
         account_alias TEXT,
         org_id TEXT,
         profile TEXT NOT NULL,
         region TEXT NOT NULL,
         frozen_at TEXT NOT NULL,
         frozen_by TEXT NOT NULL
       )`,
      `INSERT INTO fleets SELECT fleet_id, name, schema_version, account_id, account_alias, org_id, profile, region, frozen_at, frozen_by FROM fleets_by_name`,
      `DROP TABLE fleets_by_name`,
      `CREATE INDEX IF NOT EXISTS fleets_name ON fleets (name)`,
    ],
  },
  {
    /**
     * §4.9: the operator's inbox. Local, like `runs` beside it — a
     * notification is about *who is watching*, not about the fleet, so two
     * laptops on one fleet keep their own and a mute on one silences neither
     * the other nor anything in DynamoDB (§4.5).
     *
     * `notifications_active_key` is what makes an advisory a *condition*
     * rather than an event: a row may carry a `key`, and a second row with the
     * same key cannot exist while the first is unresolved. A scan that keeps
     * seeing the same problem keeps finding the row it already raised, and a
     * recurrence after `resolved_at` is a new row.
     *
     * `agent_status_seen` is the fleet scan's memory. Core's scan is stateless,
     * so without a durable "last status seen" a health transition could only be
     * detected by a process that had been running since the previous one — the
     * CLI would never see any, and a portal restart would lose every one it had.
     */
    name: "notifications-inbox",
    version: 6,
    statements: [
      `CREATE TABLE IF NOT EXISTS notifications (
         id          TEXT PRIMARY KEY,
         at          TEXT NOT NULL,
         source      TEXT NOT NULL,
         kind        TEXT NOT NULL,
         class       TEXT NOT NULL,
         title       TEXT NOT NULL,
         detail      TEXT,
         agent       TEXT,
         fleet       TEXT,
         ref         TEXT,
         key         TEXT,
         actions     TEXT NOT NULL DEFAULT '[]',
         read_at     TEXT,
         resolved_at TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS notifications_at ON notifications (at DESC)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS notifications_active_key
         ON notifications (key) WHERE key IS NOT NULL AND resolved_at IS NULL`,
      `CREATE TABLE IF NOT EXISTS notification_mutes (
         target TEXT PRIMARY KEY,
         at     TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS agent_status_seen (
         fleet   TEXT NOT NULL,
         agent   TEXT NOT NULL,
         status  TEXT NOT NULL,
         seen_at TEXT NOT NULL,
         PRIMARY KEY (fleet, agent)
       )`,
    ],
  },
  {
    /**     * §4.6: a run says *what* it was against, not just which id.
     *
     * The `fleet` column alone could only be filled in by a head that knew the
     * fleet before core had resolved one, so an alias-selected, `HERMETIC_FLEET`
     * or default-selected command recorded nothing at all and the reader was
     * left to assume it meant whatever fleet is open now. These three columns
     * are written *after* resolution, and they carry the whole immutable
     * target — account, region, id — plus the display alias the operator saw at
     * the time.
     *
     * Nullable, and the old rows stay as they are: a run recorded before this
     * migration genuinely does not know its account, and inventing one from
     * today's config would be the same guess in a different place.
     */
    name: "runs-fleet-target",
    version: 7,
    statements: [],
    columns: ["runs", "runs_archive"].flatMap((table) => [
      { table, column: "account_id", type: "TEXT" },
      { table, column: "region", type: "TEXT" },
      { table, column: "fleet_name", type: "TEXT" },
    ]),
  },
  {
    /**
     * §4.7: a pending op records the *whole* of the fleet it was against, and
     * what it was about to act on.
     *
     * `fleet` alone (v4) is not identity. It is one of three facts — account,
     * region, `fleet_id` — and a row carrying only the third cannot say which
     * account it belonged to, so a boot could not tell a row of this fleet from
     * a row of a fleet in another account that happens to share the id's eight
     * characters. `account_id` and `region` close that; rows written before
     * this migration carry NULL and are never replayed (see
     * `listUnattributed`), because a row that cannot name its fleet is a row
     * nobody can safely re-run.
     *
     * `target_identity` is the other half: the agent name a destroy names is a
     * *reusable* label, so a name that was freed and re-created between the
     * confirmation and the replay would hand the resumed destroy somebody
     * else's agent. The row records the instance id and the creation stamp the
     * agent had when the op was claimed, and `resume.ts` refuses to act on a
     * row whose agent no longer matches.
     */
    name: "pending-ops-fleet-identity",
    version: 8,
    statements: [],
    columns: [
      { table: "pending_ops", column: "account_id", type: "TEXT" },
      { table: "pending_ops", column: "region", type: "TEXT" },
      { table: "pending_ops", column: "target_identity", type: "TEXT" },
    ],
  },
  {
    /**
     * §4.6: a pending op records how far it had got, and when it may be tried
     * again.
     *
     * `phase` is the last phase its event stream reported. The row still says
     * nothing about what AWS holds — that is read back by the resumed op
     * itself (§4.5) — but a boot that has to explain an interrupted operation
     * to an operator can now say where it stopped instead of only that it
     * started.
     *
     * `retry_after` is the other half. An op refused because somebody else's
     * lease was still live (`LOCKED`, or the `NAME_TAKEN` a live create lock
     * produces) has not failed: it has been told to wait. Clearing the row on
     * that refusal threw the work away for good, because expiry on its own
     * triggers nothing. The refusal now stamps the moment the lease it met runs
     * out, and the row is left alone until then — waiting for ownership to
     * lapse rather than taking it away from whoever holds it.
     */
    name: "pending-ops-phase-retry",
    version: 9,
    statements: [],
    columns: [
      { table: "pending_ops", column: "phase", type: "TEXT" },
      { table: "pending_ops", column: "retry_after", type: "TEXT" },
    ],
  },
  {
    /**
     * Which conversations *this laptop* started (§9.2).
     *
     * The box cannot answer this. A session opened by hermetic over `/api/ws`
     * and one opened by the box's own TUI arrive at the adapter identically, and
     * upstream's `source` field names a client kind rather than an installation
     * — so nothing the box says can be read as "this portal opened it", and the
     * adapter deliberately maps no upstream value onto the `portal` origin.
     * `portal` is the one value that silences the composer's destination
     * warning, and it must never be inferred from a string a box chose.
     *
     * It is local for the same reason the inbox is, and the consequence is a
     * feature rather than a limitation: a session this operator started is
     * `portal` on their laptop and foreign on their colleague's, which is
     * exactly right, because the colleague's reply really is going into a
     * conversation they did not open. This table must never move to DynamoDB.
     */
    name: "chat-local-sessions",
    version: 10,
    statements: [
      `CREATE TABLE IF NOT EXISTS chat_local_sessions (
         fleet    TEXT NOT NULL,
         instance TEXT NOT NULL,
         bot      TEXT NOT NULL,
         session  TEXT NOT NULL,
         at       TEXT NOT NULL,
         PRIMARY KEY (fleet, session)
       )`,
      `CREATE INDEX IF NOT EXISTS chat_local_sessions_at ON chat_local_sessions (at)`,
    ],
  },
  {
    name: "instance-listening",
    version: 11,
    statements: [
      `CREATE TABLE IF NOT EXISTS instance_listening (
         fleet TEXT NOT NULL,
         instance TEXT NOT NULL,
         PRIMARY KEY (fleet, instance)
       )`,
    ],
  },
  {
    /**
     * The in-flight turn fence (`chat-fence.ts`).
     *
     * Local for the reason the inbox and `chat_local_sessions` are local, and
     * for one more: it exists *because* two local processes share this file. A
     * turn taken from `hermetic chat` has to be visible to the portal's roster
     * poll, or the poll raises a row about the reply the operator is watching
     * the CLI print. A closure in either process fences only the one that is
     * not reading.
     *
     * One row per bot, overwritten by whoever claims it last, and lapsing on
     * its own: a holder that was killed is late by at most one TTL, never
     * forever.
     */
    name: "chat-turn-fence",
    version: 12,
    statements: [
      `CREATE TABLE IF NOT EXISTS chat_turn_fence (
         fleet      TEXT NOT NULL,
         instance   TEXT NOT NULL,
         bot        TEXT NOT NULL,
         owner      TEXT NOT NULL,
         expires_at TEXT NOT NULL,
         PRIMARY KEY (fleet, instance, bot)
       )`,
    ],
  },
  {
    /**
     * Which incarnation of each agent name the rows above describe
     * (`local/incarnations.ts`, §6.7). A destroy releases the name and only the
     * laptop that ran it purges its own local state; every other laptop finds
     * out by seeing a different `created_at` on the live row, and this is where
     * it remembers the one it saw last. Created empty on purpose: an existing
     * home's state is adopted on its first read, never purged by the upgrade.
     */
    name: "agent-incarnations",
    version: 13,
    statements: [
      `CREATE TABLE IF NOT EXISTS agent_incarnations (
         fleet      TEXT NOT NULL,
         name       TEXT NOT NULL,
         created_at TEXT NOT NULL,
         PRIMARY KEY (fleet, name)
       )`,
    ],
  },
];

/**
 * Which migration a ledger row carrying only a *number* proves was applied.
 *
 * Two independent gates, and both must open. The migration has to have been
 * marked `legacy` — declared, by hand, as one of the five that shipped on
 * `origin/master` — and the number has to fall inside `LEGACY_LAST_VERSION`, so
 * that marking a later migration `legacy` by mistake still cannot widen the
 * window. Anything else returns `undefined`: an unnamed row above 5 is a number
 * some other branch wrote, and it says nothing about what this one needs.
 */
function legacyNameFor(version: number): string | undefined {
  if (version > LEGACY_LAST_VERSION) return undefined;
  return MIGRATIONS.find((m) => m.legacy === true && m.version === version)?.name;
}

/**
 * Bring the ledger itself up to the shape the name-keyed scheme needs: a
 * nullable `name`, and no primary key on `version`.
 *
 * Dropping the primary key is not cosmetic. This laptop's ledger already holds
 * an unnamed `6` written by a sibling branch, and this branch's migration `6`
 * has to be recordable beside it — two rows, same number, different names. The
 * column stays `NOT NULL` so a row always says where in the order it belongs,
 * and `name` carries the `UNIQUE` constraint instead, because the name is now
 * what identity means.
 *
 * Older builds in sibling worktrees keep working against the rebuilt table:
 * their `CREATE TABLE IF NOT EXISTS` finds it, their `SELECT version` reads it,
 * and their nameless `INSERT` still fits.
 */
function ensureLedger(db: Database): void {
  db.run(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER NOT NULL,
       name       TEXT UNIQUE,
       applied_at TEXT    NOT NULL
     )`,
  );
  const columns = db.query(`PRAGMA table_info(schema_migrations)`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === "name")) return;
  // A ledger written before names existed: rebuild it, carrying every row
  // across untouched. Each keeps its number and gets no name, which is exactly
  // what it is — a number, and no evidence of anything else.
  const rebuild = db.transaction(() => {
    db.run(
      `CREATE TABLE schema_migrations_named (
         version    INTEGER NOT NULL,
         name       TEXT UNIQUE,
         applied_at TEXT    NOT NULL
       )`,
    );
    db.run(
      `INSERT INTO schema_migrations_named (version, name, applied_at)
         SELECT version, NULL, applied_at FROM schema_migrations`,
    );
    db.run(`DROP TABLE schema_migrations`);
    db.run(`ALTER TABLE schema_migrations_named RENAME TO schema_migrations`);
  });
  rebuild();
}

/**
 * Idempotent: re-running every migration on an up-to-date file is a no-op.
 *
 * A migration is skipped when its **name** is in the ledger — or, for the five
 * legacy ones, when its number is (see `legacyNameFor`). A branch whose number
 * another branch already claimed therefore runs anyway, which is the whole
 * point and the reason every non-legacy migration must be safe to run twice.
 */
export function migrate(db: Database): number {
  ensureLedger(db);
  const rows = db.query(`SELECT version, name FROM schema_migrations`).all() as Array<{
    version: number;
    name: string | null;
  }>;
  const applied = new Set<string>();
  for (const row of rows) {
    if (row.name !== null) {
      applied.add(row.name);
      continue;
    }
    const legacy = legacyNameFor(row.version);
    if (legacy !== undefined) applied.add(legacy);
  }
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    const run = db.transaction(() => {
      for (const statement of migration.statements) db.run(statement);
      for (const { table, column, type } of migration.columns ?? []) {
        const existing = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (existing.some((c) => c.name === column)) continue;
        db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
      db.run(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`, [
        migration.version,
        migration.name,
        new Date().toISOString(),
      ]);
    });
    run();
  }
  return SCHEMA_VERSION;
}
