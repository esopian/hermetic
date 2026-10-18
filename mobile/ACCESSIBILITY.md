# iPhone accessibility and layout acceptance

Hermetic supports iPhone in portrait. iPad and Android are not supported targets. This checklist
is a release gate for a physical iPhone running a preview or TestFlight build. Unit tests cannot
establish VoiceOver focus behavior, native text layout, keyboard avoidance, or touch usability.

## Implemented guardrails

- A 3.0-second branded entry plays once after cold start, independent of network readiness. It does
  not replay on route changes or foregrounding. Reduce Motion keeps the same timing with a static
  mark; VoiceOver skips the timed entry so it never delays access to controls. The
  animated version assembles the existing mark's cells; the same fixed deadline
  applies if Reduce Motion changes during entry. A foreground return after the
  deadline dismisses an expired overlay immediately.
- Shared action buttons retain a 44-point minimum target, including compact actions. Above the
  default text scale, labels wrap and their containers grow instead of shrinking the requested text.
- Search input height follows Dynamic Type, the clear target occupies 44 points, large text moves
  Cancel below the field, and the results respect the bottom safe area.
- Agent browser controls wrap and have 44-point targets. Agent facts wrap, stack at larger text
  sizes, and can scroll without consuming the entire browser area.
- Tailscale warnings wrap their text and actions on narrow screens and at larger text sizes.
- Unread badges grow with their text and expose their meaning to VoiceOver. Warning and accent
  badges use contrasting foreground colors in the light theme.
- `Text` semantic tones use colors with at least 4.5:1 contrast on the standard page, card, raised,
  and selection surfaces in both themes. The decorative brand palette remains unchanged.
  Explicit `style.color` overrides and content rendered inside a WebView need separate review.
- Accessibility preferences are read once through a shared provider and updated by native events.
  Reduce Motion stops avatar breathing, status pulses and skeleton pulses, and removes banner and
  navigation transitions. Reanimated also respects the system setting for other animations.
- VoiceOver alerts have an explicit full label and remain available until dismissed or replaced.
  Their existing Dismiss rotor action and two-finger escape action remain available. Skeleton
  decoration stays out of the accessibility tree.

`test/ui/accessibility.jest.tsx` checks color contrast, text scaling behavior, minimum button
height, live preference changes, initial-query races, listener cleanup, and alert retention with
VoiceOver. The existing primitive and banner suites cover button activation, disabled states,
banner gestures, and accessibility actions. These are structural checks, not device acceptance.

## Physical-device matrix — still to run

Record the build number, iOS version, device, text size, theme, result, and any screenshot for each
run. Use both a narrow iPhone viewport (including 320-point layout in the simulator if available)
and a current iPhone with a home indicator. Repeat key flows at the default text size and the
largest accessibility text size. Run both light and dark appearance, with Bold Text and Increase
Contrast enabled for one pass.

| Area | Acceptance |
| --- | --- |
| First launch and pairing | VoiceOver reaches the heading, explanatory text, scan/paste controls, errors, and confirmation in order. Camera denial leaves an accessible paste path. The keyboard never hides the active field or final action. |
| Home and Search | VoiceOver reads each bot's name, instance, unread count and needs-you/failed state once. Every icon has a useful name. Search can be cleared and cancelled. Long names remain distinguishable; row and hero labels currently ellipsize visually and require review at large text sizes. |
| Navigation and sheets | Entering a screen or opening a sheet places VoiceOver focus predictably. The sheet confines focus; dismissal returns to its launching control. Verify New chat, instance picker, sessions, and subagent sheets. |
| Chat and requests | Read a long transcript, code, links, errors, approval choices, secret/file requests, and streaming output. Confirm focus does not jump on every token. All reply/approve/deny actions remain visible and understandable at the largest size. |
| Keyboard and safe areas | Type a multiline draft, rotate through keyboard suggestions, open attachments, send, stop, and dismiss the keyboard. The composer and active request fields stay above the keyboard; the final row and controls remain above the home indicator. |
| Settings | Read long instance names and values, toggle listening/push/previews, change theme, edit quiet hours, share diagnostics, and sign out. Check field labels, state announcements, and large-text reflow. |
| Browser | Verify View only, Fit/1:1, Reconnect, long hostnames, error recovery and the Safari action. noVNC is a remote visual canvas; it does not expose the remote desktop's semantic accessibility tree. Assess this limitation explicitly before making an accessibility claim. |
| Alerts and failures | Turn VoiceOver on while an alert is visible. It must stay available and support Activate, Dismiss, and escape. Toggle it off and check normal timeout behavior. An alert replacing another must not trigger the previous alert's action. |
| Reduce Motion | Start with Reduce Motion enabled, then toggle it while the app is open. Verify static avatars/status/loading placeholders, immediate navigation, and usable dismissal. Check chat scrolling and native sheets as well. |
| Touch and layout | Reach all controls with one finger on the narrow phone. Confirm targets do not overlap and there is no horizontal page overflow or clipped required content. Inspect status meaning without relying on color. |

Use Accessibility Inspector for names, roles, contrast overrides and touch targets, then perform
the actual flows with VoiceOver. Simulator screenshots alone do not establish focus or usability.
The matrix above has not yet been executed as part of this change; keep failed cases open until
they are fixed and rerun on the release build.

## References

- [React Native AccessibilityInfo](https://reactnative.dev/docs/accessibilityinfo)
- [Reanimated accessibility behavior](https://docs.swmansion.com/react-native-reanimated/docs/guides/accessibility/)
- [Apple accessibility guidance](https://developer.apple.com/design/human-interface-guidelines/accessibility)
