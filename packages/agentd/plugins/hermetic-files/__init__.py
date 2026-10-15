"""hermetic-files: exchange files and secrets with the hermetic operator.

A Hermes plugin, installed by `hermeticd apply` into
`$HERMES_HOME/plugins/hermetic-files/` and enabled by the managed
`/etc/hermes/config.yaml`. It talks to hermeticd over the box-local socket
(`FILES_SOCKET_PATH` in `@hermetic/core/shared`), which only the `hermes`
account can reach. The socket never accepts upload bytes, so nothing here can
fulfil a request: only the operator can, from the desktop app or the CLI.

Tools (toolset `hermetic_files`):

- `request_file`   open a request slot for a file and long-poll it.
- `request_secret` open a slot for named text secrets (`KEY=value`); the
                   result names the keys and a `load` line, never a value.
- `await_file`     re-enter the long-poll for an earlier request.
- `list_files`     inbox, open requests, outbox and secrets: metadata only.
- `share_file`     hand the operator a copy of a file on this box; hermeticd
                   checks the path (no credentials, no secrets, nothing
                   outside `/data/hermes`) and copies it into the outbox.

Hooks: `transform_tool_result` replaces every value of a materialised secret in
any tool result with `‹secret:KEY›` before the model sees it. Best effort: it
catches literal values, not encoded or transformed ones.
`transform_llm_output` turns each `MEDIA:/abs/path` line of a reply shown in a
hermetic surface (the desktop app, the box's terminal UIs) into a share,
rewriting it to `MEDIA:<outbox>/<share_id>/<name>` so the operator's app shows
it as an attachment; a refused share leaves the line as the model wrote it,
and a messaging gateway's replies are never touched.

Standard library only, Python 3.10 or later. Never raises into Hermes: every
failure becomes a JSON error result (tools) or `None` (the hook).

Edit this file in `packages/agentd/plugins/hermetic-files/`, never on the box:
the next apply rewrites it. hermeticd embeds it, so an edit needs
`hermetic artifacts push` to reach a fleet.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import shlex
import socket
import threading
import time
from typing import Any

# The hook's clock; a test may replace it.
_monotonic = time.monotonic
from urllib.parse import quote

PLUGIN_VERSION = "1.0.0"
TOOLSET = "hermetic_files"
EMOJI = "\N{PAPERCLIP}"

# Overridable for the plugin's own tests only; on a box these are fixed.
_SOCK_ENV = "HERMETIC_FILES_SOCK"
_SECRET_DIR_ENV = "HERMETIC_FILES_SECRET_DIR"
_DROP_DIR_ENV = "HERMETIC_FILES_DROP_DIR"
_DEFAULT_SOCK = "/run/hermetic/files.sock"
_DEFAULT_SECRET_DIR = "/run/hermetic/files"
_DEFAULT_DROP_DIR = "/run/hermetic/drop"

# `FILES_TTL` in `@hermetic/core/shared`: the box clamps a wait to 290 s, below
# Hermes's tool deadline, and the plugin polls in 25 s steps so an interrupt is
# noticed quickly.
WAIT_MAX = 290
WAIT_DEFAULT = 240
WAIT_STEP = 25

# `SECRET_TEXT_KEY_RE` / `SECRET_TEXT_MAX_KEYS`.
KEY_RE = re.compile(r"[A-Z_][A-Z0-9_]{0,63}")
MAX_KEYS = 16

# A secret value shorter than this is never scrubbed: too likely to collide
# with ordinary text.
SCRUB_MIN = 6
# The most of one secret file the scrub hook reads (the ephemeral cap).
SCRUB_READ_MAX = 1024 * 1024
# How long a listing of the box's secrets is trusted before it is asked again.
SCRUB_LIST_TTL = 5.0
# What goes into the one compiled alternation, so that building and running it
# stay cheap however large the secrets are. A value longer than
# SCRUB_REGEX_VALUE_MAX is matched as a literal (`str.replace`); a value with
# more lines than SCRUB_LINE_NEEDLES_MAX, a value over SCRUB_REGEX_VALUE_MAX,
# or any lines past SCRUB_LINE_BUDGET across every file have their lines
# matched from a set instead: whole lines and whole tokens of the result.
SCRUB_REGEX_VALUE_MAX = 64 * 1024
SCRUB_LINE_NEEDLES_MAX = 512
SCRUB_LINE_BUDGET = 2048

_OPEN_STATES = ("open", "receiving")

# `FILES_OUTBOX_DIR` in `@hermetic/core/shared`: where shares live. A MEDIA
# line already pointing here is a share, and is left alone.
OUTBOX_DIR = "/data/hermes/.hermes/outbox"
# `FILES_LIMITS.attachmentsPerTurn`: the most MEDIA lines one reply may share.
MEDIA_PER_TURN = 10
# A share copies up to the fleet's cap (256 MiB by default) before it answers.
SHARE_TIMEOUT = 180
# One `MEDIA:<path>` line: the tag alone on its line (any case), the path
# absolute or under `~`, optionally quoted or in backticks, optionally wrapped
# in up to three `*`/`_` of Markdown emphasis — the same on both sides, so a
# path that merely ends in `_` keeps it. Matched with `_match_media_line`, which
# strips the line's trailing `\r` and blanks first: a lazy path followed by a
# blank-run in the pattern rescans the run and backtracks quadratically.
_MEDIA_LINE_RE = re.compile(
    r"""^[ \t]*(?P<e>[*_]{0,3})media:[ \t]*(?P<q>[`"']?)(?P<path>(?:/|~/)[^\r\n]*?)(?P=q)(?P=e)$""",
    re.IGNORECASE,
)
# A longer line is never a MEDIA line: left as the model wrote it.
MEDIA_LINE_MAX = 4096
# A fenced code block's opening or closing line (CommonMark: up to three
# spaces of indent, three or more backticks or tildes). A MEDIA line inside one
# is an example, not a file to send — upstream's `_mask_protected_spans`.
_FENCE_RE = re.compile(r"^[ \t]{0,3}(?P<f>`{3,}|~{3,})(?P<rest>.*)$")
# Where the reply is shown in a hermetic surface — the desktop app's sessions
# (`HERMETIC_SESSION_SOURCE`, "hermetic") and the box's own terminal UIs —
# the only places a MEDIA line becomes a share. A messaging gateway
# (Telegram, Slack, …) keeps upstream's own MEDIA handling, `gateway.strict`
# included: a fresh outbox copy must not launder a path past it.
SHARE_PLATFORMS = frozenset({"hermetic", "tui", "cli"})
# Hermes abandons a hook after 30 s (`_HOOK_CALLBACK_TIMEOUT_SECS`); every share
# one reply makes must fit well inside it.
HOOK_DEADLINE = 20.0
# Below this much time left, no new share is started.
HOOK_MIN_SHARE = 0.5


def _match_media_line(line: str) -> tuple["re.Match[str]", str] | None:
    """The `_MEDIA_LINE_RE` match of one line and its trailing `\\r` (`""` if none), else `None`."""
    if len(line) > MEDIA_LINE_MAX:
        return None
    cr = "\r" if line.endswith("\r") else ""
    body = (line[:-1] if cr else line).rstrip(" \t")
    match = _MEDIA_LINE_RE.match(body)
    return (match, cr) if match else None


def _sock_path() -> str:
    return os.environ.get(_SOCK_ENV) or _DEFAULT_SOCK


def _secret_dir() -> str:
    return os.environ.get(_SECRET_DIR_ENV) or _DEFAULT_SECRET_DIR


def _drop_dir() -> str:
    return os.environ.get(_DROP_DIR_ENV) or _DEFAULT_DROP_DIR


# --- Talking to hermeticd ---------------------------------------------------


class BoxError(Exception):
    """A refusal or failure from hermeticd, or the socket being unreachable."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class _UnixConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float) -> None:
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        try:
            sock.connect(self._path)
        except BaseException:
            sock.close()
            raise
        self.sock = sock


def _call(method: str, path: str, body: Any = None, timeout: float = 30) -> dict:
    """One request to the socket; the decoded JSON object, or `BoxError`."""
    conn = _UnixConnection(_sock_path(), timeout)
    try:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json"} if payload is not None else {}
        conn.request(method, path, body=payload, headers=headers)
        response = conn.getresponse()
        raw = response.read()
        status = response.status
    except (OSError, http.client.HTTPException):
        # Never the exception text: it carries the socket path and errno noise.
        raise BoxError("UNAVAILABLE", "hermeticd's files service is not reachable on this box") from None
    finally:
        conn.close()
    try:
        data = json.loads(raw.decode("utf-8")) if raw else {}
    except (UnicodeDecodeError, ValueError):
        raise BoxError("INTERNAL", f"hermeticd answered {status} with something that is not JSON") from None
    if not isinstance(data, dict):
        raise BoxError("INTERNAL", f"hermeticd answered {status} with an unexpected shape")
    if status >= 400:
        err = data.get("error") if isinstance(data.get("error"), dict) else {}
        raise BoxError(str(err.get("code") or f"HTTP_{status}"), str(err.get("message") or f"hermeticd answered {status}"))
    return data


def _version_tuple(text: str) -> tuple[int, ...]:
    parts = []
    for piece in str(text).split("."):
        digits = re.match(r"\d+", piece)
        parts.append(int(digits.group(0)) if digits else 0)
    return tuple(parts)


_hello_lock = threading.Lock()
_hello_checked = False
_hello_warning: str | None = None


def _version_warning() -> str | None:
    """Ask `/hello` once per process; a warning when this plugin is older than the box wants."""
    global _hello_checked, _hello_warning
    with _hello_lock:
        if _hello_checked:
            return _hello_warning
        try:
            hello = _call("GET", "/hello", timeout=5)
        except BoxError:
            return None  # asked again next time; the tool call itself reports the outage
        _hello_checked = True
        minimum = hello.get("plugin_min")
        if isinstance(minimum, str) and _version_tuple(PLUGIN_VERSION) < _version_tuple(minimum):
            _hello_warning = (
                f"the hermetic-files plugin is {PLUGIN_VERSION} but hermeticd "
                f"{hello.get('hermeticd_version', '?')} wants {minimum} or later; "
                "ask the operator to re-apply this agent"
            )
        return _hello_warning


def _interrupted() -> bool:
    """Hermes's interrupt flag for this turn. Absent outside Hermes (the tests)."""
    try:
        from tools.interrupt import is_interrupted  # type: ignore[import-not-found]
    except Exception:
        return False
    try:
        return bool(is_interrupted())
    except Exception:
        return False


def _error(code: str, message: str, **extra: Any) -> str:
    return json.dumps({"status": "error", "error": {"code": code, "message": message}, **extra})


def _result(payload: dict) -> str:
    warning = _version_warning()
    if warning:
        payload = {**payload, "warning": warning}
    return json.dumps(payload)


def _clamp_wait(value: Any) -> int:
    if value is None:
        return WAIT_DEFAULT
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        return WAIT_DEFAULT
    return max(0, min(seconds, WAIT_MAX))


def _wait(request_id: str, wait_s: Any) -> dict:
    """Long-poll the slot in short steps; `pending` with `deliver_with` if it stays open."""
    rid = quote(request_id, safe="")
    left = _clamp_wait(wait_s)
    while left > 0:
        if _interrupted():
            return {"status": "interrupted", "request_id": request_id}
        step = min(left, WAIT_STEP)
        res = _call("GET", f"/requests/{rid}/wait?s={step}", timeout=step + 15)
        if res.get("status") not in _OPEN_STATES:
            return res
        left -= step
    if _interrupted():
        return {"status": "interrupted", "request_id": request_id}
    # A zero-second wait, not `GET /requests/:id`: that is the raw slot, which
    # has no `status` or `deliver_with` and carries the operator-facing refusal.
    res = _call("GET", f"/requests/{rid}/wait?s=0", timeout=15)
    if res.get("status") in _OPEN_STATES:
        res["status"] = "pending"
    return res


def _is_text_secret(res: dict) -> bool:
    """A `request_secret` answer, by what the box sent: its key names or its load line."""
    return isinstance(res.get("keys"), list) or isinstance(res.get("load"), str)


def _is_secret(res: dict) -> bool:
    return res.get("class") == "secret" or _is_text_secret(res)


def _view(res: dict) -> dict:
    """
    A wait result as a tool hands it to the model. Still waiting: only the
    status, the id, the other ways to send it and the expiry. Answered: never a
    refusal meant for the operator, and for a secret never its digest or size
    (a short secret's SHA-256 is a dictionary lookup away from its value).
    """
    status = res.get("status")
    if status in _OPEN_STATES or status == "pending":
        out: dict[str, Any] = {"status": "pending", "request_id": res.get("request_id")}
        for key in ("deliver_with", "expires_at"):
            if key in res:
                out[key] = res[key]
        return out
    out = {k: v for k, v in res.items() if k != "rejected"}
    if _is_secret(res):
        out.pop("sha256", None)
        out.pop("bytes", None)
    return out


def _is_secret_slot(slot: dict) -> bool:
    fulfilled = slot.get("fulfilled") if isinstance(slot.get("fulfilled"), dict) else {}
    return (
        slot.get("kind") == "secret_text"
        or slot.get("sensitivity") == "secret"
        or fulfilled.get("class") == "secret"
    )


def _list_view(listing: dict) -> dict:
    """`GET /files` for the model: no secret's digest or size, no secret slot's refusal."""
    out = dict(listing)
    for field in ("inbox", "outbox", "secrets"):
        entries = listing.get(field)
        if isinstance(entries, list):
            out[field] = [
                {k: v for k, v in e.items() if k not in ("sha256", "bytes")}
                if isinstance(e, dict) and (e.get("class") == "secret" or e.get("dir") in ("drop", "secret"))
                else e
                for e in entries
            ]
    requests = listing.get("requests")
    if isinstance(requests, list):
        slots = []
        for slot in requests:
            if isinstance(slot, dict) and _is_secret_slot(slot):
                slot = {k: v for k, v in slot.items() if k != "rejected"}
                if isinstance(slot.get("fulfilled"), dict):
                    slot["fulfilled"] = {
                        k: v for k, v in slot["fulfilled"].items() if k not in ("sha256", "bytes")
                    }
            slots.append(slot)
        out["requests"] = slots
    return out


def _remember(res: dict) -> None:
    """A fulfilled secret's path goes straight into the scrub hook's sources; an ordinary file's never does."""
    path = res.get("path")
    if res.get("status") == "fulfilled" and _is_secret(res) and isinstance(path, str) and path:
        _SCRUBBER.add_path(path)


# --- Tools --------------------------------------------------------------------


def request_file(args: dict, session_id: str | None = None, task_id: str | None = None, **_: Any) -> str:
    try:
        if not isinstance(args, dict) or not str(args.get("purpose") or "").strip():
            return _error("VALIDATION", "request_file needs a purpose to show the operator")
        body: dict[str, Any] = {"purpose": str(args["purpose"])}
        for key in ("name_hint", "accept", "max_bytes", "sensitivity", "durable"):
            if args.get(key) is not None:
                body[key] = args[key]
        if session_id:
            body["session_id"] = session_id
        if task_id:
            body["task_id"] = task_id
        # Opened without waiting: the plugin owns the long-poll so it can check
        # for an interrupt between steps.
        body["wait_s"] = 0
        slot = _call("POST", "/requests", body)
        request_id = slot.get("request_id")
        if not isinstance(request_id, str):
            return _error("INTERNAL", "hermeticd opened a request but returned no id")
        res = _wait(request_id, args.get("wait_s"))
        _remember(res)
        return _result(_view(res))
    except BoxError as e:
        return _error(e.code, e.message)
    except Exception:
        return _error("INTERNAL", "request_file failed unexpectedly")


def _load_line(path: str) -> str:
    # `secretTextLoad` in `@hermetic/core/shared`, quoted for the shell.
    return f"set -a; . {shlex.quote(path)}; set +a"


def _key_list(value: Any, field: str, required: bool) -> list[str]:
    if value is None and not required:
        return []
    if not isinstance(value, list) or (required and not value):
        raise BoxError("VALIDATION", f"request_secret: {field} must be a list of environment variable names")
    for key in value:
        if not isinstance(key, str) or not KEY_RE.fullmatch(key):
            raise BoxError("VALIDATION", f"request_secret: {key!r} is not an upper-case environment variable name")
    return list(value)


def _secret_result(res: dict) -> dict:
    """What `request_secret` hands the model: names, path and the load line. Never a value."""
    out: dict[str, Any] = {"status": res.get("status"), "request_id": res.get("request_id")}
    path = res.get("path")
    if res.get("status") == "fulfilled" and isinstance(path, str) and path:
        keys = res.get("keys")
        if not isinstance(keys, list):
            entries = _read_secret_file(path)
            keys = [k for k, _ in entries] if entries else []
        out.update(
            path=path,
            keys=keys,
            load=res.get("load") or _load_line(path),
            note=(
                "Use `load` in the same shell command that needs the variables, e.g. "
                "`" + _load_line(path) + "; <command>`. Never cat, echo or print the file."
            ),
        )
        if res.get("format"):
            out["format"] = res["format"]
    for key in ("deliver_with", "expires_at", "by"):
        if key in res:
            out[key] = res[key]
    return out


def request_secret(args: dict, session_id: str | None = None, task_id: str | None = None, **_: Any) -> str:
    try:
        if not isinstance(args, dict) or not str(args.get("purpose") or "").strip():
            return _error("VALIDATION", "request_secret needs a purpose to show the operator")
        keys = _key_list(args.get("keys"), "keys", True)
        optional = _key_list(args.get("optional_keys"), "optional_keys", False)
        if len(keys) + len(optional) > MAX_KEYS:
            return _error("VALIDATION", f"request_secret takes at most {MAX_KEYS} keys")
        body: dict[str, Any] = {"kind": "secret_text", "purpose": str(args["purpose"]), "keys": keys, "wait_s": 0}
        if optional:
            body["optional_keys"] = optional
        for key in ("slug", "durable", "input"):
            if args.get(key) is not None:
                body[key] = args[key]
        if session_id:
            body["session_id"] = session_id
        if task_id:
            body["task_id"] = task_id
        slot = _call("POST", "/requests", body)
        request_id = slot.get("request_id")
        if not isinstance(request_id, str):
            return _error("INTERNAL", "hermeticd opened a request but returned no id")
        res = _wait(request_id, args.get("wait_s"))
        _remember(res)
        return _result(_secret_result(res))
    except BoxError as e:
        return _error(e.code, e.message)
    except Exception:
        return _error("INTERNAL", "request_secret failed unexpectedly")


def await_file(args: dict, **_: Any) -> str:
    try:
        request_id = args.get("request_id") if isinstance(args, dict) else None
        if not isinstance(request_id, str) or not request_id:
            return _error("VALIDATION", "await_file needs the request_id an earlier request returned")
        res = _wait(request_id, args.get("wait_s"))
        _remember(res)
        # A text secret answers the same way `request_secret` did: no values,
        # and the line that loads them. Decided by what the box says the slot
        # is, never by the file name: a file request may deliver `x.env` too.
        if res.get("status") == "fulfilled" and _is_text_secret(res):
            return _result(_secret_result(res))
        return _result(_view(res))
    except BoxError as e:
        return _error(e.code, e.message)
    except Exception:
        return _error("INTERNAL", "await_file failed unexpectedly")


def list_files(args: dict | None = None, **_: Any) -> str:
    try:
        return _result(_list_view(_call("GET", "/files")))
    except BoxError as e:
        return _error(e.code, e.message)
    except Exception:
        return _error("INTERNAL", "list_files failed unexpectedly")


def _share(path: str, note: Any = None, name: Any = None, timeout: float = SHARE_TIMEOUT) -> dict:
    """`POST /outbox`: the share as the box answered it, or `BoxError`.

    A timeout closes the connection, and hermeticd stops a copy whose caller
    went away and removes it: no share is left behind that nobody named.
    """
    full = os.path.abspath(os.path.expanduser(path))
    body: dict[str, Any] = {"path": full}
    if isinstance(note, str) and note.strip():
        body["note"] = note
    if isinstance(name, str) and name.strip():
        body["name"] = name
    return _call("POST", "/outbox", body, timeout=timeout)


def share_file(args: dict, **_: Any) -> str:
    try:
        path = args.get("path") if isinstance(args, dict) else None
        if not isinstance(path, str) or not path.strip():
            return _error("VALIDATION", "share_file needs the path of a file on this box")
        return _result(_share(path, args.get("note"), args.get("name")))
    except BoxError as e:
        return _error(e.code, e.message)
    except Exception:
        return _error("INTERNAL", "share_file failed unexpectedly")


def _in_outbox(path: str) -> bool:
    return os.path.normpath(path).startswith(OUTBOX_DIR + "/")


def _share_media_line(path: str, shared: dict[str, str | None], timeout: float) -> str | None:
    """The outbox path for one MEDIA path, sharing it once per turn; `None` when refused or failed."""
    if path not in shared:
        try:
            res = _share(path, timeout=timeout)
            share_id, name = res.get("share_id"), res.get("name")
            ok = isinstance(share_id, str) and isinstance(name, str) and share_id and name
            shared[path] = f"{OUTBOX_DIR}/{share_id}/{name}" if ok else None
        except Exception:
            shared[path] = None
    return shared[path]


def _fence_step(line: str, fence: tuple[str, int] | None) -> tuple[tuple[str, int] | None, bool]:
    """The fence state after `line`, and whether `line` is itself a fence line."""
    match = _FENCE_RE.match(line)
    if not match:
        return fence, False
    marks = match.group("f")
    if fence is None:
        return (marks[0], len(marks)), True
    closes = marks[0] == fence[0] and len(marks) >= fence[1] and not match.group("rest").strip()
    return (None if closes else fence), True


def transform_llm_output(*args: Any, **kwargs: Any) -> str | None:
    """
    `transform_llm_output`: each `MEDIA:/abs/path` line of the reply shared and
    rewritten to its outbox copy, or `None` when nothing changed.

    Only on a hermetic surface (`SHARE_PLATFORMS`); anywhere else `None`, and
    the gateway handles MEDIA lines its own way. Not inside a fenced code
    block. At most `MEDIA_PER_TURN` paths per turn, all within `HOOK_DEADLINE`:
    a refused or failed share, a line already in the outbox, a line past the
    limit and a line the deadline did not reach all stay as written. Never
    raises.
    """
    try:
        if kwargs.get("platform") not in SHARE_PLATFORMS:
            return None
        text = kwargs.get("response_text", args[0] if args else None)
        if not isinstance(text, str) or "media:" not in text.lower():
            return None
        deadline = _monotonic() + HOOK_DEADLINE
        lines = text.split("\n")
        shared: dict[str, str | None] = {}
        attempts = 0
        changed = False
        fence: tuple[str, int] | None = None
        for i, line in enumerate(lines):
            fence, is_fence = _fence_step(line, fence)
            if is_fence or fence is not None:
                continue
            found = _match_media_line(line)
            if found is None:
                continue
            match, cr = found
            path = match.group("path").strip()
            if _in_outbox(os.path.expanduser(path)):
                continue
            if path not in shared:
                left = deadline - _monotonic()
                if attempts >= MEDIA_PER_TURN or left < HOOK_MIN_SHARE:
                    continue
                attempts += 1
                _share_media_line(path, shared, left)
            target = shared.get(path)
            if target:
                lines[i] = f"MEDIA:{target}{cr}"
                changed = True
        return "\n".join(lines) if changed else None
    except Exception:
        return None  # fail open: Hermes keeps the reply as the model wrote it


# --- Canonical secret files ---------------------------------------------------
#
# The Python twin of `readCanonicalSecretEnv` (`@hermetic/core/shared/secret-env.ts`):
# `KEY="…"\n` entries and nothing else, quoted the way sh reads them so the
# file can be sourced with `set -a; . <file>; set +a`. Inside the quotes `\`,
# `"`, `$` and backtick are backslash-escaped and a newline is a real newline;
# there are no other escapes. Any deviation is `None`.
# `tests/secret-env-seam.test.ts` holds the two to the same fixtures; change
# them together.

_CANONICAL_RE = re.compile(r'(?:[A-Z_][A-Z0-9_]{0,63}="(?:[^"\\$`]|\\["\\$`])*"\n)*')
_CANONICAL_ENTRY_RE = re.compile(r'([A-Z_][A-Z0-9_]{0,63})="((?:[^"\\$`]|\\["\\$`])*)"\n')
_CONTROL_RE = re.compile("[\u0000-\u0008\u000b-\u001f\u007f-\u009f]")
_ESCAPE_RE = re.compile(r'\\(["\\$`])')


def read_canonical_secret_env(text: str) -> list[tuple[str, str]] | None:
    if not _CANONICAL_RE.fullmatch(text) or _CONTROL_RE.search(text):
        return None
    entries: list[tuple[str, str]] = []
    seen: set[str] = set()
    for m in _CANONICAL_ENTRY_RE.finditer(text):
        key = m.group(1)
        if key in seen:
            return None
        seen.add(key)
        value = _ESCAPE_RE.sub(r"\1", m.group(2))
        entries.append((key, value))
    return entries


def _read_secret_file(path: str) -> list[tuple[str, str]] | None:
    """`(KEY, value)` pairs: env keys for a canonical `.env`, else the file name for the whole file."""
    try:
        with open(path, "rb") as f:
            raw = f.read(SCRUB_READ_MAX + 1)
    except OSError:
        return None
    if len(raw) > SCRUB_READ_MAX:
        raw = raw[:SCRUB_READ_MAX]
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None  # binary: it cannot appear in a text result as itself
    name = os.path.basename(path)
    if name.endswith(".env"):
        entries = read_canonical_secret_env(text)
        if entries is not None:
            return entries
    return [(name, text)]


# --- The scrub hook -----------------------------------------------------------

_ARMOUR_RE = re.compile(r"-----(?:BEGIN|END) [^-]+-----")
# A result's line breaks, real or JSON-escaped.
_LINE_SEP_RE = re.compile(r"(\r?\n|\\r\\n|\\n)")
# A result's tokens: runs between whitespace, quotes and JSON escapes. Group 1
# is a token; anything else is a separator, kept as it is.
_TOKEN_RE = re.compile(r'\\[nrt"\\]|[\s"\']+|((?:(?!\\[nrt"\\])[^\s"\'])+)')


def _escaped(form: str) -> list[str]:
    """`form`, and how it reads inside a JSON string, where a tool result often puts it."""
    out = [form]
    for ascii_only in (False, True):
        escaped = json.dumps(form, ensure_ascii=ascii_only)[1:-1]
        if escaped not in out:
            out.append(escaped)
    return out


def _value_parts(value: str) -> tuple[str | None, list[str]]:
    """A value's whole form (if long enough to scrub) and its scrubbable lines."""
    whole = value.rstrip("\r\n")
    lines: list[str] = []
    if "\n" in whole:
        for line in whole.split("\n"):
            line = line.strip()
            if len(line) >= SCRUB_MIN and not _ARMOUR_RE.fullmatch(line):
                lines.append(line)
    return (whole if len(whole) >= SCRUB_MIN else None), lines


def _needles(key: str, value: str) -> list[tuple[str, str]]:
    """Every literal form of `value` worth replacing, each with its label."""
    label = f"\u2039secret:{key}\u203a"
    whole, lines = _value_parts(value)
    forms = ([whole] if whole is not None else []) + lines
    return [(escaped, label) for form in forms for escaped in _escaped(form)]


class _Matcher:
    """
    One snapshot of every needle, built off the lock and swapped in whole.

    Three tiers, longest first: values too large for the alternation as
    literals, then the alternation (the remaining whole values, and the lines
    of values small enough to list), then lines matched from a set — a result
    line, or a token of one, equal to a secret's line.
    """

    def __init__(self, entries: list[tuple[str, str]]) -> None:
        labels: dict[str, str] = {}
        literals: dict[str, str] = {}
        lines: dict[str, str] = {}
        budget = SCRUB_LINE_BUDGET
        for key, value in entries:
            label = f"\u2039secret:{key}\u203a"
            whole, value_lines = _value_parts(value)
            if whole is not None:
                into = literals if len(whole) > SCRUB_REGEX_VALUE_MAX else labels
                for form in _escaped(whole):
                    into.setdefault(form, label)
            listable = len(whole or "") <= SCRUB_REGEX_VALUE_MAX and len(value_lines) <= SCRUB_LINE_NEEDLES_MAX
            if listable and len(value_lines) <= budget:
                budget -= len(value_lines)
                into = labels
            else:
                into = lines
            for line in value_lines:
                for form in _escaped(line):
                    into.setdefault(form, label)
        # Longest first: at any position the alternation takes the first
        # alternative that matches, so a whole value beats one of its own lines.
        ordered = sorted(labels, key=len, reverse=True)
        self.pattern = re.compile("|".join(map(re.escape, ordered))) if ordered else None
        self.labels = labels
        self.literals = sorted(literals.items(), key=lambda item: len(item[0]), reverse=True)
        self.lines = lines

    def empty(self) -> bool:
        return self.pattern is None and not self.literals and not self.lines

    def _line(self, piece: str) -> str:
        stripped = piece.strip()
        label = self.lines.get(stripped) if stripped else None
        if label is not None:
            return piece.replace(stripped, label, 1)
        return _TOKEN_RE.sub(self._token, piece)

    def _token(self, m: re.Match[str]) -> str:
        token = m.group(1)
        if token is None:
            return m.group(0)
        return self.lines.get(token, token)

    def sub(self, text: str) -> str:
        for needle, label in self.literals:
            if needle in text:
                text = text.replace(needle, label)
        if self.pattern is not None:
            labels = self.labels
            text = self.pattern.sub(lambda m: labels[m.group(0)], text)
        if self.lines:
            parts = _LINE_SEP_RE.split(text)
            # Odd indices are the separators the split kept.
            text = "".join(p if i % 2 else self._line(p) for i, p in enumerate(parts))
        return text


class _Scrubber:
    """
    Values of the box's materialised secrets, cached by file mtime and size.

    The lock guards only the bookkeeping. Listing the box (a socket call of up
    to 3 s), reading files and compiling the matcher all happen outside it, and
    the finished matcher replaces the old one in a single assignment, so one
    slow refresh never holds up another thread's scrub.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._list_lock = threading.Lock()
        self._files: dict[str, tuple[int, int, list[tuple[str, str]]]] = {}
        self._known: set[str] = set()
        self._listed: set[str] = set()
        self._listed_at = 0.0
        self._listed_dirs: tuple = ()
        self._built: tuple[tuple, _Matcher | None] = ((), None)

    def add_path(self, path: str) -> None:
        with self._lock:
            self._known.add(path)

    def _dir_stamp(self, path: str) -> tuple:
        try:
            st = os.stat(path)
            return (path, st.st_mtime_ns)
        except OSError:
            return (path, None)

    def _walk(self) -> set[str] | None:
        """Every file under the secret dirs, or `None` when they cannot be listed (the box: 0711)."""
        found: set[str] = set()
        try:
            secret_dir = _secret_dir()
            for name in os.listdir(secret_dir):
                if not name.startswith("."):
                    found.add(os.path.join(secret_dir, name))
            drop_dir = _drop_dir()
            if os.path.isdir(drop_dir):
                for request_dir in os.listdir(drop_dir):
                    sub = os.path.join(drop_dir, request_dir)
                    if os.path.isdir(sub):
                        for name in os.listdir(sub):
                            if not name.startswith("."):
                                found.add(os.path.join(sub, name))
        except OSError:
            return None
        return found

    def _from_box(self) -> set[str]:
        """Secret paths from hermeticd's index, re-asked when a dir changes or the listing ages."""
        dirs = (self._dir_stamp(_secret_dir()), self._dir_stamp(_drop_dir()))
        if dirs == self._listed_dirs and time.monotonic() - self._listed_at < SCRUB_LIST_TTL:
            return self._listed
        # One refresh at a time; anyone else scrubs with the last listing.
        if not self._list_lock.acquire(blocking=False):
            return self._listed
        try:
            try:
                listing = _call("GET", "/files", timeout=3)
            except BoxError:
                return self._listed
            paths = set()
            for entry in listing.get("secrets") or []:
                if isinstance(entry, dict) and isinstance(entry.get("path"), str):
                    paths.add(entry["path"])
            self._listed, self._listed_at, self._listed_dirs = paths, time.monotonic(), dirs
            return paths
        finally:
            self._list_lock.release()

    def _paths(self) -> set[str]:
        with self._lock:
            known = set(self._known)
        walked = self._walk()
        if walked is not None:
            return walked | known
        return self._from_box() | known

    def matcher(self) -> _Matcher | None:
        paths = self._paths()
        with self._lock:
            cache = self._files
        files: dict[str, tuple[int, int, list[tuple[str, str]]]] = {}
        for path in paths:
            try:
                st = os.stat(path)
            except OSError:
                continue  # gone: a consumed or removed secret stops being scrubbed
            cached = cache.get(path)
            if cached and cached[0] == st.st_mtime_ns and cached[1] == st.st_size:
                files[path] = cached
                continue
            entries = _read_secret_file(path) or []
            files[path] = (st.st_mtime_ns, st.st_size, entries)
        with self._lock:
            self._files = files
            # Only what this pass looked for and found gone: a path added meanwhile stays.
            self._known -= paths - set(files)
        signature = tuple(sorted((p, m, s) for p, (m, s, _) in files.items()))
        built = self._built
        if built[0] == signature:
            return built[1]
        matcher = _Matcher([entry for _, _, entries in files.values() for entry in entries])
        result = None if matcher.empty() else matcher
        self._built = (signature, result)
        return result


_SCRUBBER = _Scrubber()


def scrub(text: str) -> str:
    matcher = _SCRUBBER.matcher()
    if matcher is None:
        return text
    return matcher.sub(text)


def transform_tool_result(*args: Any, **kwargs: Any) -> str | None:
    """`transform_tool_result`: the result with every secret value replaced, or `None` to keep it."""
    try:
        result = kwargs.get("result", args[2] if len(args) > 2 else None)
        if not isinstance(result, str) or not result:
            return None
        cleaned = scrub(result)
        return cleaned if cleaned != result else None
    except Exception:
        return None  # fail open: Hermes keeps the original result


# --- Registration -------------------------------------------------------------

_WAIT_PARAM = {
    "type": "integer",
    "minimum": 0,
    "maximum": WAIT_MAX,
    "description": f"Seconds to wait for the operator, at most {WAIT_MAX} (default {WAIT_DEFAULT}).",
}

_SECRET_HANDLING = (
    " The result names the file and the keys, never the values. Use its `load` line in the "
    "same shell command that needs the variables (`set -a; . <path>; set +a; <command>`), or "
    "point a program's --env-file at the path. Never cat, echo or print the file: values "
    "that reach a tool result are replaced with ‹secret:KEY›."
)


def _schema(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "name": name,
        "description": description,
        "parameters": {"type": "object", "properties": properties, "required": required},
    }


REQUEST_FILE_SCHEMA = _schema(
    "request_file",
    "Ask the human operator for a file (a key, a certificate, a document, an image). The "
    "request appears as a card in their app; this call waits for them. On `fulfilled` the "
    "result gives the file's path on this box. On `pending`, tell the operator the request "
    "is open (deliver_with lists other ways to send it) and call await_file later. For a "
    "secret file (sensitivity: secret) the same rules as request_secret apply: never print "
    "its contents.",
    {
        "purpose": {"type": "string", "description": "Why you need it, shown verbatim to the operator."},
        "name_hint": {"type": "string", "description": "A file name for it, e.g. github-app.pem."},
        "accept": {
            "type": "array",
            "items": {"type": "string"},
            "description": 'MIME types or .ext entries, e.g. ["application/x-pem-file", ".pem"].',
        },
        "max_bytes": {"type": "integer", "minimum": 1, "description": "Largest acceptable size in bytes."},
        "sensitivity": {
            "type": "string",
            "enum": ["normal", "secret"],
            "description": "secret keeps it off the data volume and out of snapshots.",
        },
        "durable": {"type": "boolean", "description": "Secret only: survive a reboot (default true)."},
        "wait_s": _WAIT_PARAM,
    },
    ["purpose"],
)

REQUEST_SECRET_SCHEMA = _schema(
    "request_secret",
    "Ask the human operator for text secrets such as API tokens, passwords or a .env block, "
    "by environment variable name. They paste the values into a masked box in their app, "
    "and hermeticd writes them to a file on this box." + _SECRET_HANDLING,
    {
        "purpose": {"type": "string", "description": "Why you need it, shown verbatim to the operator."},
        "keys": {
            "type": "array",
            "items": {"type": "string", "pattern": "^[A-Z_][A-Z0-9_]{0,63}$"},
            "minItems": 1,
            "maxItems": MAX_KEYS,
            "description": 'Required variable names, e.g. ["GITHUB_TOKEN"].',
        },
        "optional_keys": {
            "type": "array",
            "items": {"type": "string", "pattern": "^[A-Z_][A-Z0-9_]{0,63}$"},
            "description": "Names the operator may also provide.",
        },
        "slug": {"type": "string", "description": "File name stem; derived from the first key by default."},
        "durable": {"type": "boolean", "description": "Survive a reboot (default true)."},
        "input": {
            "type": "string",
            "enum": ["auto", "single", "multi"],
            "description": "The input box's starting mode; the operator can switch.",
        },
        "wait_s": _WAIT_PARAM,
    },
    ["purpose", "keys"],
)

AWAIT_FILE_SCHEMA = _schema(
    "await_file",
    "Wait again for a request_file or request_secret that came back pending. Returns at once "
    "if it has already been fulfilled, declined or has expired.",
    {
        "request_id": {"type": "string", "description": "The request_id an earlier request returned."},
        "wait_s": _WAIT_PARAM,
    },
    ["request_id"],
)

LIST_FILES_SCHEMA = _schema(
    "list_files",
    "List this box's files: the inbox (attachments from the operator in earlier turns), "
    "open requests, the outbox (files you shared with share_file or a MEDIA: line, kept "
    "24 hours) and secrets. Metadata only: names, sizes, ages, paths.",
    {},
    [],
)

SHARE_FILE_SCHEMA = _schema(
    "share_file",
    "Give the human operator a copy of a file on this box: a report, a chart, an export. "
    "hermeticd copies it into the outbox, and it appears in their app as an attachment they "
    "can preview or save, for 24 hours; later edits to your file do not change the copy. "
    "Only regular files under /data/hermes can be shared: credentials (.env, .ssh, keys, "
    "tokens) and secrets are refused, and a refusal says why. Writing MEDIA:/absolute/path "
    "on its own line in your reply shares the same way.",
    {
        "path": {"type": "string", "description": "Absolute path of the file, e.g. /data/hermes/work/report.pdf."},
        "note": {"type": "string", "description": "A short note shown with the file."},
        "name": {"type": "string", "description": "The name to give the copy; the file's own by default."},
    },
    ["path"],
)

TOOLS = (
    ("request_file", REQUEST_FILE_SCHEMA, request_file),
    ("request_secret", REQUEST_SECRET_SCHEMA, request_secret),
    ("await_file", AWAIT_FILE_SCHEMA, await_file),
    ("list_files", LIST_FILES_SCHEMA, list_files),
    ("share_file", SHARE_FILE_SCHEMA, share_file),
)


def register(ctx: Any) -> None:
    for name, schema, handler in TOOLS:
        ctx.register_tool(
            name=name,
            toolset=TOOLSET,
            schema=schema,
            handler=handler,
            description=schema["description"],
            emoji=EMOJI,
        )
    ctx.register_hook("transform_tool_result", transform_tool_result)
    ctx.register_hook("transform_llm_output", transform_llm_output)
