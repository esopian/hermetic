/**
 * Radius is zero everywhere but avatars (`src/theme/scale.ts`, `docs/ui-brief.md`
 * "Look"). The shared primitives and the chat's cards and composer are
 * rendered and every style in the tree is checked: no corner radius above
 * zero, in any of its spellings.
 */
import { screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { Card } from "../../src/chat/Card.tsx";
import { Composer } from "../../src/chat/Composer.tsx";
import { SoftCard } from "../../src/chat/blocks/SoftCard.tsx";
import { radius } from "../../src/theme/scale.ts";
import { Badge, Button, IconButton, StatusSquare, Text, ToggleSwitch } from "../../src/ui/index.ts";
import { renderUi } from "../helpers/render.tsx";

const RADIUS_KEYS = [
  "borderRadius",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomLeftRadius",
  "borderBottomRightRadius",
  "borderTopStartRadius",
  "borderTopEndRadius",
  "borderBottomStartRadius",
  "borderBottomEndRadius",
] as const;

/** The rendered tree's JSON, as far as this walk needs it. */
interface Node {
  type: string;
  props: { style?: unknown };
  children: (Node | string)[] | null;
}

/** Every `[node type, key, value]` in the rendered tree with a corner radius above zero. */
function roundedCorners(node: Node | Node[] | null): [string, string, number][] {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap(roundedCorners);
  const style = (StyleSheet.flatten(node.props.style as never) ?? {}) as Record<string, unknown>;
  const found: [string, string, number][] = [];
  for (const key of RADIUS_KEYS) {
    const value = style[key];
    if (typeof value === "number" && value > 0) found.push([node.type, key, value]);
  }
  for (const child of node.children ?? []) {
    if (typeof child !== "string") found.push(...roundedCorners(child));
  }
  return found;
}

const noop = () => {};

test("the one radius constant is zero", () => {
  expect(radius).toBe(0);
});

test("shared primitives draw no rounded corners", async () => {
  await renderUi(
    <>
      <Button label="Primary" onPress={noop} haptic={false} />
      <Button label="Secondary" variant="secondary" onPress={noop} haptic={false} />
      <Button label="Delete" variant="destructive" onPress={noop} haptic={false} />
      <Button label="Busy" busy onPress={noop} haptic={false} />
      <Button label="Off" disabled compact onPress={noop} haptic={false} />
      <IconButton icon="gear" label="Settings" onPress={noop} />
      <IconButton icon="back" label="Back" size={36} onPress={noop} />
      <IconButton icon="more" label="More" ring={false} onPress={noop} />
      <StatusSquare status="ready" />
      <StatusSquare status="bootstrapping" size={14} />
      <Badge label="!" />
      <Badge label="3" tone="acc" />
      <ToggleSwitch accessibilityLabel="On" value onValueChange={noop} />
      <ToggleSwitch accessibilityLabel="Off" value={false} onValueChange={noop} />
    </>,
  );
  expect(roundedCorners(screen.toJSON() as Node | Node[] | null)).toEqual([]);
});

test("the chat's card, request card and composer draw no rounded corners", async () => {
  await renderUi(
    <>
      <Card verdict="ok" head="Tool" right="exit 0" subject="ls -la" open>
        <Text>body</Text>
      </Card>
      <Card verdict="muted" head="Reasoning" collapsible>
        <Text>shut</Text>
      </Card>
      <SoftCard edge="#e8b03a">
        <Text>request</Text>
      </SoftCard>
      <Composer
        draft="queued words"
        onDraft={noop}
        enabled
        placeholder="Message…"
        sending
        aborting={false}
        queue={[{ id: "q1", text: "next", at: "2026-10-15T10:00:00.000Z" }]}
        parked={false}
        onSend={noop}
        onQueue={noop}
        onSendNow={noop}
        onStop={noop}
        onUnqueue={noop}
      />
    </>,
  );
  expect(roundedCorners(screen.toJSON() as Node | Node[] | null)).toEqual([]);
});
