import type { AvatarStyle } from "@hermetic/core/shared";
import { render, screen } from "@testing-library/react-native";
import { PrefsProvider } from "../../src/prefs/prefs.tsx";
import { ThemeProvider } from "../../src/theme/theme.tsx";
import { Avatar, buildAvatar } from "../../src/ui/avatar/Avatar.tsx";

const KEY = { fleet_id: "fxtr0001", instance: "atlas", bot: "scribe" } as const;
const SEED = "fxtr0001/atlas/scribe";

interface Node {
  type: string;
  props: Record<string, unknown>;
  children: (Node | string)[] | null;
}

/** Every host node of `type` under the avatar's svg. */
function hosts(style: AvatarStyle, type: string): Node[] {
  const out: Node[] = [];
  const walk = (n: Node | (Node | string)[] | string | null) => {
    if (!n || typeof n === "string") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === type) out.push(n);
    n.children?.forEach(walk);
  };
  const svg = (function find(n: Node | (Node | string)[] | string | null): Node | null {
    if (!n || typeof n === "string") return null;
    if (Array.isArray(n)) {
      for (const c of n) {
        const hit = find(c);
        if (hit) return hit;
      }
      return null;
    }
    if (n.props.testID === `avatar-${style}`) return n;
    return find(n.children);
  })(screen.toJSON() as Node | Node[] | null);
  expect(svg).not.toBeNull();
  walk(svg);
  return out;
}

async function draw(avatarStyle: AvatarStyle, status: "ready" | "stopped" = "ready") {
  await render(
    <ThemeProvider initial="dark">
      <Avatar {...KEY} avatarStyle={avatarStyle} status={status} />
    </ThemeProvider>,
  );
}

describe("Avatar draws all three styles from the shared geometry", () => {
  test("sigil: one Rect per seeded cell, no Path", async () => {
    await draw("sigil");
    const built = buildAvatar(SEED, "sigil", false, true);
    if (built.style !== "sigil") throw new Error("expected sigil");
    expect(built.cells.length).toBeGreaterThan(0);
    expect(hosts("sigil", "RNSVGRect")).toHaveLength(built.cells.length);
    expect(hosts("sigil", "RNSVGPath")).toHaveLength(0);
  });

  test("pixel: the base runs plus the still eyes and mouth, as hex", async () => {
    await draw("pixel");
    const built = buildAvatar(SEED, "pixel", false, true);
    if (built.style !== "pixel") throw new Error("expected pixel");
    const still = built.base.length + (built.eyes[0]?.length ?? 0) + (built.mouths[0]?.length ?? 0);
    expect(hosts("pixel", "RNSVGRect")).toHaveLength(still);
    expect(hosts("pixel", "RNSVGPath")).toHaveLength(0);
    for (const c of built.base) expect(c.fill).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("pixel: a stopped box shuts its eyes", async () => {
    await draw("pixel", "stopped");
    const built = buildAvatar(SEED, "pixel", false, true);
    if (built.style !== "pixel") throw new Error("expected pixel");
    const shut = built.base.length + (built.eyes[4]?.length ?? 0) + (built.mouths[0]?.length ?? 0);
    expect(hosts("pixel", "RNSVGRect")).toHaveLength(shut);
  });

  test("blob: two Path layers, no Rect", async () => {
    await draw("blob");
    expect(hosts("blob", "RNSVGPath")).toHaveLength(2);
    expect(hosts("blob", "RNSVGRect")).toHaveLength(0);
  });

  test("with no style given, the phone's preference decides", async () => {
    const storage = {
      get: async () => JSON.stringify({ avatarStyle: "sigil" }),
      set: async () => {},
      remove: async () => {},
    };
    await render(
      <PrefsProvider storage={storage}>
        <ThemeProvider>
          <Avatar {...KEY} />
        </ThemeProvider>
      </PrefsProvider>,
    );
    // Unlabelled, the avatar is hidden from accessibility, so the query opts in.
    expect(await screen.findByTestId("avatar-sigil", { includeHiddenElements: true })).toBeTruthy();
  });

  test("the same seed always builds the same face", () => {
    for (const style of ["sigil", "pixel", "blob"] as const) {
      expect(buildAvatar(SEED, style, true, true)).toEqual(buildAvatar(SEED, style, true, true));
    }
  });
});
