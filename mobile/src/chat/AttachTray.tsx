/**
 * The files picked for the next message, as a row of square chips above the
 * composer's input (the desktop's attachment strip). An image shows its local
 * thumbnail; any other file its name and size in mono. Each chip has a remove
 * button. Uploading, a chip carries a small spinner; failed, a `bad` left rule,
 * the error's one-line copy (`errorCopy`) and a Retry button.
 *
 * The state is the screen's (`attachmentsReducer`); this only draws it.
 */
import { memo } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, View } from "react-native";
import type { PendingAttachment } from "../client/attachments.ts";
import { fmtBytes } from "../client/chat-logic.ts";
import { errorCopy } from "../client/errors.ts";
import { useTheme } from "../theme/theme.tsx";
import { haptic } from "../ui/haptics.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { Text } from "../ui/Text.tsx";

/** Side of an image chip's thumbnail. */
const THUMB = 44;

function Chip({
  item,
  locked,
  onRemove,
  onRetry,
}: {
  item: PendingAttachment;
  /** An upload is running: the tray is what is being sent, so nothing leaves it. */
  locked: boolean;
  onRemove(): void;
  onRetry(): void;
}) {
  const t = useTheme();
  const failed = item.status === "failed";
  const copy = failed && item.error ? errorCopy(item.error) : null;
  return (
    <View
      testID={`attachment-${item.local_id}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: t.c.bg2,
        borderWidth: t.border.row,
        borderColor: t.c.line,
        borderLeftWidth: failed ? t.border.control : t.border.row,
        borderLeftColor: failed ? t.c.bad : t.c.line,
        maxWidth: 260,
      }}
    >
      {item.kind === "image" ? (
        <Image
          accessibilityLabel={item.name}
          source={{ uri: item.uri }}
          style={{ width: THUMB, height: THUMB, backgroundColor: t.c.bg3 }}
          resizeMode="cover"
        />
      ) : null}
      <View
        style={{
          flexShrink: 1,
          paddingLeft: t.space.sm,
          paddingVertical: t.space.xs,
          gap: 2,
        }}
      >
        {item.kind === "image" && !failed ? null : (
          <Text mono variant="caption" numberOfLines={1} style={{ maxWidth: 150 }}>
            {item.name}
          </Text>
        )}
        {copy ? (
          <Text variant="caption" tone="bad" numberOfLines={2} style={{ maxWidth: 150 }}>
            {copy.title}
          </Text>
        ) : item.kind === "file" ? (
          <Text mono variant="caption" tone="fg3" numberOfLines={1}>
            {item.size > 0 ? fmtBytes(item.size) : "file"}
          </Text>
        ) : null}
      </View>
      {item.status === "staging" ? (
        <ActivityIndicator
          accessibilityLabel={`Uploading ${item.name}`}
          size="small"
          color={t.c.fg2}
          style={{ marginLeft: t.space.sm }}
        />
      ) : null}
      {failed ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Retry ${item.name}`}
          onPress={() => {
            haptic.select();
            onRetry();
          }}
          style={({ pressed }) => ({
            minHeight: t.touch.min,
            justifyContent: "center",
            paddingLeft: t.space.sm,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text variant="bodySmall" weight={700} tone="acc">
            Retry
          </Text>
        </Pressable>
      ) : null}
      <IconButton
        icon="close"
        label={`Remove ${item.name}`}
        ring={false}
        size={36}
        disabled={locked}
        onPress={() => {
          haptic.select();
          onRemove();
        }}
      />
    </View>
  );
}

export interface AttachTrayProps {
  items: readonly PendingAttachment[];
  onRemove(local_id: string): void;
  onRetry(local_id: string): void;
}

function AttachTrayImpl({ items, onRemove, onRetry }: AttachTrayProps) {
  const t = useTheme();
  if (items.length === 0) return null;
  const locked = items.some((item) => item.status === "staging");
  return (
    <ScrollView
      testID="attach-tray"
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: t.space.xs, alignItems: "stretch" }}
    >
      {items.map((item) => (
        <Chip
          key={item.local_id}
          item={item}
          locked={locked}
          onRemove={() => onRemove(item.local_id)}
          onRetry={() => onRetry(item.local_id)}
        />
      ))}
    </ScrollView>
  );
}

export const AttachTray = memo(AttachTrayImpl);
