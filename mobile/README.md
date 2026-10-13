# Hermetic for iPhone

The phone app: an Expo (React Native, iOS-first) companion for a Hermetic fleet. It talks to the
fleet **directly over the tailnet**, with no laptop in the path:

- chat goes to the Hermes gateway on each box (HTTPS and WSS on 443), through the same adapter the
  desktop uses, imported from core as `@hermetic/core/chat-client`;
- the fleet list (`GET /fleet`) and push-token registration (`POST /push/devices`) go to hermeticd
  on any reachable box (port 7434);
- push notifications are sent by hermeticd's own watcher on the box, through Expo;
- the agent browser's noVNC page loads from the box.

The laptop's only role is rendering the pairing QR (`hermetic mobile pair`, or the desktop app's
Settings → Pair a phone). The phone has no credential of its own: its access is membership of the
fleet's tailnet, so it needs the **Tailscale iOS app signed into the same tailnet**. See
`docs/design.md` §9.4.

`mobile/` is **not** a root workspace (same as `site/`): it has its own `package.json`, `bun.lock`,
TypeScript config, Biome config and Jest. Root `bun run check` does not touch it (CI has its own
`mobile` job); from the repo root, `bun run mobile:check` (`mobile:test`, `mobile:ios`) runs the
matching script here. Metro does resolve `../packages/core` and the root `node_modules/zod`, so run
`bun install` at the repo root before `mobile/`.

## Run it

```sh
bun install            # repo root, once
cd mobile
bun install

# Simulator against the fixture fleet: no AWS, no tailnet, no laptop process.
EXPO_PUBLIC_HERMETIC_FIXTURE=1 bun run ios     # expo run:ios — builds a dev client, opens the simulator
```

Real use: install the Tailscale app on the phone and sign in to the fleet's tailnet. On the laptop
run `hermetic mobile pair` (or open Settings → Pair a phone in the desktop app) and scan the QR from
the app's pairing screen, or paste the `hermetic://fleet?v=2&…` link. The link names the fleet and a
snapshot of its agents and carries no secret; the phone shows a confirm screen, then stores it in the
iOS keychain (`expo-secure-store`, this-device-only) as `hermetic.fleet.v2`. Pairing again replaces
it, and Settings → Sign out forgets it. To cut a phone off, remove it from the tailnet.

The app uses native modules (camera, notifications, secure store, keyboard controller, webview), so
it needs a development build (`bun run ios`), not Expo Go.

## Fleet rollout

A fleet that predates the phone needs three things before the app is fully live: `hermetic artifacts
push` and `hermetic agent recreate <name>` (a new hermeticd serves `/fleet` and `/push/devices` and
runs the push watcher), and `hermetic foundation update` (foundation 16 grants the agent role
`dynamodb:Scan` on the agents table). Until `/fleet` works the phone keeps its QR snapshot and
refreshes per-box status from `/healthz`.

## Push notifications and the EAS project id

No Expo/EAS account or project is created by this repo, and none is checked in. Remote push needs an
EAS project id, read at build time from the environment:

```sh
EXPO_PUBLIC_PROJECT_ID=<your-eas-project-uuid> bun run ios     # or EAS_PROJECT_ID, which EAS sets itself
```

`app.config.ts` puts it in `extra.eas.projectId`. Without one the app still pairs and chats, and
alerts locally while it holds its sockets (and for ~25 s after backgrounding); Settings says push is
unavailable. With one, Settings → "Enable push" registers the Expo push token with each box you
listen to, and the box pushes turn-finished, turn-error, needs-you and new-message events. A push and
a socket-delivered event for the same thing share a `dedupe` key, so you are alerted once. Tapping a
needs-you push opens the conversation; there is no inline approve or deny.

## Tailscale status

iOS offers no API to ask the Tailscale app whether it is connected, so `src/gateway/tailscale.ts`
infers it. It probes `https://<host>/api/health` (public, no token) on up to three listened boxes, 3 s
each: DNS failure on every probe is `off`, every probe timing out or refused is `unreachable`, any
success is `ok`, and no listened boxes is `unknown`. The Bots screen shows a banner for `off` and
`unreachable`, with an Open Tailscale action. It is a heuristic and the UI says so.

## What admin remains

Agent list with status, per-agent detail (status, version, host, health), the listening toggle
(phone-local), the agent browser (noVNC), Tailscale status, push on or off, and sign out. Fleet
switching, volumes, runs, create and destroy stay on the laptop. The phone's inbox is its own: the
last 200 pushes and socket-delivered events, kept on the device (`src/inbox/store.ts`).

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
src/gateway/         transport over @hermetic/core/chat-client: client, socket opener, polyfills
                     (AbortSignal.timeout/any, structuredClone), tailscale status; no React
src/fleet/           FleetProvider.tsx (paired fleet in SecureStore, /fleet refresh, push
                     registration, AppState), hooks, notifications, background refresh
src/fixture/         fixture mode: fixtureChatClient, canned fleet view, canned Tailscale
                     status, memory push registry (the only importer of chat-client-fixture)
src/inbox/store.ts   the phone-local inbox (last 200 entries, JSON in the document directory)
src/chat/            the conversation: block renderers (blocks/), markdown → native, turn rows,
                     transcript list, composer, bands, session and subagent sheets, ChatScope
src/bots/            Bots list rows and body;  src/pair/  pairing form and confirm screen
src/prefs/           phone-only preferences (haptics, local alerts, quiet hours)
src/theme/           desktop tokens (both schemes), fonts, scale, useTheme()
src/ui/              primitives: Text, Kicker, Button, Avatar (seeded blob), StatusSquare, Skeleton, Badge,
                     haptics (one switch for every tap), useNow
assets/fonts/        Archivo + JetBrains Mono static TTFs (OFL)
test/                jest suites
```

## Rules

- **Imports** (`tests/boundaries.test.ts`): `mobile/src` and `mobile/app` may import
  `@hermetic/core/schema`, `@hermetic/core/shared` and `@hermetic/core/chat-client`;
  `@hermetic/core/chat-client-fixture` only from `src/fixture/`; never a relative path into
  `packages/`. Metro maps `@hermetic/core/<door>` to the door file (`metro.config.js`, with matching
  `tsconfig.json` `paths` and Jest `moduleNameMapper`).
- What is still copied, and pinned by a root test: `src/chat/markdown.ts` is byte-identical to
  `packages/ui/src/chat/chat-markdown.ts` (Biome is told not to format it; edit the desktop file and
  copy it over). The pairing link format is not copied: both ends use `shared/mobile-link.ts`
  (`tests/mobile-link-seam.test.ts`).
- `src/gateway/` stays free of React, React Native and Expo imports, with every effect injected, so
  `tests/mobile-gateway-e2e.test.ts` can drive the real gateway client under bun against a scripted
  Hermes-wire server.
- Visual language is the desktop's (`docs/ui-brief.md`): zero radius except avatars, borders carry
  structure, kicker labels, Archivo + JetBrains Mono, dark by default. Mobile breakpoints are in scope
  here (the desktop app's "mobile is out of scope" rule is about its own window).
