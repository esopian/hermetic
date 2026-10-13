/**
 * `approval` — the agent stopped and is waiting on you (desktop
 * `blocks/Approval.tsx` + `ApprovalActions.tsx`). The loudest card on screen:
 * warn seam, warn-filled head, never collapsed. The buttons are exactly
 * `block.choices` in the gateway's order with the desktop's labels; "Always
 * allow" persists a pattern on the box, so it takes an inline confirm naming
 * the pattern and the command. Expired, it says so; closed by the box, it says
 * the command was not run; answered here, it says what was sent.
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
} from "../../client/chat-requests.ts";
import type { ApprovalBlock, ApprovalChoice } from "../../protocol/types.ts";
import { useTheme } from "../../theme/theme.tsx";
import { Button } from "../../ui/Button.tsx";
import { haptic } from "../../ui/haptics.ts";
import { Text } from "../../ui/Text.tsx";
import { CodePane } from "../CodePane.tsx";
import { useSubmit } from "./respond.ts";

export function ApprovalCard({
  block,
  now,
  closed,
  pending = 0,
  session,
  released = false,
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
            style={{ flex: 1 }}
            onPress={() => setConfirming(false)}
          />
          <Button label="Always allow" disabled={busy} style={{ flex: 1 }} onPress={always} />
        </View>
      </View>
    );
  else
    foot = (
      <View style={{ gap: t.space.sm }}>
        {pending > 1 ? (
          <Text mono variant="caption" tone="warn">{`${pending} approvals pending`}</Text>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
          {offeredChoices(block).map((choice) => (
            <Button
              key={choice}
              label={APPROVAL_LABEL[choice]}
              variant={choice === "deny" ? "destructive" : choice === "once" ? "primary" : "secondary"}
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

  return (
    <View
      testID={`approval-${request_id ?? "none"}`}
      style={{ borderWidth: t.border.control, borderColor: t.c.warn, marginVertical: t.space.xs }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: t.c.warn,
          paddingHorizontal: t.space.md,
          paddingVertical: 6,
        }}
      >
        <Text
          weight={800}
          variant="caption"
          uppercase
          style={{ color: t.c.bg, letterSpacing: 1, flex: 1 }}
        >
          ⚑ Approval required
        </Text>
        {block.expires_at && !closed ? (
          <Text mono variant="caption" style={{ color: t.c.bg }}>
            {`expires ${railTime(block.expires_at, now)}`}
          </Text>
        ) : null}
      </View>
      <View style={{ padding: t.space.md, gap: t.space.sm, backgroundColor: t.c.bg2 }}>
        <Text weight={800}>{block.tool}</Text>
        <Text mono variant="bodySmall" selectable>
          {block.summary}
        </Text>
        {block.detail ? <CodePane text={block.detail} copy={false} /> : null}
        {block.smart_denied ? (
          <Text variant="caption" tone="warn">
            Hermes' own check flagged this command.
          </Text>
        ) : null}
      </View>
      <View
        style={{
          padding: t.space.md,
          borderTopWidth: 1,
          borderTopColor: t.c.line,
          backgroundColor: t.c.bg2,
          gap: t.space.sm,
        }}
      >
        {foot}
        {state && state !== SENT && state !== GONE ? (
          <Text accessibilityRole="alert" variant="caption" tone="bad">
            {state}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
