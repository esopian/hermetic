/**
 * Nothing typed into a session, and nothing it prints, reaches `app.log`
 * (issue #18, §4.10): a sentinel typed, echoed and printed back through the
 * real binding is absent from the file, while the open and the exit are
 * there with the fields they are meant to carry.
 */
import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createAppLog } from "../../src/log.ts";
import { testHome } from "../home.ts";
import { type Bridge, bridge, until } from "./bridge.ts";

const SENTINEL = "FIXTURE-terminal-sentinel-5d1c9a";

const bridges: Bridge[] = [];
afterAll(async () => {
  for (const b of bridges.splice(0)) await b.close();
});

test("a sentinel typed and echoed never appears in the app log", async () => {
  const home = testHome("hermetic-terminal-log-");
  // Everything to the file, DEBUG included; nothing to the test's stderr.
  const log = createAppLog({ home, fixture: true, stderrLevel: "error", stderr: () => {} });
  const b = await bridge({ log, home });
  bridges.push(b);

  const { session_id } = (await b.request("terminal.open", {
    name: "atlas",
    cols: 80,
    rows: 24,
  })) as { session_id: string };
  const { stream_id } = (await b.request("terminal.attach", { session_id })) as {
    stream_id: string;
  };
  b.message("terminal.input", { session_id, in_seq: 0, data: `echo ${SENTINEL}\r` });
  b.message("terminal.input", {
    session_id,
    in_seq: 1,
    binary: Buffer.from(`echo ${SENTINEL}-binary\r`).toString("base64"),
  });
  await until(() => b.text(stream_id).includes(`${SENTINEL}-binary\r\n`));
  b.message("terminal.view", { session_id });
  b.message("terminal.ack", { stream_id, gen: 1, upto: 1 });
  // A malformed keystroke message too: a parse failure must not log its payload.
  b.message("terminal.input", { session_id, in_seq: "x", data: SENTINEL });
  // And a refused request whose params carry it.
  await b.request("terminal.close", { session_id: SENTINEL.repeat(4) }).catch(() => {});
  await b.request("terminal.close", { session_id });

  await log.flush();
  const path = log.path;
  if (path === null) throw new Error("the log has no file");
  const text = readFileSync(path, "utf8");
  expect(text).not.toContain(SENTINEL);
  expect(text).toContain("session opened");
  expect(text).toContain(`session="${session_id}"`);
  expect(text).toMatch(/session ended .*duration_ms=\d+/);
  expect(text).not.toContain("terminal.input");
  expect(text).not.toContain("terminal.ack");
  expect(text).not.toContain("terminal.view");
});
