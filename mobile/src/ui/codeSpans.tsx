/**
 * Plain product copy names commands in backticks ("Run `hermetic mobile pair`
 * on the laptop"). Inside a `Text`, `codeSpans(text)` shows those runs in mono
 * instead of printing the backticks. Unpaired backticks are left as they are.
 */
import type { ReactNode } from "react";
import { Text, type TextVariant } from "./Text.tsx";

export function codeSpans(text: string, variant: TextVariant = "bodySmall"): ReactNode {
  const parts = text.split("`");
  if (parts.length < 3 || parts.length % 2 === 0) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <Text key={`${i}:${part}`} mono variant={variant} tone="fg">
        {part}
      </Text>
    ) : (
      part
    ),
  );
}
