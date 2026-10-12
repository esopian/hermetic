import { useListeningIfAvailable } from "../state/listening-state.tsx";
import { FleetChatButton } from "../chat/components/FleetChatButton.tsx";
import { ListenButton, ListeningMark } from "./ListenButton.tsx";
/** The dense layout: one 56px row per agent, scrolling horizontally on its own. */
import type { AgentView, VolumeView } from "../api/index.ts";
import { currentStageLabel } from "../logic/bootstrap.ts";
import {
  diskTitle,
  fmtDuration,
  hostname,
  isOff,
  loadColor,
  pct,
  sizeGlyph,
  uptime,
  versionColor,
  worstDisk,
} from "../logic/format.ts";
import { lastSeenLabel } from "../logic/liveness-logic.ts";
import type { SkewStatusView } from "../logic/skew-logic.ts";
import { configLabel, configOf } from "../logic/skew-logic.ts";
import { ariaSort } from "../logic/selectors.ts";
import type { Sort, SortKey } from "../logic/selectors.ts";
import { Bar, CopyId, HealthSquares, StatusLabel } from "./primitives.tsx";
import { boardVolumes, volumeLine, volumeOf } from "../logic/volume-logic.ts";

/**
 * The eleven columns, in order, and which of them can be ordered by. The
 * unsortable ones were the whole complaint: numeric headers that look clickable
 * and are not, over a fleet where the only way to find the busiest agent was to
 * read every row.
 *
 * `Config` is the §6.6 skew column: whether the box applied the bundle the
 * fleet rendered for it. It is not sortable because its three values are not
 * ordered — `unknown` is not between `current` and `drifted`, it is a different
 * kind of answer.
 */
const COLUMNS: ReadonlyArray<{ label: string; key?: SortKey }> = [
  { label: "Agent", key: "name" },
  { label: "Status", key: "status" },
  { label: "Health" },
  { label: "Version", key: "version" },
  { label: "Config" },
  { label: "Size" },
  { label: "CPU", key: "cpu" },
  { label: "Mem", key: "mem" },
  { label: "Tailscale" },
  { label: "Uptime", key: "uptime" },
  { label: "Data volume" },
];

/** ▲/▼ on the column in force, and nothing at all on the others. */
function SortGlyph({ sort, column }: { sort: Sort | null; column: SortKey }) {
  if (sort === null || sort.key !== column) return null;
  return <span className="sort-glyph">{sort.dir === "asc" ? "▲" : "▼"}</span>;
}

export function FleetTable({
  agents,
  latest,
  foundation,
  tailnet,
  fleetId,
  fresh,
  volumes,
  selected,
  sort,
  onSort,
  onSelect,
  onCreateOnVolume,
  onSeeVolumes,
}: {
  agents: AgentView[];
  latest: string | null;
  /**
   * §6.6: `foundation.status` as `/api/meta` carries it, for the `Config`
   * column. Optional and nullable because a server that could not read `_fleet`
   * still renders a fleet table — the column then says `unknown`, which is what
   * it in fact is.
   */
  foundation?: SkewStatusView | null;
  tailnet: string;
  fleetId?: string | null;
  fresh: Set<string>;
  volumes: VolumeView[];
  selected: string | null;
  /**
   * Owned by the app shell, not by this table: the board and the triage view
   * render the same list, so an order chosen here has to be the order they draw
   * too or switching layout would silently reshuffle the fleet.
   */
  sort: Sort | null;
  onSort: (key: SortKey) => void;
  onSelect: (name: string) => void;
  onCreateOnVolume: (v: VolumeView) => void;
  onSeeVolumes: () => void;
}) {
  const listening = useListeningIfAvailable();
  const board = boardVolumes(volumes, agents);
  const loose = board.shown;
  const looseGib = loose.reduce((n, v) => n + v.size_gib, 0) + board.overflow.gib;
  const looseCost = loose.reduce((n, v) => n + v.monthly_cost_usd, 0) + board.overflow.monthly;
  const now = Date.now();
  return (
    <div className="body-scroll">
      <div className={listening ? "table listening-table" : "table"} role="table" aria-label="Fleet">
        <div className="trow thead" role="row">
          {listening && (
            <span role="columnheader" className="listening-cell">
              Listening
            </span>
          )}
          {COLUMNS.map((c) =>
            c.key === undefined ? (
              <span key={c.label} role="columnheader">
                {c.label}
              </span>
            ) : (
              <span key={c.label} role="columnheader" aria-sort={ariaSort(sort, c.key)}>
                <button
                  type="button"
                  className={sort?.key === c.key ? "th-sort is-sorted" : "th-sort"}
                  // Three states, so the operator can always get back to the
                  // server's own order: asc → desc → unsorted.
                  title={`Sort by ${c.label.toLowerCase()}`}
                  onClick={() => onSort(c.key as SortKey)}
                >
                  {c.label}
                  <SortGlyph sort={sort} column={c.key} />
                </button>
              </span>
            ),
          )}
        </div>
        {agents.map((a, i) => {
          const off = isOff(a);
          const cpu = off ? null : (a.metrics?.cpu_pct ?? null);
          const mem = off ? null : (a.metrics?.mem_pct ?? null);
          const disk = a.metrics?.disk_pct ?? null;
          // The root filesystem, reported separately since hermeticd learned to
          // measure it — absent on a row an older build wrote, and `—` there.
          const rootDisk = a.metrics?.root_disk_pct ?? null;
          const diskWorst = worstDisk(a.metrics);
          const classes = ["trow", "tbody-row"];
          if (off) classes.push("off");
          if (selected === a.name) classes.push("selected");
          return (
            <div
              key={a.name}
              data-chat-agent={a.name}
              data-listening={listening?.instances.includes(a.name)}
              className={classes.join(" ")}
              role="row"
              tabIndex={0}
              aria-label={`${a.name} · ${a.display_status}`}
              onClick={() => onSelect(a.name)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onSelect(a.name);
                }
              }}
            >
              {listening && (
                <span role="cell" className="listening-cell">
                  <ListenButton instance={a.name} />
                </span>
              )}
              <span className="cell-agent">
                <span className="idx">{String(i + 1).padStart(2, "0")}</span>
                <span className="nm">{a.name}</span>
                <ListeningMark instance={a.name} />
                <FleetChatButton instance={a.name} />
                {fresh.has(a.name) ? <span className="tag-new">NEW</span> : null}
              </span>
              <StatusLabel status={a.display_status} sub={currentStageLabel(a) ?? lastSeenLabel(a)} />
              <HealthSquares agent={a} />
              <span className="cell-version" style={{ color: versionColor(a, latest) }}>
                {a.hermes_version}
              </span>
              {(() => {
                const verdict = configLabel(configOf(foundation, a.name));
                return (
                  <span className={verdict.warn ? "cell-config warn" : "cell-config"}>
                    {verdict.label}
                    {verdict.warn ? " ⚠" : ""}
                  </span>
                );
              })()}
              <span className="cell-size">
                <b className="sizebox">{sizeGlyph(a.size)}</b>
                <span className="it">{a.instance_type}</span>
              </span>
              <span className="cell-meter">
                <span className="v" style={{ color: loadColor(cpu) }}>
                  {pct(cpu)}
                </span>
                <Bar value={cpu} color={loadColor(cpu)} />
              </span>
              <span className="cell-meter">
                <span className="v" style={{ color: loadColor(mem) }}>
                  {pct(mem)}
                </span>
                <Bar value={mem} color={loadColor(mem)} />
              </span>
              <span className="cell-ts">
                <span className="h">{hostname(a.name, tailnet, a.tailscale_dns_name, fleetId)}</span>
                <span className="ip">{a.tailscale_ip ?? "—"}</span>
              </span>
              <span className="cell-uptime">{uptime(a, now)}</span>
              {(() => {
                // The `Disk` meter said how full the volume is; this says
                // whether anything is reading it, which is the question the
                // fleet could not answer at all before (§9). The percentage
                // lives on in the agent drawer's metric tiles.
                const line = volumeLine(a, volumeOf(a, volumes));
                if (!line) {
                  return (
                    <span
                      className="cell-disk"
                      // Shared with the drawer's passing disk check
                      // (`diskTitle`), so the sentence an operator gets on hover
                      // here and the one they get in the drawer cannot drift —
                      // and both carry the sizes, which the two bare
                      // percentages in the cell deliberately do not have room
                      // for. A percentage with no denominator is the whole
                      // problem: 96% of 500 GiB is fine and 96% of 8 GiB is a
                      // box that has stopped taking updates.
                      title={diskTitle(a)}
                    >
                      <span className="v">
                        {pct(disk)}
                        <span style={{ color: "var(--fg3)" }}> / </span>
                        {/*
                          Only the root number carries its own colour: the data
                          number has always been `.v`'s grey, and a row where
                          the root disk is the full one has to be able to say so
                          without the cell going red about `/data`.
                        */}
                        <span style={{ color: loadColor(rootDisk) }}>{pct(rootDisk)}</span>
                      </span>
                      {/* The bar is the worse of the two — the one about to bite. */}
                      <Bar value={diskWorst} color={loadColor(diskWorst)} style={{ width: 60 }} />
                    </span>
                  );
                }
                return (
                  // The same disk sentence as the fallback cell above carries.
                  // This variant is the *common* one — a row whose volume
                  // resolves shows the volume, so without this the fleet table
                  // said nothing at all about either filesystem on almost every
                  // row, and the root disk's only appearance was a red square
                  // in Health with no number behind it.
                  <span className="cell-vol mono" style={{ color: line.color }} title={diskTitle(a)}>
                    <i style={{ background: line.color }} />
                    <CopyId
                      id={line.id}
                      label={`${line.label}${line.state ? ` · ${line.state}` : ""}`}
                      note={line.note}
                      style={{ color: "inherit" }}
                    />
                  </span>
                );
              })()}
            </div>
          );
        })}

        {loose.length > 0 || board.overflow.count > 0 ? (
          <>
            <div className="tsub" role="row">
              <span className="kicker" style={{ color: "var(--acc)" }}>
                Volumes · no agent
              </span>
              <span className="mono dim">
                {loose.length + board.overflow.count} volume
                {loose.length + board.overflow.count === 1 ? "" : "s"} · {looseGib} GiB · ≈ $
                {looseCost.toFixed(2)}/mo · nothing is reading them
              </span>
              <button type="button" className="btn btn-sm" onClick={onSeeVolumes}>
                All volumes →
              </button>
            </div>
            {loose.map((v) => (
              <div key={v.volume_id} className="trow tbody-row vol-row" role="row">
                <span className="cell-agent">
                  <span className="idx">—</span>
                  <span className="nm dim">{v.agent ?? "untagged"}</span>
                  <span className="tag ghost">volume</span>
                </span>
                <span className="cell-status" style={{ color: "var(--acc)" }}>
                  <i style={{ background: "var(--acc)" }} />
                  memory kept
                </span>
                <span className="mono dim">
                  {v.snapshots === 0 ? "no snaps" : `${v.snapshots} snaps`}
                </span>
                <span className="mono dim">—</span>
                <span className="mono">{v.size_gib} GiB</span>
                <span className="mono dim" style={{ gridColumn: "span 3" }}>
                  <CopyId id={v.volume_id} note={`${v.size_gib} GiB`} /> · free{" "}
                  {fmtDuration(v.free_for_ms ?? 0)} · ≈ ${v.monthly_cost_usd.toFixed(2)}/mo
                </span>
                <span>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => onCreateOnVolume(v)}
                  >
                    Create agent →
                  </button>
                </span>
              </div>
            ))}
            {board.overflow.count > 0 ? (
              <div className="trow tbody-row vol-row" role="row">
                <span className="cell-agent">
                  <span className="idx">—</span>
                  <span className="mono dim">
                    {board.overflow.count} more · {board.hiddenElsewhere} not shown here
                  </span>
                </span>
                <span className="mono dim" style={{ gridColumn: "2 / -1" }}>
                  shown in Volumes, where an ambiguous pair and anything hermetic did not create can be
                  seen but not touched
                </span>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
