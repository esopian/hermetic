/**
 * The operator's own words (desktop `blocks/Text.tsx` `PlainText`): no
 * markdown beyond fenced blocks and backtick code, every space and newline
 * kept. A stray `**` or `$x$` the operator typed stays the characters it is.
 */
import { memo } from "react";
import { View } from "react-native";
import { useTheme } from "../theme/theme.tsx";
import { Text } from "../ui/Text.tsx";
import { CodePane } from "./CodePane.tsx";
import { plainSegments } from "./text-layout.ts";

function PlainTextImpl({ text }: { text: string }) {
  const t = useTheme();
  const segments = plainSegments(text);
  // The common case — one run of prose, no code — stays a single `<Text>`.
  if (segments.length === 1 && segments[0]?.kind === "inline" && !segments[0].parts.some((p) => p.code))
    return <Text selectable>{text}</Text>;
  return (
    <View style={{ gap: t.space.xs }}>
      {segments.map((seg, i) =>
        seg.kind === "fence" ? (
          // Wrapped rather than scrolled: the bubble shrinks to its content,
          // and a horizontal scroller inside a shrink-wrapped box has no width.
          <CodePane key={i} text={seg.text} copy={false} wrap />
        ) : (
          <Text key={i} selectable>
            {seg.parts.map((part, n) =>
              part.code ? (
                <Text key={n} mono style={{ fontSize: 13, backgroundColor: t.c.bg, color: t.c.fg }}>
                  {` ${part.text} `}
                </Text>
              ) : (
                part.text
              ),
            )}
          </Text>
        ),
      )}
    </View>
  );
}

export const PlainText = memo(PlainTextImpl);
