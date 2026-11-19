/**
 * The Hermes gateway's internal signals (§9.2): event types the gateway
 * broadcasts on the chat socket that Hermes Desktop handles or ignores without drawing
 * anything in the transcript.
 *
 * The chat adapter turns any event it has no mapping for into an `unknown`
 * block, so that a `hermes_ref` bump can never blank a transcript. These are
 * the exception: change-watcher broadcasts, desktop-surface commands, and the
 * voice/display/pet side channels, and advisory tool-output risk reports.
 * Most arrive as global broadcasts with
 * `session_id: ""` (upstream `tui_gateway/server.py`), so no session check
 * filters them either. Drawn, each one is an activity row for something the
 * operator never did.
 *
 * Sourced from Hermes Desktop v2026.9.24, `apps/desktop/src`. Paths below are
 * relative to `app/session/hooks/use-message-stream/gateway-event/` unless
 * they say otherwise. An event that is not listed still renders: add a name
 * only when Desktop consumes it without a transcript row.
 *
 * Shared because two packages decide on it: core, which drops these before
 * they become blocks, and the UI, which skips any such `unknown` block already
 * stored from before core dropped it.
 */
export const HERMES_INTERNAL_EVENTS: readonly string[] = Object.freeze([
  // lifecycle.ts:26, :38, :52 — the socket handshake, setup state, theme.
  "gateway.ready",
  "setup.ready",
  "skin.changed",
  // lifecycle.ts:63-67 — change-watcher broadcasts (upstream
  // `tui_gateway/change_watcher.py`): "go re-read X", never content.
  "pet.changed",
  "cron.changed",
  "sessions.changed",
  "platforms.changed",
  "pairing.changed",
  // Hermes v0.23.1 change-watcher additions (`tui_gateway/change_watcher.py:386-390`):
  // lifecycle.ts:81 (projects), the TUI's slash catalog (skills), and the
  // hermes-bots relay's drain signal (plugins/hermes-bots/relay.ts:828).
  "projects.changed",
  "skills.changed",
  "bot_relay.outbox.pending",
  // session-info.ts:147, :472 — session metadata. The chat adapter still lifts
  // `session.info`'s usage context window before dropping the rest.
  "session.info",
  "session.title",
  // session-control.ts:8.
  "session.control.update",
  // desktop-bridge.ts:16, :23, :31, :58, :70, :82 — commands to Desktop's own
  // surfaces (terminal pane, tips, layout, reactions).
  "agent.terminal.output",
  "terminal.close",
  "tip.show",
  "pane.reveal",
  "layout.apply",
  "message.reaction",
  // message-stream.ts:207 — a heart burst, no row.
  "reaction",
  // tools.ts handles the completed tool, while Desktop draws no row for the
  // gateway's advisory output-risk event.
  "tool.output_risk",
  // tools.ts:87 — an MCP call's live progress (v0.23.1, up to 2/s per call),
  // drawn by Desktop on the running tool, never as a row of its own.
  "tool.progress",
  // use-preview-routing.ts:97, :140 — Desktop's preview pane.
  "preview.open",
  "preview.close",
  // settings/billing/use-step-up.ts:116 — a billing verification code for
  // Desktop's settings, not the transcript.
  "billing.step_up.verification",
  // onboarding.ts:10, free-tier.ts:13 — Desktop's own onboarding and
  // anonymous free-tier dialogs (v0.23.1).
  "onboarding.ended",
  "free_tier.challenge",
  // A status line printed during a local viewer's turn (v0.23.1,
  // `hermes_cli/gateway_agent.py:1516`); Desktop has no consumer.
  "agent.print",
  // plugins/hermes-bots/screen-*.tsx — the virtual display's side channel.
  "display.install.done",
  "display.install.log",
  "display.lease",
  "display.status",
  // store/pet-generate.ts — pet generation progress.
  "pet.generate.progress",
  "pet.hatch.progress",
  // app/contrib/wiring.tsx — wake word.
  "wake.detected",
  // Emitted by tui_gateway's voice mode; Desktop has no consumer at all.
  "voice.status",
  "voice.transcript",
  "voice.interrupted",
  "voice.partial",
]);

const INTERNAL = new Set(HERMES_INTERNAL_EVENTS);

/** Whether a gateway event type is an internal signal, never a transcript row. */
export function isHermesInternalEvent(name: string): boolean {
  return INTERNAL.has(name);
}
