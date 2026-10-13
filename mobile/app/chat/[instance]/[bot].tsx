/**
 * Conversation (placeholder for the next phase): transcript + live reply,
 * composer that sends, queues while a turn runs, and stops. Blocks render as
 * plain text here; the block renderers are the next phase.
 */
import { FlashList } from "@shopify/flash-list";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { TextInput, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useBridge } from "../../../src/bridge/BridgeProvider.tsx";
import { useConversation } from "../../../src/bridge/hooks.ts";
import type { ConversationTarget } from "../../../src/client/conversation-store.ts";
import type { ChatMessage } from "../../../src/protocol/types.ts";
import { useTheme } from "../../../src/theme/theme.tsx";
import { Avatar, Button, Kicker, SkeletonRow, Text } from "../../../src/ui/index.ts";

function plain(message: ChatMessage): string {
  return message.blocks
    .map((b) => {
      if (b.kind === "text") return b.markdown;
      if (b.kind === "tool") return `⚙ ${b.name} · ${b.status}`;
      if (b.kind === "approval") return `⚠ approval: ${b.summary}`;
      if (b.kind === "question") return `? ${b.prompt}`;
      if (b.kind === "reasoning") return "… thinking";
      if (b.kind === "subagent") return `↳ ${b.goal} · ${b.verdict}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export default function Conversation() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ instance: string; bot: string; session?: string }>();
  const { client, credentials } = useBridge();
  const target = useMemo<ConversationTarget>(
    () => ({
      instance: String(params.instance),
      bot: String(params.bot),
      session: params.session ? String(params.session) : null,
    }),
    [params.instance, params.bot, params.session],
  );
  const view = useConversation(target);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!client) return;
    client.conversations.open(target);
    client.setWatched({ instance: target.instance, bot: target.bot, focused: true });
    void client.inbox.ackThread(target.instance, target.bot);
    return () => {
      client.conversations.leave(target);
      client.setWatched(null);
    };
  }, [client, target]);

  const rows = useMemo(() => {
    const list = [...(view?.messages ?? [])];
    if (view?.live) list.push(view.live);
    return list;
  }, [view?.messages, view?.live]);

  const submit = () => {
    if (!client || !draft.trim()) return;
    if (view?.sending) client.conversations.enqueue(target, draft);
    else client.conversations.sendMessage(target, draft);
    setDraft("");
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
              <Avatar
                fleet_id={credentials?.fleet.fleet_id ?? ""}
                instance={target.instance}
                bot={target.bot}
                size={24}
                activity={view?.activity === "idle" || !view ? "idle" : view.activity}
              />
              <Text weight={800}>{target.bot}</Text>
              <Text mono tone="fg3" variant="caption">
                {target.instance}
              </Text>
            </View>
          ),
          headerRight: () =>
            view?.sending ? (
              <Button
                label="Stop"
                variant="destructive"
                compact
                onPress={() => void client?.conversations.stop(target)}
              />
            ) : null,
        }}
      />
      {view?.history === "loading" && rows.length === 0 ? (
        <View>
          {[0, 1, 2].map((i) => (
            <SkeletonRow key={i} />
          ))}
        </View>
      ) : (
        <FlashList
          data={rows}
          maintainVisibleContentPosition={{
            startRenderingFromBottom: true,
            autoscrollToBottomThreshold: 0.2,
          }}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: t.space.lg }}
          renderItem={({ item }) => (
            <View
              style={{
                alignSelf: item.role === "user" ? "flex-end" : "stretch",
                maxWidth: item.role === "user" ? "85%" : "100%",
                marginVertical: t.space.xs,
                padding: t.space.md,
                backgroundColor: item.role === "user" ? t.c.bg3 : "transparent",
                borderLeftWidth: item.role === "user" ? 0 : t.border.control,
                borderLeftColor: item.failure ? t.c.bad : t.c.line2,
              }}
            >
              <Text selectable>{plain(item) || " "}</Text>
              {item.failure ? (
                <Text variant="caption" mono tone="bad">
                  {item.failure.code}: {item.failure.message}
                </Text>
              ) : null}
            </View>
          )}
        />
      )}
      <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
        <View
          style={{
            borderTopWidth: t.border.control,
            borderTopColor: t.c.fg,
            backgroundColor: t.c.bg,
            padding: t.space.sm,
            paddingBottom: Math.max(insets.bottom, t.space.sm),
            gap: t.space.xs,
          }}
        >
          {view && view.queue.length > 0 ? (
            <Kicker tone={view.queueParked ? "warn" : "fg3"}>
              {view.queue.length} queued{view.queueParked ? " · parked" : ""}
            </Kicker>
          ) : null}
          {view?.turnError ? (
            <Text variant="caption" mono tone="bad">
              {view.turnError.code}: {view.turnError.message}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: t.space.sm, alignItems: "flex-end" }}>
            <TextInput
              accessibilityLabel="Message"
              value={draft}
              onChangeText={setDraft}
              placeholder={`Message ${target.bot}`}
              placeholderTextColor={t.c.fg3}
              multiline
              style={{
                flex: 1,
                maxHeight: 140,
                minHeight: t.touch.min,
                color: t.c.fg,
                fontFamily: t.sans(400),
                fontSize: 15,
                paddingHorizontal: t.space.md,
                paddingTop: 12,
                borderWidth: t.border.control,
                borderColor: t.c.line2,
                borderRadius: 0,
              }}
            />
            <Button
              label={view?.sending ? "Queue" : "Send"}
              disabled={!draft.trim()}
              onPress={submit}
            />
          </View>
        </View>
      </KeyboardStickyView>
    </View>
  );
}
