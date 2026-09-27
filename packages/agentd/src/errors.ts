/**
 * hermeticd's exit-code contract (§6.3): 0 ok, 1 error, 3 manifest refused.
 * Unlike core, hermeticd *is* a program with a human-visible exit status, so the
 * code lives on the error and `main.ts` is the only place that reads it.
 */
export type AgentdErrorCode =
  | "MANIFEST_REFUSED"
  | "USERDATA_INVALID"
  | "IMDS_UNAVAILABLE"
  | "COMMAND_FAILED"
  | "CHECKSUM_MISMATCH"
  /**
   * This agent runs a browser and the box cannot obtain the Chrome build its
   * manifest pins: the fleet manifest records no `browser` entry for that
   * `chrome_ref`, or the object it names could not be read.
   *
   * Named rather than left as an S3 403 out of the middle of a bootstrap stage
   * because the two causes have two different fixes and neither is guessable
   * from `AccessDenied`: a fleet that has never mirrored this build needs
   * `hermetic artifacts push`, and a fleet whose instance role predates
   * foundation v14 does not grant `browser/*` at all and needs `hermetic
   * foundation update` first. Both are in the message.
   */
  | "BROWSER_BUILD_MISSING"
  /**
   * A directory hermetic creates inside the `hermes` account's own home —
   * `$HERMES_HOME`, the browser profile root — is a symlink, or is not a
   * directory at all.
   *
   * Refused rather than followed, and refused rather than replaced. The account
   * owns that home, so it can put a symlink at any name directly under it, and
   * this is the honest answer to finding one: hermetic does not delete it,
   * because one an operator placed deliberately is not hermetic's to remove.
   *
   * It is not what makes the create *safe* — `installAccountDir` runs as the
   * account, so the symlink buys nothing whatever it points at. This code is
   * what makes the failure legible instead of an `EACCES` from somewhere
   * surprising.
   */
  | "AGENT_DIR_UNSAFE"
  /** The box is something hermetic has no artifact for — an arch, mostly. */
  | "UNSUPPORTED"
  /**
   * `stage verify-hermes` found the agent unable to answer: no provider, no
   * model, or a keyed provider with no key on the box. Named rather than
   * `INTERNAL` because it is not a hermeticd fault at all — it is a statement
   * about this agent's configuration, and the operator's next move (`agent set`
   * then `agent rerun`, or `secrets push`) follows from the code.
   */
  | "HERMES_MISCONFIGURED"
  /**
   * No unit at `/etc/systemd/system/hermes-gateway.service` — either because
   * `hermes gateway install --system` returned 0 and wrote none, or because an
   * earlier apply's installer wrote one under another name, which is checked
   * for *before* the installer would be run again (`detail.found` names it).
   * The name is an inference — upstream derives it from `HERMES_HOME` and only
   * a default layout makes the profile suffix empty — so it is asserted rather
   * than trusted. Named rather than `COMMAND_FAILED` because nothing failed:
   * the box is one where hermetic's assumption about upstream stopped being
   * true, and the operator's next move is to look at what was actually written.
   */
  | "GATEWAY_UNIT_MISSING"
  /**
   * `manifest.units` names a unit systemd has never heard of: no file under
   * `/etc/systemd/system`, none from a package, so `enable`/`restart` would fail
   * with systemd's own "does not exist". Raised *before* systemctl is asked, and
   * named rather than `COMMAND_FAILED`, because the raw stderr says what broke
   * and not why: the usual cause is a manifest rendered by a hermetic newer than
   * the hermeticd applying it — a newer core can list a unit only a newer
   * hermeticd knows how to install (the gateway unit was the first). The remedy
   * — `hermetic artifacts push`, then `agent recreate` — follows from the code:
   * a rerun would re-run the stages under the same hermeticd, which is the one
   * that does not know the unit, while a recreate launches a box that fetches
   * the release that was just published.
   */
  | "UNIT_MISSING"
  | "TRANSITION_REJECTED"
  | "CONFLICT"
  | "USAGE"
  | "INTERNAL";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_MANIFEST_REFUSED = 3;

export class AgentdError extends Error {
  readonly code: AgentdErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: AgentdErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "AgentdError";
    this.code = code;
    this.detail = detail;
  }

  /** 3 for a refused manifest (§6.3 step 3), 1 for everything else. */
  get exitCode(): number {
    return this.code === "MANIFEST_REFUSED" ? EXIT_MANIFEST_REFUSED : EXIT_ERROR;
  }
}

export function exitCodeFor(e: unknown): number {
  return e instanceof AgentdError ? e.exitCode : EXIT_ERROR;
}
