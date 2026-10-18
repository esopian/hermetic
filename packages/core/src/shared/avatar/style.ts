/**
 * The avatar style a viewer picks (§9.2, §9.4).
 *
 * Shared because three places must agree on the list and its default: the
 * desktop's Settings › Chat picker, the phone's Settings, and the pairing
 * link's `prefs` field that carries the desktop's choice to the phone. Pure
 * values only; the renderers live beside this file under `shared/avatar/`.
 */

export type AvatarStyle = "sigil" | "pixel" | "blob";

export const AVATAR_STYLES: readonly AvatarStyle[] = ["sigil", "pixel", "blob"];

/**
 * `blob` is the default, chosen by the owner on 2026-09-17.
 *
 * It is the style that costs something to ship, and the cost was accepted
 * deliberately rather than overlooked (§9.2). The desktop's `styles.css`
 * declares `* { border-radius: 0 }` and means it — the brutalist shell has no
 * curve anywhere — so a blob is a **stated exception to a real rule**, and the
 * reason it is allowed is that an avatar is the one thing on screen that is not
 * a control, not a surface and not a seam. It is a face. A rule with one
 * deliberate exception is still a rule; a rule with one undocumented exception
 * is a bug somebody later "fixes", which is why this comment exists and why
 * `docs/ui-brief.md` names it too.
 *
 * `sigil` was the default until this choice: a 5×3 cell matrix built entirely
 * from hermetic's own unit, the square. It remains available and remains the
 * conservative pick if the curve is ever regretted — swapping the constant
 * below is the whole change, because every style reads the same seed.
 */
export const DEFAULT_AVATAR_STYLE: AvatarStyle = "blob";

export function isAvatarStyle(value: unknown): value is AvatarStyle {
  return typeof value === "string" && (AVATAR_STYLES as readonly string[]).includes(value);
}
