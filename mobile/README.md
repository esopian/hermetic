# Hermetic for iPhone

The phone app: an Expo (React Native, iOS-first) **remote head** for a Hermetic fleet. It never talks
to AWS or to a box's Hermes gateway itself — it talks to the **mobile bridge** running on your laptop
(`hermetic mobile serve`, or the desktop app's Settings → Mobile), which owns pairing, turns, the
notification store and push. The one exception is the agent browser: noVNC is loaded straight from
the box over the tailnet, so the phone must be on the tailnet (Tailscale iOS app).

`mobile/` is **not** a root workspace (same as `site/`): it has its own `package.json`, `bun.lock`,
TypeScript config, Biome config and Jest. Root `bun install`, `bun run check` and CI do not touch it.

## Run it

```sh
cd mobile
bun install

# Laptop, from the repo root, in another terminal: a bridge over the fixture fleet (no AWS).
bun run cli -- mobile serve --fixture          # prints host, port; add --host 127.0.0.1 for the simulator
bun run cli -- mobile pair --fixture           # prints the hermetic://pair?… link + QR and the code

# Phone
bun run ios                                    # expo run:ios — builds a dev client and opens the simulator
```

Pair by scanning the QR, pasting the `hermetic://pair?host=…&port=…&code=…` link, or typing host,
port and the 8-character code. The token is stored in the iOS keychain (`expo-secure-store`,
this-device-only). Settings → "Sign out of this bridge" forgets it; `hermetic mobile revoke` on the
laptop kills it from the other side.

The app uses native modules (camera, notifications, secure store, keyboard controller, webview), so
it needs a development build (`bun run ios`), not Expo Go.

## Push notifications and the EAS project id

No Expo/EAS account or project is created by this repo. Remote push needs an EAS project id, read at
build time from the environment:

```sh
EXPO_PUBLIC_PROJECT_ID=<your-eas-project-uuid> bun run ios     # or EAS_PROJECT_ID, which EAS sets itself
```

`app.config.ts` puts it in `extra.eas.projectId`. Without one the app still pairs, chats and alerts
**locally** while it holds its socket (and for ~25 s after backgrounding); Settings says push is
unavailable. With one, Settings → "Enable push" registers the Expo push token with the bridge, and
the bridge pushes turn-finished, turn-error, needs-you (approval/clarify, with Approve once / Deny
actions on approvals) and inbox rows. A push and a socket frame for the same event share a `dedupe`
key, so you are alerted once.

## Tests and checks

```sh
bun run typecheck     # tsc --noEmit (strict, noUncheckedIndexedAccess)
bun run test          # jest (jest-expo): test/**/*.jest.ts(x)
bun run lint          # biome check . (formatter settings mirror the root biome.jsonc)
bun run check         # all three
bun run export:ios    # expo export --platform ios — proves the bundle builds
```

Test files end in `.jest.ts(x)`, not `.test.ts`: the root `bun test` discovers every `*.test.*`
file under the repo, and these are Jest suites.

## Layout

```
app/                 expo-router screens: pair, (tabs)/{index (Bots), inbox, settings},
                     chat/[instance]/[bot], agent/[name] (noVNC), listening (instance picker sheet)
src/protocol/        constants.ts (bridge wire constants) + types.ts (structural mirrors of core schemas)
src/client/          pure TypeScript client layer — no React, no React Native:
                     http, socket (auth, resume, backoff), turn-reducer, conversation-store,
                     roster-store, notifications-store, vnc, markdown (desktop parser, byte-identical),
                     and the desktop's transcript rules as mirrors: chat-logic, chat-turns,
                     chat-requests, chat-recovery, chat-activity, inbox-logic, roster-rows, pairing
src/bridge/          React glue: BridgeProvider (client, SecureStore credentials, AppState,
                     alerts), hooks, notifications (expo-notifications), background refresh
src/chat/            the conversation: block renderers (blocks/), markdown → native, turn rows,
                     transcript list, composer, bands, session and subagent sheets, ChatScope
src/bots/            Bots list rows and body;  src/inbox/  inbox card;  src/pair/  pairing form
src/prefs/           phone-only preferences (haptics, local alerts, quiet hours)
src/theme/           desktop tokens (both schemes), fonts, scale, useTheme()
src/ui/              primitives: Text, Kicker, Button, Avatar (seeded blob), StatusSquare, Skeleton, Badge,
                     haptics (one switch for every tap), useNow
assets/fonts/        Archivo + JetBrains Mono static TTFs (OFL)
test/                jest suites
```

## Rules

- **Never import from `packages/`** (or anything outside `mobile/`). Metro bundles only this
  directory, and core pulls in Zod, AWS and node. What the phone shares with core and the desktop
  is *mirrored*, and each mirror is pinned by a seam test at the repo root:
  - `src/protocol/constants.ts` ↔ `packages/core/src/mobile/protocol.ts` — `tests/mobile-protocol.test.ts`
    deep-compares every export (names listed in `.context/mobile-protocol.md`, "Export names").
  - `src/client/markdown.ts` ↔ `packages/ui/src/chat/chat-markdown.ts` — byte-identical; Biome is
    told not to format it. Edit the desktop file and copy it over.
  - `src/protocol/types.ts` mirrors `packages/core/src/schema/{chat,notification,agent}.ts` by field name.
  - `src/client/turn-reducer.ts`, `roster-store.ts`, `notifications-store.ts`, `conversation-store.ts`
    mirror the desktop's rules (`chat-state.tsx` `applyFrame`, `chat-logic.ts` rail rules,
    `notification-logic.ts` `isWatchingThread`, `chat-conversations.ts`/`chat-queue.ts`); their
    headers name the source.
- `src/client/` and `src/protocol/` stay free of React/React Native/Expo imports, with every effect
  injected, so the root end-to-end test can drive the real client against a real bridge under bun.
- Visual language is the desktop's (`docs/ui-brief.md`): zero radius except avatars, borders carry
  structure, kicker labels, Archivo + JetBrains Mono, dark by default. Mobile breakpoints are in scope
  here (the desktop app's "mobile is out of scope" rule is about its own window).
