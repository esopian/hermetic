/**
 * A picture in the transcript — an attached or shared image, a tool's image
 * or screenshot, a markdown image: a thumbnail in a bordered frame that opens
 * the full-screen viewer on a tap. Where it comes from is `file-urls.ts`'s
 * rule and `useBoxImage`'s fetch; a picture that cannot be shown says so in
 * one mono line instead of drawing a broken frame.
 *
 * A picture on the conversation's box loads at once. An `https:` one is never
 * fetched on render (desktop `Attachment.tsx`: a box that wants to signal out
 * only has to name an off-tailnet URL): it is a square placeholder naming the
 * host, with "Load image", and only that tap, on that block, fetches it. The
 * choice is not remembered.
 */
import { useState } from "react";
import { Image, Pressable, View } from "react-native";
import type { ImageSource } from "../../client/file-urls.ts";
import { useTheme } from "../../theme/theme.tsx";
import { Button } from "../../ui/Button.tsx";
import { Text } from "../../ui/Text.tsx";
import { ImageViewer } from "../ImageViewer.tsx";
import { useBoxImage } from "./use-box-file.ts";

export const PICTURE_HEIGHT = 180;

/** The one-line reason a picture is not drawn. */
export function MissingPicture({ text }: { text: string }) {
  return (
    <Text mono variant="caption" tone="fg3" testID="picture-missing">
      {text}
    </Text>
  );
}

export function Picture({
  source,
  alt,
  sha256,
  caption = false,
  height = PICTURE_HEIGHT,
}: {
  source: ImageSource;
  /** What the picture is: its file name or alt text, read by VoiceOver and the viewer. */
  alt: string;
  /** A share's digest: the bytes must match it to be drawn. */
  sha256?: string | null;
  /** Draw `alt` under the frame (a markdown image's caption). */
  caption?: boolean;
  height?: number;
}) {
  const t = useTheme();
  const [allowed, setAllowed] = useState(false);
  const gated = source.kind === "external" && !allowed;
  const image = useBoxImage(gated ? null : source, sha256);
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState<string | null>(null);
  if (source.kind === "external" && gated)
    return (
      <ExternalPlaceholder
        host={source.host}
        alt={alt}
        height={height}
        onLoad={() => setAllowed(true)}
      />
    );
  if (!image) return null;
  if (image.state === "gone") return <MissingPicture text="preview expired — no longer on the box" />;
  if (image.state === "failed")
    return (
      <MissingPicture
        text={
          image.code === "FILE_DIGEST_MISMATCH"
            ? "preview withheld — the image does not match its sha256"
            : "preview unavailable"
        }
      />
    );
  const uri = image.state === "ready" ? image.uri : null;
  if (uri !== null && broken === uri) return <MissingPicture text="image · could not be loaded" />;
  const frame = {
    height,
    borderWidth: t.border.row,
    borderColor: t.c.line,
    backgroundColor: t.c.bg2,
  } as const;
  return (
    <View style={{ gap: t.space.xs, marginVertical: t.space.xs }}>
      {uri === null ? (
        <View
          style={[frame, { alignItems: "center", justifyContent: "center" }]}
          testID="picture-loading"
        >
          <Text mono variant="caption" tone="fg3">
            loading image…
          </Text>
        </View>
      ) : (
        <Pressable
          accessibilityRole="imagebutton"
          accessibilityLabel={`Open ${alt || "image"}`}
          onPress={() => setOpen(true)}
          style={({ pressed }) => [frame, { opacity: pressed ? 0.8 : 1 }]}
          testID="picture"
        >
          <Image
            testID="picture-image"
            source={{ uri }}
            resizeMode="contain"
            style={{ flex: 1 }}
            onError={() => setBroken(uri)}
          />
        </Pressable>
      )}
      {caption && alt ? (
        <Text mono variant="caption" tone="fg3" numberOfLines={2}>
          {alt}
        </Text>
      ) : null}
      {open && uri !== null ? (
        <ImageViewer uri={uri} title={alt} onClose={() => setOpen(false)} />
      ) : null}
    </View>
  );
}

/** An off-box image before the operator chose to fetch it: the host, and "Load image". */
function ExternalPlaceholder({
  host,
  alt,
  height,
  onLoad,
}: {
  host: string;
  alt: string;
  height: number;
  onLoad(): void;
}) {
  const t = useTheme();
  return (
    <View
      testID="picture-external"
      style={{
        height,
        alignItems: "center",
        justifyContent: "center",
        gap: t.space.sm,
        padding: t.space.md,
        marginVertical: t.space.xs,
        borderWidth: t.border.row,
        borderColor: t.c.line,
        backgroundColor: t.c.bg2,
      }}
    >
      <Text mono variant="caption" tone="fg2" numberOfLines={1}>
        {host}
      </Text>
      <Text variant="caption" tone="fg3" style={{ textAlign: "center" }} numberOfLines={2}>
        {`${alt ? `${alt} · ` : ""}image not fetched — not served by the box`}
      </Text>
      <Button
        label="Load image"
        variant="secondary"
        compact
        accessibilityLabel={`Load image from ${host}`}
        onPress={onLoad}
      />
    </View>
  );
}
