import { useCallback, useEffect, useState, useRef } from "react";
import { useChat } from "../chat-state.tsx";
import { useFleetIfAvailable } from "../../state/state.tsx";
import { useListeningIfAvailable } from "../../state/listening-state.tsx";
import { threadState } from "../chat-logic.ts";
import { chatHash } from "../chat-routing.ts";
import { hasOpenOverlay } from "../../lib/focus.ts";
import { isVisible } from "../../lib/visibility.ts";
import {
  botsCreate,
  botsGet,
  botsUpdate,
  botsDelete,
  chatOpen,
  chatCompact,
  chatArchive,
  chatRespond,
  roomsCreate,
} from "../../api/index.ts";
import type { BotProfileView, RoomView } from "../../api/index.ts";
import type { AvatarStatus } from "./avatar/Avatar.tsx";
import { BotRail } from "./BotRail.tsx";
import { Thread, NoRoute } from "./Thread.tsx";
import { ScheduledJobs } from "./ScheduledJobs.tsx";
import { RoomConversation } from "./RoomConversation.tsx";
import type { PendingSend } from "./RoomConversation.tsx";
import { BotModeDialog, BotField } from "./BotModeDialog.tsx";
import { BotCreateDialog, RoomCreateDialog } from "./BotModeCreate.tsx";
import { BotResponses } from "./BotResponses.tsx";
import { Context } from "./Context.tsx";

export function BotWorkspace({
  withContext = true,
  roomPollMs,
  returnReadMinAgeMs,
}: {
  withContext?: boolean;
  /** Test seams; production callers use RoomConversation's defaults. */
  roomPollMs?: number;
  returnReadMinAgeMs?: number;
}) {
  const roomDrafts = useRef(new Map<string, string>());
  /**
   * The submission each room is waiting on, by room, beside its draft and for
   * the same reason: `RoomConversation` unmounts on a room switch, and a send
   * whose answer was lost must keep its `event_id` across that so a retry is a
   * retry rather than a second message.
   */
  const roomPending = useRef(new Map<string, PendingSend>());
  const chat = useChat(),
    fleet = useFleetIfAvailable(),
    listening = useListeningIfAvailable(),
    selection = chat.selection;
  const [room, setRoom] = useState<RoomView | null>(null),
    [dialog, setDialog] = useState<"bot" | "profile" | "room" | "archive" | "delete" | null>(null),
    [profile, setProfile] = useState<BotProfileView | null>(null),
    [error, setError] = useState(""),
    [context, setContext] = useState(false),
    [panel, setPanel] = useState<"jobs" | null>(null);
  const fleetId = fleet?.meta?.config?.fleet_id ?? "",
    swarm = chat.swarms.find((s) => s.instance === selection?.instance),
    bot = swarm?.bots.find((b) => b.name === selection?.bot),
    agent = selection ? (fleet?.byName.get(selection.instance) ?? null) : null;
  useEffect(() => {
    setRoom(null);
  }, [selection?.instance, selection?.bot, selection?.session]);
  const statusOf = useCallback(
    (name: string): AvatarStatus => {
      const status = fleet?.byName.get(name)?.display_status;
      return status === "ready" || status === "degraded" || status === "error" || status === "destroyed"
        ? status
        : status === "stopped" || status === "stopping"
          ? "stopped"
          : "pending";
    },
    [fleet],
  );
  const state = threadState({
    status: agent?.display_status ?? null,
    reachable: swarm?.reachable ?? true,
    reconnecting: chat.reconnecting,
    empty: chat.historyRead && chat.messages.length === 0 && !chat.live,
    fleetUnreachable: chat.offTailnet,
  });
  useEffect(() => {
    if (room && listening && !listening.instances.includes(room.instance)) setRoom(null);
  }, [listening, room]);
  /**
   * Escape closes the open side panel and stops there.
   *
   * The panel is a `bm-show-*` class on this element, not a focus trap, so
   * `hasOpenOverlay()` does not report it and the shell's own Escape handlers
   * ran as well: in a narrow window, dismissing the Members panel also closed the
   * chat view and left the operator on Fleet. `App`'s handler checks
   * `defaultPrevented` before it acts, so `preventDefault` is what stops it;
   * `stopImmediatePropagation` stops a second window listener in the same
   * phase, and the capture phase puts this ahead of the shell's own.
   *
   * Two things are deliberately left alone. A Bot Mode dialog owns Escape while
   * it is open and closes on its own window listener rather than through the
   * shared focus stack, so it is looked for in the DOM instead of assumed
   * absent. And with no panel open this handler does nothing at all, so Escape
   * keeps whatever meaning the shell already gives it.
   *
   * Registered once, reading the panel through a ref: re-registering on every
   * panel change would move this listener behind handlers mounted earlier.
   */
  const openPanel = useRef(panel);
  openPanel.current = panel;
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (openPanel.current === null) return;
      if (hasOpenOverlay() || document.querySelector(".bm-overlay") !== null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setPanel(null);
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, []);
  /**
   * A named session is the one conversation nothing is watching (§9.2).
   *
   * The fan-in (`GET /api/chat/stream`) carries the conversations the server
   * *owns* — the canonical conversation of every bot on a listened instance —
   * so a canonical thread is now told about a message from Hermes Desktop, the
   * CLI or a routine as it happens, and a tick here would only re-read what it
   * has already been handed. A named session is not owned, so it is still read
   * on a tick while it is the thread on screen.
   *
   * Two things this tick is deliberately not. It is not a *pair* of reads: it
   * asks for the transcript alone (`reloadTranscript`), because a bot's list of
   * conversations does not change because five seconds went by, and pairing
   * them put a second gateway read on the tailnet for every tick. And it is not
   * re-armed by a render: everything it consults is read through a ref at the
   * moment it fires, so a sending flag or a prop rebuilt upstream cannot
   * restart the interval — which is how a five-second poll becomes a faster one
   * in a tree that re-renders on a fleet event.
   */
  const named = selection?.session ?? null;
  // The cadence comes from the store (`ChatTiming`) rather than from a literal
  // here, so that a test can measure this poll without faking a clock.
  const { transcriptTickMs: tickMs, setInterval: armInterval } = chat.timing;
  const tick = useRef({ room, sending: chat.sending, reload: chat.reloadTranscript });
  tick.current = { room, sending: chat.sending, reload: chat.reloadTranscript };
  useEffect(() => {
    if (!named) return;
    return armInterval(() => {
      const { room: open, sending, reload } = tick.current;
      if (open || sending || !isVisible()) return;
      void reload();
    }, tickMs);
  }, [named, tickMs, armInterval]);
  function select(instance: string, bot: string, session: string | null = null) {
    setRoom(null);
    setPanel(null);
    setError("");
    if (chat.select(instance, bot, session))
      window.location.hash = chatHash({ instance, bot, session });
  }
  async function act(work: () => Promise<void>) {
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function editProfile() {
    if (!selection) return;
    const result = await botsGet({ instance: selection.instance, bot: selection.bot });
    setProfile(result);
    setDialog("profile");
  }
  return (
    <div
      className={`ch-body${withContext ? " with-context" : ""} bm-workspace${panel ? ` bm-show-${panel}` : ""}`}
      data-skin="soft"
    >
      <BotRail
        swarms={chat.swarms}
        sessions={chat.sessions}
        selection={selection}
        room={room}
        fleetId={fleetId}
        now={chat.now}
        query={chat.query}
        onQuery={chat.setQuery}
        onSelect={select}
        onRoom={(r) => {
          setRoom(r);
          setPanel(null);
        }}
        onCreateBot={() => setDialog("bot")}
        onCreateRoom={() => setDialog("room")}
        onNewSession={() =>
          void act(async () => {
            if (selection) {
              const opened = await chatOpen({
                instance: selection.instance,
                bot: selection.bot,
                new_session: true,
              });
              select(opened.instance, opened.bot, opened.session);
            }
          })
        }
        statusOf={statusOf}
        activities={chat.turnActivities}
        canonicalId={chat.sessions.find((s) => s.kind === "canonical")?.id}
      />
      <div className="bm-narrow-actions">
        <button
          type="button"
          className="btn-mini"
          onClick={() => setPanel(panel === "jobs" ? null : "jobs")}
        >
          {room ? "Members" : "Scheduled jobs"}
        </button>
      </div>
      {room ? (
        <RoomConversation
          key={`${room.instance}/${room.id}`}
          instance={room.instance}
          id={room.id}
          pollMs={roomPollMs}
          returnReadMinAgeMs={returnReadMinAgeMs}
          initialDraft={roomDrafts.current.get(`${room.instance}/${room.id}`) ?? ""}
          onDraft={(text) => roomDrafts.current.set(`${room.instance}/${room.id}`, text)}
          initialPending={roomPending.current.get(`${room.instance}/${room.id}`) ?? null}
          onPending={(entry) => {
            const key = `${room.instance}/${room.id}`;
            if (entry) roomPending.current.set(key, entry);
            else roomPending.current.delete(key);
          }}
          fleetId={fleetId}
          onClosed={() => setRoom(null)}
          onChanged={() => void chat.refreshSwarms()}
        />
      ) : selection ? (
        <>
          <BotResponses.Provider
            value={async (decision) => {
              const session = chat.session?.id ?? chat.messages[0]?.session;
              if (!session) throw new Error("Wait for the exact session identity before responding");
              const result = await chatRespond({
                instance: selection.instance,
                bot: selection.bot,
                session,
                ...decision,
              });
              void chat.reloadHistory();
              return result;
            }}
          >
            <div className="bm-thread-frame">
              <div className="bm-strip">
                <span>
                  {selection.session
                    ? "Additional session"
                    : "Canonical Bot Chat · always here when you return"}
                </span>
                <div>
                  <button type="button" onClick={() => void act(editProfile)}>
                    Profile ↗
                  </button>
                  <button type="button" onClick={() => setContext((v) => !v)}>
                    {context ? "Jobs" : "Activity"}
                  </button>
                  <button
                    type="button"
                    disabled={chat.sending}
                    onClick={() =>
                      void act(async () => {
                        await chatCompact({
                          instance: selection.instance,
                          bot: selection.bot,
                          ...(chat.session ? { session: chat.session.id } : {}),
                        });
                        await chat.reloadHistory();
                      })
                    }
                  >
                    Compact
                  </button>
                  <button
                    type="button"
                    disabled={chat.sending || !chat.session}
                    onClick={() => setDialog("archive")}
                  >
                    Archive
                  </button>
                </div>
              </div>
              {error ? (
                <p className="bm-error" role="alert">
                  {error}
                </p>
              ) : null}
              <Thread
                fleetId={fleetId}
                instance={selection.instance}
                bot={selection.bot}
                botTitle={bot?.title}
                isDefault={bot?.is_default}
                agent={agent}
                session={chat.session}
                destination={chat.destination}
                state={state}
                messages={chat.messages}
                live={chat.live}
                sending={chat.sending}
                activity={chat.activity}
                historyError={chat.historyError}
                now={chat.now}
                fixture={fleet?.meta?.fixture}
                reconnectAttempt={chat.reconnectAttempt}
                observation={chat.observation}
                onResumeObservation={() => void chat.resumeObservation()}
                tailnetDetail={chat.tailnetDetail}
                onSend={chat.send}
                onAbort={chat.abort}
                onRename={async (title) => {
                  // Only the update's own failure is a failed rename.
                  await botsUpdate({ instance: selection.instance, bot: selection.bot, title });
                  // Forced: the operator just acted, so the roster read is not a
                  // background poll the visibility gate should skip. A failed read
                  // is the roster's to report (`swarmsError`), not the rename's:
                  // the title is already saved.
                  await chat.refreshSwarms({ force: true }).catch(() => {});
                }}
                mentions={
                  selection.session ? [] : (swarm?.bots.filter((b) => b.name !== selection.bot) ?? [])
                }
                mentionHint="Mention a teammate on this instance; Hermes handles delivery."
                teammates={swarm?.bots}
                sessions={chat.sessions}
                onChooseSession={(session) => select(selection.instance, selection.bot, session)}
              />
            </div>
          </BotResponses.Provider>
          {withContext ? (
            context ? (
              <Context
                agent={agent}
                instance={selection.instance}
                bot={selection.bot}
                messages={chat.messages}
              />
            ) : (
              <ScheduledJobs
                key={`${selection.instance}/${selection.bot}`}
                instance={selection.instance}
                bot={selection.bot}
                title={bot?.title ?? selection.bot}
                fleetId={fleetId}
              />
            )
          ) : null}
        </>
      ) : (
        <section className="ch-thread">
          <div className="ch-empty">
            {chat.offTailnet ? (
              <NoRoute detail={chat.tailnetDetail} />
            ) : chat.swarmsLoading && !chat.swarms.length && listening?.instances.length ? (
              <div>
                <h2>Loading bots…</h2>
                <p>Reading the bots on the instances being listened to.</p>
              </div>
            ) : (
              <div>
                <h2>
                  {listening && !listening.instances.length
                    ? "No instances watched"
                    : chat.fleetUnreachable
                      ? "No box answered"
                      : "Choose a bot"}
                </h2>
                <p>
                  {chat.swarmsError ??
                    "Choose Listen on an instance in Fleet to see its bots and open a Bot Chat."}
                </p>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => {
                    window.location.hash = "";
                  }}
                >
                  Go to fleet
                </button>
              </div>
            )}
          </div>
        </section>
      )}
      {panel ? (
        <button
          type="button"
          className="bm-scrim"
          aria-label="Close side panel"
          onClick={() => setPanel(null)}
        />
      ) : null}
      {dialog === "bot" ? (
        <BotCreateDialog
          swarms={chat.swarms}
          initialInstance={selection?.instance ?? ""}
          onClose={() => setDialog(null)}
          onSubmit={async (data) => {
            const created = await botsCreate({
              instance: String(data.get("instance")),
              name: String(data.get("name")),
              ...(String(data.get("title") ?? "").trim()
                ? { title: String(data.get("title")).trim() }
                : {}),
              description: String(data.get("description")),
              soul: String(data.get("soul")),
              ...(data.get("model") ? { model: String(data.get("model")) } : {}),
            });
            await chatOpen({ instance: created.instance, bot: created.bot });
            await chat.refreshSwarms();
            select(created.instance, created.bot);
          }}
        />
      ) : null}
      {dialog === "profile" && profile ? (
        <BotModeDialog
          title={`${profile.bot} profile`}
          onClose={() => setDialog(null)}
          onSubmit={async (data) => {
            await botsUpdate({
              instance: profile.instance,
              bot: profile.bot,
              description: String(data.get("description")),
              soul: String(data.get("soul")),
              ...(String(data.get("model")) !== profile.model.default
                ? { model: String(data.get("model")) }
                : {}),
              ...(String(data.get("provider")) !== profile.model.provider
                ? { provider: String(data.get("provider")) }
                : {}),
              disabled_skills: profile.skills
                .filter((entry) => !data.getAll("skills").includes(entry.name))
                .map((entry) => entry.name),
              enabled_toolsets: data.getAll("toolsets").map(String),
              enabled_mcp_servers: data.getAll("mcp_servers").map(String),
              confirm_expensive_model: data.get("confirm_model") === "on",
            });
            await chat.refreshSwarms();
          }}
        >
          <p className="bm-note">
            {profile.instance} / {profile.bot}
          </p>
          <BotField label="Description" name="description" value={profile.description} />
          <BotField label="Role" name="soul" value={profile.soul} textarea />
          <BotField label="Model" name="model" value={profile.model.default} />
          <BotField label="Provider" name="provider" value={profile.model.provider} />
          <label className="bm-check">
            <input type="checkbox" name="confirm_model" />
            Confirm model change if Hermes flags its cost
          </label>
          {(["skills", "toolsets", "mcp_servers"] as const).map((category) => (
            <fieldset key={category}>
              <legend>{category.replaceAll("_", " ")}</legend>
              {profile[category].length ? (
                profile[category].map((entry) => (
                  <label key={entry.name} className="bm-check">
                    <input
                      type="checkbox"
                      name={category}
                      value={entry.name}
                      defaultChecked={entry.enabled}
                    />
                    {entry.name}
                  </label>
                ))
              ) : (
                <p className="bm-note">None configured</p>
              )}
            </fieldset>
          ))}
          {profile.bot !== "default" ? (
            <button type="button" className="btn btn-danger" onClick={() => setDialog("delete")}>
              Remove bot
            </button>
          ) : null}
        </BotModeDialog>
      ) : null}
      {dialog === "delete" && profile ? (
        <BotModeDialog
          title="Remove bot"
          submit="Remove profile and history"
          onClose={() => setDialog(null)}
          onSubmit={async () => {
            await botsDelete({ instance: profile.instance, bot: profile.bot, confirm: true });
            await chat.refreshSwarms();
            select(profile.instance, "default");
          }}
        >
          <p>
            Remove {profile.bot} on {profile.instance}, including its saved profile data and history?
            This cannot be undone.
          </p>
        </BotModeDialog>
      ) : null}
      {dialog === "archive" && selection ? (
        <BotModeDialog
          title="Archive conversation"
          submit="Archive"
          onClose={() => setDialog(null)}
          onSubmit={async () => {
            const session = chat.session?.id;
            if (!session) throw new Error("Wait for session identity");
            await chatArchive({ instance: selection.instance, bot: selection.bot, session });
            await chat.reloadHistory();
            await chat.refreshSwarms();
          }}
        >
          <p>
            Keep this history as an archive. Archiving Bot Chat establishes a new canonical conversation
            when it is reopened.
          </p>
        </BotModeDialog>
      ) : null}
      {dialog === "room" ? (
        <RoomCreateDialog
          swarms={chat.swarms}
          initialInstance={selection?.instance ?? ""}
          onClose={() => setDialog(null)}
          onSubmit={async (data) => {
            const instance = String(data.get("instance"));
            const result = await roomsCreate({
              instance,
              room: crypto.randomUUID(),
              name: String(data.get("name")),
              members: data.getAll("members").map((bot) => ({ instance, bot: String(bot) })),
            });
            await chat.refreshSwarms();
            setRoom({
              id: result.id,
              name: result.name,
              instance: result.instance,
              members: result.members.map((m) => ({ instance: result.instance, bot: m.profile })),
              needs_action: false,
            });
          }}
        />
      ) : null}
    </div>
  );
}
