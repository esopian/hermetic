/**
 * `tool` with `render: file_request | secret_request` — the agent asking the
 * operator for a file or a secret (desktop `blocks/FileRequest.tsx`).
 *
 * Everything the card states — purpose, accept list, cap, expiry — comes from
 * hermeticd's own slot (`useFileRequest`), never from the tool's arguments,
 * which are the model's words. The phone answers over its own channel to the
 * box (`gateway/files.ts`: hermeticd on 7434, whois-gated): a file goes up with
 * `fulfil`, a text secret with `secret`, a refusal with `decline`. It has no
 * AWS credential, so a secret is always sent "just this once" into the box's
 * tmpfs; storing one in SSM is the desktop's.
 *
 * Three cards share the head and the facts: a file (`FileCard`), a secret file
 * (the same card with no preview of any kind), and a text secret
 * (`SecretTextCard`). A block whose id the box no longer has is drawn from the
 * tool's recorded result, and says so; one with no files client is read-only.
 */
import { HermeticError } from "@hermetic/core/chat-client";
import {
  FILES_LIMITS,
  FILES_TTL,
  looksLikeKeyMaterial,
  requestFileName,
  sanitizeFileName,
  sniffMime,
} from "@hermetic/core/shared";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { FileRequest } from "@hermetic/core/schema";
import { View } from "react-native";
import { fmtBytes } from "../../client/chat-logic.ts";
import { reasonOf } from "../../client/errors.ts";
import {
  baseName,
  capLabel,
  clockHM,
  continueMessage,
  deliveredLate,
  lifetimeLabel,
  type RequestToolBlock,
  requestOrigin,
  shortSha,
  slotDelivered,
} from "../../client/file-request-logic.ts";
import {
  discardPicked,
  pickDocument,
  pickFromLibrary,
  readBytes,
} from "../../client/pick-attachment.ts";
import { useTheme } from "../../theme/theme.tsx";
import { Button } from "../../ui/Button.tsx";
import { haptic } from "../../ui/haptics.ts";
import { Text } from "../../ui/Text.tsx";
import { useChatScope } from "../ChatScope.tsx";
import {
  ArgsCard,
  type CardProps,
  Facts,
  GoneCard,
  headRight,
  LateDelivery,
  OriginText,
  Purpose,
  Refusal,
  RequestShell,
  TagLine,
  Unreachable,
  useAgentName,
  useDecline,
} from "./request-parts.tsx";
import { SecretTextCard } from "./SecretText.tsx";
import { ToolBlock } from "./Tool.tsx";
import { useFileRequest, useRequestFiles } from "./use-file-request.ts";

export interface FileRequestProps {
  block: RequestToolBlock;
  now: number;
  /** The session the message is in: "from this conversation" is claimed only for it. */
  session: string | null;
}

export function FileRequestBlock({ block, now, session }: FileRequestProps) {
  // The id is unknown until the box answered: the tool row, waiting.
  if (!block.request_id) return <ToolBlock block={block} />;
  // Keyed by the id: nothing typed or held for one request carries over to another.
  return (
    <RequestCard
      key={block.request_id}
      block={block}
      request_id={block.request_id}
      now={now}
      session={session}
    />
  );
}

function RequestCard({ block, request_id, now, session }: FileRequestProps & { request_id: string }) {
  const files = useRequestFiles();
  const view = useFileRequest(files, request_id);
  const secret = block.render === "secret_request";
  if (!files) return <ArgsCard block={block} secret={secret} />;
  if (view.missing) return <GoneCard block={block} secret={secret} />;
  const slot = view.slot;
  const notice = view.unreachable ? <Unreachable retry={view.refresh} /> : null;
  if (slot === null) {
    return (
      <RequestShell
        testID={`file-request-${request_id}`}
        title={secret ? "Secret requested" : "File requested"}
        waiting={false}
      >
        {notice ?? (
          <Text variant="bodySmall" tone="fg2">
            {view.error
              ? `Could not read the request from the box: ${view.error}`
              : "Reading the request from the box…"}
          </Text>
        )}
      </RequestShell>
    );
  }
  const props = { block, slot, files, now, session, refresh: view.refresh, notice };
  return slot.kind === "secret_text" ? <SecretTextCard {...props} /> : <FileCard {...props} />;
}

/** A picked file, held until it is sent or let go. Its bytes are zeroed on the way out. */
interface Held {
  name: string;
  bytes: Uint8Array;
}

type Upload =
  | { phase: "idle" }
  | { phase: "reading" }
  | { phase: "uploading" }
  | { phase: "error"; message: string };

/**
 * The slot's cap and `.ext` accept entries against what the picker reported,
 * so an oversized or plainly misnamed file is refused before it is read. A
 * MIME entry is left to `fulfil`, which sniffs the bytes as the box does: the
 * picker's own type (Keynote for a `.key` PEM, `application/x-yaml`) is not
 * what the accept list is defined against.
 */
function beforeRead(slot: FileRequest, picked: { name: string; size: number }): void {
  const clean = sanitizeFileName(picked.name);
  const name = (clean.ok ? clean.name : picked.name).toLowerCase();
  if (picked.size > slot.max_bytes) {
    throw new HermeticError(
      "FILE_TOO_LARGE",
      `the file is ${fmtBytes(picked.size)}; this request takes at most ${capLabel(slot.max_bytes)}`,
      { size: picked.size, limit: slot.max_bytes },
    );
  }
  const entries = slot.accept.map((e) => e.trim().toLowerCase()).filter((e) => e !== "");
  const byExtension = entries.length > 0 && entries.every((e) => e.startsWith("."));
  if (byExtension && !entries.some((e) => name.endsWith(e))) {
    throw new HermeticError(
      "FILE_TYPE_REJECTED",
      `this request accepts ${slot.accept.join(" ")}; the file has another extension`,
    );
  }
}

function FileCard({ block, slot, files, now, session, refresh, notice }: CardProps) {
  const t = useTheme();
  const scope = useChatScope();
  const agent = useAgentName();
  const request_id = slot.request_id;
  const declining = useDecline(files, request_id, refresh);
  const secret = slot.sensitivity === "secret" || slot.fulfilled?.class === "secret";
  const live = slot.state === "open" || slot.state === "receiving";
  const [upload, setUpload] = useState<Upload>({ phase: "idle" });
  // A key-looking pick on a normal request (D6), held until the operator says
  // which. A ref, not state: the bytes are never part of a render.
  const held = useRef<Held | null>(null);
  const [keyPrompt, setKeyPrompt] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  // Mounted is its own flag, set in the mount effect's body, so a pick that
  // resolves after the card left neither reads nor uploads.
  const mounted = useRef(false);
  const stillLive = (): boolean => mounted.current && liveRef.current;

  const letGo = (): void => {
    held.current?.bytes.fill(0);
    held.current = null;
    setKeyPrompt(false);
  };
  // The card leaves, or the slot closes under the question: whatever was held goes.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      held.current?.bytes.fill(0);
      held.current = null;
    };
  }, []);
  useEffect(() => {
    if (live || held.current === null) return;
    letGo();
    setChosen(null);
  }, [live]);

  const send = async (file: Held, not_secret: boolean): Promise<void> => {
    const stop = new AbortController();
    controller.current = stop;
    setUpload({ phase: "uploading" });
    try {
      await files.fulfil(request_id, {
        name: file.name,
        bytes: file.bytes,
        ...(not_secret ? { not_secret: true } : {}),
        signal: stop.signal,
      });
      haptic.success();
      setUpload({ phase: "idle" });
    } catch (e) {
      haptic.error();
      const reason = reasonOf(e);
      setUpload(
        reason.code === "ABORTED" ? { phase: "idle" } : { phase: "error", message: reason.message },
      );
    } finally {
      file.bytes.fill(0);
      controller.current = null;
      refresh();
    }
  };

  const pick = async (from: "files" | "photos"): Promise<void> => {
    if (!stillLive()) return;
    setUpload({ phase: "reading" });
    try {
      const [first] = from === "files" ? await pickDocument(1) : await pickFromLibrary(1);
      if (!first) {
        setUpload({ phase: "idle" });
        return;
      }
      let bytes: Uint8Array;
      try {
        if (!stillLive()) {
          setUpload({ phase: "idle" });
          return;
        }
        // Refused on what the picker reported, before a byte is read.
        beforeRead(slot, first);
        bytes = await readBytes(first.uri);
      } finally {
        // The picker's copy in the app cache goes once read (or refused):
        // the bytes are held in memory only until they are sent.
        discardPicked(first);
      }
      if (!stillLive()) {
        bytes.fill(0);
        setUpload({ phase: "idle" });
        return;
      }
      const clean = sanitizeFileName(first.name);
      const name = clean.ok ? clean.name : first.name;
      const mime = sniffMime(bytes.subarray(0, FILES_LIMITS.sniffBytes), name);
      setChosen(requestFileName(slot, name, mime));
      const file = { name: first.name, bytes };
      if (!secret && looksLikeKeyMaterial(bytes.subarray(0, FILES_LIMITS.sniffBytes), name)) {
        held.current = file;
        setKeyPrompt(true);
        setUpload({ phase: "idle" });
        return;
      }
      await send(file, false);
    } catch (e) {
      setUpload({ phase: "error", message: reasonOf(e).message });
    }
  };

  const release = (not_secret: boolean | null): void => {
    const file = held.current;
    held.current = null;
    setKeyPrompt(false);
    if (file === null) return;
    if (not_secret === null) {
      file.bytes.fill(0);
      setChosen(null);
      return;
    }
    void send(file, not_secret);
  };

  const busy = upload.phase === "uploading" || upload.phase === "reading";
  const refusal =
    upload.phase === "error" ? upload.message : live && slot.rejected ? slot.rejected.message : null;
  const origin = requestOrigin(slot, session);
  const done = slot.fulfilled;
  const onBox = done ? baseName(done.path) : chosen;
  const rows: [string, ReactNode][] = secret
    ? [
        [
          "Stored as",
          slot.durable && !done
            ? "just this once from this phone (tmpfs, 1 h); keeping it in SSM needs the desktop app"
            : done?.ssm_slot
              ? `encrypted SSM slot ${done.ssm_slot}`
              : "not stored · just this once",
        ],
        ["On the box", `${onBox ? `${onBox} · ` : ""}tmpfs · 0600 · never written to /data`],
        ["Never", "previewed · kept on this phone once sent"],
        [
          "Accepts",
          `${slot.accept.length > 0 ? `${slot.accept.join(" ")} · ` : ""}≤ ${capLabel(slot.max_bytes)}`,
        ],
        ["Request", <OriginText key="r" {...origin} />],
      ]
    : [
        ["Destination", `inbox · deleted after ${Math.round(FILES_TTL.inbox / 86_400)} days`],
        [
          "Accepts",
          `${slot.accept.length > 0 ? `${slot.accept.join(" ")} · ` : "any type · "}≤ ${capLabel(slot.max_bytes)}`,
        ],
        ...(slot.name_hint ? ([["Name", slot.name_hint]] as [string, string][]) : []),
        ["Request", <OriginText key="r" {...origin} />],
      ];

  return (
    <RequestShell
      testID={`file-request-${request_id}`}
      title={secret ? "Secret requested" : "File requested"}
      right={headRight(slot, now)}
      waiting={live}
    >
      {notice}
      <Purpose text={slot.purpose} />
      <Facts rows={rows} />
      {keyPrompt && live ? (
        <View accessibilityRole="alert" style={{ gap: t.space.sm }}>
          <Text variant="bodySmall" weight={600}>
            Looks like a private key. The box will keep it as a secret, just this once.
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
            <Button
              label="Send as secret"
              compact
              style={{ flexGrow: 1 }}
              onPress={() => release(false)}
            />
            <Button
              label="This isn't a secret"
              variant="secondary"
              compact
              style={{ flexGrow: 1 }}
              onPress={() => release(true)}
            />
            <Button label="Cancel" variant="secondary" compact onPress={() => release(null)} />
          </View>
        </View>
      ) : null}
      {upload.phase === "uploading" ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
          <Text variant="bodySmall" tone="acc" style={{ flex: 1 }}>
            {secret ? "Sending the secret…" : "Uploading…"}
          </Text>
          <Button
            label="Cancel"
            variant="secondary"
            compact
            onPress={() => controller.current?.abort()}
          />
        </View>
      ) : null}
      {refusal && live && !busy ? (
        <Refusal message={refusal} what={secret ? "Choose another key." : "Choose another file."} />
      ) : null}
      {declining.error ? (
        <Text accessibilityRole="alert" variant="caption" tone="bad">
          {declining.error}
        </Text>
      ) : null}
      {done && slotDelivered(slot) ? (
        <TagLine tag={secret ? "secret delivered" : "delivered"} tone="acc">
          {secret
            ? `${baseName(done.path)}${done.ssm_slot ? ` → slot ${done.ssm_slot}` : " → tmpfs"} · ${fmtBytes(done.bytes)} · sha ${shortSha(done.sha256)} · contents never shown`
            : `${baseName(done.path)} · ${fmtBytes(done.bytes)} · sha ${shortSha(done.sha256)} · by ${done.by} · ${clockHM(done.at)}`}
        </TagLine>
      ) : null}
      {slot.state === "declined" ? (
        <TagLine tag="declined">{`You declined. ${agent} was told.`}</TagLine>
      ) : null}
      {slot.state === "expired" ? (
        <TagLine tag="expired">{`No file within ${lifetimeLabel(slot)}. Ask ${agent} to request again.`}</TagLine>
      ) : null}
      {done && deliveredLate(block, slot) ? (
        <LateDelivery
          instance={scope?.instance ?? ""}
          agent={agent}
          request_id={request_id}
          stoppedAt={slot.created_at}
          what={secret ? "The secret" : "The file"}
          message={continueMessage(request_id, done.path)}
        />
      ) : null}
      {live && !busy && !keyPrompt ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
          <Button
            label="Choose file"
            style={{ flexGrow: 1, flexBasis: "45%" }}
            onPress={() => void pick("files")}
          />
          <Button
            label="Photo library"
            variant="secondary"
            style={{ flexGrow: 1, flexBasis: "45%" }}
            onPress={() => void pick("photos")}
          />
          <Button
            label="Decline"
            variant="destructive"
            busy={declining.busy}
            style={{ flexGrow: 1 }}
            onPress={declining.decline}
          />
        </View>
      ) : null}
    </RequestShell>
  );
}
