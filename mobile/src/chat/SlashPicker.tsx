/**
 * The slash-command list over the composer: the gateway's catalog, filtered as
 * a command name is typed (`slashQuery` and friends, `@hermetic/core/shared`,
 * the desktop's own rules). Tapping a row puts `/name ` in the composer.
 */
import type { ChatCommand } from "@hermetic/core/schema";
import { acceptSlash, filterSlashCommands, slashQuery } from "@hermetic/core/shared";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useTheme } from "../theme/theme.tsx";
import { Text } from "../ui/Text.tsx";

/** Where the catalog comes from: `key` names the instance/bot it is cached under. */
export interface SlashSource {
  key: string;
  load(): Promise<{ commands: ChatCommand[] }>;
}

// One fetch per instance/bot for the app's life; a failed one is dropped so
// the next `/` asks again (an adapter with no catalog throws `UNSUPPORTED`).
const catalogs = new Map<string, Promise<ChatCommand[]>>();

function catalog(source: SlashSource): Promise<ChatCommand[]> {
  let found = catalogs.get(source.key);
  if (!found) {
    found = source.load().then((r) => r.commands);
    found.catch(() => catalogs.delete(source.key));
    catalogs.set(source.key, found);
  }
  return found;
}

/** Test seam: forget every cached catalog. */
export function resetSlashCatalogs(): void {
  catalogs.clear();
}

export function SlashPicker({
  text,
  source,
  onPick,
}: {
  text: string;
  source: SlashSource;
  onPick(text: string): void;
}) {
  const t = useTheme();
  const query = slashQuery(text);
  const open = query !== null;
  const [commands, setCommands] = useState<{ key: string; list: ChatCommand[] } | null>(null);

  useEffect(() => {
    if (!open || commands?.key === source.key) return;
    let live = true;
    catalog(source).then(
      (list) => live && setCommands({ key: source.key, list }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [open, source, commands?.key]);

  if (query === null || commands?.key !== source.key) return null;
  const rows = filterSlashCommands(commands.list, query);
  if (rows.length === 0) return null;
  return (
    <View
      accessibilityRole="menu"
      accessibilityLabel="Slash commands"
      style={{
        maxHeight: t.touch.min * 5,
        borderWidth: t.border.row,
        borderColor: t.c.line2,
        backgroundColor: t.c.bg2,
      }}
    >
      <ScrollView keyboardShouldPersistTaps="always">
        {rows.map(({ command }, index) => (
          <Pressable
            key={command.name}
            accessibilityRole="menuitem"
            accessibilityLabel={
              command.description ? `${command.name}, ${command.description}` : command.name
            }
            onPress={() => onPick(acceptSlash(command))}
            style={({ pressed }) => ({
              minHeight: t.touch.min,
              justifyContent: "center",
              paddingHorizontal: t.space.md,
              paddingVertical: t.space.xs,
              borderTopWidth: index === 0 ? 0 : t.border.row,
              borderColor: t.c.line2,
              backgroundColor: pressed ? t.c.bg3 : "transparent",
            })}
          >
            <Text variant="mono">{command.name}</Text>
            {command.description ? (
              <Text variant="caption" tone="fg3" numberOfLines={1}>
                {command.description}
              </Text>
            ) : null}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
