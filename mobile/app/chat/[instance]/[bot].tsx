/**
 * Conversation: the transcript (history read + the bridge's observation of
 * this conversation + this phone's own turns, all through the client
 * layer's `ConversationStore`), the bands that say what is wrong, the
 * composer, the session switcher and the subagent sheet.
 */
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useBridge } from "../../../src/bridge/BridgeProvider.tsx";
import { useConversation, useRoster } from "../../../src/bridge/hooks.ts";
import {
  DroppedBand,
  ObservationBand,
  SocketBand,
  ThreadBand,
  TurnErrorBand,
} from "../../../src/chat/Bands.tsx";
import { ChatScope, type ChatScopeValue } from "../../../src/chat/ChatScope.tsx";
import { Composer } from "../../../src/chat/Composer.tsx";
import { SessionSheet, sessionLabel } from "../../../src/chat/SessionSheet.tsx";
import { type SubagentControl, SubagentSheet } from "../../../src/chat/SubagentSheet.tsx";
import { Transcript, transcriptItems } from "../../../src/chat/Transcript.tsx";
import { subagentsIn } from "../../../src/client/chat-activity.ts";
import { composerState, type ThreadState, threadState } from "../../../src/client/chat-logic.ts";
import { questionsOf } from "../../../src/client/chat-requests.ts";
import type { ConversationTarget, RespondInput } from "../../../src/client/conversation-store.ts";
import type {
  AbortResult,
  AgentView,
  ChatConversation,
  RespondResult,
  SteerResult,
} from "../../../src/protocol/types.ts";
import { useTheme } from "../../../src/theme/theme.tsx";
import type { AvatarStatus } from "../../../src/ui/avatar/avatar-seed.ts";
import { haptic } from "../../../src/ui/haptics.ts";
import { Avatar, Kicker, SkeletonRow, Text } from "../../../src/ui/index.ts";
import { useNow } from "../../../src/ui/useNow.ts";

const AVATAR_STATUS: Record<ThreadState, AvatarStatus> = {
  ready: "ready",
  empty: "ready",
  bootstrapping: "pending",
  stopped: "stopped",
  destroyed: "destroyed",
  unreachable: "error",
  no_tailnet: "error",
  dropped: "degraded",
};

const chatPath = (instance: string, bot: string, session: string | null) =>
  `/chat/${encodeURIComponent(instance)}/${encodeURIComponent(bot)}${session ? `?session=${encodeURIComponent(session)}` : ""}`;

export default function Conversation() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ instance: string; bot: string; session?: string }>();
  const { client, credentials, socketState, reconnect, servedFleet, rePair } = useBridge();
  const { state: roster } = useRoster();
  const now = useNow();
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
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [subagentId, setSubagentId] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentView | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const fleetId = credentials?.fleet.fleet_id ?? "";

  // Open: read what is missing and watch. Leave: stop watching, park the queue.
  useEffect(() => {
    if (!client) return;
    client.conversations.open(target);
    return () => client.conversations.leave(target);
  }, [client, target]);

  // Focused: this is the watched thread (no banners for it), and its unread clears.
  useFocusEffect(
    useCallback(() => {
      if (!client) return;
      client.setWatched({ instance: target.instance, bot: target.bot, focused: true });
      client.roster.markSeen(target.instance, target.bot);
      void client.inbox.ackThread(target.instance, target.bot);
      return () => client.setWatched(null);
    }, [client, target.instance, target.bot]),
  );

  useEffect(() => {
    if (!client) return;
    let live = true;
    client
      .rpc<AgentView>("agents.get", { name: target.instance })
      .then((a) => live && setAgent(a))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client, target.instance]);

  const swarm = roster?.swarms.find((s) => s.instance === target.instance) ?? null;
  const botRow = swarm?.bots.find((b) => b.name === target.bot) ?? null;
  const botTitle = botRow?.title ?? null;
  const messages = view?.messages ?? [];
  const live = view?.live ?? null;
  const sending = view?.sending ?? false;
  const items = useMemo(
    () => transcriptItems(messages, live, sending, now),
    [messages, live, sending, now],
  );
  const state = threadState({
    status: agent?.display_status ?? null,
    reachable: swarm?.reachable ?? true,
    reconnecting: view?.reconnecting ?? false,
    empty: view?.history === "ready" && messages.length === 0 && !live,
  });
  const composer = composerState(state);
  const avatarStatus = AVATAR_STATUS[state];
  const session = view?.sessions.find((s) => s.id === (view.resolvedSession ?? target.session)) ?? null;
  const onCanonical = target.session === null || session?.kind === "canonical";

  // A clarify still open in the running turn: "Send now" skips it before steering.
  const openQuestion = useMemo(() => {
    if (!live || !view) return null;
    for (const block of live.blocks)
      if (block.kind === "question" && block.request_id && view.openRequests.includes(block.request_id))
        return block;
    return null;
  }, [live, view]);

  const respond = useCallback(
    async (input: RespondInput, messageSession: string | null): Promise<RespondResult> => {
      if (!client) throw new Error("Not connected to a bridge.");
      const s = messageSession || view?.resolvedSession || target.session;
      if (!s) return client.conversations.respond(target, input);
      const result = await client.rpc<RespondResult>("chat.respond", {
        ...input,
        instance: target.instance,
        bot: target.bot,
        session: s,
      });
      client.conversations.release(target, input.request_id);
      return result;
    },
    [client, target, view?.resolvedSession],
  );

  const goSession = useCallback(
    (next: string | null) => {
      setSessionsOpen(false);
      if ((next ?? null) === target.session) return;
      router.replace(chatPath(target.instance, target.bot, next) as never);
    },
    [target],
  );

  const openNewSession = useCallback(
    async (prompt?: string) => {
      if (!client) return;
      const opened = await client.rpc<ChatConversation>("chat.open", {
        instance: target.instance,
        bot: target.bot,
        new_session: true,
      });
      haptic.success();
      setSessionsOpen(false);
      if (prompt) {
        const next = { instance: opened.instance, bot: opened.bot, session: opened.session };
        client.conversations.open(next);
        client.conversations.sendMessage(next, prompt);
      }
      router.replace(chatPath(opened.instance, opened.bot, opened.session) as never);
    },
    [client, target],
  );

  const scope = useMemo<ChatScopeValue>(
    () => ({
      fleetId,
      instance: target.instance,
      bot: target.bot,
      now,
      sending,
      released: view?.released ?? [],
      messages: live ? [...messages, live] : messages,
      respond,
      openSubagent: setSubagentId,
      draft: (text) => {
        haptic.select();
        setDraft(text);
      },
      retry: (prompt) => client?.conversations.sendMessage(target, prompt) ?? false,
      compact: async () => {
        if (!client) return;
        await client.rpc("chat.compact", {
          instance: target.instance,
          bot: target.bot,
          ...(view?.resolvedSession ? { session: view.resolvedSession } : {}),
        });
        await client.conversations.reload(target);
      },
      newSession: (prompt) => openNewSession(prompt),
    }),
    [
      fleetId,
      target,
      now,
      sending,
      view?.released,
      view?.resolvedSession,
      messages,
      live,
      respond,
      client,
      openNewSession,
    ],
  );

  const subagent = useMemo(() => {
    if (!subagentId) return null;
    return subagentsIn(live ? [...messages, live] : messages).get(subagentId) ?? null;
  }, [subagentId, messages, live]);

  const subagentControl = useMemo<SubagentControl | null>(() => {
    if (!client || !subagentId) return null;
    const where = {
      instance: target.instance,
      bot: target.bot,
      ...(view?.resolvedSession ? { session: view.resolvedSession } : {}),
    };
    return {
      steer: async (text) =>
        (await client.rpc<SteerResult>("chat.steer", { ...where, text, subagent_id: subagentId }))
          .status,
      stop: async () =>
        (await client.rpc<AbortResult>("chat.abort", { ...where, subagent_id: subagentId })).aborted,
    };
  }, [client, subagentId, target, view?.resolvedSession]);

  const onSend = useCallback(
    (text: string) => {
      if (!client) return;
      if (!client.conversations.sendMessage(target, text)) client.conversations.enqueue(target, text);
    },
    [client, target],
  );

  const onSendNow = useCallback(
    (text: string, queuedId?: string) => {
      if (!client) return;
      void (async () => {
        // A steer queues behind a blocked clarify and would never land: decline it first.
        if (openQuestion?.request_id) {
          await respond(
            { request_id: openQuestion.request_id, kind: "question", skip: true },
            live?.session ?? null,
          ).catch(() => null);
        }
        const outcome = await client.conversations.sendNow(target, text, queuedId ?? null);
        if (outcome === "redirected" || outcome === "queued" || outcome === "sent") haptic.success();
        else if (outcome === "refused") {
          haptic.error();
          if (!queuedId) setDraft(text);
        } else haptic.warning();
      })();
    },
    [client, target, openQuestion, respond, live?.session],
  );

  const headerTitle = useCallback(
    () => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${botTitle ?? target.bot}, ${sessionLabel(session)}. Switch session`}
        onPress={() => {
          haptic.select();
          setSessionsOpen(true);
        }}
        style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, maxWidth: 240 }}
      >
        <Avatar
          fleet_id={fleetId}
          instance={target.instance}
          bot={target.bot}
          size={28}
          status={avatarStatus}
          activity={view?.activity === "idle" || !view ? "idle" : view.activity}
        />
        <View style={{ flexShrink: 1 }}>
          <Text weight={800} variant="bodySmall" numberOfLines={1}>
            {botTitle ?? target.bot}
          </Text>
          <Text mono variant="caption" tone={onCanonical ? "fg3" : "acc"} numberOfLines={1}>
            {`${target.instance} · ${onCanonical ? "Bot Chat" : sessionLabel(session)} ▾`}
          </Text>
        </View>
      </Pressable>
    ),
    [t, fleetId, target, botTitle, session, onCanonical, avatarStatus, view],
  );

  // One Stop, in the composer (iMessage-style). The header keeps only the
  // browser button; the avatar's activity ring and the composer's footer say a
  // turn is running.
  const headerRight = useCallback(
    () => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open browser"
        onPress={() => router.push(`/agent/${encodeURIComponent(target.instance)}`)}
        style={{
          minWidth: t.touch.min,
          minHeight: t.touch.min,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text mono weight={700}>
          ◫
        </Text>
      </Pressable>
    ),
    [t, target],
  );

  const loading = !view || (view.history === "loading" && messages.length === 0 && !live);

  return (
    <ChatScope.Provider value={scope}>
      {/* A hairline under the opaque header: the transcript scrolls up to it, not under it. */}
      <View
        style={{
          flex: 1,
          backgroundColor: t.c.bg,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: t.c.line2,
        }}
      >
        <Stack.Screen options={{ headerTitle, headerRight, title: botTitle ?? target.bot }} />
        <SocketBand
          state={socketState}
          onRetry={reconnect}
          servedFleet={servedFleet}
          pairedFleet={credentials?.fleet ?? null}
          onRePair={() => void rePair()}
        />
        <ThreadBand
          state={state}
          instance={target.instance}
          reconnectAttempt={view?.reconnectAttempt ?? 0}
        />
        {view ? (
          <ObservationBand
            state={view.observe}
            error={view.observeError}
            onResume={() => {
              client?.conversations.leave(target);
              client?.conversations.open(target);
            }}
          />
        ) : null}
        {view?.rolledOverFrom ? (
          <Text
            mono
            variant="caption"
            tone="fg3"
            style={{ paddingHorizontal: t.space.lg, paddingTop: t.space.xs }}
          >
            This conversation moved to a new session; earlier messages are in the session list.
          </Text>
        ) : null}
        {loading ? (
          <View style={{ flex: 1, justifyContent: "flex-end", paddingBottom: t.space.lg }}>
            {[0, 1, 2, 3].map((i) => (
              <SkeletonRow key={i} />
            ))}
          </View>
        ) : (
          <Transcript
            items={items}
            fleetId={fleetId}
            instance={target.instance}
            bot={target.bot}
            botTitle={botTitle}
            status={avatarStatus}
            now={now}
            activity={view?.activity ?? "idle"}
            released={view?.released ?? []}
            refreshing={refreshing}
            onRefresh={() => {
              if (!client) return;
              setRefreshing(true);
              void client.conversations.reload(target).finally(() => setRefreshing(false));
            }}
            empty={
              <View style={{ alignItems: "center", gap: t.space.md, paddingVertical: 80 }}>
                <Avatar
                  fleet_id={fleetId}
                  instance={target.instance}
                  bot={target.bot}
                  size={64}
                  status={avatarStatus}
                />
                <Text variant="title">{botTitle ?? target.bot}</Text>
                <Text tone="fg3" variant="bodySmall" style={{ textAlign: "center", maxWidth: 260 }}>
                  {view?.history === "failed"
                    ? `The transcript could not be read: ${view.historyError ?? "unknown error"}. Pull to retry.`
                    : "Nothing said yet."}
                </Text>
              </View>
            }
          />
        )}
        <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
          {view?.turnError ? <TurnErrorBand error={view.turnError} /> : null}
          {view?.dropped && !sending ? <DroppedBand truncated={view.truncated} /> : null}
          <View
            style={{
              borderTopWidth: t.border.control,
              borderTopColor: t.c.fg,
              backgroundColor: t.c.bg,
              paddingHorizontal: t.space.sm,
              paddingTop: t.space.sm,
              paddingBottom: Math.max(insets.bottom, t.space.sm),
            }}
          >
            <Composer
              draft={draft}
              onDraft={setDraft}
              enabled={composer.enabled}
              placeholder={composer.placeholder}
              sending={sending}
              aborting={view?.aborting ?? false}
              queue={view?.queue ?? []}
              parked={view?.queueParked ?? false}
              questionOpen={!!openQuestion && questionsOf(openQuestion).length > 0}
              onSend={onSend}
              onQueue={(text) => client?.conversations.enqueue(target, text)}
              onSendNow={onSendNow}
              onStop={() => void client?.conversations.stop(target)}
              onUnqueue={(id) => client?.conversations.unqueue(target, id)}
            />
            {!sending && !composer.enabled ? null : (
              <Kicker tone={sending ? "acc" : "fg3"} style={{ marginTop: t.space.xs, fontSize: 9 }}>
                {`${sending ? (view?.aborting ? "stopping…" : "turn in flight") : "over the bridge"} · ${onCanonical ? "Bot Chat" : sessionLabel(session)}`}
              </Kicker>
            )}
          </View>
        </KeyboardStickyView>
        <SessionSheet
          visible={sessionsOpen}
          sessions={view?.sessions ?? []}
          current={onCanonical ? null : (view?.resolvedSession ?? target.session)}
          now={now}
          onSelect={goSession}
          onNew={() => openNewSession()}
          onClose={() => setSessionsOpen(false)}
        />
        {subagentId ? (
          <SubagentSheet
            block={subagent}
            control={subagentControl}
            onClose={() => setSubagentId(null)}
          />
        ) : null}
      </View>
    </ChatScope.Provider>
  );
}
