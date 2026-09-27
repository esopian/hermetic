import { describe, expect, test } from "bun:test";
import { HERMETICD_RPC_PORT, RPC_CONTENT_TYPE, RPC_PATHS, decodeRpcFrame } from "@hermetic/core/schema";
import type { RpcFrame, RpcHealth } from "@hermetic/core/schema";
import type { Whois } from "../src/rpc.ts";
import {
  HERMES_LOG_DIR,
  REFUSAL_LOG_WINDOW_MS,
  TAGGED_DEVICES_LOGIN,
  hermesLogPath,
  makeRpcHandler,
  mapJournalLine,
  rpcAccess,
  tailscaleWhois,
  waitForTailscaleAddress,
} from "../src/rpc.ts";
import { FakeHost } from "./fake-host.ts";
import { TEST_NAME } from "./fixtures.ts";

const OPERATOR_IP = "100.64.0.3";
const STRANGER_IP = "203.0.113.9";

/** The operator's own laptop: a tailnet member, no tags — what the ACL admits. */
const MEMBER: Whois = { login: "evan@example.com", node: "laptop.tailnet.ts.net", tags: [] };
/** Another agent box in this very fleet. On the tailnet; not a member. */
const AGENT_NODE: Whois = {
  login: TAGGED_DEVICES_LOGIN,
  node: "bravo.tailnet.ts.net",
  tags: ["tag:hermetic"],
};

function handler(
  options: {
    configHash?: string | null;
    /** What the box says about its browser identities; absent wires no dep. */
    browsers?: RpcHealth["browsers"];
    journalLines?: string[];
    /** What `whois` says about a tailnet peer; strangers still resolve to null. */
    peer?: Whois;
    allowedTags?: readonly string[];
    /**
     * Use the real journal reader instead of the injected one, so the argv and
     * the child's lifetime are the listener's own rather than the fixture's.
     * Still no journald: it goes through `FakeHost.execLines` like everything.
     */
    defaultJournal?: boolean;
  } = {},
) {
  const host = new FakeHost();
  /** What the route asked the journal for, in order — unit, tail and follow. */
  const journalCalls: Array<{ unit: string; tail: number; follow: boolean }> = [];
  /** Every audit line the listener wrote, in order. */
  const audit: string[] = [];
  return {
    host,
    journalCalls,
    audit,
    fetch: makeRpcHandler({
      host,
      name: TEST_NAME,
      hermeticdVersion: "0.1.0",
      configHash: async () =>
        options.configHash === undefined ? "abc123def4567890" : options.configHash,
      // Not wired at all unless a test asks for it, which is how the listener
      // looks on a build that has no browser stack to report.
      ...(options.browsers === undefined ? {} : { browsers: async () => options.browsers }),
      // Only tailnet addresses resolve; everything else is an unknown peer.
      whois: async (ip) => (ip.startsWith("100.64.") ? (options.peer ?? MEMBER) : null),
      ...(options.allowedTags ? { allowedTags: options.allowedTags } : {}),
      log: (message) => void audit.push(message),
      ...(options.defaultJournal
        ? {}
        : {
            journal: async function* (unit, tail, follow) {
              journalCalls.push({ unit, tail, follow });
              for (const line of options.journalLines ?? []) yield line;
            },
          }),
    }),
  };
}

/**
 * Take exactly one frame off a stream that is still open, leaving the body for
 * the caller to cancel. Peeling the reader off and releasing it is what makes
 * the later `body.cancel()` legal.
 */
async function readOneFrame(response: Response): Promise<RpcFrame> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no body");
  try {
    const first = await reader.read();
    if (first.done || !first.value) throw new Error("stream ended before its first frame");
    return decodeRpcFrame(new TextDecoder().decode(first.value).trim());
  } finally {
    reader.releaseLock();
  }
}

async function frames(response: Response): Promise<RpcFrame[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map(decodeRpcFrame);
}

describe("the RPC listener (§6.4)", () => {
  test("a peer `tailscale whois` cannot identify gets 403", async () => {
    const { fetch } = handler();
    const res = await fetch(
      new Request(`http://100.64.0.7:${HERMETICD_RPC_PORT}${RPC_PATHS.logs}`),
      STRANGER_IP,
    );
    expect(res.status).toBe(403);
    const [frame] = await frames(res);
    // HTTP 403 and the frame's FORBIDDEN say the same thing, so a client can
    // branch on either.
    expect(frame).toMatchObject({ type: "error", code: "FORBIDDEN" });
    expect(frame).toMatchObject({ message: expect.stringContaining("not on the tailnet") });
    expect(res.headers.get("content-type")).toBe(RPC_CONTENT_TYPE);
  });

  /**
   * There is no route that changes the box. A config change goes out by
   * rerendering and rerunning the bootstrap stages (§4.2), so the listener has
   * no write path at all — and this is the test that keeps it that way.
   */
  test.each([
    ["POST", "/apply"],
    ["POST", "/rerun"],
    ["POST", "/exec"],
    ["GET", "/shell"],
  ])("%s %s is 404 — the listener has no write path", async (method, path) => {
    const { fetch } = handler();
    const res = await fetch(new Request(`http://x${path}`, { method }), OPERATOR_IP);
    expect(res.status).toBe(404);
    const [frame] = await frames(res);
    expect(frame).toMatchObject({ type: "error", code: "NOT_FOUND" });
  });

  test("GET /logs?unit=&follow=1 streams journal lines as log frames", async () => {
    const { fetch } = handler({
      journalLines: [
        JSON.stringify({
          MESSAGE: "hermes started",
          __REALTIME_TIMESTAMP: "1788264000000000",
          _SYSTEMD_UNIT: "hermes-dashboard.service",
          PRIORITY: "6",
        }),
        JSON.stringify({
          MESSAGE: "backend unreachable",
          __REALTIME_TIMESTAMP: "1788264001000000",
          _SYSTEMD_UNIT: "hermes-dashboard.service",
          PRIORITY: "3",
        }),
        "{ not json",
      ],
    });

    const res = await fetch(
      new Request(`http://x${RPC_PATHS.logs}?unit=hermes-dashboard.service&follow=1`),
      OPERATOR_IP,
    );
    expect(res.status).toBe(200);

    const all = await frames(res);
    const logs = all.filter((f): f is Extract<RpcFrame, { type: "log" }> => f.type === "log");
    expect(logs).toHaveLength(2);
    expect(logs[0]?.line).toEqual({
      unit: "hermes-dashboard.service",
      at: "2026-09-01T12:00:00.000Z",
      message: "hermes started",
      stream: "stdout",
    });
    expect(logs[1]?.line.stream).toBe("stderr");
    expect(all.at(-1)).toMatchObject({ type: "done", ok: true });
  });

  /**
   * The half of `hermetic logs` that decides whether the stream ever ends. With
   * `follow` journalctl is left running and the body stays open; without it,
   * journalctl prints its backlog and exits, which is what closes the stream
   * with `done`. The client used to ask for a follow every time, so a plain
   * `hermetic logs <name>` waited on a connection nobody would write to again
   * and died with a socket error once it was dropped.
   */
  test("a request that does not ask to follow gets a bounded read that ends", async () => {
    const { fetch, journalCalls } = handler({
      journalLines: [
        JSON.stringify({ MESSAGE: "hermes started", __REALTIME_TIMESTAMP: "1788264000000000" }),
      ],
    });

    const res = await fetch(new Request(`http://x${RPC_PATHS.logs}`), OPERATOR_IP);
    const all = await frames(res);

    expect(journalCalls).toEqual([{ unit: "hermes-dashboard.service", tail: 200, follow: false }]);
    expect(all.at(-1)).toMatchObject({ type: "done", ok: true });
  });

  test("follow and tail are read from the query", async () => {
    const { fetch, journalCalls } = handler();
    await fetch(
      new Request(`http://x${RPC_PATHS.logs}?unit=hermeticd.service&follow=true&tail=20`),
      OPERATOR_IP,
    );
    expect(journalCalls).toEqual([{ unit: "hermeticd.service", tail: 20, follow: true }]);
  });

  /**
   * The other source. journald carries Hermes's startup banner and uvicorn's
   * request noise, because upstream attaches no stderr handler unless it is run
   * verbose — the turn that failed is in `$HERMES_HOME/logs/errors.log` and
   * nowhere else, so a `hermetic logs` that can only read the journal cannot
   * answer the question it is usually asked.
   */
  test("GET /logs?file= tails the Hermes log file on the data volume", async () => {
    const { fetch, host, journalCalls } = handler();
    host.seed(hermesLogPath("errors"), "");
    host.journalLines = ["2026-09-01 12:00:00 WARNING turn aborted: provider returned 429"];

    const res = await fetch(new Request(`http://x${RPC_PATHS.logs}?file=errors`), OPERATOR_IP);
    expect(res.status).toBe(200);

    expect(host.commands).toContain(`tail -n 200 ${HERMES_LOG_DIR}/errors.log`);
    // The file source is not the journal, and asking for one must not reach the
    // other: a fallback here would answer the wrong question quietly.
    expect(journalCalls).toEqual([]);

    const all = await frames(res);
    const logs = all.filter((f): f is Extract<RpcFrame, { type: "log" }> => f.type === "log");
    expect(logs).toHaveLength(1);
    // `unit` is the file, because that is the honest label for a flat file, and
    // `errors.log` is WARNING and above by construction, so every line in it is
    // the kind a reader wants highlighted.
    expect(logs[0]?.line).toMatchObject({
      unit: "errors.log",
      message: "2026-09-01 12:00:00 WARNING turn aborted: provider returned 429",
      stream: "stderr",
    });
    expect(all.at(-1)).toMatchObject({ type: "done", ok: true });
  });

  test("a followed file read uses tail -F, which survives a rotation", async () => {
    const { fetch, host } = handler();
    host.seed(hermesLogPath("agent"), "");
    await fetch(new Request(`http://x${RPC_PATHS.logs}?file=agent&follow=1&tail=20`), OPERATOR_IP);
    // `-F` rather than `-f`: these files rotate at 5 MB, and a plain `-f` would
    // keep following the renamed inode nobody writes to any more.
    expect(host.commands).toContain(`tail -n 20 -F ${HERMES_LOG_DIR}/agent.log`);
  });

  /**
   * The end a followed stream is most likely to reach: the operator closes the
   * terminal. Nothing makes `tail -F` exit on its own and it does not notice a
   * closed pipe until it next writes — which on a log gone quiet, the very log
   * somebody stops watching, is never. Every abandoned `hermetic logs --follow`
   * used to leave one running on the box.
   */
  test("dropping a followed stream kills the tail it started", async () => {
    const { fetch, host } = handler();
    host.seed(hermesLogPath("agent"), "");
    host.journalLines = ["2026-09-01 12:00:00 INFO turn complete"];
    // Parks after its line, as a real `tail -F` does between two writes.
    host.followsForever = true;

    const res = await fetch(new Request(`http://x${RPC_PATHS.logs}?file=agent&follow=1`), OPERATOR_IP);
    // Read one frame before hanging up, which is what puts the reader *past*
    // its line and into the park. Cancelling before that would find it
    // suspended at a `yield`, where returning the iterator is enough — the case
    // this is not about.
    await readOneFrame(res);
    await res.body?.cancel();

    expect(host.killedCommands).toEqual([`tail -n 200 -F ${HERMES_LOG_DIR}/agent.log`]);
  });

  test("a journal follow the client drops is killed the same way", async () => {
    const { fetch, host } = handler({ defaultJournal: true });
    host.journalLines = [
      JSON.stringify({ MESSAGE: "hermes started", __REALTIME_TIMESTAMP: "1788264000000000" }),
    ];
    host.followsForever = true;

    const res = await fetch(
      new Request(`http://x${RPC_PATHS.logs}?unit=hermes-dashboard.service&follow=1`),
      OPERATOR_IP,
    );
    await readOneFrame(res);
    await res.body?.cancel();

    expect(host.killedCommands).toEqual([
      "journalctl -u hermes-dashboard.service -o json -n 200 --follow",
    ]);
  });

  /** A read that ends on its own leaves nothing behind either. */
  test("a bounded read's child is not left running once its lines are done", async () => {
    const { fetch, host } = handler();
    host.seed(hermesLogPath("agent"), "");
    host.journalLines = ["2026-09-01 12:00:00 INFO turn complete"];

    const res = await fetch(new Request(`http://x${RPC_PATHS.logs}?file=agent`), OPERATOR_IP);
    await frames(res);

    expect(host.killedCommands).toEqual([`tail -n 200 ${HERMES_LOG_DIR}/agent.log`]);
  });

  /**
   * `-F` differs from `-f` in exactly this: it waits for a path that is not
   * there yet and starts reading when it appears. Somebody following a box
   * mid-bootstrap is asking to be told when Hermes writes its first line, so
   * answering "it does not exist" and hanging up is the one response that
   * cannot be right — that is the question `tail -F` exists to answer.
   */
  test("a followed read of a file Hermes has not written yet waits for it", async () => {
    const { fetch, host } = handler();

    const res = await fetch(
      new Request(`http://x${RPC_PATHS.logs}?file=gateway&follow=1`),
      OPERATOR_IP,
    );
    const all = await frames(res);

    expect(host.commands).toContain(`tail -n 200 -F ${HERMES_LOG_DIR}/gateway.log`);
    expect(all.some((f) => f.type === "log")).toBe(false);
  });

  /**
   * Hermes writes each of these on its first run, so a box that has just
   * finished bootstrapping has none of them. That is a boring answer to a
   * reasonable question, not a failure — an error frame here would read as "the
   * RPC is broken" for a box that is working exactly as expected. Only for a
   * bounded read, though: see the followed case above.
   */
  test("a log file Hermes has not written yet is one frame, not an error", async () => {
    const { fetch, host } = handler();
    const res = await fetch(new Request(`http://x${RPC_PATHS.logs}?file=gateway`), OPERATOR_IP);
    expect(res.status).toBe(200);

    const all = await frames(res);
    expect(all.filter((f) => f.type === "error")).toEqual([]);
    expect(all[0]).toMatchObject({
      type: "log",
      line: { unit: "gateway.log", message: expect.stringContaining("does not exist yet") },
    });
    expect(all.at(-1)).toMatchObject({ type: "done", ok: true });
    expect(host.commands.some((c) => c.startsWith("tail "))).toBe(false);
  });

  test("a query naming both a unit and a file is refused", async () => {
    const { fetch } = handler();
    const res = await fetch(
      new Request(`http://x${RPC_PATHS.logs}?unit=hermes-dashboard.service&file=agent`),
      OPERATOR_IP,
    );
    expect(res.status).toBe(400);
    const [frame] = await frames(res);
    expect(frame).toMatchObject({ type: "error", code: "UNSUPPORTED" });
  });

  test("a file the enum does not name is refused rather than read", async () => {
    const { fetch } = handler();
    const res = await fetch(
      new Request(`http://x${RPC_PATHS.logs}?file=../../etc/shadow`),
      OPERATOR_IP,
    );
    expect(res.status).toBe(400);
  });

  test("logs are refused for a stranger too — whois gates every route", async () => {
    const { fetch } = handler();
    const res = await fetch(
      new Request(`http://x${RPC_PATHS.logs}?unit=hermes-dashboard.service`),
      STRANGER_IP,
    );
    expect(res.status).toBe(403);
  });

  test("GET /healthz reports the identity and the applied config_hash", async () => {
    const { fetch } = handler();
    const res = await fetch(new Request(`http://x${RPC_PATHS.health}`), OPERATOR_IP);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: TEST_NAME,
      hermeticd_version: "0.1.0",
      protocol: 1,
      config_hash: "abc123def4567890",
    });
  });

  test("/healthz carries the browser stack when hermeticd has one to report", async () => {
    const browsers = [
      {
        name: "default",
        unit_active: true,
        cdp_ok: true,
        cdp_version: "Chrome/153.0.8010.12",
        detail: "hermetic-browser@default active (running), CDP Chrome/153.0.8010.12",
      },
    ];
    const { fetch } = handler({ browsers });
    const res = await fetch(new Request(`http://x${RPC_PATHS.health}`), OPERATOR_IP);
    expect(await res.json()).toMatchObject({ browsers });
  });

  /**
   * Absent, not empty. `agents.probe` reads a missing `browsers` as "the box
   * could not say" — an `artifacts push` owing — and an empty array as "the
   * config this box applied lists none", which on a browser agent is a failure
   * naming `agent rerun`. A build with nothing to say must not claim the second.
   */
  test("/healthz omits browsers entirely when hermeticd has nothing to say", async () => {
    const { fetch } = handler();
    const res = await fetch(new Request(`http://x${RPC_PATHS.health}`), OPERATOR_IP);
    expect(Object.keys((await res.json()) as object)).not.toContain("browsers");
  });

  test("a box that has never fetched a config reports config_hash null", async () => {
    const { fetch } = handler({ configHash: null });
    const res = await fetch(new Request(`http://x${RPC_PATHS.health}`), OPERATOR_IP);
    expect(await res.json()).toMatchObject({ config_hash: null });
  });
});

describe("tailscale whois", () => {
  test("a non-zero exit means the peer is not on the tailnet", async () => {
    const host = new FakeHost();
    host.handlers.push((argv) =>
      argv[1] === "whois" ? { code: 1, stdout: "", stderr: "no match" } : null,
    );
    expect(await tailscaleWhois(host)(STRANGER_IP)).toBeNull();
  });

  test("a tailnet peer resolves to its login and node", async () => {
    const host = new FakeHost();
    host.handlers.push((argv) =>
      argv[1] === "whois"
        ? {
            code: 0,
            stdout: JSON.stringify({
              UserProfile: { LoginName: "evan@example.com" },
              Node: { Name: "laptop.tailnet.ts.net", Tags: ["tag:operator"] },
            }),
            stderr: "",
          }
        : null,
    );
    expect(await tailscaleWhois(host)(OPERATOR_IP)).toEqual({
      login: "evan@example.com",
      node: "laptop.tailnet.ts.net",
      tags: ["tag:operator"],
    });
  });
});

describe("journal mapping", () => {
  test("an unparseable line is dropped rather than crashing the stream", () => {
    expect(mapJournalLine("hermes-dashboard.service", "not json")).toBeNull();
    expect(mapJournalLine("hermes-dashboard.service", JSON.stringify({ PRIORITY: "6" }))).toBeNull();
  });
});

describe("binding the listener", () => {
  test("waits for a tailscale address rather than falling back to loopback", async () => {
    const host = new FakeHost();
    let attempts = 0;
    host.handlers.push((argv) => {
      if (argv[0] === "tailscale" && argv[1] === "ip") {
        attempts += 1;
        return attempts < 3
          ? { code: 1, stdout: "", stderr: "no addresses" }
          : { code: 0, stdout: "100.64.0.7\n", stderr: "" };
      }
      return null;
    });

    const waiting: string[] = [];
    const ip = await waitForTailscaleAddress(host, (m) => waiting.push(m));

    expect(ip).toBe("100.64.0.7");
    expect(attempts).toBe(3);
    expect(waiting.length).toBe(2);
    expect(host.sleeps.length).toBe(2);
  });

  test("gives up rather than binding anything else", async () => {
    const host = new FakeHost();
    host.handlers.push((argv) =>
      argv[0] === "tailscale" && argv[1] === "ip"
        ? { code: 1, stdout: "", stderr: "no addresses" }
        : null,
    );
    await expect(waitForTailscaleAddress(host, () => {}, 5_000)).rejects.toThrow(
      /refusing to bind the RPC listener anywhere else/,
    );
  });
});

/**
 * Being on the tailnet is not the same as being allowed to read this box.
 *
 * `whois` used to be fetched and then used for nothing but a null check, so any
 * peer the ACL let reach 7434 got the full journal of every unit — including
 * every *other agent* in the fleet, all of which are on the same tailnet and
 * all of which carry `tag:hermetic`. The ACL hermetic writes says
 * `src: autogroup:member` (§5.2), and this is that sentence enforced on the box.
 */
describe("who may use the RPC", () => {
  test("a tailnet member is allowed, and the request is audited", async () => {
    const { fetch, audit } = handler();

    const res = await fetch(new Request(`http://x${RPC_PATHS.health}`), OPERATOR_IP);

    expect(res.status).toBe(200);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain("GET /healthz");
    expect(audit[0]).toContain("login=evan@example.com");
    expect(audit[0]).toContain("node=laptop.tailnet.ts.net");
    expect(audit[0]).toContain("ok");
  });

  test("a tagged node — another agent in this fleet — is refused", async () => {
    const { fetch, audit } = handler({ peer: AGENT_NODE });

    const res = await fetch(new Request(`http://x${RPC_PATHS.logs}`), OPERATOR_IP);

    expect(res.status).toBe(403);
    const [frame] = await frames(res);
    expect(frame).toMatchObject({ type: "error", code: "FORBIDDEN" });
    expect(frame).toMatchObject({ message: expect.stringContaining("not a tailnet member") });
    // Refusals are audited too — a refused read is the one worth noticing.
    expect(audit[0]).toContain("tags=tag:hermetic");
    expect(audit[0]).toContain("refused");
  });

  test("a peer whois names but nobody owns is refused", async () => {
    const { fetch } = handler({ peer: { login: "", node: "mystery", tags: [] } });
    const res = await fetch(new Request(`http://x${RPC_PATHS.logs}`), OPERATOR_IP);
    expect(res.status).toBe(403);
  });

  test("a stranger is audited too, with no identity to name", async () => {
    const { fetch, audit } = handler();
    await fetch(new Request(`http://x${RPC_PATHS.logs}`), STRANGER_IP);
    expect(audit[0]).toContain("login=-");
    expect(audit[0]).toContain("tags=-");
    expect(audit[0]).toContain("not on the tailnet");
  });

  test("an explicitly allowed tag opens the door the default keeps shut", async () => {
    const { fetch } = handler({ peer: AGENT_NODE, allowedTags: ["tag:hermetic"] });
    const res = await fetch(new Request(`http://x${RPC_PATHS.health}`), OPERATOR_IP);
    expect(res.status).toBe(200);
  });

  /**
   * Anything that can reach 7434 can produce refusals as fast as it can open
   * sockets. A line each would let an unauthorised peer fill journald and evict
   * the very records this audit trail exists to keep — so a refused peer is
   * logged once per window, and the ones in between are counted rather than
   * written.
   */
  test("a peer cannot fill the journal with refusals", async () => {
    const { fetch, host, audit } = handler({ peer: AGENT_NODE });

    for (let i = 0; i < 20; i += 1) {
      expect((await fetch(new Request(`http://x${RPC_PATHS.logs}`), OPERATOR_IP)).status).toBe(403);
    }
    expect(audit).toHaveLength(1);

    // Past the window, one more line — carrying what happened in the silence.
    host.advance(REFUSAL_LOG_WINDOW_MS);
    await fetch(new Request(`http://x${RPC_PATHS.logs}`), OPERATOR_IP);

    expect(audit).toHaveLength(2);
    expect(audit[1]).toContain("+19 suppressed");
  });

  test("a second peer is rate-limited on its own account, not the first's", async () => {
    const { fetch, audit } = handler({ peer: AGENT_NODE });
    await fetch(new Request(`http://x${RPC_PATHS.logs}`), "100.64.0.3");
    await fetch(new Request(`http://x${RPC_PATHS.logs}`), "100.64.0.4");
    expect(audit).toHaveLength(2);
  });

  test("allowed requests are always logged, however many there are", async () => {
    const { fetch, audit } = handler();
    for (let i = 0; i < 5; i += 1) {
      await fetch(new Request(`http://x${RPC_PATHS.health}`), OPERATOR_IP);
    }
    expect(audit).toHaveLength(5);
  });

  test("rpcAccess says why, in every case", () => {
    expect(rpcAccess(null)).toMatchObject({ allowed: false, reason: "not on the tailnet" });
    expect(rpcAccess(MEMBER)).toMatchObject({ allowed: true });
    expect(rpcAccess(AGENT_NODE).allowed).toBe(false);
    expect(rpcAccess(AGENT_NODE, ["tag:ops"]).allowed).toBe(false);
    expect(rpcAccess(AGENT_NODE, ["tag:hermetic"]).allowed).toBe(true);
    // Tailscale's own sentinel for "a machine, acting as itself".
    expect(rpcAccess({ login: TAGGED_DEVICES_LOGIN, node: "n", tags: [] }).allowed).toBe(false);
  });
});
