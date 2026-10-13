# mobile/ — agent notes

Read `mobile/README.md` (layout, commands, the import rule) and the root `AGENTS.md` (conventions,
commit and PR rules). The design is `docs/design.md` §9.4. This directory is its own toolchain; run
everything from `mobile/` with bun. Run `bun install` at the repo root first: Metro resolves
`../packages/core`, and core's `zod` from `packages/core/node_modules/zod` (where the core file sits).

- Expo SDK 57. Expo changes every SDK: check `https://docs.expo.dev/versions/v57.0.0/` (or
  `https://docs.expo.dev/llms.txt`) before using an API from memory. Add native packages with
  `bunx expo install <pkg>`, never a bare `bun add`, so versions match the SDK.
- Routes live in `mobile/app/` (expo-router). Non-route code lives in `mobile/src/`.
- The phone talks to the fleet directly, with no laptop bridge: `src/gateway/` is the transport over
  `@hermetic/core/chat-client` (the same Hermes adapter the desktop uses), `src/fleet/` holds the
  paired fleet and `FleetProvider.tsx`, the `GET /fleet` and push-registration calls to hermeticd,
  `src/fixture/` is fixture mode, and `src/inbox/store.ts` is the phone-local inbox.
- `src/gateway/` stays free of `react`, `react-native` and `expo-*` imports, with every effect
  injected, so the root `tests/mobile-gateway-e2e.test.ts` can drive it under bun against a scripted
  Hermes-wire server. Runtime globals Hermes may lack (`AbortSignal.timeout`, `AbortSignal.any`,
  `structuredClone`) are installed by `src/gateway/polyfills.ts`.
- Import rule (`tests/boundaries.test.ts`): `mobile/src` and `mobile/app` may import
  `@hermetic/core/schema`, `@hermetic/core/shared` and `@hermetic/core/chat-client`.
  `@hermetic/core/chat-client-fixture` only from `src/fixture/`. Never a relative path into
  `packages/`, and never the bare `@hermetic/core` door. Anything the phone needs that is not behind
  those doors is a change to core, not a copy here; the one deliberate copy is
  `src/chat/markdown.ts`, byte-identical to `packages/ui/src/chat/chat-markdown.ts`.
- `ios/` and `android/` are generated (continuous native generation) and git-ignored; configure
  native behaviour in `app.config.ts`.
- Done means `bun run check` exits 0 and `bun run export:ios` builds.

## Fixture and real use

- Fixture: `EXPO_PUBLIC_HERMETIC_FIXTURE=1 bun run ios`. The phone builds `fixtureChatClient`
  in process, with a canned fleet view, a canned Tailscale status (switchable from Settings, fixture
  builds only) and an in-memory push registry. Nothing outside `src/fixture/` may know about it.
- Real: the Tailscale app signed into the fleet's tailnet, then scan the QR from
  `hermetic mobile pair` (or paste the link). The link carries no secret. There is no token on the
  phone; revocation is removing it from the tailnet.
- Push: the EAS project id comes from `EXPO_PUBLIC_PROJECT_ID` (or `EAS_PROJECT_ID`). No Expo account
  or project id is checked in. The box sends the push; the phone only registers its token with
  hermeticd (`POST /push/devices`) and keys events by the `dedupe` string.

## Tailscale status

iOS has no public API to ask the Tailscale app, so `src/gateway/tailscale.ts` infers it: it probes
`https://<host>/api/health` (public, no token) on up to three listened boxes, 3 s each. DNS failure
on every probe is `off`, every probe timing out or refused is `unreachable`, any success is `ok`, no
listened boxes is `unknown`. Treat it as a heuristic: word the UI as one, and do not gate chat on it.
Re-probe on foreground and after a failed request.

## Admin the phone keeps

Agent list with status, per-agent detail (status, version, host, health from `/fleet` and
`/healthz`), the listening toggle (phone-local), noVNC, Tailscale status, push on and off, sign out.
Nothing else: no fleet switching, volumes, runs, create or destroy, and no laptop inbox. Do not add
a path that gives the phone an AWS credential or a secret.

## Transport security

- The phone reaches the fleet only over the tailnet, and Tailscale's WireGuard tunnel encrypts and
  authenticates every link end to end. The Hermes gateway is HTTPS and WSS on 443 through Tailscale
  Serve; hermeticd on 7434 is plain HTTP inside the tunnel. The phone dials only hosts that come from
  the pairing link or from `/fleet` (names under the paired tailnet, or tailnet addresses). Do not
  add a dial path for an arbitrary or LAN address: on a LAN the traffic would cross Wi-Fi in the clear.
- iOS App Transport Security (`ios.infoPlist.NSAppTransportSecurity` in `app.config.ts`):
  - ATS does not apply to IP literals, so `127.0.0.1`, `100.x.y.z` and `fd7a:…` need nothing.
  - A MagicDNS name (`box.tailXXXX.ts.net`) is a public FQDN to ATS. The 7434 calls are cleartext,
    so `NSExceptionDomains` grants `ts.net` with `NSIncludesSubdomains` and
    `NSExceptionAllowsInsecureHTTPLoads`. iOS has no narrower form that still covers every
    operator's tailnet name.
  - `NSAllowsArbitraryLoads` stays `false`.
  - noVNC and the gateway are HTTPS (Tailscale Serve certificates), so they need no exception. The
    agent browser's WebView may navigate only to that one origin (`vncNavigationAllowed`).
- The ATS keys are native config. Changing them needs a rebuild (`bun run ios`), not a Metro reload.
- Android is out of scope (the app is iOS-first). Its cleartext policy (`usesCleartextTraffic` or a
  network security config) has not been set or checked.
