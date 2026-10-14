/**
 * `approval` — the agent stopped and is waiting on you (desktop
 * `blocks/Approval.tsx` + `ApprovalActions.tsx`). A soft card led by a warn
 * dot while it waits on you, never collapsed. The buttons are exactly
 * `block.choices` in the gateway's order with the desktop's labels; "Always
 * allow" persists a pattern on the box, so it takes an inline confirm naming
 * the pattern and the command. Expired, it says so; closed by the box, it says
 * the command was not run; answered here, it says what was sent. In a turn no
 * longer live on this phone (`stale`), its buttons are drawn disabled.
 */
import { type ReactNode, useState } from "react";
import { View } from "react-native";
import { railTime } from "../../client/chat-logic.ts";
import {
  APPROVAL_LABEL,
  APPROVAL_OUTCOME,
  approvalClosedLine,
  type ClosedRequest,
  EXPIRED,
  GONE,
  offeredChoices,
  SENT,
  STALE,
} from "../../client/chat-requests.ts";
import type { ApprovalBlock, ApprovalChoice } from "@hermetic/core/chat-client";
import { useTheme } from "../../theme/theme.tsx";
import { Button } from "../../ui/Button.tsx";
import { haptic } from "../../ui/haptics.ts";
import { Text } from "../../ui/Text.tsx";
import { CodePane } from "../CodePane.tsx";
import { useSubmit } from "./respond.ts";
import { NeedsDot, SoftCard } from "./SoftCard.tsx";

export function ApprovalCard({
  block,
  now,
  closed,
  pending = 0,
  session,
  released = false,
  stale = false,
}: {
  block: ApprovalBlock;
  now: number;
  closed?: ClosedRequest | undefined;
  /** Open approvals in this turn, this one included. */
  pending?: number;
  /** The session the message belongs to (where the answer goes). */
  session: string | null;
  /** Already answered from this phone (another render of the same card). */
  released?: boolean;
  /** Its turn is no longer live on this phone: nothing can be answered here (`openRequests`). */
  stale?: boolean;
}) {
  const t = useTheme();
  const { live, state, busy, submit, settled } = useSubmit(session);
  const [chosen, setChosen] = useState<ApprovalChoice | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [lapsed, setLapsed] = useState(false);
  const closedLine = closed ? approvalClosedLine(closed.kind) : null;
  const expired = lapsed || (!!block.expires_at && Date.parse(block.expires_at) < now);
  const request_id = block.request_id ?? null;

  const answer = (choice: ApprovalChoice) => {
    if (!request_id) return;
    setChosen(choice);
    void submit({ request_id, kind: "approval", choice });
  };

  const always = () => {
    const gone = !!block.expires_at && Date.parse(block.expires_at) < Date.now();
    setConfirming(false);
    if (gone || closed) {
      setLapsed(true);
      return;
    }
    answer("always");
  };

  let foot: ReactNode;
  if (closedLine)
    foot = (
      <Text accessibilityRole="text" tone="bad" weight={700} variant="bodySmall">
        {closedLine}
      </Text>
    );
  else if (!live || !request_id)
    foot = (
      <Text variant="bodySmall" tone="fg2">
        Respond in Hermes. This conversation is waiting for your approval.
      </Text>
    );
  else if (settled || released)
    foot = (
      <Text variant="bodySmall" weight={700} tone={chosen === "deny" ? "bad" : "ok"}>
        {state === SENT && chosen ? APPROVAL_OUTCOME[chosen] : released && !state ? SENT : GONE}
      </Text>
    );
  else if (expired)
    foot = (
      <Text variant="bodySmall" tone="fg2">
        {EXPIRED}
      </Text>
    );
  else if (stale)
    foot = (
      <View style={{ gap: t.space.sm }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
          {offeredChoices(block).map((choice) => (
            <Button
              key={choice}
              label={APPROVAL_LABEL[choice]}
              variant="secondary"
              soft
              disabled
              style={{ flexGrow: 1, flexBasis: "45%" }}
              onPress={() => undefined}
            />
          ))}
        </View>
        <Text variant="bodySmall" tone="fg2">
          {STALE}
        </Text>
      </View>
    );
  else if (confirming)
    foot = (
      <View accessibilityRole="none" style={{ gap: t.space.sm }}>
        <Text weight={800}>Always allow this command?</Text>
        <Text variant="bodySmall" tone="fg2">
          Hermes stops asking for commands that match this pattern. It is saved in ~/.hermes/config.yaml
          on the box.
        </Text>
        {block.pattern ? (
          <Text mono variant="caption" tone="warn" selectable>
            {block.pattern}
          </Text>
        ) : null}
        <CodePane text={block.summary} copy={false} />
        <View style={{ flexDirection: "row", gap: t.space.sm }}>
          <Button
            label="Cancel"
            variant="secondary"
            soft
            style={{ flex: 1 }}
            onPress={() => setConfirming(false)}
          />
          <Button label="Always allow" soft disabled={busy} style={{ flex: 1 }} onPress={always} />
        </View>
      </View>
    );
  else
    foot = (
      <View style={{ gap: t.space.sm }}>
        {pending > 1 ? (
          <Text variant="caption" weight={600} tone="warn">{`${pending} approvals pending`}</Text>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
          {offeredChoices(block).map((choice) => (
            <Button
              key={choice}
              label={APPROVAL_LABEL[choice]}
              variant={choice === "deny" ? "destructive" : choice === "once" ? "primary" : "secondary"}
              soft
              busy={busy && chosen === choice}
              disabled={busy}
              haptic={false}
              style={{ flexGrow: 1, flexBasis: "45%" }}
              onPress={() => {
                if (choice === "always") {
                  haptic.warning();
                  setConfirming(true);
                } else {
                  haptic.medium();
                  answer(choice);
                }
              }}
            />
          ))}
        </View>
      </View>
    );

  const waiting = !closedLine && !settled && !released && !expired;
  return (
    <SoftCard testID={`approval-${request_id ?? "none"}`}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
        {waiting ? <NeedsDot /> : null}
        <Text variant="bodySmall" weight={600} tone={waiting ? "fg" : "fg2"} style={{ flex: 1 }}>
          Approval required
        </Text>
        {block.expires_at && !closed ? (
          <Text variant="caption" tone="fg3">
            {`expires ${railTime(block.expires_at, now)}`}
          </Text>
        ) : null}
      </View>
      <View style={{ gap: t.space.sm }}>
        {/* What it is, then what it runs: the description is quiet prose and
            the command sits boxed in mono, the thing being approved. */}
        <Text weight={600}>{block.tool}</Text>
        {block.detail ? (
          <Text variant="bodySmall" tone="fg2" selectable>
            {block.detail}
          </Text>
        ) : null}
        <CodePane text={block.summary} copy={false} />
        {block.smart_denied ? (
          <Text variant="caption" tone="warn">
            Hermes' own check flagged this command.
          </Text>
        ) : null}
      </View>
      <View style={{ gap: t.space.sm }}>
        {foot}
        {state && state !== SENT && state !== GONE ? (
          <Text accessibilityRole="alert" variant="caption" tone="bad">
            {state}
          </Text>
        ) : null}
      </View>
    </SoftCard>
  );
}
