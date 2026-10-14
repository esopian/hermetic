/**
 * Conversation: the transcript (history read + this phone's observation of
 * the conversation on the box's gateway + its own turns, all through the
 * client layer's `ConversationStore`, `client.chat`), the bands that say what
 * is wrong, the composer, the session switcher and the subagent sheet. What
 * the store does not cover — a new thread, compact, an answer into another
 * session, subagent control — goes to the gateway directly (`client.gateway`).
 *
 * `?fresh=1` (the home's New chat sheet) opens a new, separate session once,
 * in place of the Bot Chat, and replaces this route with that session's.
 */
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  DroppedBand,
  ObservationBand,
  RemoteBand,
  ThreadBand,
  TurnErrorBand,
} from "../../../src/chat/Bands.tsx";
import { ChatHeader, conversationMenu } from "../../../src/chat/ChatHeader.tsx";
import { ChatScope, type ChatScopeValue } from "../../../src/chat/ChatScope.tsx";
import { Composer } from "../../../src/chat/Composer.tsx";
import { isFresh } from "../../../src/chat/new-chat.ts";
import { SessionSheet, sessionLabel } from "../../../src/chat/SessionSheet.tsx";
import { type SubagentControl, SubagentSheet } from "../../../src/chat/SubagentSheet.tsx";
import { Transcript, type TranscriptItem, transcriptItems } from "../../../src/chat/Transcript.tsx";
import { subagentsIn } from "../../../src/client/chat-activity.ts";
import { composerState, type ThreadState, threadState } from "../../../src/client/chat-logic.ts";
import { turnErrorNeedsBand } from "../../../src/client/chat-recovery.ts";
import { questionsOf } from "../../../src/client/chat-requests.ts";
import type { RespondResult } from "../../../src/client/chat-types.ts";
import type { ConversationTarget, RespondInput } from "../../../src/client/conversation-store.ts";
import { openSeparateSession } from "../../../src/client/new-session.ts";
import { markConversationRead } from "../../../src/client/read.ts";
import { useFleetContext } from "../../../src/fleet/FleetProvider.tsx";
import { useConversation, useFleetAgents, useFleetState, useRoster } from "../../../src/fleet/hooks.ts";
import { useTheme } from "../../../src/theme/theme.tsx";
import type { AvatarStatus } from "../../../src/ui/avatar/avatar-seed.ts";
import { haptic } from "../../../src/ui/haptics.ts";
import { Avatar, SkeletonRow, Text } from "../../../src/ui/index.ts";
import { useNow } from "../../../src/ui/useNow.ts";
import { useThrottled } from "../../../src/ui/useThrottled.ts";

const LIVE_THROTTLE_MS = 80;
const NO_IDS: readonly string[] = [];
const isNull = (value: unknown): boolean => value === null;

const AVATAR_STATUS: Record<ThreadState, AvatarStatus> = {
  ready: "ready",
  empty: "ready",
  bootstrapping: "pending",
  stopped: "stopped",
  destroyed: "destroyed",
  unreachable: "error",
  no_tailnet: "error",
  dropped: "degraded",
  missing: "destroyed",
};

const chatPath = (instance: string, bot: string, session: string | null) =>
  `/chat/${encodeURIComponent(instance)}/${encodeURIComponent(bot)}${session ? `?session=${encodeURIComponent(session)}` : ""}`;

export default function Conversation() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    instance: string;
    bot: string;
    session?: string;
    fresh?: string;
  }>();
  const { client, focusConversation } = useFleetContext();
  const fleetState = useFleetState();
  const agents = useFleetAgents();
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
  const [refreshing, setRefreshing] = useState(false);
  const fleetId = fleetState.link?.payload.fleet_id ?? "";
  const agent = agents.find((a) => a.name === target.instance) ?? null;
  // A new session still being opened: the Bot Chat is neither read nor watched meanwhile.
  const [freshPending, setFreshPending] = useState(() => isFresh(params.fresh) && !params.session);

  // Open: read what is missing and watch. Leave: stop watching, park the queue.
  useEffect(() => {
    if (!client || freshPending) return;
    client.chat.open(target);
    return () => client.chat.leave(target);
  }, [client, target, freshPending]);

  // False once this screen is gone: a new session opened after the operator
  // left must not replace whatever screen is in front by then.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const swarm = roster?.swarms.find((s) => s.instance === target.instance) ?? null;
  const botRow = swarm?.bots.find((b) => b.name === target.bot) ?? null;
  const botTitle = botRow?.title ?? null;
  const messages = view?.messages ?? [];
  // The streaming row redraws at most every 80 ms (`useThrottled`). The turn
  // ending (`live` gone, the reply recorded in the same change) is shown at
  // once: a stale `live` beside the recorded reply would draw it twice — a
  // failed turn's card (`failed:…`) has an id the transcript never shares.
  const live = useThrottled(view?.live ?? null, LIVE_THROTTLE_MS, isNull);
  const sending = view?.sending ?? false;
  // The store hands out a fresh `released` array with every snapshot (each
  // streamed delta); keep one identity per content so the transcript's
  // `extraData` does not change, and redraw every row, on each delta.
  const releasedKey = (view?.released ?? NO_IDS).join("\n");
  const released = useMemo(() => view?.released ?? NO_IDS, [releasedKey]);
  // The last answer is handed back so unchanged rows keep their identity and
  // the memoised rows skip a streamed delta (`transcriptItems`).
  const lastItems = useRef<TranscriptItem[]>([]);
  // A turn running on its box unfollowed: its requests cannot be answered from here.
  const remote = !!view?.remote;
  const items = useMemo(() => {
    const next = transcriptItems(messages, live, sending, now, lastItems.current, remote);
    lastItems.current = next;
    return next;
  }, [messages, live, sending, now, remote]);
  const state = threadState({
    status: agent?.status ?? null,
    reachable: swarm?.reachable ?? true,
    reconnecting: view?.reconnecting ?? false,
    empty: view?.history === "ready" && messages.length === 0 && !live,
    missing: view?.history === "failed" && view.historyCode === "NOT_FOUND",
  });
  const missing = state === "missing";
  // While a new session opens, nothing typed may land in the Bot Chat.
  const composer = freshPending
    ? { enabled: false, placeholder: "Opening a new session…" }
    : composerState(state);
  const avatarStatus = AVATAR_STATUS[state];

  // Stable props for the memoised transcript: a streaming turn re-renders this
  // screen on every delta, and a fresh element or closure here would redraw
  // the whole list each time (`Transcript` is `memo`).
  // A missing bot is the thread band's to say; the body repeats nothing.
  const historyLine = missing
    ? null
    : view?.history === "failed"
      ? `The transcript could not be read: ${view.historyError ?? "unknown error"}. Pull to retry.`
      : "Nothing said yet.";
  const empty = useMemo(
    () => (
      <View style={{ alignItems: "center", gap: t.space.md, paddingVertical: 80 }}>
        <Avatar
          fleet_id={fleetId}
          instance={target.instance}
          bot={target.bot}
          size={64}
          status={avatarStatus}
        />
        <Text variant="title">{botTitle ?? target.bot}</Text>
        {historyLine ? (
          <Text tone="fg3" variant="bodySmall" style={{ textAlign: "center", maxWidth: 260 }}>
            {historyLine}
          </Text>
        ) : null}
      </View>
    ),
    [t, fleetId, target.instance, target.bot, avatarStatus, botTitle, historyLine],
  );
  const onRefresh = useCallback(() => {
    if (!client) return;
    setRefreshing(true);
    void client.chat.reload(target).finally(() => setRefreshing(false));
  }, [client, target]);
  const session = view?.sessions.find((s) => s.id === (view.resolvedSession ?? target.session)) ?? null;
  const onCanonical = target.session === null || session?.kind === "canonical";
  // What this screen shows as read (`markConversationRead`): the Bot Chat
  // clears the bot but leaves its separate sessions' entries unread (until the
  // session list is known, it reads only its own; an entry naming a session
  // the list lacks, filed after the list was asked for, waits for the next
  // list, which opening this screen asks for); a separate session clears
  // only its own entries, by its opened or its resolved id. A `?session=` that
  // turns out to be the canonical one (a notification tap) counts as the Bot Chat.
  const separateKey =
    onCanonical && view && view.sessions.length > 0
      ? view.sessions
          .filter((s) => s.kind !== "canonical")
          .map((s) => s.id)
          .join("\n")
      : null;
  const shownSession = view?.resolvedSession ?? target.session;
  const listedAt = view?.sessionsAt ?? null;
  const readTarget = useMemo(
    () => ({
      instance: target.instance,
      bot: target.bot,
      session: onCanonical ? null : target.session,
      resolved: shownSession,
      ...(separateKey !== null
        ? { separate: separateKey ? separateKey.split("\n") : [], listedAt }
        : {}),
    }),
    [target, onCanonical, shownSession, separateKey, listedAt],
  );

  // Focused: this is the watched conversation, read at once (`setWatched`
  // applies `markConversationRead`) and never a banner. Not while a new
  // session is still opening: the Bot Chat is not this screen's thread then,
  // and a foreground re-open would watch it with nothing to leave it.
  useFocusEffect(
    useCallback(() => {
      if (!client || freshPending) return;
      client.setWatched({ ...readTarget, focused: true });
      // Back from the background, the provider re-opens this one.
      focusConversation(target);
      return () => {
        client.setWatched(null);
        focusConversation(null);
      };
    }, [client, target, readTarget, focusConversation, freshPending]),
  );

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
      if (!client) throw new Error("This phone is not paired.");
      const s = messageSession || view?.resolvedSession || target.session;
      if (!s) return client.chat.respond(target, input);
      // An answer in another session's message goes to that session.
      const result = await client.gateway.respond({
        ...input,
        instance: target.instance,
        bot: target.bot,
        session: s,
      });
      client.chat.release(target, input.request_id);
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

  // A prompt goes in even when the operator left meanwhile; only the route
  // and the haptic wait on this screen still being there.
  const openNewSession = useCallback(
    async (prompt?: string) => {
      if (!client) return;
      const opened = await openSeparateSession(client, target, prompt, () => alive.current);
      if (!opened) return;
      haptic.success();
      setSessionsOpen(false);
      router.replace(chatPath(opened.instance, opened.bot, opened.session) as never);
    },
    [client, target],
  );

  // `?fresh=1`: open the new session once. Success replaces this route; a
  // failure says so, drops the param, and leaves the Bot Chat open here.
  const freshStarted = useRef(false);
  useEffect(() => {
    if (!client || !freshPending || freshStarted.current) return;
    freshStarted.current = true;
    openNewSession().catch((e: unknown) => {
      if (!alive.current) return;
      haptic.error();
      setFreshPending(false);
      router.setParams({ fresh: undefined });
      Alert.alert("No new session", e instanceof Error ? e.message : String(e));
    });
  }, [client, freshPending, openNewSession]);

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
      retry: (prompt) => client?.chat.sendMessage(target, prompt) ?? false,
      compact: async () => {
        if (!client) return;
        await client.gateway.compact({
          instance: target.instance,
          bot: target.bot,
          ...(view?.resolvedSession ? { session: view.resolvedSession } : {}),
        });
        await client.chat.reload(target);
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
        (await client.gateway.steerSubagent({ ...where, text, subagent_id: subagentId })).status,
      stop: async () =>
        (await client.gateway.abortSubagent({ ...where, subagent_id: subagentId })).aborted,
    };
  }, [client, subagentId, target, view?.resolvedSession]);

  const [pinSignal, setPinSignal] = useState(0);
  const onSend = useCallback(
    (text: string) => {
      if (!client) return;
      setPinSignal((n) => n + 1);
      if (!client.chat.sendMessage(target, text)) client.chat.enqueue(target, text);
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
        setPinSignal((n) => n + 1);
        const outcome = await client.chat.sendNow(target, text, queuedId ?? null);
        if (outcome === "redirected" || outcome === "queued" || outcome === "sent") haptic.success();
        else if (outcome === "refused") {
          haptic.error();
          if (!queuedId) setDraft(text);
        } else haptic.warning();
      })();
    },
    [client, target, openQuestion, respond, live?.session],
  );

  const title = botTitle ?? target.bot;
  const onBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, []);
  const onSessions = useCallback(() => setSessionsOpen(true), []);
  const onMore = useCallback(
    () =>
      conversationMenu(title, t.c.fg, {
        sessions: () => setSessionsOpen(true),
        browser: () => router.push(`/agent/${encodeURIComponent(target.instance)}`),
        markRead: () => {
          if (!client) return;
          haptic.success();
          markConversationRead(client, readTarget);
        },
      }),
    [title, t.c.fg, client, target, readTarget],
  );

  const loading =
    freshPending || !view || (view.history === "loading" && messages.length === 0 && !live);

  return (
    <ChatScope.Provider value={scope}>
      <View style={{ flex: 1, backgroundColor: t.c.bg }}>
        {/* The title is what VoiceOver reads on a pushed screen's back button. */}
        <Stack.Screen options={{ headerShown: false, title }} />
        <ChatHeader
          fleetId={fleetId}
          instance={target.instance}
          bot={target.bot}
          title={title}
          session={freshPending ? "New session" : onCanonical ? null : sessionLabel(session)}
          status={avatarStatus}
          activity={view?.activity ?? "idle"}
          onBack={onBack}
          onSessions={onSessions}
          onMore={onMore}
        />
        <ThreadBand
          state={state}
          instance={target.instance}
          bot={target.bot}
          session={target.session}
          reconnectAttempt={view?.reconnectAttempt ?? 0}
        />
        {/* The watch on a missing bot only retries; the thread band already says why. */}
        {view && !missing && !freshPending ? (
          <ObservationBand
            state={view.observe}
            error={view.observeError}
            onResume={() => {
              client?.chat.leave(target);
              client?.chat.open(target);
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
            released={released}
            refreshing={refreshing}
            pinSignal={pinSignal}
            onRefresh={onRefresh}
            empty={empty}
          />
        )}
        {/* Opened, the home-indicator inset sinks under the keyboard; a small margin stays. */}
        <KeyboardStickyView
          offset={{ closed: 0, opened: Math.max(insets.bottom, t.space.sm) - t.space.sm }}
        >
          {view?.turnError && !missing && turnErrorNeedsBand(messages, view.live) ? (
            <TurnErrorBand error={view.turnError} />
          ) : null}
          {/* A turn that ended on an error already has its card (or the band above). */}
          {view?.dropped && !view.turnError && !sending && !missing ? <DroppedBand /> : null}
          <RemoteBand remote={view?.remote ?? null} />
          <View
            style={{
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: t.c.line,
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
              onQueue={(text) => client?.chat.enqueue(target, text)}
              onSendNow={onSendNow}
              onStop={() => void client?.chat.stop(target)}
              onUnqueue={(id) => client?.chat.unqueue(target, id)}
            />
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
