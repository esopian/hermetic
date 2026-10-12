/* Chapter 6 — safety rails, the sealed lab, the seal map, the honest gaps, where to read next. */

scene({
  id: "state",
  ch: "Safety rails",
  title: "State, versions and locks",
  html: `
    ${kick(30, 20, "agents.status · §4.3", { b: 0 })}
    ${st(30, 60, "creating", { b: 0, c: "acc" })}
    ${st(220, 60, "bootstrapping", { b: 0, c: "acc" })}
    ${st(460, 60, "ready", { b: 0, c: "ok" })}
    ${st(460, 160, "degraded", { b: 0, c: "warn" })}
    ${st(220, 160, "error", { b: 0, c: "bad" })}
    ${st(620, 60, "stopping", { b: 0, c: "dim" })}
    ${st(620, 160, "stopped", { b: 0, c: "dim" })}
    ${st(30, 260, "destroying", { b: 0, c: "bad" })}
    ${st(230, 260, "destroyed", { b: 0, c: "dim" })}
    ${txt(30, 316, 720, "<span class='dot' style='background:var(--vio)'></span><b>box writes</b>: bootstrapping, ready ⇄ degraded, → error. <span class='dot acc'></span><b>operator writes</b> the rest — and rerun only as a command the box acts on. <span class='mono'>unreachable</span> is derived from a stale heartbeat, never stored.", { b: 0 })}

    ${code(
      30,
      400,
      720,
      230,
      "every write is conditional",
      `UpdateItem agents/atlas
  SET status = <span class="s">:ready</span>, version = version + 1
  <span class="a">ConditionExpression</span>: version = <span class="s">:7</span> AND status = <span class="s">:bootstrapping</span>

<span class="c">conflict →</span> re-read: if the store already reached our target, adopt it
          (a resync, not an error) — else surface CONFLICT
<span class="c">so a stale writer can never move a destroying agent back to ready</span>`,
      { b: 1 },
    )}

    ${zone(800, 20, 770, 610, "locks · all TTL, all conditional", { b: 2, c: "acc solid" })}
    ${bx(824, 56, 360, 120, "agent lock · 10 min", "create · upgrade · destroy take lock{owner, expires} and heartbeat it; a dead laptop's lock simply expires", { b: 2, c: "sm" })}
    ${bx(1196, 56, 352, 120, "fleet lock on _fleet · 10 min", "foundation update and network apply serialise the whole fleet", { b: 2, c: "sm" })}
    ${bx(824, 190, 360, 120, "profile writes · 30 s", "settings record + SSM slot aren't atomic, so key rotations hold the fleet lock across both", { b: 2, c: "sm" })}
    ${bx(1196, 190, 352, 120, "volume reservation · 10 min", "for a disk no row owns yet: create --volume, volume delete", { b: 2, c: "sm" })}
    ${bx(824, 326, 724, 130, "teardown holds the fleet lock for its entire run", "taken before its agent check and renewed from inside the bucket sweep and stack wait — so no create on another laptop can slip a config into a bucket being emptied. Every fleet mutation meanwhile is refused LOCKED, naming the teardown.", { b: 3, c: "sm bad" })}
    ${bx(824, 472, 724, 136, "multiplayer without a server", "Each operator runs their own hermetic; DynamoDB is where they meet. Identity is free — every event records the caller's STS ARN. Acquire, then read: the revision an operation commits against comes from a read taken with the lock held.", { b: 4, c: "sm" })}
  `,
  svg: `
    ${wire("M150 76 L220 76", { flow: false, b: 0, c: "acc" })}
    ${wire("M410 76 L460 76", { flow: false, b: 0, c: "ok" })}
    ${wire("M500 94 L500 160", { flow: false, b: 0, c: "warn", start: true })}
    ${wire("M280 94 L280 160", { flow: false, b: 0, c: "bad" })}
    ${wire("M310 160 C 330 130, 330 120, 320 94", { flow: false, b: 0, c: "acc", w: "thin" })}
    ${wire("M560 76 L620 76", { flow: false, b: 0 })}
    ${wire("M680 94 L680 160", { flow: false, b: 0 })}
    ${wire("M640 160 C 560 120, 420 120, 380 94", { flow: false, b: 0, w: "thin" })}
    ${wire("M180 276 L230 276", { flow: false, b: 0, c: "bad" })}
  `,
  beats: [
    {
      c: "Every agent moves through one state machine. The box writes its own transitions; the operator writes the rest — and even a rerun is a request the box picks up, not a transition forced on it.",
      r: ["packages/core/src/agents/state.ts", "design.md §4.3"],
    },
    {
      c: "Every write is a conditional update on the item's version. Losing a race means re-reading; being asked to move a row to the status it already holds is treated as a resync — which is what makes re-running any stuck command safe.",
      r: ["backend · store port", "design.md §4.5"],
    },
    {
      c: "Long operations take TTL locks — per agent, per fleet, per volume — and renew them as they work. A laptop that dies mid-operation leaves a lock that simply expires.",
      r: ["packages/core/src/fleet/fleet-lock.ts", "context.ts · TTL locks"],
    },
    {
      c: "Teardown holds the fleet lock from its first check to its last delete, so nothing created elsewhere can be swept up silently while it runs.",
      r: ["packages/core/src/fleet/teardown.ts"],
      seal: "cas",
    },
    {
      c: "That's the whole multiplayer model: no server, no login system. Each operator's hermetic meets the others in DynamoDB, and every event records who did it.",
      r: ["design.md §4.4"],
    },
  ],
});

scene({
  id: "plan",
  ch: "Safety rails",
  title: "Plan, confirm, apply",
  html: `
    ${code(
      30,
      30,
      520,
      300,
      'core · plan.destroy("atlas")',
      `{
  kind: <span class="s">"destroy"</span>,
  summary: { account_id, region, fleet_id: <span class="a">"fxtr0001"</span> },
  steps: [
    terminate i-07c3…,
    detach vol-0a91… <span class="c">(kept)</span>,
    delete config/atlas/*,
    delete /hermes/fxtr0001/atlas/*,
    remove tailnet device
  ],
  warnings: [ … ]
}`,
      { b: 0 },
    )}
    ${bx(600, 30, 440, 140, "CLI", "prints the plan, then @clack confirm — or --yes for scripts. The target header repeats: ▸ main · 123456789012 · us-east-1", { b: 1, c: "sm" })}
    ${bx(600, 190, 440, 140, "app", "the drawer shows the plan; destructive buttons stay disabled until the typed name matches", { b: 1, c: "sm" })}
    ${bx(1090, 30, 480, 300, "apply(plan)", 'executes exactly what was reviewed:<br><br>· bound to the fleet in its summary — never applied to another<br>· a policy plan carries its ETag; no ETag, no write<br>· core never asks "are you sure" — confirmation is the head\'s job, and dry-run is free', { b: 2, c: "acc" })}
    ${zone(30, 370, 1540, 260, "the biggest one · hermetic plan teardown → hermetic teardown", { b: 3, c: "bad solid" })}
    ${term(
      56,
      404,
      700,
      200,
      `<span class="p">$</span> hermetic teardown --yes \\
    <span class="y">--confirm-account-id 123456789012</span>
<span class="c">refuses while any agent exists · takes the fleet lock</span>
<span class="c">phases: stack delete → bucket sweep → tables → local reset</span>
<span class="g">Tailnet policy left unchanged; managed rules may serve</span>
<span class="g">other fleets. Review them manually …</span>`,
      { b: 3 },
    )}
    ${bx(790, 404, 760, 200, "typed, not clicked", "The twelve-digit account id is a required typed confirmation, not --yes alone; in the app, the account id <b style='color:var(--fg)'>and</b> the word teardown, in the one full-red DANGER block in the UI. The words in the plan, the run and the receipt are one exported constant, so what you confirmed is what you read back months later.", { b: 3, c: "sm" })}
  `,
  svg: `
    ${wire("M550 100 L600 100", { b: 1, c: "acc" })}
    ${wire("M550 260 L600 260", { b: 1, c: "acc" })}
    ${wire("M1040 100 L1090 120", { b: 2, c: "acc" })}
    ${wire("M1040 260 L1090 240", { b: 2, c: "acc" })}
  `,
  beats: [
    {
      c: "Destructive work is two calls. Core computes a <b>plan</b> — every step it would take, the warnings, and the exact fleet it was computed against — and changes nothing.",
      r: ["packages/core/src/agents/plans.ts", "design.md §3.2 rule 3"],
    },
    {
      c: "The head shows it and asks: the CLI with a prompt (or <code>--yes</code> for scripts), the app with a drawer whose button waits for the typed name.",
      r: ["packages/cli/src/confirm.ts", "packages/ui/src/destroy-plan.ts"],
    },
    {
      c: "<code>apply(plan)</code> executes what was reviewed, and only against the fleet the plan names. Core itself never prompts.",
      r: ["packages/core/src/agents/plan-apply.ts"],
    },
    {
      c: "Teardown is the extreme: it refuses while any agent exists, demands the account id typed out, holds the fleet lock throughout, and deliberately leaves your tailnet policy alone.",
      r: ["packages/core/src/fleet/teardown.ts", "docs/operations.md · Teardown"],
      seal: "plan",
    },
  ],
});

scene({
  id: "lab",
  ch: "Safety rails",
  title: "The sealed lab: fixture mode and tests",
  html: `
    ${zone(20, 30, 740, 290, "fixture mode · --fixture · HERMETIC_FIXTURE=1 · bun run dev:fixture", { b: 0, c: "ok solid" })}
    ${bx(44, 64, 340, 120, "MemoryBackend", "a fake fleet in memory — no AWS client of any kind, no git for the Hermes mirror", { b: 0, c: "sm ok" })}
    ${bx(400, 64, 340, 120, "seeded fleets", "fxtr0001 'main' · 12 agents, 5 provider profiles<br>sg7k2m4p 'staging' · one version behind", { b: 0, c: "sm" })}
    ${bx(44, 196, 340, 108, "hermetic-fixture.db", "its own run log; the real hermetic.db is never touched", { b: 0, c: "sm" })}
    ${bx(400, 196, 340, 108, "pre-init session", "before init, a notInitializedBackend throws for every call — the wizard can't reach AWS before you pick a profile", { b: 1, c: "sm" })}

    ${zone(800, 30, 770, 290, "tests can't escape", { b: 2, c: "acc solid" })}
    ${list(
      824,
      64,
      730,
      [
        [
          "acc",
          "<b>No network.</b> AWS is mocked with <span class='m'>aws-sdk-client-mock</span>; hermeticd runs against <span class='m'>fake-host.ts</span> — no root, systemd, apt or network.",
        ],
        [
          "acc",
          "<b>No real home.</b> <span class='m'>tests/preload.ts</span> gives every test process a fresh <span class='m'>HERMETIC_HOME</span>, unsets <span class='m'>AWS_PROFILE</span>, <span class='m'>HERMETIC_FLEET</span>, <span class='m'>HERMETIC_FIXTURE</span>, and throws if the temp root resolves inside the real home.",
        ],
        [
          "acc",
          "<b>UI end-to-end without a browser driver:</b> real components over the real bind and dispatch, against the fixture backend.",
        ],
      ],
      { b: 2 },
    )}

    ${kick(20, 344, "the gates · bun run check / bun run ci", { b: 3 })}
    ${[
      ["boundaries.test.ts", "the import matrix"],
      ["parity.test.ts", "one command + one handler per method"],
      ["secrets-leak.test.ts", "no fixture secret / tskey- in output"],
      ["shared-browser-safe", "core/shared needs no node, zod, AWS"],
      ["render-network-invariants", "loopback binds, nft policy drop"],
      ["foundation-version", "template sha ⇒ FOUNDATION_VERSION bump"],
      ["seams.test.ts / user-data", "every laptop→box document, both sides"],
      ["scripts/lint.ts", "no console in core, no any, ≤1500 lines, owned TODOs"],
    ]
      .map(([t, s], i) =>
        bx(20 + (i % 4) * 390, 374 + Math.floor(i / 4) * 128, 374, 112, t, s, { b: 3, c: "sm" }),
      )
      .join("")}
  `,
  beats: [
    {
      c: "Fixture mode runs the <b>whole product</b> — CLI and app — against an in-memory backend with two seeded fleets. The same lifecycle code runs; nothing can reach AWS or touch your real state.",
      r: ["packages/core/src/backend/fixture/", "packages/core/src/open.ts"],
    },
    {
      c: "Even the real app is sealed before init: until you've chosen a profile, the backend behind it throws <code>NOT_INITIALIZED</code> for every call.",
      r: ["packages/app/src/state.ts · openState", "open.ts · openForInit"],
    },
    {
      c: "Tests are sealed too: no network, no real home directory, no inherited environment. A test that could touch your machine fails before it starts.",
      r: ["tests/preload.ts", "tests/test-isolation.test.ts", "packages/agentd/test/fake-host.ts"],
    },
    {
      c: "And each seal in this walkthrough has a gate. The import matrix, parity, secret leaks, loopback binds, foundation version — all are tests or lint rules that fail the build, not conventions in a review.",
      r: ["tests/", "scripts/lint.ts", "CONTRIBUTING.md"],
      seal: "lab",
    },
  ],
});

const LAYERS = {
  boundaries: "code",
  account: "laptop",
  triple: "laptop",
  plan: "laptop",
  cas: "laptop",
  app: "laptop",
  chat: "laptop",
  lab: "code",
  named: "aws",
  sg: "aws",
  iam: "aws",
  supply: "aws",
  tailnet: "tailnet",
  noport: "tailnet",
  nft: "box",
  loopback: "box",
  instance: "box",
  browser: "box",
  secrets: "box",
  pin: "box",
};
const LAYER_ORDER = ["code", "laptop", "aws", "tailnet", "box"];
const LAYER_COLOR = {
  code: "var(--vio)",
  laptop: "var(--fg)",
  aws: "var(--acc)",
  tailnet: "var(--blue)",
  box: "var(--ok)",
};
const LAYER_NAME = {
  code: "the codebase",
  laptop: "the laptop + app",
  aws: "the AWS account",
  tailnet: "the tailnet",
  box: "the box",
};

scene({
  id: "sealmap",
  ch: "Summary",
  title: "Every seal, by layer",
  html: (() => {
    const ordered = LAYER_ORDER.flatMap((l) => SEALS.filter((s) => LAYERS[s.id] === l));
    return ordered
      .map((s, i) => {
        const l = LAYERS[s.id];
        const n = SEAL_INDEX[s.id] + 1;
        const x = 20 + (i % 5) * 312,
          y = 14 + Math.floor(i / 5) * 160;
        return `<div class="bx sm pop" data-b="${LAYER_ORDER.indexOf(l)}" style="left:${x}px;top:${y}px;width:300px;height:148px;border-top:3px solid ${LAYER_COLOR[l]}">
          <div class="k" style="color:${LAYER_COLOR[l]}">${LAYER_NAME[l]}</div>
          <div class="t"><span class="mono" style="color:var(--acc);font-size:15px;margin-right:6px">${String(n).padStart(2, "0")}</span>${s.name}</div>
          <div class="s">${s.where.replace(/</g, "&lt;")}</div></div>`;
      })
      .join("");
  })(),
  beats: [
    {
      c: "Here they are together. In the <b>codebase</b>: package boundaries no import can cross, and a test suite sealed from your machine and AWS.",
      r: ["tests/boundaries.test.ts", "tests/preload.ts"],
    },
    {
      c: "On the <b>laptop</b>: a frozen account, the fleet triple, plan-then-confirm, versioned writes and locks, a portless app, and one redaction door for chat.",
      r: ["aws/client.ts", "app/src/target.ts", "chat/chat-seal.ts"],
    },
    {
      c: "In <b>AWS</b>: fleet-named resources, a security group with no inbound rules, a box role that can't see the fleet's secrets, and content-addressed releases.",
      r: ["foundation template", "release/"],
    },
    {
      c: "On the <b>tailnet</b>: tagged nodes behind an ACL hermetic manages carefully — and no control port, because commands ride the DynamoDB row.",
      r: ["fleet/policy.ts", "agentd/src/rpc.ts"],
    },
    {
      c: "On the <b>box</b>: a host firewall, loopback-only services, a contained browser, a tmpfs-only secret path, pinned Hermes — and the instance itself as the trust boundary around an agent that is otherwise root.",
      r: ["render/render-system.ts", "render/render-browser.ts", "agentd/src/apply/"],
    },
  ],
});

scene({
  id: "gaps",
  ch: "Summary",
  title: "Where the seal is thin — on the record",
  html: `
    ${txt(30, 14, 1540, "hermetic documents its own weak points in design.md rather than hiding them. Knowing them is part of understanding the system.", { b: 0, st: "font-size:19px;color:var(--fg)" })}
    ${list(
      30,
      76,
      750,
      [
        [
          "warn",
          "<b>Fleet-wide box role + open IMDS.</b> Any process on a box can mint the role's credentials and read its fleet-mates' slots, rows and config. Fix named: a role per agent, an IMDS hop limit. <span class='m'>§5.1</span>",
          0,
        ],
        [
          "warn",
          "<b>Root inside the box, by design.</b> Whatever compromises Hermes owns the instance — and so the role above. The boundary is the instance. <span class='m'>§6.4, §7.1</span>",
          1,
        ],
        [
          "warn",
          "<b>policy_file is tailnet-wide.</b> The OAuth client can edit your whole ACL; mitigated by marker-splicing, validate, If-Match, plan/diff, an event log — or <span class='m'>--skip-policy</span>. <span class='m'>§5.2</span>",
          1,
        ],
        [
          "warn",
          "<b>Port 443 = dashboard + live browser,</b> no per-user identity in Hermes's audit log (local mode). Anyone the ACL admits may drive the agent. <span class='m'>§5.2, §6.4</span>",
          2,
        ],
        [
          "warn",
          "<b>Egress is unfiltered.</b> Outbound is open by design; Hermes's debug-share can upload a redacted log tail to paste.rs. <span class='m'>§7.2</span>",
          2,
        ],
      ],
      { a: "up lg" },
    )}
    ${list(
      820,
      76,
      750,
      [
        [
          "warn",
          "<b><span class='m'>chat.turn</span> carries no fleet target,</b> so a window left open across a fleet switch could send to the new fleet — pinned by a <span class='m'>test.failing</span>. <span class='m'>§4.7</span>",
          3,
        ],
        [
          "warn",
          "<b>Unsigned app builds.</b> The updater verifies only by TLS, so updates are a notice and a manual DMG install until releases are signed. <span class='m'>§3.6</span>",
          3,
        ],
        [
          "warn",
          "<b>Tailscale auto-updates unpinned.</b> It's the only ingress, so a bad release also breaks <span class='m'>agent rerun</span>; recovery is the serial console or SSM. <span class='m'>§6.3</span>",
          4,
        ],
        [
          "warn",
          "<b>nat mode has one fck-nat instance,</b> no failover — doctor watches it, nothing heals it. <span class='m'>§5, §7.2</span>",
          4,
        ],
        [
          "warn",
          "<b>An agent's own <span class='m'>.env</span> can shadow its key.</b> Caught at boot (<span class='m'>env_shadow</span>), only reported by doctor afterwards. <span class='m'>§8.1</span>",
          4,
        ],
      ],
      { a: "up lg" },
    )}
  `,
  beats: [
    {
      c: "No seal is perfect, and hermetic says where its are thin. The biggest: every box in a fleet shares one role, and any process on a box can reach the metadata service to use it.",
      r: ["design.md §5.1 · Why not ABAC"],
    },
    {
      c: "Two are deliberate trades: the agent is root inside its box so it can work unattended, and hermetic manages tailnet policy with a scope Tailscale can't narrow — so both are fenced by mechanism, not promise.",
      r: ["design.md §6.4 · root on the box", "§5.2 · trade-off"],
    },
    {
      c: "The tailnet ACL is the only authorization in front of the dashboard and browser, and outbound traffic is open, because agents need the web.",
      r: ["design.md §7.2"],
    },
    {
      c: "Known code gaps are pinned rather than forgotten: a chat request without a fleet target is a failing test with an owner, and app updates wait on signed releases.",
      r: ["packages/app/test/fleet-target.test.ts", "design.md §3.6"],
    },
    {
      c: "And operational edges are written down with their recovery path — unpinned Tailscale updates, a single NAT instance, an agent's own config shadowing its key.",
      r: ["docs/operations.md · Recovery scenarios"],
    },
  ],
});

scene({
  id: "read",
  ch: "Summary",
  title: "Where to read the code next",
  html: `
    ${[
      [
        "1 · run it with no AWS",
        "bun install\nbun run dev:fixture\nbun run cli -- agent ps --fixture",
        "the whole product, sealed in fixture mode",
      ],
      [
        "2 · the surface",
        "packages/core/src/surface.ts\npackages/core/src/hermetic.ts",
        "every method, then how they're wired",
      ],
      [
        "3 · entry + context",
        "packages/core/src/open.ts\npackages/core/src/context.ts",
        "how a head gets a Hermetic, what every op takes",
      ],
      [
        "4 · one operation, end to end",
        "core/src/agents/lifecycle/create-agent.ts\ncli/src/commands/agent.ts\napp/src/handlers/agents.ts",
        "follow agents.create through all three",
      ],
      [
        "5 · the guard + backends",
        "core/src/aws/client.ts\ncore/src/backend/types.ts\ncore/src/backend/memory.ts",
        "how AWS is reached, and faked",
      ],
      [
        "6 · what the box receives",
        "core/src/render/render.ts\ncore/src/schema/userdata.ts",
        "rendered files, user-data, the manifest",
      ],
      [
        "7 · the box itself",
        "agentd/src/bootstrap.ts\nagentd/stages/*.sh\nagentd/src/apply/index.ts\nagentd/src/daemon.ts",
        "first boot, apply, the resident loops",
      ],
      [
        "8 · the seams + gates",
        "tests/boundaries.test.ts\ntests/parity.test.ts\ntests/seams.test.ts",
        "the rules, as executable checks",
      ],
    ]
      .map(
        ([t, c, s], i) => `
      <div class="bx sm up" data-b="${Math.floor(i / 2)}" style="left:${20 + (i % 4) * 390}px;top:${20 + Math.floor(i / 4) * 236}px;width:374px;height:220px">
        <div class="t">${t}</div>
        <div class="term" style="position:static;margin-top:6px;font-size:12.5px;white-space:pre;padding:8px 10px">${c}</div>
        <div class="s" style="margin-top:6px">${s}</div>
      </div>`,
      )
      .join("")}
    ${txt(20, 500, 1540, "<span style='font-size:26px;font-weight:900;color:var(--fg)'>One SDK, two heads, one sealed agent per box.</span><br>Spec: <span class='mono'>docs/design.md</span> (read by section: <span class='mono'>grep -n \"^## \\|^### \" docs/design.md</span>) · runtime map: <span class='mono'>docs/architecture.md</span> · running a fleet: <span class='mono'>docs/operations.md</span> · rules for contributors: <span class='mono'>AGENTS.md</span>", { b: 4 })}
    <div class="pop" data-b="4" style="position:absolute;left:1500px;top:510px;width:46px;height:46px;background:var(--acc)"></div>
  `,
  beats: [
    {
      c: "To learn the code, start by running it sealed: fixture mode needs no AWS. Then read the surface — every method in one list — and how <code>hermetic.ts</code> wires it.",
      r: ["README.md · Developing"],
    },
    {
      c: "Next, the two entry points every head goes through, then follow a single method, <code>agents.create</code>, through core, the CLI command and the RPC handler.",
      r: ["AGENTS.md · Start here"],
    },
    {
      c: "Then the edges: how AWS is reached through the guard and faked by the memory backend, and exactly what gets rendered and handed to a box.",
      r: ["docs/architecture.md"],
    },
    {
      c: "Finally, the box itself — bootstrap, stages, apply, the resident loops — and the tests that turn every rule you've seen into a build failure.",
      r: ["packages/agentd/", "tests/"],
    },
    {
      c: "That's hermetic: one SDK, two heads, one sealed agent per box. Press <code>T</code> to jump back to any chapter.",
      r: ["docs/design.md", "docs/architecture.md", "docs/operations.md"],
    },
  ],
});
