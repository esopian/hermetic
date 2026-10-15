# Hermetic for iPhone

The phone app: an Expo (React Native, iOS only) companion for a Hermetic fleet. It talks to the
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
matching script here. Metro resolves `../packages/core`, and core's own imports (`zod` among them)
resolve from where the core file sits: `zod` comes from `packages/core/node_modules/zod`, which the
root install links, and nothing needs to exist at `../node_modules/zod`. So run `bun install` at the
repo root before `mobile/`.

## Run it

```sh
bun install            # repo root, once
cd mobile
bun install

# Simulator against the fixture fleet: no AWS, no tailnet, no laptop process.
EXPO_PUBLIC_HERMETIC_FIXTURE=1 bun run ios     # expo run:ios — builds a dev client, opens the simulator
```

Fixture mode needs both a development build (`__DEV__`) and the flag set to exactly `1`
(`fixtureSelected` in `src/fleet/deps.ts`); a release build ignores the flag. In fixture mode the
Pair screen has a "Use fixture fleet" button (the `main` fleet, `fxtr0001`, with
the desktop fixture's eleven agents), chat runs on core's fixture chat stack (`createFixtureChatStack`,
the same canned `fixtureChatClient` the desktop's fixture mode builds, with its activity store), and
Settings →
Tailscale can switch what the probe sees between `ok`, `off` and `unreachable`. The flag is inlined
when Metro transforms the code, so after switching it, start Metro with a clean cache
(`bunx expo start --clear`, or `expo export --clear`). A release build does not carry the fixture at
all: `src/fleet/deps.ts` requires it only behind the inlined flag, which Metro folds away.

Real use: install the Tailscale app on the phone and sign in to the fleet's tailnet. On the laptop
run `hermetic mobile pair` (or open Settings → Pair a phone in the desktop app) and scan the QR from
the app's pairing screen, or paste the `hermetic://fleet?v=2&…` link. The link names the fleet and a
snapshot of its agents and carries no secret; the phone shows a confirm screen, then stores it in the
iOS keychain (`expo-secure-store`, this-device-only) as `hermetic.fleet.v2`. Pairing again replaces
it, and Settings → Sign out forgets it. To cut a phone off, remove it from the tailnet.

A push registration on a box belongs to the tailnet login that made it: another member cannot update
or delete it, and two logins never collide on a `device_id`. The phone mints its `device_id` once and
keeps it. A box that answers 403 refused this phone's login at its `tailscale whois` gate (a transient
whois failure, or a tagged node); Settings names that box as not registered, and the next sync tries
again with the same id.

A registration lapses **72 hours** after the phone last renewed it. The phone renews on every
foreground, and the background task (below) renews it when the last full renewal is 12 hours old,
so a phone left in the background keeps receiving pushes. A phone removed from the tailnet can no
longer renew, and stops receiving pushes within 72 hours even though its registration was never
deleted.

The app uses native modules (camera, notifications, secure store, keyboard controller, webview), so
it needs a development build (`bun run ios`), not Expo Go.

## Screens

There is no tab bar and no inbox screen. Everything lives on one home screen, and the rest opens
from it on demand:

- **Home**: a bare bar with three round buttons (the gear on the left, search and `+` on the
  right). Under it, the hero: a row of large avatars, each with its name and its unread or needs-you
  state. The hero holds every bot pinned on this phone (a star marks a pin); with nothing pinned, it
  holds the default bot of each listened instance. A few sit centred; more scroll sideways. Below
  the hero, the other listened bots, in one quiet section per instance: the instance's name in muted
  capitals with a status dot, and its bots under it (avatar, name, time of the last message, a
  one-line preview, and at the row's edge an accent dot when unread, a gold `!` when the bot needs
  you, a red mark when its last turn failed). A box that does not answer says so in its header and
  keeps the bots it last listed, dimmed, with their marks; its default bot stays in its section. Inside a section, bots needing you come first, then unread, then the most
  recent message, then name; sections that answer come before those that do not, then those with
  something needing you or unread, then the most recent. A bot in the hero is not repeated below.
  The needs-you mark comes from the roster, from this phone's unread `needs_action` inbox entries
  (a box's push; reading the thread clears it), and from a request still open in a turn this phone
  follows, which stays until it is answered, expires or its turn ends, however the thread was read.
  When such a request closes, its own `needs_action` entry is marked read too, and so is a box
  push folded into it once it was the conversation's last open request, so neither source holds
  the mark up alone. A request whose stream the phone merely lost is not a close: its entry stays
  unread until the thread is read.
  A followed turn the phone let go in the background and found `waiting` on its box keeps the mark
  only while the box says so: off screen the phone asks again every 30 s
  (`REMOTE_WAITING_POLL_MS`), so a request answered on the desktop clears it within one ask. A row's
  count is the larger of the roster's Bot Chat unread and the inbox's unread entries about the bot,
  in any session. The failed mark is an unread `turn.error`: a failure seen with its chat on screen
  is filed read and leaves no mark. Long-press a bot (in the hero or a row) for Pin or Unpin, the agent browser and Mark read.
  The Tailscale band appears under the bar only when something is wrong.
- **Settings** (the gear): pairing and sign-out, listened instances, notifications, appearance,
  Tailscale detail, the agent list (detail and noVNC), and the version.
- **Search** (the magnifier): an autofocused field over the listened bots, matching name, title,
  description, instance and the last message's preview, ignoring case and spaces
  (`src/client/search.ts`). A result opens the bot's chat; Cancel returns home.
- **New chat** (`+`): a sheet listing the listened bots. A pick opens a new, separate session with
  that bot (`/chat/<instance>/<bot>?fresh=1`, opened once with `new_session`), leaving its Bot Chat
  as it was. Its last row, "Add instance…", opens the instance picker.
- **Conversation**: a slim bar (a round back button, the bot's avatar and name, which opens the
  session switcher, and one round overflow button for Sessions, the agent browser and Mark read), the
  transcript with the operator's words in soft rounded bubbles, and a pill-shaped composer with a
  round Send (or Stop while a turn runs). Opening the Bot Chat clears the bot's unread and its inbox
  entries, except those naming one of its listed separate sessions (the list is asked for again on
  every open, and an entry naming a session it does not have, filed after it was asked for, waits
  for the next list); opening a separate session
  clears only that session's inbox entries (by the id it was opened with or the one a compaction
  rotated it to). So a bot's row keeps a count after its Bot Chat is read while a separate session
  is unread; the row's Mark read clears both. The Bot Chat and a separate session are two
  conversations: while one is on screen, an event in the other is filed unread and alerts.

The phone-local inbox store (`src/inbox/store.ts`) has no screen of its own: it feeds the unread
and failure marks on the home rows, the app badge and notification routing. The badge counts only
the instances this phone listens to; an unlistened instance's entries stay unread, so listening again
brings its marks back, and it is not set until the pairing has loaded on launch. A notification tap
opens the conversation it is about. An alert this phone raises is titled with the bot's display
title, followed by its instance only when the phone listens to more than one and the bot is not
named, or shown, as its instance (the box's push title has the same rule: `corvid`, not
`corvid · corvid`).

## Chat: a request raised while the phone was away

A turn the phone stopped following in the background can stop for an approval or a question. On
the return the phone sees only that its session is `waiting` (`session.active_list`): the request
itself lives in the gateway's `open_requests`, which is replayed only to a turn pump that
reconnects, and history has no row for it, so the phone cannot show or answer it. The band says so
("answer from the desktop, or stop the turn here"), Stop interrupts the turn by its session, and
upstream otherwise keeps the request waiting until its own timeout. The fix (folding
`open_requests` from `session.events.since` into approval and question cards, answered through the
canonical `respond`) is marked `TODO(mobile)` in `src/client/chat-logic.ts`.

Core's adapter does not reveal a turn's live session id, so a compaction while the phone was away
(the stored key rotated and gone from `session.active_list`) looks like a finished turn; with no live
id learned the phone therefore takes a missing session as over only once the transcript's last rows
show a reply or failure written after the turn started, or after `REMOTE_UNKNOWN_MAX_MS` (2 min) of
misses (`followRemote`, `src/client/client.ts`).

## Platforms

iOS only. Android is out of scope: `app.config.ts` carries only the `android` block `expo prebuild`
needs, and the Android cleartext policy (`usesCleartextTraffic` or a network security config for the
plain-HTTP calls to hermeticd) is not configured or checked. An Android build is not a supported way
to run the app.

## Fleet rollout

A fleet that predates the phone needs three things before the app is fully live: `hermetic artifacts
push` and `hermetic agent recreate <name>` (a new hermeticd serves `/fleet` and `/push/devices` and
runs the push watcher), and `hermetic foundation update` (foundation 17 grants the agent role
`dynamodb:Scan` on the agents table). Until `/fleet` works (it answers `FLEET_LIST_UNAVAILABLE`, or
no box answers it) the phone keeps its QR snapshot and fills each agent's status from that box's own
`/healthz`: `ready` where hermeticd answered, `unreachable` where it did not. The listening default
narrows on those answers, and Settings says "Fleet view: from boxes (foundation update pending)".

## The off-tunnel gate

The Hermes gateway and noVNC are HTTPS through Tailscale Serve, but hermeticd on port 7434 is plain
HTTP inside the tunnel, and iOS sends that cleartext to any `*.ts.net` name (the ATS exception in
`app.config.ts`). So every 7434 call — `/fleet`, `/healthz`, `/push/devices` — first passes a gate
(`src/gateway/hermeticd.ts`): it goes out only if an HTTPS request to the same host
(`https://<host>/api/health`) succeeded within the last 60 seconds, and otherwise the gate probes
once. A host whose HTTPS name does not answer is never sent cleartext: the call fails with
`TUNNEL_UNVERIFIED` ("The box could not be confirmed on the tailnet"), which the screens treat like
an unreachable box. The Tailscale probe records its successes in the same table, so the app (and the
background task) probes before it refreshes the fleet. In practice `TUNNEL_UNVERIFIED` means the
Tailscale app is off, signed in to another tailnet, or the box is down.

## Push notifications and the EAS project id

No Expo/EAS account or project is created by this repo, and none is checked in. Remote push needs an
EAS project id, read at build time from the environment:

```sh
EXPO_PUBLIC_PROJECT_ID=<your-eas-project-uuid> bun run ios     # or EAS_PROJECT_ID, which EAS sets itself
```

`app.config.ts` puts it in `extra.eas.projectId`. Without one the app still pairs and chats, and
alerts locally while it holds its sockets (and for ~25 s after backgrounding); Settings says push is
unavailable. With one, Settings → Notifications → "Push from the agents" registers the Expo push
token with each box you listen to (and unregisters it from a box you stop listening to), and the box
pushes turn-finished, turn-error, needs-you and new-message events. While the app is away from the
screen it draws no local notification of its own for a box that holds its registration: that box's
push is the one alert. A push and a socket-delivered event for the same thing share a `dedupe` key,
so you are alerted once. A push whose `data` names another fleet, or an agent the pairing does not
name, is dropped before it reaches the inbox store. Tapping a needs-you push opens the conversation; there
is no inline approve or deny.

**Previews are opt-in.** Every registration states `previews`, the Settings "Show message previews"
switch, which is off until you turn it on; changing it re-registers with every listened box. Off, a
push says only "<bot> replied" or "needs you". On, the box puts a redacted excerpt of the reply in
the push body, and that text travels through Apple's and Expo's push services. The same switch decides
whether this phone's own alerts quote the conversation.

**Quiet hours** silence the alerts this phone raises from its own connections; the inbox store
still fills, so the home's unread marks stay true. They do not reach the boxes: pushes still arrive during quiet hours, so use an iOS Focus (or
turn push off) to silence those too.

**Background refresh.** Every wake (iOS decides when, at most every 15 minutes) probes Tailscale,
refreshes `/fleet` behind the gate, renews the push registration when it is due, and sets the badge
from the phone's inbox store. It reads no conversation: the boxes' pushes cover what happened while the
app was away.

## Tailscale status

iOS offers no API to ask the Tailscale app whether it is connected, so `src/gateway/tailscale.ts`
infers it. It probes `https://<host>/api/health` (public, no token) on up to three listened boxes, 3 s
each: DNS failure on every probe is `off`, every probe timing out or refused is `unreachable`, any
success is `ok`, and no listened boxes is `unknown`. The home screen shows a band under its bar for
`off` and `unreachable`, with an Open Tailscale action, and Settings has the detail. It is a heuristic and the UI says so.

## What admin remains

Agent list with status, per-agent detail (status, version, host, health), the listening toggle
(phone-local), the agent browser (noVNC), Tailscale status, push on or off, and sign out. Fleet
switching, volumes, runs, create and destroy stay on the laptop. All of it sits behind the home's gear
(Settings). The phone's inbox store is its own: the last 200 pushes and socket-delivered events, kept
on the device (`src/inbox/store.ts`), with no screen; it drives the home's unread marks.

## Running it as an agent

Coding agents drive Metro and the simulator without anything interactive:

- Never open React Native DevTools, and never press `j` (or any key) in Metro. DevTools attaches a
  debugger to the app's JS runtime and takes over the session.
- Start Metro non-interactively: `CI=1 npx expo start` (or `CI=1 bunx expo start --clear` after
  switching the fixture flag). For a native build without a second bundler, run Metro yourself and
  build with `bunx expo run:ios --no-bundler`.
- Read logs from Metro's stdout, or from the simulator:
  `xcrun simctl spawn booted log stream --predicate 'process == "Hermetic"'`.
- Bundle checks need no simulator: `CI=1 npx expo export --platform ios --output-dir /tmp/mobile-export`.

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
app/                 expo-router screens: pair, home (hero + bot list), settings, search, new-chat
                     (sheet), chat/[instance]/[bot], agent/[name] (detail + noVNC), listening
                     (instance picker sheet); +native-intent.tsx turns a hermetic://fleet link
                     into /pair
src/client/          the client layer, no React: createHermeticClient (client.ts), the
                     conversation and roster stores, turn reducer, chat and inbox logic, home rows
                     and bot search (home-rows.ts, search.ts), errors, the noVNC URL (vnc.ts)
src/gateway/         transport over @hermetic/core/chat-client: client, socket opener, polyfills
                     (AbortSignal.timeout/any, structuredClone), hermeticd calls (/fleet,
                     /push/devices), tailscale status; no React, React Native or Expo
src/fleet/           FleetProvider.tsx (client, AppState, alerts, push, Tailscale) and hooks.ts;
                     store.ts (pairing, /fleet view, listening), pairing.ts, persist.ts
                     (SecureStore, document files), push.ts (registration), alerts.ts and
                     notifications.ts (expo-notifications), background.ts, deps.ts (real or fixture)
src/fixture/         fixture mode: fixtureChatClient, canned fleet view and pairing link, canned
                     Tailscale status, memory push registry (the only importer of chat-client-fixture)
src/inbox/           store.ts, the phone-local inbox store (last 200 entries, JSON in the document
                     directory): unread and failure marks, badge, no screen
src/chat/            the conversation: block renderers (blocks/), markdown → native, turn rows,
                     transcript list, composer, bands, session and subagent sheets, the
                     conversation bar (ChatHeader.tsx), new-chat helpers, ChatScope
src/bots/            home rows and hero;  src/pair/  paste form and confirm card
src/prefs/           phone-only preferences (haptics, local alerts, quiet hours)
src/theme/           desktop tokens (both schemes), fonts, scale, useTheme()
src/ui/              primitives: Text, Kicker, Button, IconButton (round 44pt chrome button), Avatar
                     (seeded blob), StatusSquare, Skeleton, Badge,
                     Banner (in-app alert, Tailscale band), haptics (one switch for every tap), useNow
assets/fonts/        Archivo + JetBrains Mono static TTFs (OFL)
test/                jest suites (client, gateway, fleet, fixture, inbox, ui) and helpers/
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
- Visual language is the desktop's palette and type (`docs/ui-brief.md`): Archivo + JetBrains Mono,
  the accent and warn colours, dark by default. The chrome is softer than the desktop's: round 44pt
  icon buttons with a hairline ring (`IconButton`), round avatars, a rounded search field, list rows
  with no borders or separators, a pill composer with a round Send, and rounded operator bubbles.
  Content cards and bands keep the desktop's square edges. Mobile breakpoints are in scope
  here (the desktop app's "mobile is out of scope" rule is about its own window).
