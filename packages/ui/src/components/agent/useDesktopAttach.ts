/**
 * §7.4's Desktop attach details, fetched on request and dropped on every
 * agent switch. Split out of `AgentDrawer.tsx`; `AgentConfig` draws them.
 */
import { useCallback, useEffect, useState } from "react";
import { desktopAttach } from "../../api/index.ts";
import type { DesktopAttach } from "../../api/index.ts";

export function useDesktopAttach(name: string) {
  /**
   * §7.4's Desktop attach details, held only while the panel is open.
   *
   * State rather than a memo, and dropped on every agent switch below, because
   * the token in it is a live credential with a lifetime shorter than this
   * drawer's: it dies when the box's dashboard process restarts. Keeping it
   * around would mean offering an operator a token that may already be dead,
   * which is worse than making them ask again.
   */
  const [attach, setAttach] = useState<DesktopAttach | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  /** The token is masked until asked for; a drawer left open should not leak it. */
  const [tokenShown, setTokenShown] = useState(false);

  /**
   * Fetch the attach details on request, never on open: it reaches the box over
   * the tailnet, and an operator reading a drawer has not asked for that.
   */
  const doAttach = useCallback(async () => {
    setAttachError(null);
    setTokenShown(false);
    setAttaching(true);
    try {
      setAttach(await desktopAttach(name));
    } catch (e) {
      setAttach(null);
      setAttachError(e instanceof Error ? e.message : String(e));
    } finally {
      setAttaching(false);
    }
  }, [name]);

  /** A different agent is a different box and a different token. Drop both. */
  useEffect(() => {
    setAttach(null);
    setAttachError(null);
    setTokenShown(false);
  }, [name]);

  return { attach, attaching, attachError, tokenShown, setTokenShown, doAttach };
}
