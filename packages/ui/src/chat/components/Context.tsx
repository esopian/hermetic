/**
 * The right panel: what this box is, what this conversation has cost, and what
 * the bot has been allowed to do in it.
 *
 * Everything on the agent half is read from the live fleet row rather than from
 * anything chat learned, for the same reason a `hermetic` block carries a ref
 * and never data: the panel has to still be right after the operator has left
 * the tab open for three hours. The conversation half is summed off the turn
 * meters the box sent, and says "—" rather than "$0" when no turn carried one —
 * a provider that did not report a cost is not a provider that charged nothing.
 */
import type { AgentView, ChatMessageView } from "../../api/index.ts";
import { threadTotals, toolsUsed } from "../chat-logic.ts";
import { fmtClock, pct, statusColor } from "../../logic/format.ts";

export function Context({
  agent,
  instance,
  bot,
  messages,
  turnsAllowed,
  onHide,
}: {
  agent: AgentView | null;
  instance: string;
  bot: string;
  messages: ChatMessageView[];
  /** hermetic's own per-agent turn ceiling, when the fleet has one to state. */
  turnsAllowed?: number | null;
  onHide?: () => void;
}) {
  const tools = toolsUsed(messages);
  const totals = threadTotals(messages);
  const started = messages[0]?.at ?? null;

  return (
    <aside className="ch-ctx">
      <div className="ch-ctx-head">
        <span className="kicker">Context</span>
        {onHide ? (
          <button type="button" className="btn-mini" onClick={onHide}>
            Hide
          </button>
        ) : null}
      </div>
      <div className="ch-ctx-body">
        <div className="ch-ctx-sec">
          <span className="kicker">Agent</span>
          <div className="ch-tiles">
            <div className="ch-tile">
              <b>{pct(agent?.metrics?.cpu_pct)}</b>
              <span>cpu</span>
            </div>
            <div className="ch-tile">
              <b>{pct(agent?.metrics?.mem_pct)}</b>
              <span>mem</span>
            </div>
            <div className="ch-tile">
              <b>{pct(agent?.metrics?.disk_pct)}</b>
              <span>/data</span>
            </div>
          </div>
          <div className="kv">
            <span className="k">status</span>
            <span className="v" style={{ color: statusColor(agent?.display_status ?? "unknown") }}>
              {agent?.display_status ?? "no fleet row"}
            </span>
            <span className="k">instance</span>
            <span className="v mono">{instance}</span>
            <span className="k">hermes</span>
            <span className="v mono">
              {agent?.running_hermes_version ?? agent?.hermes_version ?? "—"}
            </span>
          </div>
        </div>

        <div className="ch-ctx-sec">
          <span className="kicker">This conversation</span>
          <div className="kv">
            <span className="k">bot</span>
            <span className="v mono">{`${bot}@${instance}`}</span>
            <span className="k">started</span>
            <span className="v">{started ? fmtClock(started) : "—"}</span>
            <span className="k">turns</span>
            <span className="v">
              {turnsAllowed ? `${totals.turns} / ${turnsAllowed}` : totals.turns}
            </span>
            <span className="k">tokens</span>
            <span className="v">
              {totals.metered
                ? `${totals.inputTokens.toLocaleString()} in · ${totals.outputTokens.toLocaleString()} out`
                : "—"}
            </span>
            <span className="k">cost</span>
            <span className="v">{totals.metered ? `$${totals.costUsd.toFixed(4)}` : "—"}</span>
            <span className="k">transcript</span>
            <span className="v">on the box · /data/hermes</span>
          </div>
        </div>

        <div className="ch-ctx-sec">
          <span className="kicker">Tools this thread used</span>
          <div>
            {tools.length === 0 ? (
              <span className="ch-toolchip">
                <i />
                none yet
              </span>
            ) : (
              tools.map((tool) => (
                <span key={tool.name} className="ch-toolchip">
                  <i data-verdict={tool.verdict} />
                  {tool.name}
                </span>
              ))
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
