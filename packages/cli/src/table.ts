/**
 * `agent ps` (§9): plain aligned text, no colour dependency, so it is readable
 * in a pipe and in a terminal without a TTY-detection branch.
 */
import type {
  AgentEvent,
  AgentView,
  DesktopAttach,
  ProbeLayer,
  ProbeReport,
  ProvidersListResult,
  ProvidersModelsOutput,
  ProvidersWriteResult,
  SecretsListResult,
  SharedSecretView,
  SettingsResult,
  TeardownReceipt,
  VolumeDetailResult,
  VolumeListResult,
  VolumeView,
} from "@hermetic/core";
import {
  DEFAULT_ROOT_GIB,
  PROVIDERS,
  agentDashboardUrl,
  agentDesktopUrl,
  groupByDisposition,
  splitHermesSettings,
} from "@hermetic/core";

export function formatAge(ms: number | null): string {
  if (ms === null) return "-";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * The four heartbeat checks as `h+ t+ d+ D-`: lowercase `d` is **disk**,
 * uppercase `D` is the **dashboard** — the box's own GET of its Serve URL,
 * which is the only check that proves the tailnet cert, `tailscale serve` and
 * Hermes together (§6.4).
 *
 * `d` covers *both* filesystems, since either one filling up stops the agent —
 * so it says that something is full, not which thing. The `DISK` column is
 * where the two are told apart.
 *
 * `?` means "not reported": before the first heartbeat for all four, and for
 * `D` alone on a row an older hermeticd wrote, which had no dashboard check to
 * report. Rendering an absent check as `-` would accuse a healthy agent of
 * failing something its build never ran; rendering it as `+` would hide a real
 * failure behind a version skew. `?` is the only honest third state, and it is
 * why `dashboard` is optional in `Health` rather than defaulted.
 */
export function formatHealth(health: AgentView["health"]): string {
  if (!health) return "h? t? d? D?";
  const mark = (ok: boolean | undefined) => (ok === undefined ? "?" : ok ? "+" : "-");
  return [
    `h${mark(health.hermes)}`,
    `t${mark(health.tailscale)}`,
    `d${mark(health.disk)}`,
    `D${mark(health.dashboard)}`,
  ].join(" ");
}

/**
 * The two filesystems the heartbeat measures, as `data/root`: `62%/27%`.
 *
 * `-` on either side is "not measured", and the right-hand one is `-` on every
 * row an older hermeticd wrote, which reported no `root_disk_pct` at all (§6.4).
 * Printing that as `0%` would report the emptiest possible root disk for a box
 * that never looked — the opposite of the failure this column exists to show.
 */
export function formatDisk(metrics: AgentView["metrics"]): string {
  const one = (v: number | null | undefined): string =>
    v === null || v === undefined ? "-" : `${Math.round(v)}%`;
  return `${one(metrics?.disk_pct)}/${one(metrics?.root_disk_pct)}`;
}

export function formatLock(lock: AgentView["lock"]): string {
  if (!lock) return "-";
  const owner = lock.owner.split("/").pop() ?? lock.owner;
  return owner.split("#")[0] ?? owner;
}

export function renderTable(rows: readonly string[][], headers: readonly string[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const pad = (cells: readonly string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0, " ")))
      .join("  ")
      .trimEnd();
  return [pad(headers), ...rows.map(pad)].join("\n");
}

const PS_HEADERS = [
  "NAME",
  "STATUS",
  "HEALTH",
  "HEARTBEAT",
  "HERMES",
  "HERMETICD",
  "SIZE",
  "DISK D/R",
  "TAILSCALE IP",
  "PROFILE",
  "LOCK",
] as const;

/**
 * What this agent's provider binding has to say, in one column (§8.3).
 *
 * Three answers and they do not overlap: something is staged and waiting for an
 * apply, the profile it is pinned to has moved since it was pinned, or neither.
 * `pending` wins, because it is the one an operator can act on with a command
 * rather than a decision.
 */
function formatProfile(a: AgentView): string {
  if (a.pending !== null && a.pending !== undefined) return "pending apply";
  if (a.update_available === true) return "update available";
  return "-";
}

export function renderPs(agents: readonly AgentView[]): string {
  if (agents.length === 0) return "no agents";
  const rows = agents.map((a) => [
    a.name,
    a.display_status,
    formatHealth(a.health),
    formatAge(a.heartbeat_age_ms),
    a.hermes_version,
    a.hermeticd_version ?? "-",
    a.size,
    formatDisk(a.metrics),
    a.tailscale_ip ?? "-",
    formatProfile(a),
    formatLock(a.lock),
  ]);
  return renderTable(rows, PS_HEADERS);
}

/**
 * The MagicDNS name the node actually holds, and — when it is not the one the
 * agent was named after — the reason, on the same line.
 *
 * The canonical spelling is reconstructed from the real name's own suffix
 * rather than from the fleet item. `agents.get` returns a row, not a tailnet,
 * and a `GetItem` on `_fleet` bought purely to print one line would make
 * `agent status` slower for every agent to say something about a rare one. The
 * suffix is right there in `tailscale_dns_name`, and it is by construction the
 * tailnet this node joined.
 */
function tailnetName(a: AgentView, fleetId?: string, fleetName?: string): string {
  // The node joins the tailnet as `<fleet id>-<agent>` since foundation v4
  // (core's `cloudName`), so that — not the bare agent name — is the canonical
  // spelling a stale device would be holding.
  const canonicalHost = fleetId ? `${fleetId}-${a.name}` : a.name;
  /**
   * The spellings hermetic itself used to hand out (core's `legacyCloudNames`):
   * a box built under v3 is `<fleet name>-<agent>` and one before it is the
   * bare agent name. Neither is a stale device — each is this agent's own node,
   * keeping the hostname it booted with — and calling them one would send an
   * operator to delete a live machine.
   */
  const legacy = fleetName ? [`${fleetName}-${a.name}`, a.name] : [a.name];
  // Tailscale's API reports `DNSName` fully qualified — `atlas.tail0.ts.net.`,
  // with the root dot. Splitting that leaves a trailing empty label, so the
  // canonical name reconstructed below would come out `atlas.tail0.ts.net.`
  // and never equal the row's own name. The dot says nothing a reader needs.
  const real = a.tailscale_dns_name?.replace(/\.$/, "") ?? null;
  if (!real) return "-";
  const [host, ...rest] = real.split(".");
  const tailnet = rest.join(".");
  if (host === canonicalHost || tailnet === "") return real;
  if (host !== undefined && legacy.includes(host)) {
    // A name hermetic hands out, not necessarily an old box: the spelling is
    // asked for by the release in the fleet bucket (core's `staleDeviceNote`).
    return `${real} (a name hermetic used to hand out; recreate to adopt ${canonicalHost}.${tailnet})`;
  }
  return `${real} (canonical ${canonicalHost}.${tailnet} is held by a stale device)`;
}

/**
 * The Hermes settings, each with who owns it.
 *
 * The value is always knowable — an unstated setting is not unset, it is the
 * fleet default (or the provider's default model) that hermetic seeded — so all
 * of them are printed, and what varies is the owner. `managed` means hermetic
 * holds it: it is in `/etc/hermes/config.yaml`, rewritten on every apply, and
 * `agent set` is what moves it. `seeded` means it was written into the agent's
 * own config once and belongs to whoever is driving the agent since; the row
 * records what was asked for at create time, not what the box currently reads,
 * which is why the line says so rather than presenting it as current fact.
 *
 * `a.seed` is passed, and leaving it out was a bug: it is the fleet's own
 * answers frozen onto the row when the agent was created (`schema/agent.ts`),
 * and it outranks `HERMES_DEFAULTS` for every field the operator did not state.
 * Without it an agent created against `settings set --approvals smart` printed
 * `approvals off` — this build's default rather than the value its box was
 * actually seeded with — and the same for `max turns`, `reasoning` and
 * `terminal`. That is the opposite of the reassurance the row exists to give:
 * this is the line an operator reads before believing an agent will not stop
 * and wait for somebody.
 *
 * `packages/ui/src/components/agent/AgentOverview.tsx` shows the approvals half
 * of this split, resolved the same way from the same two row fields.
 */
function hermesRows(a: AgentView): Array<[string, string]> {
  const { managed, seed } = splitHermesSettings(a.hermes, PROVIDERS[a.provider].default_model, a.seed);
  const labels: Array<[string, keyof typeof managed]> = [
    ["model", "model"],
    ["terminal", "terminal_backend"],
    ["max turns", "max_turns"],
    ["reasoning", "reasoning_effort"],
  ];
  const rows: Array<[string, string]> = labels.map(([label, key]) => {
    const held = managed[key];
    const value = held ?? seed[key];
    return [
      label,
      held === undefined
        ? `${String(value)} (seeded — the agent's to change)`
        : `${String(value)} (managed)`,
    ];
  });
  /*
   * Appended rather than folded into the loop above, because its owner is not
   * a question: `approvals_mode` is seed-only (`SEED_ONLY` in
   * `schema/hermes.ts`), so `managed` can never carry it and a row that asked
   * would be printing a branch that cannot happen. Stating it moves the seed —
   * hermetic re-asserts the mode when the operator changes the answer — and
   * between those changes it is the agent's, which is what the line says.
   */
  rows.push([
    "approvals",
    `${String(seed.approvals_mode)} (seeded — the agent's to change; re-asserted when \`agent set --approvals\` moves it)`,
  ]);
  return rows;
}

/**
 * The two URLs an operator actually wants to click, and the reason they are
 * built here from the row rather than from `<name>.<tailnet>`.
 *
 * Both are addressed at the name the node *reports* holding, not the canonical
 * spelling: after a recreate whose predecessor still sits in the tailnet, the
 * canonical name resolves to the dead box, and Serve answers only on the real
 * one (core's `agentHostname`). So nothing is printed at all for a row that has
 * not reported one yet — a URL that cannot be right is worse than no URL.
 *
 * `desktop` appears for every agent, because every agent runs a browser — one
 * row per identity in `browsers`, which is a list so that a second identity is a
 * data change rather than a second field.
 */
function urlRows(a: AgentView): Array<[string, string]> {
  // Tailscale reports `DNSName` fully qualified, with the root dot; a URL built
  // from `atlas.tail0.ts.net.` works but reads as a typo.
  const real = a.tailscale_dns_name?.replace(/\.$/, "") ?? null;
  if (!real) return [];
  const tailnet = real.split(".").slice(1).join(".");
  if (tailnet === "") return [];
  const node = { name: a.name, tailscale_dns_name: real };
  const rows: Array<[string, string]> = [["dashboard", agentDashboardUrl(node, tailnet)]];
  for (const b of a.browsers) rows.push(["desktop", agentDesktopUrl(node, tailnet, null, b.name)]);
  return rows;
}

/** One side of the disk line: a percentage, or why there is no percentage. */
function diskCell(v: number | null | undefined): string {
  return v === null || v === undefined ? "not reported" : `${Math.round(v)}%`;
}

export function renderStatus(a: AgentView, fleetId?: string, fleetName?: string): string {
  const pairs: Array<[string, string]> = [
    ["name", a.name],
    ["status", a.display_status],
    ["stored status", a.status],
    ["health", formatHealth(a.health)],
    ["heartbeat", formatAge(a.heartbeat_age_ms)],
    ["size", `${a.size} (${a.instance_type})`],
    ["region", a.region],
    ["instance", a.instance_id ?? "-"],
    ["volume", `${a.volume_id ?? "-"} (${a.volume_gib} GiB)`],
    [
      "disk",
      // Two filesystems, named the way the portal names them (§6.4): the data
      // disk an operator sized, and the system disk that goes with the
      // instance. A row from before `root_gib` existed knows only the reading,
      // not the size, so the size half is simply absent rather than guessed.
      `data ${diskCell(a.metrics?.disk_pct)} of ${a.volume_gib} GiB · system ${diskCell(a.metrics?.root_disk_pct)}${a.root_gib ? ` of ${a.root_gib} GiB` : ""}`,
    ],
    ["hermes", a.hermes_version],
    ["hermeticd", a.hermeticd_version ?? "-"],
    [
      "provider",
      a.profile_id === undefined
        ? a.provider
        : `${a.provider} · profile ${a.profile_id} r${String(a.profile_revision ?? 1)}${a.update_available === true ? " (update available)" : ""}`,
    ],
    ...(a.pending === null || a.pending === undefined
      ? []
      : ([
          [
            "pending apply",
            `${a.pending.provider} · profile ${a.pending.profile_id} r${String(a.pending.profile_revision)} · model ${a.pending.model} (staged ${a.pending.staged_at} by ${a.pending.staged_by})`,
          ],
        ] as Array<[string, string]>)),
    ["secrets", a.secrets_mode],
    ...hermesRows(a),
    ["tailnet name", tailnetName(a, fleetId, fleetName)],
    ...urlRows(a),
    ["tailscale ip", a.tailscale_ip ?? "-"],
    // The daemon's own version, reported on the heartbeat. `-` is *unknown* —
    // a box that has never heartbeated, or a row written before the field —
    // never "an old one": Tailscale's updater moves this on the box's schedule
    // and this line is the only record of where it got to.
    ["tailscale version", a.tailscale_version ?? "-"],
    ["config hash", a.config_hash ?? "-"],
    ["lock", formatLock(a.lock)],
    ["created", `${a.created_at} by ${a.created_by}`],
    ["updated", a.updated_at],
  ];
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${k.padEnd(width, " ")}  ${v}`).join("\n");
}

/**
 * `agent probe` (§9): one line per layer, then the verdict and what to do.
 *
 * The layers are printed even when they pass, and in a fixed order, because the
 * *shape* of the failure is the diagnosis — "EC2 ok, hermeticd silent" and
 * "EC2 stopped, hermeticd skipped" are read at a glance from which marks are
 * which, and a renderer that only showed the failures would take that away.
 */
export function renderProbe(report: ProbeReport): string {
  const mark = (l: ProbeLayer): string =>
    l.outcome === "ok" ? "\u2713" : l.outcome === "fail" ? "\u2717" : "\u2013";
  const latency = (l: ProbeLayer): string => (l.latency_ms === null ? "" : ` (${l.latency_ms}ms)`);

  const layers: Array<[string, ProbeLayer]> = [
    ["instance", report.instance],
    ["hermeticd", report.hermeticd],
    ["dashboard", report.dashboard],
    // The two browser layers last and in this order, because that is how they
    // fail: no desktop is a Serve/noVNC problem, a desktop that serves over a
    // browser that is down is a systemd/Chrome one.
    ["desktop", report.desktop],
    ["browser", report.browser],
  ];
  const width = Math.max(...layers.map(([name]) => name.length));

  const lines = [
    `${report.name}  ${report.row.display_status}  (probed ${report.at})`,
    "",
    ...layers.map(([name, l]) => `${mark(l)}  ${name.padEnd(width, " ")}  ${l.detail}${latency(l)}`),
    "",
    `${report.verdict.level.toUpperCase()}: ${report.verdict.summary}`,
    ...report.verdict.hints.map((h) => `  \u2192 ${h}`),
  ];
  return lines.join("\n");
}

/**
 * §7.4's two fields, as `hermetic agent desktop` prints them.
 *
 * The rotation note is not decoration. The token belongs to the box's running
 * `hermes dashboard` process, so the next reboot, `agent recreate`, `hermeticd
 * apply` or Hermes update invalidates whatever was pasted into Desktop — and
 * Desktop's own report of that state ("Remote host rejected the saved token")
 * says nothing about which side changed.
 */
export function renderDesktop(attach: DesktopAttach): string {
  const label = (text: string): string => text.padEnd("remote address".length, " ");
  return [
    attach.instance,
    "",
    `${label("remote address")}  ${attach.url}`,
    `${label("session token")}  ${attach.token}`,
    "",
    'In Hermes Desktop: Settings → Gateways (or a profile’s "Connect to a remote',
    'host…"). Paste the address into "Remote address" and the token into "Session',
    'token". The connection test passes without a token and the real connection does',
    "not, so both fields are required.",
    ...(attach.rotates
      ? [
          "",
          "The token dies with the box’s dashboard process — a reboot, `agent recreate`,",
          "an apply or a Hermes update mints a new one. Run this again when Desktop says",
          "the host rejected the saved token.",
        ]
      : []),
  ].join("\n");
}

export function renderHistory(events: readonly AgentEvent[]): string {
  if (events.length === 0) return "no events";
  const rows = events.map((e) => [
    e.timestamp,
    e.action,
    `${e.from_status ?? "-"}→${e.to_status ?? "-"}`,
    e.actor,
    e.detail ?? "",
  ]);
  const table = renderTable(rows, ["TIMESTAMP", "ACTION", "TRANSITION", "ACTOR", "DETAIL"]);

  /**
   * A failed stage's evidence, under the table rather than in it: the `detail`
   * column is the headline and stays one line, and a tail is a dozen to a
   * hundred of them (§4.2). Nothing is printed for an event without one, so a
   * history of ordinary transitions renders exactly as it always has.
   */
  const blocks: string[] = [];
  for (const e of events) {
    const tail = e.log_tail?.split("\n") ?? [];
    if (tail.length === 0 || e.log_tail === "") continue;
    blocks.push(
      "",
      `--- ${e.timestamp} ${e.action} · log tail (${tail.length} line${tail.length === 1 ? "" : "s"}) ---`,
      ...tail.map((line) => `  ${line}`),
    );
  }
  return blocks.length === 0 ? table : `${table}\n${blocks.join("\n")}`;
}

/**
 * A teardown receipt (§4.6), as three lists: what this run removed, what it
 * left behind and why, and what no flag can reach. The same three groups the
 * portal shows in its modal — one record, two renderings.
 */
export function renderTeardownReceipt(receipt: TeardownReceipt, withEvents = false): string {
  const groups = groupByDisposition(receipt);
  const lines: string[] = [];
  const flags = Object.entries(receipt.options)
    .filter(([, on]) => on === true)
    .map(([name]) => `--${name.replace(/_/g, "-")}`);

  lines.push(
    `${receipt.outcome === "ok" ? "torn down" : "TEARDOWN FAILED"}  ${receipt.stack_name} · fleet ${receipt.fleet_id} · ${receipt.account_id} · ${receipt.region}`,
  );
  lines.push(`  at ${receipt.finished_at}${flags.length > 0 ? `  ${flags.join(" ")}` : ""}`);
  if (receipt.error) lines.push(`  ${receipt.error.code}: ${receipt.error.message}`);

  const section = (title: string, outcomes: typeof receipt.resources) => {
    if (outcomes.length === 0) return;
    lines.push("", `  ${title}`);
    for (const r of outcomes) {
      const count = r.count === null ? "" : ` (${r.count})`;
      lines.push(`    - ${r.what}${count}${r.detail ? `\n        ${r.detail}` : ""}`);
    }
  };
  section("removed", [...groups.removed]);
  section("nothing to remove", [...groups.skipped]);
  section("still there", [...groups.retained]);
  section("yours to do by hand", [...groups.manual]);
  section("failed", [...groups.failed]);

  /**
   * The Elastic IP block (§4.6), as ids rather than as prose. The sections
   * above already say *that* an allocation was kept or released; this is where
   * the operator copies the id from into the console or the AWS CLI.
   */
  if (receipt.addresses.kept.length > 0 || receipt.addresses.released.length > 0) {
    lines.push("", "  elastic addresses");
    for (const a of receipt.addresses.kept) {
      lines.push(
        `    - ${a.allocation_id}  ${a.public_ip}  ${a.associated ? "still associated" : "unassociated"}`,
      );
    }
    for (const id of receipt.addresses.released) lines.push(`    - ${id}  released`);
  }

  if (withEvents && receipt.events.length > 0) {
    lines.push("", "  log");
    for (const e of receipt.events) {
      lines.push(`    ${e.at}  ${e.phase.padEnd(13)} ${e.level === "warn" ? "! " : "  "}${e.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * How long a volume has been free, in the same shape `formatAge` gives a
 * heartbeat. A volume nothing has ever attached reads `-` rather than `0s`.
 */
function freeFor(v: VolumeView): string {
  return v.attached ? "-" : formatAge(v.free_for_ms);
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** What each group means, in the order `volume ls` prints them. */
const VOLUME_GROUPS = [
  ["no_agent", "NO AGENT", "memory nothing is reading"],
  ["ambiguous", "AMBIGUOUS", "two volumes share one agent tag; hermetic will not guess"],
  ["detached", "DETACHED", "free, but a live agent still owns it"],
  ["attached", "ATTACHED", "an instance is reading it"],
  ["unmanaged", "NOT THIS FLEET", "hermetic did not create these and will not touch them"],
] as const;

const VOLUME_HEADERS = [
  "VOLUME",
  "AGENT",
  "STATE",
  "SIZE",
  "AZ",
  "FREE FOR",
  "SNAPS",
  "COST/MO",
] as const;

/**
 * §9 `volume ls`, grouped the way the Volumes view is: what nothing is reading
 * first, because that is the question the command exists to answer.
 */
export function renderVolumes(result: VolumeListResult): string {
  if (result.volumes.length === 0) return "no volumes";
  const blocks: string[] = [];
  for (const [group, title, hint] of VOLUME_GROUPS) {
    const rows = result.volumes.filter((v) => v.group === group);
    if (rows.length === 0) continue;
    const table = renderTable(
      rows.map((v) => [
        v.volume_id,
        v.agent ?? "-",
        v.state,
        `${v.size_gib} GiB`,
        v.availability_zone ?? "-",
        freeFor(v),
        String(v.snapshots),
        usd(v.monthly_cost_usd),
      ]),
      VOLUME_HEADERS,
    );
    blocks.push(`${title} · ${rows.length} — ${hint}\n${table}`);
  }
  const s = result.summary;
  blocks.push(
    `${s.total} volumes · ${s.total_gib} GiB · ≈ ${usd(s.monthly_cost_usd)}/mo · ` +
      `${s.unattached_gib} GiB unattached ≈ ${usd(s.unattached_monthly_cost_usd)}/mo · ` +
      `${s.snapshots} snapshots`,
  );
  return blocks.join("\n\n");
}

/**
 * The one line `agent ps` adds when something is loose, and prints nothing at
 * all when nothing is (§9). It goes to stderr, so a pipe stays clean — the same
 * rule the header line follows.
 */
export function renderLooseVolumes(result: VolumeListResult): string | null {
  const loose = result.volumes.filter((v) => v.group === "no_agent");
  const ambiguous = result.volumes.filter((v) => v.group === "ambiguous");
  if (loose.length === 0 && ambiguous.length === 0) return null;
  const lines: string[] = [];
  if (loose.length > 0) {
    const gib = loose.reduce((n, v) => n + v.size_gib, 0);
    const cost = loose.reduce((n, v) => n + v.monthly_cost_usd, 0);
    lines.push(
      `${loose.length} data volume${loose.length === 1 ? " has" : "s have"} no agent · ${gib} GiB · ≈ ${usd(cost)}/mo`,
    );
    for (const v of loose) {
      lines.push(`  ${v.agent ?? "(untagged)"}  ${v.volume_id}  ${v.size_gib} GiB  free ${freeFor(v)}`);
    }
  }
  if (ambiguous.length > 0) {
    lines.push(
      `${ambiguous.length} volume(s) share an agent tag; hermetic will not guess which holds the memory`,
    );
  }
  lines.push("  hermetic volume ls   ·   hermetic agent create <name> --volume <id>");
  return lines.join("\n");
}

/** §9 `volume status <volume-id>`. */
export function renderVolumeStatus(v: VolumeDetailResult): string {
  const pairs: Array<[string, string]> = [
    ["volume", v.volume_id],
    ["group", v.group],
    ["state", v.state],
    ["size", `${v.size_gib} GiB`],
    ["az", v.availability_zone ?? "-"],
    ["agent tag", v.agent ?? "-"],
    ["agent row", v.agent_status ?? "-"],
    ["managed", v.managed ? "yes" : "no (hermetic did not create it)"],
    ["role=data", v.role_data ? "yes" : "no"],
    ["attached to", v.attached_to ?? "-"],
    ["free for", freeFor(v)],
    ["created", v.created_at ?? "-"],
    ["snapshots", `${v.snapshots}${v.newest_snapshot_at ? ` (newest ${v.newest_snapshot_at})` : ""}`],
    ["cost", `≈ ${usd(v.monthly_cost_usd)}/mo`],
    [
      "tags",
      Object.entries(v.tags)
        .map(([k, val]) => `${k}=${val}`)
        .join(" ") || "-",
    ],
  ];
  if (v.ambiguous_with.length > 0) {
    pairs.push(["ambiguous with", v.ambiguous_with.join(", ")]);
  }
  const width = Math.max(...pairs.map(([k]) => k.length));
  const head = pairs.map(([k, val]) => `${k.padEnd(width, " ")}  ${val}`).join("\n");
  if (v.snapshot_list.length === 0) return head;
  const snaps = renderTable(
    v.snapshot_list.map((s) => [s.snapshot_id, s.started_at, `${s.size_gib} GiB`]),
    ["SNAPSHOT", "STARTED", "SIZE"],
  );
  return `${head}\n\n${snaps}`;
}

/**
 * `settings show` (§4.6): the fleet's shared settings as three blocks — the
 * defaults a create inherits, the Hermes settings it seeds, and one row per
 * provider.
 *
 * The provider rows show the model each provider *resolves* to, marking which
 * of the two it came from: `(fleet)` for an override written here, `(catalog)`
 * for the build's own default. Printing the override alone would leave three
 * rows blank and hide the answer to the only question the table is asked —
 * what will this agent actually run.
 */
/** The fleet's default profile as `name (id)`, or a dash when it has none. */
function defaultProfileLabel(settings: SettingsResult["settings"]): string {
  const id = settings.default_profile;
  if (id === null || id === undefined) return "—";
  const profile = settings.profiles?.[id];
  return profile === undefined ? id : `${profile.name} (${id})`;
}

export function renderSettings(result: SettingsResult): string {
  const { settings, catalog } = result;
  const pairs: Array<[string, string]> = [
    // A fleet with no settings has no version to name, and printing `1` would
    // suggest `--expected-version 1` — which is a CONFLICT, because the version
    // a first write is conditional on is "there are none" and not a number.
    ["version", result.persisted ? `${settings.version}` : "— (not written yet)"],
    ["updated", `${settings.updated_at} by ${settings.updated_by}`],
    ["size", settings.defaults.size],
    // §8.3: what a create with no `--provider-profile` resolves to. The
    // pre-profile `defaults.provider` is below it and no longer settable: it is
    // the record of what this fleet was built with, not a live default.
    ["default profile", defaultProfileLabel(settings)],
    ["provider (pre-profile)", settings.defaults.provider],
    ["volume", `${settings.defaults.volume_gib} GiB`],
    ["root disk", `${settings.defaults.root_gib ?? DEFAULT_ROOT_GIB} GiB`],
    ["secrets", settings.defaults.secrets],
    ["agent model", settings.agent_defaults?.model ?? "-"],
    ["agent terminal", settings.agent_defaults?.terminal_backend ?? "-"],
    ["agent max turns", settings.agent_defaults?.max_turns?.toString() ?? "-"],
    ["agent reasoning", settings.agent_defaults?.reasoning_effort ?? "-"],
    ["agent approvals", settings.agent_defaults?.approvals_mode ?? "-"],
  ];
  const width = Math.max(...pairs.map(([k]) => k.length));
  const head = pairs.map(([k, v]) => `${k.padEnd(width, " ")}  ${v}`).join("\n");
  const rows = (Object.keys(catalog) as Array<keyof typeof catalog>).map((p) => {
    const entry = settings.providers[p];
    const override = entry?.default_model;
    return [
      p + (p === settings.defaults.provider ? " *" : ""),
      entry?.enabled === false ? "disabled" : "enabled",
      `${override ?? catalog[p].default_model} ${override ? "(fleet)" : "(catalog)"}`,
      entry?.secret ?? "—",
    ];
  });
  const table = renderTable(rows, ["PROVIDER", "STATE", "DEFAULT MODEL", "SECRET"]);
  const secrets =
    settings.secrets.length === 0
      ? "shared secrets: none"
      : `shared secrets: ${settings.secrets.map((s) => s.slug).join(", ")}`;
  return `${head}\n\n${table}\n\n${secrets}\n* the pre-profile default provider; the fleet default is the profile above`;
}

/**
 * `providers ls` (§8.3): one row per provider profile.
 *
 * `READY` is the answer to the only question the table is asked — can an agent
 * be created on this — and the reason beside it is why not, in core's own
 * words. "Stored" is never "verified": a key that is present may still be
 * wrong, and hermetic does not make an inference call to find out.
 */
export function renderProfiles(result: ProvidersListResult): string {
  if (result.profiles.length === 0) {
    return "no provider profiles yet — `hermetic providers create --provider <p> --name <n>`";
  }
  const rows = result.profiles.map((p) => [
    p.name + (p.is_default ? " *" : ""),
    p.id,
    p.provider,
    p.model,
    p.ready ? "ready" : `no (${p.ready_reason})`,
    p.grant ?? "—",
    p.linked_agents.length === 0 ? "—" : p.linked_agents.join(","),
  ]);
  const table = renderTable(rows, ["NAME", "ID", "PROVIDER", "MODEL", "READY", "GRANT", "AGENTS"]);
  return `${table}\n* the fleet default profile`;
}

/** One profile, printed back after a write (§8.3). */
export function renderProfile(result: ProvidersWriteResult): string {
  const p = result.profile;
  return [
    `${p.name}  ${p.id}  ${p.provider}${p.is_default ? "  (fleet default)" : ""}`,
    `  model     ${p.model}`,
    `  state     ${p.enabled ? "enabled" : "disabled"}, revision ${p.revision}`,
    `  ready     ${p.ready ? "yes" : "no"} (${p.ready_reason})`,
    `  credential ${p.credential.kind === "role" ? "instance role" : p.credential.slug}`,
    ...(p.grant === undefined ? [] : [`  grant     ${p.grant}`]),
    `  settings now at version ${result.settings.version}`,
  ].join("\n");
}

/**
 * `providers models` (§8.3): what the provider says it can run right now.
 *
 * The selected model is first — pinned by core, not re-sorted here — and an id
 * the catalog did not contain is marked `unlisted` rather than dropped, which
 * is the whole point of the mark.
 */
export function renderModels(result: ProvidersModelsOutput): string {
  const rows = result.models.map((m) => [
    m.id === result.default_model ? `${m.id} *` : m.id,
    m.name,
    m.capabilities?.context === undefined ? "—" : `${m.capabilities.context}`,
    m.unlisted === true ? "unlisted" : "",
  ]);
  const table = renderTable(rows, ["MODEL", "NAME", "CONTEXT", ""]);
  return `${result.provider} · ${result.models.length} model(s) · fetched ${result.fetched_at}\n\n${table}\n* selected`;
}

/**
 * `secrets ls` (§8.2): the fleet's shared slots, what state each is in, and who
 * reads it. No value is here to print — the whole list is metadata — and STATE
 * is the one column that distinguishes the three ways a slot can fail to be
 * useful: never filled (`empty`), named by nothing hermetic knows (`orphan`),
 * or simply gone (`missing`, a provider about to fall back to prompting).
 */
export function renderSharedSecrets(result: SecretsListResult): string {
  if (result.secrets.length === 0) return "no shared secrets";
  const state = (s: SharedSecretView): string =>
    s.orphan ? "orphan" : !s.exists ? "missing" : s.placeholder ? "empty" : "set";
  const rows = result.secrets.map((s) => [
    s.slug,
    s.label ?? "—",
    state(s),
    s.used_by.length === 0 ? "—" : s.used_by.join(", "),
    s.last_set_at ?? "—",
  ]);
  return renderTable(rows, ["SLUG", "LABEL", "STATE", "USED BY", "LAST SET"]);
}
