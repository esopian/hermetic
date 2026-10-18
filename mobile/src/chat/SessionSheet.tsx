/**
 * The session switcher: the bot's canonical "Bot Chat" on top, its other
 * sessions under it (`chat.sessions`), and "+ New session", which opens one
 * (`chat.open {new_session:true}`) and switches to it.
 */
import { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { railTime } from "../client/chat-logic.ts";
import type { Session } from "@hermetic/core/chat-client";
import { useTheme } from "../theme/theme.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { haptic } from "../ui/haptics.ts";
import { Kicker } from "../ui/Kicker.tsx";
import { Text } from "../ui/Text.tsx";

export function sessionLabel(session: Session | null | undefined): string {
  if (!session || session.kind === "canonical") return "Bot Chat";
  return session.title?.trim() || session.id.slice(0, 12);
}

function Row({
  title,
  sub,
  right,
  unread,
  selected,
  onPress,
}: {
  title: string;
  sub?: string | null;
  right?: string;
  unread?: number;
  selected: boolean;
  onPress(): void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.md,
        minHeight: 56,
        paddingHorizontal: t.space.lg,
        borderBottomWidth: 1,
        borderBottomColor: t.c.line,
        borderLeftWidth: t.border.seam,
        borderLeftColor: selected ? t.c.acc : "transparent",
        backgroundColor: pressed ? t.c.sel : t.c.bg,
      })}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text weight={700} numberOfLines={1}>
          {title}
        </Text>
        {sub ? (
          <Text variant="caption" tone="fg3" numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      {right ? (
        <Text mono variant="caption" tone="fg3">
          {right}
        </Text>
      ) : null}
      <Badge label={unread ? String(unread) : null} />
    </Pressable>
  );
}

export function SessionSheet({
  visible,
  sessions,
  current,
  now,
  onSelect,
  onNew,
  onClose,
}: {
  visible: boolean;
  sessions: readonly Session[];
  /** The session on screen; `null` is Bot Chat. */
  current: string | null;
  now: number;
  onSelect(session: string | null): void;
  onNew(): Promise<void>;
  onClose(): void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canonical = sessions.find((s) => s.kind === "canonical") ?? null;
  const others = sessions.filter((s) => s.kind !== "canonical");
  const onCanonical = current === null || current === canonical?.id;
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: t.c.bg }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            padding: t.space.lg,
            borderBottomWidth: t.border.control,
            borderBottomColor: t.c.fg,
          }}
        >
          <Text variant="heading" style={{ flex: 1 }}>
            Sessions
          </Text>
          <Button label="Done" variant="secondary" compact onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + t.space.xl }}>
          <View style={{ paddingHorizontal: t.space.lg, paddingVertical: t.space.sm }}>
            <Kicker>Canonical</Kicker>
          </View>
          <Row
            title="Bot Chat"
            sub={canonical?.preview ?? "The bot's own running conversation"}
            right={canonical?.last_message_at ? railTime(canonical.last_message_at, now) : undefined}
            unread={canonical?.unread ?? 0}
            selected={onCanonical}
            onPress={() => {
              haptic.select();
              onSelect(null);
            }}
          />
          <View
            style={{
              paddingHorizontal: t.space.lg,
              paddingVertical: t.space.sm,
              marginTop: t.space.md,
            }}
          >
            <Kicker>{`Other sessions · ${others.length}`}</Kicker>
          </View>
          {others.length === 0 ? (
            <Text variant="bodySmall" tone="fg3" style={{ paddingHorizontal: t.space.lg }}>
              None yet. Routines, Slack threads and sessions started elsewhere appear here.
            </Text>
          ) : (
            others.map((s) => (
              <Row
                key={s.id}
                title={sessionLabel(s)}
                sub={[s.origin, s.preview].filter(Boolean).join(" · ")}
                right={s.last_message_at ? railTime(s.last_message_at, now) : undefined}
                unread={s.unread}
                selected={current === s.id}
                onPress={() => {
                  haptic.select();
                  onSelect(s.id);
                }}
              />
            ))
          )}
          <View style={{ padding: t.space.lg, gap: t.space.sm }}>
            <Button
              label="+ New session"
              variant="secondary"
              busy={busy}
              onPress={() => {
                setBusy(true);
                setError(null);
                onNew()
                  .catch((e: unknown) => {
                    haptic.error();
                    setError(e instanceof Error ? e.message : String(e));
                  })
                  .finally(() => setBusy(false));
              }}
            />
            {error ? (
              <Text variant="caption" tone="bad">
                {error}
              </Text>
            ) : null}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
