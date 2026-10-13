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
