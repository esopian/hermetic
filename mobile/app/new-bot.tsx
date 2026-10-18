/**
 * New bot (a form sheet, from the New chat sheet's "New bot…" row): create a
 * Bot Mode bot on one listened instance (`HermeticClient.createBot`, the
 * desktop's `bots.create`), then open its chat. The instance defaults to the
 * primary; a phone listening to one instance shows it as a fixed line. The name
 * is kept lowercase and checked against core's `BotName` as it is typed.
 */
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  botNameError,
  createBotErrorCopy,
  defaultBotInstance,
  normalizeBotName,
} from "../src/bots/new-bot.ts";
import { useFleetContext } from "../src/fleet/FleetProvider.tsx";
import { useFleetState } from "../src/fleet/hooks.ts";
import { useTheme } from "../src/theme/theme.tsx";
import { haptic } from "../src/ui/haptics.ts";
import { Button, Kicker, Screen, Text } from "../src/ui/index.ts";
import { multilineTint } from "../src/ui/tint.ts";

const TITLE_MAX = 64;
const DESCRIPTION_MAX = 1000;

export const chatPathFor = (instance: string, name: string): string =>
  `/chat/${encodeURIComponent(instance)}/${encodeURIComponent(name)}`;

export default function NewBot() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { client, fleet, primary } = useFleetContext();
  const fleetState = useFleetState();
  const listened = useMemo(() => fleet.listened(), [fleet, fleetState]);
  const [chosen, setChosen] = useState<string | null>(null);
  const instance = chosen && listened.includes(chosen) ? chosen : defaultBotInstance(listened, primary);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const nameError = botNameError(name);
  const ready = !!client && !!instance && name.length > 0 && nameError === null && !busy;

  const create = async () => {
    if (!ready || !client || !instance) return;
    setBusy(true);
    setError(null);
    try {
      const trimmedTitle = title.trim();
      const trimmedDescription = description.trim();
      await client.createBot(instance, {
        name,
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
        ...(trimmedDescription ? { description: trimmedDescription } : {}),
      });
      haptic.success();
      // Close the sheet, then go: pushed from inside it, the chat lands in the sheet's context.
      router.back();
      router.push(chatPathFor(instance, name) as never);
    } catch (e) {
      haptic.error();
      setError(createBotErrorCopy(e, name, instance));
      setBusy(false);
    }
  };

  const field = {
    borderWidth: t.border.row,
    borderColor: t.c.line2,
    backgroundColor: t.c.bg2,
    color: t.c.fg,
    fontFamily: t.sans(400),
    fontSize: 16,
    paddingHorizontal: t.space.md,
    paddingVertical: t.space.sm,
    minHeight: t.touch.min,
  } as const;
  const inputProps = {
    keyboardAppearance: t.scheme,
    selectionColor: multilineTint(t.c.acc),
    cursorColor: t.c.acc,
    placeholderTextColor: t.c.fg3,
    editable: !busy,
  } as const;

  return (
    // Clears the status bar when pushed full-screen; a form sheet measures no top inset.
    <Screen edges={["top"]} background={t.c.bg2}>
      <ScrollView
        // The sheet's raised surface (`contentStyle` in `_layout.tsx`), not the page colour.
        style={{ flex: 1, backgroundColor: t.c.bg2 }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: t.space.lg + t.space.xs,
          paddingTop: t.space.xl,
          paddingBottom: insets.bottom + t.space.xl,
          gap: t.space.lg,
        }}
      >
        <View style={{ gap: 4 }}>
          <Text variant="heading" accessibilityRole="header">
            New bot
          </Text>
          <Text variant="bodySmall" tone="fg3">
            A new Bot Mode profile on one of the instances this phone listens to.
          </Text>
        </View>

        <View style={{ gap: t.space.sm }}>
          <Kicker>Instance</Kicker>
          {listened.length === 0 ? (
            <Text tone="fg3">
              This phone listens to no instance yet. Add one in Settings › Listening.
            </Text>
          ) : listened.length === 1 ? (
            <View
              testID="new-bot-instance"
              style={{
                ...field,
                justifyContent: "center",
                borderColor: t.c.line,
              }}
            >
              <Text mono>{listened[0]}</Text>
            </View>
          ) : (
            <View
              accessibilityRole="radiogroup"
              style={{ borderWidth: t.border.row, borderColor: t.c.line2 }}
            >
              {listened.map((name, i) => {
                const on = name === instance;
                return (
                  <Pressable
                    key={name}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on, disabled: busy }}
                    accessibilityLabel={name === primary ? `${name}, primary` : name}
                    disabled={busy}
                    onPress={() => {
                      haptic.select();
                      setChosen(name);
                    }}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: t.space.md,
                      minHeight: t.touch.min,
                      paddingHorizontal: t.space.md,
                      borderTopWidth: i === 0 ? 0 : t.border.row,
                      borderTopColor: t.c.line,
                      backgroundColor: on ? t.c.sel : pressed ? t.c.bg3 : "transparent",
                    })}
                  >
                    <View
                      style={{
                        width: 16,
                        height: 16,
                        alignItems: "center",
                        justifyContent: "center",
                        borderWidth: t.border.control,
                        borderColor: on ? t.c.fg : t.c.line2,
                      }}
                    >
                      {on ? <View style={{ width: 8, height: 8, backgroundColor: t.c.fg }} /> : null}
                    </View>
                    <Text mono style={{ flex: 1 }}>
                      {name}
                    </Text>
                    {name === primary ? <Kicker>Primary</Kicker> : null}
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>

        <View style={{ gap: t.space.sm }}>
          <Kicker>Name</Kicker>
          <TextInput
            {...inputProps}
            accessibilityLabel="Bot name"
            value={name}
            onChangeText={(v) => {
              setName(normalizeBotName(v));
              setError(null);
            }}
            placeholder="scribe"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            maxLength={80}
            style={{ ...field, fontFamily: t.mono(400), borderColor: nameError ? t.c.bad : t.c.line2 }}
          />
          {nameError ? (
            <Text variant="bodySmall" tone="bad" accessibilityRole="alert">
              {nameError}
            </Text>
          ) : (
            <Text variant="bodySmall" tone="fg3">
              Lowercase letters, digits, dots, underscores and hyphens. It names the profile on the box.
            </Text>
          )}
        </View>

        <View style={{ gap: t.space.sm }}>
          <Kicker>Title (optional)</Kicker>
          <TextInput
            {...inputProps}
            accessibilityLabel="Bot title"
            value={title}
            onChangeText={setTitle}
            placeholder="Digest writer"
            maxLength={TITLE_MAX}
            style={field}
          />
        </View>

        <View style={{ gap: t.space.sm }}>
          <Kicker>Description (optional)</Kicker>
          <TextInput
            {...inputProps}
            accessibilityLabel="Bot description"
            value={description}
            onChangeText={setDescription}
            placeholder="What this bot is for"
            maxLength={DESCRIPTION_MAX}
            multiline
            textAlignVertical="top"
            style={{ ...field, minHeight: 96 }}
          />
        </View>

        {error ? (
          <View
            accessibilityRole="alert"
            testID="new-bot-error"
            style={{
              borderLeftWidth: t.border.control,
              borderLeftColor: t.c.bad,
              paddingLeft: t.space.md,
              gap: 2,
            }}
          >
            <Text weight={700} tone="bad">
              {error.title}
            </Text>
            {error.detail ? (
              <Text variant="bodySmall" tone="fg2">
                {error.detail}
              </Text>
            ) : null}
          </View>
        ) : null}

        <Button
          label={busy ? "Creating…" : "Create"}
          accessibilityLabel="Create bot"
          busy={busy}
          disabled={!ready}
          onPress={() => void create()}
        />
      </ScrollView>
    </Screen>
  );
}
