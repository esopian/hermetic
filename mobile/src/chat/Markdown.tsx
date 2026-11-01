/**
 * Markdown nodes → React Native (desktop `blocks/Text.tsx`). The parser is the
 * desktop's own (`client/markdown.ts`, byte-identical); this only draws its
 * nodes. Links open in the system browser only when `openableHref` allows
 * them — anything else is drawn as `text (href)`, as the desktop draws a link
 * it refuses. Math is shown as its TeX source in mono (no KaTeX on a phone).
 * An image (`![alt](url)`) is drawn as a picture between the paragraph's words,
 * with its alt text as a mono caption, when `file-urls.ts` lets the phone load
 * it (a file on the conversation's box, or `https:`); otherwise as its alt text.
 */
import { createContext, memo, type ReactNode, useContext, useMemo } from "react";
import { Linking, ScrollView, type TextStyle, View } from "react-native";
import { openableHref } from "../client/chat-logic.ts";
import { imageSourceOf } from "../client/file-urls.ts";
import { hasImage, splitImages } from "../client/markdown-images.ts";
import { type MdList, type MdNode, type MdSpan, parseMarkdown } from "../client/markdown.ts";
import { useTheme } from "../theme/theme.tsx";
import { Text, type TextProps } from "../ui/Text.tsx";
import { Picture } from "./blocks/Picture.tsx";
import { CodePane } from "./CodePane.tsx";
import { collapseSpaces } from "./text-layout.ts";

const HEADING: Record<number, { size: number; line: number }> = {
  1: { size: 22, line: 27 },
  2: { size: 19, line: 24 },
  3: { size: 17, line: 22 },
  4: { size: 15, line: 21 },
  5: { size: 15, line: 21 },
  6: { size: 15, line: 21 },
};

/** Prose still arriving: one step smaller and muted, bold and code with it. */
const Quiet = createContext(false);

function MdText(props: TextProps) {
  const quiet = useContext(Quiet);
  return <Text {...(quiet ? ({ variant: "bodySmall", tone: "fg2" } as const) : null)} {...props} />;
}

function Spans({ spans, base }: { spans: MdSpan[]; base?: TextStyle }): ReactNode {
  const t = useTheme();
  const quiet = useContext(Quiet);
  return spans.map((span, i) => {
    const key = `${span.type}:${i}`;
    switch (span.type) {
      case "code":
        return (
          <MdText
            key={key}
            mono
            style={[
              base,
              { fontSize: quiet ? 12 : 13, backgroundColor: t.c.bg3, color: quiet ? t.c.fg2 : t.c.fg },
            ]}
          >{` ${collapseSpaces(span.text)} `}</MdText>
        );
      case "math":
        return (
          <MdText key={key} mono style={[base, { fontSize: 13, fontStyle: "italic", color: t.c.fg2 }]}>
            {span.text}
          </MdText>
        );
      case "strong":
        return (
          <MdText key={key} style={[base, { fontFamily: t.sans(700) }]}>
            {span.spans ? (
              <Spans spans={span.spans} base={{ fontFamily: t.sans(700) }} />
            ) : (
              collapseSpaces(span.text)
            )}
          </MdText>
        );
      case "em":
        return (
          <MdText key={key} style={[base, { fontStyle: "italic" }]}>
            {span.spans ? (
              <Spans spans={span.spans} base={{ fontStyle: "italic" }} />
            ) : (
              collapseSpaces(span.text)
            )}
          </MdText>
        );
      case "del":
        return (
          <MdText key={key} style={[base, { textDecorationLine: "line-through", color: t.c.fg2 }]}>
            {span.spans ? <Spans spans={span.spans} /> : collapseSpaces(span.text)}
          </MdText>
        );
      case "link": {
        const href = openableHref(span.href);
        if (href === null)
          return (
            <MdText key={key} style={base}>
              {`${span.text} (${span.href})`}
            </MdText>
          );
        return (
          <MdText
            key={key}
            accessibilityRole="link"
            onPress={() => void Linking.openURL(href).catch(() => {})}
            style={[base, { color: t.c.acc, textDecorationLine: "underline" }]}
          >
            {span.spans ? <Spans spans={span.spans} /> : collapseSpaces(span.text)}
          </MdText>
        );
      }
      case "cite":
        return (
          <MdText key={key} mono style={[base, { fontSize: 11, color: t.c.acc }]}>
            {`[${span.n}]`}
          </MdText>
        );
      // A newline inside a paragraph: the desktop's `<br>` (`breaks` semantics).
      case "br":
        return <MdText key={key}>{"\n"}</MdText>;
      default:
        return (
          <MdText key={key} style={base}>
            {collapseSpaces(span.text)}
          </MdText>
        );
    }
  });
}

function List({ node, depth }: { node: MdList; depth: number }) {
  const t = useTheme();
  return (
    <View style={{ gap: 2, paddingLeft: depth > 0 ? t.space.lg : 0 }}>
      {node.items.map((item, i) => (
        <View key={i}>
          <View style={{ flexDirection: "row", gap: t.space.sm }}>
            <MdText mono tone="fg3" style={{ minWidth: node.ordered ? 22 : 12, textAlign: "right" }}>
              {item.checked === true
                ? "☑"
                : item.checked === false
                  ? "☐"
                  : node.ordered
                    ? `${i + 1}.`
                    : depth % 2 === 0
                      ? "•"
                      : "◦"}
            </MdText>
            <MdText selectable style={{ flex: 1 }}>
              <Spans spans={item.spans} />
            </MdText>
          </View>
          {item.lists?.map((list, n) => (
            <List key={n} node={list} depth={depth + 1} />
          ))}
        </View>
      ))}
    </View>
  );
}

function Node({ node }: { node: MdNode }) {
  const t = useTheme();
  switch (node.type) {
    case "h": {
      const h = HEADING[Math.min(Math.max(node.level, 1), 6)] ?? { size: 15, line: 21 };
      return (
        <MdText
          selectable
          accessibilityRole="header"
          weight={800}
          style={{ fontSize: h.size, lineHeight: h.line, marginTop: t.space.xs }}
        >
          <Spans spans={node.spans} />
        </MdText>
      );
    }
    case "quote":
      return (
        <View
          style={{
            borderLeftWidth: t.border.control,
            borderLeftColor: t.c.line2,
            paddingLeft: t.space.md,
          }}
        >
          <MdText selectable tone="fg2">
            <Spans spans={node.spans} />
          </MdText>
        </View>
      );
    case "list":
      return <List node={node} depth={0} />;
    case "code":
      return <CodePane text={node.text} lang={node.lang} />;
    case "math":
      return <CodePane text={node.text} lang="tex" copy={false} />;
    case "hr":
      return <View style={{ height: 1, backgroundColor: t.c.line, marginVertical: t.space.sm }} />;
    case "table":
      return (
        <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator>
          <View style={{ borderWidth: 1, borderColor: t.c.line }}>
            {[node.header, ...node.rows].map((row, r) => (
              <View
                key={r}
                style={{
                  flexDirection: "row",
                  borderTopWidth: r === 0 ? 0 : 1,
                  borderTopColor: t.c.line,
                  backgroundColor: r === 0 ? t.c.bg3 : "transparent",
                }}
              >
                {row.map((cell, c) => (
                  <View
                    key={c}
                    style={{
                      width: 140,
                      padding: t.space.sm,
                      borderLeftWidth: c === 0 ? 0 : 1,
                      borderLeftColor: t.c.line,
                    }}
                  >
                    <MdText
                      selectable
                      variant="bodySmall"
                      weight={r === 0 ? 700 : 400}
                      style={{
                        textAlign:
                          node.align[c] === "right"
                            ? "right"
                            : node.align[c] === "center"
                              ? "center"
                              : "left",
                      }}
                    >
                      <Spans spans={cell} />
                    </MdText>
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    default:
      return hasImage(node.spans) ? (
        <View style={{ gap: t.space.xs }}>
          {splitImages(node.spans).map((piece, i) =>
            piece.kind === "image" ? (
              <MarkdownImage key={`i${i}`} alt={piece.alt} href={piece.href} />
            ) : (
              <MdText key={`s${i}`} selectable>
                <Spans spans={piece.spans} />
              </MdText>
            ),
          )}
        </View>
      ) : (
        <MdText selectable>
          <Spans spans={node.spans} />
        </MdText>
      );
  }
}

function MarkdownImage({ alt, href }: { alt: string; href: string }) {
  const source = imageSourceOf(href);
  if (!source)
    return (
      <MdText mono variant="caption" tone="fg3" testID="markdown-image-refused">
        {`image not loaded · ${alt || href}`}
      </MdText>
    );
  return <Picture source={source} alt={alt} caption />;
}

function MarkdownImpl({
  markdown,
  streaming = false,
  quiet = false,
}: {
  markdown: string;
  streaming?: boolean;
  quiet?: boolean;
}) {
  const t = useTheme();
  const nodes = useMemo(() => parseMarkdown(markdown), [markdown]);
  return (
    <Quiet.Provider value={quiet}>
      <View style={{ gap: quiet ? t.space.xs : t.space.sm }}>
        {nodes.map((node, i) => (
          <Node key={`${node.type}:${i}`} node={node} />
        ))}
        {streaming ? (
          <MdText tone="acc" accessibilityLabel="streaming">
            ▍
          </MdText>
        ) : null}
      </View>
    </Quiet.Provider>
  );
}

export const Markdown = memo(MarkdownImpl);
