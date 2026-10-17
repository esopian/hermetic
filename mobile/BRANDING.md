# Mobile brand assets

The phone uses Hermetic's established fleet mark: six orange cells, two cream cells,
and an orange H at the center. The shape follows the desktop app icon in
`packages/app/assets/icon-1024.png`; the colors are the dark palette from
`docs/ui-brief.md`. The mobile sources are clean vector geometry so the mark stays
clear at notification and Settings sizes.

## Sources and regeneration

`assets/brand/mark.svg` is the editable master. The generator places it on the
appropriate canvas, writes the derived SVGs into `assets/brand/`, and rasterizes
all six PNGs consumed by `app.config.ts`.

Install ImageMagick 7 (`brew install imagemagick` on macOS), then from `mobile/` run:

```sh
bun scripts/generate-brand-assets.ts
```

Commit the master, derived SVGs, generator, and PNGs together. ImageMagick is only
needed to regenerate artwork; EAS builds consume the checked-in PNG files.

| Asset | Output | Use |
| --- | --- | --- |
| `icon.png` | 1024 × 1024, opaque RGB | iOS app icon; full-bleed charcoal, no pre-rendered corner mask |
| `splash-icon.png` | 1024 × 1024, transparent RGBA | Tight fleet mark, rendered at 120 points on `#0e0e0d` by the splash plugin |
| `android-icon-foreground.png` | 1024 × 1024, transparent RGBA | Mark centered in the adaptive icon safe area |
| `android-icon-background.png` | 1024 × 1024, opaque RGB | Solid charcoal adaptive icon background |
| `android-icon-monochrome.png` | 1024 × 1024, transparent RGBA | Single-color mask for themed Android icons |
| `favicon.png` | 64 × 64, opaque RGB | Consistent web scaffold icon |

Android and web artwork keep the scaffold consistent; they do not imply those
platforms are supported. The app remains iPhone-only.

## Animated entry

The native launch screen hands off to a 3.0-second React entry, after the first
layout and local mark image are ready. `EntryMark.tsx` crops the existing splash
PNG into its nine cells; it adds no new art or native dependency. The first frame
uses the complete raster at the native screen's exact 120-point size and color.

The first 140 milliseconds preserve the native mark and exchange its raster for
matching cells. The outer cells gently lift away from the central H, finishing
their departure at 500 milliseconds. The cream cells assemble the vertical spine
first, starting at 560 and 700 milliseconds. The orange left column follows from
860 milliseconds, then the right column from 1440 milliseconds. The placements
overlap, ease in and out, and finish at 2520 milliseconds without bouncing or
spinning. The assembled mark holds until 2700 milliseconds, then the whole overlay
dissolves over 300 milliseconds. Because native launch already displays the completed mark,
the first movement is a brief separation before assembly; there is no blank logo
frame or abrupt replacement with scattered blocks.

The 3000-millisecond deadline starts after native splash dismissal, independent of
fleet data or route readiness. Routes stay mounted underneath. Returning from the
background after the deadline dismisses an expired entry rather than replaying it.
VoiceOver skips the timed entry. Reduce Motion retains a stationary complete mark
for the same duration. Image failures and stalled accessibility queries skip the
animation instead of blocking startup.

The crop geometry follows the master's 220-unit grid: 60-unit cells on an 80-unit
pitch. If that geometry changes, update `EntryMark.tsx` alongside the source art.
Check the animation in a preview or production binary; an iOS export validates
bundling but cannot establish native handoff alignment or animation smoothness.

## Acceptance

Inspect the icon at 20, 29, 40, 60, 120, and 180 rendered pixels. The grid and
orange/cream rhythm should remain recognizable at all sizes; the H detail becomes
secondary at the smallest sizes. Check that the icon has no alpha channel and
that the splash has transparent space between its cells.

Artwork and native launch configuration are embedded in the binary. After changing
them, build a new preview or production binary; a Metro reload is insufficient.
Cold-launch that installed build on an iPhone and verify the centered mark, charcoal
background, and transition to the app in both system appearances. Also inspect the
installed icon on the home screen and in Settings. A generated splash composition
is a design preview, not a substitute for this native launch check. Expo development
clients can show their own launch UI and do not reliably represent the final splash.

References: [Expo app icons](https://docs.expo.dev/develop/user-interface/splash-screen-and-app-icon/)
and [Expo splash screen](https://docs.expo.dev/versions/v57.0.0/sdk/splash-screen/).
