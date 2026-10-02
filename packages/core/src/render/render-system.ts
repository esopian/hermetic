/**
 * The box itself, below Hermes: the apt package set and sources, the nftables
 * seal, the loopback nginx in front of the dashboard, and the apt grant the
 * agent gets. Final file content, no templating — see `render.ts`.
 */
import type { AptSource, SecretsMode } from "../schema/index.ts";
import {
  APT_LOCK_TIMEOUT_SECONDS,
  HERMES_ACCOUNT,
  HERMES_AGENT_VENV,
  HERMES_DASHBOARD_PORT,
  HERMES_LAZY_TARGET,
  HERMES_PROXY_PORT,
  HERMES_USER_PREFIX,
} from "../schema/index.ts";
import { BROWSER_PACKAGES } from "./render-browser.ts";
import type { RenderInput } from "./render.ts";

/**
 * What a Hermes server install needs from apt, taken from upstream's own two
 * statements of it — `scripts/install.sh` and `Dockerfile:71-73` — rather than
 * derived by hand, which is how the list went a release without `ripgrep`.
 *
 * Deliberately *not* here yet: `build-essential`, `python3-dev`, `libffi-dev`.
 * Upstream installs them pre-emptively on Debian/Ubuntu — a `dpkg -s` probe
 * before the install tiers begin, and an `apt-get` it lets fail
 * (`scripts/install.sh:1875-1897`) — for packages that *may* need a source
 * build, rather than after one has failed. The `[all]` extra is curated
 * wheels-only, so today's closure resolves on arm64 with no compiler, and
 * upstream's own tolerance of that apt-get failing says it is not load-bearing.
 * The failure mode if that stops being true is a fleet-wide apply dying on a
 * box with no compiler, so add them when a missing wheel proves it — not
 * before.
 */
const BASE_PACKAGES = [
  "ca-certificates",
  "curl",
  // TTS and voice messages. Upstream's installer probes for it by name and
  // installs it when it is missing (`scripts/install.sh:1311-1318,1356-1358`).
  "ffmpeg",
  // Hermes is installed from a git checkout of the upstream repo (§6.4), so git
  // is a build dependency of the box, not just a convenience for an operator.
  "git",
  "gnupg",
  "jq",
  /**
   * Not for Hermes: for the Node hermeticd downloads. The official linux
   * tarball links `libatomic.so.1`, which a minimal Ubuntu image does not ship,
   * and upstream installs this package for exactly that reason with the failure
   * written out at `scripts/install.sh:1129-1142`. Without it the first thing
   * hermetic would see is a bare `COMMAND_FAILED` from `node --version`.
   */
  "libatomic1",
  // The loopback reverse proxy in front of Hermes (see `nginxConf`). Every
  // agent publishes its dashboard through Serve, so this is unconditional and
  // not part of the browser stack. `-light` is the smallest Ubuntu flavour that
  // still carries `proxy` and the `map` directive — no third-party modules.
  "nginx-light",
  "nftables",
  /**
   * Hermes's file-search tool prefers `rg` and needs 14 or newer to sort by
   * modification time at all (`tools/file_operations_search.py:308-318`);
   * Ubuntu noble ships 14.1.0. Without it every search takes the find/grep
   * fallback path, which is slower and answers a slightly different question.
   * Upstream installs it from both its installer and its image.
   */
  "ripgrep",
  // Ubuntu's cloud images already carry it, so this installs nothing on any box
  // hermetic has ever created — but `/etc/sudoers.d/hermetic-apt` is a dead
  // letter without it, and "the grant silently does nothing" is not a failure
  // mode worth leaving open for the sake of one no-op apt operand.
  "sudo",
  "unzip",
  // `tar -xJf` on the Node tarball needs it, and a minimal image does not have
  // it; upstream's Dockerfile installs it explicitly for the same reason.
  "xz-utils",
];

const DOCKER_PACKAGES = ["docker-ce", "docker-ce-cli", "containerd.io"];

const BWS_PACKAGES = ["bws"];

export function aptSources(secrets_mode: SecretsMode): AptSource[] {
  const sources: AptSource[] = [
    {
      name: "tailscale",
      uri: "https://pkgs.tailscale.com/stable/ubuntu noble main",
      key_url: "https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg",
    },
    {
      name: "docker",
      uri: "https://download.docker.com/linux/ubuntu noble stable",
      key_url: "https://download.docker.com/linux/ubuntu/gpg",
    },
  ];
  if (secrets_mode === "bitwarden") {
    sources.push({
      name: "bitwarden-sm",
      uri: "https://apt.bitwarden.com/sm stable main",
      key_url: "https://apt.bitwarden.com/sm/bitwarden.gpg",
    });
  }
  return sources;
}

export function packages(input: RenderInput): string[] {
  const list = [...BASE_PACKAGES, "tailscale", ...DOCKER_PACKAGES];
  list.push(...BROWSER_PACKAGES);
  if (input.secrets_mode === "bitwarden") list.push(...BWS_PACKAGES);
  return [...new Set(list)].sort();
}

/**
 * Default-deny inbound, `tailscale0` and loopback only (§6.4). The security
 * group already blocks inbound; this is the instance-level layer so the box is
 * sealed even if it were ever placed in the wrong subnet.
 */
export function nftablesRuleset(): string {
  return [
    "#!/usr/sbin/nft -f",
    "# Rendered by hermetic. Do not edit on the instance; edits are reverted on the next apply.",
    "flush ruleset",
    "",
    "table inet hermetic {",
    "  chain input {",
    "    type filter hook input priority filter; policy drop;",
    "    iif lo accept",
    '    iifname "tailscale0" accept',
    "    ct state established,related accept",
    "    ip protocol icmp accept",
    "    ip6 nexthdr icmpv6 accept",
    '    udp dport 41641 accept comment "tailscale direct connections"',
    "  }",
    "  chain forward {",
    "    type filter hook forward priority filter; policy drop;",
    "  }",
    "  chain output {",
    "    type filter hook output priority filter; policy accept;",
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * Stock Ubuntu's `nftables.service` only loads `/etc/nftables.conf` (default
 * `flush ruleset`), so enabling it would not load hermetic's ruleset and a
 * reboot would leave the box unsealed. This dedicated unit loads hermetic's
 * ruleset file directly and runs before networking comes up (§6.4).
 */
export function hermeticNftablesUnit(): string {
  return [
    "# Rendered by hermetic. Final file, no templating.",
    "[Unit]",
    "Description=hermetic nftables ruleset (default-deny inbound)",
    "Before=network-online.target tailscaled.service",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    "ExecStart=/usr/sbin/nft -f /etc/hermetic/nftables.hermetic.nft",
    "ExecReload=/usr/sbin/nft -f /etc/hermetic/nftables.hermetic.nft",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/**
 * The loopback reverse proxy that stands between Tailscale Serve and Hermes,
 * and the reason no agent's dashboard asks for a password.
 *
 * Hermes 0.21 has two mutually exclusive postures. Declare
 * `HERMES_DASHBOARD_PUBLIC_URL` and it engages its auth gate — with no auth
 * provider registered it refuses to start at all. Leave it unset and it stays
 * in unauthenticated **local mode**: it binds loopback, its SPA injects its own
 * session token for `/api/*`, and its DNS-rebinding guard admits only a `Host`
 * that matches what it bound to. Serve forwards `Host: <name>.<tailnet>`, so
 * without the public URL every proxied request came back `Invalid Host header`.
 *
 * nginx breaks the deadlock by making the request *look* local: it rewrites
 * `Host` to `127.0.0.1:9119` and `Origin` to `http://127.0.0.1:9119` before
 * passing it upstream. Hermes then sees a loopback client on a loopback host
 * and stays in local mode — the SPA loads with no login and `/api/ws` upgrades
 * 101 straight through Serve. In local mode Hermes ignores `X-Forwarded-*`
 * entirely, so the forwarded headers below are for the operator reading logs,
 * not for Hermes.
 *
 * A whole `nginx.conf` rather than a site file under `sites-enabled/`: Ubuntu's
 * package ships a default site listening on `0.0.0.0:80`, and the one thing
 * this box must not have is a listener on a public interface. Owning the whole
 * config is the only way to be sure ours is the *only* `listen` — nftables and
 * the security group are the other two layers, and none of the three should be
 * the one carrying the whole argument. The listen is `127.0.0.1:9120`, so the
 * proxy is reachable from Serve and from nothing else.
 *
 * The trade-off, decided deliberately: this keeps Hermes's own gate off, so
 * **the tailnet ACL is the perimeter** — whoever may reach `tag:hermetic` on
 * 443 is whoever may drive the agent. Two consequences worth knowing. Hermes's
 * audit log carries no per-user identity, because every request arrives as the
 * same local session. And a future Hermes release could learn to inspect proxy
 * headers and refuse this shape; the fallback then is a Hermes auth plugin fed
 * by Serve's `Tailscale-User-Login` header, which is why that header (and
 * `Tailscale-User-Name`) is passed through today even though nothing reads it.
 * That plugin is noted as future work, not built.
 *
 * `proxy_read_timeout`/`proxy_send_timeout` are a day because the dashboard
 * holds a websocket open for the life of a session, and `proxy_buffering off`
 * because Hermes streams tokens — a buffer would turn a live transcript into a
 * batch delivery.
 */
export function nginxConf(): string {
  return [
    "# Rendered by hermetic. Final file, no templating.",
    "user www-data;",
    "worker_processes 1;",
    "pid /run/nginx.pid;",
    "error_log /var/log/nginx/error.log warn;",
    "events { worker_connections 256; }",
    "http {",
    "  server_tokens off;",
    "  access_log off;",
    "  map $http_upgrade $connection_upgrade { default upgrade; '' close; }",
    "  server {",
    `    listen 127.0.0.1:${String(HERMES_PROXY_PORT)};`,
    "    client_max_body_size 512m;",
    "    location / {",
    `      proxy_pass http://127.0.0.1:${String(HERMES_DASHBOARD_PORT)};`,
    "      proxy_http_version 1.1;",
    `      proxy_set_header Host 127.0.0.1:${String(HERMES_DASHBOARD_PORT)};`,
    `      proxy_set_header Origin http://127.0.0.1:${String(HERMES_DASHBOARD_PORT)};`,
    "      proxy_set_header Upgrade $http_upgrade;",
    "      proxy_set_header Connection $connection_upgrade;",
    "      proxy_set_header X-Forwarded-For $http_x_forwarded_for;",
    "      proxy_set_header Tailscale-User-Login $http_tailscale_user_login;",
    "      proxy_set_header Tailscale-User-Name $http_tailscale_user_name;",
    "      proxy_read_timeout 1d;",
    "      proxy_send_timeout 1d;",
    "      proxy_buffering off;",
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * The commands the agent may run without asking, spelled as Hermes spells them:
 * a top-level list of exact commands or fnmatch globs, silently approved in
 * every session from now on.
 *
 * The list is no longer the sudoers grant, and the comment that said it was
 * outlived the grant it described. It was exact while the grant was two apt
 * binaries; the grant below is now full passwordless root, and writing that out
 * as fnmatch patterns would be a single `*` dressed up as a policy.
 *
 * What the list is still for is the operator who turns approvals back on. At
 * the mode hermetic seeds the agent asks about nothing, and these four patterns
 * decide nothing; at `smart` or `manual` they are the difference between the
 * agent installing a package and the agent waiting on a prompt nobody is there
 * to answer. Seeding them costs nothing while they are inert and means they are
 * already there on the box the day someone changes the mode.
 *
 * Both binaries, each with and without `sudo`, because a model reaching for a
 * package writes `apt install` as readily as `apt-get install`.
 *
 * No `sudo -E` forms. A sudoers rule without `SETENV` rejects `-E` outright, so
 * a pattern for it would allowlist a command that cannot run; `DEBIAN_FRONTEND`
 * is how the agent avoids debconf, and it reaches apt through the `env_keep` in
 * `sudoersGrant` rather than through the agent's argv.
 *
 * **Seeded, not managed**, and that distinction cost an upstream feature while
 * it was the other way round. A managed *list* replaces the agent's rather than
 * merging into it (`_deep_merge`, `hermes_cli/config.py:1498-1513`), which was
 * the point: `hermes config set` could not widen it. But upstream persists an
 * "always approve" answer by writing the whole key back to the user config
 * (`tools/approval.py:441-442`), and `save_config` strips every managed leaf before
 * writing (`_strip_managed_keys_for_save`, `hermes_cli/config.py:2287`, called
 * at `:2326`), printing only *"Note: 1 managed setting(s) were not saved"*. So
 * with this key managed, every `always` an operator or agent answers works for
 * the session and is gone at process exit — permanently, on every agent — and
 * `hermes approvals suggest --apply` (`hermes_cli/approvals_suggest.py:270`) is
 * a no-op for the same reason.
 *
 * That trade is not worth it, because this list is not the security boundary
 * and never was. The instance is (§7.1); the sudoers drop-in below grants
 * everything the kernel would let the account reach by other means anyway. A
 * `command_allowlist` only decides what runs *without asking*, and on an
 * unattended box nobody answers the prompt anyway. Seeding it gives the agent
 * both: the apt patterns from the first boot, and an allowlist it can actually
 * add to.
 *
 * No `approvals.deny` floor either. It is upstream's "everything except these,
 * ever" mechanism (`hermes_cli/config_defaults.py:1568-1571`), checked before
 * `--yolo` and before `approvals.mode: off`, and there is nothing to put in it:
 * the box's real limit is the instance boundary (§7.1) and nothing above it,
 * and an empty floor pins nothing while implying it does.
 */
export const COMMAND_ALLOWLIST = ["apt-get *", "sudo apt-get *", "apt *", "sudo apt *"] as const;

/**
 * Where the agent's sudoers grant lives; validated with `visudo -c` before it
 * lands.
 *
 * The filename still says `apt`, and the grant inside it has not been apt-only
 * since `sudoersGrant` replaced `sudoersApt`. That is deliberate rather than
 * lazy: `hermeticd apply` never reaps a file it stops rendering, so renaming
 * the path would leave the old apt grant sitting in `sudoers.d` on every box
 * that already exists, alongside the new one, until something went and deleted
 * it. The file's own header comment says what it is; the filename is history.
 */
export const SUDOERS_PATH = "/etc/sudoers.d/hermetic-apt";
/** The apt configuration every apt on the box inherits, hermeticd's and the agent's alike. */
export const APT_CONF_PATH = "/etc/apt/apt.conf.d/91hermetic-dpkg";

/**
 * The agent is root on its own box, and is not asked for a password.
 *
 * Be exact about what this grants, and about what it does not change. It grants
 * everything: `hermes` may run any command as any user with no password and no
 * allowlist. That is not a widening of what the account can already reach. The
 * account is in the `docker` group, and a docker socket starts a privileged
 * container bind-mounting host `/` — the same root, by a longer route and with
 * less to read afterwards. The security boundary on an agent box is the
 * instance, not the unix user (§7.1): one agent, one instance, one data volume,
 * zero inbound rules. A narrower sudoers file only chose which of two doors the
 * agent had to walk through to reach the same place.
 *
 * What the change buys is the failure mode. The apt-only grant this replaces
 * meant every other root-owned thing the agent met — a file under `/etc`, a
 * systemd unit it wanted restarted, a directory root created — was a permission
 * error with no route around it, on a box with nobody at the keyboard to widen
 * the rule. The agent could not do the work and could not ask for the
 * privilege, which is the worst of both.
 *
 * This file is only half of the decision. It says what the kernel permits;
 * whether the agent asks a human first is Hermes's own `approvals.mode`, and
 * the two move together. A full grant under an approval mode that classifies
 * every `sudo` as dangerous is still a wall — one with a prompt in front of it,
 * on a box where nobody answers prompts. `render-hermes.ts` seeds the mode.
 *
 * `env_keep` because `sudo` scrubs the environment: `DEBIAN_FRONTEND` is set on
 * the Hermes unit so the agent never meets a debconf prompt, and without this
 * line it would be dropped on the way through `sudo` and the agent would hang
 * on a dialog nobody can answer.
 *
 * `HERMES_HOME` is deliberately *not* kept, and the consequence is a sharp edge
 * this repo has chosen rather than fixed: `sudo hermes …` therefore acts on
 * root's own `/root/.hermes` rather than the agent's home. Keeping it would
 * trade that for a worse one — every such command would write root-owned files
 * into the tree the `hermes` account has to keep writing, and the first
 * permission error would arrive later and be harder to explain. Neither option
 * is good; `sudo hermes` is not a thing anyone needs to run.
 */
export function sudoersGrant(): string {
  return [
    "# Rendered by hermetic. Final file, no templating.",
    "# Full root, no password. The unix user is not the boundary on this box; the",
    "# instance is (§7.1). The account is already root-equivalent via the docker group.",
    'Defaults:hermes env_keep += "DEBIAN_FRONTEND"',
    "hermes ALL=(ALL:ALL) NOPASSWD: ALL",
    "",
  ].join("\n");
}

/** Where `agentProfile` lands: sourced by `/etc/profile` for every login shell. */
export const AGENT_PROFILE_PATH = "/etc/profile.d/hermetic-agent.sh";

/**
 * The `hermes` account's install locations, for every login shell it gets.
 *
 * Two kinds of shell need them and neither inherits the Hermes units'
 * environment the same way. Hermes's terminal tool runs commands under
 * `bash -l -c`, from whichever unit is serving the conversation, and it strips
 * `VIRTUAL_ENV` from what it passes down (`local_env_policy.py:184`) — so the
 * agent's own venv has to be re-established *after* that, which is what a
 * profile script is for. And an operator's `sudo -iu hermes` gets no unit
 * environment at all, so without the lazy-install lines a `hermes` command run
 * by hand would try to install into the root-owned venv and fail.
 *
 * `HERMES_AGENT_VENV` goes first on `PATH`, ahead of the Hermes venv the
 * gateway unit puts on it: `python3`, `pip` and `uv pip` then all mean the
 * agent's own, writable environment, in a gateway shell and a dashboard shell
 * alike — which also ends the split where one served Hermes's 3.11 and the
 * other Ubuntu's externally-managed 3.12. The skeleton `~/.profile` runs after
 * this and prepends `~/.local/bin`, so `npm install -g`, `uv tool install` and
 * `pip install --user` binaries win over both. Only when the venv exists, so a
 * box whose venv could not be built still gets a working `PATH`.
 */
export function agentProfile(): string {
  const bin = `${HERMES_AGENT_VENV}/bin`;
  return [
    "# Rendered by hermetic. Final file, no templating.",
    "# The hermes account's own install locations, for every login shell it gets:",
    "# Hermes's terminal tool (bash -l) and an operator's `sudo -iu hermes`.",
    `if [ "$(id -un 2>/dev/null)" = "${HERMES_ACCOUNT}" ]; then`,
    "  export HERMES_DISABLE_LAZY_INSTALLS=1",
    `  export HERMES_LAZY_INSTALL_TARGET=${HERMES_LAZY_TARGET}`,
    `  export NPM_CONFIG_PREFIX=${HERMES_USER_PREFIX}`,
    `  if [ -x ${bin}/python ]; then`,
    `    export VIRTUAL_ENV=${HERMES_AGENT_VENV}`,
    '    case ":$PATH:" in',
    `      *":${bin}:"*) ;;`,
    `      *) PATH="${bin}:$PATH" ;;`,
    "    esac",
    "    export PATH",
    "  fi",
    "fi",
    "",
  ].join("\n");
}

/**
 * One dpkg lock, three processes that want it (§6.4): hermeticd's packages
 * phase on every apply, Ubuntu's `unattended-upgrades` on its own schedule, and
 * now the agent. Stock apt does not queue — it prints `Could not get lock
 * /var/lib/dpkg/lock-frontend` and exits — so the agent's first unlucky
 * `apt-get install` fails for a reason it cannot see or fix.
 *
 * hermeticd already passes the timeout on its own argv (`APT_OPTIONS`); this
 * file is how the *agent's* apt inherits it without having to know. Both read
 * `APT_LOCK_TIMEOUT_SECONDS`, so the two cannot drift.
 *
 * The conffile defaults are for the third process: an unattended upgrade that
 * meets a modified conffile stops on a prompt and holds the lock while it
 * waits. Keeping the installed version (`--force-confold`, with
 * `--force-confdef` for the ones we never touched) is the answer that lets it
 * finish; a box whose configuration hermetic renders should not be taking a
 * package's new default anyway.
 */
export function aptConf(): string {
  return [
    "// Rendered by hermetic. Final file, no templating.",
    "//",
    "// One dpkg lock, three users of it: hermeticd's apply, unattended-upgrades,",
    "// and the agent itself. Wait for it rather than failing.",
    `DPkg::Lock::Timeout "${String(APT_LOCK_TIMEOUT_SECONDS)}";`,
    "// An unattended upgrade must never stop on a conffile prompt while holding",
    "// that lock: keep what is installed.",
    'DPkg::Options { "--force-confdef"; "--force-confold"; };',
    "",
  ].join("\n");
}
