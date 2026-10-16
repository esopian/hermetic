/**
 * The pieces the file and secret request cards share (desktop
 * `blocks/FileRequest.tsx`'s `Shell`, `Facts`, `Purpose`, `LateDelivery` and
 * `GoneCard`): the card's head, its fact rows, the agent's purpose quoted
 * literally, the tagged status lines, and the late-delivery offer.
 *
 * Like the approval card, a request card is loud and never collapses while it
 * is open: the agent may be parked on it. The head carries the warn rule and
 * mark while the slot waits on the operator.
 */
import { redactText } from "@hermetic/core/chat-client";
import { shortId } from "@hermetic/core/shared";
import { type ReactNode, useState } from "react";
import { View } from "react-native";
import {
  clockHM,
  countdown,
  markToldLate,
  type RequestToolBlock,
  requestArgs,
  resultStatus,
  toldLate,
} from "../../client/file-request-logic.ts";
import type { FileRequest } from "@hermetic/core/schema";
import { useTheme } from "../../theme/theme.tsx";
import { Button } from "../../ui/Button.tsx";
import { Kicker } from "../../ui/Kicker.tsx";
import { Text } from "../../ui/Text.tsx";
import { reasonOf } from "../../client/errors.ts";
import { haptic } from "../../ui/haptics.ts";
import { useChatScope } from "../ChatScope.tsx";
import { NeedsDot, SoftCard } from "./SoftCard.tsx";
import type { RequestFiles } from "./use-file-request.ts";

/** The card: a square `bg2` shell, a warn rule and mark while it needs the operator. */
export function RequestShell({
  testID,
  title,
  right,
  waiting,
  children,
}: {
  testID: string;
  title: string;
  right?: string | null;
  /** The slot waits on the operator: the warn rule and mark. */
  waiting: boolean;
  children: ReactNode;
}) {
  const t = useTheme();
  return (
    <SoftCard testID={testID} edge={waiting ? t.c.warn : undefined}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
        {waiting ? <NeedsDot /> : null}
        <Kicker tone={waiting ? "warn" : "fg2"} style={{ flex: 1 }}>
          {title}
        </Kicker>
        {right ? (
          <Text mono variant="caption" tone="fg3">
            {right}
          </Text>
        ) : null}
      </View>
      {children}
    </SoftCard>
  );
}

/** What the head's right side says about the slot. */
export function headRight(slot: FileRequest, now: number): string {
  switch (slot.state) {
    case "open":
    case "receiving":
      return `expires in ${countdown(slot.expires_at, now)}`;
    case "fulfilled":
    case "consumed":
      return "delivered";
    default:
      return slot.state;
  }
}

/** The agent's purpose, quoted literally: no markdown, no links, masked like the transcript. */
export function Purpose({ text }: { text: string }) {
  const t = useTheme();
  return (
    <View
      style={{ borderLeftWidth: t.border.control, borderLeftColor: t.c.line2, paddingLeft: t.space.md }}
    >
      <Text variant="bodySmall" selectable>{`“${redactText(text)}”`}</Text>
    </View>
  );
}

/** Term and value rows, the desktop's `dl`. */
export function Facts({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.xs }}>
      {rows.map(([term, value]) => (
        <View key={term} style={{ flexDirection: "row", gap: t.space.sm }}>
          <Kicker style={{ width: 84, paddingTop: 2 }}>{term}</Kicker>
          <View style={{ flex: 1, minWidth: 0 }}>
            {typeof value === "string" ? (
              <Text variant="caption" mono tone="fg2" selectable>
                {value}
              </Text>
            ) : (
              value
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

/** A tagged status line: the tag in a kicker, then what it means. */
export function TagLine({
  tag,
  tone = "fg2",
  children,
  alert = false,
}: {
  tag: string;
  tone?: "fg2" | "warn" | "bad" | "acc";
  children: ReactNode;
  alert?: boolean;
}) {
  const t = useTheme();
  return (
    <View accessibilityRole={alert ? "alert" : undefined} style={{ gap: t.space.xxs }}>
      <Kicker tone={tone}>{tag}</Kicker>
      {typeof children === "string" ? (
        <Text variant="bodySmall" tone="fg2">
          {children}
        </Text>
      ) : (
        children
      )}
    </View>
  );
}

/** The box said no: the card stays open to try again. */
export function Refusal({ message, what }: { message: string; what: string }) {
  return (
    <TagLine tag="rejected by box" tone="bad" alert>
      {`${redactText(message)} Nothing was stored. ${what}`}
    </TagLine>
  );
}

/** Reads kept failing and polling stopped: what the card shows may be stale. */
export function Unreachable({ retry }: { retry: () => void }) {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.sm }}>
      <TagLine tag="box unreachable" tone="bad" alert>
        The request could not be read from the box. What this card shows may be out of date.
      </TagLine>
      <Button label="Retry" variant="secondary" compact onPress={retry} />
    </View>
  );
}

/** Where the slot came from: a warning unless it is this conversation's own. */
export function OriginText({ own, label }: { own: boolean; label: string }) {
  return (
    <Text variant="caption" mono tone={own ? "fg2" : "warn"}>
      {label}
    </Text>
  );
}

/**
 * The delivery came after the agent stopped waiting (`deliveredLate`): offer
 * to tell it, once per request for the life of the app (`toldLate`).
 */
export function LateDelivery({
  instance,
  agent,
  request_id,
  stoppedAt,
  what,
  message,
}: {
  instance: string;
  agent: string;
  request_id: string;
  stoppedAt: string;
  /** "The file" or "The secret". */
  what: string;
  /** What "Tell … & continue" sends. */
  message: string;
}) {
  const t = useTheme();
  const scope = useChatScope();
  const send = scope?.retry ?? null;
  const [later, setLater] = useState<"open" | "dismissed" | "sent">(() =>
    toldLate(instance, request_id) ? "sent" : "open",
  );
  if (later === "dismissed") return null;
  return (
    <View testID={`late-${request_id}`} style={{ gap: t.space.sm }}>
      <TagLine tag="delivered after the turn ended" tone="warn">
        {`${agent} stopped waiting at ${clockHM(stoppedAt)}. ${what} is on the box.`}
      </TagLine>
      {later === "sent" ? (
        <Text variant="bodySmall" tone="fg2">{`Sent to ${agent}.`}</Text>
      ) : send ? (
        <View style={{ flexDirection: "row", gap: t.space.sm }}>
          <Button
            label={`Tell ${agent} & continue`}
            style={{ flex: 1 }}
            onPress={() => {
              if (toldLate(instance, request_id)) {
                setLater("sent");
                return;
              }
              // Not sent (a turn in flight): still offered.
              if (!send(message)) return;
              markToldLate(instance, request_id);
              setLater("sent");
            }}
          />
          <Button label="Later" variant="secondary" onPress={() => setLater("dismissed")} />
        </View>
      ) : null}
    </View>
  );
}

/** The box no longer has the slot: what the tool recorded is all there is. */
export function GoneCard({ block, secret }: { block: RequestToolBlock; secret: boolean }) {
  const status = resultStatus(block.result) ?? (block.status === "running" ? "waiting" : "closed");
  const id = block.request_id ?? "";
  return (
    <RequestShell
      testID={`file-request-${id}`}
      title={secret ? "Secret requested" : "File requested"}
      right={status}
      waiting={false}
    >
      <TagLine tag={status}>{`Request ${shortId(id)} is no longer on the box.`}</TagLine>
    </RequestShell>
  );
}

/**
 * No files client for this box (a build without one, or a box the phone
 * cannot place): the request as the tool recorded it, read-only. The words are
 * the model's, so the card says where to answer rather than offering to.
 */
export function ArgsCard({ block, secret }: { block: RequestToolBlock; secret: boolean }) {
  const t = useTheme();
  const args = requestArgs(block);
  const status = resultStatus(block.result) ?? (block.status === "running" ? "waiting" : "closed");
  const waiting = block.status === "running";
  const rows: [string, string][] = [];
  if (args.keys.length > 0) rows.push(["Keys", args.keys.join(" ")]);
  if (args.accept.length > 0) rows.push(["Accepts", args.accept.join(" ")]);
  if (args.sensitivity) rows.push(["Sensitivity", args.sensitivity]);
  return (
    <RequestShell
      testID={`file-request-${block.request_id ?? "none"}`}
      title={secret ? "Secret requested" : "File requested"}
      right={status}
      waiting={waiting}
    >
      {args.purpose ? <Purpose text={args.purpose} /> : null}
      {rows.length > 0 ? <Facts rows={rows} /> : null}
      <Text variant="bodySmall" tone="fg2" style={{ marginTop: t.space.xxs }}>
        Answer it from the desktop app, or with `hermetic files put`.
      </Text>
    </RequestShell>
  );
}

export interface CardProps {
  block: RequestToolBlock;
  slot: FileRequest;
  files: RequestFiles;
  now: number;
  session: string | null;
  refresh: () => void;
  /** Set when the box stopped answering. */
  notice: ReactNode;
}

/** Decline: the box answers, and the slot is re-read. */
export function useDecline(files: RequestFiles, request_id: string, refresh: () => void) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const decline = (): void => {
    setBusy(true);
    setError(null);
    haptic.warning();
    files
      .decline(request_id)
      .catch((e: unknown) => setError(reasonOf(e).message))
      .finally(() => {
        setBusy(false);
        refresh();
      });
  };
  return { decline, error, busy };
}

/** Who asked, as the operator knows it: the conversation's bot. */
export function useAgentName(): string {
  const scope = useChatScope();
  return scope?.bot ?? scope?.instance ?? "the agent";
}
