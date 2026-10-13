/* Chapter 2 — the software: five packages, one core, enforced parity. */

scene({
  id: "packages",
  ch: "Software",
  title: "Five packages, one import matrix",
  html: `
    ${bx(50, 40, 230, 92, "cli", "Commander head<br>imports core in-process", { b: 0 })}
    ${bx(340, 40, 260, 92, "app", "Electrobun main process<br>answers RPC, loads ui", { b: 0 })}
    ${bx(660, 40, 300, 92, "ui", "React page in the webview<br>no node, no AWS", { b: 0 })}
    ${zone(50, 270, 650, 160, "core · the SDK · three doors", { b: 0, c: "acc solid" })}
    ${bx(70, 300, 200, 110, "core", "<span class='mono'>.</span> — all logic, all AWS, SQLite, DynamoDB", { b: 0, c: "sm acc" })}
    ${bx(290, 300, 190, 110, "core/schema", "Zod schemas · the only source of types", { b: 0, c: "sm" })}
    ${bx(500, 300, 180, 110, "core/shared", "pure values, browser-safe · no zod, no node", { b: 0, c: "sm" })}
    ${bx(740, 470, 240, 112, "agentd", "hermeticd · linux-arm64<br>runs on every box", { b: 0, c: "vio" })}

    ${tag(286, 74, "✕", { b: 3, c: "bad" })}
    ${tag(560, 176, "✕ ui → core", { b: 2, c: "bad" })}
    ${tag(330, 530, "✕ agentd → core", { b: 4, c: "bad" })}
    ${txt(560, 8, 400, "<span class='mono' style='color:var(--blue)'>ui → app: typed Electrobun RPC · types only</span>", { b: 2 })}
    ${sealBadge(890, 290, "boundaries", { b: 4 })}

    ${kick(1040, 30, "tests/boundaries.test.ts — the ALLOWED literal", { b: 5 })}
    <table class="cmp up" data-b="5" style="left:1040px;top:56px;width:530px;font-size:14px">
      <tr><th>from \\ may import</th><th>core</th><th>schema</th><th>shared</th><th>cli</th><th>app</th><th>ui</th><th>agentd</th></tr>
      <tr><td>core</td><td>—</td><td>—</td><td>—</td><td class="bad">no</td><td class="bad">no</td><td class="bad">no</td><td class="bad">no</td></tr>
      <tr><td>cli</td><td class="ok">yes</td><td class="ok">yes</td><td class="ok">yes</td><td>—</td><td class="bad">no</td><td class="bad">no</td><td class="bad">no</td></tr>
      <tr><td>app</td><td class="ok">yes</td><td class="ok">yes</td><td class="ok">yes</td><td class="bad">no</td><td>—</td><td class="bad">no</td><td class="bad">no</td></tr>
      <tr><td>ui</td><td class="bad">no</td><td class="bad">no</td><td class="ok">yes</td><td class="bad">no</td><td class="ok">types</td><td>—</td><td class="bad">no</td></tr>
      <tr><td>agentd</td><td class="bad">no</td><td class="ok">yes</td><td class="ok">yes</td><td class="bad">no</td><td class="bad">no</td><td class="bad">no</td><td>—</td></tr>
    </table>
    ${list(1040, 340, 530, [
      [
        "acc",
        "Every <span class='m'>import</span>, <span class='m'>export … from</span>, <span class='m'>import()</span> and <span class='m'>require()</span> in every <span class='m'>packages/*/src</span> file is resolved to one cell.",
        5,
      ],
      [
        "acc",
        "A <span class='m'>no</span> covers <span class='m'>import type</span> too. Relative paths escaping a package hit the same table.",
        5,
      ],
      [
        "acc",
        "<span class='m'>shared</span> is checked separately: nothing reachable from it may need node, bun, zod or AWS — the UI bundles it.",
        5,
      ],
    ])}
  `,
  svg: `
    ${wire("M165 132 L165 300", { b: 1, c: "ok" })}
    ${wire("M440 132 L440 270", { b: 1, c: "ok" })}
    ${lbl(176, 220, "in-process", { b: 1, c: "ok" })}
    ${lbl(430, 236, "in-process", { b: 1, c: "ok", anchor: "end" })}
    ${wire("M660 86 L604 86", { b: 2, c: "blue" })}
    ${wire("M880 132 L880 240 L620 240 L620 300", { b: 2, c: "ok" })}
    ${wire("M720 132 C 720 200, 240 200, 200 298", { b: 2, c: "bad", end: false })}
    ${wire("M282 86 L338 86", { b: 3, c: "bad", end: false })}
    ${wire("M740 500 L400 500 L400 412", { b: 4, c: "ok" })}
    ${wire("M740 520 L600 520 L600 412", { b: 4, c: "ok" })}
    ${wire("M740 560 L170 560 L170 412", { b: 4, c: "bad", end: false })}
  `,
  beats: [
    {
      c: 'The repo is five Bun workspaces, and the workspace boundaries <b>are</b> the architecture: they turn "just add it to the CLI" into a build error.',
      r: ["AGENTS.md · Layout", "design.md §3.1"],
    },
    {
      c: "Both heads — the CLI and the app's main process — import core <em>in-process</em>. There is no daemon, socket or server between a head and the SDK.",
      r: ["packages/cli/src/program.ts", "packages/app/src/main/index.ts"],
    },
    {
      c: "The UI is a page inside the app's webview. It reaches the app only over typed Electrobun RPC and may not import core — only <code>core/shared</code>, the browser-safe door, plus the app's types.",
      r: ["packages/ui/src/api/transport-rpc.ts", "packages/core/src/shared/"],
    },
    {
      c: "The CLI can't import the app and the app can't import the CLI, so no capability can become CLI-only or GUI-only by accident.",
      r: ["tests/parity.test.ts"],
    },
    {
      c: "<b>hermeticd</b>, the agent on every box, may import only <code>core/schema</code> and <code>core/shared</code>. Fleet operations — create, destroy, the AWS command layer — are not in its binary at all.",
      r: ["packages/agentd/src/", "design.md §3.1"],
      seal: "boundaries",
    },
    {
      c: "The matrix is literal: <code>tests/boundaries.test.ts</code> transpiles every source file, resolves every specifier to one cell, and the table has no exceptions.",
      r: ["tests/boundaries.test.ts", "packages/core/test/shared-browser-safe.test.ts"],
    },
  ],
});

scene({
  id: "core",
  ch: "Software",
  title: "Inside core: rules, streams, one Backend",
  html: `
    ${zone(30, 30, 620, 600, "packages/core/src", { b: 0, c: "acc solid" })}
    ${bx(56, 60, 280, 70, "open.ts", "openHermetic / openForInit — every head starts here", { b: 0, c: "sm acc" })}
    ${bx(352, 60, 272, 70, "hermetic.ts", "assembles the SDK (~570 lines of wiring)", { b: 0, c: "sm" })}
    ${bx(56, 146, 568, 70, "context.ts · CoreContext", "the one object every long op takes: backend, clock, actor, guards, TTL locks, transition(), events", { b: 0, c: "sm" })}
    ${bx(56, 232, 136, 58, "agents/", "lifecycle, destroy, plans", { b: 0, c: "xs" })}
    ${bx(200, 232, 136, 58, "fleet/", "init, foundation, doctor", { b: 0, c: "xs" })}
    ${bx(344, 232, 136, 58, "release/", "artifacts, mirrors", { b: 0, c: "xs" })}
    ${bx(488, 232, 136, 58, "render/", "final files, no templates", { b: 0, c: "xs" })}
    ${bx(56, 298, 136, 58, "profiles/", "providers, keys", { b: 0, c: "xs" })}
    ${bx(200, 298, 136, 58, "chat/", "Hermes adapter", { b: 0, c: "xs" })}
    ${bx(344, 298, 136, 58, "local/db/", "SQLite: config, runs", { b: 0, c: "xs" })}
    ${bx(488, 298, 136, 58, "schema/ shared/", "types · browser-safe", { b: 0, c: "xs" })}
    ${list(60, 386, 570, [
      [
        "acc",
        "<b>1 · Core never talks to a human.</b> No <span class='m'>console.*</span>, no <span class='m'>process.exit</span>, no prompts — typed results and <span class='m'>HermeticError{code}</span>.",
        1,
      ],
      [
        "acc",
        "<b>2 · Long operations yield events</b> — <span class='m'>AsyncIterable&lt;OpEvent&gt;</span> + <span class='m'>AbortSignal</span>.",
        2,
      ],
      ["acc", '<b>3 · Plan, then apply.</b> Core never asks "are you sure"; heads confirm.', 2],
      ["acc", "<b>4 · Parity is testable.</b> <b>5 · No file over 1500 lines.</b> Both linted.", 2],
    ])}

    ${term(
      700,
      40,
      380,
      150,
      `<span class="c">// one OpEvent stream…</span>
{ phase: <span class="g">"claim"</span>,   progress: .05 }
{ phase: <span class="g">"secrets"</span>, progress: .20 }
{ phase: <span class="g">"render"</span>,  progress: .40 }
{ phase: <span class="g">"launch"</span>,  progress: .70 }`,
      { b: 2 },
    )}
    ${bx(1120, 30, 210, 56, "CLI", "spinner + lines", { b: 2, c: "xs" })}
    ${bx(1120, 96, 210, 56, "app → ui", "progress bar, step list", { b: 2, c: "xs" })}
    ${bx(1120, 162, 210, 56, "runs table", "persisted, resumable", { b: 2, c: "xs" })}
    ${txt(1350, 60, 230, "<b>One source, three renderings.</b> Closing the window does not kill a create.", { b: 2 })}

    ${zone(700, 250, 870, 380, "backend/types.ts · interface Backend", { b: 3, c: "blue solid" })}
    ${[
      "identity|STS · IAM · Orgs",
      "store|agents · events · _fleet",
      "secrets|SSM slots",
      "artifacts|S3",
      "compute|EC2 · EBS · SG",
      "foundation|CloudFormation",
      "tailscale|keys · devices · ACL",
      "rpc|hermeticd logs/health",
      "directory|fleet directory",
      "clock|now()",
    ]
      .map((p, i) => {
        const [n, s] = p.split("|");
        return bx(720 + (i % 5) * 168, 284 + Math.floor(i / 5) * 76, 156, 64, n, s, {
          b: 3,
          c: "xs blue",
        });
      })
      .join("")}
    ${bx(740, 470, 360, 130, "AwsBackend", "packages/core/src/aws/ — real SDK calls, every client built by aws.client() under the account guard", { b: 4, c: "acc" })}
    ${bx(1160, 470, 380, 130, "MemoryBackend", "backend/memory.ts — in-memory fake fleet. Fixture mode, the dev app and every unit test", { b: 4, c: "ok" })}
  `,
  svg: `
    ${wire("M650 200 L700 116", { b: 2, c: "acc" })}
    ${wire("M1080 90 L1120 58", { b: 2, c: "acc" })}
    ${wire("M1080 115 L1120 124", { b: 2, c: "acc" })}
    ${wire("M1080 150 L1120 190", { b: 2, c: "acc" })}
    ${wire("M650 420 L700 420", { b: 3, c: "blue" })}
    ${wire("M920 440 L920 470", { b: 4, c: "acc" })}
    ${wire("M1350 440 L1350 470", { b: 4, c: "ok" })}
  `,
  beats: [
    {
      c: "Inside core, every head enters through <code>open.ts</code>. <code>hermetic.ts</code> wires the SDK together, and each long operation is its own module taking a <code>CoreContext</code> — never another function bolted onto one big file.",
      r: ["packages/core/src/open.ts", "packages/core/src/context.ts", "docs/architecture.md"],
    },
    {
      c: "Rule one: core never talks to a human. It returns typed results and errors with codes; the CLI maps codes to exit statuses, the app to typed RPC failures. The linter enforces it.",
      r: ["scripts/lint.ts", "packages/core/src/errors.ts"],
    },
    {
      c: "Long operations are streams of <code>{ phase, progress, message }</code>. The same stream becomes a CLI spinner, the app's progress view and a persisted run record — and destructive work is always a <em>plan</em> first, applied only after a head confirms.",
      r: ["packages/core/src/agents/plans.ts", "packages/app/src/ops.ts"],
    },
    {
      c: "Everything core can do to the outside world is one interface, <code>Backend</code>, with a port per store or service. No AWS SDK client exists outside <code>packages/core/src/aws/</code>.",
      r: ["packages/core/src/backend/types.ts"],
    },
    {
      c: "Two implementations: <code>AwsBackend</code> for real calls, <code>MemoryBackend</code> for an in-memory fleet. The same lifecycle code runs unmodified against both — which is how fixture mode and the whole test suite work without AWS.",
      r: ["packages/core/src/aws/", "packages/core/src/backend/memory.ts"],
    },
  ],
});
