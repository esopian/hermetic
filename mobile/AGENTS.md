# mobile/ — agent notes

Read `mobile/README.md` (layout, commands, the mirror rules) and the root `AGENTS.md` (conventions,
commit and PR rules). This directory is its own toolchain; run everything from `mobile/` with bun.

- Expo SDK 57. Expo changes every SDK: check `https://docs.expo.dev/versions/v57.0.0/` (or
  `https://docs.expo.dev/llms.txt`) before using an API from memory. Add native packages with
  `bunx expo install <pkg>`, never a bare `bun add`, so versions match the SDK.
- Routes live in `mobile/app/` (expo-router). Non-route code lives in `mobile/src/`.
- `src/client/` and `src/protocol/` are pure TypeScript — no `react`, `react-native` or `expo-*`
  imports — because the repo-root e2e test imports them under bun.
- Never import from `packages/`. Shared rules are mirrored and seam-tested (README "Rules").
- `ios/` and `android/` are generated (continuous native generation) and git-ignored; configure
  native behaviour in `app.config.ts`.
- Done means `bun run check` exits 0 and `bun run export:ios` builds.

## Transport security

- The bridge is plain HTTP and WebSocket (`http://`, `ws://`). It listens on the laptop's tailnet
  address, and Tailscale's WireGuard tunnel encrypts and authenticates that link end to end. There
  is no TLS of our own on top. That holds only while the phone dials a tailnet or loopback address.
  `pairHostAllowed` (`src/client/pairing.ts`) is the gate: loopback, `100.64.0.0/10`,
  `fd7a:115c:a1e0::/48` or a `*.ts.net` name. Anything else is refused before a pairing code or
  token is sent. Do not widen it to LAN addresses, because on a LAN the token would cross Wi-Fi in
  the clear.
- iOS App Transport Security (`ios.infoPlist.NSAppTransportSecurity` in `app.config.ts`):
  - ATS does not apply to IP literals, so `127.0.0.1`, `100.x.y.z` and `fd7a:…` need nothing.
  - `NSAllowsLocalNetworking` covers `localhost` (an unqualified name). It does not cover MagicDNS
    names.
  - A MagicDNS name (`laptop.tailXXXX.ts.net`) is a public FQDN to ATS. `NSExceptionDomains` therefore
    grants `ts.net` with `NSIncludesSubdomains` and `NSExceptionAllowsInsecureHTTPLoads`. iOS has no
    narrower form that still covers every operator's tailnet name.
  - `NSAllowsArbitraryLoads` stays `false`.
  - noVNC is loaded over HTTPS (Tailscale Serve certificates), so it needs no exception. The agent
    browser's WebView may navigate only to that one origin (`vncNavigationAllowed`).
- The ATS keys are native config. Changing them needs a rebuild (`bun run ios`), not a Metro reload.
- Android is out of scope (the app is iOS-first). Its cleartext policy (`usesCleartextTraffic` or a
  network security config) has not been set or checked.
