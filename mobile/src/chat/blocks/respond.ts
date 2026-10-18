/**
 * One respond call's lifecycle for a card (desktop `useSubmit`): `state` is the
 * line the card shows — `SENT`, `GONE`, or the error — and `settled` whether
 * the request is over. A success or a refusal plays its haptic.
 */
import { useCallback, useRef, useState } from "react";
import { GONE, SENT } from "../../client/chat-requests.ts";
import type { RespondInput } from "../../client/conversation-store.ts";
import { haptic } from "../../ui/haptics.ts";
import { useChatScope } from "../ChatScope.tsx";

export function useSubmit(session: string | null) {
  const scope = useChatScope();
  const respond = scope?.respond ?? null;
  const [state, setState] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const submit = useCallback(
    async (input: RespondInput) => {
      if (inFlight.current || !respond) return;
      inFlight.current = true;
      setBusy(true);
      setState("");
      try {
        const result = await respond(input, session);
        const expired = result && typeof result === "object" && result.status === "expired";
        setState(expired ? GONE : SENT);
        if (expired) haptic.warning();
        else haptic.success();
      } catch (e) {
        haptic.error();
        setState(e instanceof Error ? e.message : String(e));
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [respond, session],
  );
  return { live: !!respond, state, busy, submit, settled: state === SENT || state === GONE };
}
