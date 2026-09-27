/**
 * Source-derived request contract, not a recording of a successful RPC.
 *
 * Read from the local Hermes mirror at v2026.9.14, commit
 * 7a963716b81be13ba513d4f127633b7da493aff2:
 * - tui_gateway/contracts/sessions.py:395: SessionHistoryParams(SessionParams)
 *   adds no fields.
 * - tui_gateway/contracts/common.py:191: SessionParams declares session_id and
 *   optional profile.
 * - tui_gateway/contracts/base.py:35: Params rejects extra fields.
 *
 * A read against silent-crane on 2026-09-17 confirmed the rejection direction:
 * "invalid params for session.history: limit: Extra inputs are not permitted".
 * The old double accepted every parameter and its assertion required forwarding
 * limit, so it proved precisely the request that the real box rejected. Keep
 * the whitelist separate from adapter implementation and make the RPC double
 * enforce it if the adapter regresses to the runtime-only RPC.
 *
 * The final durable read uses hermes_cli/web_routers/sessions.py:528 instead:
 * its GET /api/sessions/{id}/messages endpoint accepts profile, limit, offset,
 * and order. hermes_state_messages.py:774 documents that latest pages still
 * return chronological rows, with numeric SQLite IDs. Test REST rows are
 * constructed from that contract, not labelled as live recordings.
 */
export const SESSION_HISTORY_PARAM_KEYS = ["session_id", "profile"] as const;

/**
 * Sanitized shape from the 2026-09-17 live REST read of test-owned rows 55/56.
 * Identifiers and command/output were replaced with fixture values. The split
 * between function arguments and the separate tool result is preserved exactly.
 */
export const DURABLE_TOOL_ROWS = [
  {
    id: 55,
    role: "assistant",
    content: "",
    tool_call_id: null,
    tool_calls: [
      {
        id: "call_FIXTURE",
        call_id: "call_FIXTURE",
        response_item_id: "fc_FIXTURE",
        type: "function",
        function: { name: "terminal", arguments: '{"command":"printf FIXTURE"}' },
      },
    ],
    tool_name: null,
    timestamp: 1789679977.1513968,
    finish_reason: "tool_calls",
    display_kind: null,
  },
  {
    id: 56,
    role: "tool",
    content: '{"output":"FIXTURE\\n","exit_code":0,"error":null}',
    tool_call_id: "call_FIXTURE",
    tool_calls: null,
    tool_name: "terminal",
    timestamp: 1789679977.749358,
    display_kind: null,
  },
] as const;
