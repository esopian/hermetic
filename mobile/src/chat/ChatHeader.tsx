/**
 * The conversation's bar, in the home's soft chrome: a round back button, the
 * bot's round avatar and name (a tap opens the session switcher; a separate session
 * names itself under the name), and one overflow button for the rest
 * (`conversationMenu`). Drawn in the screen, not by the native header, so a
 * streamed delta re-renders this memoised bar and never resets screen options.
 */
import { memo } from "react";
import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/theme.tsx";
import type { AvatarActivity, AvatarStatus } from "../ui/avatar/avatar-seed.ts";
import { Avatar } from "../ui/avatar/Avatar.tsx";
import { haptic } from "../ui/haptics.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { Text } from "../ui/Text.tsx";

export interface ChatHeaderProps {
  fleetId: string;
  instance: string;
  bot: string;
  title: string;
  /** The session's name when it is not the Bot Chat, else null. */
  session: string | null;
  status: AvatarStatus;
  activity: AvatarActivity;
  onBack(): void;
  onSessions(): void;
  onMore(): void;
}

function ChatHeaderImpl({
  fleetId,
  instance,
  bot,
  title,
  session,
  status,
  activity,
  onBack,
  onSessions,
  onMore,
}: ChatHeaderProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.sm,
        paddingTop: insets.top + t.space.xs,
        paddingBottom: t.space.sm,
        paddingHorizontal: t.space.md,
        backgroundColor: t.c.bg,
        // The transcript scrolls up to this rule, not under the bar.
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: t.c.line,
      }}
    >
      {/* 36pt drawn, the round buttons of the home bar; the tap target stays 44pt. */}
      <IconButton icon="back" label="Back" size={BUTTON} onPress={onBack} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${session ?? "Bot Chat"}. Switch session`}
        onPress={() => {
          haptic.select();
          onSessions();
        }}
        style={({ pressed }) => ({
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: t.space.sm,
          minHeight: t.touch.min,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        {/* Unlabelled: the button's own label says who this is. */}
        <Avatar
          fleet_id={fleetId}
          instance={instance}
          bot={bot}
          size={32}
          status={status}
          activity={activity}
        />
        <View style={{ flexShrink: 1 }}>
          <Text weight={600} numberOfLines={1} style={{ fontSize: 17, lineHeight: 21 }}>
            {title}
          </Text>
          {session ? (
            <Text variant="bodySmall" tone="fg2" numberOfLines={1}>
              {session}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <IconButton icon="more" label="More" size={BUTTON} onPress={onMore} />
    </View>
  );
}

export const ChatHeader = memo(ChatHeaderImpl);

const BUTTON = 36;

export interface ConversationMenu {
  sessions(): void;
  browser(): void;
  markRead(): void;
}

/** The overflow menu: Sessions, Agent browser, Mark read, Cancel. `tint` colours its buttons. */
export function conversationMenu(title: string, tint: string, actions: ConversationMenu): void {
  haptic.light();
  const items: [string, () => void][] = [
    ["Sessions", actions.sessions],
    ["Agent browser", actions.browser],
    ["Mark read", actions.markRead],
  ];
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: [...items.map(([label]) => label), "Cancel"],
        cancelButtonIndex: items.length,
        tintColor: tint,
      },
      (index) => items[index]?.[1](),
    );
    return;
  }
  Alert.alert(title, undefined, [
    ...items.map(([text, onPress]) => ({ text, onPress })),
    { text: "Cancel", style: "cancel" as const },
  ]);
}
