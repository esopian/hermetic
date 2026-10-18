# TestFlight candidate

Fill this record for the exact candidate before distributing it. These are draft notes, not a claim
that a new TestFlight build has been uploaded.

- Version / build: pending
- Git revision: pending
- EAS production build UUID: pending
- Device / iOS: pending
- Acceptance record: pending

## Changes

- Hermetic app icon and branded launch artwork.
- More accessible controls, readable text and support for narrow iPhones.
- A support report that can be reviewed and shared without conversation or fleet identifiers.

## What to test

Cold launch in light and dark mode. Pair with a test fleet, open a chat, type with the keyboard,
background the app and return. Try VoiceOver, large text and Reduce Motion. Review the support report
in Settings and confirm the version/build match this candidate. Check push delivery and notification
taps with Tailscale connected.

## Known limitations

iPhone only. A real fleet and Tailscale membership are required. Background refresh timing is managed
by iOS. Updates arrive through TestFlight/App Store binaries. Complete the acceptance record and add
any candidate-specific issues before distributing.
