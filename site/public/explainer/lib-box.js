/* Chapter 4 — an agent's life: create, first boot, releases, and what is on the box. */

const CREATE_STEPS = [
  ["01", "claim the name", "conditional PutItem · status = creating · take the TTL lock"],
  ["02", "open the key slot", "SSM /hermes/fxtr0001/atlas/ts-key · placeholder value"],
  ["03", "mint a Tailscale key", "tag:hermetic · single-use · 1 h · pre-authorised → push to slot"],
  ["04", "copy the provider key", "fleet slot → this agent's provider-key-ant00001-r3 (on the laptop)"],
  ["05", "render + upload config", "final files, no templates → s3 config/atlas/&lt;hash&gt;.tgz"],
  ["06", "create the data volume", "CreateVolume 100 GiB gp3 · tagged agent + fleet"],
  ["07", "launch + attach", "presign hermeticd (1 h) · RunInstances · record id · AttachVolume"],
  ["08", "hand off", "release the lock · record ssm_paths · the box reports from here"],
];

scene({
  id: "create",
  ch: "Lifecycle",
  title: "agent create, step by step",
  html: `
    ${CREATE_STEPS.map(([n, t, s], i) => bx(30, 14 + i * 77, 600, 68, `<span class='mono' style='color:var(--acc);margin-right:10px'>${n}</span>${t}`, s, { b: i, c: "sm", a: "lf", h: String(i) })).join("")}
    ${code(
      1150,
      14,
      420,
      330,
      "dynamodb · agents · pk = atlas",
      `status       <span class="a">creating</span>
version      <span class="s">7</span>
lock         { owner: evan@mbp, expires: +10m }
<span data-b="3" class="up">profile      ant00001 r3 · provider anthropic</span>
<span data-b="4" class="up">config_hash  9f2c41…  <span class="c">+ config_key</span></span>
<span data-b="5" class="up">resources    volume_id   vol-0a91…</span>
<span data-b="6" class="up">             instance_id i-07c3…</span>
<span data-b="7" class="up">lock         <span class="c">— released</span></span>
<span data-b="7" class="up">ssm_paths    [ts-key, provider-key-…-r3]</span>`,
      { b: 0 },
    )}
    ${bx(700, 30, 190, 66, "SSM", "/hermes/fxtr0001/atlas/*", { b: 1, c: "xs" })}
    ${bx(920, 30, 190, 66, "Tailscale API", "OAuth client → auth key", { b: 2, c: "xs blue" })}
    ${bx(700, 260, 190, 66, "S3", "config/atlas/…tgz", { b: 4, c: "xs" })}
    ${bx(700, 410, 190, 66, "EBS", "fxtr0001-atlas-data", { b: 5, c: "xs ok" })}
    ${bx(920, 410, 190, 66, "EC2", "fxtr0001-atlas", { b: 6, c: "xs acc iso" })}
    ${code(
      700,
      496,
      420,
      136,
      "user-data · the whole of it",
      `{ name: <span class="s">"atlas"</span>, hostname: <span class="s">"fxtr0001-atlas"</span>,
  bucket: <span class="s">"hermetic-fxtr0001-…"</span>,
  hermeticd_url: <span class="s">"https://…?X-Amz-Expires=3600"</span>,
  hermeticd_sha256: <span class="s">"e3b0c4…"</span> }
<span class="c">// no secret · no table names · one UserData schema</span>`,
      { b: 6 },
    )}
    ${zone(1150, 370, 420, 260, "why it's safe to re-run", { b: 8, c: "ok solid" })}
    ${list(
      1170,
      400,
      380,
      [
        [
          "ok",
          "Step 1's conditional put is the only claim; steps 2–7 check reality first, so re-running <span class='m'>create</span> finishes a half-made agent.",
        ],
        [
          "ok",
          "Crash recovery lives on the row, not the laptop: any operator can resume or destroy it.",
        ],
        [
          "ok",
          "<span class='m'>--rollback-on-failure</span> unwinds only what <i>this</i> run created, re-taking the lock before each removal.",
        ],
      ],
      { b: 8 },
    )}
  `,
  svg: `
    ${wire("M630 48 C 1000 48, 1080 60, 1150 60", { b: 0, c: "acc" })}
    ${wire("M630 125 C 660 125, 670 63, 700 63", { b: 1, c: "acc" })}
    ${wire("M630 202 C 860 202, 1015 160, 1015 96", { b: 2, c: "blue" })}
    ${wire("M920 70 L890 70", { b: 2, c: "blue" })}
    ${wire("M630 279 C 660 279, 680 80, 700 80", { b: 3, c: "acc" })}
    ${wire("M630 356 C 660 356, 670 293, 700 293", { b: 4, c: "acc" })}
    ${wire("M630 433 C 660 433, 670 443, 700 443", { b: 5, c: "ok" })}
    ${wire("M630 510 C 820 510, 1015 520, 1015 476", { b: 6, c: "acc" })}
    ${wire("M920 443 L890 443", { b: 6, c: "ok", end: false, w: "fat" })}
    ${wire("M630 587 C 1000 600, 1100 300, 1150 300", { b: 7, c: "acc" })}
  `,
  beats: [
    {
      c: "<code>agents.create</code> validates the name — the only place names are validated — and claims it with a <b>conditional put</b>: status <code>creating</code>, plus a ten-minute TTL lock that expires by itself if this laptop dies.",
      r: ["agents/lifecycle/create-agent.ts", "names.ts · validateName"],
    },
    {
      c: "It opens the agent's SSM slot for its Tailscale key with a placeholder. hermetic owns a secret's <em>existence</em> — the path and the IAM policy — never a copy of its value.",
      r: ["design.md §8.2 · slot and push"],
    },
    {
      c: "It mints a Tailscale auth key with the fleet's OAuth client — tagged, single-use, one-hour, pre-authorised — and pushes it straight into that slot.",
      r: ["backend · tailscale port"],
    },
    {
      c: "If the agent uses a keyed provider, the laptop copies the provider profile's key from the fleet slot into this agent's own slot. The box can never read the fleet slot, so the copy has to happen here.",
      r: ["profiles/profile-apply.ts", "design.md §8.1"],
    },
    {
      c: "Core renders the agent's <b>final</b> files — systemd units, Hermes config, nginx, nftables, package list — tars them and uploads to S3. The box never sees a template or a variable.",
      r: ["render/render.ts", "render/render-hermes.ts", "render/render-system.ts"],
    },
    {
      c: "It creates the data volume — 100 GiB gp3 by default, encrypted, tagged with the agent and the fleet. This disk is the agent's memory.",
      r: ["design.md §7.1"],
    },
    {
      c: "It presigns a one-hour URL for the exact hermeticd key the fleet manifest names, launches the instance with a five-field user-data blob, writes the instance id to the row, then attaches the volume.",
      r: ["schema/userdata.ts · UserData", "agents/attach.ts"],
    },
    {
      c: "Finally it releases the lock and records which SSM slots it filled. From here the <b>box</b> is the one writing to its row.",
      r: ["design.md §6.2 step 8"],
    },
    {
      c: "Every step after the claim checks reality before acting, so a create that died halfway is finished by running it again — from any laptop — because everything needed is on the row.",
      r: ["design.md §4.5", "agents/rollback.ts"],
    },
  ],
});

const STAGES = [
  ["00-preflight", "runtime dirs, hostname, assert apt/systemctl/curl"],
  ["01-tailscale", "auth key SSM → tmpfs (never argv) → tailscale up → key deleted"],
  ["02-data-volume", "mount /data · format only a genuinely blank device"],
  ["03-config", "fetch + validate the agent manifest → /etc/hermetic"],
  ["04-apply", "hermeticd apply: packages · files · units · commands"],
  ["05-service", "enable + start hermeticd.service"],
  ["06-verify", "mount, tailnet, both Hermes units, provider + model + key"],
];

scene({
  id: "boot",
  ch: "Lifecycle",
  title: "First boot: from user-data to ready",
  html: `
    ${bx(30, 20, 400, 150, "cloud-init · runs once", "1 · hostname from user-data (UserData schema)<br>2 · curl the presigned URL — via the S3 gateway endpoint — verify sha256, install /usr/local/bin/hermeticd<br>3 · hermeticd bootstrap --install → oneshot unit, Restart=on-failure", { b: 0, c: "sm" })}
    ${bx(30, 190, 400, 150, "hermeticd-bootstrap.service", "region from IMDS · fleet manifest from S3 (cache only as fallback) · every stage fetched, sha256-verified, ordered · stale stages pruned", { b: 1, c: "sm acc" })}
    ${bx(30, 360, 400, 128, "every stage runs with", "an env allowlist (PATH, HOME, LANG, HERMETIC_*) — never a secret in env or argv. Anything that touches AWS, a disk or a secret is a <span style='color:var(--fg)'>hermeticd stage …</span> subcommand in TypeScript, under test.", { b: 6, c: "sm" })}
    ${bx(30, 508, 400, 120, "hermeticd stage secret --out", "refuses any path outside /run/ (normalised, no ..); /run/hermetic is 0700 → a secret can only land on tmpfs", { b: 6, c: "sm warn" })}

    ${STAGES.map(
      ([n, s], i) => `
      <div class="bx sm up" data-b="${i < 4 ? 2 : 3}" style="left:470px;top:${20 + i * 66}px;width:560px;height:58px;flex-direction:row;align-items:center;gap:12px">
        <i class="stq" data-i="${i}" style="width:14px;height:14px;background:var(--line2);flex:none"></i>
        <div><div class="t mono" style="font-family:var(--mono);font-size:14px">${n}.sh</div><div class="s">${s}</div></div>
      </div>`,
    ).join("")}
    ${bx(470, 494, 560, 134, "on failure", "row → <span style='color:var(--bad)'>error</span>; the stage event carries <span style='color:var(--fg)'>log_tail</span> — its last 120 lines, redacted — so <span style='color:var(--fg)'>agent history</span> shows why with no connection to the box. The runner stays resident, polling its own row for an <span style='color:var(--fg)'>agent rerun</span> command, and resumes at the failed stage.", { b: 5, c: "sm bad" })}

    ${kick(1080, 22, "the row · §4.3 state machine", { b: 1 })}
    ${st(1080, 54, "creating", { b: 0, c: "acc" })}
    ${st(1240, 54, "bootstrapping", { b: 1, c: "acc pulse" })}
    ${st(1440, 54, "ready", { b: 4, c: "ok" })}
    ${st(1240, 140, "error", { b: 5, c: "bad" })}
    ${txt(1080, 196, 480, "<span class='mono' style='font-size:13px'>agent rerun</span> writes a <span class='mono'>command</span> on the row; the box notices and resumes. Nothing opens a connection to it.", { b: 5 })}
    ${st(1440, 140, "degraded", { b: 4, c: "warn" })}
    ${term(
      1080,
      290,
      480,
      200,
      `<span class="c">/var/lib/hermeticd/stages/04-apply.ok</span>
sha256  <span class="g">a41f…</span>  <span class="c"># the stage that ran</span>
config  <span class="g">9f2c…</span>  <span class="c"># the config it ran against</span>

<span class="c">a reboot re-runs the unit; a stage whose</span>
<span class="c">marker matches both is skipped — a fast,</span>
<span class="c">idempotent resume, not a restart.</span>`,
      { b: 4 },
    )}
    ${bx(1080, 510, 480, 118, "every 30 s after ready", "heartbeat → own row: last_heartbeat, health{hermes, tailscale, disk, dashboard}, metrics. A failing check moves ready ⇄ degraded.", { b: 4, c: "sm ok" })}
  `,
  svg: `
    ${wire("M230 170 L230 190", { b: 1, c: "acc" })}
    ${wire("M430 260 L470 260", { b: 2, c: "acc" })}
    ${wire("M1196 70 L1240 70", { flow: false, b: 1, c: "acc" })}
    ${wire("M1400 70 L1440 70", { flow: false, b: 4, c: "ok" })}
    ${wire("M1320 88 L1320 140", { flow: false, b: 5, c: "bad" })}
    ${wire("M1360 140 C 1360 116, 1380 110, 1380 90", { flow: false, b: 5, c: "acc", w: "thin" })}
    ${wire("M1480 88 L1480 140", { b: 4, c: "warn", start: true })}
  `,
  onBeat(b, cv) {
    cv.querySelectorAll(".stq").forEach((q) => {
      const i = Number(q.dataset.i);
      let c = "var(--line2)";
      if (b >= 4 || (b >= 2 && i < 4) || (b === 3 && i < 7)) c = "var(--ok)";
      if (b === 2 && i === 3) c = "var(--acc)";
      if (b === 3 && i >= 4) c = i === 6 ? "var(--acc)" : "var(--ok)";
      if (b === 5 && i === 4) c = "var(--bad)";
      if (b === 5 && i > 4) c = "var(--line2)";
      if (b === 6 && i === 4) c = "var(--bad)";
      if (b === 6 && i > 4) c = "var(--line2)";
      q.style.background = c;
      q.classList.toggle("pulse", c === "var(--acc)");
    });
  },
  beats: [
    {
      c: "The box boots stock Ubuntu. cloud-init does about ten lines: set the hostname, fetch hermeticd from the presigned URL, verify its sha256, and install a systemd unit to run the real bootstrap. Then it gets out of the way.",
      r: ["packages/core/src/render/cloud-init.ts", "design.md §6.3"],
    },
    {
      c: "The bootstrap unit reads the <b>fleet manifest</b> from S3 — the box's only source for table names and which release to run — then fetches every stage it lists and verifies each digest. The row moves to <code>bootstrapping</code>.",
      r: ["packages/agentd/src/bootstrap.ts", "packages/agentd/src/fleet.ts"],
    },
    {
      c: "Stages run in order. Tailscale's auth key goes from SSM to a tmpfs file — never a command-line argument — is used once, and deleted. The data volume mounts at <code>/data</code>; the config tarball is fetched and validated.",
      r: ["packages/agentd/stages/01-tailscale.sh", "packages/agentd/src/stages.ts"],
    },
    {
      c: "<code>04-apply</code> runs hermeticd's idempotent apply. The service starts, and <code>06-verify</code> confirms the mount, the tailnet, both Hermes units, and that Hermes really has a provider, model and key.",
      r: ["packages/agentd/src/apply/index.ts", "stage verify-hermes"],
    },
    {
      c: "All green → <code>ready</code>. Stage markers bind to both the script's digest and the config it ran against, so a reboot resumes in seconds. From then on a 30-second heartbeat keeps the row honest.",
      r: ["packages/agentd/src/heartbeat.ts"],
    },
    {
      c: "A failing stage moves the row to <code>error</code> and attaches the redacted tail of its log to the event. The runner waits for an <code>agent rerun</code> command on the row and resumes exactly where it stopped.",
      r: ["agent history <name>", "design.md §4.2 · log_tail"],
    },
    {
      c: "Stages are just orchestration in shellcheck-clean bash. Anything dangerous — secrets, disks, AWS — lives behind <code>hermeticd stage …</code> in TypeScript, and a secret can only ever be written under <code>/run</code>.",
      r: ["bun run lint:sh", "packages/agentd/src/cli.ts"],
    },
  ],
});

scene({
  id: "release",
  ch: "Lifecycle",
  title: "Releases: content-addressed, verified, pinned",
  html: `
    ${bx(30, 20, 360, 160, "artifacts push / init", "builds hermeticd (bun --compile, linux-arm64) + stages from a <b style='color:var(--fg)'>committed</b> tree — WORKING_TREE_DIRTY otherwise, so a build number always names real code", { b: 0, c: "sm acc" })}
    ${bx(30, 200, 360, 136, "generation = digest(names + sha256s)", "16 hex chars. Same bytes → same key; different bytes can never overwrite a release in place", { b: 1, c: "sm" })}
    ${bx(30, 356, 360, 130, "upload order", "stages → binary → confirm every key → <b style='color:var(--fg)'>release.json</b> → <b style='color:var(--fg)'>manifest.json</b> last. A half push is invisible.", { b: 1, c: "sm" })}
    ${bx(30, 506, 360, 122, "mirrors (soft-fail)", "Hermes at hermes_ref → a single-commit bundle · Chrome for Testing zip checked against the pinned digest + size", { b: 3, c: "sm" })}

    ${code(
      440,
      20,
      600,
      470,
      "s3://hermetic-fxtr0001-…",
      `<span class="a">manifest.json</span>                      <span class="c">← the fleet manifest</span>
  hermeticd: { version 0.5.0, generation 3fa9c1e0…,
     build_number 412, commit 3b7b135,
     files: { key, sha256, size } × 8,
     capabilities: [gateway-unit, …] }
  hermes:   { v2026.9.24: { key, sha256 } }
  browser:  { key, sha256, size }
  resources: { tables, bucket, vpc, network }

artifacts/0.5.0/<span class="a">3fa9c1e07b2d4a11</span>/
  stages/00-preflight.sh … 06-verify.sh
  hermeticd
  <span class="s">release.json</span>                   <span class="c">← makes it a release</span>
hermes/v2026.9.24.bundle
browser/chrome-linux-arm64-&lt;chrome_ref&gt;.zip
config/atlas/9f2c41….tgz            <span class="c">← per agent</span>`,
      { b: 2 },
    )}
    ${tag(440, 500, "MANIFEST_REFUSED · keys outside the named release are never fetched", { b: 2, c: "bad" })}
    ${bx(440, 540, 600, 88, "why the refusal matters", "create presigns files[\"hermeticd\"].key into user-data. A manifest pointing that at config/* would hand a box another agent's rendered secrets as a 'binary'.", { b: 2, c: "xs bad" })}

    ${bx(1090, 20, 470, 120, "on the box", "hermeticd checks the user-data sha256 · every stage digest · the manifest's keys · Chrome digest + length · Hermes bundle digest", { b: 4, c: "sm ok" })}
    ${bx(1090, 156, 470, 120, "nightly update · 03:00–03:59 UTC", "minute from a hash of the name. Compares the installed binary's sha256 with the manifest — the <b style='color:var(--fg)'>digest</b>, never the version label — verifies, swaps, restarts last", { b: 4, c: "sm ok" })}
    ${bx(1090, 292, 470, 110, "requires: capabilities", "a config needing what the published hermeticd can't do is refused on the laptop before anything is created", { b: 4, c: "sm" })}
    ${bx(1090, 418, 470, 210, "Hermes is pinned, not updated", "<span style='color:var(--fg)'>/etc/hermes/image-provenance.json</span> marks the box image-managed, so upstream's own updater refuses every path to <span style='color:var(--fg)'>hermes update</span> — including the dashboard's POST /api/hermes/update. <span style='color:var(--fg)'>updates.check: false</span> stops the version probe phoning GitHub. The version moves only by <span style='color:var(--fg)'>hermetic upgrade --hermes</span>, one agent at a time.", { b: 5, c: "sm acc" })}
  `,
  svg: `
    ${wire("M390 100 L440 100", { b: 2, c: "acc" })}
    ${wire("M1040 200 L1090 80", { b: 4, c: "ok" })}
  `,
  beats: [
    {
      c: "hermetic's own code is <b>never published to a package manager</b>. A release — the hermeticd binary plus the bash stages — is pushed straight into the fleet's bucket, and only from a committed tree.",
      r: ["packages/core/src/release/artifacts.ts", "release/git.ts"],
    },
    {
      c: "A release is an immutable <em>generation</em> addressed by the digest of its files. Stages upload first, the binary next, and a <code>release.json</code> marker only after every key is confirmed present.",
      r: ["release/artifacts-release.ts · releaseGeneration"],
    },
    {
      c: "The root <code>manifest.json</code> is written last and names every key with its sha256 and size. A manifest naming objects outside the release it claims is refused on both sides — <code>MANIFEST_REFUSED</code>.",
      r: ["release/artifacts-manifest.ts", "packages/agentd/src/fleet.ts · releaseObjectKey"],
      seal: "supply",
    },
    {
      c: "The laptop also mirrors the pinned Hermes source as a single-commit git bundle and the pinned Chrome build, both verified, both uploaded before the manifest names them — so a box installs with GitHub down.",
      r: ["release/hermes-mirror.ts", "release/browser-mirror.ts"],
    },
    {
      c: "The box trusts nothing it hasn't digested. The nightly self-update compares bytes, not version strings, and a config that needs a capability the published binary lacks is refused before any instance is launched.",
      r: ["packages/agentd/src/update/", "AGENT_CONFIG_CAPABILITIES"],
    },
    {
      c: "And Hermes itself is a pin. A provenance marker makes upstream's own updater refuse — even from the dashboard's update button — so two agents built a week apart run exactly the version their rows say.",
      r: ["agentd/src/apply/hermes.ts", "design.md §6.4"],
      seal: "pin",
    },
  ],
});

scene({
  id: "netpath",
  ch: "The box",
  title: "Two walls, one door, all loopback",
  html: `
    ${bx(20, 40, 200, 90, "the internet", "port scans, bots", { b: 0, c: "sm bad" })}
    ${bx(20, 380, 200, 100, "your laptop", "on the tailnet", { b: 0, c: "sm blue" })}
    <div class="wall up" data-b="1" style="left:280px;top:20px;width:14px;height:620px"></div>
    ${kick(300, 24, "SG · 0 ingress", { b: 1, st: "color:var(--acc)" })}
    <div class="wall up" data-b="2" style="left:520px;top:20px;width:14px;height:620px"></div>
    ${kick(540, 24, "nftables · policy drop", { b: 2, st: "color:var(--acc)" })}
    ${code(
      300,
      466,
      214,
      168,
      "render-system.ts",
      `<span class="kw">chain</span> input {
 policy <span class="r">drop</span>;
 iif <span class="s">lo</span> accept
 iifname <span class="s">tailscale0</span>
   accept
 udp 41641 accept
}`,
      { b: 2, c: "", st: "font-size:12px" },
    )}
    ${zone(580, 60, 990, 580, "agent box · everything below binds 127.0.0.1", { b: 3, c: "ok solid" })}
    ${bx(610, 100, 220, 90, "tailscaled", "tailscale0 · WireGuard", { b: 3, c: "sm blue" })}
    ${bx(880, 100, 230, 90, "Serve :443", "real TLS cert · https://fxtr0001-atlas.&lt;tailnet&gt;.ts.net", { b: 3, c: "sm blue" })}
    ${bx(1160, 100, 380, 90, "nginx 127.0.0.1:9120", "rewrites Host + Origin → 127.0.0.1:9119 · our whole nginx.conf, the only listen", { b: 4, c: "sm" })}
    ${bx(1160, 230, 380, 90, "hermes dashboard 127.0.0.1:9119", "local mode, no login · SPA token guards /api/* and /api/ws", { b: 4, c: "sm acc" })}
    ${bx(880, 230, 230, 90, "/vnc → websockify", "loopback → x11vnc → Xvfb :99", { b: 4, c: "sm" })}
    ${bx(610, 360, 220, 90, "hermeticd :7434", "tailscale0 only · logs + health · caller via tailscale whois", { b: 5, c: "sm vio" })}
    ${bx(880, 360, 230, 90, "Chrome CDP 127.0.0.1:9222", "never published · never a Serve route", { b: 5, c: "sm" })}
    ${bx(1160, 360, 380, 90, "hermes gateway", "messaging + cron · opens no listener (api_server off)", { b: 5, c: "sm" })}
    ${bx(610, 480, 930, 140, "enforced by a test, not a review", "render-network-invariants.test.ts asserts that no rendered file binds anything but 127.0.0.1/::1, and that nftables keeps policy drop with lo + tailscale0 as the only accepted interfaces. UDP 41641 stays open for direct WireGuard (unauthenticated packets die in the Noise handshake); ICMPv6 stays open so NDP and path-MTU work. A raw http://&lt;tailscale-ip&gt;:9119 reaches nothing.", { b: 5, c: "sm ok" })}
  `,
  svg: `
    ${wire("M220 85 L278 85", { b: 1, c: "bad", end: false })}
    ${pk("M220 85 L278 85", { b: 1, c: "bad", dur: 900 })}
    ${wire("M220 150 C 400 150, 420 200, 518 200", { b: 2, c: "bad", end: false })}
    ${pk("M220 150 C 400 150, 420 200, 518 200", { b: 2, c: "bad", dur: 1400 })}
    ${wire("M220 430 C 420 430, 480 145, 610 145", { b: 3, c: "blue" })}
    ${wire("M830 145 L880 145", { b: 3, c: "blue" })}
    ${wire("M1110 145 L1160 145", { b: 4, c: "acc" })}
    ${wire("M1350 190 L1350 230", { b: 4, c: "acc" })}
    ${wire("M995 190 L995 230", { b: 4, c: "acc" })}
    ${wire("M720 190 L720 360", { b: 5, c: "vio" })}
  `,
  svgTop: `${lbl(258, 80, "✕", { b: 1, c: "bad" })}${lbl(498, 196, "✕", { b: 2, c: "bad" })}`,
  beats: [
    {
      c: "Zoom into one box and follow a packet in. Two walls stand between the internet and any socket, and both are <em>stateful default-deny</em>.",
      r: ["design.md §7.2"],
    },
    {
      c: "The first wall is the VPC security group: zero inbound rules, so nothing unsolicited reaches the instance at all.",
      r: ["foundation · agent security group"],
    },
    {
      c: "The second is on the box: nftables with <code>policy drop</code>, accepting only loopback and the tailnet interface. The box stays sealed even if it were ever placed in the wrong subnet.",
      r: ["packages/core/src/render/render-system.ts:114"],
      seal: "nft",
    },
    {
      c: "Your request arrives as WireGuard on <code>tailscale0</code>. Tailscale Serve terminates TLS with a real certificate for the box's MagicDNS name — the only address there is.",
      r: ["design.md §7.4"],
    },
    {
      c: "Serve forwards to nginx on loopback, which rewrites Host and Origin so Hermes sees a loopback client and stays in its no-login local mode. hermetic owns the <em>entire</em> nginx.conf, so Ubuntu's default site on 0.0.0.0:80 never exists.",
      r: ["render · nginx.conf", "design.md §6.4 · dashboard access"],
    },
    {
      c: "Everything else binds 127.0.0.1 — the browser's debugging port, VNC, the dashboard. hermeticd's RPC is the one tailnet listener, and it checks every caller with <code>tailscale whois</code>. A test fails the build if any rendered file binds anything else.",
      r: ["render-network-invariants.test.ts", "packages/agentd/src/rpc.ts"],
      seal: "loopback",
    },
  ],
});

scene({
  id: "inside",
  ch: "The box",
  title: "Inside an agent box",
  html: `
    ${zone(20, 30, 760, 600, "root volume · replaced on every recreate", { b: 0, c: "solid" })}
    ${zone(820, 30, 760, 600, "/data · EBS · the agent's memory · survives", { b: 0, c: "ok solid" })}
    ${bx(40, 60, 340, 120, "hermeticd.service · root", "heartbeat 30 s · nightly update · RPC :7434 · acts on row-borne requests (rerun, converge, update)", { b: 1, c: "sm vio" })}
    ${bx(400, 60, 360, 120, "hermetic-secrets.service", "writes /run/hermetic/secrets.env — tmpfs, 0600, root-owned. Both Hermes units Require= it", { b: 1, c: "sm warn" })}
    ${bx(40, 200, 340, 120, "hermes-dashboard.service", "User=hermes · 127.0.0.1:9119 · unit rendered by hermetic (upstream ships none)", { b: 2, c: "sm acc" })}
    ${bx(400, 200, 360, 120, "hermes-gateway.service", "User=hermes · channels + cron · upstream's own installer, run once; hermetic adds a drop-in", { b: 2, c: "sm acc" })}
    ${bx(40, 340, 340, 130, "/etc/hermes/config.yaml", "<b style='color:var(--fg)'>managed</b>, root:hermes 0640, rewritten every apply: provider wiring (names the key's env var, never its value), stated settings, browser.cdp_url", { b: 3, c: "sm" })}
    ${bx(400, 340, 360, 130, "/etc/hermes/config.seed.yaml", "<b style='color:var(--fg)'>seed</b>: default model, max_turns, approvals.mode = off … copied into $HERMES_HOME once, then it's the agent's", { b: 3, c: "sm" })}
    ${bx(40, 490, 340, 120, "/etc/sudoers.d/hermetic-apt", "hermes ALL=(ALL:ALL) NOPASSWD: ALL · visudo -c before install", { b: 4, c: "sm bad" })}
    ${bx(400, 490, 360, 120, "/usr/local/lib/hermes-agent", "root's pinned venv (uv editable install, [all,messaging,+provider])", { b: 1, c: "sm" })}

    ${bx(840, 60, 720, 110, "/data/hermes · home of the hermes account", "HOME=/data/hermes, so $HOME/.hermes IS $HERMES_HOME — upstream's native layout, nothing remapped", { b: 0, c: "sm ok" })}
    ${bx(840, 190, 350, 150, "$HERMES_HOME = ~/.hermes", "config.yaml (agent-owned) · memory · sessions · skills · cron · logs/", { b: 2, c: "sm" })}
    ${bx(1210, 190, 350, 150, "the agent's own tools", "~/.venv — its Python, pip works<br>~/.local — npm -g prefix<br>~/.hermes/lazy-packages — Hermes's on-demand installs", { b: 5, c: "sm" })}
    ${bx(840, 360, 350, 110, "~/browser/default", "Chrome profile — logins survive a rebuild", { b: 2, c: "sm" })}
    ${bx(1210, 360, 350, 110, "never on /data", "secrets · the hermeticd binary · Hermes code", { b: 3, c: "sm bad" })}
    ${zone(840, 490, 720, 120, "the boundary is the instance, not the unix user", { b: 4, c: "acc solid" })}
    ${txt(860, 516, 690, "The agent may run anything as root, unattended — it is in the <b>docker</b> group anyway, which is root by a longer route. So hermetic doesn't pretend a sudoers list is a wall: <b>one agent = one instance, one kernel, one volume, one provider binding</b>, zero inbound, destroyable in one command.", { b: 4 })}
  `,
  beats: [
    {
      c: "An agent box has two disks. The root volume holds the OS, hermeticd and the pinned Hermes code, and is <em>replaced</em> on every recreate. <code>/data</code> is the agent's memory and survives everything.",
      r: ["design.md §7.1", "packages/agentd/src/disk.ts"],
    },
    {
      c: "hermeticd runs as root: heartbeat, nightly self-update, the log RPC. A small unit materialises secrets into a RAM-backed file before Hermes may start.",
      r: ["packages/agentd/src/daemon.ts", "agentd/src/apply/secrets.ts"],
    },
    {
      c: "Two Hermes processes run as the unprivileged <code>hermes</code> user: the dashboard, whose unit hermetic renders, and the gateway — channels and cron — installed once by upstream's own installer and extended with a drop-in.",
      r: ["render/render-units.ts", "agentd/src/apply/hermes.ts"],
    },
    {
      c: "Config is two layers. The <b>managed</b> file in <code>/etc/hermes</code> wins per key and the agent can't rewrite it; the <b>seed</b> becomes the agent's own <code>config.yaml</code> once and is then theirs to change.",
      r: ["schema/hermes.ts · splitHermesSettings", "render/render-hermes.ts"],
    },
    {
      c: "Inside, the agent is trusted with root on purpose — passwordless sudo, approvals off — so it can install and fix things unattended. The containment is the instance itself, and everything around it.",
      r: ["design.md §6.4 · root on the box"],
      seal: "instance",
    },
    {
      c: "Its own tools — a writable Python, an npm prefix, Hermes's lazy installs — live on <code>/data</code> in the account's home, so they survive a rebuild without root ever touching the pinned venv.",
      r: ["agentd/src/account-dirs.ts", "/etc/profile.d/hermetic-agent.sh"],
    },
  ],
});

scene({
  id: "browser",
  ch: "The box",
  title: "One contained browser, shared with you",
  html: `
    ${bx(40, 40, 320, 110, "hermes agent", "agent-browser tool · browser.cdp_url = http://127.0.0.1:9222 (managed)", { b: 1, c: "sm acc" })}
    ${bx(560, 200, 420, 190, "hermetic-browser@default", "pinned Chrome for Testing · headed on Xvfb :99<br>CDP 127.0.0.1:9222 · profile /data/hermes/browser/default<br>/opt/hermetic/chrome/&lt;chrome_ref&gt;/ — digest-verified from the fleet bucket", { b: 0, c: "acc" })}
    ${bx(560, 40, 200, 100, "xvfb@default", ":99 virtual display", { b: 0, c: "sm" })}
    ${bx(780, 40, 200, 100, "hermetic-wm@", "matchbox · kiosk, no menu", { b: 0, c: "sm" })}
    ${bx(1080, 200, 220, 90, "x11vnc@", "attaches to :99", { b: 2, c: "sm" })}
    ${bx(1080, 320, 220, 90, "novnc@ · websockify", "loopback", { b: 2, c: "sm" })}
    ${bx(1360, 260, 210, 110, "Serve /vnc/", "→ the app's sandboxed webview", { b: 2, c: "sm blue" })}
    ${bx(1360, 420, 210, 120, "you", "watch, or take the wheel at a login wall, then hand back", { b: 2, c: "sm blue" })}
    ${zone(40, 430, 940, 200, "containment", { b: 3, c: "acc solid" })}
    ${list(
      60,
      460,
      900,
      [
        [
          "acc",
          "<b>All five units run as <span class='m'>hermes</span></b>, not root — root is the worst account to hold an unauthenticated display and take network input.",
        ],
        [
          "acc",
          "<b>The sandbox stays on.</b> An AppArmor profile scoped to <span class='m'>/opt/hermetic/chrome/**/chrome</span> grants the user namespace Chrome needs — never <span class='m'>--no-sandbox</span>.",
        ],
        [
          "acc",
          "<b>No snap anywhere;</b> CDP on loopback only; one browser per agent — two identities that mustn't meet are two agents.",
        ],
        [
          "acc",
          "<b>No privileged command creates a path inside <span class='m'>/data/hermes</span></b> — a symlink planted there is refused by name (<span class='m'>AGENT_DIR_UNSAFE</span>).",
        ],
      ],
      { b: 3 },
    )}
    ${bx(40, 190, 440, 200, "why one browser", "Hermes attaches over CDP to the browser hermetic already started — it never launches its own. You and the agent see and drive the <b style='color:var(--fg)'>same window</b>: it hits a login wall or consent banner, you take over through noVNC, hand back, and its next tool call sees the result.", { b: 2, c: "sm" })}
  `,
  svg: `
    ${wire("M360 95 C 500 95, 500 260, 560 260", { b: 1, c: "acc" })}
    ${lbl(380, 86, "CDP · loopback", { b: 1, c: "acc" })}
    ${wire("M660 140 L660 200", { b: 0, end: false })}
    ${wire("M980 245 L1080 245", { b: 2 })}
    ${wire("M1190 290 L1190 320", { b: 2 })}
    ${wire("M1300 365 L1360 330", { b: 2, c: "blue" })}
    ${wire("M1456 370 L1456 420", { b: 2, c: "blue" })}
    ${wire("M1476 420 L1476 370", { b: 2, c: "blue" })}
  `,
  beats: [
    {
      c: "Every agent runs exactly one browser: a pinned Chrome for Testing, headed on a virtual display, with its profile on <code>/data</code> so logins survive a rebuild.",
      r: ["render/render-browser.ts", "design.md §7.3"],
    },
    {
      c: "Hermes's browser tool is pointed at that Chrome's debugging port on loopback by a managed setting, so it attaches instead of downloading and launching a second browser of its own.",
      r: ["/etc/hermes/config.yaml · browser.cdp_url"],
    },
    {
      c: "You watch the same display through noVNC, published by Serve at <code>/vnc/</code> and embedded in the app. One window, two drivers — the operator can clear a login wall and hand control back.",
      r: ["packages/ui · desktop view", "design.md §3.4"],
    },
    {
      c: "And it's contained: every unit runs unprivileged, Chrome's own sandbox stays on via a narrow AppArmor profile, the build is mirrored and digest-checked, and the debug port never leaves loopback.",
      r: ["/etc/apparmor.d/hermetic-chrome", "agentd/src/browser-source.ts"],
      seal: "browser",
    },
  ],
});

scene({
  id: "secrets",
  ch: "The box",
  title: "The secret path",
  html: `
    ${term(
      20,
      30,
      330,
      120,
      `<span class="p">$</span> hermetic providers create \\
    --provider anthropic \\
    --name work <span class="y">--api-key-stdin</span>
<span class="c">the one place a key is typed</span>`,
      { b: 0 },
    )}
    ${bx(400, 30, 300, 120, "/hermetic/fxtr0001/secrets/work", "fleet slot · SecureString<br>no instance role can read /hermetic/*", { b: 0, c: "sm warn" })}
    ${bx(400, 230, 300, 120, "/hermes/fxtr0001/atlas/provider-key-ant00001-r3", "this agent's copy, made on the laptop with the operator's credentials", { b: 1, c: "sm" })}
    ${bx(780, 230, 260, 120, "hermeticd secrets materialise", "reads the slot the manifest names (provider_key_ref) with the instance role", { b: 2, c: "sm vio" })}
    ${bx(1110, 230, 450, 120, "/run/hermetic/secrets.env", "tmpfs · 0600 · root · ANTHROPIC_API_KEY=… · rewritten every apply — a provider switch clears the old line", { b: 3, c: "sm warn" })}
    ${bx(1110, 400, 210, 90, "hermes-dashboard", "EnvironmentFile + Requires=", { b: 3, c: "xs acc" })}
    ${bx(1350, 400, 210, 90, "hermes-gateway", "same, via drop-in", { b: 3, c: "xs acc" })}
    ${bx(780, 30, 260, 120, "rendered config.yaml", "names the variable (key_env) — never the value", { b: 2, c: "sm" })}

    ${zone(20, 420, 1050, 210, "never", { b: 4, c: "bad solid" })}
    ${[
      "git",
      "user-data",
      "an AMI",
      "config tarball",
      "hermetic.db",
      "/data",
      "stage argv/env",
      "logs & events",
      "a CLI flag",
    ]
      .map((t, i) =>
        tag(44 + (i % 5) * 204, 456 + Math.floor(i / 5) * 46, `✕ ${t}`, { b: 4, c: "bad" }),
      )
      .join("")}
    ${txt(44, 560, 1010, "<span class='mono'>secrets-leak.test.ts</span> fails the suite if any fixture secret or any <span class='mono'>tskey-…</span> appears in captured output; inputs carrying <span class='mono'>api_key</span> are redacted before the run log; stage failure tails are redacted at capture.", { b: 4 })}
    ${bx(1110, 520, 450, 110, "Bedrock: zero secrets", "the instance role is the credential — the only secret the box ever holds is its single-use Tailscale key", { b: 5, c: "sm ok" })}
  `,
  svg: `
    ${wire("M350 90 L400 90", { b: 0, c: "warn" })}
    ${wire("M550 150 L550 230", { b: 1, c: "warn" })}
    ${lbl(562, 196, "copied on the laptop · operator's creds", { b: 1, c: "acc" })}
    ${wire("M700 290 L780 290", { b: 2, c: "vio" })}
    ${wire("M1040 290 L1110 290", { b: 3, c: "warn" })}
    ${wire("M1215 350 L1215 400", { b: 3, c: "warn" })}
    ${wire("M1455 350 L1455 400", { b: 3, c: "warn" })}
  `,
  beats: [
    {
      c: "A provider key is typed exactly once, on stdin — never as a flag value, which would land in shell history and hermetic's own run log — into a fleet-level SSM slot that no box can read.",
      r: ["profiles/provider-profiles.ts", "design.md §8.1"],
    },
    {
      c: "When an agent is created or re-bound, the <b>laptop</b> copies the key into that agent's own slot, named for the profile and its revision, so rotations move as a reviewable change.",
      r: ["profiles/profile-apply.ts", "design.md §8.3"],
    },
    {
      c: "On the box, hermeticd reads the slot the agent manifest names — its own, with the instance role — while the rendered Hermes config only ever names the environment variable.",
      r: ["agentd/src/apply/secrets.ts"],
    },
    {
      c: "The value lands in a tmpfs file, mode 0600, that both Hermes units require. It never touches <code>/data</code> and is gone on stop; Hermes starts with the key in its environment, or doesn't start.",
      r: ["hermetic-secrets.service"],
    },
    {
      c: "The list of places a secret may <em>never</em> appear is long and tested: no git, no user-data, no SQLite, no logs, no persistent disk. A leak test greps captured output for every fixture secret.",
      r: ["packages/core/test/secrets-leak.test.ts", "chat/chat-redact.ts"],
      seal: "secrets",
    },
    {
      c: "And the default path needs none of it: on Bedrock the instance role authenticates, so a working agent's only secret is a single-use, already-consumed Tailscale join key.",
      r: ["design.md §1 · zero-secret minimal path"],
    },
  ],
});

scene({
  id: "volumes",
  ch: "The box",
  title: "Disposable instances, precious volumes",
  html: `
    ${bx(60, 60, 320, 170, "instance i-07c3…", "Ubuntu · hermeticd · Hermes code<br>root volume", { b: 0, c: "acc iso", x: 1 })}
    ${tag(130, 120, "TERMINATED", { b: 1, c: "bad" })}
    ${bx(460, 60, 320, 170, "instance i-0b55…", "fresh boot · fresh bootstrap<br>new config render · current hermeticd", { b: 1, c: "acc iso" })}
    ${bx(260, 330, 320, 120, "vol-0a91… · /data", "the agent's memory, skills, sessions, browser profile", { b: 0, c: "ok" })}
    ${st(270, 470, "daily snapshot · keep 7", { b: 0, c: "dim" })}
    ${kick(60, 26, "agent recreate", { b: 1, st: "color:var(--acc)" })}

    ${kick(900, 26, "agent destroy", { b: 2, st: "color:var(--bad)" })}
    ${bx(900, 60, 300, 120, "instance", "terminated", { b: 2, c: "sm bad hatch iso" })}
    ${bx(900, 210, 300, 150, "MEMORY KEPT", "volume detached, default kept · row → destroyed (kept forever) · shows on the volumes lens as a tombstone", { b: 2, c: "sm ok", st: "border-top:4px dashed var(--fg3)" })}
    ${bx(1250, 210, 310, 150, "agent create --volume", "adopts the disk; its tag moves to the new name. A 10-minute reservation lock guards a disk no row owns yet.", { b: 3, c: "sm acc" })}
    ${bx(900, 400, 660, 220, "why this split", "Anything an agent learned lives on a separate encrypted EBS volume, so rebuilding a box is routine: a new AMI, a bigger instance, a broken root disk, a newer hermeticd — all are <b style='color:var(--fg)'>recreate</b>. Hermetic never guesses which disk holds an agent's memory: rollback never deletes a volume it merely found by tag, and deleting a volume is its own typed confirmation.", { b: 3, c: "sm" })}
  `,
  svg: `
    ${wire("M220 230 L380 330", { b: 0, c: "ok", end: false, w: "fat", x: 1 })}
    ${wire("M620 230 L460 330", { b: 1, c: "ok", end: false, w: "fat" })}
    ${wire("M394 145 L460 145", { flow: false, b: 1, c: "acc" })}
    ${wire("M1200 285 L1250 285", { flow: false, b: 3, c: "acc" })}
  `,
  beats: [
    {
      c: "The split that makes everything else cheap: an instance holds the OS and code; a separate EBS volume holds everything the agent has learned, and is snapshotted daily.",
      r: ["design.md §1 · instances are disposable"],
    },
    {
      c: "<code>agent recreate</code> terminates the instance and launches a fresh one onto the <b>same</b> volume — new bootstrap, new config render, current hermeticd. The fix for most things is a rebuild.",
      r: ["agents/lifecycle/recreate-agent.ts"],
    },
    {
      c: "<code>agent destroy</code> terminates the instance and, by default, keeps the volume. The dashboard shows it as a tombstone — <em>memory kept</em> — where the agent used to be.",
      r: ["agents/destroy-agent.ts", "volumes/"],
    },
    {
      c: "A new agent can adopt that disk later. hermetic refuses to guess which disk is whose: nothing it merely found by tag is ever deleted, and destroying memory always takes its own confirmation.",
      r: ["design.md §9.1", "agents/rollback.ts"],
    },
  ],
});
