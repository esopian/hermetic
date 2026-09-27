/**
 * `hermetic` — the cards only this portal can draw.
 *
 * **A `hermetic` block carries a ref and never data**, and this file is where
 * that rule is either kept or quietly broken. The block says
 * `{ card: "agent", ref: "ember" }`; every number on the card below comes from
 * the live fleet stream. So the card is still right three hours after the turn
 * that produced it, and it is right even when the model that produced it was
 * wrong about the fleet — which is the case that makes this worth the
 * indirection, because a model asked about disk will occasionally invent a
 * percentage and a card rendered from the block would print it.
 *
 * Nothing here reads a field off the block other than `card` and `ref`. If a
 * later schema change puts data on one, this file still must not.
 *
 * Four variants, and they differ in what they can answer. `agent` and `fleet`
 * have a live source in this tree; `op` and `plan` do not, and say so rather
 * than inventing one. A plan in particular is never actionable from a
 * transcript: §1's "plan, then apply" gets no exception for having been asked
 * for conversationally.
 */
import type { ChatBlockOf } from "../../../api/index.ts";
import { UnknownBlock } from "./Unknown.tsx";
import { pct, statusColor } from "../../../logic/format.ts";
import { useFleetIfAvailable } from "../../../state/state.tsx";
import { CardBody } from "../Card.tsx";

function Tiles({ cpu, mem, disk }: { cpu: number | null; mem: number | null; disk: number | null }) {
  return (
    <div className="ch-tiles">
      <div className="ch-tile">
        <b>{pct(cpu)}</b>
        <span>cpu</span>
      </div>
      <div className="ch-tile">
        <b>{pct(mem)}</b>
        <span>mem</span>
      </div>
      <div className="ch-tile">
        <b>{pct(disk)}</b>
        <span>/data</span>
      </div>
    </div>
  );
}

function AgentCard({ target: name }: { target: string }) {
  const fleet = useFleetIfAvailable();
  const agent = fleet?.byName.get(name) ?? null;

  if (!agent) {
    return (
      <div className="ch-card muted">
        <div className="ch-card-head">
          <span>agent</span>
          <code className="mono">{name}</code>
          <span className="right">not in this fleet</span>
        </div>
        <CardBody>
          <p>
            The turn referred to an agent this fleet has no row for. The reference is kept verbatim — it
            is what the bot said — and nothing is drawn from it.
          </p>
        </CardBody>
      </div>
    );
  }

  const status = agent.display_status;
  const tone =
    status === "ready" ? "ok" : status === "degraded" ? "warn" : status === "error" ? "bad" : "muted";
  return (
    <div className={`ch-card ${tone}`}>
      <div className="ch-card-head">
        <span>agent</span>
        <code className="mono">{agent.name}</code>
        <span className="right">live · from the fleet stream</span>
      </div>
      <CardBody>
        <div className="ch-meter">
          <i className="dot" style={{ background: statusColor(status) }} />
          <b>{status}</b>
          <span className="mono" style={{ marginLeft: "auto" }}>
            {agent.tailscale_dns_name ?? agent.name}
          </span>
        </div>
        <Tiles
          cpu={agent.metrics?.cpu_pct ?? null}
          mem={agent.metrics?.mem_pct ?? null}
          disk={agent.metrics?.disk_pct ?? null}
        />
        <div className="kv">
          <span className="k">size</span>
          <span className="v">{agent.size}</span>
          <span className="k">hermes</span>
          <span className="v">{agent.running_hermes_version ?? agent.hermes_version}</span>
        </div>
      </CardBody>
    </div>
  );
}

function FleetCard({ target: id }: { target: string }) {
  const fleet = useFleetIfAvailable();
  const config = fleet?.meta?.config ?? null;
  return (
    <div className="ch-card acc">
      <div className="ch-card-head">
        <span>fleet</span>
        <code className="mono">{id}</code>
        <span className="right">{fleet ? `${fleet.agents.length} agents` : "no live fleet here"}</span>
      </div>
      <CardBody>
        <div className="kv">
          <span className="k">account</span>
          <span className="v mono">{config?.account_id ?? "—"}</span>
          <span className="k">region</span>
          <span className="v mono">{config?.region ?? "—"}</span>
          <span className="k">fleet</span>
          <span className="v mono">{config?.fleet_id ?? id}</span>
        </div>
      </CardBody>
    </div>
  );
}

/**
 * An operation and a plan, both of which this component can only *point at*.
 *
 * The op registry and the plan drawer are the surfaces that own them, and both
 * are reached from outside the transcript. Rendering a step list here from a
 * block's payload would be rendering data off a block, which is the one thing
 * this file exists to not do; rendering it from a live read would mean an
 * live subscription per card in a scrolling log.
 */
function PointerCard({ card, target: id }: { card: "op" | "plan"; target: string }) {
  const op = card === "op";
  return (
    <div className={op ? "ch-card acc" : "ch-card warn"}>
      <div className="ch-card-head">
        <span>{op ? "operation" : "plan"}</span>
        <code className="mono">{id}</code>
        <span className="right">{op ? "runs in the engine" : "needs confirming"}</span>
      </div>
      <CardBody>
        <p>
          {op
            ? "The operation runs in the engine and is safe to leave. Its progress, its events and its outcome live in the op registry, not in this transcript."
            : "A plan is reviewed and applied in its own drawer. Chat can name one; it cannot apply one — plan, then apply gets no exception for having been asked for in a conversation."}
        </p>
      </CardBody>
    </div>
  );
}

export function HermeticBlock({ block }: { block: ChatBlockOf<"hermetic"> }) {
  switch (block.card) {
    case "agent":
      return <AgentCard target={block.ref} />;
    case "fleet":
      return <FleetCard target={block.ref} />;
    case "op":
      return <PointerCard card="op" target={block.ref} />;
    case "plan":
      return <PointerCard card="plan" target={block.ref} />;
    default:
      // Every `card` value this build knows is named above, so this is a card a
      // newer core sent — the `hermes_ref`-bump case §9.2 exists for. It goes
      // to the fallthrough renderer rather than to a nearby branch: a fifth
      // card drawn under the heading `plan · needs confirming` would be the UI
      // asserting something about the fleet that nobody told it. A wrong label
      // is worse than an unstyled payload.
      return <UnknownBlock block={block} />;
  }
}
