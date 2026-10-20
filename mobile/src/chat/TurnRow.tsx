/**
 * One row of the transcript (desktop `Message.tsx`): the operator's turn
 * (`.me`: "You", the words on a recessed panel), a bot turn (name, meta, then its
 * sections — one activity group per run of steps and one block per thing
 * addressed to the reader — then the failure card and the turn meter), or the
 * box speaking for itself (a system row).
 *
 * No avatar gutter: the conversation bar already names and draws the bot, so
 * every row starts at the transcript's content inset and the words take the
 * full width.
 */
import { memo } from "react";
import { View } from "react-native";
import { activeGroup, sections } from "../client/chat-activity.ts";
import { fmtCount } from "../client/chat-logic.ts";
import { failureOf } from "../client/chat-recovery.ts";
import { closedRequests, keepsCard, openRequests } from "../client/chat-requests.ts";
import type { TurnRow as TurnRowType } from "../client/chat-turns.ts";
import { isLocal } from "../client/conversation-store.ts";
import type { TurnActivity } from "../client/turn-reducer.ts";
import type { ChatMessage } from "@hermetic/core/chat-client";
import { useTheme } from "../theme/theme.tsx";
import { Kicker } from "../ui/Kicker.tsx";
import { Text } from "../ui/Text.tsx";
import { ActivityGroup } from "./blocks/Activity.tsx";
import { Block } from "./blocks/Block.tsx";
import { FailureCard } from "./blocks/Failure.tsx";
import { PlainText } from "./PlainText.tsx";
import { chatTime } from "./time.ts";

function Meter({ usage }: { usage: NonNullable<ChatMessage["usage"]> }) {
  const t = useTheme();
  const parts = [
    usage.input_tokens ? `${fmtCount(usage.input_tokens)} in` : null,
    usage.output_tokens ? `${fmtCount(usage.output_tokens)} out` : null,
    usage.cost_usd !== null && usage.cost_usd !== undefined ? `$${usage.cost_usd.toFixed(4)}` : null,
    usage.model ?? null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <Text mono variant="caption" tone="fg3" style={{ marginTop: t.space.xs }} numberOfLines={1}>
      {parts.join(" · ")}
    </Text>
  );
}

/**
 * The operator's turn, laid out the desktop's way (`.ch-msg.me` in the soft
 * skin), less the desktop's avatar gutter: a "You" head row with the time, and
 * the words flush at the content inset on a recessed panel with a 2px left
 * rule. No bubble and no right alignment: every turn reads from the
 * same left edge. A steer takes the accent on its rule and a `Steered` tag.
 * The files the operator sent go under the words, through the same `Block`
 * switch as any other turn's attachments.
 */
function OperatorTurn({
  message,
  now,
  answered,
}: {
  message: ChatMessage;
  now: number;
  answered: boolean;
}) {
  const t = useTheme();
  // A reply already under it means the box took it, echo or not.
  const pending = isLocal(message) && !answered;
  const text = message.blocks.map((b) => (b.kind === "text" ? b.markdown : "")).join("");
  const steer = message.id.startsWith("local:steer:");
  const attached = message.blocks.filter((b) => b.kind === "attachment");
  return (
    <View style={{ marginTop: t.space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
        <Text weight={800} variant="bodySmall">
          You
        </Text>
        {steer ? (
          <View
            style={{
              borderWidth: t.border.row,
              borderColor: t.c.line2,
              paddingHorizontal: t.space.xs,
            }}
          >
            <Kicker style={{ fontSize: 9, lineHeight: 14 }}>Steered</Kicker>
          </View>
        ) : null}
        <Text variant="caption" mono tone="fg3" numberOfLines={1} style={{ flexShrink: 1 }}>
          {pending ? "sending…" : chatTime(message.at, now)}
        </Text>
      </View>
      {/* Files sent alone have no words: no empty panel above their chips. */}
      {text || attached.length === 0 ? (
        <View
          style={{
            marginTop: t.space.xs,
            backgroundColor: t.c.sel,
            borderLeftWidth: t.border.control,
            borderLeftColor: steer ? t.c.acc : t.c.line2,
            paddingHorizontal: t.space.md,
            paddingVertical: t.space.sm,
            opacity: pending ? 0.7 : 1,
          }}
        >
          <PlainText text={text} />
        </View>
      ) : null}
      {attached.length > 0 ? (
        <View style={{ marginTop: t.space.xs, gap: t.space.xs, opacity: pending ? 0.7 : 1 }}>
          {attached.map((block, i) => (
            <Block key={`f${i}`} block={block} now={now} mine />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export interface TurnRowProps {
  row: TurnRowType;
  instance: string;
  bot: string;
  botTitle?: string | null;
  now: number;
  streaming?: boolean;
  activity?: TurnActivity;
  released?: readonly string[];
  /** An operator message with an agent turn after it (`transcriptItems`). */
  answered?: boolean;
  /**
   * The row's turn is live on this phone, so its requests can be answered here
   * (`transcriptItems`; defaults to `streaming`). A cut-off or failed row never is.
   */
  answerable?: boolean;
}

function TurnRowImpl({
  row,
  instance,
  bot,
  botTitle,
  now,
  streaming = false,
  activity = streaming ? "streaming" : "idle",
  released = [],
  answered = false,
  answerable = streaming,
}: TurnRowProps) {
  const t = useTheme();
  const { message, continuation } = row;
  const fromBot = message.role === "user" ? (message.from_bot ?? null) : null;
  if (message.role === "user" && !fromBot)
    return <OperatorTurn message={message} now={now} answered={answered} />;

  const failure = failureOf(message);
  const broken = !!failure || !!message.incomplete;
  if (message.blocks.length === 0 && !broken && !message.usage && !streaming) return null;

  if (message.role === "system" && !message.author) {
    return (
      <View
        style={{
          marginVertical: t.space.xs,
          paddingHorizontal: t.space.md,
          paddingVertical: t.space.sm,
          borderLeftWidth: t.border.control,
          borderLeftColor: t.c.line2,
          gap: t.space.xs,
        }}
      >
        <Text variant="caption" tone="fg3">{`system · ${chatTime(message.at, now)}`}</Text>
        {message.blocks.map((block, i) => (
          <Block key={i} block={block} now={now} />
        ))}
      </View>
    );
  }

  const author = message.author ?? null;
  const who = fromBot
    ? fromBot.name
    : author && (author.instance !== instance || author.bot !== bot)
      ? author.bot
      : (botTitle ?? bot);
  const closed = closedRequests(message.blocks);
  const requestsLive = answerable && !broken;
  const open = openRequests(message.blocks, closed, released, now, requestsLive);
  const waiting = open.length > 0;
  const blocks = message.blocks.filter(
    (block) =>
      (block.kind !== "text" || block.markdown.trim().length > 0) &&
      !(
        (block.kind === "approval" || block.kind === "question") &&
        block.request_id &&
        !keepsCard(block, closed.get(block.request_id))
      ),
  );
  const pending = open.filter((b) => b.kind === "approval").length;
  const list = sections(blocks);
  const live = activeGroup(list, streaming, activity, waiting);
  const meta = [
    chatTime(message.at, now),
    message.incomplete && !message.error ? "incomplete" : null,
    streaming ? (waiting ? "waiting" : activity === "idle" ? null : activity) : null,
    author && author.instance !== instance ? `@ ${author.instance}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View style={{ marginTop: continuation ? 2 : t.space.md }}>
      {continuation ? null : (
        <View
          style={{ flexDirection: "row", alignItems: "baseline", gap: t.space.sm, marginBottom: 2 }}
        >
          <Text weight={800} variant="bodySmall" numberOfLines={1} style={{ flexShrink: 1 }}>
            {who}
          </Text>
          <Text variant="caption" mono tone={streaming ? "acc" : "fg3"} numberOfLines={1}>
            {meta}
          </Text>
        </View>
      )}
      {list.map((section, index) =>
        section.activity ? (
          <ActivityGroup
            key={`a${index}`}
            blocks={section.blocks}
            streaming={streaming && index === live && (activity !== "idle" || waiting)}
            activity={activity}
            waiting={waiting}
            turnRunning={streaming}
          />
        ) : (
          <Block
            key={`b${index}`}
            block={section.blocks[0] as ChatMessage["blocks"][number]}
            now={now}
            streaming={streaming && activity === "streaming" && index === list.length - 1}
            closed={(() => {
              const b = section.blocks[0];
              return (b?.kind === "approval" || b?.kind === "question") && b.request_id
                ? closed.get(b.request_id)
                : undefined;
            })()}
            pending={pending}
            session={message.session || null}
            released={released}
            stale={!requestsLive}
          />
        ),
      )}
      {streaming && list.length === 0 ? (
        <Text mono variant="caption" tone="acc">
          {activity === "streaming" ? "▍" : "thinking…"}
        </Text>
      ) : null}
      {broken ? <FailureCard failure={failure} ids={row.ids} at={message.at} /> : null}
      {message.usage && !streaming ? <Meter usage={message.usage} /> : null}
      {fromBot ? <Text variant="caption" tone="fg3">{`Message from ${fromBot.name} ⇄`}</Text> : null}
    </View>
  );
}

export const TurnRow = memo(TurnRowImpl);
