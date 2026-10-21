/**
 * The fixture kit's contract with the app, kept free of React, react-native
 * and expo imports on purpose: root seam tests (`tests/mobile-files-seam.test.ts`)
 * build the kit in Bun, and `FleetProvider.tsx` is a React component whose
 * imports reach react-native's global typings. `FleetProvider.tsx` re-exports
 * these names, so app code keeps importing them from there.
 */
import type { AvatarStyle } from "@hermetic/core/shared";
import type { PickedFile } from "../client/attachments.ts";
import type { PastedImage } from "../client/paste.ts";
import type { TailscaleStatus } from "../gateway/tailscale.ts";
import type { SchemeName } from "../theme/tokens.ts";

/** The theme choice a drive link may set; the same union `theme.tsx` keeps as `SchemePreference`. */
export type SchemePreferenceName = "system" | SchemeName;

/** A canned prompt that raises one kind of block or card in fixture mode (data only). */
export interface DemoPrompt {
  group: string;
  label: string;
  prompt: string;
}

/** The query of a `hermetic://fixture?…` link, as expo-router hands it over. */
export type FixtureDriveParams = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * What a `hermetic://fixture?…` link may do to the app (`app/fixture.tsx`
 * builds it from the providers; `src/fixture/drive.ts` calls it).
 */
export interface FixtureDriveActions {
  /** Pair with the kit's canned link, as the Pair screen's "Use fixture fleet" does. */
  pair(): Promise<void>;
  setPrimary(name: string): Promise<void>;
  listen(name: string): Promise<void>;
  /** Create a Bot Mode bot (`HermeticClient.createBot`). */
  createBot(instance: string, input: { name: string; title?: string }): Promise<void>;
  setAvatarStyle(style: AvatarStyle): void;
  setTheme(preference: SchemePreferenceName): void;
  /** A parameter that was refused or a step that failed; the drive goes on. */
  warn(message: string): void;
}

/**
 * Fixture builds only: the canned pairing link, the switchable Tailscale
 * status, the demo prompts the conversation's "Demo prompts…" menu and
 * `?demo=` link send, and the `hermetic://fixture?…` driver, which applies a
 * link's parameters and answers the route to open.
 */
export interface FixtureControls {
  link: string;
  demoPrompts?: readonly DemoPrompt[];
  drive?: (params: FixtureDriveParams, actions: FixtureDriveActions) => Promise<string>;
  /** Canned attachments (an image, then a text file) for the conversation's `?attach=` link. */
  sampleFiles?: () => Promise<PickedFile[]>;
  /** A canned clipboard picture, as the paste control answers it, for the conversation's `?paste=image` link. */
  clipboardImage?: () => Promise<PastedImage>;
  tailscale: {
    get(): Exclude<TailscaleStatus, "unknown">;
    set(s: Exclude<TailscaleStatus, "unknown">): void;
  };
}
