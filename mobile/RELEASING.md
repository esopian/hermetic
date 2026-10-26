# iPhone releases and support

Hermetic ships portrait iPhone binaries. Each release contains its JavaScript, native code, fonts,
icon and launch screen. `app.config.ts` disables OTA updates explicitly. TestFlight and App Store
installs therefore run the code reviewed for that build; a fix ships as another binary. EAS Update
channels, runtime versions, update URLs and `expo-updates` are intentionally absent. Revisit this
policy only with a separate rollout, runtime compatibility and rollback plan.

## Build lanes

Run these commands from `mobile/`; the package scripts pin EAS CLI 24.14.0. The global CLI on a
machine may be older. The repo's EAS project UUID is public and checked into `app.config.ts`;
README documents fork overrides. Signing credentials remain in EAS/Apple, never in Git. All profiles pin Bun to the repo's
`.bun-version` (1.4.3). Keep those pins together. EAS installs `mobile/` dependencies itself; the
`eas-build-pre-install` hook first installs the root lockfile with lifecycle scripts disabled.
Metro also bundles core source and needs core's Zod and the root Bun store. A successful local
bundle can hide this missing clean-builder dependency, so preserve the hook.

| Profile | Environment | Artifact | Use |
| --- | --- | --- | --- |
| development | development | Internal development client | Metro and fixture development |
| preview | preview | Internal, signed iPhone Release build | Device acceptance without Metro |
| production | production | Store Release build | TestFlight, then App Store |

Preview and production force `EXPO_PUBLIC_HERMETIC_FIXTURE=0`. They use real pairing/Tailscale.
The marketing version is `version` in `app.config.ts` (keep `package.json` in sync). EAS owns the
remote iOS build number; production increments it for each build. Record the version, build number,
Git commit and EAS build UUID together. Never reuse a build number for a store upload.

## One-time App Store Connect setup

1. Confirm the app record uses bundle ID `com.hermetic.mobile`. Create the record if it does not
   exist. Copy its numeric Apple ID into `submit.production.ios.ascAppId` in `eas.json`; it is public
   metadata. It is intentionally not invented in this repo. Noninteractive submission needs it.
2. Create the TestFlight group **Alpha Users**, matching `submit.production.ios.groups` and the
   workflow's `external_groups`.
   Add the intended App Store Connect testers. External testers need a separate group and Apple's
   Beta App Review; don't invite them implicitly.
3. Configure EAS Submit credentials interactively or provide an App Store Connect API key through
   EAS credentials. Keep key files and secrets out of the repo. Confirm the Apple team and target
   app when prompted. EAS Build's signing profile and EAS Submit's upload authorization are distinct.
4. Complete TestFlight beta contact, export compliance and test instructions. Testers need Tailscale
   membership in a test fleet. Do not put a pairing link or fleet details in public release notes.

## Each candidate

1. Run `bun run check` and `bun run export:ios`. Review the diff, especially native config and
   dependency changes. Record the exact revision used to build.
2. Run `bun run build:preview`. A preview uses registered-device provisioning; register a new iPhone
   before building or re-sign the artifact for that device. Install the EAS artifact, then launch
   with Metro stopped. This is the icon/splash acceptance build (a dev client is not sufficient).
3. Run the acceptance checklist below and fill `RELEASE_NOTES.md` with the candidate version/build,
   changes, what to test, and known limitations. Do not label checks passed without evidence.
4. Run `bun run build:production`. Save the resulting EAS build UUID and artifact. Use the UUID from
   this command to select the candidate explicitly:

   ```sh
   bun run submit:testflight --id <production-build-uuid>
   ```

   This uploads the candidate to App Store Connect/TestFlight, not to the public App Store. Do not
   use `--latest`, which can select an unrelated build. Wait for Apple's processing, resolve any
   compliance questions, and confirm the build is available to **Alpha Users**.
5. Paste the candidate's `RELEASE_NOTES.md` “What to test” into that build's TestFlight **What to Test**
   field. EAS Submit uploads the binary; this repo does not claim to upload beta notes automatically.
   Have a tester install through TestFlight and repeat first launch, pairing and push checks.
6. Public App Store release is a separate approval and submission step. Select this tested build;
   complete the listing, privacy declarations and review information before requesting review.

## Automated TestFlight

`.eas/workflows/testflight.yml` (EAS Workflows) does steps 4 and 5 above in one run: a production
build with the next build number, the upload, the **Alpha Users** group, the "What to test"
section of `RELEASE_NOTES.md` as the TestFlight **What to Test** notes, and the Beta App Review
submission. Apple's approval is the only step left; the first build of a version takes longest.

- **On a tag:** push `mobile-v<version>-<n>` (for example `git tag mobile-v0.1.0-6 && git push
  origin mobile-v0.1.0-6`) from the commit to ship. The tag is a trigger only; EAS still assigns
  the build number.
- **On demand:** `bun run release:testflight` from `mobile/`. This uploads the local `mobile/`
  directory, so run it from a clean checkout of the revision you mean to ship.

Fill the "What to test" section of `RELEASE_NOTES.md` before either; the run fails without it.

One-time setup, beyond the App Store Connect steps above:

1. In the EAS project (**Project settings → GitHub**), connect `esopian/hermetic` with the base
   directory `mobile`, so tag pushes reach the workflow.
2. In the EAS project (**Project settings → General → Connections**), connect App Store Connect,
   so the workflow can set groups, notes and the review submission.
3. In App Store Connect, complete **TestFlight → Test Information** (beta description, feedback
   email, contact, review notes). Beta App Review refuses a submission without it.

`submit:testflight` stays for a build made by hand; it uploads and joins the group, but does not
fill What to Test or submit for review.

## Acceptance record

Record device, iOS version, app version/build, commit, pass/fail, and evidence for each check:

- Home screen, Settings/search icon rendering at small size; opaque icon with system corner mask.
- Force quit and cold launch a preview or TestFlight build; final brand mark on charcoal, no Expo
  artwork, no white flash, no frozen splash. Repeat in system light and dark mode.
- Fresh install and upgrade over the last candidate; pairing persists on upgrade, no fixture entry.
- Deep link and QR pairing; permission denied and granted; Tailscale off/wrong tailnet/reconnected.
- Chat, keyboard, reconnect, notification tap after cold launch, push foreground/background/locked.
- `ACCESSIBILITY.md` device matrix: narrow iPhone, maximum text size, VoiceOver, Reduce Motion.
- Settings → Support report: review and cancel sends nothing; Share opens iOS sharing; report contains
  only the documented fields. Version/build match App Store Connect.

## Diagnostics without a telemetry service

Settings → **Review support report** builds an in-memory report on demand and lets the operator
review it before opening iOS sharing. It includes version/build, iOS version, real/fixture mode,
paired status, coarse Tailscale/fleet/push status and aggregate registration counts. Error codes are
allowlisted; unknown codes become `OTHER`. It excludes raw error text, stack traces, hostnames,
account/fleet/agent IDs, pairing links, push tokens and chat content. No report is persisted or sent
by the app automatically. Share it through the existing support conversation alongside reproduction
steps and the approximate time of failure; redact screenshots before attaching them.

For a native or fatal JavaScript crash, the app cannot create a report after it has terminated.
Use **App Store Connect → TestFlight → Crashes/Feedback** for beta crashes and tester feedback, and
**Xcode → Window → Organizer → Crashes** for symbolicated reports. If the report is unavailable,
the tester can inspect **iOS Settings → Privacy & Security → Analytics & Improvements → Analytics
Data** for a Hermetic report and review it before sharing. Apple's reports may contain device or
other identifying information; they are separate from the app's allowlisted support report.
Retain the matching Xcode archive/dSYMs and JavaScript source map for each production build in
restricted release storage; never publish them as app assets. A Metro export is not a substitute
for the exact map and symbols generated by the shipped native build.

There is no automatic JavaScript/network telemetry or issue alerting. For nonfatal chat/network
failures, capture the visible failure category, support report, time and steps, then reproduce with
the matching build. Adding a monitoring provider later requires deliberate data filtering and a
privacy declaration review.

## Recovery

TestFlight testers may reinstall the previous available build. For a public regression, stop a
phased rollout in App Store Connect if one is active and ship a corrected build with a higher build
number. There is no remote JavaScript rollback under the store-only policy.

## References

- [Expo: TestFlight](https://docs.expo.dev/submit/testflight/)
- [Expo: EAS build and submit schema](https://docs.expo.dev/eas/json/)
- [Expo: update configuration](https://docs.expo.dev/versions/v57.0.0/config/app/#updates)
- [Expo: splash screens and app icons](https://docs.expo.dev/develop/user-interface/splash-screen-and-app-icon/)
- [Apple: crash reports](https://developer.apple.com/documentation/xcode/diagnosing-issues-using-crash-reports-and-device-logs)
