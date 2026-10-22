/* The Security path — "Trust model & seals", for security reviewers.
 *
 * The trust model in one frame, then all twenty seals in tally order (library scenes, re-narrated
 * as "what it stops, what it doesn't"), then five threat scenarios that put the seals to work, then
 * the seal map and the documented gaps. Every claim is checked against docs/design.md (§1, §4.7,
 * §5.1, §5.2, §6.3–6.4, §7, §8) and the source.
 */
(() => {
  css(`
    .seal.sec-sb { width: 58px; height: 58px; font-size: 8px; }
    .seal.sec-sb > div { gap: 3px; }
    .seal.sec-sb b { width: 34px; height: 28px; font-size: 18px; }
    .list.sec-reach { gap: 5px; }
    .list.sec-reach .li { font-size: 15.5px; }
    .sec-tile { position: absolute; border: 1.5px solid var(--line2); background: var(--bg); padding: 5px 8px;
      font-size: 11.5px; font-weight: 700; line-height: 1.25; color: var(--fg); }
    .sec-tile .n { font-family: var(--mono); color: var(--acc); margin-right: 6px; }
    .sec-row { position: absolute; display: grid; grid-template-columns: 230px 400px 1fr 110px 130px; gap: 14px;
      align-items: center; border-bottom: 1px solid var(--line); padding: 0 6px; }
    .sec-row .a { font-weight: 900; font-size: 16px; color: var(--fg); }
    .sec-row .b { font-family: var(--mono); font-size: 12px; color: var(--fg2); line-height: 1.35; }
    .sec-row .c { font-size: 14px; color: var(--fg2); line-height: 1.35; }
    .sec-row .d { font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: 0.1em; }
    .sec-row .e { position: relative; height: 58px; }
    .sec-row.hd { border-bottom: 1.5px solid var(--fg); font-family: var(--mono); font-size: 11px; font-weight: 700;
      letter-spacing: 0.14em; text-transform: uppercase; color: var(--fg2); }
    .sec-row.hd > div { font: inherit; color: inherit; }
  `);

  glossary({
    "prompt injection":
      "Instructions hidden in content an AI agent reads — a web page, a document, a message — that steer what it does next.",
    AppArmor:
      "A Linux mandatory access control system. On a box, one narrow profile lets the pinned Chrome keep its own sandbox on.",
    "Chrome for Testing":
      "Google's versioned, non-auto-updating Chrome builds. hermetic pins one by digest and mirrors it into the fleet bucket.",
    "blast radius": "Everything an attacker can reach from one foothold.",
    "autogroup:member": {
      d: "Tailscale's name for every person who is a member of the tailnet. Tagged machines are not members.",
      link: false,
    },
  });

  /** A small seal badge, numbered from the security tally. */
  const badge = (x, y, id, o) =>
    sealBadge(x, y, id, o).replace('class="seal pop', 'class="seal sec-sb pop');

  /* ------------------------------------------------------------ the trust model in one frame */
  scene({
    id: "sec-trust",
    title: "The trust model in one frame",
    html: `
      ${zone(20, 30, 470, 440, "trusted", { b: 0, c: "blue solid" })}
      ${bx(44, 60, 422, 124, "operator laptop + AWS profile", "your credentials and your tailnet login — the only principal that creates, destroys, or reads the fleet's own secrets under /hermetic/*", { b: 1, c: "acc", h: "1" })}
      ${bx(44, 202, 422, 110, "the tailnet ACL", "who may reach a box: tag:hermetic on 22 · 443 · 7434 — the whole authorization layer in front of every agent", { b: 1, c: "blue", h: "1" })}
      ${bx(44, 330, 422, 96, "AWS IAM", "the operator holds the account; each box holds one fleet-scoped instance role, nothing more", { b: 1, h: "1" })}
      ${txt(46, 436, 420, "<span style='font-size:13.5px'>and the upstreams: AWS, Tailscale, Ubuntu's archives</span>", { b: 1 })}

      ${zone(530, 30, 520, 440, "the box · the boundary", { b: 0, c: "acc solid" })}
      ${bx(556, 60, 468, 110, "Hermes agent — untrusted", "root by design: passwordless sudo, approvals off, docker group. Whatever steers it owns the instance.", { b: 2, c: "bad", h: "2" })}
      ${tag(556, 188, "web pages", { b: 2, c: "bad" })}
      ${tag(668, 188, "chat messages", { b: 2, c: "bad" })}
      ${tag(812, 188, "documents", { b: 2, c: "bad" })}
      ${tag(556, 226, "model output", { b: 2, c: "bad" })}
      ${tag(698, 226, "installed packages", { b: 2, c: "bad" })}
      ${bx(556, 282, 468, 160, "contained by", "its own instance, kernel, data volume and role binding · zero inbound rules · nftables drop · every service on loopback · a role that can't see /hermetic/* · destroyable in one command", { b: 2, c: "ok" })}

      ${zone(1090, 30, 490, 440, "assets · what an attacker wants", { b: 0, c: "warn solid" })}
      ${list(
        1112,
        62,
        450,
        [
          [
            "warn",
            "<b>Tailscale OAuth client</b> — mints join keys, can edit the whole tailnet policy<br><span class='m'>/hermetic/&lt;fleet&gt;/tailscale/oauth-secret</span>",
          ],
          [
            "warn",
            "<b>Provider API keys</b> — fleet slots, plus a copy per agent<br><span class='m'>/hermetic/&lt;fleet&gt;/secrets/*</span>",
          ],
          ["warn", "<b>Each agent's memory</b> — an encrypted EBS volume: sessions, skills, logins"],
          ["warn", "<b>The AWS account</b> — and every fleet that shares it"],
        ],
        { b: 3, a: "up lg", st: "gap:16px" },
      )}

      ${kick(24, 488, "twenty seals ahead · each names the code or test that enforces it", { b: 4, st: "color:var(--acc)" })}
      ${SEALS.map(
        (s, i) =>
          `<div class="sec-tile up" data-b="4" style="${`left:${24 + (i % 10) * 155}px;top:${512 + Math.floor(i / 10) * 60}px;width:147px;height:52px`}"><span class="n">${String(i + 1).padStart(2, "0")}</span>${s.name}</div>`,
      ).join("")}
    `,
    svg: `
      ${wire("M466 115 L556 115", { b: 1, c: "blue" })}
      ${wire("M556 378 L466 378", { b: 2, c: "ok" })}
    `,
    beats: [
      {
        c: "This path is for whoever has to sign off on hermetic. First the frame: what is trusted, what is not, and what an attacker would be after.",
        r: ["docs/design.md §1", "§5.1", "§7"],
      },
      {
        c: "Trusted: the operator's laptop and AWS profile — the only principal that creates, destroys or reads the fleet's own secrets — the tailnet ACL, which alone decides who reaches a box, and AWS IAM.",
        r: ["design.md §4.7", "§5.2"],
      },
      {
        c: "Not trusted: the agent. Hermes reads web pages and chat and runs commands as root on its box, by design. So the boundary is the instance and everything around it, not a unix user.",
        r: ["design.md §6.4 · root on the box", "§7.1"],
      },
      {
        c: "The assets: the fleet's Tailscale OAuth client, provider API keys, each agent's memory volume, and the AWS account itself.",
        r: ["design.md §5 · §8.1"],
      },
      {
        c: "Twenty seals follow, each a boundary named with the code or test that enforces it — watch the counter, top right. Then five attack scenarios put them to work, and the gaps go on the record.",
        r: ["docs/explainer/engine.js · SEALS"],
      },
    ],
  });

  /* ------------------------------------------------------------ threat scenario template
   * Top row: attacker position → escalation steps. Left: what holds, each with its seal badges and a
   * red probe that dies at the target. Right: what the attacker reaches, then the residual risk.
   */
  function threat(def) {
    const { id, title, who, whoSub, steps, reach, held, residual, beats } = def;
    const n = steps.length;
    const gap = 44;
    const w = Math.floor((1270 - (n - 1) * gap) / n);
    const sx = (i) => 310 + i * (w + gap);
    const lastCx = Math.round(sx(n - 1) + w / 2);
    const top = (i) => 208 + i * 84;
    const heldBeat = def.heldBeat ?? 2;
    const reachBeat = def.reachBeat ?? 1;
    const resBeat = def.resBeat ?? 3;
    const html = `
      ${kick(20, 14, "attacker position", { b: 0, st: "color:var(--bad)" })}
      ${bx(20, 40, 250, 110, who, whoSub, { b: 0, c: "bad" })}
      ${steps.map((s, i) => bx(sx(i), 40, w, 110, s.t, s.s, { b: s.b ?? 0, c: s.c || "" })).join("")}

      ${zone(20, 186, 990, 444, "what holds — and which seal holds it", { b: heldBeat, c: "ok solid" })}
      ${held
        .map(
          (h, i) =>
            `${h.seals.map((sid, j) => badge(44 + j * 66, top(i) + 6, sid, { b: heldBeat })).join("")}${bx(
              250,
              top(i),
              708,
              70,
              `✕ ${h.t}`,
              h.s,
              { b: heldBeat, c: "sm bad hatch" },
            )}`,
        )
        .join("")}

      ${zone(1050, 186, 530, 196, "what they reach", { b: reachBeat, c: "bad solid" })}
      ${list(
        1070,
        210,
        494,
        reach.map((r) => ["bad", r]),
        { b: reachBeat, a: "up sec-reach" },
      )}
      ${zone(1050, 406, 530, 224, "residual risk", { b: resBeat, c: "warn solid" })}
      ${txt(1070, 430, 494, residual, { b: resBeat, st: "font-size:16px;line-height:1.45" })}
    `;
    const svg = `
      ${steps
        .map((s, i) =>
          wire(`M${i === 0 ? 270 : sx(i - 1) + w} 95 L${sx(i)} 95`, { b: s.b ?? 0, c: "bad" }),
        )
        .join("")}
      ${wire(`M${lastCx} 150 L${lastCx} 186`, { b: reachBeat, c: "bad" })}
      ${held
        .map((_, i) => {
          const d = `M${lastCx} 150 L${lastCx} 168 L1030 168 L1030 ${top(i) + 35} L960 ${top(i) + 35}`;
          return `${wire(d, { b: heldBeat, c: "bad", end: false, w: "thin", flow: false })}${pk(d, { b: heldBeat, c: "bad", dur: 2600, ph: i * 0.17 })}`;
        })
        .join("")}
    `;
    scene({ id, title, html, svg, beats });
  }

  threat({
    id: "sec-box",
    title: "Threat 1 · a compromised agent",
    who: "prompt injection",
    whoSub: "a page, a document or a chat message the agent reads",
    steps: [
      { t: "terminal tool", s: "Hermes runs commands as the <span class='m'>hermes</span> user" },
      { t: "root on the box", s: "passwordless sudo, approvals off — by design", c: "warn" },
      { t: "IMDS", s: "169.254.169.254 hands any local process the fleet role's credentials", b: 1 },
    ],
    reach: [
      "fleet-mates' SSM slots — their provider keys",
      "fleet-mates' rows in DynamoDB — read and write",
      "every agent's rendered config under <span class='m'>config/*</span>",
      "the Bedrock models the stack names",
      "this box: its key, its memory, its browser logins",
    ],
    held: [
      {
        t: "/hermetic/&lt;fleet&gt;/*",
        s: "the Tailscale OAuth client and shared provider keys are never granted to a box",
        seals: ["iam"],
      },
      {
        t: "another fleet",
        s: "slots, tables and bucket are fleet-named; the role reaches only its own",
        seals: ["named", "iam"],
      },
      {
        t: "launch, stop or write anything",
        s: "no RunInstances or any EC2 mutation, no PutParameter, no Scan",
        seals: ["iam"],
      },
      {
        t: "the other boxes",
        s: "a tagged node isn't a member: hermetic's ACL admits it nowhere, hermeticd's RPC refuses it",
        seals: ["tailnet", "noport"],
      },
      {
        t: "other agents' memory",
        s: "each volume is attached to its own instance; the role holds no EC2 or EBS actions at all",
        seals: ["instance", "iam"],
      },
    ],
    residual:
      "The blast radius is the <b>fleet</b>, not the agent — stated in design.md §5.1. Rotate fleet-mates' provider keys. A recreate replaces the root disk but keeps <span class='mono'>/data</span>, where skills and cron jobs live, so inspect or discard it. The named fix — a role per agent, IMDS reachable only by hermeticd — is future work.",
    beats: [
      {
        c: "Scenario one: an agent is talked into it — <b>prompt injection</b> from a page, a document or a chat message. Its terminal tool runs commands, and with passwordless sudo, as root. Assume the attacker owns the box.",
        r: ["design.md §6.4 · root on the box"],
      },
      {
        c: "Root reaches IMDS and mints the fleet role's credentials. That reads fleet-mates' SSM slots — their provider keys — reads and writes their rows, reads every agent's config, and calls the fleet's Bedrock models.",
        r: ["design.md §5.1", "aws/cfn-template.ts · FleetRows"],
      },
      {
        c: "What stops it going further: the role never sees <code>/hermetic/*</code> or another fleet, and can't launch, stop or write anything in EC2 or SSM. Nothing hermetic writes into the ACL lets one box reach another.",
        r: ["design.md §5.1 · §8.3", "packages/agentd/src/rpc.ts · rpcAccess"],
      },
      {
        c: "Residual, on the record: the blast radius is the fleet. Rotate the exposed keys; a recreate keeps <code>/data</code>, so inspect it. The planned fix is a role per agent and IMDS reachable only by hermeticd.",
        r: ["design.md §5.1 · Why not ABAC"],
      },
    ],
  });

  threat({
    id: "sec-laptop",
    title: "Threat 2 · the operator's laptop or credentials",
    who: "the operator's side",
    whoSub: "a stolen laptop, malware running as you — or just the wrong AWS profile",
    steps: [
      { t: "your AWS profile", s: "the frozen profile in ~/.aws: operator rights in the account" },
      { t: "your tailnet login", s: "an autogroup:member device: 22 · 443 · 7434 on every box", b: 1 },
    ],
    reach: [
      "<span class='m'>/hermetic/*</span> — the OAuth client and shared provider keys",
      "create, destroy, teardown — any fleet in the account",
      "the fleet bucket: what every box will run next",
      "Tailscale SSH as root on every box",
    ],
    held: [
      {
        t: "the wrong account",
        s: "STS checks the frozen account before the first call: ACCOUNT_MISMATCH",
        seals: ["account"],
      },
      {
        t: "the wrong fleet",
        s: "{account_id, region, fleet_id} on every mutation and plan: FLEET_MISMATCH",
        seals: ["triple"],
      },
      {
        t: "a one-keystroke teardown",
        s: "plan → confirm; the twelve-digit account id typed out, not --yes alone",
        seals: ["plan"],
      },
      {
        t: "secrets at rest on the laptop",
        s: "none in hermetic.db, logs or flags — keys live in SSM and pass through memory",
        seals: ["secrets"],
      },
      {
        t: "a local port into the app",
        s: "Electrobun RPC is in-process: no socket, no port, no HTTP",
        seals: ["app"],
      },
    ],
    residual:
      "Guards against <b>mistakes</b> are not locks against an <b>adversary</b>: whoever holds operator credentials can call AWS directly. Treat the AWS profile and tailnet login as fleet-admin credentials. A leaked OAuth client is rotated with <span class='mono'>hermetic secrets push _fleet --tailscale-oauth</span>.",
    beats: [
      {
        c: "Scenario two: the operator's side. The laptop holds an AWS profile and a tailnet login, and hermetic's guards are built first against <em>mistakes</em> — the wrong profile, the wrong fleet, a reflexive <code>y</code>.",
        r: ["design.md §4.7"],
      },
      {
        c: "An adversary holding those credentials is another matter: they can read <code>/hermetic/*</code>, destroy agents and volumes, rewrite the bucket the boxes trust, and SSH to every box as root.",
        r: ["design.md §5 · §5.2", "fleet/policy.ts · ssh users"],
      },
      {
        c: "What still holds: the guards stop a wrong account or fleet, typed confirmations stop a slip, the laptop keeps no secret at rest, and the app has no port for other software to talk to.",
        r: ["aws/client.ts", "app/src/target.ts", "secrets-leak.test.ts"],
      },
      {
        c: "Residual: an operator credential <em>is</em> the fleet. Protect the AWS profile and tailnet login accordingly; a leaked OAuth client is rotated with <code>secrets push _fleet --tailscale-oauth</code>.",
        r: ["design.md §8.2"],
      },
    ],
  });

  threat({
    id: "sec-web",
    title: "Threat 3 · a hostile web page",
    who: "a hostile page",
    whoSub: "anything the agent browses to, or is sent to",
    steps: [
      {
        t: "Chrome renderer",
        s: "pinned Chrome for Testing, sandboxed, running as <span class='m'>hermes</span>",
      },
      {
        t: "the agent's context",
        s: "page text is model input — it can steer the next tool call",
        c: "warn",
        b: 1,
      },
    ],
    reach: [
      "the agent's next tool call — and so scenario one",
      "live logins in this agent's browser profile",
      "after a sandbox escape: the <span class='m'>hermes</span> account, one sudo from root",
    ],
    held: [
      {
        t: "CDP from the page",
        s: "the debugging port binds 127.0.0.1:9222 — never published, never a Serve route",
        seals: ["loopback", "browser"],
      },
      {
        t: "an unsandboxed renderer",
        s: "a narrow AppArmor profile keeps Chrome's sandbox on — never --no-sandbox",
        seals: ["browser"],
      },
      {
        t: "a root browser",
        s: "Xvfb, the window manager, x11vnc, noVNC and Chrome all run as hermes",
        seals: ["browser"],
      },
      {
        t: "a swapped browser build",
        s: "Chrome for Testing mirrored into the bucket, checked by digest and size",
        seals: ["supply"],
      },
      {
        t: "your desktop app",
        s: "the noVNC pane is a sandboxed webview with no RPC bridge, held to the box's origin",
        seals: ["app"],
      },
    ],
    residual:
      "The page can't break out easily, but it can still <b>talk to the agent</b> — and the agent is root. Prompt injection is not a browser bug and no seal here stops it; it leads to scenario one. Logins share one profile per agent: identities that must not meet belong on separate agents.",
    beats: [
      {
        c: "Scenario three: the agent browses to a hostile page. There are two ways in — exploit the browser, or talk to the agent through what the page says.",
        r: ["design.md §7.3"],
      },
      {
        c: "An exploit lands in a sandboxed renderer running as <code>hermes</code>. Page text, meanwhile, is model input: it can steer the agent's next tool call, and the profile holds live logins.",
        r: ["render/render-browser.ts"],
      },
      {
        c: "What holds: the sandbox stays on via a narrow AppArmor profile, CDP never leaves loopback, the build is digest-pinned, and the noVNC pane in your app has no bridge back into it.",
        r: ["/etc/apparmor.d/hermetic-chrome", "packages/app/src/main/navigation.ts"],
      },
      {
        c: "Residual: the page can still steer the agent, and the agent is root, so prompt injection leads straight to scenario one. Keep identities that must not meet on separate agents.",
        r: ["design.md §7.3 · one browser per agent"],
      },
    ],
  });

  threat({
    id: "sec-insider",
    title: "Threat 4 · someone on your tailnet",
    who: "a tailnet member",
    whoSub: "a teammate, a contractor, or a compromised device of theirs",
    steps: [
      {
        t: "hermetic's ACL rule",
        s: "autogroup:member → tag:hermetic on 22 · 443 · 7434, every box on this tailnet, every fleet",
      },
      {
        t: "the box",
        s: "dashboard (no login) · chat · /vnc · Tailscale SSH as root · logs",
        c: "warn",
        b: 1,
      },
    ],
    reach: [
      "dashboard and chat: drive the agent, terminal included",
      "<span class='m'>/vnc</span>: the live browser and its logins",
      "SSH as root → IMDS → the fleet role (scenario one)",
      "hermeticd's logs and health on 7434",
    ],
    held: [
      {
        t: "anyone off the tailnet",
        s: "zero inbound rules at the VPC edge, nftables drop on the box",
        seals: ["sg", "nft"],
      },
      {
        t: "raw ports on the tailnet IP",
        s: "every service binds 127.0.0.1 — only Serve, SSH and the RPC answer",
        seals: ["loopback"],
      },
      {
        t: "tagged devices, other boxes included",
        s: "not members: hermetic's ACL admits none, and the RPC refuses any tagged caller",
        seals: ["tailnet"],
      },
      {
        t: "changing a box over RPC",
        s: "7434 serves logs and health only; commands ride the DynamoDB row",
        seals: ["noport"],
      },
      {
        t: "operator rights in AWS",
        s: "no /hermetic/*, no create or destroy without the operator's AWS credentials",
        seals: ["iam"],
      },
    ],
    residual:
      "The ACL is the whole authorization, and it is coarse: every member, every box — and Hermes's local mode records no per-user identity. To narrow it, use <span class='mono'>--skip-policy</span> and write your own rules; hand edits inside the markers are drift the next apply overwrites.",
    beats: [
      {
        c: "Scenario four: a person — or a compromised device — already on your tailnet. hermetic's rule admits <b>every member</b> to every <code>tag:hermetic</code> box, across all fleets sharing the tailnet.",
        r: ["packages/core/src/fleet/policy.ts", "design.md §5.2"],
      },
      {
        c: "That reaches a lot: the dashboard with no login, chat that drives the terminal, the live browser, and Tailscale SSH as root — and from root, the fleet role.",
        r: ["design.md §5.2 · the 443 entry", "§7.4"],
      },
      {
        c: "What holds: nobody off the tailnet reaches a socket, tagged devices — other boxes included — are refused, and hermeticd's RPC can't change anything.",
        r: ["packages/agentd/src/rpc.ts"],
      },
      {
        c: "Residual: the ACL is the authorization, with no per-user identity behind it. To narrow it, use <code>--skip-policy</code> and write your own rules — edits inside the markers are overwritten.",
        r: ["design.md §5.2 · trade-off"],
      },
    ],
  });

  /* ------------------------------------------------------------ supply chain: every input a box runs */
  const SUPPLY = [
    [
      "hermeticd + stages",
      "fleet bucket · built from a committed tree · presigned 1 h URL",
      "sha256 per file, generation digest, manifest written last, MANIFEST_REFUSED",
      "ok",
      ["supply"],
      1,
    ],
    [
      "Hermes",
      "single-commit bundle at hermes_ref, mirrored to the bucket",
      "bundle digest; the provenance marker makes <span class='mono'>hermes update</span> refuse",
      "ok",
      ["pin"],
      1,
    ],
    [
      "Chrome for Testing",
      "zip at chrome_ref, mirrored to the bucket",
      "digest and byte size, unpacked to /opt/hermetic/chrome/",
      "ok",
      ["supply", "browser"],
      1,
    ],
    [
      "Tailscale",
      "pkgs.tailscale.com apt repository",
      "auto-update on: no version pin, no staged rollout — it is also the only way in",
      "warn",
      [],
      2,
    ],
    [
      "Ubuntu + Docker packages",
      "public apt repositories over open egress",
      "apt's own repository signatures; trusted upstream",
      "warn",
      [],
      2,
    ],
    [
      "Python + npm packages",
      "public package indexes, installed at boot",
      "outside hermetic's dependency audit, which covers bun.lock only",
      "warn",
      [],
      2,
    ],
    [
      "Hermetic.app",
      "GitHub Release: the DMG, or an update the app downloads",
      "Developer ID and notarised; an update installs only if its signature verifies",
      "ok",
      [],
      1,
    ],
  ];
  scene({
    id: "sec-supply",
    title: "Threat 5 · the supply chain",
    html: `
      ${kick(20, 12, "every input a box (or a laptop) runs — and what checks it", { b: 0, st: "color:var(--bad)" })}
      <div class="sec-row hd up" data-b="0" style="left:20px;top:34px;width:1560px;height:30px">
        <div>input</div><div>arrives from</div><div>checked by</div><div>status</div><div>seal</div>
      </div>
      ${SUPPLY.map(
        ([a, b, c, cls, seals, beat], i) => `
        <div class="sec-row up" data-b="${beat}" data-h="${beat}" style="left:20px;top:${70 + i * 68}px;width:1560px;height:66px">
          <div class="a">${a}</div><div class="b">${b}</div><div class="c">${c}</div>
          <div class="d" style="color:var(--${cls})">${cls === "ok" ? "PINNED" : i === 4 ? "UPSTREAM" : "OPEN"}</div>
          <div class="e">${seals.map((s, j) => badge(j * 66, 4, s, { b: beat })).join("")}</div>
        </div>`,
      ).join("")}
      ${zone(20, 562, 1560, 68, "the root of trust", { b: 3, c: "warn solid" })}
      ${txt(44, 576, 1510, "Digests prove a box got exactly what the manifest names — not who wrote the manifest, which is unsigned. The <b>fleet bucket</b> is the root of trust: its policy admits the VPC endpoint and the operator, and anyone writing it with operator credentials decides what every box runs next.", { b: 3, st: "font-size:15.5px" })}
    `,
    beats: [
      {
        c: "Scenario five: the supply chain. Everything a box runs arrives from somewhere, and the attacker's move is to tamper with the source, a mirror, or the bucket.",
        r: ["design.md §1 · §3.6"],
      },
      {
        c: "hermetic's own code, Hermes and Chrome are pinned: content-addressed in the fleet bucket, verified on the box, and a manifest naming objects outside its release is refused. The app on your laptop installs an update only after its signature verifies against the release key compiled into it.",
        r: [
          "release/artifacts-manifest.ts",
          "release/hermes-mirror.ts",
          "release/browser-mirror.ts",
          "release/app-update-signature.ts",
        ],
      },
      {
        c: "The rest is ordinary trust: Tailscale auto-updates with no pin, and the apt, Python and npm packages a box installs come from public sources outside the dependency audit.",
        r: ["design.md §6.3 · Tailscale keeps itself current", "§11 · audit"],
      },
      {
        c: "And digests aren't signatures: the bucket is the root of trust. Whoever can write it with operator credentials — scenario two — decides what every box runs next.",
        r: ["design.md §5 · bucket policy"],
      },
    ],
  });

  /* ------------------------------------------------------------ the path */
  pathway({
    id: "security",
    title: "Trust model & seals",
    audience: "Security reviewers",
    level: 4,
    minutes: 16,
    color: "var(--warn)",
    tagline: "Trust boundaries, twenty containment seals, five attacks, and the gaps on the record.",
    learn: [
      "Who and what hermetic trusts, and why the instance is the boundary",
      "All twenty seals: what each stops and what it doesn't",
      "Five attacker positions, traced to the seals that hold and the risk that remains",
    ],
    next: ["deploy", "contrib"],
    tally: { label: "SEALS", unit: "SEAL", items: SEALS },
    outro:
      "Twenty seals, each enforced by code or a test, around an agent trusted with root. The largest gaps — a fleet-wide role, a coarse ACL — are documented in design.md, with their fixes named.",
    chapters: [
      { name: "Trust model", items: ["sec-trust"] },
      { name: "Code & laptop", items: ["packages", "guard"] },
      { name: "AWS", items: ["foundation", "iam"] },
      { name: "Tailnet & releases", items: ["tailnet", "release"] },
      { name: "The box", items: ["netpath", "inside", "browser", "secrets"] },
      { name: "Control & heads", items: ["control", "app", "chat"] },
      { name: "Safety rails", items: ["state", "plan", "lab"] },
      { name: "Threats", items: ["sec-box", "sec-laptop", "sec-web", "sec-insider", "sec-supply"] },
      { name: "Verdict", items: ["sealmap", "gaps"] },
    ],
    overrides: {
      packages: {
        beats: [
          {
            c: "Seal one lives in the source tree. Five packages, and the import matrix between them is enforced, not advised.",
            r: ["AGENTS.md · Import boundaries"],
          },
          {
            c: "The CLI and the app import core in-process. No daemon or local socket sits between a head and the SDK for other software to reach.",
            r: ["packages/cli/src/program.ts", "packages/app/src/main/index.ts"],
          },
          {
            c: "The UI may not import core at all — only the browser-safe <code>core/shared</code>. Nothing that renders can call AWS; every request crosses validated RPC.",
            r: ["packages/core/src/shared/"],
          },
          {
            c: "Neither head can import the other, so no capability hides in just one of them.",
            r: ["tests/parity.test.ts"],
          },
          {
            c: "What it stops: hermeticd, on every box, imports only schemas and shared values. Create, destroy and the AWS command layer are not in its binary — root on a box finds no fleet tooling there.",
            r: ["packages/agentd/src/", "design.md §3.1"],
            seal: "boundaries",
          },
          {
            c: "What it doesn't: it is a build-time rule about code, not a runtime wall. <code>tests/boundaries.test.ts</code> resolves every import to one cell, with no exceptions.",
            r: ["tests/boundaries.test.ts"],
          },
        ],
      },
      guard: {
        beats: [
          {
            c: "<code>init</code> freezes one AWS account per hermetic home, confirmed by typing all twelve digits — not <code>y</code>.",
            r: ["design.md §4.7"],
          },
          {
            c: "Every AWS client core builds comes from <code>aws.client()</code> with the frozen profile. <code>AWS_PROFILE</code> and environment credentials are ignored.",
            r: ["packages/core/src/aws/client.ts"],
          },
          {
            c: "Seal two: the first call in each process asks STS whose credentials these are. A switched SSO session or an edited profile can't reach the wrong account.",
            r: ["aws/client.ts · verify()"],
            seal: "account",
          },
          {
            c: "It fails closed — <code>ACCOUNT_MISMATCH</code>, nothing sent. What it doesn't stop: someone holding the <em>right</em> credentials. It guards against mistakes, not adversaries.",
            r: ['HermeticError("ACCOUNT_MISMATCH")'],
          },
          {
            c: "A client built any other way lacks the guard symbol, and the low-level helpers refuse it with <code>INTERNAL</code>.",
            r: ["aws/client.ts · guardClient"],
          },
          {
            c: "Seal three: every mutation and plan names the triple <code>{account_id, region, fleet_id}</code>, so a command meant for one fleet can't land on another in the same account.",
            r: ["packages/app/src/target.ts", "design.md §4.4"],
            seal: "triple",
          },
        ],
      },
      foundation: {
        beats: [
          {
            c: "The foundation is one CloudFormation stack per fleet, from a small template compiled into the binary — the inbound boundary is auditable in one read.",
            r: ["design.md §5"],
          },
          {
            c: "Seal four: everything is named and tagged for its fleet, and every lookup filters on <code>hermetic:fleet_id</code>. Two fleets in one account can't see, block or tear down each other.",
            r: ["schema/fleet.ts · cloudName()", "design.md §5"],
            seal: "named",
          },
          {
            c: "A dedicated VPC; S3 and DynamoDB traffic stays on AWS's network through gateway endpoints.",
            r: ["foundation template"],
          },
          {
            c: "Seal five: the agents' security group has <b>zero inbound rules</b>. <code>agent create</code> refuses to run if one appears and <code>doctor</code> checks. A port scan reaches no socket.",
            r: ["fleet/doctor.ts", "design.md §7.2"],
            seal: "sg",
          },
          {
            c: "What it doesn't stop: egress. Outbound is open on purpose — agents browse, search and call models — so exfiltration is not blocked at the network.",
            r: ["design.md §7.2 · egress model"],
          },
          {
            c: "Daily snapshots select volumes by role <em>and</em> fleet, so one fleet's policy never touches another's disks.",
            r: ["design.md §5 · DLM"],
          },
        ],
      },
      iam: {
        beats: [
          {
            c: "A box's whole reach into AWS is one instance role, shared by every agent in the fleet.",
            r: ["design.md §5.1"],
          },
          {
            c: "It reads SSM only under <code>/hermes/&lt;fleet_id&gt;/*</code>, and decrypts only through SSM, so the KMS grant adds nothing.",
            r: ["kms:ViaService condition"],
          },
          {
            c: "Rows by key in the fleet's two tables (no <code>Scan</code>), its bucket's config and artifacts, and the Bedrock models the stack names.",
            r: ["aws/cfn-template.ts"],
          },
          {
            c: "Seal six — what it stops: a box never reads <code>/hermetic/*</code>, where the OAuth client and shared keys live, never touches another fleet, never launches an instance or writes a parameter.",
            r: ["design.md §8.3"],
            seal: "iam",
          },
          {
            c: "Since foundation v12 the SSM agent's permissions are inline. AWS's managed policy allowed <code>GetParameter</code> on every parameter, quietly undoing the rest.",
            r: ["FOUNDATION_VERSION 12"],
          },
          {
            c: "What it doesn't: the role is fleet-wide and IMDS answers any process on the box, so one compromised agent reads its fleet-mates' slots and rows. Documented; a role per agent is future work.",
            r: ["design.md §5.1 · Why not ABAC"],
          },
        ],
      },
      tailnet: {
        beats: [
          {
            c: "Each box joins as <code>tag:hermetic</code> with a key minted for it alone: single-use, one hour, pre-authorised.",
            r: ["design.md §6.2"],
          },
          {
            c: "Who may reach a tagged node is three entries in your tailnet policy, written between <code>// hermetic:managed</code> markers.",
            r: ["packages/core/src/fleet/policy.ts"],
          },
          {
            c: "They admit tailnet members to three ports — 22 for Tailscale SSH, 443 for Serve, 7434 for hermeticd's read-only RPC. The internet gets nothing.",
            r: ["packages/agentd/src/rpc.ts"],
          },
          {
            c: "The policy file stays yours: hermetic splices bytes between its markers and never re-serializes the rest.",
            r: ["packages/core/src/fleet/hujson.ts"],
          },
          {
            c: "Seal seven: every write is validated by Tailscale's own tests, sent with <code>If-Match</code> so a concurrent edit becomes <code>CONFLICT</code>, and logged by ETag, never by content.",
            r: ["policy.ts · applyManagedBlocks", "policy-scope.ts"],
            seal: "tailnet",
          },
          {
            c: "What it doesn't: the OAuth client's <code>policy_file</code> scope is tailnet-wide, and 443 grants dashboard and browser together. The ACL is the only authorization.",
            r: ["design.md §5.2 · trade-off"],
          },
        ],
      },
      release: {
        beats: [
          {
            c: "hermetic's own code never passes through a package manager. Releases go straight into the fleet bucket, only from a committed tree.",
            r: ["release/artifacts.ts", "release/git.ts"],
          },
          {
            c: "A release is an immutable generation named by the digest of its files, marked complete only after every upload is confirmed.",
            r: ["release/artifacts-release.ts"],
          },
          {
            c: "Seal eight: the manifest goes last, naming every key with its sha256. One pointing outside its release is <code>MANIFEST_REFUSED</code> — no box can be handed another agent's config as its binary.",
            r: ["release/artifacts-manifest.ts", "agentd/src/fleet.ts"],
            seal: "supply",
          },
          {
            c: "Hermes and Chrome are mirrored into the bucket at pinned refs and verified, so a box installs with GitHub down.",
            r: ["release/hermes-mirror.ts", "release/browser-mirror.ts"],
          },
          {
            c: "On the box every download is checked against a digest, and self-update compares bytes, never version labels.",
            r: ["packages/agentd/src/update/"],
          },
          {
            c: "Seal nine: Hermes is a pin. A provenance marker makes upstream's own updater refuse, dashboard button included. Digests aren't signatures, though — the bucket is the trust root.",
            r: ["agentd/src/apply/hermes.ts", "design.md §6.4"],
            seal: "pin",
          },
        ],
      },
      netpath: {
        beats: [
          {
            c: "Follow a packet in. Two stateful default-deny walls stand between the internet and any socket.",
            r: ["design.md §7.2"],
          },
          {
            c: "The security group — seal five — drops it first.",
            r: ["foundation · agent security group"],
          },
          {
            c: "Seal ten: on the box, nftables drops everything but loopback and <code>tailscale0</code>. Put the box in the wrong subnet and it is still sealed.",
            r: ["packages/core/src/render/render-system.ts"],
            seal: "nft",
          },
          {
            c: "Your request arrives over WireGuard; Tailscale Serve terminates TLS for the box's MagicDNS name.",
            r: ["design.md §7.4"],
          },
          {
            c: "Serve hands off to nginx on loopback. hermetic owns the whole <code>nginx.conf</code>, so no default site ever listens on <code>0.0.0.0</code>.",
            r: ["render · nginx.conf"],
          },
          {
            c: "Seal eleven: everything else binds 127.0.0.1 — CDP, VNC, the dashboard — and a test fails the build otherwise. The one tailnet listener is hermeticd's read-only RPC.",
            r: ["render-network-invariants.test.ts", "packages/agentd/src/rpc.ts"],
            seal: "loopback",
          },
        ],
      },
      inside: {
        beats: [
          {
            c: "Inside: a replaceable root disk with the OS and pinned code, and <code>/data</code>, the agent's memory, which survives.",
            r: ["design.md §7.1"],
          },
          {
            c: "hermeticd runs as root; a small unit writes secrets to RAM before Hermes may start.",
            r: ["packages/agentd/src/daemon.ts"],
          },
          {
            c: "Hermes runs as the unprivileged <code>hermes</code> user — but read on.",
            r: ["render/render-units.ts"],
          },
          {
            c: "Managed config in <code>/etc/hermes</code> wins per key. Secrets and code never live on <code>/data</code>.",
            r: ["render/render-hermes.ts"],
          },
          {
            c: "Seal twelve: the agent has passwordless root and approvals off, by design — it is in the <code>docker</code> group anyway. The wall is the instance: one agent, one kernel, one volume, one role binding.",
            r: ["design.md §6.4 · root on the box"],
            seal: "instance",
          },
          {
            c: "So model a compromised agent as root on its box. What contains it is everything outside: the role's limits, the network walls, the tailnet ACL.",
            r: ["design.md §7.1"],
          },
        ],
      },
      browser: {
        beats: [
          {
            c: "Every agent runs one pinned Chrome for Testing on a virtual display — the component most exposed to hostile content.",
            r: ["design.md §7.3"],
          },
          {
            c: "Hermes attaches over CDP on loopback; it never launches a browser of its own.",
            r: ["/etc/hermes/config.yaml · browser.cdp_url"],
          },
          {
            c: "You watch and drive the same window through noVNC over Serve — and so can anyone the ACL admits to 443.",
            r: ["design.md §5.2 · the 443 entry"],
          },
          {
            c: "Seal thirteen: Chrome runs as <code>hermes</code> with its sandbox kept on by a narrow AppArmor profile — never <code>--no-sandbox</code> — CDP on loopback, no snap. An exploit must still escape the sandbox.",
            r: ["/etc/apparmor.d/hermetic-chrome", "render/render-browser.ts"],
            seal: "browser",
          },
        ],
      },
      secrets: {
        beats: [
          {
            c: "A provider key is typed once, on stdin, into a fleet slot under <code>/hermetic/</code> that no box can read.",
            r: ["design.md §8.1"],
          },
          {
            c: "The laptop, with operator credentials, copies it into each agent's own slot, named by profile and revision.",
            r: ["profiles/profile-apply.ts"],
          },
          {
            c: "On the box, hermeticd reads its own slot with the instance role. Hermes's config names only the variable.",
            r: ["agentd/src/apply/secrets.ts"],
          },
          {
            c: "The value lands in a tmpfs file, 0600, root-owned, that both Hermes units require. It never touches <code>/data</code>.",
            r: ["hermetic-secrets.service"],
          },
          {
            c: "Seal fourteen: never in git, user-data, SQLite, logs or a CLI flag, and a leak test greps captured output. What it doesn't stop: root on the box reads its own key — the agent needs it to work.",
            r: ["packages/core/test/secrets-leak.test.ts"],
            seal: "secrets",
          },
          {
            c: "On Bedrock there is no key at all: the role is the credential. The Tailscale join key is single-use and spent at boot.",
            r: ["design.md §1 · zero-secret minimal path"],
          },
        ],
      },
      control: {
        beats: [
          {
            c: "How does a laptop steer a box with no open port? Both sides meet at the agent's DynamoDB row.",
            r: ["design.md §4.1–4.5"],
          },
          {
            c: "The box writes its heartbeat, health, and the digest of the binary it runs.",
            r: ["packages/agentd/src/heartbeat.ts"],
          },
          {
            c: "Operators write requests — rerun, update, a new config hash — and the box acts on its next heartbeat.",
            r: ["agentd/src/request-gate.ts"],
          },
          {
            c: "Reads go straight to DynamoDB; there is no local mirror to drift.",
            r: ["packages/app/src/poller.ts"],
          },
          {
            c: "Seal fifteen: there is no control port to attack. hermeticd's one listener serves logs and health, to tailnet members only. The flip side: the shared role can write fleet-mates' rows.",
            r: ["packages/agentd/src/rpc.ts", "design.md §5.1"],
            seal: "noport",
          },
        ],
      },
      app: {
        beats: [
          {
            c: "The desktop app's page is a bundled webview that fetches nothing from the network to render.",
            r: ["packages/ui/src/"],
          },
          {
            c: "It talks to the main process over in-process RPC — no socket, no port — validated and bound to the fleet it names.",
            r: ["packages/app/src/rpc/bind.ts", "app/src/target.ts"],
          },
          {
            c: "Long operations run in the main process and survive a closed window.",
            r: ["packages/app/src/ops.ts"],
          },
          {
            c: "A poller reads the fleet once a minute; chat shares one upstream subscription.",
            r: ["packages/app/src/poller.ts"],
          },
          {
            c: "Seal sixteen: the live desktop is a separate sandboxed webview with no RPC bridge, held to the box's origin. A hostile page on an agent can't call into your app.",
            r: ["packages/app/src/main/navigation.ts", "design.md §3.4"],
            seal: "app",
          },
          {
            c: "Nothing else on the laptop can talk to the app, and the app replaces itself only with an update whose signature verifies against the release key built into it.",
            r: ["design.md §3.6"],
          },
        ],
      },
      chat: {
        beats: [
          {
            c: "Chat addresses a bot on a box, through the app's one upstream subscription.",
            r: ["packages/app/src/chat-owner.ts"],
          },
          {
            c: "It rides the box's own dashboard API over the tailnet. hermetic opens nothing new on the box.",
            r: ["chat/hermes/hermes-chat-rpc.ts"],
          },
          {
            c: "Only one adapter directory knows Hermes's payload shapes.",
            r: ["chat/hermes/"],
          },
          {
            c: "Seal seventeen: every transcript byte leaves core through one seal-and-redact door, and errors are masked, so a key echoed in a stack trace never reaches a head.",
            r: ["chat/chat-seal.ts", "chat/chat-redact.ts"],
            seal: "chat",
          },
          {
            c: "No transcript is stored on the laptop; background notices become events, never the operator's voice.",
            r: ["chat/hermes/process-notice.ts"],
          },
          {
            c: "The stakes: a chat turn can drive the terminal tool, and through sudo, root. Anyone the ACL admits to 443 holds that power.",
            r: ["design.md §9.2"],
          },
        ],
      },
      state: {
        beats: [
          {
            c: "One state machine per agent: the box writes its own transitions, operators write the rest.",
            r: ["design.md §4.3"],
          },
          {
            c: "Every write is conditional on the row's version, so a stale writer can't move a destroying agent back to ready.",
            r: ["design.md §4.5"],
          },
          {
            c: "Long operations take TTL locks — per agent, fleet and volume — that expire if a laptop dies.",
            r: ["packages/core/src/fleet/fleet-lock.ts"],
          },
          {
            c: "Seal eighteen: teardown holds the fleet lock from first check to last delete, so nothing created elsewhere is swept up mid-run.",
            r: ["packages/core/src/fleet/teardown.ts"],
            seal: "cas",
          },
          {
            c: "And every event records the caller's STS ARN — an audit trail without a server.",
            r: ["design.md §4.4"],
          },
        ],
      },
      plan: {
        beats: [
          {
            c: "Destructive work is a plan first: every step, the warnings and the exact fleet — changing nothing.",
            r: ["packages/core/src/agents/plans.ts"],
          },
          {
            c: "The head confirms: a CLI prompt, or the app's typed name.",
            r: ["packages/cli/src/confirm.ts"],
          },
          {
            c: "<code>apply</code> runs only what was reviewed, only against that fleet.",
            r: ["packages/core/src/agents/plan-apply.ts"],
          },
          {
            c: "Seal nineteen: teardown wants the account id typed out and refuses while any agent exists. It stops a slip — not someone with operator credentials, who can call AWS directly.",
            r: ["packages/core/src/fleet/teardown.ts"],
            seal: "plan",
          },
        ],
      },
      lab: {
        beats: [
          {
            c: "Fixture mode runs the whole product against an in-memory fleet; nothing can reach AWS.",
            r: ["packages/core/src/backend/fixture/"],
          },
          {
            c: "Before init, the real app's backend refuses every call.",
            r: ["open.ts · openForInit"],
          },
          {
            c: "Tests run with no network, a fresh home and no inherited AWS profile.",
            r: ["tests/preload.ts", "tests/test-isolation.test.ts"],
          },
          {
            c: "Seal twenty: each seal has a gate — import matrix, parity, secret leaks, loopback binds — that fails the build, not a review.",
            r: ["tests/", "scripts/lint.ts"],
            seal: "lab",
          },
        ],
      },
      sealmap: {
        beats: [
          {
            c: "All twenty, by layer. In the <b>codebase</b>: package boundaries and a sealed lab.",
            r: ["tests/boundaries.test.ts", "tests/preload.ts"],
          },
          {
            c: "On the <b>laptop</b>: frozen account, fleet triple, plan-then-confirm, versioned writes and locks, a portless app, one chat door.",
            r: ["aws/client.ts", "app/src/target.ts"],
          },
          {
            c: "In <b>AWS</b>: fleet-named resources, no inbound rules, a box role blind to fleet secrets, content-addressed releases.",
            r: ["foundation template"],
          },
          {
            c: "On the <b>tailnet</b>: an ACL managed with care, and no control port.",
            r: ["fleet/policy.ts"],
          },
          {
            c: "On the <b>box</b>: firewall, loopback services, a contained browser, tmpfs secrets, pinned Hermes — around an agent that is root by design.",
            r: ["render/render-system.ts", "agentd/src/apply/"],
          },
        ],
      },
      gaps: {
        beats: [
          {
            c: "The gaps, as design.md records them. The largest: one role per fleet, and IMDS open to every process — scenario one's blast radius.",
            r: ["design.md §5.1 · Why not ABAC"],
          },
          {
            c: "Two are deliberate trades, fenced by mechanism: root inside the box, and a tailnet-wide policy scope hermetic can't narrow.",
            r: ["design.md §6.4", "§5.2 · trade-off"],
          },
          {
            c: "The ACL is the only authorization in front of the dashboard and browser, and egress is unfiltered.",
            r: ["design.md §7.2"],
          },
          {
            c: "Known code gaps are pinned, not forgotten: <code>chat.turn</code> carries no fleet target — a failing test with an owner. App updates install only after their signature checks out against one release key, so that key is the thing to guard.",
            r: ["packages/app/test/fleet-target.test.ts", "design.md §3.6"],
          },
          {
            c: "Operational edges come with a recovery path: unpinned Tailscale updates, one NAT instance, an agent's own <code>.env</code> shadowing its key.",
            r: ["docs/operations.md"],
          },
        ],
      },
    },
  });
})();
