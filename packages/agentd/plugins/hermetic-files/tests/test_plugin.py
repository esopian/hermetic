"""The hermetic-files plugin against a fake hermeticd socket.

Standard library only, no Hermes: `tools.interrupt` is stubbed, and the socket
is a threaded HTTP server on a Unix socket in a temp dir, answering with the
shared fixtures in `tests/fixtures/files/` (the same documents the TypeScript
side's seam tests read). Run with `python3 -m unittest discover -s <this dir>`,
or through `bun test packages/agentd/test/plugin.test.ts`.

Every secret here is a FIXTURE sentinel.
"""

from __future__ import annotations

import http.server
import importlib.util
import json
import os
import random
import shutil
import socketserver
import string
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path

# No __pycache__ beside the plugin: the release fingerprint hashes every file
# under packages/agentd/plugins.
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
PLUGIN_DIR = HERE.parent
REPO = PLUGIN_DIR.parents[3]
FIXTURES = REPO / "tests" / "fixtures" / "files"

# Hermes's interrupt flag, stubbed before the plugin can look for it.
INTERRUPTED = [False]
_tools = types.ModuleType("tools")
_interrupt = types.ModuleType("tools.interrupt")
_interrupt.is_interrupted = lambda: INTERRUPTED[0]  # type: ignore[attr-defined]
_tools.interrupt = _interrupt  # type: ignore[attr-defined]
sys.modules.setdefault("tools", _tools)
sys.modules["tools.interrupt"] = _interrupt


def load_plugin() -> types.ModuleType:
    spec = importlib.util.spec_from_file_location("hermetic_files_plugin", PLUGIN_DIR / "__init__.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


plugin = load_plugin()


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def has_fixture(name: str) -> bool:
    return (FIXTURES / name).exists()


class _Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class FakeBox:
    """A scripted hermeticd socket. `routes[(method, path-without-query)]` → `(status, body)`,
    or a function of the request body returning one."""

    def __init__(self, sock: str) -> None:
        self.routes: dict[tuple[str, str], object] = {}
        self.calls: list[tuple[str, str, dict | None]] = []
        box = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def _answer(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                body = json.loads(raw) if raw else None
                box.calls.append((self.command, self.path, body))
                route = box.routes.get((self.command, self.path.split("?")[0]))
                if callable(route):
                    route = route(body)
                status, payload = route if route else (404, {"error": {"code": "NOT_FOUND", "message": "no route"}})
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = _answer
            do_POST = _answer

            def log_message(self, *_args: object) -> None:
                pass

            def address_string(self) -> str:
                return "unix"

        self.server = _Server(sock, Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, args=(0.02,), daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def posted(self) -> dict:
        bodies = [body for method, path, body in self.calls if (method, path) == ("POST", "/requests")]
        assert len(bodies) == 1 and bodies[0] is not None, self.calls
        return bodies[0]

    def paths(self) -> list[str]:
        return [f"{method} {path}" for method, path, _ in self.calls]


RID = "fr_7k2m4p9q3f9a"


class PluginTestCase(unittest.TestCase):
    def setUp(self) -> None:
        # Short: macOS caps a Unix socket path at 104 bytes.
        self.tmp = tempfile.mkdtemp(prefix="hf", dir="/tmp")
        self.secret_dir = os.path.join(self.tmp, "files")
        self.drop_dir = os.path.join(self.tmp, "drop")
        os.mkdir(self.secret_dir)
        os.mkdir(self.drop_dir)
        sock = os.path.join(self.tmp, "s")
        self.env = {
            "HERMETIC_FILES_SOCK": sock,
            "HERMETIC_FILES_SECRET_DIR": self.secret_dir,
            "HERMETIC_FILES_DROP_DIR": self.drop_dir,
        }
        self.saved = {k: os.environ.get(k) for k in self.env}
        os.environ.update(self.env)
        self.box = FakeBox(sock)
        self.box.routes[("GET", "/hello")] = (200, fixture("hello.json"))
        self.box.routes[("GET", "/files")] = (200, {"inbox": [], "outbox": [], "secrets": [], "requests": []})
        INTERRUPTED[0] = False
        plugin._hello_checked = False
        plugin._hello_warning = None
        plugin._SCRUBBER = plugin._Scrubber()

    def tearDown(self) -> None:
        self.box.close()
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        os.chmod(self.secret_dir, 0o700)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def open_slot(self) -> None:
        self.box.routes[("POST", "/requests")] = (201, {**fixture("wait-pending.json"), "status": "open"})

    def write_secret(self, name: str, content: str, directory: str | None = None) -> str:
        path = os.path.join(directory or self.secret_dir, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return path


class RequestFileTest(PluginTestCase):
    def test_fulfilled(self) -> None:
        self.open_slot()
        self.box.routes[("GET", f"/requests/{RID}/wait")] = (200, fixture("wait-fulfilled.json"))
        args = {**fixture("open-request.json")}
        out = json.loads(plugin.request_file(args, session_id="20261013_120000_abcdef", task_id="task-1"))
        self.assertEqual(out["status"], "fulfilled")
        self.assertEqual(out["path"], fixture("wait-fulfilled.json")["path"])
        self.assertNotIn("warning", out)
        body = self.box.posted()
        self.assertEqual(body["purpose"], args["purpose"])
        self.assertEqual(body["session_id"], "20261013_120000_abcdef")
        # The plugin owns the long-poll, so the slot is opened without one.
        self.assertEqual(body["wait_s"], 0)
        self.assertNotIn("model_extra", body)
        self.assertIn(f"GET /requests/{RID}/wait?s=25", self.box.paths())

    def test_pending_after_the_wait_runs_out(self) -> None:
        self.open_slot()
        # Whatever else the box sends, a pending result is these four fields.
        still_open = {
            **fixture("wait-pending.json"),
            "status": "open",
            "rejected": {"code": "VALIDATION", "message": "for the operator", "at": "2026-10-13T18:00:00Z"},
            "purpose": "a file",
        }
        self.box.routes[("GET", f"/requests/{RID}/wait")] = (200, still_open)
        out = json.loads(plugin.request_file({"purpose": "a file", "wait_s": 1}))
        self.assertEqual(out["status"], "pending")
        self.assertEqual(out["deliver_with"], fixture("wait-pending.json")["deliver_with"])
        self.assertEqual(set(out), {"status", "request_id", "deliver_with", "expires_at"})
        paths = self.box.paths()
        at = paths.index(f"GET /requests/{RID}/wait?s=1")
        # The last look is a zero-second wait, never the raw slot.
        self.assertEqual(paths[at + 1], f"GET /requests/{RID}/wait?s=0")
        self.assertNotIn(f"GET /requests/{RID}", paths)

    def test_a_pending_text_secret_is_the_same_four_fields(self) -> None:
        self.open_slot()
        self.box.routes[("GET", f"/requests/{RID}/wait")] = (200, {**fixture("wait-pending.json"), "status": "open"})
        out = json.loads(plugin.request_secret({"purpose": "a token", "keys": ["GITHUB_TOKEN"], "wait_s": 1}))
        self.assertEqual(set(out), {"status", "request_id", "deliver_with", "expires_at"})
        self.assertEqual(out["status"], "pending")

    def test_a_secret_file_loses_its_digest_and_size_and_any_refusal(self) -> None:
        self.open_slot()
        # The box no longer sends either for a secret; an older one did, and the
        # plugin must still drop them.
        res = {
            **fixture("wait-secret-file-fulfilled.json"),
            "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
            "bytes": 1679,
            "rejected": {"code": "X", "message": "m", "at": "t"},
        }
        self.box.routes[("GET", f"/requests/{RID}/wait")] = (200, res)
        raw = plugin.request_file({"purpose": "the deploy key", "sensitivity": "secret"})
        out = json.loads(raw)
        self.assertEqual(out["status"], "fulfilled")
        self.assertEqual(out["path"], res["path"])
        for field in ("sha256", "bytes", "rejected", "keys", "load"):
            self.assertNotIn(field, out)
        self.assertNotIn(res["sha256"], raw)

    def test_a_secret_file_as_the_box_sends_it_passes_through_whole(self) -> None:
        self.open_slot()
        res = fixture("wait-secret-file-fulfilled.json")
        self.box.routes[("GET", f"/requests/{RID}/wait")] = (200, res)
        out = json.loads(plugin.request_file({"purpose": "the deploy key", "sensitivity": "secret"}))
        self.assertEqual(out["path"], res["path"])
        self.assertEqual(out["class"], "secret")
        self.assertNotIn("sha256", out)
        self.assertNotIn("bytes", out)

    def test_wait_is_clamped_and_stepped(self) -> None:
        self.assertEqual(plugin._clamp_wait(10_000), 290)
        self.assertEqual(plugin._clamp_wait(None), 240)
        self.assertEqual(plugin._clamp_wait("x"), 240)
        self.assertEqual(plugin._clamp_wait(-3), 0)

    def test_declined(self) -> None:
        self.open_slot()
        self.box.routes[("GET", f"/requests/{RID}/wait")] = (200, fixture("wait-declined.json"))
        out = json.loads(plugin.request_file({"purpose": "a file"}))
        self.assertEqual(out["status"], "declined")

    def test_interrupted(self) -> None:
        self.open_slot()
        INTERRUPTED[0] = True
        out = json.loads(plugin.request_file({"purpose": "a file"}))
        self.assertEqual(out, {"status": "interrupted", "request_id": RID})
        self.assertFalse(any("/wait" in p for p in self.box.paths()))

    def test_box_error_is_a_result(self) -> None:
        self.box.routes[("POST", "/requests")] = (410, fixture("error.json"))
        out = json.loads(plugin.request_file({"purpose": "a file"}))
        self.assertEqual(out["status"], "error")
        self.assertEqual(out["error"]["code"], "FILE_REQUEST_EXPIRED")

    def test_unreachable_socket_names_no_path(self) -> None:
        os.environ["HERMETIC_FILES_SOCK"] = os.path.join(self.tmp, "absent")
        raw = plugin.request_file({"purpose": "a file"})
        out = json.loads(raw)
        self.assertEqual(out["error"]["code"], "UNAVAILABLE")
        self.assertNotIn(self.tmp, raw)
        self.assertNotIn("Traceback", raw)

    def test_purpose_is_required(self) -> None:
        out = json.loads(plugin.request_file({}))
        self.assertEqual(out["error"]["code"], "VALIDATION")
        self.assertEqual(self.box.calls, [])

    def test_old_plugin_warns(self) -> None:
        self.box.routes[("GET", "/hello")] = (200, {**fixture("hello.json"), "plugin_min": "9.0.0"})
        self.open_slot()
        self.box.routes[("GET", f"/requests/{RID}/wait")] = (200, fixture("wait-declined.json"))
        out = json.loads(plugin.request_file({"purpose": "a file"}))
        self.assertIn("9.0.0", out["warning"])
        plugin.list_files({})
        self.assertEqual(self.box.paths().count("GET /hello"), 1)


class AwaitAndListTest(PluginTestCase):
    def test_await_file(self) -> None:
        self.box.routes[("GET", f"/requests/{RID}/wait")] = (200, fixture("wait-fulfilled.json"))
        out = json.loads(plugin.await_file({"request_id": RID, "wait_s": 30}))
        self.assertEqual(out["status"], "fulfilled")
        self.assertIn(f"GET /requests/{RID}/wait?s=25", self.box.paths())

    def test_await_needs_an_id(self) -> None:
        self.assertEqual(json.loads(plugin.await_file({}))["error"]["code"], "VALIDATION")

    def test_an_ordinary_file_named_env_is_not_a_text_secret(self) -> None:
        # A normal request that happened to receive `x.env`: its digest and size
        # stay, there is no load line, and its contents are never scrubbed.
        path = self.write_secret("x.env", 'NOT_SECRET="FIXTURE-plain-config"\n', self.tmp)
        res = {
            **fixture("wait-fulfilled.json"),
            "path": path,
            "rejected": {"code": "X", "message": "for the operator", "at": "t"},
        }
        self.box.routes[("GET", f"/requests/{RID}/wait")] = (200, res)
        out = json.loads(plugin.await_file({"request_id": RID}))
        self.assertEqual(out["sha256"], res["sha256"])
        self.assertEqual(out["bytes"], res["bytes"])
        for field in ("load", "keys", "note", "rejected"):
            self.assertNotIn(field, out)
        self.assertIsNone(
            plugin.transform_tool_result(tool_name="terminal", result="FIXTURE-plain-config")
        )

    def test_await_a_text_secret_by_its_keys(self) -> None:
        res = fixture("wait-secret-fulfilled.json")
        self.box.routes[("GET", f"/requests/{RID}/wait")] = (200, res)
        out = json.loads(plugin.await_file({"request_id": RID}))
        self.assertEqual(out["load"], res["load"])
        self.assertEqual(out["keys"], res["keys"])
        self.assertIn("Never cat", out["note"])

    def test_list_files(self) -> None:
        out = json.loads(plugin.list_files({}))
        self.assertEqual(out["secrets"], [])

    def test_list_files_hides_secret_digests_and_refusals(self) -> None:
        digest = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
        refusal = {"code": "VALIDATION", "message": "Line 2 sets a key that was not requested", "at": "t"}
        self.box.routes[("GET", "/files")] = (
            200,
            {
                "inbox": [{"id": "f_1", "dir": "inbox", "class": "file", "name": "a.txt", "sha256": digest, "bytes": 3}],
                "outbox": [],
                "secrets": [{"id": "f_2", "dir": "secret", "class": "secret", "name": "k.pem", "sha256": digest, "bytes": 9}],
                "requests": [
                    {"request_id": RID, "kind": "secret_text", "sensitivity": "secret", "rejected": refusal},
                    {
                        "request_id": "fr_2",
                        "kind": "file",
                        "sensitivity": "normal",
                        "fulfilled": {"path": "/run/hermetic/drop/fr_2/k.pem", "class": "secret", "sha256": digest, "bytes": 9},
                    },
                    {"request_id": "fr_3", "kind": "file", "sensitivity": "normal", "rejected": refusal},
                ],
            },
        )
        out = json.loads(plugin.list_files({}))
        self.assertEqual(out["inbox"][0]["sha256"], digest)
        self.assertNotIn("sha256", out["secrets"][0])
        self.assertNotIn("bytes", out["secrets"][0])
        self.assertNotIn("rejected", out["requests"][0])
        self.assertEqual(out["requests"][1]["fulfilled"], {"path": "/run/hermetic/drop/fr_2/k.pem", "class": "secret"})
        # A normal slot's refusal is about a file, not a secret, and stays.
        self.assertEqual(out["requests"][2]["rejected"], refusal)


ENV_TEXT = 'GITHUB_TOKEN="FIXTURE-ghp-token-value"\nWEBHOOK_URL="https://FIXTURE.example/hook"\n'


class RequestSecretTest(PluginTestCase):
    def fulfilled(self) -> dict:
        if has_fixture("wait-secret-fulfilled.json"):
            return fixture("wait-secret-fulfilled.json")
        path = "/run/hermetic/files/github.env"
        return {
            **fixture("wait-fulfilled.json"),
            "path": path,
            "keys": ["GITHUB_TOKEN"],
            "format": "dotenv",
            "load": f"set -a; . {path}; set +a",
        }

    def test_sends_kind_secret_text_and_returns_no_values(self) -> None:
        self.open_slot()
        box = self.fulfilled()
        self.box.routes[("GET", f"/requests/{RID}/wait")] = (200, box)
        raw = plugin.request_secret(
            {"purpose": "GitHub API", "keys": ["GITHUB_TOKEN"], "optional_keys": ["WEBHOOK_URL"], "model_extra": 1},
            session_id="20261013_120000_abcdef",
        )
        body = self.box.posted()
        self.assertEqual(body["kind"], "secret_text")
        self.assertEqual(body["keys"], ["GITHUB_TOKEN"])
        self.assertEqual(body["optional_keys"], ["WEBHOOK_URL"])
        self.assertEqual(body["session_id"], "20261013_120000_abcdef")
        self.assertNotIn("model_extra", body)
        out = json.loads(raw)
        self.assertEqual(out["status"], "fulfilled")
        self.assertEqual(out["path"], box["path"])
        self.assertEqual(out["keys"], box["keys"])
        self.assertEqual(out["format"], "dotenv")
        self.assertEqual(out["load"], box["load"])
        self.assertIn("Never cat", out["note"])
        self.assertEqual(
            set(out), {"status", "request_id", "path", "keys", "format", "load", "note", "deliver_with", "expires_at", "by"}
        )

    def test_keys_and_load_from_the_file_when_the_box_omits_them(self) -> None:
        path = self.write_secret("github.env", ENV_TEXT)
        self.open_slot()
        res = {k: v for k, v in self.fulfilled().items() if k not in ("keys", "load")}
        self.box.routes[("GET", f"/requests/{RID}/wait")] = (200, {**res, "path": path})
        raw = plugin.request_secret({"purpose": "GitHub API", "keys": ["GITHUB_TOKEN"]})
        out = json.loads(raw)
        self.assertEqual(out["keys"], ["GITHUB_TOKEN", "WEBHOOK_URL"])
        self.assertEqual(out["load"], f"set -a; . {path}; set +a")
        self.assertNotIn("FIXTURE-ghp-token-value", raw)
        self.assertNotIn("FIXTURE.example", raw)

    def test_open_secret_request_fixture(self) -> None:
        if not has_fixture("open-secret-request.json"):
            self.skipTest("tests/fixtures/files/open-secret-request.json not present yet")
        args = fixture("open-secret-request.json")
        self.open_slot()
        self.box.routes[("GET", f"/requests/{RID}/wait")] = (200, fixture("wait-declined.json"))
        out = json.loads(plugin.request_secret(args))
        self.assertEqual(out["status"], "declined")
        body = self.box.posted()
        self.assertEqual(body["kind"], "secret_text")
        self.assertEqual(body["keys"], args["keys"])

    def test_bad_key_names_never_reach_the_box(self) -> None:
        for keys in ([], ["lower"], ["A" * 65], "GITHUB_TOKEN"):
            out = json.loads(plugin.request_secret({"purpose": "x", "keys": keys}))
            self.assertEqual(out["error"]["code"], "VALIDATION", keys)
        out = json.loads(plugin.request_secret({"purpose": "x", "keys": [f"K{i}" for i in range(17)]}))
        self.assertEqual(out["error"]["code"], "VALIDATION")
        self.assertEqual(self.box.calls, [])


PEM_LINES = [
    "-----BEGIN PRIVATE KEY-----",
    "FIXTUREpemLineOneAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "FIXTUREpemLineTwoBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    "FIX01",
    "-----END PRIVATE KEY-----",
]
PEM = "\n".join(PEM_LINES) + "\n"


class ScrubTest(PluginTestCase):
    def hook(self, result: str) -> str | None:
        return plugin.transform_tool_result(
            tool_name="terminal", args={}, result=result, task_id="t", session_id="s"
        )

    def test_env_value_is_replaced_by_its_key(self) -> None:
        self.write_secret("github.env", ENV_TEXT)
        out = self.hook('{"output": "token is FIXTURE-ghp-token-value\\n"}')
        self.assertEqual(out, '{"output": "token is \u2039secret:GITHUB_TOKEN\u203a\\n"}')

    def test_positional_arguments(self) -> None:
        self.write_secret("github.env", ENV_TEXT)
        out = plugin.transform_tool_result("terminal", {}, "FIXTURE-ghp-token-value", "t", "s")
        self.assertEqual(out, "\u2039secret:GITHUB_TOKEN\u203a")

    def test_untouched_result_is_none(self) -> None:
        self.write_secret("github.env", ENV_TEXT)
        self.assertIsNone(self.hook("nothing secret here"))
        self.assertIsNone(plugin.transform_tool_result(tool_name="x", result={"not": "a string"}))

    def test_each_line_of_a_multi_line_value(self) -> None:
        self.write_secret("app.pem", PEM)
        label = "\u2039secret:app.pem\u203a"
        # One line of the key, printed alone.
        self.assertEqual(self.hook(f"line: {PEM_LINES[2]}"), f"line: {label}")
        # The whole file is one label, not one per line.
        self.assertEqual(self.hook(PEM), label + "\n")
        # The whole file inside a JSON string, newlines escaped.
        self.assertEqual(self.hook(json.dumps({"out": PEM})), '{"out": "' + label + '\\n"}')

    def test_a_multi_line_env_value_is_matched_by_line_under_its_key(self) -> None:
        self.write_secret("app.env", 'APP_KEY="' + PEM.rstrip("\n") + '"\n')
        self.assertEqual(self.hook(f"> {PEM_LINES[1]}"), "> \u2039secret:APP_KEY\u203a")
        self.assertIsNone(self.hook(PEM_LINES[0]))

    def test_armour_and_short_lines_stay(self) -> None:
        self.write_secret("app.pem", PEM)
        text = f"{PEM_LINES[0]}\n{PEM_LINES[3]}\n{PEM_LINES[4]}"
        self.assertIsNone(self.hook(text))

    def test_short_values_are_not_scrubbed(self) -> None:
        self.write_secret("short.env", 'PIN="FIX01"\n')
        self.assertIsNone(self.hook("pin FIX01"))

    def test_drop_dir_and_cache_follow_the_files(self) -> None:
        request_dir = os.path.join(self.drop_dir, RID)
        os.mkdir(request_dir)
        path = self.write_secret("token.txt", "FIXTURE-drop-token\n", request_dir)
        self.assertEqual(self.hook("FIXTURE-drop-token"), "\u2039secret:token.txt\u203a")
        os.remove(path)
        self.assertIsNone(self.hook("FIXTURE-drop-token"))

    def test_unlistable_dirs_fall_back_to_the_box_index(self) -> None:
        if os.geteuid() == 0:
            self.skipTest("root can list a 0311 directory")
        path = self.write_secret("github.env", ENV_TEXT)
        os.chmod(self.secret_dir, 0o311)
        self.assertIsNone(self.hook("FIXTURE-ghp-token-value"))
        self.box.routes[("GET", "/files")] = (200, {"secrets": [{"path": path}]})
        plugin._SCRUBBER = plugin._Scrubber()
        self.assertEqual(self.hook("FIXTURE-ghp-token-value"), "\u2039secret:GITHUB_TOKEN\u203a")

    def test_a_fulfilled_result_teaches_the_hook_its_path(self) -> None:
        if os.geteuid() == 0:
            self.skipTest("root can list a 0311 directory")
        path = self.write_secret("github.env", ENV_TEXT)
        os.chmod(self.secret_dir, 0o311)
        self.box.routes[("GET", f"/requests/{RID}/wait")] = (
            200,
            {**fixture("wait-secret-file-fulfilled.json"), "path": path},
        )
        plugin.await_file({"request_id": RID})
        self.assertEqual(self.hook("FIXTURE-ghp-token-value"), "\u2039secret:GITHUB_TOKEN\u203a")

    def big_secret(self, lines: int) -> list[str]:
        """A PEM-shaped secret of `lines` distinct 64-character lines, written to the secret dir."""
        rng = random.Random(7)
        alphabet = string.ascii_letters + string.digits + "+/"
        body = ["FIXTURE" + "".join(rng.choice(alphabet) for _ in range(57)) for _ in range(lines)]
        self.write_secret("big.pem", "\n".join([PEM_LINES[0], *body, PEM_LINES[4]]) + "\n")
        return body

    def test_a_large_secret_stays_cheap(self) -> None:
        # ~1 MiB, ~16k lines: once one alternation of every line, which took
        # seconds to compile and most of a second per 20 KB result.
        body = self.big_secret(16_000)
        result = "".join(random.Random(1).choice(string.ascii_letters + " \n") for _ in range(20_000))
        started = time.monotonic()
        self.assertIsNone(self.hook(result))
        first = time.monotonic() - started
        started = time.monotonic()
        for _ in range(5):
            self.assertIsNone(self.hook(result))
        again = time.monotonic() - started
        self.assertLess(first, 1.5, f"first scrub took {first:.2f}s")
        self.assertLess(again, 1.0, f"five more scrubs took {again:.2f}s")
        # And still scrubbed: a line from deep in the file, alone, in a sentence
        # and inside a JSON string, and the whole file.
        label = "‹secret:big.pem›"
        line = body[12_345]
        self.assertEqual(self.hook(f"  {line}\n"), f"  {label}\n")
        self.assertEqual(self.hook(f"key: {line} end"), f"key: {label} end")
        self.assertEqual(
            self.hook(json.dumps({"out": f"{body[9]}\n{line}\n"})),
            json.dumps({"out": f"{label}\n{label}\n"}, ensure_ascii=False),
        )
        whole = "\n".join([PEM_LINES[0], *body, PEM_LINES[4]])
        self.assertEqual(self.hook(f"<{whole}>"), f"<{label}>")

    def test_lines_past_the_per_value_cap_are_still_scrubbed(self) -> None:
        body = self.big_secret(plugin.SCRUB_LINE_NEEDLES_MAX + 10)
        label = "‹secret:big.pem›"
        self.assertEqual(self.hook(f"> {body[-1]}"), f"> {label}")
        self.assertEqual(self.hook(PEM_LINES[0]), None)

    def test_a_slow_box_listing_does_not_hold_the_lock(self) -> None:
        if os.geteuid() == 0:
            self.skipTest("root can list a 0311 directory")
        os.chmod(self.secret_dir, 0o311)
        entered, release = threading.Event(), threading.Event()
        original = plugin._call

        def slow_call(*_args: object, **_kwargs: object) -> dict:
            entered.set()
            release.wait(5)
            return {"secrets": []}

        plugin._call = slow_call
        try:
            worker = threading.Thread(target=self.hook, args=("anything",), daemon=True)
            worker.start()
            self.assertTrue(entered.wait(5))
            # While the listing hangs, another thread can teach the hook a path
            # and scrub with what it has.
            adder = threading.Thread(target=plugin._SCRUBBER.add_path, args=("/nowhere",), daemon=True)
            adder.start()
            adder.join(1)
            self.assertFalse(adder.is_alive())
            started = time.monotonic()
            self.assertIsNone(self.hook("anything"))
            self.assertLess(time.monotonic() - started, 1.0)
        finally:
            release.set()
            plugin._call = original
            worker.join(5)

    def test_the_hook_never_raises(self) -> None:
        original = plugin.scrub
        plugin.scrub = lambda _text: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            self.assertIsNone(self.hook("anything"))
        finally:
            plugin.scrub = original


OUTBOX = "/data/hermes/.hermes/outbox"


class ShareFileTest(PluginTestCase):
    def test_shares_and_returns_the_box_result(self) -> None:
        self.box.routes[("POST", "/outbox")] = (201, fixture("share-result.json"))
        out = json.loads(plugin.share_file({"path": "/data/hermes/work/chart.png", "note": "Q3", "name": "chart.png"}))
        self.assertEqual(out, fixture("share-result.json"))
        bodies = [b for m, p, b in self.box.calls if (m, p) == ("POST", "/outbox")]
        self.assertEqual(bodies, [{"path": "/data/hermes/work/chart.png", "note": "Q3", "name": "chart.png"}])

    def test_a_relative_or_home_path_is_made_absolute_here_and_checked_by_the_box(self) -> None:
        self.box.routes[("POST", "/outbox")] = (201, fixture("share-result.json"))
        plugin.share_file({"path": "~/work/chart.png"})
        plugin.share_file({"path": "out/chart.png"})
        sent = [b["path"] for m, p, b in self.box.calls if (m, p) == ("POST", "/outbox")]
        self.assertEqual(sent, [os.path.expanduser("~/work/chart.png"), os.path.abspath("out/chart.png")])

    def test_a_refusal_is_the_error_shape(self) -> None:
        self.box.routes[("POST", "/outbox")] = (
            403,
            {"error": {"code": "FORBIDDEN", "message": "share refused: credential path"}},
        )
        out = json.loads(plugin.share_file({"path": "/data/hermes/.hermes/.env"}))
        self.assertEqual(
            out, {"status": "error", "error": {"code": "FORBIDDEN", "message": "share refused: credential path"}}
        )

    def test_a_path_is_required(self) -> None:
        out = json.loads(plugin.share_file({}))
        self.assertEqual(out["error"]["code"], "VALIDATION")
        self.assertEqual(self.box.calls, [])


class MediaHookTest(PluginTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.ids = iter(f"sh_{n:012d}" for n in range(1, 100))

        def answer(body: dict) -> tuple[int, dict]:
            path = body["path"]
            if ".env" in path or path.endswith("missing.pdf"):
                return (403, {"error": {"code": "FORBIDDEN", "message": "share refused: credential path"}})
            name = os.path.basename(path)
            return (201, {"share_id": next(self.ids), "name": name, "bytes": 1, "mime": "x/y", "sha256": "0" * 64})

        self.box.routes[("POST", "/outbox")] = answer

    def hook(self, text: str, platform: object = "hermetic") -> str | None:
        return plugin.transform_llm_output(
            response_text=text, session_id="s1", model="m", platform=platform, turn_id="t1"
        )

    def shared(self) -> list[str]:
        return [b["path"] for m, p, b in self.box.calls if (m, p) == ("POST", "/outbox")]

    def test_a_media_line_is_shared_and_rewritten_to_its_outbox_copy(self) -> None:
        text = "Here is the chart:\nMEDIA:/data/hermes/work/chart.png\nAnything else?"
        self.assertEqual(
            self.hook(text),
            f"Here is the chart:\nMEDIA:{OUTBOX}/sh_000000000001/chart.png\nAnything else?",
        )
        self.assertEqual(self.shared(), ["/data/hermes/work/chart.png"])

    def test_a_refused_share_leaves_its_line_and_the_rest_still_rewrite(self) -> None:
        text = "MEDIA:/data/hermes/.hermes/.env\n  MEDIA: `/data/hermes/work/a b.pdf`  "
        self.assertEqual(self.hook(text), f"MEDIA:/data/hermes/.hermes/.env\nMEDIA:{OUTBOX}/sh_000000000001/a b.pdf")

    def test_only_refusals_is_none(self) -> None:
        self.assertIsNone(self.hook("MEDIA:/data/hermes/.hermes/.env\nMEDIA:/data/hermes/missing.pdf"))

    def test_no_media_line_is_none_and_asks_nothing(self) -> None:
        self.assertIsNone(self.hook("All done. The MEDIA: tag goes on its own line."))
        self.assertIsNone(self.hook(""))
        self.assertEqual(self.shared(), [])

    def test_a_line_already_in_the_outbox_is_left_alone(self) -> None:
        line = f"MEDIA:{OUTBOX}/sh_aaaaaaaaaaaa/chart.png"
        self.assertIsNone(self.hook(line))
        self.assertEqual(self.shared(), [])

    def test_the_same_path_twice_is_one_share(self) -> None:
        out = self.hook("MEDIA:/data/hermes/a.pdf\ntext\nMEDIA:/data/hermes/a.pdf")
        self.assertEqual(out, f"MEDIA:{OUTBOX}/sh_000000000001/a.pdf\ntext\nMEDIA:{OUTBOX}/sh_000000000001/a.pdf")
        self.assertEqual(self.shared(), ["/data/hermes/a.pdf"])

    def test_a_spaced_path_and_its_normalized_variants_are_one_share(self) -> None:
        home = os.path.expanduser("~")
        text = (
            f"MEDIA:{home}/AI Brain/report.pdf\n"
            f'MEDIA:"{home}//AI Brain/./report.pdf"\n'
            "  **MEDIA: `~/AI Brain/report.pdf`**"
        )
        line = f"MEDIA:{OUTBOX}/sh_000000000001/report.pdf"
        self.assertEqual(self.hook(text), "\n".join([line] * 3))
        self.assertEqual(self.shared(), [f"{home}/AI Brain/report.pdf"])

    def test_at_most_ten_shares_per_turn(self) -> None:
        text = "\n".join(f"MEDIA:/data/hermes/f{i}.pdf" for i in range(12))
        out = (self.hook(text) or "").split("\n")
        self.assertEqual(len(self.shared()), 10)
        self.assertTrue(all(line.startswith(f"MEDIA:{OUTBOX}/") for line in out[:10]))
        self.assertEqual(out[10:], ["MEDIA:/data/hermes/f10.pdf", "MEDIA:/data/hermes/f11.pdf"])

    def test_an_unreachable_box_leaves_the_reply_alone(self) -> None:
        os.environ["HERMETIC_FILES_SOCK"] = os.path.join(self.tmp, "nope")
        self.assertIsNone(self.hook("MEDIA:/data/hermes/work/chart.png"))

    def test_only_on_a_hermetic_surface(self) -> None:
        text = "MEDIA:/data/hermes/work/chart.png"
        for platform in ("hermetic", "tui", "cli"):
            self.assertIsNotNone(self.hook(text, platform), platform)
        for platform in ("telegram", "slack", "api_server", "", None):
            self.assertIsNone(self.hook(text, platform), platform)
        self.assertIsNone(plugin.transform_llm_output(response_text=text))
        # One share per hermetic surface above; none for any other platform.
        self.assertEqual(len(self.shared()), 3)

    def test_a_media_line_in_a_fenced_block_is_an_example(self) -> None:
        text = (
            "Write it like this:\n```\nMEDIA:/data/hermes/a.pdf\n```\n"
            "~~~~md\nMEDIA:/data/hermes/b.pdf\n~~~\nstill inside\nMEDIA:/data/hermes/c.pdf\n~~~~\n"
            "MEDIA:/data/hermes/d.pdf"
        )
        out = self.hook(text)
        self.assertEqual(self.shared(), ["/data/hermes/d.pdf"])
        self.assertEqual(out, text.replace("MEDIA:/data/hermes/d.pdf", f"MEDIA:{OUTBOX}/sh_000000000001/d.pdf"))

    def test_case_and_emphasis_are_accepted_and_the_line_comes_out_canonical(self) -> None:
        text = "media:/data/hermes/a.pdf\n**MEDIA:/data/hermes/b.pdf**\n_Media: `/data/hermes/c.pdf`_\nMEDIA:/data/hermes/d_"
        out = (self.hook(text) or "").split("\n")
        self.assertEqual(self.shared(), ["/data/hermes/a.pdf", "/data/hermes/b.pdf", "/data/hermes/c.pdf", "/data/hermes/d_"])
        self.assertEqual(
            out,
            [
                f"MEDIA:{OUTBOX}/sh_000000000001/a.pdf",
                f"MEDIA:{OUTBOX}/sh_000000000002/b.pdf",
                f"MEDIA:{OUTBOX}/sh_000000000003/c.pdf",
                f"MEDIA:{OUTBOX}/sh_000000000004/d_",
            ],
        )
        # Unbalanced emphasis is not a MEDIA line.
        self.assertIsNone(self.hook("**MEDIA:/data/hermes/e.pdf*"))

    def test_crlf_and_trailing_blanks_are_kept_or_trimmed(self) -> None:
        out = self.hook("MEDIA:/data/hermes/a.pdf \t \r\nMEDIA:`/data/hermes/b c.pdf`  ")
        self.assertEqual(self.shared(), ["/data/hermes/a.pdf", "/data/hermes/b c.pdf"])
        self.assertEqual(out, f"MEDIA:{OUTBOX}/sh_000000000001/a.pdf\r\nMEDIA:{OUTBOX}/sh_000000000002/b c.pdf")

    def test_an_adversarial_line_is_matched_in_linear_time(self) -> None:
        for line in ("MEDIA:/a" + " " * 50000 + "x", "MEDIA:/a" + " \t" * 25000 + "x", "MEDIA:" + " " * 50000):
            started = time.monotonic()
            self.assertIsNone(self.hook(line))
            self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual(self.shared(), [])

    def test_a_line_over_the_length_cap_is_left_alone(self) -> None:
        long_line = "MEDIA:/data/hermes/" + "a" * plugin.MEDIA_LINE_MAX + ".pdf"
        self.assertIsNone(self.hook(long_line))
        self.assertEqual(self.shared(), [])

    def test_one_deadline_for_the_whole_hook(self) -> None:
        def slow(body: dict) -> tuple[int, dict]:
            time.sleep(3)
            return (201, {"share_id": "sh_999999999999", "name": "x", "bytes": 1, "mime": "x/y", "sha256": "0" * 64})

        self.box.routes[("POST", "/outbox")] = slow
        saved = plugin.HOOK_DEADLINE
        plugin.HOOK_DEADLINE = 1.0
        try:
            started = time.monotonic()
            out = self.hook("MEDIA:/data/hermes/a.pdf\nMEDIA:/data/hermes/b.pdf\nMEDIA:/data/hermes/c.pdf")
            took = time.monotonic() - started
        finally:
            plugin.HOOK_DEADLINE = saved
        self.assertIsNone(out)
        self.assertLess(took, 2.5)
        # The first share used up the deadline; the lines after it were never started.
        self.assertEqual(self.shared(), ["/data/hermes/a.pdf"])

    def test_no_share_starts_once_the_deadline_is_spent(self) -> None:
        ticks = iter([0.0, 0.0, plugin.HOOK_DEADLINE])
        saved = plugin._monotonic
        plugin._monotonic = lambda: next(ticks, plugin.HOOK_DEADLINE)
        try:
            out = self.hook("MEDIA:/data/hermes/a.pdf\nMEDIA:/data/hermes/b.pdf")
        finally:
            plugin._monotonic = saved
        self.assertEqual(self.shared(), ["/data/hermes/a.pdf"])
        self.assertEqual(out, f"MEDIA:{OUTBOX}/sh_000000000001/a.pdf\nMEDIA:/data/hermes/b.pdf")

    def test_the_hook_never_raises(self) -> None:
        original = plugin._share
        plugin._share = lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            self.assertIsNone(self.hook("MEDIA:/data/hermes/work/chart.png"))
            self.assertIsNone(plugin.transform_llm_output(response_text=None))
        finally:
            plugin._share = original


class CanonicalReaderTest(unittest.TestCase):
    def test_round_trip(self) -> None:
        # sh's double-quote escapes, and a real newline inside the quotes.
        text = 'A="x\ny \\"q\\" \\\\ \\$HOME \\`id\\`"\nB=""\n'
        self.assertEqual(
            plugin.read_canonical_secret_env(text), [("A", 'x\ny "q" \\ $HOME `id`'), ("B", "")]
        )

    def test_strict(self) -> None:
        for bad in [
            'A="x"',
            'A="x"\n\n',
            '# c\nA="x"\n',
            'a="x"\n',
            'A="x"\nA="y"\n',
            'A="\\n"\n',
            'A="\\t"\n',
            'A="$HOME"\n',
            'A="`id`"\n',
            'A="\x01"\n',
            'A="x\ry"\n',
            '\ufeffA="x"\n',
        ]:
            self.assertIsNone(plugin.read_canonical_secret_env(bad), bad)


class RegisterTest(unittest.TestCase):
    def test_registers_five_tools_and_the_hooks(self) -> None:
        tools: list[dict] = []
        hooks: list[str] = []

        class Ctx:
            def register_tool(self, **kw: object) -> None:
                tools.append(kw)

            def register_hook(self, name: str, fn: object) -> None:
                hooks.append(name)

        plugin.register(Ctx())
        self.assertEqual(
            [t["name"] for t in tools], ["request_file", "request_secret", "await_file", "list_files", "share_file"]
        )
        self.assertTrue(all(t["toolset"] == "hermetic_files" for t in tools))
        self.assertTrue(all(t["schema"]["parameters"]["type"] == "object" for t in tools))
        self.assertEqual(hooks, ["transform_tool_result", "transform_llm_output"])


if __name__ == "__main__":
    unittest.main()
