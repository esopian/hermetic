/* Path: Standing up a fleet — for the operator who runs `init` and creates agents.
 *
 * Twelve stops from an empty account to a running fleet and back down again. The path's own scenes
 * (dep-*) carry a provisioning spine across the top: every stop, the ones already passed, and where
 * we are now. The stop number matches the scene counter in the caption band, so the library scenes
 * in between (re-narrated below for operators) keep their place on the route without one.
 */

const DEP_STOPS = [
  "Prereqs",
  "init",
  "Guard",
  "Foundation",
  "Release",
  "Policy",
  "Providers",
  "Create",
  "First boot",
  "Team",
  "Upgrades",
  "Teardown",
];

/** The provisioning spine: stops before `cur` are done, `cur` is lit, the rest are ahead. */
function depSpine(cur) {
  return `<div class="dep-spine">${DEP_STOPS.map(
    (s, i) =>
      `<div class="${i < cur ? "done" : i === cur ? "cur" : ""}"><b>${String(i + 1).padStart(2, "0")}</b>${s}</div>`,
  ).join("")}</div>`;
}

/** A numbered prerequisite card: a title, a body (snippet or text) and what goes wrong without it. */
function depCard(x, y, w, h, n, title, body, fail, o = {}) {
  return `<div class="dep-card up"${o.b != null ? ` data-b="${o.b}"` : ""} style="left:${x}px;top:${y}px;width:${w}px;height:${h}px">
    <div class="dh"><b>${n}</b>${title}</div>
    <div class="db">${body}</div>
    ${fail ? `<div class="df ${o.fc || "bad"}">${fail}</div>` : ""}
  </div>`;
}

/** One phase row of an op: number, phase id, what it does. */
function depRow(x, y, w, n, name, desc, o = {}) {
  return `<div class="dep-row ${o.c || ""} lf"${o.b != null ? ` data-b="${o.b}"` : ""}${o.h != null ? ` data-h="${o.h}"` : ""} style="left:${x}px;top:${y}px;width:${w}px">
    <span class="n">${n}</span><span class="p">${name}</span><span class="d">${desc}</span></div>`;
}

css(`
  .dep-spine { position:absolute; left:36px; top:12px; width:1528px; height:40px; display:grid;
    grid-template-columns:repeat(12, 1fr); gap:5px; font-family:var(--mono); font-size:11px; font-weight:700;
    letter-spacing:.08em; text-transform:uppercase; color:var(--fg3); }
  .dep-spine > div { border-top:4px solid var(--line2); padding-top:6px; white-space:nowrap; overflow:hidden; }
  .dep-spine > div b { margin-right:6px; color:inherit; }
  .dep-spine > div.done { border-top-color:var(--fg2); color:var(--fg2); }
  .dep-spine > div.cur { border-top-color:var(--acc); background:var(--acc); color:var(--acc-fg); padding-left:6px; }

  .dep-card { position:absolute; border:1.5px solid var(--fg); background:var(--bg); padding:10px 14px 12px;
    display:flex; flex-direction:column; gap:8px; }
  .dep-card .dh { font-weight:900; font-size:19px; letter-spacing:-.01em; display:flex; gap:10px; align-items:baseline; }
  .dep-card .dh b { font-family:var(--mono); font-size:12px; line-height:1; padding:4px 5px 3px; background:var(--acc);
    color:var(--acc-fg); align-self:center; }
  .dep-card .db { font-family:var(--mono); font-size:12.5px; color:var(--fg2); line-height:1.5; white-space:pre; flex:1;
    background:var(--bg); border:1px solid var(--line2); border-left:3px solid var(--fg3); padding:8px 10px; }
  .dep-card .db .k { color:var(--acc); }
  .dep-card .db .g { color:var(--ok); }
  .dep-card .db .c { color:var(--fg3); }
  .dep-card .db.txt { white-space:normal; background:transparent; border:0; padding:0; font-size:13px; }
  .dep-card .db.txt b { color:var(--fg); font-weight:700; }
  .dep-card .df { font-family:var(--mono); font-size:12px; font-weight:700; padding:4px 8px; border:1px solid; background:var(--bg); }
  .dep-card .df.bad { color:var(--bad); border-color:var(--bad); }
  .dep-card .df.warn { color:var(--warn); border-color:var(--warn); }

  .dep-row { position:absolute; height:40px; border:1.5px solid var(--line2); background:var(--bg);
    display:grid; grid-template-columns:30px 100px 1fr; align-items:center; gap:8px; padding:0 10px; }
  .dep-row .n { font-family:var(--mono); font-size:12px; color:var(--fg3); }
  .dep-row .p { font-family:var(--mono); font-size:13px; font-weight:700; color:var(--fg); }
  .dep-row .d { font-family:var(--mono); font-size:11.5px; color:var(--fg2); white-space:nowrap; overflow:hidden; }
  .dep-row.acc { border-color:var(--acc); }
  .dep-row.acc .p { color:var(--acc); }
  .dep-row.ok { border-color:var(--ok); }
  .dep-row.ok .p { color:var(--ok); }
  .dep-row.blue { border-color:var(--blue); }
  .dep-row.blue .p { color:var(--blue); }

  .dep-hd { position:absolute; font-family:var(--mono); font-size:12px; font-weight:700; letter-spacing:.14em;
    text-transform:uppercase; color:var(--fg3); }
  .dep-cmd { color:var(--fg); }
`);

glossary({
  "fleet directory":
    "The account-wide DynamoDB table (hermetic-directory, in us-east-1 by default) that lists every fleet in the account, so any operator's laptop can find one and attach to it.",
  tagOwners:
    "The section of a tailnet policy that says who may assign a tag. tag:hermetic needs an owner before an OAuth client can be created for it.",
  "HTTPS Certificates":
    "A tailnet setting (admin console → DNS) that lets Tailscale issue real TLS certificates. Every agent's dashboard needs it.",
  "change set":
    "CloudFormation's preview of a stack update. foundation update refuses one that would replace a stateful resource.",
  "create preset":
    "A machine bundle on your laptop — size, data volume, system disk — that agent create starts from. The built-in default is Standard: medium, 100 GiB data.",
  rollout:
    "plan rollout → apply: re-render every agent's config and converge the running boxes that are behind, one at a time by default.",
});

/* ---------------------------------------------------------------- 01 · prerequisites */
scene({
  id: "dep-prereqs",
  ch: "Before you start",
  title: "Six things to have before init",
  html: `
    ${depSpine(0)}
    ${depCard(
      20,
      74,
      506,
      272,
      "01",
      "An AWS profile",
      `<span class="c"># ~/.aws/config</span>
<span class="k">[profile acme-prod]</span>
sso_session    = acme
sso_account_id = 123456789012
sso_role_name  = Admin
region         = us-east-1`,
      "AWS_PROFILE / AWS_ACCESS_KEY_ID set → warned, ignored",
      { b: 0, fc: "warn" },
    )}
    ${depCard(
      547,
      74,
      506,
      272,
      "02",
      "Tailscale on this laptop",
      `<span class="c">$ tailscale status --json</span>
BackendState    <span class="g">"Running"</span>
MagicDNSSuffix  <span class="g">"acme.ts.net"</span>
CertDomains     <span class="g">[ … ]</span>   <span class="c">← stop 05</span>

<span class="c">the tailnet you are on is the tailnet
the fleet belongs to — detected, not typed</span>`,
      "TAILSCALE_UNAVAILABLE · init --create refuses",
      { b: 1 },
    )}
    ${depCard(
      1074,
      74,
      506,
      272,
      "03",
      "One tagOwners line, by hand",
      `<span class="c">// tailnet policy file · admin console → Access controls</span>
<span class="k">"tagOwners"</span>: {
  <span class="g">"tag:hermetic"</span>: [<span class="g">"autogroup:admin"</span>],
},

<span class="c">paste it first: the OAuth client form only
offers tags that already have an owner</span>`,
      "the only policy edit you make",
      { b: 2, fc: "warn" },
    )}
    ${depCard(
      20,
      366,
      506,
      272,
      "04",
      "A Tailscale OAuth client",
      `<span class="k">auth_keys</span>        write          tag:hermetic
<span class="k">devices:core</span>     read + write   tag:hermetic
<span class="k">policy_file</span>      tailnet-wide

<span class="c">auth_keys    mints each agent's join key
devices:core doctor's drift check; recreate
             and destroy delete stale devices
policy_file  hermetic keeps its ACL entries</span>`,
      "scopes are fixed: widening = new client + rotation",
      { b: 3, fc: "warn" },
    )}
    ${depCard(
      547,
      366,
      506,
      272,
      "05",
      "HTTPS Certificates on",
      `<span class="c">admin console → DNS</span>
MagicDNS             <span class="g">on</span>
HTTPS Certificates   <span class="g">on</span>

<span class="c">every agent serves its dashboard at
https://fxtr0001-atlas.acme.ts.net
via tailscale serve --https=443</span>`,
      "off → init --create refuses; doctor reports it",
      { b: 4 },
    )}
    ${depCard(
      1074,
      366,
      506,
      272,
      "06",
      "IAM, including the directory",
      `<span class="c">the fleet itself</span>
CloudFormation · DynamoDB · S3 · EC2 · SSM

<span class="c">every operator · us-east-1</span>
<span class="k">table/hermetic-directory</span>
CreateTable  DescribeTable  GetItem
PutItem  DeleteItem  <span class="k">Scan</span>  TagResource …`,
      "missing → DIRECTORY_UNAVAILABLE, even to attach",
      { b: 5 },
    )}
  `,
  beats: [
    {
      c: "Standing up a fleet is twelve stops, tracked along the top. First: an AWS profile in <code>~/.aws/config</code> — SSO, assume-role or static. hermetic reads that profile and nothing else; <code>AWS_PROFILE</code> and env keys are ignored, with a warning.",
      r: ["docs/operations.md · Prerequisites", "design.md §4.7"],
    },
    {
      c: "Tailscale installed and logged in on <b>your laptop</b>, with MagicDNS on. <code>init --create</code> reads <code>tailscale status</code> and refuses with <code>TAILSCALE_UNAVAILABLE</code> if it isn't — a fleet its own operator can't reach is no fleet at all.",
      r: ["packages/core/src/fleet/preflight.ts", "init --skip-tailscale-check (headless only)"],
    },
    {
      c: "One line pasted into your tailnet policy by hand, <em>before</em> you create the OAuth client — the client form only offers tags that already have an owner. It is the only policy edit you make; hermetic writes the rest itself.",
      r: ["design.md §5.2", "TAILSCALE_ADMIN_ACL_URL"],
    },
    {
      c: "An OAuth client, made by hand in the admin console — there is no API for it. Three scopes: <code>auth_keys</code> and <code>devices:core</code> tagged <code>tag:hermetic</code>, plus <code>policy_file</code>. Tailscale can't add a scope later, so widening means a new client and a rotation.",
      r: ["design.md §5", "secrets push _fleet --tailscale-oauth"],
    },
    {
      c: "HTTPS Certificates on, under DNS in the admin console. Every dashboard is served with <code>tailscale serve --https</code>, so <code>init --create</code> refuses without it rather than letting each box fail twenty minutes in. The cost: agent hostnames land in public CT logs.",
      r: ["design.md §4.7 · Tailscale preflight", "TAILSCALE_ADMIN_DNS_URL"],
    },
    {
      c: "IAM for the stack, tables, bucket, EC2 and SSM — and, for <b>every</b> operator, grants on the account-wide <code>hermetic-directory</code> table in us-east-1, <code>Scan</code> included. Without them even a re-attach stops at <code>DIRECTORY_UNAVAILABLE</code>.",
      r: ["design.md §4.8 · IAM", "README.md · Prerequisites"],
    },
  ],
});

/* ---------------------------------------------------------------- 02 · init */
const INIT_ROWS = [
  ["01", "profile", "picker over ~/.aws/config · region", 0],
  ["02", "identity", "sts get-caller-identity · alias · org", 0],
  ["03", "confirm", "you type the twelve-digit account id", 0],
  ["04", "directory", "ensure hermetic-directory · us-east-1", 1],
  ["05", "find", "DescribeStacks · tagged hermetic:fleet_id", 2],
  ["06", "preflight", "tailscale · certs · OAuth mint + revoke", 3],
  ["07", "foundation", "CloudFormation hermetic-&lt;fleet_id&gt;", 4],
  ["08", "tailscale", "OAuth secret → SSM /hermetic/&lt;fleet&gt;/…", 4],
  ["09", "fleet", "_fleet item · register in the directory", 4],
  ["10", "artifacts", "hermeticd + stages + mirrors → bucket", 4],
  ["11", "ready", "this home frozen to the new fleet", 4],
  ["12", "policy", "ssh + acls into the tailnet policy", 4],
];

scene({
  id: "dep-init",
  ch: "One-time setup",
  title: "hermetic init, phase by phase",
  html: `
    ${depSpine(1)}
    <div class="dep-hd" style="left:20px;top:70px">the init op · in order</div>
    ${INIT_ROWS.map(([n, p, d, b], i) => depRow(20, 92 + i * 45, 470, n, p, d, { b, c: i >= 5 ? "acc" : i === 4 ? "blue" : "" })).join("")}

    <div class="dep-hd" style="left:540px;top:70px">cli · abridged — phase names are the op's own</div>
    ${term(
      540,
      92,
      540,
      340,
      `<span class="p">$</span> hermetic init --create --profile acme-prod
<span class="c">identity  arn:aws:sts::123456789012:assumed-role/…</span>
type the account id › <span class="p">123456789012</span>
<span class="up" data-b="1"><span class="g">directory </span> hermetic-directory · us-east-1</span>
<span class="up" data-b="2"><span class="b">find      </span> no foundation here → create</span>
<span class="up" data-b="3">OAuth client secret › <span class="c">••••••••••••</span></span>
<span class="up" data-b="3"><span class="g">preflight </span> acme.ts.net · HTTPS certificates on</span>
<span class="up" data-b="4"><span class="y">foundation</span> Vpc CREATE_COMPLETE (3/31) …</span>
<span class="up" data-b="4"><span class="g">tailscale </span> secret stored · client id recorded</span>
<span class="up" data-b="4"><span class="g">fleet     </span> _fleet item · registered, no alias</span>
<span class="up" data-b="4"><span class="g">artifacts </span> hermeticd + stages → bucket</span>
<span class="up" data-b="4"><span class="g">ready     </span> home frozen to fxtr0001</span>
<span class="up" data-b="4"><span class="g">policy    </span> ssh + acls written between markers</span>`,
      { b: 0 },
    )}
    ${bx(540, 452, 540, 84, "found → attach", "read _fleet · look the fleet up in the directory · never rename it · publish this build's release only if it is newer · freeze", { b: 2, c: "sm blue" })}
    ${bx(540, 552, 540, 84, "flags for scripts and odd cases", "--attach / --create force a branch · --network nat · --skip-policy · --skip-artifacts · --confirm-account-id · --fleet &lt;id|alias&gt; to pick what to attach", { b: 3, c: "sm" })}

    <div class="dep-hd" style="left:1120px;top:70px">where it lands</div>
    ${bx(1120, 92, 460, 56, "~/.hermetic/hermetic.db", "a fleets row: profile, account, region, fleet_id", { b: 4, c: "xs acc" })}
    ${bx(1120, 156, 460, 56, "us-east-1 · hermetic-directory", "fleet/fxtr0001 · status active · no alias yet", { b: 1, c: "xs" })}
    ${bx(1120, 220, 460, 56, "CloudFormation · hermetic-fxtr0001", "VPC, tables, bucket, role — stop 04", { b: 4, c: "xs" })}
    ${bx(1120, 284, 460, 56, "SSM · /hermetic/fxtr0001/tailscale/*", "oauth-secret (SecureString) + oauth-client-id", { b: 4, c: "xs" })}
    ${bx(1120, 348, 460, 56, "S3 · manifest.json + artifacts/", "the release every box boots from — stop 05", { b: 4, c: "xs" })}
    ${bx(1120, 412, 460, 56, "tailnet policy", "hermetic's ssh + acls, between markers — stop 06", { b: 4, c: "xs blue" })}
    ${bx(1120, 488, 460, 148, "the app: the same op as a wizard", "1 profile · 2 connection check — an STS spinner, then a tick box beside the account id instead of typing it (core still re-verifies) · 3 foundation · 4 progress, which swaps to the dashboard on success", { b: 5, c: "sm acc" })}
  `,
  svg: `
    ${wire("M490 292 L515 292 L515 494 L540 494", { b: 2, c: "blue" })}
  `,
  beats: [
    {
      c: "<code>hermetic init</code> starts with you: pick a profile and region, let STS say whose credentials they are, and <b>type the twelve-digit account id</b> back. Not <code>y</code> — the digits. Nothing has been created yet.",
      r: ["packages/core/src/fleet/init.ts", "design.md §4.7 steps 1–3"],
    },
    {
      c: "Next it makes sure the account's fleet directory exists in us-east-1 — on every <code>init</code>, attach or create. If it can't, <code>DIRECTORY_UNAVAILABLE</code> stops everything before a stack is touched.",
      r: ["fleet/init-directory.ts", "--directory-region"],
    },
    {
      c: "Then it looks for a foundation tagged <code>hermetic:fleet_id</code>. Found: <b>attach</b> — the new-laptop and new-teammate path. Not found: <b>create</b>. <code>--attach</code> and <code>--create</code> force one and fail on the other.",
      r: ["fleet/init-attach.ts", "fleet/init-create.ts"],
    },
    {
      c: "Create runs the preflight before any mutation: Tailscale running and logged in, certificates on, and the OAuth secret proven by minting and revoking a <code>tag:hermetic</code> key. No hermeticd to publish is <code>HERMETICD_UNAVAILABLE</code>.",
      r: ["fleet/preflight.ts", "init.verifyTailscaleOauth"],
    },
    {
      c: "Then the build: the stack, the OAuth secret into SSM, the <code>_fleet</code> item and its directory entry, the release into the bucket, your home frozen — and <b>last</b> the tailnet policy, so an earlier failure leaves the policy untouched.",
      r: ["fleet/init-create.ts", "fleet/init-release.ts"],
    },
    {
      c: "The desktop app runs the same core op as a four-step wizard the first time it opens on an uninitialized home. It swaps typing for a tick box beside the resolved account id — core re-checks it against STS either way.",
      r: ["docs/ui-brief.md · Init wizard", "packages/ui/src/components/InitWizard.tsx"],
    },
  ],
});

/* ---------------------------------------------------------------- 07 · provider profiles */
scene({
  id: "dep-providers",
  ch: "Agents",
  title: "Provider profiles: which model, whose key",
  html: `
    ${depSpine(6)}
    ${term(
      20,
      70,
      620,
      262,
      `<span class="p">$</span> hermetic providers ls
<span class="c">bedrock  bedrock  role · ready      ← default</span>
<span class="up" data-b="1"><span class="p">$</span> hermetic providers create --provider anthropic \\
    --name main --default
<span class="c">API key › ••••••••••••••••   (prompt, never a flag)</span></span>
<span class="up" data-b="1"><span class="p">$</span> cat key.txt | hermetic providers create \\
    --provider openrouter --name cheap --api-key-stdin</span>
<span class="up" data-b="3"><span class="p">$</span> hermetic agent create atlas --provider-profile cheap</span>`,
      { b: 0 },
    )}
    ${bx(20, 348, 620, 70, "which profile a create uses", "--provider-profile &lt;id|name&gt;  →  --provider &lt;p&gt; (AMBIGUOUS_PROFILE if two)  →  the fleet default", { b: 2, c: "sm acc" })}

    ${bx(680, 70, 280, 156, "bedrock", "credential: the instance role<br>no slot · nothing to rotate<br>model must be in the fleet's grant<br><br><b style='color:var(--fg)'>a fresh fleet's default</b>", { b: 0, c: "sm ok" })}
    ${bx(980, 70, 290, 156, "main · anthropic", "slot: /hermetic/fxtr0001/<br>secrets/profile-&lt;id&gt;<br>revision r3<br><br><b style='color:var(--fg)'>default after --default</b>", { b: 1, c: "sm acc" })}
    ${bx(1290, 70, 290, 156, "cheap · openrouter", "slot: /hermetic/fxtr0001/<br>secrets/profile-&lt;id&gt;<br>revision r1", { b: 1, c: "sm" })}

    ${bx(680, 262, 400, 88, "fleet slot · laptop-only", "/hermetic/fxtr0001/secrets/profile-&lt;id&gt; — no instance role may read it", { b: 3, c: "sm" })}
    ${bx(1180, 262, 400, 88, "the agent's own slot", "/hermes/fxtr0001/atlas/provider-key-&lt;id&gt;-r3 — a snapshot of one revision", { b: 3, c: "sm ok" })}
    ${tag(680, 366, "Bedrock model outside the grant → MODEL_NOT_GRANTED · foundation update grants it", { b: 3, c: "bad" })}

    ${zone(20, 446, 1560, 190, "rotating a key · nothing moves under a running agent", { b: 4, c: "acc solid" })}
    ${bx(44, 478, 280, 96, "providers update main --api-key-stdin", "new key in the fleet slot", { b: 4, c: "xs" })}
    ${bx(352, 478, 280, 96, "revision r3 → r4", "every edit bumps it, rotation included", { b: 4, c: "xs" })}
    ${bx(660, 478, 280, 96, "agent ps", "PROFILE column: update available", { b: 4, c: "xs warn" })}
    ${bx(968, 478, 280, 96, "agent set atlas --refresh-profile", "staged: pending apply", { b: 4, c: "xs" })}
    ${bx(1276, 478, 280, 96, "plan rollout → apply", "copies r4 into a new slot, converges the box", { b: 4, c: "xs ok" })}
    ${txt(44, 590, 1500, "The Tailscale OAuth client rotates the same way in spirit: <span class='mono dep-cmd'>printf '%s' \"$SECRET\" | hermetic secrets push _fleet --tailscale-oauth</span> — proven before it is stored.", { b: 4, st: "font-size:14px" })}
  `,
  svg: `
    ${wire("M1080 306 L1180 306", { b: 3, c: "ok" })}
    ${lbl(1130, 296, "at create", { b: 3, anchor: "middle" })}
    ${wire("M324 526 L352 526", { b: 4, c: "acc", w: "thin" })}
    ${wire("M632 526 L660 526", { b: 4, c: "acc", w: "thin" })}
    ${wire("M940 526 L968 526", { b: 4, c: "acc", w: "thin" })}
    ${wire("M1248 526 L1276 526", { b: 4, c: "acc", w: "thin" })}
  `,
  beats: [
    {
      c: "Before creating agents, decide what they run on. A <b>provider profile</b> is a named provider, model and credential. A fresh fleet starts with one: Bedrock, authenticated by the instance role — no key to type, and it is the default.",
      r: ["design.md §8.3", "packages/core/src/profiles/provider-profiles.ts"],
    },
    {
      c: "For a keyed provider, <code>hermetic providers create</code>. The key comes from a prompt or <code>--api-key-stdin</code>, never a flag — flags land in shell history and the <code>runs</code> table — and goes straight into the fleet's own SSM slot.",
      r: ["packages/cli/src/commands/providers.ts", "design.md §8.2"],
    },
    {
      c: "<code>--default</code> (or <code>settings set --default-profile</code>) picks what a bare <code>agent create</code> uses. Per agent: <code>--provider-profile</code>, or <code>--provider</code> as shorthand — refused as <code>AMBIGUOUS_PROFILE</code> when the fleet has two.",
      r: ["profiles/profile-binding.ts", "design.md §10"],
    },
    {
      c: "At create, your laptop copies the key into the agent's own slot, named for the profile and revision — the box can never read the fleet slot. A Bedrock model the fleet's role may not invoke is refused, not swapped.",
      r: ["profiles/profile-apply.ts", "MODEL_NOT_GRANTED"],
    },
    {
      c: "Rotating a key bumps the profile's revision and marks its agents <em>update available</em> — nothing restarts underneath them. <code>agent set --refresh-profile</code> stages it; <code>plan rollout</code> → <code>apply</code> delivers it.",
      r: ["design.md §8.3 · binding", "hermetic plan rollout"],
    },
  ],
});

/* ---------------------------------------------------------------- 10 · more operators, more fleets */
scene({
  id: "dep-team",
  ch: "Running it",
  title: "More operators, more fleets",
  html: `
    ${depSpine(9)}
    ${zone(20, 80, 420, 290, "your laptop · ~/.hermetic", { b: 0, c: "solid" })}
    ${code(
      40,
      106,
      380,
      120,
      "hermetic.db · fleets",
      `fxtr0001  <span class="s">main</span>     us-east-1  <span class="a">default</span>
<span class="up" data-b="2">sg7k2m4p  <span class="s">staging</span>  us-west-2</span>`,
      { b: 0 },
    )}
    ${term(
      40,
      240,
      380,
      114,
      `<span class="up" data-b="2"><span class="p">$</span> hermetic init --create --region us-west-2
<span class="p">$</span> hermetic fleet alias sg7k2m4p staging</span>
<span class="up" data-b="3"><span class="p">$</span> hermetic fleet use main
<span class="p">$</span> hermetic agent ps --fleet staging</span>`,
      { b: 2 },
    )}
    ${txt(20, 390, 420, "Only <b>this laptop's</b> facts live here: the profile name, the run log, presets. Agents, settings and profiles live in the account. A lost laptop is <span class='mono'>hermetic init</span> again — it auto-attaches.", { b: 4, st: "font-size:15px" })}
    ${tag(20, 512, "two+ fleets frozen → teardown demands --fleet", { b: 4, c: "warn" })}

    ${zone(480, 80, 640, 556, "AWS account 123456789012", { b: 0, c: "acc solid" })}
    ${code(
      500,
      108,
      600,
      150,
      "us-east-1 · hermetic-directory",
      `fleet/fxtr0001   alias <span class="s">main</span>     active · v15
<span class="up" data-b="2">fleet/sg7k2m4p   alias <span class="s">staging</span>  active · v15</span>
alias/main     → fxtr0001
<span class="up" data-b="2">alias/staging  → sg7k2m4p</span>`,
      { b: 0 },
    )}
    ${bx(500, 282, 290, 110, "hermetic-fxtr0001", "us-east-1 · 12 agents<br>its own VPC, tables, bucket, role", { b: 0, c: "sm" })}
    ${bx(810, 282, 290, 110, "hermetic-sg7k2m4p", "us-west-2 · 2 agents<br>nothing shared with main", { b: 2, c: "sm" })}
    ${bx(500, 414, 600, 200, "the shared truth, and how two operators stay out of each other's way", "agent rows, _fleet settings, provider profiles and events live in each fleet's DynamoDB tables — every laptop reads the same answers. Every create, recreate, stop, start and destroy takes a per-agent lock with a ten-minute TTL: a second operator gets <b style='color:var(--fg)'>LOCKED</b>, and a lock left by a crashed laptop simply expires. Writes are version-checked, so a stale form is a CONFLICT, not an overwrite.", { b: 4, c: "sm" })}

    ${zone(1160, 80, 420, 250, "a teammate's laptop", { b: 0, c: "blue solid" })}
    ${term(
      1180,
      106,
      380,
      84,
      `<span class="p">$</span> hermetic init --attach
type the account id › <span class="p">123456789012</span>
<span class="g">attached to fleet fxtr0001 as "main"</span>`,
      { b: 0 },
    )}
    ${tag(1180, 206, "older hermetic than the fleet → FOUNDATION_NEWER", { b: 1, c: "bad" })}
    ${tag(1180, 240, "not on the fleet's tailnet → warned, proceeds", { b: 1, c: "warn" })}
    ${tag(1180, 274, "attach never renames · their own profile + IAM", { b: 1 })}

    ${bx(1160, 350, 420, 286, "which fleet a bare command means", "", {
      b: 3,
      c: "sm acc",
      html: `<div class="list" style="position:static;margin-top:6px">${[
        ["acc", "<span class='m'>--fleet &lt;id|alias&gt;</span> — either side of the subcommand"],
        ["acc", "<span class='m'>HERMETIC_FLEET</span> — for one shell"],
        ["acc", "<span class='m'>fleet use</span> — this laptop's default"],
        ["", "the only fleet frozen here"],
        ["bad", "else <span class='m'>FLEET_REQUIRED</span>, naming the candidates"],
      ]
        .map(([c, h]) => `<div class="li ${c}"><i></i><div>${h}</div></div>`)
        .join(
          "",
        )}</div><div class="s" style="margin-top:10px">every command's stderr header leads with the fleet:<br><span style="color:var(--fg)">▸ main · acme-prod · 123456789012 · us-east-1</span></div>`,
    })}
  `,
  svg: `
    ${wire("M1160 150 L1100 150", { b: 0, c: "blue" })}
    ${wire("M440 160 L500 160", { b: 2, c: "acc" })}
  `,
  beats: [
    {
      c: "A teammate joins with their own laptop, profile and IAM — directory grants included — and runs <code>hermetic init --attach</code> (a plain <code>init</code> attaches on its own when a foundation exists). They type the account id too.",
      r: ["fleet/init-attach.ts", "design.md §4.7 · attach"],
    },
    {
      c: "Attach refuses <code>FOUNDATION_NEWER</code> when their hermetic is older than the fleet's foundation — upgrade, then attach again. Being off the fleet's tailnet is only a warning, and attach never relabels a fleet.",
      r: ["fleet/init-attach.ts", "design.md §4.7"],
    },
    {
      c: "A second fleet is <code>init --create</code> again, in the same home: a new <code>fleet_id</code>, its own stack, <b>no alias</b>. <code>fleet alias &lt;id&gt; staging</code> labels it; aliases are unique account-wide, torn-down fleets included.",
      r: ["design.md §4.6", "packages/cli/src/commands/fleets.ts"],
    },
    {
      c: "With two fleets frozen, every command resolves one: <code>--fleet</code>, then <code>HERMETIC_FLEET</code>, then <code>fleet use</code>'s default — else <code>FLEET_REQUIRED</code>. The id always wins over an alias, and the header names the fleet first.",
      r: ["fleet/fleet-select.ts", "design.md §4.6 · selection"],
    },
    {
      c: "Each home holds only its own laptop's facts; the fleet's truth is in the account. Ten-minute agent locks keep two operators apart, and with two fleets frozen, <code>teardown</code> won't run without an explicit <code>--fleet</code>.",
      r: ["design.md §4.4", "operations.md · Recovery scenarios"],
    },
  ],
});

/* ---------------------------------------------------------------- 11 · upgrades */
const UPG_ROWS = [
  [
    "a new hermetic build",
    "app update, or your own commit",
    "hermetic artifacts push",
    "a new generation in the bucket; the manifest names it",
    "nightly, 03:00–03:59 UTC: digest differs → verify, swap, restart hermeticd",
  ],
  [
    "a hermeticd someone else pushed",
    "a version already in the bucket",
    "hermetic upgrade --hermeticd &lt;ver&gt;",
    "fleet-wide only: no name, no --all — rewrites the manifest pointer",
    "the same nightly digest check, box by box",
  ],
  [
    "a new Hermes upstream tag",
    "a build that pins it (hermes_ref)",
    "artifacts push · upgrade atlas --hermes &lt;ver&gt;",
    "one agent first, or --all, one at a time",
    "on that agent's next agent recreate",
  ],
  [
    "an agent's config",
    "agent set, a profile change",
    "plan rollout [--agent atlas] → apply",
    "one step per agent; --concurrency 1 by default",
    "converged in place — no new instance",
  ],
  [
    "the foundation contract",
    "FOUNDATION_VERSION, now 15",
    "plan foundation → foundation update",
    "archive · change set · release · migrate",
    "rollout: every ready agent asked to take the new binary",
  ],
];

scene({
  id: "dep-upgrade",
  ch: "Running it",
  title: "Keeping a fleet current",
  html: `
    ${depSpine(10)}
    <div class="dep-hd" style="left:20px;top:68px">what changed</div>
    <div class="dep-hd" style="left:420px;top:68px">what you run</div>
    <div class="dep-hd" style="left:1060px;top:68px">when a box sees it</div>
    ${UPG_ROWS.map(
      ([what, sub, cmd, cmdSub, box], i) => `
      ${bx(20, 88 + i * 84, 360, 72, what, sub, { b: i, c: "sm" })}
      ${bx(420, 88 + i * 84, 600, 72, `<span class='mono' style='font-size:14px'>${cmd}</span>`, cmdSub, { b: i, c: "sm acc" })}
      ${bx(1060, 88 + i * 84, 520, 72, "", box, { b: i, c: `sm ${i === 2 ? "warn" : "ok"}`, st: "justify-content:center" })}`,
    ).join("")}
    ${bx(20, 516, 500, 120, "agent rerun atlas", "same machine · agent must be in error · resumes the failed bootstrap stage · picks up nothing new", { b: 5, c: "sm" })}
    ${bx(540, 516, 500, 120, "agent recreate atlas --yes", "new instance, same data volume · fresh bootstrap from the current release, pin and config · deletes the old tailnet device", { b: 5, c: "sm acc" })}
    ${bx(1060, 516, 520, 120, "hermetic doctor", "read-only: DynamoDB vs EC2 vs Tailscale devices, the account/fleet guard, network mode, the Bedrock grant, inbound rules", { b: 5, c: "sm ok" })}
  `,
  svg: `
    ${[0, 1, 2, 3, 4].map((i) => `${wire(`M380 ${124 + i * 84} L420 ${124 + i * 84}`, { b: i, c: "acc", w: "thin" })}${wire(`M1020 ${124 + i * 84} L1060 ${124 + i * 84}`, { b: i, c: i === 2 ? "warn" : "ok", w: "thin" })}`).join("")}
  `,
  beats: [
    {
      c: "Nothing converges on its own: each kind of change has one command. A new hermetic build is <code>artifacts push</code> — committed tree only — and each box's nightly tick notices the new digest, verifies it, swaps and restarts.",
      r: ["design.md §6.5", "packages/agentd/src/update/"],
    },
    {
      c: "To move the fleet to a hermeticd release already in the bucket, <code>upgrade --hermeticd &lt;ver&gt;</code>. It is fleet-wide by definition — it only repoints the fleet manifest — so it takes no agent name and no <code>--all</code>.",
      r: ["design.md §6.5", "hermetic upgrade --help"],
    },
    {
      c: "Hermes moves deliberately. <code>foundation status</code> says when upstream has a newer tag; a build pinning it plus <code>artifacts push</code> mirrors it, then <code>upgrade atlas --hermes</code> and a <code>recreate</code>, one agent first.",
      r: ["operations.md · Knowing when to bump Hermes", "BUILD_VERSIONS.hermes_ref"],
    },
    {
      c: "Config changes — <code>agent set</code>, a refreshed profile — are re-rendered at once but reach a box only by <code>plan rollout</code> → <code>apply</code>, which converges running agents one at a time, or by a <code>recreate</code>.",
      r: ["design.md §6.5 · plan rollout", "operations.md · Day to day"],
    },
    {
      c: "A new foundation contract: read <code>plan foundation</code>, then <code>foundation update</code>. It archives state first, refuses a change set that would replace a stateful resource, migrates, then rolls the new hermeticd out.",
      r: ["design.md §6.6", "FOUNDATION_UPDATE_FAILED"],
    },
    {
      c: "<code>rerun</code> resumes a failed boot on the same machine; <code>recreate</code> is a new machine on the same memory, built from today's release. When the fleet feels off, run <code>doctor</code> before you trust <code>agent ps</code>.",
      r: ["design.md §6.5", "packages/core/src/fleet/doctor.ts"],
    },
  ],
});

/* ---------------------------------------------------------------- the path */
pathway({
  id: "deploy",
  title: "Standing up a fleet",
  audience: "Operators",
  level: 3,
  minutes: 13,
  color: "var(--acc)",
  tagline: "From an empty AWS account to running agents and back: every command, in order.",
  learn: [
    "The prerequisites, and what init builds, where",
    "Creating agents, and what to do when a boot fails",
    "Teammates, second fleets, upgrades and teardown",
  ],
  next: ["security", "contrib"],
  outro:
    "You have the whole route: prerequisites, init, the foundation and its policy, provider profiles, agents from create to ready, teammates and second fleets, upgrades, and the way back down. <code>docs/operations.md</code> is the runbook to keep open.",
  chapters: [
    { name: "Before you start", items: ["dep-prereqs"] },
    { name: "One-time setup", items: ["dep-init", "guard", "foundation", "release", "tailnet"] },
    { name: "Agents", items: ["dep-providers", "create", "boot"] },
    { name: "Running it", items: ["dep-team", "dep-upgrade", "plan"] },
  ],
  overrides: {
    guard: {
      title: "The frozen account, from the operator's chair",
      beats: [
        {
          c: "When <code>init</code> finishes, this home is frozen: profile, account, region and <code>fleet_id</code>. The alias is only a label. The twelve digits you typed are the last time hermetic takes your word for which account this is.",
          r: ["design.md §4.6–4.7", "hermetic config show"],
        },
        {
          c: "From here every AWS call uses the frozen profile explicitly. <code>AWS_PROFILE</code> or a static <code>AWS_ACCESS_KEY_ID</code> in your shell is ignored — and warned about, because otherwise the SDK would quietly prefer it.",
          r: ["packages/core/src/aws/client.ts"],
        },
        {
          c: "The first AWS call in each command asks STS who your credentials really are. If the account matches the frozen one, the command proceeds; the check costs one call per process.",
          r: ["aws/client.ts · verify()"],
        },
        {
          c: "If it doesn't — a switched SSO session, an edited profile, a different role — you get <code>ACCOUNT_MISMATCH</code> (exit code 4) before anything is sent. Fix the profile or the session; there is no flag to override it.",
          r: ["operations.md · Recovery scenarios", "hermetic help exit-codes"],
        },
        {
          c: "The check lives in the only place hermetic builds AWS clients, so no command can skip it. To point a home at a different account on purpose: <code>hermetic init --reset</code>, with the same typed confirmation and a new <code>fleet_id</code>.",
          r: ["aws/client.ts · guardClient", "hermetic init --reset"],
        },
        {
          c: "Mutations also check <b>which fleet</b>: a stack tagged for another fleet is <code>FLEET_MISMATCH</code> — usually the wrong <code>HERMETIC_HOME</code> or <code>--fleet</code>. Every command prints its target to stderr first, so you always see it.",
          r: ["design.md §4.7", "operations.md · FLEET_MISMATCH"],
        },
      ],
    },
    foundation: {
      title: "What init --create builds",
      beats: [
        {
          c: "<code>init --create</code> builds one CloudFormation stack, <code>hermetic-&lt;fleet_id&gt;</code>, from a template inside hermetic, narrated resource by resource. It is the fleet's only infrastructure-as-code; agents are made later by direct API calls.",
          r: ["design.md §5", "packages/core/src/fleet/init-create.ts"],
        },
        {
          c: "Everything is named and tagged for the fleet — <code>hermetic-fxtr0001-agents</code>, the bucket, the role — so in the AWS console you can tell fleets apart, and a second fleet in the account never collides with this one.",
          r: ["design.md §5 · naming"],
        },
        {
          c: "A dedicated dual-stack VPC with public subnets, plus free gateway endpoints that keep S3 and DynamoDB traffic on AWS's network.",
          r: ["foundation template"],
        },
        {
          c: "One security group with <b>zero inbound rules</b>. Leave it that way: <code>agent create</code> refuses with <code>SG_INBOUND_RULE</code> if someone adds one, and <code>doctor</code> reports it.",
          r: ["design.md §5", "hermetic doctor"],
        },
        {
          c: "The default network mode is <b>public</b>: a public IPv4 per agent with nothing listening on it. <code>init --network nat</code> puts agents behind a <code>t4g.nano</code> NAT instance with a stable egress IP. Switch later with <code>plan network --to</code> → <code>apply</code>.",
          r: ["design.md §5 · network mode", "hermetic network status"],
        },
        {
          c: "The bucket is versioned and private, the tables pay per request, and every data volume gets a daily snapshot, keeping seven. In public mode the foundation has no always-on cost beyond each agent's public IPv4.",
          r: ["design.md §5", "design.md §7.1"],
        },
      ],
    },
    release: {
      title: "Publishing hermeticd into the fleet",
      beats: [
        {
          c: "Boxes install hermetic's code only from <b>your fleet's bucket</b>. <code>init</code> publishes it, and later <code>hermetic artifacts push</code> does. From a checkout, the tree must be committed — else <code>WORKING_TREE_DIRTY</code>.",
          r: ["release/artifacts.ts", "release/git.ts · HERMETIC_ALLOW_DIRTY"],
        },
        {
          c: "The installed app carries hermeticd and its stages inside <code>Hermetic.app</code>, so a push needs no build. Each push is an immutable generation keyed by its digests; a push that dies halfway is never seen by any box.",
          r: ["design.md §3.6", "release/artifacts-release.ts"],
        },
        {
          c: "<code>manifest.json</code> is written last and is what every box reads: which release, which tables, which bucket. A manifest naming files outside its release is refused on both ends as <code>MANIFEST_REFUSED</code>.",
          r: ["release/artifacts-manifest.ts"],
        },
        {
          c: "The push also mirrors the pinned Hermes source and Chrome build into the bucket. Both fail soft — a <code>mirror_warning</code> or <code>browser_warning</code> — and boxes need foundation v7 and v14 to read them.",
          r: ["release/hermes-mirror.ts", "release/browser-mirror.ts"],
        },
        {
          c: "<code>agent create</code> and <code>rerun</code> warn when your build differs from the published one. A config needing something the published hermeticd can't do is refused on your laptop, naming <code>artifacts push</code>.",
          r: ["design.md §3.6", "AGENT_CONFIG_CAPABILITIES"],
        },
        {
          c: "Hermes itself is pinned per agent, and Hermes's own updater refuses to run on the box. The version moves only when you say so: <code>hermetic upgrade --hermes</code>, one agent at a time (stop 11).",
          r: ["design.md §6.4", "agentd/src/apply/hermes.ts"],
        },
      ],
    },
    tailnet: {
      title: "The tailnet policy hermetic keeps for you",
      beats: [
        {
          c: "Every agent joins your tailnet as <code>tag:hermetic</code> with a key minted for it alone by the fleet's OAuth client: single-use, one-hour, pre-authorised. Your laptop reaches agents only this way.",
          r: ["design.md §6.2 step 3"],
        },
        {
          c: "The <code>tagOwners</code> line was yours. As its last phase, <code>init</code> writes the other two entries — an <code>ssh</code> rule and an <code>acls</code> rule — between <code>// hermetic:managed</code> markers.",
          r: ["packages/core/src/fleet/policy.ts", "design.md §5.2"],
        },
        {
          c: "The managed rule admits every tailnet member to 22 (SSH), 443 (dashboard and live browser) and 7434 (log RPC) on tagged nodes. The dashboard has no login: whoever your ACL admits can drive every agent. Keep it tight.",
          r: ["operations.md · Prerequisites", "design.md §5.2"],
        },
        {
          c: "<code>hermetic policy</code> shows the scope, each block's state and a diff. Edit <em>inside</em> the markers and the block reads <code>drifted</code>, to be overwritten on the next apply. Keep your own edits outside them.",
          r: ["hermetic policy", "fleet/hujson.ts"],
        },
        {
          c: "<code>plan policy --json &gt; policy.json</code>, then <code>apply policy.json</code>. Tailscale validates the result first, and the write carries the ETag it was planned against — an edit made in between is <code>CONFLICT</code>.",
          r: ["operations.md · The tailnet policy", "policy.ts · applyManagedBlocks"],
        },
        {
          c: "Policy kept in git? <code>init --create --skip-policy</code>, then paste what <code>hermetic policy</code> prints. Skip that paste and <code>agent create</code> still succeeds — but nothing it makes will be reachable.",
          r: ["design.md §5.2", "init --skip-policy"],
        },
      ],
    },
    create: {
      title: "hermetic agent create atlas",
      beats: [
        {
          c: "<code>hermetic agent create atlas</code> claims the name with a conditional write and a ten-minute lock — <code>NAME_TAKEN</code> if it exists. The machine comes from your default create preset: Standard, a <code>medium</code> with 100 GiB of data.",
          r: ["agents/lifecycle/create-agent.ts", "hermetic presets show"],
        },
        {
          c: "It opens the agent's SSM slot for its Tailscale key. hermetic manages where a secret lives, never a copy of it.",
          r: ["design.md §8.2"],
        },
        {
          c: "It mints the agent's join key with the fleet's OAuth client and pushes it into that slot. A client that can no longer mint fails here, before any machine exists.",
          r: ["design.md §6.2 step 3"],
        },
        {
          c: "It copies the provider profile's key into the agent's own slot, on your laptop. Bedrock skips this: the instance role is the credential.",
          r: ["profiles/profile-apply.ts"],
        },
        {
          c: "It renders the agent's final config and uploads it — refused here if the published hermeticd lacks a capability the config needs, which <code>artifacts push</code> fixes.",
          r: ["render/render.ts", "design.md §3.6"],
        },
        {
          c: "It creates the encrypted data volume, the agent's memory. <code>--volume-gib</code> sizes it; <code>--volume vol-…</code> builds the agent on an existing one instead — how a destroyed agent's memory comes back.",
          r: ["design.md §9.1", "hermetic volume ls"],
        },
        {
          c: "It launches the instance with a five-field user-data blob and attaches the volume. Use <code>--size</code>, <code>--preset</code> or <code>--instance-type</code> for another machine; <code>--provider-profile</code> for another credential.",
          r: ["schema/userdata.ts", "hermetic agent create --help"],
        },
        {
          c: "It releases the lock; the box reports from here. End to end takes about eight minutes — watch it with <code>hermetic agent status atlas</code> or the dashboard's create drawer, which reattaches if you close it.",
          r: ["operations.md · Creating the first agent"],
        },
        {
          c: "If a create fails, run it again — every step checks what exists first, from any laptop. <code>--rollback-on-failure</code> undoes what the run made instead; Ctrl-C never rolls back; <code>agent destroy atlas --yes</code> clears the rest.",
          r: ["agents/rollback.ts", "design.md §4.5"],
        },
      ],
    },
    boot: {
      title: "First boot, and when it fails",
      beats: [
        {
          c: "You don't touch the box. It boots stock Ubuntu; cloud-init fetches hermeticd from the presigned URL, checks its digest and hands over. <code>agent status atlas</code> shows the row move from <code>creating</code>.",
          r: ["render/cloud-init.ts", "design.md §6.3"],
        },
        {
          c: "hermeticd reads the fleet manifest you published, fetches and verifies every stage, and the row moves to <code>bootstrapping</code>. Each stage's progress appears under <code>bootstrap.stages</code>.",
          r: ["packages/agentd/src/bootstrap.ts", "hermetic agent status"],
        },
        {
          c: "The early stages join the tailnet with the one-shot key, mount the data volume at <code>/data</code>, and fetch and validate the config you rendered at create.",
          r: ["packages/agentd/stages/01-tailscale.sh"],
        },
        {
          c: "<code>04-apply</code> installs and configures everything; <code>06-verify</code> checks the mount, the tailnet, both Hermes units, and that Hermes really has a provider, model and key — so a misconfigured agent fails here, not at your first message.",
          r: ["stage verify-hermes", "operations.md"],
        },
        {
          c: "All green: <code>ready</code>, and the dashboard is at <code>https://fxtr0001-atlas.&lt;tailnet&gt;.ts.net</code>. A heartbeat every 30 seconds keeps the row current; a failing health check shows as <code>degraded</code>.",
          r: ["packages/agentd/src/heartbeat.ts", "hermetic agent ps"],
        },
        {
          c: "A failed stage turns the row to <code>error</code>. <code>hermetic agent history atlas</code> carries its last 120 log lines — no connection needed. <code>logs atlas</code> streams the full log; <code>logs atlas --console</code> reads the serial console if the box never got that far.",
          r: ["AGENTS.md · Debug a failure on the box", "hermetic logs --help"],
        },
        {
          c: "Fix the cause — a bad slot value, a flaky apt mirror — then <code>hermetic agent rerun atlas</code>: it resumes at the failed stage on the same machine. Secrets never travel in a stage's environment or arguments, and the log tail is redacted.",
          r: ["operations.md · Bootstrap failed on a stage", "design.md §6.3"],
        },
      ],
    },
    plan: {
      title: "Destroy and teardown",
      beats: [
        {
          c: "Removal is plan first. <code>hermetic plan destroy atlas</code> lists every step and changes nothing: terminate, tailnet device, secrets, config, the record — and the data volume only with <code>--delete-volume</code>.",
          r: ["design.md §6.7", "hermetic plan destroy"],
        },
        {
          c: "<code>hermetic agent destroy atlas --yes</code> runs it; without <code>--yes</code> the CLI asks. Or save <code>plan destroy atlas --json</code> and <code>hermetic apply</code> that file. In the app, the button waits for the typed name.",
          r: ["packages/cli/src/confirm.ts", "hermetic apply"],
        },
        {
          c: "<code>apply</code> runs exactly the plan you read, only on the fleet it names. If the agent was recreated since, it refuses <code>PLAN_STALE</code>. The volume is kept by default — <code>volume ls</code> finds it later.",
          r: ["packages/core/src/agents/plan-apply.ts", "hermetic volume ls"],
        },
        {
          c: "Teardown removes the foundation. Destroy every agent first (<code>AGENTS_EXIST</code>), read <code>plan teardown</code>, then run <code>teardown --yes</code> with the account id typed or passed as <code>--confirm-account-id</code>.",
          r: ["packages/core/src/fleet/teardown.ts", "operations.md · Teardown"],
        },
        {
          c: "Leftover volumes and snapshots stay unless you pass <code>--delete-volumes</code> or <code>--delete-snapshots</code>. Afterwards, by hand: the OAuth client, any tailnet devices, and the policy entries — teardown leaves your tailnet policy unchanged.",
          r: ["design.md §5.2 · one-directional", "hermetic teardowns --last"],
        },
      ],
    },
  },
});
