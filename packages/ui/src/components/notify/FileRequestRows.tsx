/**
 * The bell's file-request rows (attachments plan §8.6, scenario D): one row per
 * open request on any running agent, whichever session raised it — a cron job
 * or a Telegram chat has no card anywhere else. Read from the shared poller
 * (`file-requests-state.tsx`), so a request is one row however many times it
 * is seen, and leaves when the box says it is no longer open.
 *
 * A row opens the agent's Files tab, where the request is answered. The
 * purpose is the model's words: shown as text, cut to one line.
 */
import { agentHash } from "../../nav/agent-nav.ts";
import { useFileRequestsIfAvailable } from "../../state/file-requests-state.tsx";
import { requestClass, truncatePurpose } from "../agent/files-logic.ts";

export function FileRequestRows({ onNavigated }: { onNavigated: () => void }) {
  const files = useFileRequestsIfAvailable();
  const all = files?.all ?? [];
  if (all.length === 0) return null;
  return (
    <div className="nt-sec-group nt-freq">
      <div className="nt-sec pin">
        File requests <span className="c">{all.length}</span>
      </div>
      {all.map(({ agent, request }) => {
        const secret = requestClass(request) === "secret";
        const title = `${agent} requested ${secret ? "a secret" : "a file"}: ${truncatePurpose(request.purpose, 72)}`;
        return (
          <div
            key={`${agent}/${request.request_id}`}
            className="nt-item needs-action"
            data-unread="true"
            data-kind="file_request"
          >
            <div className="nt-icon nt-freq-icon" aria-hidden="true">
              {secret ? "◆" : "▣"}
            </div>
            <div className="nt-main">
              <button
                type="button"
                className="nt-hit"
                onClick={() => {
                  window.location.hash = agentHash(agent, "files");
                  onNavigated();
                }}
              >
                <span className="nt-title">{title}</span>
                <span className="nt-src">
                  <i className="dot nt-freq-dot" />
                  {`${agent} · ${request.session_id ?? "no session"} · open Files →`}
                </span>
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
