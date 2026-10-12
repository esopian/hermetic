/* Chapter 5 — communication: the row as control plane, the app's seam, chat. */

scene({
  id: "control",
  ch: "Communication",
  title: "The row is the control plane",
  html: `
    ${zone(20, 30, 360, 600, "laptops", { b: 0, c: "solid" })}
    ${bx(44, 64, 312, 96, "hermetic CLI", "reads DynamoDB directly on every command · consistent reads", { b: 0, c: "sm" })}
    ${bx(44, 180, 312, 120, "Hermetic.app", "FleetPoller: Scan once a minute → in-memory snapshot → diffs pushed to the page", { b: 3, c: "sm" })}
    ${bx(44, 320, 312, 110, "another operator", "their own hermetic, same account — DynamoDB is where they meet", { b: 3, c: "sm" })}

    ${zone(440, 30, 560, 600, "dynamodb · agents · pk = atlas", { b: 0, c: "acc solid" })}
    ${code(
      462,
      64,
      516,
      210,
      "written by the box · every 30 s",
      `status          <span class="s">ready</span>
last_heartbeat  2026-10-08T14:02:31Z
health          { hermes ✓, tailscale ✓, disk ✓, dashboard ✓ }
metrics         { cpu 12%, mem 41%, disk 18%, root 63% }
running_hermeticd_sha256  e3b0c4…
tailscale_dns_name        fxtr0001-atlas.tail1a2b.ts.net`,
      { b: 1 },
    )}
    ${code(
      462,
      296,
      516,
      170,
      "written by an operator",
      `command         { id: c-91, action: <span class="a">"rerun"</span> }
update_request  { id: u-12, hermeticd_version: 0.5.1 }
config_hash     <span class="a">a77e10…</span>  <span class="c">← differs from applied</span>
pending         { profile ant00001 r4 }  <span class="c">← staged</span>`,
      { b: 2 },
    )}
    ${bx(462, 486, 516, 124, "no push channel into the box", "There is no converge RPC and no inbound port. A command waits on the row until the box's own heartbeat reads it, and every transition is a conditional update.", { b: 2, c: "sm" })}

    ${zone(1060, 30, 520, 360, "agent box", { b: 0, c: "ok solid" })}
    ${bx(1084, 64, 472, 100, "hermeticd heartbeat", "every 30 s: write health → read own row → hand any request to its loop", { b: 1, c: "sm vio" })}
    ${bx(1084, 180, 225, 92, "request-gate.ts", "converge · update_request · rerun", { b: 2, c: "xs" })}
    ${bx(1331, 180, 225, 92, "install-lock.ts", "one on-box lock: bootstrap, apply and update never race", { b: 2, c: "xs" })}
    ${bx(1084, 288, 472, 84, "rpc.ts · :7434 on tailscale0", "logs + health · caller identified with tailscale whois", { b: 4, c: "xs vio" })}
    ${zone(1060, 420, 520, 210, "direct, over the tailnet — reads only", { b: 4, c: "blue solid" })}
    ${list(
      1080,
      450,
      480,
      [
        ["", "<span class='m'>hermetic logs atlas</span> → hermeticd RPC"],
        ["", "<span class='m'>hermetic ssh atlas</span> → Tailscale SSH"],
        ["", "chat, dashboard, noVNC → Serve :443"],
        [
          "",
          "<span class='m'>agent probe</span> → EC2 + /healthz + dashboard, in parallel, writes nothing",
        ],
      ],
      { b: 4 },
    )}
  `,
  svg: `
    ${wire("M1084 114 L980 160", { b: 1, c: "ok" })}
    ${wire("M356 112 L462 380", { b: 2, c: "acc" })}
    ${wire("M980 380 C 1030 380, 1040 226, 1084 226", { b: 2, c: "vio" })}
    ${wire("M462 170 L356 240", { b: 3, c: "ok" })}
    ${wire("M356 392 L462 406", { b: 3, c: "acc" })}
    ${wire("M462 432 L356 418", { b: 3, c: "ok" })}
    ${wire("M380 560 C 700 660, 900 660, 1060 560", { b: 4, c: "blue" })}
  `,
  beats: [
    {
      c: "How does a laptop steer a box that has no open port? Mostly it doesn't talk to it at all. Both sides meet at the agent's <b>DynamoDB row</b>.",
      r: ["design.md §4.1–4.5"],
    },
    {
      c: "The box writes: every 30 seconds hermeticd records its heartbeat, health checks, metrics, the digest of the binary it's running and its real tailnet name.",
      r: ["packages/agentd/src/heartbeat.ts"],
    },
    {
      c: "The operator writes, too: a <code>command</code> to rerun, an <code>update_request</code> for a rollout, a new config hash to converge. The box notices on its next heartbeat and hands the request to the right loop.",
      r: ["agentd/src/request-gate.ts", "agentd/src/converge.ts", "agentd/src/install-lock.ts"],
    },
    {
      c: "Reads are direct: the CLI scans the table, the app polls it once a minute into an in-memory snapshot. There is no local mirror of cloud state to drift; a stale heartbeat is simply shown as <code>unreachable</code>.",
      r: ["packages/app/src/poller.ts", "packages/core/src/reads.ts"],
    },
    {
      c: "The only direct connections are laptop-initiated reads over the tailnet — logs, SSH, chat, the dashboard — each authorized by the ACL, hermeticd's checked with <code>tailscale whois</code>. Nothing can push into a box.",
      r: ["agents/agent-logs.ts", "agents/probe.ts"],
      seal: "noport",
    },
  ],
});

scene({
  id: "app",
  ch: "Communication",
  title: "Inside the desktop app",
  html: `
    ${zone(20, 30, 480, 600, "webview · views://main · packages/ui", { b: 0, c: "solid" })}
    ${bx(44, 64, 432, 100, "React page", "loaded from the bundle, fonts vendored — fetches nothing at render time. Rules in pure modules, rendering in components/", { b: 0, c: "sm" })}
    ${bx(44, 182, 432, 86, "api/transport-rpc.ts", 'rpc.request("agents.create", params) — typed by HermeticRPC', { b: 1, c: "sm blue" })}
    ${bx(44, 286, 432, 86, "api/streams.ts", "open/close subscription pairs: ops, fleet, chat", { b: 2, c: "sm" })}
    ${bx(44, 400, 432, 210, "noVNC pane", "a separate <span style='color:var(--fg)'>&lt;electrobun-webview&gt;</span>, sandboxed, with <b style='color:var(--fg)'>no RPC bridge</b>, its navigation held to the box's own origin. Never an iframe in the app page — whose navigation is held to views://main/*.", { b: 4, c: "sm acc" })}

    ${bx(540, 230, 200, 150, "Electrobun RPC", "in-process channel<br><b style='color:var(--fg)'>no socket<br>no port<br>no HTTP</b>", { b: 1, c: "sm c blue" })}

    ${zone(780, 30, 800, 600, "main process · packages/app/src", { b: 1, c: "acc solid" })}
    ${bx(804, 64, 360, 110, "handlers/dispatch.ts", "HANDLERS[name] → parseInput(schema) → teardownBlocked → requireTarget", { b: 1, c: "sm" })}
    ${bx(1190, 64, 366, 110, "target.ts", "FLEET_MISMATCH if the request's {account, region, fleet} isn't the fleet being served — checked before the first await", { b: 1, c: "sm" })}
    ${bx(804, 194, 360, 130, "ops.ts · OpRegistry", "long op → answer { op_id } at once; frames carry generation:sequence so a page can reattach after closing the window", { b: 2, c: "sm" })}
    ${bx(1190, 194, 366, 130, "poller.ts · FleetPoller", "Scan every 60 s → snapshot → snapshot / agent / removed events on fleet.subscribe", { b: 3, c: "sm" })}
    ${bx(804, 344, 360, 110, "state.ts · AppState", "initialized ⇄ uninitialized (wizard), fleet switch; read per request, never captured once", { b: 3, c: "sm" })}
    ${bx(1190, 344, 366, 110, "chat-owner.ts", "one upstream subscription, many readers", { b: 3, c: "sm" })}
    ${bx(804, 474, 360, 136, "core (in-process)", "the same Hermetic instance the CLI would use", { b: 1, c: "sm acc" })}
    ${bx(1190, 474, 366, 136, "one operator, one process", "single instance via LaunchServices · close-guard denies quit with an op in flight · resume.ts restarts interrupted ops · ~/.hermetic/app.log", { b: 5, c: "sm" })}
  `,
  svg: `
    ${wire("M476 225 L540 280", { b: 1, c: "blue" })}
    ${wire("M740 300 L804 120", { b: 1, c: "blue" })}
    ${wire("M984 174 L984 194", { b: 2, c: "acc" })}
    ${wire("M984 454 L984 474", { b: 1, c: "acc", start: true })}
    ${wire("M804 260 C 640 400, 600 330, 476 330", { b: 2, c: "ok" })}
    ${wire("M1190 260 C 1100 420, 620 420, 476 345", { b: 3, c: "ok" })}
  `,
  beats: [
    {
      c: "The app is two halves. The page is React in a webview, loaded from a <code>views://</code> bundle with its fonts inside — it fetches nothing from the network to render.",
      r: ["packages/ui/src/", "packages/ui/index.html"],
    },
    {
      c: "It reaches the main process over Electrobun's RPC channel — <b>no socket, no port, no HTTP</b> — so nothing else on the machine can talk to the app. Each request is dispatched, validated, and bound to the fleet it names.",
      r: ["packages/app/src/rpc/bind.ts", "handlers/dispatch.ts", "app/src/target.ts"],
    },
    {
      c: "Long operations run in the main process's op registry and answer with an op id. The page subscribes to the op's frames, and can close the window and reattach later without losing the run.",
      r: ["packages/app/src/ops.ts", "handlers/streams.ts"],
    },
    {
      c: "A poller scans DynamoDB each minute and pushes fleet changes; chat observations are multiplexed onto one upstream subscription. Every stream is an open/close request pair plus tagged pushes.",
      r: ["packages/app/src/poller.ts", "packages/app/src/chat-owner.ts"],
    },
    {
      c: "The live desktop is a separate sandboxed webview with <b>no RPC bridge</b> and navigation pinned to the box's origin — a page from an agent can never call into the app.",
      r: ["packages/app/src/main/navigation.ts", "design.md §3.4"],
      seal: "app",
    },
    {
      c: "And it's single-operator by construction: one process, no listener to share. Quitting with an op in flight is refused natively, interrupted ops resume at next launch, and everything lands in <code>~/.hermetic/app.log</code>.",
      r: ["main/close-guard.ts", "app/src/resume.ts", "app/src/log.ts"],
    },
  ],
});

scene({
  id: "chat",
  ch: "Communication",
  title: "Chat: a pipe to the box, through one door",
  html: `
    ${bx(20, 40, 250, 120, "Chat view / CLI", "atlas/default<br><span class='mono'>&lt;instance&gt;/&lt;bot&gt;</span> — a bot is a Hermes profile", { b: 0, c: "sm" })}
    ${bx(20, 200, 250, 100, "app · chat-owner", "observe-pool: one subscription, many readers", { b: 0, c: "sm" })}
    ${zone(310, 20, 560, 610, "core · packages/core/src/chat", { b: 1, c: "acc solid" })}
    ${bx(334, 54, 512, 92, "chat.ts — the surface", "speaks hermetic's ChatMessage / ChatBlock only · chat-send, chat-gate, chat-fence, chat-observe", { b: 1, c: "sm" })}
    ${bx(334, 166, 512, 120, "chat-seal.ts · chat-redact.ts", "the one door every transcript byte leaves core through: inputs validated without echo, roster + sessions masked, errors sealed on the way out", { b: 3, c: "sm warn" })}
    ${bx(334, 306, 512, 150, "chat/hermes/ — the adapter", "hermes-chat-connect · rpc · turn · history · resume · roster · process-notice …<br><br>the <b style='color:var(--fg)'>only</b> code that knows Hermes's payload shapes; an unknown shape renders as a raw block, never vanishes", { b: 2, c: "sm" })}
    ${bx(334, 476, 512, 136, "nothing stored", "no transcript, no local conversation: the box is authoritative and every read goes to it. Observing is passive — it never creates a session or warms a model.", { b: 4, c: "sm" })}

    ${bx(930, 120, 260, 200, "wss://fxtr0001-atlas…ts.net/api/ws", "JSON-RPC 2.0<br>→ session.create<br>→ prompt.submit<br>← message.delta …<br>← message.complete<br><br>token: the dashboard's own session token", { b: 1, c: "sm blue" })}
    ${bx(930, 360, 260, 120, "GET /api/sessions/&lt;id&gt;/messages", "history, scoped to the bot's profile", { b: 2, c: "sm blue" })}
    ${zone(1240, 20, 340, 610, "agent box", { b: 1, c: "ok solid" })}
    ${bx(1262, 60, 296, 80, "Serve :443 → nginx", "same path the heartbeat probes", { b: 1, c: "xs blue" })}
    ${bx(1262, 160, 296, 100, "hermes dashboard", "the box's own API — hermetic switches nothing on and owns no listener", { b: 1, c: "sm acc" })}
    ${bx(1262, 280, 296, 120, "Hermes agent loop", "tools — including the <b style='color:var(--fg)'>terminal</b>, as the hermes user", { b: 5, c: "sm bad" })}
    ${bx(1262, 420, 296, 190, "background notices", "a finished process or watch match is stored upstream as a user-role row; core recognises it and emits a <b style='color:var(--fg)'>system event</b> — never shown as \"You\"", { b: 4, c: "sm" })}
  `,
  svg: `
    ${wire("M145 160 L145 200", { b: 0, c: "acc" })}
    ${wire("M270 250 L334 100", { b: 1, c: "acc" })}
    ${wire("M590 146 L590 166", { b: 3, c: "warn", start: true })}
    ${wire("M590 286 L590 306", { b: 3, c: "warn", start: true })}
    ${wire("M846 380 L930 220", { b: 1, c: "blue" })}
    ${wire("M846 420 L930 420", { b: 2, c: "blue" })}
    ${wire("M1190 220 L1262 100", { b: 1, c: "blue" })}
    ${wire("M1270 140 L1198 262", { b: 1, c: "ok" })}
    ${wire("M930 262 L852 404", { b: 1, c: "ok" })}
    ${wire("M1410 140 L1410 160", { b: 1, c: "acc" })}
    ${wire("M1410 260 L1410 280", { b: 5, c: "bad" })}
  `,
  beats: [
    {
      c: "Chat addresses a <b>bot</b> — a Hermes profile — on an instance: <code>atlas/default</code>. The app owns the live observations and fans one upstream subscription out to every open view.",
      r: ["packages/app/src/chat-owner.ts", "chat/observe-pool.ts"],
    },
    {
      c: "The transport is the box's <em>own</em> dashboard API over the tailnet: JSON-RPC 2.0 on <code>/api/ws</code> with the dashboard's session token — <code>session.create</code>, <code>prompt.submit</code>, streamed deltas back. hermetic opens nothing new on the box.",
      r: ["chat/hermes/hermes-chat-rpc.ts", "chat/hermes/hermes-chat-turn.ts"],
    },
    {
      c: "Only the adapter under <code>chat/hermes/</code> knows Hermes's shapes. Upstream's dashboard routes are not a stable API, so a Hermes version bump costs one directory, not a UI — and an unrecognised event still renders.",
      r: ["chat/hermes/hermes-chat.ts", "chat/hermes/hermes-chat-blocks.ts"],
    },
    {
      c: "Every transcript byte leaves core through one door — the seal and redaction modules — and errors are masked on the way out, so a provider key echoed in a stack trace never reaches a head.",
      r: ["chat/chat-seal.ts", "chat/chat-redact.ts"],
      seal: "chat",
    },
    {
      c: "hermetic stores no transcript; the box is authoritative. Watching a conversation is a passive read that de-duplicates by upstream's own message ids, and background-process notices become events, never the operator's voice.",
      r: ["chat/chat-observe.ts", "chat/hermes/process-notice.ts"],
    },
    {
      c: "Be clear about the stakes: a chat turn can drive the terminal tool and run commands on the box. The tailnet ACL is the whole authorization boundary for this feature.",
      r: ["design.md §9.2 · §7.2"],
    },
  ],
});
