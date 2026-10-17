/**
 * A file the agent handed the operator (desktop `blocks/ShareCard.tsx`):
 * `share_file`, or a `MEDIA:` line naming the box's outbox.
 *
 * One card per share: the type tag, the name, the size, a short sha256, how
 * long the box keeps it, and Save. An image is fetched from the box at once
 * and shown above the row, only when its bytes match the box's digest and the
 * share's own sha256. Save brings the file onto the phone (digest-checked) and
 * opens the system share sheet for it (`save-box-file.ts`).
 *
 * A share the box refused never gets a card: the call is a tool error, and the
 * box's words are what the operator reads.
 */
import type { AttachmentBlock, ToolBlock as ToolBlockType } from "@hermetic/core/chat-client";
import { FILES_TTL, isImageMime, isShareId } from "@hermetic/core/shared";
import { useState } from "react";
import { View } from "react-native";
import { fmtBytes } from "../../client/chat-logic.ts";
import { resultText, subjectOf } from "../../client/chat-turns.ts";
import { reasonOf } from "../../client/errors.ts";
import { useTheme } from "../../theme/theme.tsx";
import { Button } from "../../ui/Button.tsx";
import { haptic } from "../../ui/haptics.ts";
import { Text } from "../../ui/Text.tsx";
import { Picture } from "./Picture.tsx";
import { saveBoxFile } from "./save-box-file.ts";
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

export function ShareCard({ share }: { share: ShareFacts }) {
  const t = useTheme();
  const files = useBoxFiles();
  const [save, setSave] = useState<SaveState>({ phase: "idle" });
  const mime = typeof share.mime === "string" ? share.mime : "";
  const image = isImageMime(mime) && isShareId(share.id);
  const gone = save.phase === "error" && save.code === "FILE_NOT_FOUND";
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
      {image && !gone ? (
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
