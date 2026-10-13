/**
 * The phone's client layer: pure TypeScript, no React, no React Native.
 * Screens reach the fleet only through this (via `src/fleet/`).
 *
 * `createHermeticClient(...)` answers the one object the screens use:
 *
 * - `fleet` — `FleetStore` (`src/fleet/store.ts`): the pairing link, the live
 *   `GET /fleet` view, the merged agent list (`agents()`), each box's host
 *   (`hostOf`), and the phone-local listening choice (`listened`,
 *   `setListening`). `refresh()` asks up to three listened boxes; a failure
 *   keeps the snapshot and sets `stale`.
 * - `chat` — `ConversationStore`: one conversation's transcript, live reply,
 *   queue, requests and observation. `view/subscribe/open/leave/reload/send/
 *   steer/stop/enqueue/unqueue/sendMessage/sendNow/respond/release`.
 * - `roster` — `RosterStore`: the Bots list over every listened box's swarm.
 * - `inbox` — `InboxStore` (`src/inbox/store.ts`): the phone's own last 200
 *   events (pushes and socket-delivered), unread counts and the badge.
 * - `gateway` — the transport over core's Hermes adapter, for what the
 *   screens call beside the store: `open` (a new thread), `compact`,
 *   `archive`, `steerSubagent`, `abortSubagent`.
 * - `tailscale` — `probe()` / `last()`: the heuristic Tailscale status
 *   (`src/gateway/tailscale.ts`).
 * - `setPhase` / `setWatched` — what the alert decision reads.
 * - `dispose()` — stop every turn pump and observation and drop the stores' state.
 *
 * Errors are core's `HermeticError`; `errors.ts` maps a code to the copy a
 * screen shows (`errorCopy`), `chat-logic.ts` `failureCopy` the copy of a
 * failure inside a transcript.
 */
export * from "./chat-types.ts";
export * from "./client.ts";
export * from "./conversation-store.ts";
export * from "./errors.ts";
export * from "./roster-store.ts";
export * from "./timers.ts";
export * from "./turn-reducer.ts";
export * from "./vnc.ts";
