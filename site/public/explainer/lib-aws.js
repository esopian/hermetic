/* Chapter 3 — AWS: the frozen account, the foundation, the box's IAM, the tailnet perimeter. */

scene({
  id: "guard",
  ch: "AWS",
  title: "One home, one account, frozen",
  html: `
    ${code(
      40,
      30,
      380,
      196,
      "~/.hermetic/hermetic.db · frozen config",
      `profile     <span class="s">acme-prod</span>
account_id  <span class="a">123456789012</span>
region      <span class="s">us-east-1</span>
fleet_id    <span class="a">fxtr0001</span>
alias       <span class="s">main</span>   <span class="c">// display only</span>
frozen_at   2026-09-01T…`,
      { b: 0 },
    )}
    ${term(
      40,
      246,
      380,
      104,
      `<span class="c">confirm the target account</span>
type the account id › <span class="p">123456789012</span><span class="cur"></span>
<span class="c">(not "y" — the twelve digits)</span>`,
      { b: 0 },
    )}

    ${bx(470, 70, 190, 70, "core op", "agents.destroy(…)", { b: 1, c: "sm" })}
    ${bx(470, 200, 330, 150, "aws.client()", "the only way core builds an SDK client.<br>fromIni({ profile }) — env chain ignored.<br>send() is wrapped:<br><span style='color:var(--acc)'>await assertAccount()</span> first", { b: 1, c: "acc" })}
    ${bx(880, 30, 290, 84, "STS", "GetCallerIdentity → Account<br>once per process, cached", { b: 2, c: "sm" })}
    ${bx(1240, 200, 320, 150, "AWS APIs", "EC2 · DynamoDB · S3 · SSM · CloudFormation …", { b: 2, c: "ok" })}
    ${tag(890, 240, "✓ 123456789012 = frozen", { b: 2, c: "ok" })}
    ${bx(880, 380, 300, 84, "ACCOUNT_MISMATCH", "AWS_PROFILE=dev → 210987654321<br>fails closed, nothing sent", { b: 3, c: "bad sm" })}
    ${tag(470, 372, "ACCOUNT_GUARD symbol · missing ⇒ INTERNAL", { b: 4, c: "warn" })}
    ${code(
      40,
      380,
      420,
      250,
      "packages/core/src/aws/client.ts",
      `<span class="kw">async function</span> <span class="f">assertAccount</span>() {
  <span class="kw">if</span> (failure) <span class="kw">throw</span> failure;
  pending ??= verify();   <span class="c">// STS once</span>
  <span class="kw">await</span> pending;
}
<span class="kw">function</span> <span class="f">client</span>(Ctor) {
  <span class="kw">const</span> inner = <span class="kw">new</span> Ctor({ region, credentials });
  <span class="kw">return</span> <span class="f">guardClient</span>(inner, assertAccount);
}`,
      { b: 4 },
    )}
    ${zone(470, 470, 1090, 160, "the fleet triple · nothing a rename can move", { b: 5, c: "acc solid" })}
    ${bx(490, 500, 250, 110, "{account_id, region, fleet_id}", "", { b: 5, c: "fillacc c" })}
    ${bx(760, 500, 250, 110, "FLEET_MISMATCH", "stack's hermetic:fleet_id tag must match config before any mutation", { b: 5, c: "sm" })}
    ${bx(1030, 500, 250, 110, "withTarget()", "app checks a request's triple synchronously, before its first await", { b: 5, c: "sm" })}
    ${bx(1300, 500, 240, 110, "plans", "a plan records its fleet; never applied to another", { b: 5, c: "sm" })}
    ${txt(1200, 30, 370, "<span class='mono' style='font-size:13px;color:var(--fg)'>▸ main · acme-prod · 123456789012 · us-east-1</span><br>every command prints its target to stderr first, so <span class='mono' style='white-space:nowrap'>--json</span> output stays clean", { b: 0 })}
  `,
  svg: `
    ${wire("M565 140 L565 200", { b: 1, c: "acc" })}
    ${wire("M800 230 C 840 230, 840 72, 880 72", { b: 2, c: "acc" })}
    ${wire("M800 280 L1240 280", { b: 2, c: "ok" })}
    ${wire("M800 320 C 840 320, 840 420, 880 420", { b: 3, c: "bad" })}
  `,
  beats: [
    {
      c: "<code>init</code> binds a hermetic home to <b>one AWS account</b>. You pick a profile, hermetic resolves it with STS, shows the account and org, and you type the twelve-digit id to confirm.",
      r: ["design.md §4.7", "packages/core/src/fleet/init-freeze.ts"],
    },
    {
      c: "From then on, every AWS client core constructs comes from one factory, <code>aws.client()</code>. It uses the frozen profile explicitly — <code>AWS_PROFILE</code> and env credentials are ignored — and wraps <code>send()</code>.",
      r: ["packages/core/src/aws/client.ts"],
    },
    {
      c: "The first call in each process asks STS who these credentials really are and compares the account with the frozen one. Match: the call proceeds and the answer is cached.",
      r: ["aws/client.ts · verify()"],
      seal: "account",
    },
    {
      c: "Switched SSO session, edited profile, wrong role: the guard fails <em>closed</em> with <code>ACCOUNT_MISMATCH</code> before a single mutating call leaves the process. A wrong-account deploy is a build error, not a bad afternoon.",
      r: ['HermeticError("ACCOUNT_MISMATCH")'],
    },
    {
      c: "A client built any other way doesn't carry the <code>ACCOUNT_GUARD</code> symbol, and the low-level helpers throw <code>INTERNAL</code> rather than use it. The fleet-directory client in another region goes through the same guard.",
      r: ["aws/client.ts · guardClient", "aws/directory.ts"],
    },
    {
      c: "An account can hold several fleets, so mutations also check <b>which fleet</b>: the stack's tag must match (<code>FLEET_MISMATCH</code>), and every app request and plan carries the immutable triple <code>{account_id, region, fleet_id}</code>.",
      r: ["packages/app/src/target.ts", "design.md §4.4"],
      seal: "triple",
    },
  ],
});

scene({
  id: "foundation",
  ch: "AWS",
  title: "The foundation stack",
  html: `
    ${zone(30, 30, 1100, 600, "CloudFormation · hermetic-fxtr0001 · ~120-line template embedded in the binary", { b: 0, c: "acc solid" })}
    ${zone(60, 80, 700, 420, "VPC · dual-stack · public subnets", { b: 2, c: "blue" })}
    ${bx(420, 52, 150, 50, "Internet GW", "", { b: 2, c: "xs c" })}
    ${zone(110, 170, 600, 230, "security group · agents · 0 inbound rules", { b: 3, c: "acc solid" })}
    ${bx(140, 210, 250, 160, "fxtr0001-atlas", "EC2 · public IPv4<br>nothing listens on it<br><br>tag agent=atlas<br>tag hermetic:fleet_id", { b: 2, c: "sm iso" })}
    ${bx(430, 210, 250, 160, "fxtr0001-corvid", "EC2 · public IPv4<br>nothing listens on it<br><br>tag agent=corvid<br>tag hermetic:fleet_id", { b: 2, c: "sm iso" })}
    ${bx(110, 420, 280, 60, "S3 gateway endpoint", "free · stays on AWS", { b: 2, c: "xs blue" })}
    ${bx(430, 420, 280, 60, "DynamoDB gateway endpoint", "free · stays on AWS", { b: 2, c: "xs blue" })}

    ${bx(800, 80, 300, 84, "hermetic-fxtr0001-agents", "DynamoDB · pay-per-request · + -events", { b: 1, c: "sm" })}
    ${bx(800, 180, 300, 92, "S3 bucket", "hermetic-fxtr0001-&lt;acct&gt;-&lt;region&gt;<br>versioned · private · policy: VPC endpoint + operator", { b: 1, c: "sm" })}
    ${bx(800, 288, 300, 84, "IAM role + instance profile", "one for the whole fleet (next scene)", { b: 1, c: "sm" })}
    ${bx(800, 388, 300, 92, "DLM policy", "daily snapshot, keep 7<br>targets role=data <b>AND</b> fleet_id", { b: 5, c: "sm" })}
    ${bx(60, 520, 1040, 90, "names are stack outputs, recorded in the fleet manifest", "A second fleet in the same account can't collide with, block, or tear down any of this — and every DescribeInstances / DescribeVolumes lookup filters on hermetic:fleet_id as well as agent=<name>.", { b: 1, c: "sm thin" })}

    ${bx(1170, 30, 400, 120, "the internet", "", { b: 3, c: "bad" })}
    ${tag(1190, 80, "✕ :22  ✕ :443  ✕ :9119  ✕ any", { b: 3, c: "bad" })}
    ${bx(1170, 200, 400, 200, "outbound: open", "web search · browser tools<br>Bedrock / model providers<br>Tailscale control + DERP<br>Ubuntu, Docker, Tailscale apt repos", { b: 4, c: "ok" })}
    ${bx(1170, 430, 400, 180, "network mode is fleet state", "<b>public</b> (default): per-agent public IP, direct Tailscale paths, no NAT bill.<br><b>nat</b>: private subnets behind fck-nat on t4g.nano + stable Elastic IP. Switch with plan network → apply.", { b: 4, c: "sm" })}
  `,
  svg: `
    ${wire("M1170 100 L1140 100 L1140 60 L780 60 L780 240 L714 240", { b: 3, c: "bad", end: false })}
    ${wire("M1170 130 L1152 130 L1152 46 L495 46 L495 168", { b: 3, c: "bad", end: false })}
    ${pk("M1170 100 L1140 100 L1140 60 L780 60 L780 240 L716 240", { b: 3, c: "bad", dur: 2200 })}
    ${pk("M1170 130 L1152 130 L1152 46 L495 46 L495 166", { b: 3, c: "bad", dur: 2200, ph: 0.5 })}
    ${wire("M694 260 C 900 260, 1000 300, 1170 300", { b: 4, c: "ok" })}
    ${wire("M265 370 L265 420", { b: 2, c: "blue" })}
    ${wire("M555 370 L555 420", { b: 2, c: "blue" })}
  `,
  svgTop: `
    ${lbl(488, 166, "✕", { b: 3, c: "bad" })}
    ${lbl(718, 245, "✕", { b: 3, c: "bad" })}
  `,
  beats: [
    {
      c: "<code>init --create</code> builds the fleet's one piece of declarative infrastructure: a CloudFormation stack from a ~120-line template compiled into the binary. Everything per-agent afterwards is an SDK call, not IaC.",
      r: ["design.md §5", "packages/core/src/fleet/init-create.ts"],
    },
    {
      c: "Everything is named for the fleet — stack, tables, bucket, roles — and every instance and volume is tagged <code>hermetic:fleet_id</code>. Every tag lookup filters on it, so two fleets in one account never see each other's resources.",
      r: ["schema/fleet.ts · cloudName()", "design.md §5"],
      seal: "named",
    },
    {
      c: "A dedicated dual-stack VPC with public subnets. Gateway endpoints for S3 and DynamoDB keep artifact and state traffic on AWS's network, at no cost.",
      r: ["foundation template"],
    },
    {
      c: "One security group for every agent, with <b>no inbound rules at all</b>. Unsolicited packets never reach a socket. <code>agent create</code> refuses to run if an inbound rule has been added, and <code>doctor</code> checks it.",
      r: ["compute · security-group inbound check", "fleet/doctor.ts"],
      seal: "sg",
    },
    {
      c: "Outbound is open, deliberately: agents search the web, drive a browser, call model providers. By default each agent has its own public IP — which nothing listens on — so Tailscale connects directly instead of via relays.",
      r: ["design.md §7.2"],
    },
    {
      c: "The bucket is versioned and private; DynamoDB is pay-per-request. A Data Lifecycle Manager policy snapshots each data volume daily, selecting by role <em>and</em> fleet so one fleet never snapshots another's disks.",
      r: ["design.md §7.1", "foundation-migrations.ts · v3"],
    },
  ],
});

scene({
  id: "iam",
  ch: "AWS",
  title: "What a box is allowed to touch",
  html: `
    ${bx(40, 210, 270, 190, "agent box", "instance profile:<br><b style='color:var(--fg)'>hermetic-fxtr0001 role</b><br>shared by every agent in the fleet<br><br>no IAM churn per agent", { b: 0, c: "acc iso" })}
    ${kick(400, 18, "allowed", { b: 1, st: "color:var(--ok)" })}
    ${bx(400, 40, 520, 64, "ssm:GetParameter  /hermes/fxtr0001/*", "the fleet's per-agent slots — hermeticd reads only its own name", { b: 1, c: "sm ok" })}
    ${bx(400, 112, 520, 64, "kms:Decrypt  if kms:ViaService = ssm", "useless except through SSM — so scoped by the line above", { b: 1, c: "sm ok" })}
    ${bx(400, 184, 520, 64, "dynamodb: Get / Put / Update / Query", "agents + events tables — never Scan", { b: 2, c: "sm ok" })}
    ${bx(400, 256, 520, 64, "s3:GetObject  config/* artifacts/* hermes/* browser/*", "+ the root manifest.json · through the gateway endpoint", { b: 2, c: "sm ok" })}
    ${bx(400, 328, 520, 64, "bedrock:InvokeModel  on named model ARNs", "reconciled by foundation update; + List* for Hermes diagnostics", { b: 2, c: "sm ok" })}
    ${bx(400, 400, 520, 64, "SSM agent + Session Manager channels, inline", "break-glass only; none of them reads a parameter", { b: 4, c: "sm ok" })}

    ${kick(1000, 18, "never", { b: 3, st: "color:var(--bad)" })}
    ${bx(1000, 40, 560, 64, "/hermetic/fxtr0001/*", "Tailscale OAuth client secret · shared provider keys", { b: 3, c: "sm bad hatch" })}
    ${bx(1000, 112, 560, 64, "/hermes/&lt;other fleet&gt;/*", "narrowed from /hermes/* in foundation v3", { b: 3, c: "sm bad hatch" })}
    ${bx(1000, 184, 560, 64, "dynamodb:Scan", "no view of the fleet", { b: 3, c: "sm bad hatch" })}
    ${bx(1000, 256, 560, 64, "ec2:RunInstances · any EC2 mutation", "a box cannot create, stop or kill anything", { b: 3, c: "sm bad hatch" })}
    ${bx(1000, 328, 560, 64, "ssm:PutParameter", "slots are written from the laptop only", { b: 3, c: "sm bad hatch" })}
    ${bx(1000, 400, 560, 64, "AmazonSSMManagedInstanceCore", 'dropped in v12 — it allowed GetParameter on Resource "*"', { b: 4, c: "sm bad hatch" })}

    ${zone(40, 500, 1520, 130, "the honest limit", { b: 5, c: "warn solid" })}
    ${txt(64, 526, 1470, "The role is <b>fleet-wide</b>, and IMDS (169.254.169.254) is reachable by any process on the box — the Hermes gateway, a terminal-tool command, anything the agent installs. A compromised agent could read its <b>fleet-mates'</b> slots, rows and config, though never another fleet's or the fleet-level secrets. hermeticd only ever addresses its own name; real per-agent isolation needs a role per agent (role tags are principal tags) and an IMDS hop limit — named as future work in design.md §5.1.", { b: 5 })}
  `,
  svg: `
    ${[72, 144, 216, 288, 360, 432].map((y, i) => wire(`M324 ${300 - 40 + i * 4} C 350 ${300 - 40 + i * 4}, 360 ${y}, 400 ${y}`, { b: i < 2 ? 1 : i < 5 ? 2 : 4, c: "ok", w: "thin" })).join("")}
  `,
  beats: [
    {
      c: "Every agent box runs with the same instance role — one role and profile per fleet, so creating an agent never touches IAM. What that role allows is the box's whole reach into AWS.",
      r: ["design.md §5.1", "foundation template · AgentRole"],
    },
    {
      c: "It may read SSM parameters under <code>/hermes/&lt;fleet_id&gt;/*</code> — the per-agent slots — and decrypt them only <em>via SSM</em>, so the KMS grant is useless on its own.",
      r: ["kms:ViaService condition"],
    },
    {
      c: "It may write rows in the fleet's two tables (never <code>Scan</code>), fetch its config, binaries, the Hermes bundle and Chrome from the bucket, and invoke the Bedrock models the stack names.",
      r: ["design.md §5.1"],
    },
    {
      c: "It can never read <code>/hermetic/</code> — where the fleet's Tailscale OAuth client and shared provider keys live — never another fleet's slots, never list the fleet, launch an instance or write a parameter.",
      r: ["design.md §8.3"],
      seal: "iam",
    },
    {
      c: "Since foundation v12 the SSM-agent permissions are written inline instead of attaching AWS's managed policy, which quietly allowed <code>GetParameter</code> on <em>every</em> parameter in the account — undoing the scoping above.",
      r: ["FOUNDATION_VERSION 12", "foundation-migrations.ts"],
    },
    {
      c: "The honest limit: the role is shared and IMDS is open to every process on the box, so one compromised agent can read its fleet-mates' slots. That's documented, with a role-per-agent fix as future work.",
      r: ["design.md §5.1 · Why not ABAC"],
    },
  ],
});

scene({
  id: "tailnet",
  ch: "AWS",
  title: "The tailnet is the perimeter",
  html: `
    ${bx(40, 60, 260, 110, "your laptop", "tailnet member<br>autogroup:member", { b: 0, c: "blue" })}
    ${bx(40, 210, 260, 90, "a teammate", "tailnet member", { b: 0, c: "sm blue" })}
    ${bx(40, 360, 260, 90, "the internet", "not on the tailnet", { b: 0, c: "sm bad" })}
    ${zone(360, 30, 520, 470, "tailnet · WireGuard · ACL-enforced", { b: 0, c: "blue solid fillz" })}
    ${bx(390, 70, 460, 66, "tag:hermetic", "every box joins tagged · single-use, 1-hour, pre-authorised key", { b: 0, c: "sm fillacc" })}
    ${bx(390, 160, 460, 70, ":22  Tailscale SSH", "identity-authenticated · no key pairs · no sshd on a public port", { b: 2, c: "sm" })}
    ${bx(390, 246, 460, 70, ":443  Tailscale Serve", "https://&lt;cloud-name&gt;.&lt;tailnet&gt;.ts.net — dashboard, chat API, /vnc", { b: 2, c: "sm" })}
    ${bx(390, 332, 460, 70, ":7434  hermeticd RPC", "logs + health only · caller checked with tailscale whois", { b: 2, c: "sm" })}
    ${bx(390, 424, 460, 64, "agent box", "nftables accepts tailscale0 + lo, drops the rest", { b: 2, c: "sm acc iso" })}

    ${code(
      920,
      30,
      640,
      250,
      "tailnet policy file · HuJSON · operator-owned",
      `<span class="s">"acls"</span>: [
  { <span class="s">"action"</span>: <span class="s">"accept"</span>, <span class="s">"src"</span>: [<span class="s">"group:ops"</span>], … },   <span class="c">// yours</span>
  <span class="a">// hermetic:managed begin</span>
  { <span class="s">"action"</span>: <span class="s">"accept"</span>, <span class="s">"src"</span>: [<span class="s">"autogroup:member"</span>],
    <span class="s">"dst"</span>: [<span class="s">"tag:hermetic:22"</span>, <span class="s">"tag:hermetic:443"</span>,
            <span class="s">"tag:hermetic:7434"</span>] },
  <span class="a">// hermetic:managed end</span>
],`,
      { b: 1 },
    )}
    ${bx(920, 300, 200, 82, "1 · splice", "only bytes between markers; comments + key order kept", { b: 3, c: "xs" })}
    ${bx(1140, 300, 200, 82, "2 · /acl/validate", "runs the policy's own embedded tests", { b: 4, c: "xs" })}
    ${bx(1360, 300, 200, 82, "3 · If-Match ETag", "edited meanwhile → 412 → CONFLICT", { b: 4, c: "xs" })}
    ${bx(920, 398, 640, 84, "a record, not the text", "every write appends a policy.apply event with ETags before/after — never the policy (it names people). Teardown leaves the entries: other fleets may use them.", { b: 4, c: "xs" })}
    ${zone(40, 522, 1520, 108, "accepted trade-offs", { b: 5, c: "warn solid" })}
    ${txt(64, 546, 1470, "<b>policy_file</b> can't be scoped to a tag, so the OAuth client could edit the whole policy — hence the five mechanical guards above (and <span class='mono'>--skip-policy</span> to opt out). <b>443 carries both the dashboard and the live browser</b>: anyone the ACL admits may drive the agent. The ACL is the authorization layer, by design.", { b: 5 })}
  `,
  svg: `
    ${wire("M300 115 L390 195", { b: 2, c: "blue" })}
    ${wire("M300 115 L390 280", { b: 2, c: "blue" })}
    ${wire("M300 255 L390 366", { b: 2, c: "blue" })}
    ${wire("M300 405 L356 405", { b: 2, c: "bad", end: false })}
    ${pk("M300 405 L356 405", { b: 2, c: "bad", dur: 900 })}
    ${wire("M1020 382 L1140 341", { b: 4, c: "acc", w: "thin" })}
    ${wire("M1240 382 L1360 341", { b: 4, c: "acc", w: "thin" })}
  `,
  svgTop: `${lbl(334, 398, "✕", { b: 2, c: "bad" })}`,
  beats: [
    {
      c: "Every agent joins your tailnet as a <b>tagged node</b>, <code>tag:hermetic</code>, using an auth key minted for it alone: single-use, one-hour expiry, pre-authorised. Tailscale is required — it is the only way in.",
      r: ["design.md §6.2 step 3", "fleet/preflight.ts"],
    },
    {
      c: "Reaching a tagged node is governed by three entries in your tailnet policy — a tag owner, an <code>ssh</code> rule, and an <code>acls</code> rule — which hermetic writes for you between <code>// hermetic:managed</code> markers.",
      r: ["packages/core/src/fleet/policy.ts", "design.md §5.2"],
    },
    {
      c: "Three ports, nothing else: <b>22</b> for Tailscale SSH, <b>443</b> for Tailscale Serve (dashboard, chat, live browser), <b>7434</b> for hermeticd's log RPC, which checks every caller with <code>tailscale whois</code>.",
      r: ["packages/agentd/src/rpc.ts"],
    },
    {
      c: "The policy file is yours: <code>hujson.ts</code> never re-serializes it. It splices bytes between the markers and returns every other byte — comments, key order, your rules — unchanged.",
      r: ["packages/core/src/fleet/hujson.ts"],
    },
    {
      c: "Every write is validated by Tailscale first (running your policy's own tests), sent with <code>If-Match</code> so a concurrent edit becomes <code>CONFLICT</code>, and logged by ETag — never by content.",
      r: ["policy.ts · applyManagedBlocks", "policy-scope.ts"],
      seal: "tailnet",
    },
    {
      c: "Two widenings are accepted out loud: the policy scope can't be limited to a tag, and port 443 grants the dashboard <em>and</em> the browser together. The tailnet ACL is the authorization boundary for everything.",
      r: ["design.md §5.2 · trade-off"],
    },
  ],
});
