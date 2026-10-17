/**
 * A bot-to-bot DM the turn sent (`message_agent`), as one compact line
 * between the turn's prose instead of a tool step (desktop `BotDm.tsx`,
 * `DmSentMarker`): "→ <face> <bot>: <message>", "Messaging" while the call
 * runs, and upstream's own sentence when it refused or could not confirm the
 * hand-off. The phone opens no exchange view; the reply arrives as a
 * notification in the thread like any other.
 */
import type { ToolBlock } from "@hermetic/core/chat-client";
import { View } from "react-native";
import type { MessageAgentLine } from "../../client/message-agent.ts";
import { useTheme } from "../../theme/theme.tsx";
import { Avatar } from "../../ui/avatar/Avatar.tsx";
import { Text } from "../../ui/Text.tsx";
import { useChatScope } from "../ChatScope.tsx";
import { ToolBlock as ToolCard } from "./Tool.tsx";

const LEAD: Record<MessageAgentLine["state"], string> = {
  pending: "→ Messaging",
  sent: "→",
  ambiguous: "→ May not have reached",
  failed: "✕ Couldn't message",
};

const SPOKEN: Record<MessageAgentLine["state"], string> = {
  pending: "Messaging",
  sent: "Messaged",
  ambiguous: "May not have reached",
  failed: "Couldn't message",
};

export function DmLine({ line, block }: { line: MessageAgentLine | null; block: ToolBlock }) {
  const t = useTheme();
  const scope = useChatScope();
  if (!line) return <ToolCard block={block} />;
  const trouble = line.state === "failed" || line.state === "ambiguous";
  const tone = line.state === "failed" ? t.c.bad : line.state === "ambiguous" ? t.c.warn : t.c.line2;
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`${SPOKEN[line.state]} ${line.bot}: ${line.message}`}
      testID="dm-line"
      style={{
        borderLeftWidth: t.border.control,
        borderLeftColor: tone,
        paddingLeft: t.space.sm,
        paddingVertical: 2,
        marginVertical: t.space.xs,
        gap: 2,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.xs }}>
        <Text mono variant="caption" tone={line.state === "failed" ? "bad" : trouble ? "warn" : "fg3"}>
          {LEAD[line.state]}
        </Text>
        {scope ? (
          <Avatar
            fleet_id={scope.fleetId}
            instance={scope.instance}
            bot={line.bot}
            size={16}
            activity={line.state === "pending" ? "thinking" : "idle"}
          />
        ) : null}
        <Text weight={700} variant="bodySmall" numberOfLines={1} style={{ flexShrink: 1 }}>
          {`${line.bot}:`}
        </Text>
      </View>
      <Text variant="bodySmall" tone="fg2" numberOfLines={3}>
        {line.message}
      </Text>
      {trouble && line.error ? (
        <Text variant="caption" tone="fg3" numberOfLines={3}>
          {line.error}
        </Text>
      ) : null}
    </View>
  );
}
