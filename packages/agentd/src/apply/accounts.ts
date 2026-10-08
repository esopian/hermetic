/**
 * The `hermes` account and everything that hangs off its identity: the group
 * Docker needs it in, the home on the data volume, the ownership of rendered
 * files, and the removal of the units hermetic's own renames superseded (§6.4).
 */
import type { AgentConfig, RenderedFile } from "@hermetic/core/schema";
import {
  HERMES_ACCOUNT,
  HERMES_ACCOUNT_HOME,
  HERMES_BIN,
  HERMES_DASHBOARD_UNIT,
  HERMES_GATEWAY_UNIT,
  HERMES_HOME,
  HERMES_USER_PREFIX,
  HERMES_LAZY_TARGET,
  HERMES_AGENT_VENV,
  HERMES_LEGACY_DASHBOARD_UNIT,
} from "@hermetic/core/shared";
import { installAccountDir } from "../account-dirs.ts";
import type { Host } from "../host.ts";
import { must } from "../host.ts";
import { AgentdError } from "../errors.ts";
import type { Emit } from "../events.ts";
import { opEvent } from "../events.ts";
import { HERMETICD_VERSION } from "../version.ts";
import type { ApplyResult } from "./shared.ts";
import { UNIT_DIR } from "./shared.ts";

/**
 * Every name upstream's installer could plausibly have used: the expected one,
 * and the `hermes-gateway-<profile hash>.service` a non-default `HERMES_HOME`
 * would produce. `ensureGatewayUnit` both looks for one and tells the operator
 * to, so the pattern is stated once.
 */
const GATEWAY_UNIT_GLOB = "hermes-gateway*.service";
/**
 * The unprivileged account every rendered unit and every owned file names, and
 * the group Docker's socket is owned by.
 *
 * These are hermeticd's own step rather than a manifest `commands` entry
 * (where they used to live) because of *when* the two run. `commands` is the
 * last phase: it runs after `units`, and the units phase starts
 * `hermes-dashboard.service`, which is `User=hermes`. So on a first apply systemd was
 * asked to start a unit as an account that did not exist yet and failed it
 * `217/USER` — the manifest was, in effect, asking for the account after the
 * thing that needs it. An account is not a post-step; it is a precondition, and
 * this is the phase that says so.
 *
 * Kept schema-free on purpose: a `pre_commands` list in the manifest would let
 * core order agentd's phases from the laptop, and the ordering that matters
 * here belongs to whoever runs the phases.
 */
export const HERMES_USER = HERMES_ACCOUNT;

/**
 * The account-home directory rules live in their own module (`account-dirs.ts`)
 * because they are a privilege boundary rather than a step of the apply, and
 * they are re-exported here because every caller and every test already reaches
 * for them through `apply.ts`.
 */
export {
  asHermes,
  BROWSER_PROFILE_ROOT,
  ensureBrowserProfileRoot,
  installAccountDir,
} from "../account-dirs.ts";
export const DOCKER_GROUP = "docker";

/**
 * Create the `hermes` account, the `docker` group it needs to be in, its home
 * on the data volume and the `$HERMES_HOME` its unit sets as
 * `WorkingDirectory` — all of it idempotent, because this runs on every apply
 * and only the first one has anything to do.
 *
 * The `docker` group is created explicitly rather than left to Docker's own
 * postinst: the packages phase and this one are independent, and `useradd -G
 * docker` against a group that does not exist yet fails the whole apply. On a
 * box where apt got there first, `--force` makes this a no-op.
 *
 * `usermod` is separate from `useradd` so that an account created by an earlier
 * hermeticd — before the box had Docker at all — still ends up in the group.
 */
export async function ensureAccounts(host: Host, dry: boolean): Promise<void> {
  if (dry) return;
  await must(host, ["groupadd", "--system", "--force", DOCKER_GROUP]);
  if ((await host.exec(["id", "-u", HERMES_USER])).code !== 0) {
    await must(host, [
      "useradd",
      "--system",
      // The home is on the data volume, and `$HERMES_HOME` is `$HOME/.hermes`
      // under it — see `HERMES_ACCOUNT_HOME`. `--create-home` against a
      // directory that already exists (a reattached data volume carrying the
      // previous instance's `/data/hermes`) warns and exits 0, which is the
      // behaviour this wants: the account is recreated, its state is not.
      "--create-home",
      "--home-dir",
      HERMES_ACCOUNT_HOME,
      "--shell",
      "/usr/sbin/nologin",
      "-G",
      DOCKER_GROUP,
      HERMES_USER,
    ]);
  }
  await must(host, ["usermod", "-aG", DOCKER_GROUP, HERMES_USER]);
  /**
   * Move an account created before the home did. Same shape as the `usermod
   * -aG` above and for the same reason: the `useradd` runs once, on the box
   * that had no account, so anything the account's *shape* later gains has to
   * be re-asserted here or an older box never gets it.
   *
   * The home is not cosmetic. `$HERMES_HOME` is `$HOME/.hermes` and upstream
   * resolves `$HOME` from the passwd entry, so a box still homed at
   * `/var/lib/hermes` has `$HOME/.hermes != HERMES_HOME` — the equality this
   * whole layout exists for — and `hermes gateway install` would generate a
   * unit pointing at upstream's custom-root path rather than at the data
   * volume.
   *
   * No `--move-home`: nothing under the old home is state hermetic wants. The
   * agent's state lives in `$HERMES_HOME` on the data volume, which is where
   * this is moving the account *to*; the old home holds only what a `useradd
   * --create-home` put there from `/etc/skel`.
   *
   * `usermod` refuses while the account has running processes (`user hermes is
   * currently used by process N`). That fails the apply with usermod's own
   * message, and the way through is `recreate` — which is honest: re-homing a
   * live account underneath a running gateway is not something to paper over.
   */
  const passwd = (await must(host, ["getent", "passwd", HERMES_USER])).stdout;
  if (passwd.trim().split(":")[5] !== HERMES_ACCOUNT_HOME) {
    await must(host, ["usermod", "--home", HERMES_ACCOUNT_HOME, HERMES_USER]);
  }
  /**
   * Give the account a user manager. `hermes` is `--system` and `nologin`, so
   * it never logs in and systemd never starts `user@<uid>.service` for it —
   * which upstream's system-scope gateway unit orders itself `After=`/`Wants=`
   * (`hermes gateway install --system`). Linger is what makes that ordering
   * satisfiable: it is what keeps a `user@<uid>.service` running for an account
   * nobody logs into.
   *
   * Upstream would mostly cope on its own — on a missing linger it enables
   * linger itself and otherwise warns, refusing outright only under a
   * Nix-managed install — but hermetic enables it here so the unit's *start*
   * does not depend on the installer having done so. The unit is started by the
   * units phase, by systemd, long after the installer has exited.
   *
   * Unconditional and idempotent, like the `groupadd`/`usermod` above: enabling
   * linger twice is a no-op, and probing first costs a second exec to learn
   * what the write already knows. `must` rather than a warning — a box whose
   * logind will not take this is a box the gateway cannot be supervised on, and
   * that is worth failing the apply for rather than discovering at first
   * message.
   */
  await must(host, ["loginctl", "enable-linger", HERMES_USER]);
  /**
   * `hermes-dashboard.service` sets `WorkingDirectory=$HERMES_HOME`, so a unit started
   * before this directory exists fails `200/CHDIR` for the same reason a
   * missing account fails `217/USER`. `/data` is mounted by an earlier stage.
   *
   * Both directories, account home first: `useradd --create-home` only makes
   * the home when it is absent, so on a reattached volume neither it nor the
   * `.hermes` under it can be assumed, and `install -d` on a parent that does
   * not exist yet would fail. `0750` on both: `$HERMES_HOME` is where the
   * agent's sessions, memories and `.env` land, and the home above it is the
   * agent's working state too. Nothing needs the world bit — hermeticd is root,
   * which modes do not stop, and nginx reaches Hermes over a loopback port
   * rather than through this directory.
   *
   * **Only the first is root's to make.** `/data/hermes` hangs off `/data`,
   * which is root's own mount point (`disk.ts`), so no unprivileged process can
   * substitute that name and this is the line that makes the home the account's
   * at all. `$HERMES_HOME` hangs off `/data/hermes`, which by then *is* the
   * account's — so the account can replace the `.hermes` entry with a symlink,
   * and a root `install -d` would follow it and hand its target to `hermes` at
   * 0750. `installAccountDir` runs that one as the account instead, where the
   * same symlink buys nothing. Same reasoning, and the same function, as the
   * browser profile root.
   */
  await must(host, [
    "install",
    "-d",
    "-m",
    "0750",
    "-o",
    HERMES_USER,
    "-g",
    HERMES_USER,
    HERMES_ACCOUNT_HOME,
  ]);
  await installAccountDir(host, HERMES_HOME, "0750");
  /**
   * The account's own install prefix (`HERMES_USER_PREFIX`), with its `bin/`
   * present from the first boot: the skeleton `~/.profile` only puts
   * `~/.local/bin` on `PATH` when the directory already exists at login, so an
   * agent's first `npm install -g` would otherwise land somewhere its next
   * shell cannot see. As the account, for the same symlink reason as above.
   */
  // The prefix itself first, so its own mode and its not-a-symlink check are
  // this function's rather than whatever `install -d` would give a parent;
  // 0700 because that is what the per-user installers that share it expect.
  await installAccountDir(host, HERMES_USER_PREFIX, "0700");
  await installAccountDir(host, HERMES_USER_PREFIX + "/bin", "0755");
  /**
   * Where upstream's on-demand installs go (`HERMES_LAZY_INSTALL_TARGET` on
   * both units). Hermes would make it on first use, but pre-creating it as the
   * account is what upstream's image does at every boot (`stage2-hook.sh`),
   * and it means the first install never races a directory root created.
   */
  await installAccountDir(host, HERMES_LAZY_TARGET, "0755");
}

/**
 * Install upstream's gateway unit, once, on the box that does not have it yet.
 *
 * hermetic renders `hermes-dashboard.service` (the dashboard) but not this one. `hermes
 * gateway install --system` generates it — the venv python, the module path,
 * the `After=user@<uid>.service` ordering — and a unit hermetic wrote instead
 * would pin the way Hermes is supervised to hermetic's release rather than to
 * the manifest's `hermes_ref` (§6.6). The trade is deliberate: a Hermes upgrade
 * may change how the gateway is supervised, and `hermes_ref` is what holds it
 * still.
 *
 * **After `ensureAccounts`** because the installer writes `User=hermes`,
 * `Environment=HOME=<the account's home>` and a `WorkingDirectory` under it, so
 * the account and its home have to exist first — and because the unit it writes
 * orders itself after a `user@<uid>.service` that only linger keeps running.
 *
 * **Before the files phase** because everything hermetic adds to this unit
 * arrives afterwards: the drop-in at `HERMES_GATEWAY_DROPIN` is an ordinary
 * rendered file, the `daemon-reload` that makes it readable is the units
 * phase's, and the restart is the units phase's too.
 *
 * `HERMES_HOME` **and** `HOME` are both passed explicitly, and `HOME` is the
 * `hermes` account's, not root's.
 *
 * The unit's *name* comes from `_profile_suffix()`, which asks whether this
 * process's `HERMES_HOME` is a home entitled to the bare `hermes-gateway`
 * name. Through `v2026.8.31` that test was `home == get_default_hermes_root()`,
 * which returns `HERMES_HOME` unchanged for a root outside `~/.hermes` — so any
 * custom root answered yes and `HOME` did not matter. `v2026.9.14` replaced it
 * with `home in _native_service_homes() or home == _bare_unit_pinned_home()`
 * (`hermes_cli/gateway.py:2015-2041`), where "native" is literally
 * `Path.home() / ".hermes"`; the docstring says the bare name is "deliberately
 * NOT tied to `get_default_hermes_root()`", because that helper let a temp-home
 * test harness resolve onto the production unit. Under the new rule a root-run
 * install with `HOME=/root` is not native to `/data/hermes/.hermes`, and the
 * installer writes `hermes-gateway-c5b5bead.service` — a hash of this path.
 *
 * So `HOME` is set to `HERMES_ACCOUNT_HOME`, which makes `Path.home()/.hermes`
 * *be* `HERMES_HOME` and the suffix empty again. That is not a trick played on
 * the naming rule, it is the rule's own question answered honestly: the box
 * runs exactly one Hermes, owned by the `hermes` account, whose native home
 * this is — and every other `hermes` invocation on the box already agrees,
 * since `hermesCmd()` goes through `runuser -u hermes`, which sets `HOME` to
 * the same directory. Only this one root-run command disagreed.
 *
 * Nothing in the unit's *contents* moves with it. In the `system=True` branch
 * the unit's `HERMES_HOME` is `_hermes_home_for_target_user(home_dir)`, which
 * lands on `/data/hermes/.hermes` whether it takes the remap branch (new) or
 * the keep-verbatim branch (old); `_remap_path_for_user` only rewrites paths
 * under `Path.home()`, and the venv lives under `/usr/local`, so it rewrites
 * nothing either way. `RealHost.exec` merges `opts.env` over the process
 * environment, so this replaces root's `HOME` for this one command only.
 *
 * `--no-start-now` because neither the managed config nor the tmpfs secrets
 * file exists yet at this point in the apply; the units phase starts it once
 * they do. Upstream still runs `systemctl daemon-reload` and still `enable`s
 * the unit (`start_on_login` defaults true and only the immediate start is
 * skipped), which is why this returns a boolean: to the units phase an
 * already-enabled unit looks like nothing to do, and the caller uses this to
 * restart it anyway.
 *
 * Only ever run when the unit is absent, and never with `--force`, so
 * hermeticd itself never regenerates the unit on a Hermes upgrade — deliberate,
 * and listed under the plan's Risks: regenerating it on every apply would hand
 * upstream the ability to change a running fleet's supervision on a version
 * bump alone. Upstream can still do it from the box: since `v2026.9.21` the
 * dashboard's start/restart buttons run `sudo -n hermes gateway …`, and that
 * path calls `refresh_systemd_unit_if_needed(system=True)`, which rewrites a
 * unit an older Hermes generated (one without `ExecStop=…systemd_stop_mark`).
 * The result is upstream's own unit for the pinned ref, and hermetic's drop-in
 * survives it, but "installed once" describes hermeticd, not the file.
 *
 * Returns whether *this* apply installed it. Throws `GATEWAY_UNIT_MISSING` if
 * the unit is not at the expected path — either because a previous apply's
 * installer already wrote one under another name (checked *before* reinstalling
 * over it) or because this one wrote nothing at all. See below.
 */
export async function ensureGatewayUnit(host: Host, dry: boolean): Promise<boolean> {
  const path = `${UNIT_DIR}/${HERMES_GATEWAY_UNIT}`;
  const present = (await host.stat(path)) !== null;
  if (dry) return false;
  if (!present) {
    /**
     * Look before installing. If upstream ever changes the naming rule, the
     * install already ran on some earlier apply and left a unit behind under
     * the other name — and running it a second time is at best a no-op and at
     * worst upstream's own "already installed" failure, which surfaces as
     * `COMMAND_FAILED` and buries the diagnostic this function exists to
     * produce. So an unexpected `hermes-gateway*.service` is reported as it
     * stands, and nothing is reinstalled over it.
     */
    const found = (
      await host.exec(["/bin/sh", "-c", `ls ${UNIT_DIR}/${GATEWAY_UNIT_GLOB} 2>/dev/null`])
    ).stdout.trim();
    if (found !== "") {
      throw new AgentdError(
        "GATEWAY_UNIT_MISSING",
        `no unit at ${path}, but hermes gateway install has already written ${found}. ` +
          `Upstream derives the name from HERMES_HOME (${HERMES_HOME}) against the invoking ` +
          `process's own HOME (${HERMES_ACCOUNT_HOME}) and hermetic expects no profile suffix; ` +
          "the installer is not run again over what is there",
        { path, hermes_home: HERMES_HOME, home: HERMES_ACCOUNT_HOME, found },
      );
    }
    await must(
      host,
      [HERMES_BIN, "gateway", "install", "--system", "--run-as-user", HERMES_USER, "--no-start-now"],
      {
        env: { HERMES_HOME, HOME: HERMES_ACCOUNT_HOME },
      },
    );
  }
  /**
   * And then check — on every apply, not only the one that installed it — that
   * the unit really is at the name hermetic expects.
   *
   * The name is not documented anywhere. Upstream derives it from `HERMES_HOME`
   * and appends a hash of that path whenever it is not the invoking process's
   * native `~/.hermes`; hermetic arranges for it to *be* that home by running
   * the installer with the `hermes` account's `HOME` (above), which is why
   * there is no suffix. But "arranges for" is an assumption about someone
   * else's code — one whose basis upstream already moved once, at `v2026.9.14`
   * — and the failure it produces is silent: `manifest.units` would
   * name a unit systemd has never heard of, the enable would fail or the
   * restart would restart nothing, and the box would still reach `ready` with
   * no gateway running on it. `ready` would be a lie, which is the one thing
   * the last stage exists to prevent.
   *
   * One `stat` per apply, and worth it: a Hermes upgrade that changed the
   * naming rule would otherwise be discovered by an operator whose agent had
   * quietly stopped answering its messages.
   */
  if ((await host.stat(path)) === null) {
    throw new AgentdError(
      "GATEWAY_UNIT_MISSING",
      `hermes gateway install wrote no unit at ${path}. Upstream derives the name from ` +
        `HERMES_HOME (${HERMES_HOME}) against the invoking process's own HOME ` +
        `(${HERMES_ACCOUNT_HOME}); check what it actually wrote with ` +
        `\`ls ${UNIT_DIR}/${GATEWAY_UNIT_GLOB}\``,
      { path, hermes_home: HERMES_HOME, home: HERMES_ACCOUNT_HOME },
    );
  }
  return !present;
}

/**
 * The first line of every file `render.ts` writes, and the only thing that makes
 * removing one of them safe.
 *
 * hermeticd deletes a file on the box in exactly one place — the unit below —
 * and the rule there is that hermetic removes what hermetic wrote. A unit at the
 * old path that does not carry this marker belongs to somebody else: an operator
 * who wrote their own `hermes.service`, or a future upstream installer that
 * takes the name. Either way it is not hermetic's to delete. The seam test in
 * `tests/seams.test.ts` asserts the rendered dashboard unit really does contain
 * this string, so the two halves cannot drift into "never matches, never
 * removes".
 */
export const HERMETIC_RENDERED_MARKER = "Rendered by hermetic";

/**
 * Disable and remove the dashboard unit hermetic used to render, on the apply
 * that installs its replacement (§6.4).
 *
 * The rename exists so upstream's own restart path finds the unit
 * (`HERMES_DASHBOARD_UNIT`), and it is the one unit rename hermetic has made.
 * `apply` never removes a unit that simply stopped being listed in a manifest,
 * which is the right default — a manifest is not an inventory of everything on
 * the box — and it is why this step has to be explicit.
 *
 * Idempotent in both directions: no old file means nothing to do, and a file
 * that is not hermetic's is reported and left where it is. Reloads systemd
 * itself, so the caller can skip its own reload: the removal is the last change
 * to `/etc/systemd/system` this apply makes before units are enabled.
 *
 * A dry run reports the unit in `result.changed` — the one place a plan says
 * what a real run would do — and emits nothing, because the event is written in
 * the present tense about a removal that is not happening.
 *
 * Returns whether it removed the unit.
 */
export async function removeLegacyDashboardUnit(
  host: Host,
  result: ApplyResult,
  emit: Emit,
  dry: boolean,
): Promise<boolean> {
  const path = `${UNIT_DIR}/${HERMES_LEGACY_DASHBOARD_UNIT}`;
  const content = await host.readFile(path);
  if (content === null) return false;
  if (!content.includes(HERMETIC_RENDERED_MARKER)) {
    emit(
      opEvent(
        "units",
        0.6,
        `${path} was not rendered by hermetic; leaving it in place. It runs a second ` +
          `dashboard against the same HERMES_HOME as ${HERMES_DASHBOARD_UNIT} if it is enabled`,
        host.now(),
        "warn",
      ),
    );
    return false;
  }
  result.changed.push(path);
  if (dry) return false;
  emit(
    opEvent(
      "units",
      0.6,
      `removing ${HERMES_LEGACY_DASHBOARD_UNIT}, superseded by ${HERMES_DASHBOARD_UNIT}`,
      host.now(),
    ),
  );
  // `--now` as well as `disable`: the symlink is only the next boot's problem,
  // and the running process is this boot's.
  await must(host, ["systemctl", "disable", "--now", HERMES_LEGACY_DASHBOARD_UNIT]);
  await host.remove(path);
  await must(host, ["systemctl", "daemon-reload"]);
  return true;
}

/**
 * The single-instance browser units hermetic rendered before the stack became
 * per-identity template instances (§7.3).
 *
 * Each one is the un-instantiated name of a unit the manifest now lists as
 * `<name>@<identity>.service`, and each holds exactly what its replacement
 * needs: `xvfb.service` owns `:99`, `x11vnc.service` owns 5900, `novnc.service`
 * owns 6080. They also run as root, which the template instances deliberately
 * do not.
 */
export const LEGACY_BROWSER_UNITS = ["xvfb.service", "x11vnc.service", "novnc.service"] as const;

/**
 * Disable and remove those units, on the apply that installs the instances
 * replacing them.
 *
 * Same rule and same guard as `removeLegacyDashboardUnit`: `apply` does not
 * prune a de-listed unit in general, so a rename has to be named here, and only
 * a file carrying `HERMETIC_RENDERED_MARKER` is hermetic's to delete. What is
 * different is the cost of *not* doing it. The legacy units are enabled and
 * running as root on every existing browser agent, so `xvfb@default.service`
 * and friends find the display and both ports taken and crash-loop forever
 * under `Restart=always` — the new stack cannot come up at all until the old
 * one is gone.
 *
 * Only for an agent that has browsers, decided per stack from the manifest
 * rather than from a flag: a legacy unit is removed when the manifest lists an
 * instance of that same stack. An agent created with `--browser` and later
 * rerun with `--no-browser` keeps whatever it has; that is a de-listed unit
 * like any other, and this is not the general pruner.
 *
 * Reloads systemd once at the end if it removed anything, so — like the
 * dashboard removal — the caller can skip its own reload. A dry run reports the
 * files in `result.changed` and emits nothing.
 *
 * Returns whether anything was removed.
 */
export async function removeLegacyBrowserUnits(
  host: Host,
  manifest: AgentConfig,
  result: ApplyResult,
  emit: Emit,
  dry: boolean,
): Promise<boolean> {
  let removed = false;
  for (const unit of LEGACY_BROWSER_UNITS) {
    const stack = unit.slice(0, -".service".length);
    // `xvfb@<identity>.service`, with an identity in it: the bare template name
    // `xvfb@.service` is a file the manifest writes, never a unit it lists.
    const instance = manifest.units.find(
      (u) =>
        u.startsWith(`${stack}@`) &&
        u.endsWith(".service") &&
        u.slice(stack.length + 1, -".service".length).length > 0,
    );
    if (instance === undefined) continue;

    const path = `${UNIT_DIR}/${unit}`;
    const content = await host.readFile(path);
    if (content === null) continue;
    if (!content.includes(HERMETIC_RENDERED_MARKER)) {
      emit(
        opEvent(
          "units",
          0.6,
          `${path} was not rendered by hermetic; leaving it in place. While it is enabled it ` +
            `holds the display or the port ${instance} needs, and that unit will not start`,
          host.now(),
          "warn",
        ),
      );
      continue;
    }
    result.changed.push(path);
    if (dry) continue;
    emit(opEvent("units", 0.6, `removing ${unit}, superseded by ${instance}`, host.now()));
    // `--now`: the symlink is the next boot's problem, and the root-owned
    // process squatting on the display is this boot's.
    await must(host, ["systemctl", "disable", "--now", unit]);
    await host.remove(path);
    removed = true;
  }
  // One reload for the three, after the last file is gone.
  if (removed) await must(host, ["systemctl", "daemon-reload"]);
  return removed;
}

/**
 * Refuse, with the cause and the remedy, to hand systemd a unit it does not
 * have — rather than letting `systemctl enable` fail with "Unit file X does not
 * exist" and nothing about *why* a manifest would name such a unit.
 *
 * `is-enabled` is the probe the units phase already runs. For a unit systemd
 * knows but has not enabled it prints the state (`disabled`, `static`, …) on
 * stdout and exits non-zero; for one it has never heard of it prints nothing on
 * stdout and complains on stderr. An empty stdout is therefore the signal, and
 * `systemctl cat` confirms it before anything is thrown — one extra exec, only
 * on the path that is about to fail anyway.
 *
 * The cause this names is the one that produced it: an agent manifest rendered
 * by a hermetic newer than the hermeticd applying it. Both carry a version, but
 * a version cannot tell two builds apart, and a newer core can list a unit that
 * only a newer hermeticd installs (`ensureGatewayUnit` was the first). The box
 * cannot fix that; the operator can, and the message says how.
 */
export async function requireKnownUnit(
  host: Host,
  manifest: AgentConfig,
  unit: string,
  isEnabled: { code: number; stdout: string; stderr: string },
): Promise<void> {
  if (isEnabled.code === 0 || isEnabled.stdout.trim() !== "") return;
  const shown = await host.exec(["systemctl", "cat", unit]);
  if (shown.code === 0) return;
  const reason = (isEnabled.stderr.trim() || shown.stderr.trim()).split("\n")[0] ?? "";
  throw new AgentdError(
    "UNIT_MISSING",
    `the agent manifest (config ${manifest.config_hash}) lists ${unit} in its units, but systemd on this box has no such unit file` +
      (reason ? ` (${reason})` : "") +
      `. This hermeticd is ${HERMETICD_VERSION}; the manifest was probably rendered by a newer hermetic, ` +
      "which can list a unit only a newer hermeticd knows how to install. Publish this checkout's release " +
      "with `hermetic artifacts push`, then `hermetic agent recreate <name>`: a rerun keeps the old binary, " +
      "and only a fresh instance fetches the pushed one.",
    { unit, config_hash: manifest.config_hash, hermeticd_version: HERMETICD_VERSION },
  );
}

/**
 * `$HERMES_HOME` belongs to the `hermes` account — all of it, on every apply.
 *
 * Upstream's CLI initialises the home of whoever invokes it: `hermes gateway
 * install --system` runs as root with `HERMES_HOME` pointed at the agent's
 * tree, and on the way in it creates `logs/agent.log`, `skills/`, `cron/` and
 * more, owned by root. The gateway then starts as `hermes`, cannot open its own
 * log, and exits 1 forever — `PermissionError: /data/hermes/.hermes/logs/agent.log`
 * on a box every check but the gateway's called healthy. An operator who runs
 * `sudo HERMES_HOME=… hermes …` for a look does the same thing by hand.
 *
 * So ownership is re-asserted rather than assumed, after the installer and on
 * every real apply: a recursive chown over the agent's memory is a sub-second
 * walk, and it is what makes the box heal from any root that touched the tree,
 * not only the one call hermeticd knows about. Symlinks are not followed.
 *
 * The same goes for the account's two install trees, `~/.local` and `~/.venv`
 * (`HERMES_USER_PREFIX`, `HERMES_AGENT_VENV`): the agent has full sudo, and one
 * `sudo -E npm install -g` or `sudo pip install` leaves root-owned files in a
 * tree its next unprivileged install has to write. Each only when present — a
 * box whose venv could not be built yet is not a failed apply.
 */
export async function ensureHermesHomeOwnership(host: Host, dry: boolean): Promise<void> {
  if (dry) return;
  const owner = `${HERMES_USER}:${HERMES_USER}`;
  await must(host, ["chown", "-R", "-h", owner, HERMES_HOME]);
  for (const tree of [HERMES_USER_PREFIX, HERMES_AGENT_VENV]) {
    if ((await host.lstat(tree)) === null) continue;
    await must(host, ["chown", "-R", "-h", owner, tree]);
  }
}

/** The owner and group a rendered file asks for; unset means root. */
export function ownershipOf(file: RenderedFile): { owner: string; group: string } {
  const owner = file.owner ?? "root";
  return { owner, group: file.group ?? file.owner ?? "root" };
}

/**
 * Apply `owner`/`group` when the manifest sets them. Idempotent: the current
 * ownership is read first, so a second apply reports nothing.
 *
 * The user may not exist yet — core renders the `useradd` as a `commands` entry,
 * which runs after `files` — so a missing owner defers rather than failing, and
 * the caller retries after the post-steps. On the retry pass a missing owner is
 * a real error: nothing else is going to create it.
 */
export async function ensureOwnership(
  host: Host,
  file: RenderedFile,
  dry: boolean,
  opts: { final?: boolean } = {},
): Promise<"unchanged" | "changed" | "deferred"> {
  if (!file.owner && !file.group) return "unchanged";
  const { owner, group } = ownershipOf(file);
  const want = `${owner}:${group}`;

  const current = await host.exec(["stat", "-c", "%U:%G", file.path]);
  if (current.code === 0 && current.stdout.trim() === want) return "unchanged";

  // A dry run stops here: the ownership would change, and the `useradd` that
  // would make it possible is itself a post-step this run did not execute.
  if (dry) return "changed";

  /**
   * Both halves are probed, not just the owner. A file can name a group whose
   * account does not exist yet while its owner does — the managed Hermes config
   * is `root:hermes`, and `root` exists on every box from the first second while
   * `hermes` is created by a post-step. Probing only the owner made that file's
   * chown depend on whether `chown` happened to fail, which is a different thing
   * from knowing it was too early.
   */
  const missing =
    (await host.exec(["id", "-u", owner])).code !== 0
      ? { kind: "user" as const, name: owner }
      : (await host.exec(["getent", "group", group])).code !== 0
        ? { kind: "group" as const, name: group }
        : null;
  if (missing) {
    if (opts.final) {
      throw new AgentdError(
        "COMMAND_FAILED",
        `${missing.kind} ${missing.name} does not exist, so ${file.path} cannot be owned ${want}`,
        { path: file.path, owner, group },
      );
    }
    return "deferred";
  }

  const chown = await host.exec(["chown", want, file.path]);
  if (chown.code !== 0) {
    if (opts.final) {
      throw new AgentdError("COMMAND_FAILED", `chown ${want} ${file.path} failed`, {
        path: file.path,
        code: chown.code,
      });
    }
    return "deferred";
  }
  return "changed";
}
