/**
 * A file the agent handed the operator (desktop `blocks/ShareCard.tsx`):
 * `share_file`, or a `MEDIA:` line naming the box's outbox.
 *
 * One card per share: the type tag, the name, the size, a short sha256, how
 * long the box keeps it, and Save. What shows above the row follows the box's
 * sniffed type (`shareView`), as on the desktop: an image is fetched at once;
 * a text file opens in a code pane behind "Preview"; audio and video are
 * fetched only on "Play" (up to 25 MiB over the tailnet is not spent on a
 * scroll), written to the cache directory and played by the system player.
 * Every read must match the box's digest and the share's own sha256. Save
 * brings the file onto the phone (digest-checked) and opens the system share
 * sheet for it (`save-box-file.ts`).
 *
 * A share the box refused never gets a card: the call is a tool error, and the
 * box's words are what the operator reads.
 */
import type { AttachmentBlock, ToolBlock as ToolBlockType } from "@hermetic/core/chat-client";
import { contentPurposeAllows, contentPurposeBytes, FILES_TTL } from "@hermetic/core/shared";
import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { fmtBytes } from "../../client/chat-logic.ts";
import { resultText, subjectOf } from "../../client/chat-turns.ts";
import { errorCode, reasonOf } from "../../client/errors.ts";
import { type ShareView, sharePurpose, shareToggleLabel, shareView } from "../../client/share-logic.ts";
import type { PhoneFiles } from "../../gateway/files.ts";
import { useTheme } from "../../theme/theme.tsx";
import { Button } from "../../ui/Button.tsx";
import { haptic } from "../../ui/haptics.ts";
import { Text } from "../../ui/Text.tsx";
import { CodePane } from "../CodePane.tsx";
import { Picture } from "./Picture.tsx";
import { cacheName, saveBoxFile, writeCacheFile } from "./save-box-file.ts";
import { typeTag } from "./Simple.tsx";
import { ToolBlock } from "./Tool.tsx";
import { useBoxFiles } from "./use-box-file.ts";

/** What a card draws: a `share_file` result, or an outbox chip's facts. */
export interface ShareFacts {
  id: string;
  name: string;
  mime: string;
  /** 0 when the outbox listing could not be read. */
  bytes: number;
  sha256: string | null;
}

/** `on box 24 h`: how long the outbox keeps a share. */
const RETENTION = `on box ${Math.round(FILES_TTL.outbox / 3600)} h`;

type SaveState =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "saved" }
  | { phase: "error"; code: string; message: string };

/** A text or media share opened behind its toggle. */
type Opened =
  | { state: "loading" }
  | { state: "text"; text: string }
  | { state: "media"; uri: string }
  | { state: "gone" }
  | { state: "failed"; code: string };

/** Read an opened share's bytes (capped for its purpose, digest-checked): text, or a cache-file URI to play. */
function useOpenedShare(
  files: PhoneFiles | null,
  share: ShareFacts,
  view: ShareView | null,
  open: boolean,
): Opened | null {
  const key = open && view && view !== "image" ? `${share.id}\n${view}` : null;
  const [got, setGot] = useState<{ key: string; value: Opened } | null>(null);
  const { id, name, sha256 } = share;
  useEffect(() => {
    if (!key || !view) return;
    const purpose = sharePurpose(view);
    if (!files) {
      setGot({ key, value: { state: "failed", code: "UNSUPPORTED" } });
      return;
    }
    const controller = new AbortController();
    const settle = (value: Opened) => {
      if (!controller.signal.aborted) setGot({ key, value });
    };
    settle({ state: "loading" });
    files
      .content(id, { signal: controller.signal, maxBytes: contentPurposeBytes(purpose) })
      .then((c) => {
        if (sha256 && c.sha256 !== sha256.toLowerCase()) {
          settle({ state: "failed", code: "FILE_DIGEST_MISMATCH" });
        } else if (!contentPurposeAllows(purpose, c.mime)) {
          settle({ state: "failed", code: "FILE_TYPE_REJECTED" });
        } else if (view === "text") {
          settle({ state: "text", text: new TextDecoder().decode(c.bytes) });
        } else {
          settle({
            state: "media",
            uri: writeCacheFile(cacheName(id, name), c.bytes),
          });
        }
      })
      .catch((e: unknown) => {
        const code = errorCode(e) ?? "UNKNOWN";
        settle(code === "FILE_NOT_FOUND" ? { state: "gone" } : { state: "failed", code });
      });
    return () => controller.abort();
  }, [key, view, files, id, name, sha256]);
  if (!key) return null;
  return got?.key === key ? got.value : { state: "loading" };
}

/** The system player for a cached audio or video file, with its own controls. */
function SharePlayer({
  uri,
  video,
  name,
  onError,
}: {
  uri: string;
  video: boolean;
  name: string;
  onError: () => void;
}) {
  const t = useTheme();
  const player = useVideoPlayer(uri);
  const { status } = useEvent(player, "statusChange", { status: player.status });
  useEffect(() => {
    if (status === "error") onError();
  }, [status, onError]);
  return (
    <VideoView
      testID="share-player"
      player={player}
      nativeControls
      contentFit="contain"
      accessibilityLabel={name}
      // Audio needs only the control bar's height; video gets a frame.
      style={{ width: "100%", height: video ? 200 : 96, backgroundColor: t.c.bg3 }}
    />
  );
}

/** The one-line note an opened share shows instead of its contents. */
function openedNote(opened: Opened | null, playable: boolean, undecodable: boolean): string | null {
  const verb = playable ? "play" : "preview";
  if (undecodable) return "this app cannot play this file — Save instead";
  if (opened?.state === "loading") return playable ? "loading…" : "loading preview…";
  if (opened?.state !== "failed") return null;
  if (opened.code === "FILE_TOO_LARGE") return `too large to ${verb} here — Save instead`;
  return `${playable ? "playback" : "preview"} unavailable`;
}

export function ShareCard({ share }: { share: ShareFacts }) {
  const t = useTheme();
  const files = useBoxFiles();
  const [save, setSave] = useState<SaveState>({ phase: "idle" });
  const [open, setOpen] = useState(false);
  const [undecodable, setUndecodable] = useState(false);
  const mime = typeof share.mime === "string" ? share.mime : "";
  const view = shareView(mime, share.id);
  const playable = view === "audio" || view === "video";
  const opened = useOpenedShare(files, share, view, open);
  const toggle = shareToggleLabel(view, open);
  const note = open ? openedNote(opened, playable, undecodable) : null;
  const gone = opened?.state === "gone" || (save.phase === "error" && save.code === "FILE_NOT_FOUND");
  const sha = share.sha256 ? `sha ${share.sha256.slice(0, 4)}…` : null;
  const meta = [
    share.bytes > 0 || sha !== null ? fmtBytes(share.bytes) : null,
    sha,
    gone ? "no longer on the box" : RETENTION,
  ]
    .filter(Boolean)
    .join(" · ");
  const busy = save.phase === "saving";
  const onSave = () => {
    if (!files || busy) return;
    setSave({ phase: "saving" });
    saveBoxFile(files, share.id, share.name)
      .then(() => {
        haptic.success();
        setSave({ phase: "saved" });
      })
      .catch((e: unknown) => {
        haptic.error();
        const { code, message } = reasonOf(e);
        setSave({ phase: "error", code, message });
      });
  };
  return (
    <View
      testID={`share-${share.id}`}
      style={{
        borderWidth: t.border.row,
        borderColor: t.c.cardEdge,
        backgroundColor: t.c.card,
        padding: t.space.sm,
        gap: t.space.sm,
        marginVertical: t.space.xs,
      }}
    >
      {view === "image" && !gone ? (
        <Picture source={{ kind: "box", id: share.id }} alt={share.name} sha256={share.sha256} />
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.md }}>
        <View
          style={{
            width: 40,
            height: 40,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: t.border.row,
            borderColor: t.c.line2,
            backgroundColor: t.c.bg3,
          }}
        >
          <Text mono variant="caption" weight={700}>
            {typeTag(mime, share.name)}
          </Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text weight={700} variant="bodySmall" numberOfLines={1}>
            {share.name}
          </Text>
          <Text mono variant="caption" tone={gone ? "bad" : "fg3"} numberOfLines={1}>
            {meta}
          </Text>
        </View>
        {toggle ? (
          <Button
            label={toggle}
            variant="secondary"
            compact
            disabled={!files || gone}
            accessibilityLabel={`${toggle} ${share.name}`}
            onPress={() => {
              setUndecodable(false);
              setOpen((was) => !was);
            }}
          />
        ) : null}
        <Button
          label={busy ? "Saving…" : "Save"}
          variant="secondary"
          compact
          busy={busy}
          disabled={!files || gone}
          accessibilityLabel={`Save ${share.name}`}
          onPress={onSave}
        />
      </View>
      {opened?.state === "text" ? <CodePane text={opened.text} lang={share.name} /> : null}
      {opened?.state === "media" && !undecodable ? (
        <SharePlayer
          uri={opened.uri}
          video={view === "video"}
          name={share.name}
          onError={() => setUndecodable(true)}
        />
      ) : null}
      {note && !gone ? (
        <Text mono variant="caption" tone="fg3" accessibilityRole="text">
          {note}
        </Text>
      ) : null}
      {save.phase === "saved" ? (
        <Text mono variant="caption" tone="ok" accessibilityRole="text">
          {`✓ ready to save · ${share.name}`}
        </Text>
      ) : null}
      {save.phase === "error" && !gone ? (
        <Text mono variant="caption" tone="bad" accessibilityRole="alert">
          {`not saved — ${save.message}`}
        </Text>
      ) : null}
    </View>
  );
}

/** `share_file`: its card, the box's refusal, or — still running or unreadable — the tool row. */
export function ShareToolBlock({ block }: { block: ToolBlockType }) {
  const t = useTheme();
  const share = block.share;
  if (share) {
    return (
      <ShareCard
        share={{
          id: share.share_id,
          name: share.name,
          mime: share.mime,
          bytes: share.bytes,
          sha256: share.sha256,
        }}
      />
    );
  }
  if (block.status === "bad" || block.status === "warn") {
    const subject = subjectOf(block.args);
    const tone = block.status === "bad" ? t.c.bad : t.c.warn;
    return (
      <View
        accessibilityRole="text"
        style={{
          borderWidth: t.border.row,
          borderColor: t.c.cardEdge,
          borderLeftWidth: t.border.seam,
          borderLeftColor: tone,
          backgroundColor: t.c.card,
          padding: t.space.sm,
          gap: t.space.xs,
          marginVertical: t.space.xs,
        }}
      >
        <Text mono variant="caption" weight={700} tone={block.status === "bad" ? "bad" : "warn"}>
          {subject ? `${block.name} · ${subject}` : block.name}
        </Text>
        <Text variant="bodySmall" tone="fg2">
          {resultText(block.result) || "the share failed"}
        </Text>
      </View>
    );
  }
  return <ToolBlock block={block} />;
}

/** A `MEDIA:` outbox chip: the same card, from what the chip carries. */
export function ShareAttachment({ block }: { block: AttachmentBlock }) {
  return (
    <ShareCard
      share={{
        id: block.file_id ?? "",
        name: block.name,
        mime: typeof block.mime === "string" ? block.mime : "",
        bytes: typeof block.bytes === "number" ? block.bytes : 0,
        sha256: block.sha256 || null,
      }}
    />
  );
}
