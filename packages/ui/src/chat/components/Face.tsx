/**
 * An avatar in its `.ch-ava` frame, with the status square beside it.
 *
 * The avatar itself is the other half of Phase 6 and lives in `./avatar/`. This
 * is the whole of the renderer's dependency on it: the three parts of the
 * identity key, a size, and the two state axes. Nothing here derives a seed —
 * `avatarSeed()` is the only place that happens, and it is seeded from
 * `fleet_id/instance/bot` rather than from a display name, so renaming a bot
 * does not change its face (§9.2).
 *
 * `status` and `activity` come from the *fleet row* wherever there is one, not
 * from what chat has inferred. A box the fleet already reports stopped has a
 * stopped face even if a transcript read has not failed yet.
 */
import { Avatar } from "./avatar/Avatar.tsx";
import type { AvatarActivity, AvatarStatus } from "./avatar/Avatar.tsx";

/** The status square's colour, spelled in the stylesheet's own tokens. */
export function statusVar(status: AvatarStatus): string {
  switch (status) {
    case "ready":
      return "var(--ok)";
    case "degraded":
      return "var(--warn)";
    case "error":
      return "var(--bad)";
    case "pending":
      return "var(--acc)";
    default:
      return "var(--fg3)";
  }
}

export function Face({
  fleetId,
  instance,
  bot,
  size,
  status,
  activity = "idle",
  /** The status square beside the face. On in the rail, off in the transcript. */
  square = true,
  large = false,
}: {
  fleetId: string;
  instance: string;
  bot: string;
  size: number;
  status: AvatarStatus;
  activity?: AvatarActivity;
  square?: boolean;
  large?: boolean;
}) {
  return (
    <span className={large ? "ch-ava lg" : "ch-ava"}>
      <Avatar
        fleet_id={fleetId}
        instance={instance}
        bot={bot}
        size={size}
        status={status}
        activity={activity}
      />
      {square ? <i className="st" style={{ background: statusVar(status) }} /> : null}
    </span>
  );
}

/**
 * The operator's own face. Never generated — it is not a bot, it has no place
 * in the fleet's identity key, and there is nothing to seed it from.
 *
 * `ME`, because the portal does not know who is looking at it. Two letters
 * either way, so the box is the size the stylesheet expects.
 */
export function OperatorFace() {
  return <div className="ch-avatar me">ME</div>;
}
