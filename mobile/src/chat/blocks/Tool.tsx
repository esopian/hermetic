/**
 * `tool` — one renderer, switching on the `render` hint and the status
 * (desktop `blocks/Tool.tsx`). Running: an accent card with a moving bar.
 * Settled: a collapsed card whose seam says the verdict; opened, the
 * arguments and the result, drawn per hint (diff, table, terminal, image).
 * Images are never fetched — a phone fetching a URL a model wrote is the
 * same off-tailnet request the desktop refuses to make.
 */
import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { fmtMs, formatPayload, toolVerdict } from "../../client/chat-logic.ts";
import { resultText, subjectOf, tableOf } from "../../client/chat-turns.ts";
import type { ToolBlock as ToolBlockType } from "@hermetic/core/chat-client";
import { useTheme } from "../../theme/theme.tsx";
import { Text } from "../../ui/Text.tsx";
import { Card } from "../Card.tsx";
import { Label } from "./SoftCard.tsx";
import { CodePane } from "../CodePane.tsx";

function RunningBar() {
  const t = useTheme();
  const x = useSharedValue(0);
  useEffect(() => {
    x.value = withRepeat(withTiming(1, { duration: 1100 }), -1, false);
    return () => cancelAnimation(x);
  }, [x]);
  const style = useAnimatedStyle(() => ({ left: `${x.value * 75}%` }));
  return (
    <View style={{ height: 3, borderRadius: 1.5, backgroundColor: t.c.bg3, overflow: "hidden" }}>
      <Animated.View
        style={[
          { position: "absolute", top: 0, bottom: 0, width: "25%", backgroundColor: t.c.acc },
          style,
        ]}
      />
    </View>
  );
}

function TableResult({ result }: { result: unknown }) {
  const t = useTheme();
  const table = tableOf(result);
  if (!table) return <CodePane text={resultText(result)} />;
  const lines = [
    ...(table.columns.length ? [table.columns.join(" │ ")] : []),
    ...table.rows.map((row) =>
      row.map((cell) => (cell === null || cell === undefined ? "—" : String(cell))).join(" │ "),
    ),
  ];
  return (
    <View style={{ gap: t.space.xs }}>
      <CodePane text={lines.join("\n")} lang={`${table.rows.length} rows`} />
    </View>
  );
}

function ShotResult({ result }: { result: unknown }) {
  const href =
    typeof result === "string"
      ? result
      : result && typeof result === "object"
        ? ((result as { href?: unknown }).href ?? (result as { url?: unknown }).url)
        : null;
  return (
    <Text mono variant="caption" tone="fg3">
      {typeof href === "string" && href.length > 0
        ? `image not fetched — ${href} is not loaded on the phone`
        : "image · not fetched"}
    </Text>
  );
}

export function ToolResult({ block }: { block: ToolBlockType }) {
  const t = useTheme();
  const text = resultText(block.result);
  switch (block.render) {
    case "diff":
      return (
        <CodePane
          text={text}
          lang="diff"
          lineTone={(line) =>
            line.startsWith("@@")
              ? t.c.acc
              : line.startsWith("+")
                ? t.c.ok
                : line.startsWith("-")
                  ? t.c.bad
                  : null
          }
        />
      );
    case "table":
      return <TableResult result={block.result} />;
    case "image":
    case "screenshot":
      return <ShotResult result={block.result} />;
    case "terminal":
      return <CodePane text={text || "(no output)"} lang="terminal" />;
    default:
      return <CodePane text={text || "(no output)"} />;
  }
}

export function ToolBlock({ block }: { block: ToolBlockType }) {
  const t = useTheme();
  const verdict = toolVerdict(block.status);
  const running = block.status === "running";
  const right = running
    ? `running${block.duration_ms ? ` · ${fmtMs(block.duration_ms)}` : ""}`
    : [
        block.exit_code === null || block.exit_code === undefined ? null : `exit ${block.exit_code}`,
        fmtMs(block.duration_ms) || null,
      ]
        .filter(Boolean)
        .join(" · ") || block.status;
  const head = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, flexShrink: 1 }}>
      {block.server ? (
        <Text
          mono
          variant="caption"
          tone="fg2"
          style={{
            backgroundColor: t.c.sel,
            borderRadius: 6,
            overflow: "hidden",
            paddingHorizontal: 6,
          }}
          numberOfLines={1}
        >
          {`mcp · ${block.server}`}
        </Text>
      ) : null}
      <Text mono weight={700} variant="bodySmall" tone={running ? "acc" : "fg"} numberOfLines={1}>
        {running ? `● ${block.name}` : block.name}
      </Text>
    </View>
  );
  return (
    <Card
      verdict={verdict}
      head={head}
      right={right}
      subject={subjectOf(block.args)}
      collapsible={!running}
      testID={`tool-${block.tool_id ?? block.name}`}
    >
      {running ? (
        <View style={{ gap: t.space.sm }}>
          <RunningBar />
          <Text mono variant="caption" tone="fg3">
            running on the box
          </Text>
        </View>
      ) : (
        <>
          <Label>Arguments</Label>
          <CodePane text={formatPayload(block.args)} lang="json" />
          <Label>Result</Label>
          <ToolResult block={block} />
        </>
      )}
    </Card>
  );
}
