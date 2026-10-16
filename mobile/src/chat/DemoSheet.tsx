/**
 * Fixture builds only: the demo prompts, grouped, one square row each. A tap
 * closes the sheet and sends that prompt through the conversation's own send
 * path, so every kind of block the fixture can raise is one tap away.
 *
 * The sheet knows no prompt: the list is the fixture kit's
 * (`FleetContext.fixture.demoPrompts`), and a build without the fixture has
 * none, so the conversation never offers the sheet there.
 */
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { DemoPrompt } from "../fleet/FleetProvider.tsx";
import { useTheme } from "../theme/theme.tsx";
import { Button } from "../ui/Button.tsx";
import { haptic } from "../ui/haptics.ts";
import { Kicker } from "../ui/Kicker.tsx";
import { Text } from "../ui/Text.tsx";

/** The prompts in list order, grouped under the first-seen order of their groups. */
export function demoGroups(prompts: readonly DemoPrompt[]): { group: string; items: DemoPrompt[] }[] {
  const groups = new Map<string, DemoPrompt[]>();
  for (const prompt of prompts) {
    const items = groups.get(prompt.group) ?? [];
    items.push(prompt);
    groups.set(prompt.group, items);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
}

export function DemoSheet({
  visible,
  prompts,
  onPick,
  onClose,
}: {
  visible: boolean;
  prompts: readonly DemoPrompt[];
  onPick(prompt: string): void;
  onClose(): void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
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
            Demo prompts
          </Text>
          <Button label="Done" variant="secondary" compact onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + t.space.xl }}>
          {demoGroups(prompts).map(({ group, items }) => (
            <View key={group}>
              <View
                style={{
                  paddingHorizontal: t.space.lg,
                  paddingTop: t.space.md,
                  paddingBottom: t.space.sm,
                }}
              >
                <Kicker>{`${group} · ${items.length}`}</Kicker>
              </View>
              {items.map((item) => (
                <Pressable
                  key={`${item.group}:${item.label}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${group}: ${item.label}`}
                  onPress={() => {
                    haptic.select();
                    onClose();
                    onPick(item.prompt);
                  }}
                  style={({ pressed }) => ({
                    minHeight: 52,
                    justifyContent: "center",
                    gap: 2,
                    paddingHorizontal: t.space.lg,
                    paddingVertical: t.space.sm,
                    borderTopWidth: t.border.row,
                    borderTopColor: t.c.line,
                    backgroundColor: pressed ? t.c.sel : t.c.bg,
                  })}
                >
                  <Text weight={700} numberOfLines={1}>
                    {item.label}
                  </Text>
                  <Text mono variant="caption" tone="fg3" numberOfLines={1}>
                    {item.prompt}
                  </Text>
                </Pressable>
              ))}
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}
