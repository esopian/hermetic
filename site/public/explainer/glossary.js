/* Shared glossary. A string entry is linked in narration (first mention, at most three per beat);
 * an { d, link: false } entry is listed in the glossary panel only — for words too common to underline.
 * Path files may add terms with glossary({...}). */
glossary({
  hermetic: {
    d: "This project: a fleet manager that runs Hermes agents on AWS, each sealed in its own cloud machine.",
    link: false,
  },
  Hermes: {
    d: "The open-source AI agent hermetic runs (Hermes Agent, by Nous Research). hermetic installs it unmodified.",
    link: false,
  },
  agent: {
    d: "One Hermes instance on its own cloud machine, with its own memory volume and browser.",
    link: false,
  },
  fleet: {
    d: "A set of agents sharing one AWS foundation, one tailnet and one set of settings. One account can hold several.",
    link: false,
  },
  foundation:
    "The one-time AWS setup for a fleet — a CloudFormation stack with the network, tables, bucket and IAM role.",
  tailnet: "Your private Tailscale network. It is the only way to reach an agent.",
  Tailscale:
    "A private networking service (WireGuard underneath) that connects your laptop to agents without opening ports.",
  "Tailscale Serve":
    "Tailscale's feature that publishes a loopback service on the tailnet over HTTPS with a real certificate.",
  MagicDNS: "Tailscale's built-in DNS — gives each agent a name like fxtr0001-atlas.<tailnet>.ts.net.",
  ACL: "Access control list — here, the tailnet policy that decides who may reach tagged agent machines.",
  hermeticd:
    "hermetic's small agent program on every box: boots it, applies config, heartbeats, self-updates.",
  core: {
    d: "packages/core — the SDK that holds all of hermetic's logic. The CLI and the app are thin heads over it.",
    link: false,
  },
  SDK: {
    d: "Software development kit — here, core: the one library both the CLI and the app call.",
    link: false,
  },
  CLI: { d: "The hermetic command-line tool.", link: false },
  CloudFormation:
    "AWS's declarative infrastructure service. hermetic uses it once, for the fleet foundation.",
  EC2: "AWS's virtual machines. Each agent is one EC2 instance.",
  EBS: "AWS's network disks. Each agent's memory lives on its own EBS data volume.",
  S3: "AWS object storage. The fleet bucket holds hermetic's binary, boot stages and rendered config.",
  DynamoDB: "AWS's key-value database. It is the fleet's source of truth: one row per agent.",
  SSM: "AWS Systems Manager Parameter Store — encrypted slots that hold bootstrap secrets.",
  IAM: "AWS Identity and Access Management — the permissions an operator or a box has.",
  IMDS: "The EC2 instance metadata service (169.254.169.254) a process on a box can ask for the box's AWS credentials.",
  STS: "AWS Security Token Service; GetCallerIdentity says which account a set of credentials belongs to.",
  Bedrock:
    "AWS's hosted model service. On Bedrock an agent needs no API key — its machine role is the credential.",
  nftables:
    "Linux's firewall. On every box it drops all inbound traffic except loopback and the tailnet.",
  loopback: "127.0.0.1 — an address only reachable from the same machine.",
  tmpfs: "A RAM-backed filesystem; files on it vanish when the machine stops.",
  noVNC: "A browser-based remote screen viewer — how you watch and drive an agent's browser.",
  CDP: "Chrome DevTools Protocol — how Hermes drives the agent's Chrome.",
  "fixture mode": "Running hermetic against an in-memory fake fleet — no AWS, no network.",
  "provider profile":
    "A named model provider + model + key, defined once per fleet and bound to agents.",
  heartbeat: "The status hermeticd writes to its agent's row every 30 seconds.",
  "fleet manifest":
    "manifest.json at the bucket root — tells every box which release and resources the fleet uses.",
  "agent manifest": "The rendered config bundle for one agent — final files, no templates.",
  "security group": "An AWS firewall around instances. hermetic's has zero inbound rules.",
  "OAuth client":
    "The Tailscale credential hermetic uses to mint agent join keys and manage its ACL entries.",
  recreate: "Replace an agent's machine with a fresh one on the same memory volume.",
  rerun: "Resume a failed boot from the stage that failed, on the same machine.",
  doctor:
    "hermetic doctor — a read-only check that compares AWS, DynamoDB, the tailnet and local config for drift.",
  bot: "A Hermes profile on an agent box. Every box has a default bot; you can add more.",
  gateway:
    "Hermes's background service that runs messaging channels (Slack, Telegram, Discord) and scheduled jobs.",
  dashboard: "Hermes's web UI on the box, reached through Tailscale Serve.",
  seal: {
    d: "In the Security path: one containment boundary and the code or test that enforces it.",
    link: false,
  },
  Electrobun:
    "The desktop-app framework the hermetic app is built on: a native shell with a web page inside.",
  parity:
    "The rule that every core method has exactly one CLI command and one app handler, checked by a test.",
  Zod: "A TypeScript schema library. hermetic's request and response shapes are Zod schemas in core.",
});
