"""prme: PRME ("Prism") long-term memory for Hermes.

A Hermes MemoryProvider plugin, installed by `hermeticd apply` into
`$HERMES_HOME/plugins/prme/` for an agent on the `prism` memory provider and
selected by the managed `/etc/hermes/config.yaml` (`memory.provider: prme`).
It talks to the box's PRME server (`hermetic-memory.service`) over loopback at
`PRME_API_URL`, which the Hermes units set, else `DEFAULT_API_URL`: a `hermes`
run from a shell or another profile has no unit environment and must reach the
same server. The server binds 127.0.0.1 only, so it takes no credential.

HTTP only, never `prme` in process: exactly one process, the server, opens the
pack.

- `prefetch` recalls up to eight memories for the coming turn.
- `sync_turn` stores both sides of a finished turn, on a background thread,
  without LLM extraction (the box has no model for PRME to call).
- Tools: `memory_search`, `memory_store`, `memory_forget` (archives a node; PRME
  keeps the source event).

Never raises into Hermes: a failed recall is an empty block, a failed write is
a debug log line, a failed tool call is a JSON error.

Edit this file in `packages/agentd/plugins/prme/`, never on the box: the next
apply rewrites it. hermeticd embeds it, so an edit needs `hermetic artifacts
push` to reach a fleet, and a bump of `version` in `plugin.yaml` and of the
`+plugin-<n>` suffix of `MEMORY_SERVICES.prism.pin`.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any
from urllib.parse import quote

import httpx

from agent.memory_provider import MemoryProvider, spawn_context_thread

logger = logging.getLogger(__name__)

# PRISM_PORT in @hermetic/core/shared; a test holds the two together.
DEFAULT_API_URL = "http://127.0.0.1:18010"
# The realm is the instance: one memory shared by every profile and session on
# the box. Hermes's session id is only recorded on store, never a retrieval filter.
_USER_ID = "hermes"
# Under Hermes's 8 s prefetch bound, so a slow server costs a turn nothing worse than no recall.
_TIMEOUT_S = 5.0
_PREFETCH_LIMIT = 8
_SEARCH_LIMIT_MAX = 20
# Mutate the shared memory, so subagents, cron and flush runs never get them.
_WRITE_TOOLS = frozenset({"memory_store", "memory_forget"})

_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "memory_search",
        "description": "Search long-term memory. Returns matching memories with their node ids.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to look for."},
                "limit": {"type": "integer", "description": "Max results (default 8, max 20)."},
            },
            "required": ["query"],
        },
    },
    {
        "name": "memory_store",
        "description": "Save a fact, preference or decision to long-term memory.",
        "parameters": {
            "type": "object",
            "properties": {"content": {"type": "string", "description": "What to remember."}},
            "required": ["content"],
        },
    },
    {
        "name": "memory_forget",
        "description": "Forget one memory by the node id memory_search returned.",
        "parameters": {
            "type": "object",
            "properties": {"node_id": {"type": "string", "description": "The memory's node id."}},
            "required": ["node_id"],
        },
    },
]


def _error(message: str) -> str:
    return json.dumps({"error": message[:500]}, ensure_ascii=False)


class PrmeMemoryProvider(MemoryProvider):
    """PRME over its local HTTP API: recall before a turn, store after it, three tools."""

    def __init__(self) -> None:
        self._base = ""
        self._session_id = ""
        self._writes = True
        self._threads: list[threading.Thread] = []

    @property
    def name(self) -> str:
        return "prme"

    def is_available(self) -> bool:
        # Installed only on a box that runs the server; DEFAULT_API_URL covers a missing env.
        return True

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._base = (os.environ.get("PRME_API_URL", "").strip() or DEFAULT_API_URL).rstrip("/")
        self._session_id = session_id
        # Subagents, cron and flush runs read memory but never write turns into it.
        self._writes = (kwargs.get("agent_context") or "primary") == "primary"

    def system_prompt_block(self) -> str:
        return (
            "# Long-term memory (PRME)\n"
            "Relevant memories are recalled into each turn. Use memory_search to look for more, "
            "memory_store to save something worth keeping, and memory_forget with a node id "
            "from memory_search to drop one that is wrong or outdated."
        )

    # -- HTTP -----------------------------------------------------------------

    def _call(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        resp = httpx.request(method, f"{self._base}{path}", json=body, timeout=_TIMEOUT_S)
        resp.raise_for_status()
        return resp.json()

    def _retrieve(self, query: str, limit: int) -> list[dict[str, Any]]:
        # RetrieveRequest forbids unknown keys and has no session filter: recall spans sessions.
        out = self._call("POST", "/v1/retrieve", {"query": query, "user_id": _USER_ID, "limit": limit})
        return [r for r in out.get("results", []) if isinstance(r, dict) and r.get("content")]

    def _store(self, content: str, role: str, session_id: str, **extra: Any) -> dict[str, Any]:
        body: dict[str, Any] = {"content": content, "user_id": _USER_ID, "role": role, "extract": False, **extra}
        if session_id:
            body["session_id"] = session_id
        return self._call("POST", "/v1/store", body)

    # -- Lifecycle ------------------------------------------------------------

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if not self._base or not query.strip():
            return ""
        try:
            results = self._retrieve(query, _PREFETCH_LIMIT)
        except Exception as exc:  # recall is best effort: no block rather than a failed turn
            logger.debug("prme recall failed: %s", exc)
            return ""
        lines = [f"- {' '.join(str(r['content']).split())}" for r in results]
        return "Relevant memories:\n" + "\n".join(lines) if lines else ""

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "", **_: Any) -> None:
        if not self._base or not self._writes:
            return
        sid = session_id or self._session_id
        turn = [(role, text) for role, text in (("user", user_content), ("assistant", assistant_content)) if text]
        if not turn:
            return
        self._threads = [t for t in self._threads if t.is_alive()]
        thread = spawn_context_thread(self._write_turn, args=(turn, sid), name="prme-sync")
        self._threads.append(thread)
        thread.start()

    def _write_turn(self, turn: list[tuple[str, str]], session_id: str) -> None:
        for role, text in turn:
            try:
                self._store(text, role, session_id)
            except Exception as exc:
                logger.debug("prme store (%s) failed: %s", role, exc)

    def shutdown(self) -> None:
        for thread in self._threads:
            thread.join(timeout=_TIMEOUT_S)
        self._threads = []

    # -- Tools ----------------------------------------------------------------

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        # Hermes initializes before injecting tools, so a non-primary context only gets search.
        return [s for s in _SCHEMAS if self._writes or s["name"] not in _WRITE_TOOLS]

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs: Any) -> str:
        if not self._base:
            return _error("PRME memory is not initialized")
        try:
            return json.dumps(self._dispatch(tool_name, args), ensure_ascii=False)
        except httpx.HTTPStatusError as exc:
            return _error(f"PRME answered {exc.response.status_code}: {exc.response.text}")
        except Exception as exc:
            return _error(str(exc))

    def _dispatch(self, tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
        if tool_name in _WRITE_TOOLS and not self._writes:
            return {"error": f"{tool_name} is unavailable outside the primary agent"}
        if tool_name == "memory_search":
            query = str(args.get("query") or "").strip()
            if not query:
                return {"error": "query is required"}
            limit = max(1, min(int(args.get("limit") or _PREFETCH_LIMIT), _SEARCH_LIMIT_MAX))
            results = self._retrieve(query, limit)
            return {"results": [{"node_id": r.get("node_id"), "content": r["content"]} for r in results]}
        if tool_name == "memory_store":
            content = str(args.get("content") or "").strip()
            if not content:
                return {"error": "content is required"}
            # An explicit null disables PRME's 90-day default TTL for notes: kept until forgotten.
            out = self._store(content, "assistant", self._session_id, node_type="note", ttl_days=None)
            return {"stored": True, "node_id": out.get("node_id")}
        if tool_name == "memory_forget":
            node_id = str(args.get("node_id") or "").strip()
            if not node_id:
                return {"error": "node_id is required"}
            out = self._call("PUT", f"/v1/nodes/{quote(node_id, safe='')}/archive")
            return {"forgotten": True, "node_id": node_id, "lifecycle_state": out.get("lifecycle_state")}
        return {"error": f"unknown tool: {tool_name}"}


def register(ctx) -> None:
    """Register PRME as a memory provider plugin."""
    ctx.register_memory_provider(PrmeMemoryProvider())
