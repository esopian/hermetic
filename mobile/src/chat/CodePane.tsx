/**
 * Monospace text that keeps its lines: horizontal scroll rather than wrap,
 * selectable, and a Copy button that says it copied. Fenced code blocks, tool
 * output and payloads all draw through this. Square, a `bg3` fill and a 1px
 * `line` border, with a mono head row (language, Copy) over a hairline.
 */
import * as Clipboard from "expo-clipboard";
import { memo, useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useTheme } from "../theme/theme.tsx";
import { haptic } from "../ui/haptics.ts";
import { Text } from "../ui/Text.tsx";

/** Past this many lines a pane starts clipped, with "Show all N lines". */
const CLIP_LINES = 40;

function CodePaneImpl({
  text,
  lang,
  copy = true,
  wrap = false,
  lineTone,
  fill,
}: {
  text: string;
  lang?: string | null;
  copy?: boolean;
  /** Wrap long lines instead of scrolling (prose-like payloads). */
  wrap?: boolean;
  /** Per-line colour (a diff's adds and dels). */
  lineTone?: (line: string) => string | null;
  /** The pane's fill, where `bg3` would not stand off its surface (the operator's panel is `sel`). */
  fill?: string;
}) {
  const t = useTheme();
  const [copied, setCopied] = useState(false);
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const lines = text.split("\n");
  const clipped = !all && lines.length > CLIP_LINES;
  const shown = clipped ? lines.slice(0, CLIP_LINES) : lines;
  const body = (
    <View
      style={{
        paddingHorizontal: t.space.md,
        paddingTop: lang || copy ? 0 : t.space.sm,
        paddingBottom: t.space.sm,
      }}
    >
      {lineTone ? (
        shown.map((line, i) => (
          <Text
            key={i}
            selectable
            mono
            variant="mono"
            style={{ color: lineTone(line) ?? t.c.fg, fontSize: 12, lineHeight: 17 }}
          >
            {line || " "}
          </Text>
        ))
      ) : (
        <Text selectable mono variant="mono" style={{ fontSize: 12, lineHeight: 17 }}>
          {shown.join("\n")}
        </Text>
      )}
    </View>
  );
  return (
    <View
      style={{
        backgroundColor: fill ?? t.c.bg3,
        borderWidth: t.border.row,
        borderColor: t.c.line,
        overflow: "hidden",
      }}
    >
      {lang || copy ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingLeft: t.space.md,
            minHeight: 30,
            borderBottomWidth: t.border.row,
            borderBottomColor: t.c.line,
            marginBottom: t.space.sm,
          }}
        >
          <Text mono variant="caption" tone="fg3" style={{ flex: 1 }} numberOfLines={1}>
            {lang ?? ""}
          </Text>
          {copy ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copied ? "Copied" : "Copy code"}
              hitSlop={8}
              onPress={() => {
                void Clipboard.setStringAsync(text)
                  .then(() => {
                    haptic.success();
                    setCopied(true);
                  })
                  .catch(() => {});
              }}
              style={{ paddingHorizontal: t.space.md, paddingVertical: 6 }}
            >
              <Text variant="caption" tone={copied ? "ok" : "fg2"} weight={600}>
                {copied ? "Copied" : "Copy"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {wrap ? (
        body
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator bounces={false}>
          {body}
        </ScrollView>
      )}
      {clipped ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setAll(true)}
          style={{ paddingHorizontal: t.space.md, paddingVertical: t.space.sm }}
        >
          <Text variant="caption" weight={600} tone="fg2">
            {`Show all ${lines.length} lines`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export const CodePane = memo(CodePaneImpl);
