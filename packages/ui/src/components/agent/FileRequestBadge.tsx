/**
 * `▣ n` on a fleet table row: the agent has `n` file requests waiting on the
 * operator (attachments plan §8.6). `--warn`, because it needs you. Drawn from
 * the shared poller, so it is absent where there is no provider and on an
 * agent with none open.
 */
import { useOpenRequestCount } from "../../state/file-requests-state.tsx";
import { openRequestsLabel } from "./files-logic.ts";

export function FileRequestBadge({ agent }: { agent: string }) {
  const n = useOpenRequestCount(agent);
  if (n === 0) return null;
  const label = openRequestsLabel(n);
  return (
    <span className="tag-freq" role="img" aria-label={label} title={label}>
      ▣ {n}
    </span>
  );
}
