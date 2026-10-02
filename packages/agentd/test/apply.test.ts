import { beforeEach, describe, expect, test } from "bun:test";
import {
  NODE_VERSION,
  apply,
  nodeArch,
  parseDpkgQuery,
  resetAptIndexState,
  reportsHermesVersion,
  shasumFor,
  APT_OPTIONS,
  HERMETIC_RENDERED_MARKER,
  SECRETS_ENV_PATH,
} from "../src/apply/index.ts";
import {
  APT_LOCK_TIMEOUT_SECONDS,
  HERMES_ACCOUNT_HOME,
  HERMES_HOME,
  browserBuildKey,
  chromeBinaryPath,
  chromeInstallDir,
  hermesBundleKey,
} from "@hermetic/core/schema";
import type { FleetManifest } from "@hermetic/core/schema";
import { collector } from "../src/events.ts";
import { AgentdError } from "../src/errors.ts";
import { APPLY_PENDING_PATH, LEGACY_STOP_MARKER_PATH } from "../src/apply-pending.ts";
import { APPLIED_CONFIG_PATH } from "../src/manifest.ts";
import { FLEET_CACHE_PATH } from "../src/fleet.ts";
import { HERMES_BUNDLE_PATH } from "../src/hermes-source.ts";
import { expectNotRan, expectRan, ranInOrder } from "./fake-host.ts";
import { BoxHost as FakeHost, fakeCommitSha } from "./fake-box.ts";
import { makeFleetManifest, makeManifest, sha256Of, TEST_BUCKET, TEST_CHROME_REF } from "./fixtures.ts";

const HERMES_UNIT = "/etc/systemd/system/hermes-dashboard.service";
/** The dashboard unit hermetic used to render, before it took upstream's name. */
const LEGACY_DASHBOARD_UNIT = "/etc/systemd/system/hermes.service";
const HERMETICD_UNIT = "/etc/systemd/system/hermeticd.service";
const SUDOERS_APT = "/etc/sudoers.d/hermetic-apt";

/** The units the box currently records as owed a restart, or `[]` for none. */
function pendingUnits(host: FakeHost): string[] {
  const text = host.files.get(APPLY_PENDING_PATH)?.content;
  return text === undefined ? [] : (JSON.parse(text) as { units: string[] }).units;
}

describe("hermeticd apply — the four primitives (§6.4)", () => {
  let host: FakeHost;

  beforeEach(() => {
    host = new FakeHost();
    resetAptIndexState();
  });

  test("first apply installs packages, writes files, enables and restarts units", async () => {
    const manifest = makeManifest();
    const { emit, events } = collector();

    const result = await apply(manifest, { host, emit });

    expect(result.installed).toEqual(expect.arrayContaining(["curl", "jq", "nftables"]));
    expectRan(host, /^apt-get install/, 1);

    for (const file of manifest.files) {
      expect(result.changed).toContain(file.path);
      expect(host.files.get(file.path)?.content).toBe(file.content);
      expect(host.files.get(file.path)?.mode).toBe(file.mode);
    }

    expect(result.enabled).toEqual([
      "hermeticd.service",
      "hermes-dashboard.service",
      "hermes-gateway.service",
    ]);
    expect(result.restarted.sort()).toEqual([
      "hermes-dashboard.service",
      "hermes-gateway.service",
      "hermeticd.service",
    ]);
    expect(host.daemonReloads).toHaveLength(1);

    // The manifest's post-steps ran, in order, through the shell.
    expect(result.commands).toEqual(manifest.commands);
    expectRan(host, /nft -f \/etc\/hermetic\/nftables\.hermetic\.nft/);

    expect(events.at(-1)?.phase).toBe("done");
    expect(events.at(-1)?.progress).toBe(1);
  });

  test("a second apply of the same manifest reports zero changes and restarts nothing", async () => {
    const manifest = makeManifest();
    await apply(manifest, { host });
    host.commands.length = 0;

    const second = await apply(manifest, { host });

    expect(second.changed).toEqual([]);
    expect(second.contentChanged).toEqual([]);
    expect(second.modeCorrected).toEqual([]);
    expect(second.restarted).toEqual([]);
    expect(second.installed).toEqual([]);
    expect(second.commands).toEqual(manifest.commands);
    expect(second.enabled).toEqual([]);
    expect(host.daemonReloads).toHaveLength(1);
    // No apt-get, no systemctl enable/restart, no daemon-reload the second time.
    expectNotRan(host, /^apt-get/);
    expectNotRan(host, /^systemctl (restart|enable|daemon-reload)/);
  });

  test("a manifest with one changed unit file restarts only that unit", async () => {
    await apply(makeManifest(), { host });
    host.restarted.length = 0;

    const changed = makeManifest({
      hermesUnitBody:
        "[Service]\nExecStart=/usr/local/bin/hermes serve --host 127.0.0.1 --port 9119 --verbose\n",
    });
    const result = await apply(changed, { host });

    expect(result.changed).toEqual([HERMES_UNIT]);
    expect(result.contentChanged).toEqual([HERMES_UNIT]);
    expect(result.modeCorrected).toEqual([]);
    expect(result.restarted).toEqual(["hermes-dashboard.service"]);
    expect(host.restarted).toEqual(["hermes-dashboard.service"]);
    expect(host.files.get(HERMETICD_UNIT)?.content).not.toContain("--verbose");
    expect(host.daemonReloads).toHaveLength(2);
  });

  /**
   * nginx is the loopback proxy in front of Hermes: apt installs it, core
   * renders its `nginx.conf` as an ordinary file, and `nginx.service` is a
   * package-provided unit hermeticd never writes. Nothing puts
   * `/etc/systemd/system/nginx.service` in `rewritten`, so before the
   * newly-enabled set existed the unit was enabled and then left stopped until
   * the box next rebooted — with `tailscale serve` pointed at a port nobody was
   * listening on.
   */
  test("a unit the manifest lists but hermeticd does not render is enabled and started", async () => {
    const manifest = makeManifest({
      units: ["hermeticd.service", "hermes-dashboard.service", "nginx.service"],
      packages: ["curl", "git", "jq", "nftables", "nginx"],
    });

    const result = await apply(manifest, { host });

    expect(result.enabled).toContain("nginx.service");
    expect(result.restarted).toContain("nginx.service");
    expect(host.restarted).toContain("nginx.service");
    // No unit file was written for it — the start came from the enable, not
    // from a rendered file that changed.
    expect(host.files.has("/etc/systemd/system/nginx.service")).toBe(false);
    expect(result.changed).not.toContain("/etc/systemd/system/nginx.service");
  });

  /**
   * The incident: a fleet whose published hermeticd predated the gateway
   * feature booted a box with a manifest rendered by a core that already listed
   * `hermes-gateway.service`. The old hermeticd handed the name to
   * `systemctl enable`, which answered "Unit file hermes-gateway.service does
   * not exist." — true, and useless, because nothing said *why* a manifest
   * would name a unit the box could not have. This is that failure, caught
   * before systemctl is asked, with the cause and the remedy on it.
   */
  test("a unit systemd does not know refuses with the cause, before enable is attempted", async () => {
    const manifest = makeManifest({
      units: ["hermeticd.service", "hermes-dashboard.service", "ghost.service"],
    });

    const run = apply(manifest, { host });
    await expect(run).rejects.toMatchObject({
      code: "UNIT_MISSING",
      detail: { unit: "ghost.service", config_hash: manifest.config_hash },
    });
    await expect(apply(manifest, { host })).rejects.toThrow(
      /ghost\.service.*no such unit file.*artifacts push.*agent recreate/s,
    );
    // The diagnostic replaced the failure; systemd was never asked to enable
    // what it does not have.
    expectNotRan(host, /^systemctl enable ghost\.service/);
  });

  test("a unit that is known but disabled is enabled, not mistaken for a missing one", async () => {
    const manifest = makeManifest();
    await apply(manifest, { host });
    // Disable one behind hermeticd's back; the file is still there.
    host.enabledUnits.delete("hermes-dashboard.service");

    const second = await apply(manifest, { host });

    expect(second.enabled).toEqual(["hermes-dashboard.service"]);
  });

  test("a second apply leaves an already-enabled package unit alone", async () => {
    const manifest = makeManifest({
      units: ["hermeticd.service", "hermes-dashboard.service", "nginx.service"],
      packages: ["curl", "git", "jq", "nftables", "nginx"],
    });
    await apply(manifest, { host });
    host.restarted.length = 0;

    const second = await apply(manifest, { host });

    expect(second.enabled).toEqual([]);
    expect(second.restarted).toEqual([]);
    expect(host.restarted).toEqual([]);
  });

  /**
   * The account is a precondition, not a post-step. `hermes-dashboard.service` is
   * `User=hermes`, and the units phase starts it — so an apply that created the
   * account afterwards (as a manifest `commands` entry, which is where it used
   * to live) handed systemd a unit whose user did not exist and got `217/USER`
   * on every first boot.
   */
  test("the hermes account exists before any unit is started", async () => {
    const manifest = makeManifest();
    expect(host.users.has("hermes")).toBe(false);

    await apply(manifest, { host });

    expect(host.users.has("hermes")).toBe(true);
    expect(ranInOrder(host, [/^useradd /, /^systemctl restart /])).toBe(true);
    // …and the group the unit's `SupplementaryGroups=docker` needs, plus the
    // `WorkingDirectory` it would otherwise fail `200/CHDIR` on.
    expect(ranInOrder(host, [/^groupadd /, /^systemctl restart /])).toBe(true);
    expect(
      ranInOrder(host, [new RegExp(`^install -d .* ${HERMES_HOME}$`), /^systemctl restart /]),
    ).toBe(true);
  });

  /**
   * `$HERMES_HOME` is `$HOME/.hermes` of this account and nothing else — that
   * is the equality every upstream default-layout branch turns on (see
   * `packages/core/test/hermes-home.test.ts`). Here it has to be true of the
   * box: the account's home is what `useradd` was told, and both directories
   * exist before the units phase can start a `WorkingDirectory=` into one of
   * them.
   */
  test("the account is homed at /data/hermes with .hermes under it", async () => {
    await apply(makeManifest(), { host });

    const useradd = host.commands.find((c) => c.startsWith("useradd "))!;
    expect(useradd).toContain(`--home-dir ${HERMES_ACCOUNT_HOME}`);
    expect(useradd).toContain("--create-home");

    const installs = host.commandsMatching(/install -d /);
    const homeAt = installs.findIndex((c) => c.endsWith(` ${HERMES_ACCOUNT_HOME}`));
    const rootAt = installs.findIndex((c) => c.endsWith(` ${HERMES_HOME}`));
    // The parent first: `install -d` on a `.hermes` whose home is not there
    // yet is a failure, and a reattached data volume is exactly the box where
    // `useradd --create-home` declines to make one.
    expect(homeAt).toBeGreaterThanOrEqual(0);
    expect(rootAt).toBeGreaterThan(homeAt);
    // `0750` on both: the home holds the agent's state as surely as the
    // `.hermes` under it does, and nothing on the box reads either through the
    // filesystem — hermeticd is root and nginx proxies to a loopback port.
    expect(installs[homeAt]).toContain("-m 0750");
    expect(installs[rootAt]).toContain("-m 0750");
    /*
     * And the *privilege* each one is made with, which is not a detail. The home
     * hangs off root's own `/data`, so only root can make it and this line is
     * what makes it the account's. `.hermes` hangs off the home, which by then
     * belongs to `hermes` — so the account can put a symlink at that name, and a
     * root `install -d` would follow it and hand the target away. This one drops
     * privilege first, where the same symlink buys nothing.
     */
    expect(installs[homeAt]).toBe(`install -d -m 0750 -o hermes -g hermes ${HERMES_ACCOUNT_HOME}`);
    expect(installs[rootAt]).toBe(`runuser -u hermes -- install -d -m 0750 ${HERMES_HOME}`);
    // The account's own install prefix, `bin/` included so the skeleton
    // `~/.profile` puts it on `PATH` from the first login shell. As the account.
    expect(installs).toContain("runuser -u hermes -- install -d -m 0755 /data/hermes/.local/bin");
    // Upstream's on-demand install target, made by the account like the rest.
    expect(installs).toContain(
      "runuser -u hermes -- install -d -m 0755 /data/hermes/.hermes/lazy-packages",
    );

    expect(
      ranInOrder(host, [new RegExp(`^install -d .* ${HERMES_ACCOUNT_HOME}$`), /^systemctl restart /]),
    ).toBe(true);
  });

  /**
   * The `useradd` runs once, on the box that had no account — so a box created
   * before the home moved to the data volume would keep `/var/lib/hermes`
   * forever, and with it `$HOME/.hermes != HERMES_HOME`: the equality the whole
   * layout turns on. The re-home is the same re-assertion as `usermod -aG`, and
   * has to land in the same place — before the directories are made and long
   * before a unit is started into one of them.
   */
  describe("an account created before the home moved is re-homed", () => {
    test("a fresh box needs no move", async () => {
      await apply(makeManifest(), { host });

      expectNotRan(host, /^usermod --home/);
      // …and it is not that the check was skipped: the home was read back.
      expectRan(host, /^getent passwd hermes$/);
    });

    test("an account still at /var/lib/hermes is moved to /data/hermes", async () => {
      host.users.add("hermes");
      host.groups.add("hermes");
      host.userHomes.set("hermes", "/var/lib/hermes");

      await apply(makeManifest(), { host });

      const move = new RegExp(`^usermod --home ${HERMES_ACCOUNT_HOME} hermes$`);
      expectRan(host, move);
      // No `--move-home`: nothing under the old home is state hermetic wants.
      expectNotRan(host, /^usermod .*--move-home/);
      expect(ranInOrder(host, [move, new RegExp(`^install -d .* ${HERMES_ACCOUNT_HOME}$`)])).toBe(true);
      expect(ranInOrder(host, [move, /^systemctl restart /])).toBe(true);
    });

    test("the move happens once: the next apply reads the new home and stops", async () => {
      host.users.add("hermes");
      host.groups.add("hermes");
      host.userHomes.set("hermes", "/var/lib/hermes");
      await apply(makeManifest(), { host });
      host.commands.length = 0;

      await apply(makeManifest(), { host });

      expectNotRan(host, /^usermod --home/);
    });

    test("a dry run reads nothing and moves nothing", async () => {
      host.users.add("hermes");
      host.groups.add("hermes");
      host.userHomes.set("hermes", "/var/lib/hermes");

      await apply(makeManifest(), { host, dryRun: true });

      expectNotRan(host, /^usermod /);
      expectNotRan(host, /^getent passwd hermes$/);
    });
  });

  /**
   * `hermes` is a `--system` account with `nologin`, so nothing ever starts
   * `user@<uid>.service` for it. Upstream's system-scope gateway unit orders
   * itself `After=`/`Wants=` that manager, and only linger keeps one running for
   * an account nobody logs into — so linger is a precondition of *starting* the
   * gateway, and, like the account itself, has to be in place before the units
   * phase rather than left to whatever the installer happened to do.
   */
  test("the hermes account lingers, before any unit is started", async () => {
    const manifest = makeManifest();

    await apply(manifest, { host });

    expect(ranInOrder(host, [/^loginctl enable-linger hermes$/, /^systemctl restart /])).toBe(true);
  });

  /** Idempotent like the rest of `ensureAccounts`: a second apply still asserts it. */
  test("linger is re-asserted on every apply", async () => {
    const manifest = makeManifest();
    await apply(manifest, { host });
    host.commands.length = 0;

    await apply(manifest, { host });

    expectRan(host, /^loginctl enable-linger hermes$/);
  });

  test("ownership is applied on the pass that writes the file, and never restarts", async () => {
    const manifest = makeManifest();

    const result = await apply(manifest, { host });

    expect(host.files.get("/etc/hermes/config.yaml")?.ownership).toBe("root:hermes");
    expect(result.ownershipCorrected).toEqual(["/etc/hermes/config.yaml"]);
    expect(result.changed).toContain("/etc/hermes/config.yaml");
    // No longer deferred past the post-steps: the account exists before the
    // files phase, so the chown lands before the last of them.
    expect(ranInOrder(host, [/^useradd /, /^chown /, /nft -f/])).toBe(true);
    // Only the units whose files were written (plus the gateway this apply
    // installed) restart; the chown adds none.
    expect(result.restarted.sort()).toEqual([
      "hermes-dashboard.service",
      "hermes-gateway.service",
      "hermeticd.service",
    ]);
  });

  /**
   * The gap `restart_units` closes. `hermes-dashboard.service` reads
   * `/etc/hermes/config.yaml` and is not that file, so under the "own file
   * only" rule an `agent set --model` reached the box and left the old model
   * running. The file names its dependents; apply honours the name only when
   * the file's content actually changed.
   */
  describe("a file that names the units it feeds", () => {
    test("restarts them when its content changes", async () => {
      await apply(makeManifest(), { host });
      host.restarted.length = 0;

      const changed = makeManifest({ hermesConfigBody: 'model:\n  provider: "openrouter"\n' });
      const result = await apply(changed, { host });

      expect(result.contentChanged).toEqual(["/etc/hermes/config.yaml"]);
      // Both, in the manifest's unit order: a model that reached only the
      // dashboard would leave the gateway answering messages on the old one.
      expect(result.restarted).toEqual(["hermes-dashboard.service", "hermes-gateway.service"]);
      // The config is not a unit file, so systemd has nothing new to read.
      expect(host.daemonReloads).toHaveLength(1);
    });

    test("restarts nothing when its content has not changed", async () => {
      await apply(makeManifest(), { host });
      host.restarted.length = 0;

      const second = await apply(makeManifest(), { host });

      expect(second.contentChanged).toEqual([]);
      expect(second.restarted).toEqual([]);
      expect(host.restarted).toEqual([]);
    });

    /** An older core rendered no such declaration; that must still apply. */
    test("is ignored when the manifest declares none", async () => {
      await apply(makeManifest({ configRestartUnits: [] }), { host });
      host.restarted.length = 0;

      const result = await apply(
        makeManifest({
          configRestartUnits: [],
          hermesConfigBody: 'model:\n  provider: "openrouter"\n',
        }),
        { host },
      );

      expect(result.contentChanged).toEqual(["/etc/hermes/config.yaml"]);
      expect(result.restarted).toEqual([]);
    });
  });

  test("a second apply corrects no ownership and restarts nothing", async () => {
    const manifest = makeManifest();
    await apply(manifest, { host });
    host.restarted.length = 0;

    const second = await apply(manifest, { host });

    expect(second.ownershipCorrected).toEqual([]);
    expect(second.changed).toEqual([]);
    expect(second.restarted).toEqual([]);
    expect(host.restarted).toEqual([]);
    // Per-file corrections only: the `chown -R` over the hermes home is the
    // gateway step's, runs on every real apply, and corrects no rendered file.
    expectRan(host, /^chown (?!-R )/, 1);
    expect(host.files.get("/etc/hermes/config.yaml")?.ownership).toBe("root:hermes");
  });

  test("drifted ownership is corrected on its own, without a restart", async () => {
    const manifest = makeManifest();
    await apply(manifest, { host });
    host.restarted.length = 0;
    const file = host.files.get("/etc/hermes/config.yaml");
    host.files.set("/etc/hermes/config.yaml", {
      ...(file as { content: string; mode: string }),
      ownership: "root:root",
    });

    const result = await apply(manifest, { host });

    expect(result.ownershipCorrected).toEqual(["/etc/hermes/config.yaml"]);
    expect(result.contentChanged).toEqual([]);
    expect(result.restarted).toEqual([]);
    expect(host.files.get("/etc/hermes/config.yaml")?.ownership).toBe("root:hermes");
  });

  /**
   * hermeticd creates `hermes` and `docker` and nothing else. A file that names
   * some other account is an error rather than a file quietly left unreadable
   * by whatever needs it — the deferral exists to wait for a post-step, not to
   * forgive an owner nothing on the box will ever create.
   */
  test("an owner nothing creates is an error, not a silent skip", async () => {
    const manifest = makeManifest({ commands: [], owner: "postgres" });
    await expect(apply(manifest, { host })).rejects.toThrow(/user postgres does not exist/);
  });

  test("a file with no owner in the manifest is never chowned", async () => {
    const manifest = makeManifest();
    await apply(manifest, { host });
    const chowned = host.commandsMatching(/^chown (?!-R )/);
    expect(chowned).toHaveLength(1);
    expect(chowned[0]).toContain("/etc/hermes/config.yaml");
    expect(host.files.get("/etc/systemd/system/hermes-dashboard.service")?.ownership).toBeUndefined();
  });

  test("a mode-only drift is corrected, recorded separately, and restarts nothing", async () => {
    const manifest = makeManifest();
    await apply(manifest, { host });
    host.restarted.length = 0;
    // Drift the mode of a *unit* file: even that must not cause a restart —
    // only a content change can (§6.4).
    await host.chmod(HERMES_UNIT, "0777");
    await host.chmod("/etc/hermes/config.yaml", "0777");

    const result = await apply(manifest, { host });

    expect(result.changed.sort()).toEqual([HERMES_UNIT, "/etc/hermes/config.yaml"].sort());
    expect(result.ownershipCorrected).toEqual([]);
    expect(result.modeCorrected.sort()).toEqual([HERMES_UNIT, "/etc/hermes/config.yaml"].sort());
    expect(result.contentChanged).toEqual([]);
    expect(host.files.get("/etc/hermes/config.yaml")?.mode).toBe("0640");
    expect(host.files.get(HERMES_UNIT)?.mode).toBe("0644");
    expect(result.restarted).toEqual([]);
    expect(host.restarted).toEqual([]);
    // No unit file *content* moved, so no daemon-reload either.
    expect(host.daemonReloads).toHaveLength(1);
  });

  test("packages dpkg already reports installed are not reinstalled", async () => {
    host.installedPackages.add("curl");
    host.installedPackages.add("jq");

    const result = await apply(makeManifest(), { host });

    expect(result.installed).toContain("nftables");
    expect(result.installed).not.toContain("curl");
    expect(result.installed).not.toContain("jq");
    const installCommand = host.commandsMatching(/^apt-get install/)[0] ?? "";
    expect(installCommand).toContain("nftables");
    expect(installCommand).not.toMatch(/\bcurl\b/);
    expect(installCommand).not.toMatch(/\bjq\b/);
  });

  test("a manifest with no packages does not shell out to dpkg-query at all", async () => {
    const manifest = makeManifest({ packages: [] });
    // Hermes still installs from a checkout, and this manifest asks apt for
    // nothing — so git has to already be here for the install to be reachable.
    host.availableCommands.add("git");
    const result = await apply(manifest, { host });
    expectNotRan(host, /^dpkg-query/);
    expect(result.installed).toEqual(["hermes-agent@v2026.8.31", "node@24.20.0"]);
  });

  test("apt-get update runs once per process, even when no source moved", async () => {
    // Pre-seed the sources so nothing about apt sources changes on this apply,
    // but a package is still missing: the index must be refreshed once anyway.
    await apply(makeManifest(), { host });
    expectRan(host, /^apt-get update/, 1);

    host.installedPackages.delete("nftables");
    host.commands.length = 0;
    await apply(makeManifest(), { host });
    expectNotRan(host, /^apt-get update/);
    expectRan(host, /^apt-get install/, 1);
  });

  test("apt sources from the manifest are added once, and only then is apt-get update run", async () => {
    await apply(makeManifest(), { host });
    expect(host.files.get("/etc/apt/sources.list.d/tailscale.list")?.content).toContain(
      "pkgs.tailscale.com/stable/ubuntu noble main",
    );
    expect(host.files.has("/usr/share/keyrings/tailscale-archive-keyring.gpg")).toBe(true);
    // A binary keyring gets the binary extension and no armored twin.
    expect(host.files.has("/usr/share/keyrings/tailscale-archive-keyring.asc")).toBe(false);
    expectRan(host, /^apt-get update/, 1);

    host.commands.length = 0;
    await apply(makeManifest(), { host });
    expectNotRan(host, /^apt-get update/);
  });

  /**
   * apt picks its parser from the `signed-by=` file's extension, so the bytes a
   * vendor actually serves — armored or binary — decide where the key lands.
   */
  describe("apt keyrings follow the key's own encoding", () => {
    const DOCKER_KEY_URL = "https://download.docker.com/linux/ubuntu/gpg";
    const DOCKER_SOURCE = {
      name: "docker",
      uri: "https://download.docker.com/linux/ubuntu noble stable",
      key_url: DOCKER_KEY_URL,
    };
    const ARMORED_KEY =
      "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQINBFIT+FIXTURE\n-----END PGP PUBLIC KEY BLOCK-----\n";
    const ASC = "/usr/share/keyrings/docker-archive-keyring.asc";
    const GPG = "/usr/share/keyrings/docker-archive-keyring.gpg";
    const LIST = "/etc/apt/sources.list.d/docker.list";
    /** The cap `apply.ts` enforces; kept in step by the argv assertion below. */
    const MAX_KEY_BYTES = 1_048_576;

    const dockerManifest = () => makeManifest({ apt_sources: [DOCKER_SOURCE] });

    test("an armored key lands at .asc, and the source list points there", async () => {
      host.curlBodies.set(DOCKER_KEY_URL, ARMORED_KEY);

      const result = await apply(dockerManifest(), { host });

      expect(host.files.get(ASC)?.content).toBe(ARMORED_KEY);
      expect(host.files.has(GPG)).toBe(false);
      // The temp download is moved, not left beside the real thing.
      expect([...host.files.keys()].filter((p) => p.endsWith(".tmp"))).toEqual([]);
      expect(host.files.get(LIST)?.content).toContain(`signed-by=${ASC}`);
      expect(result.changed).toContain(ASC);
      expectRan(host, /^apt-get update/, 1);
    });

    test("a binary key keeps the .gpg path", async () => {
      // Real bytes, not a JS string: an OpenPGP packet tag is not valid UTF-8,
      // so a string fixture would arrive re-encoded and prove nothing.
      const binary = new Uint8Array([0x99, 0x02, 0x0d, 0x04, 0x66, 0x21]);
      host.curlBodies.set(DOCKER_KEY_URL, binary);

      await apply(dockerManifest(), { host });

      expect(await host.readBytes(GPG)).toEqual(binary);
      expect(host.files.has(ASC)).toBe(false);
      expect([...host.files.keys()].filter((p) => p.endsWith(".tmp"))).toEqual([]);
      expect(host.files.get(LIST)?.content).toContain(`signed-by=${GPG}`);
      expect(host.chmods).toContainEqual([GPG, "0644"]);
    });

    test("an armored key already mis-filed at .gpg is re-fetched, moved and un-broken", async () => {
      // Exactly the state a box left by the old unconditional `.gpg` is in:
      // the key is there, the list points at it, and apt cannot read it.
      host.curlBodies.set(DOCKER_KEY_URL, ARMORED_KEY);
      host.seed(GPG, ARMORED_KEY);
      host.seed(LIST, `# Rendered by hermetic. deb [signed-by=${GPG}] ${DOCKER_SOURCE.uri}\n`);

      const healed = await apply(dockerManifest(), { host });

      expectRan(host, /^curl .*keyrings/, 1);
      expect(host.files.get(ASC)?.content).toBe(ARMORED_KEY);
      expect(host.files.has(GPG)).toBe(false);
      expect(host.files.get(LIST)?.content).toContain(`signed-by=${ASC}`);
      expect(healed.changed).toContain(ASC);
      expect(healed.changed).toContain(LIST);
      expectRan(host, /^apt-get update/, 1);

      // Healed once is healed for good: the next apply re-fetches nothing.
      host.commands.length = 0;
      const again = await apply(dockerManifest(), { host });
      expectNotRan(host, /^curl /);
      expectNotRan(host, /^apt-get/);
      expect(again.changed).toEqual([]);
      expect(host.files.has(GPG)).toBe(false);
    });

    test("a broken box's plan names the same paths the real run then changes", async () => {
      host.curlBodies.set(DOCKER_KEY_URL, ARMORED_KEY);
      host.seed(GPG, ARMORED_KEY);
      host.seed(LIST, `# Rendered by hermetic. deb [signed-by=${GPG}] ${DOCKER_SOURCE.uri}\n`);

      // The mis-filed key is itself the evidence of where the fetch will land,
      // so the plan must not fall back to the conventional `.gpg`.
      const plan = await apply(dockerManifest(), { host, dryRun: true });
      expect(plan.changed).toContain(ASC);
      expect(plan.changed).not.toContain(GPG);

      const real = await apply(dockerManifest(), { host });
      const paths = (changed: string[]) => [...new Set(changed)].sort();
      expect(paths(plan.changed)).toEqual(paths(real.changed));
    });

    test("a failed fetch leaves no temp file and no source list", async () => {
      host.seed(LIST, "# stale\n");
      host.when(/^curl /, { code: 22, stderr: "404 Not Found" });

      await expect(apply(dockerManifest(), { host })).rejects.toThrow(AgentdError);

      expect([...host.files.keys()].filter((p) => p.endsWith(".tmp"))).toEqual([]);
      expect(host.files.has(ASC)).toBe(false);
      expect(host.files.has(GPG)).toBe(false);
      // The list still names the keyring that was never replaced.
      expect(host.files.get(LIST)?.content).toBe("# stale\n");
    });

    test.each([
      ["an empty body", ""],
      ["an HTML error page", "<!DOCTYPE html>\n<html><body>403</body></html>\n"],
      ["a truncated key", "\u0000\u0000"],
    ])("a 200 that is not a key fails loudly: %s", async (_label, body) => {
      host.curlBodies.set(DOCKER_KEY_URL, body);

      const failure = apply(dockerManifest(), { host });
      await expect(failure).rejects.toThrow(AgentdError);
      // The message names the URL, so the operator knows which vendor lied.
      await expect(failure).rejects.toThrow(DOCKER_KEY_URL);

      expect([...host.files.keys()].filter((p) => p.endsWith(".tmp"))).toEqual([]);
      expect(host.files.has(ASC)).toBe(false);
      expect(host.files.has(GPG)).toBe(false);
    });

    test("an empty keyring left by an earlier half-download is re-fetched", async () => {
      const binary = new Uint8Array([0x99, 0x02, 0x0d, 0x04]);
      host.curlBodies.set(DOCKER_KEY_URL, binary);
      host.seed(GPG, "");

      const result = await apply(dockerManifest(), { host });

      expectRan(host, /^curl .*keyrings/, 1);
      expect(await host.readBytes(GPG)).toEqual(binary);
      expect(result.changed).toContain(GPG);
    });

    test("the fetch asks curl for a size cap", async () => {
      host.curlBodies.set(DOCKER_KEY_URL, ARMORED_KEY);
      await apply(dockerManifest(), { host });
      expect(host.commandsMatching(/^curl /)[0]).toContain("--max-filesize 1048576");
    });

    test("an oversize body is refused even though curl accepted it", async () => {
      // curl's own cap cannot be enforced on a chunked response, so the size on
      // disk is re-checked: a valid packet tag does not buy an unbounded body.
      host.curlBodies.set(DOCKER_KEY_URL, "\u0099" + "a".repeat(MAX_KEY_BYTES));

      const failure = apply(dockerManifest(), { host });
      await expect(failure).rejects.toThrow(AgentdError);
      // The size branch, not the shape branch: the message names both.
      await expect(failure).rejects.toThrow(
        new RegExp(`${DOCKER_KEY_URL}.*past the ${MAX_KEY_BYTES}-byte limit`),
      );

      expect([...host.files.keys()].filter((p) => p.endsWith(".tmp"))).toEqual([]);
      expect(host.files.has(ASC)).toBe(false);
      expect(host.files.has(GPG)).toBe(false);
    });

    test("a junk twin dropped beside a good keyring is removed, and nothing else moves", async () => {
      host.curlBodies.set(DOCKER_KEY_URL, ARMORED_KEY);
      await apply(dockerManifest(), { host });
      expect(host.files.get(LIST)?.content).toContain(`signed-by=${ASC}`);

      // Something put a `.gpg` back beside the key apt is actually using.
      host.seed(GPG, "<!DOCTYPE html>\n");
      host.commands.length = 0;

      const result = await apply(dockerManifest(), { host });

      expect(host.files.has(GPG)).toBe(false);
      expect(host.files.get(ASC)?.content).toBe(ARMORED_KEY);
      expectNotRan(host, /^curl /);
      // The list already names the surviving key, so nothing is rewritten.
      expect(result.changed).toEqual([]);
    });

    test("an apt source whose name is not a bare name is refused", async () => {
      const escaping = { ...DOCKER_SOURCE, name: "../../etc/cron.d/evil" };

      const failure = apply(makeManifest({ apt_sources: [escaping] }), { host });
      await expect(failure).rejects.toThrow(AgentdError);
      await expect(failure).rejects.toThrow(/bare name/);

      expectNotRan(host, /^curl /);
    });

    test("a dry run reports the keyring it would create and writes nothing", async () => {
      host.curlBodies.set(DOCKER_KEY_URL, ARMORED_KEY);

      const result = await apply(dockerManifest(), { host, dryRun: true });

      // The extension is unknowable without the download, so the plan names the
      // conventional binary path — the fact being reported is "a key is missing".
      expect(result.changed).toContain(GPG);
      expect(result.changed).toContain(LIST);
      expect(host.files.size).toBe(0);
      expectNotRan(host, /^curl /);
      expectNotRan(host, /^apt-get/);
    });
  });

  test("bitwarden disabled: no bws package, no bws call, an empty environment file", async () => {
    const manifest = makeManifest({ secrets_mode: "none" });
    const result = await apply(manifest, { host });

    expect(manifest.packages).not.toContain("bws");
    expect(result.installed).not.toContain("bws");
    expectNotRan(host, /^bws /);
    // §8.3: the file is written for every manifest, empty when the manifest
    // carries nothing, so a key a previous binding left there does not survive.
    // The dashboard unit `Requires=` it either way.
    expect(host.files.get(SECRETS_ENV_PATH)?.content).toBe("\n");
    expect(host.files.get(SECRETS_ENV_PATH)?.mode).toBe("0600");
    expect(result.changed).toContain(SECRETS_ENV_PATH);

    // Idempotent: a second apply of the same manifest leaves it alone.
    const again = await apply(manifest, { host });
    expect(again.changed).not.toContain(SECRETS_ENV_PATH);
  });

  test("bitwarden enabled: secrets land on tmpfs at mode 600, never under /data", async () => {
    host.when(/^bws /, { stdout: JSON.stringify([{ key: "ANTHROPIC_API_KEY", value: "sk-fixture" }]) });
    const manifest = makeManifest({ secrets_mode: "bitwarden" });

    const result = await apply(manifest, { host, bwsToken: "0.token.fixture" });

    const env = host.files.get(SECRETS_ENV_PATH);
    expect(env?.mode).toBe("0600");
    expect(env?.content).toContain("ANTHROPIC_API_KEY=sk-fixture");
    expect(SECRETS_ENV_PATH.startsWith("/run/")).toBe(true);
    // The data volume does carry files now — the agent's own venv — but none
    // of them holds a secret.
    expect(
      [...host.files].some(
        ([p, f]) =>
          p.startsWith("/data") && (f.content.includes("sk-fixture") || f.content.includes("0.token")),
      ),
    ).toBe(false);
    expect(result.changed).toContain(SECRETS_ENV_PATH);

    // The token reaches bws through the environment, never through argv.
    expect(host.commandsMatching(/^bws /)[0]).not.toContain("0.token.fixture");
  });

  test("a keyed provider's key becomes its variable in the tmpfs env file", async () => {
    const manifest = makeManifest({ provider: "nous" });

    const result = await apply(manifest, { host, providerKey: "nous-FIXTURE-KEY" });

    const env = host.files.get(SECRETS_ENV_PATH);
    expect(env?.mode).toBe("0600");
    expect(env?.content).toBe("NOUS_API_KEY=nous-FIXTURE-KEY\n");
    expect(result.changed).toContain(SECRETS_ENV_PATH);
    // Nothing Bitwarden-shaped exists on a box that only has a provider key.
    expectNotRan(host, /^bws /);
  });

  test("a switch from a keyed provider to Bedrock clears the key line (§8.3)", async () => {
    await apply(makeManifest({ provider: "nous" }), { host, providerKey: "nous-FIXTURE-KEY" });
    expect(host.files.get(SECRETS_ENV_PATH)?.content).toBe("NOUS_API_KEY=nous-FIXTURE-KEY\n");

    const result = await apply(makeManifest({ provider: "bedrock" }), { host });

    // The previous provider's key does not outlive the binding that put it there.
    expect(host.files.get(SECRETS_ENV_PATH)?.content).toBe("\n");
    expect(result.changed).toContain(SECRETS_ENV_PATH);
  });

  test("a keyed provider with bitwarden gets one file with both sources", async () => {
    host.when(/^bws /, { stdout: JSON.stringify([{ key: "GITHUB_TOKEN", value: "ghp-fixture" }]) });
    const manifest = makeManifest({ provider: "openrouter", secrets_mode: "bitwarden" });

    await apply(manifest, { host, providerKey: "sk-or-FIXTURE", bwsToken: "0.token.fixture" });

    const env = host.files.get(SECRETS_ENV_PATH);
    expect(env?.content).toContain("OPENROUTER_API_KEY=sk-or-FIXTURE");
    expect(env?.content).toContain("GITHUB_TOKEN=ghp-fixture");
  });

  test("a keyed provider with no key resolved is a refused apply, not a keyless box", async () => {
    const manifest = makeManifest({ provider: "openrouter" });
    await expect(apply(manifest, { host })).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(host.files.has(SECRETS_ENV_PATH)).toBe(false);
  });

  test("the environment file is materialised before any unit is enabled or restarted", async () => {
    host.when(/^bws /, { stdout: JSON.stringify([{ key: "K", value: "V" }]) });
    await apply(makeManifest({ secrets_mode: "bitwarden" }), { host, bwsToken: "0.token.fixture" });

    expect(ranInOrder(host, [/^bws /, /^systemctl (enable|restart|daemon-reload)/])).toBe(true);
  });

  test("--dry-run reports the secrets file accurately without writing it", async () => {
    host.when(/^bws /, { stdout: JSON.stringify([{ key: "K", value: "V" }]) });
    const manifest = makeManifest({ secrets_mode: "bitwarden" });

    const first = await apply(manifest, { host, bwsToken: "0.token.fixture", dryRun: true });
    expect(first.changed).toContain(SECRETS_ENV_PATH);
    expect(host.files.has(SECRETS_ENV_PATH)).toBe(false);

    // Now the file exists with exactly that content: a dry run must say so.
    await apply(manifest, { host, bwsToken: "0.token.fixture" });
    const second = await apply(manifest, { host, bwsToken: "0.token.fixture", dryRun: true });
    expect(second.changed).not.toContain(SECRETS_ENV_PATH);
  });

  test("--dry-run probes reality and mutates nothing", async () => {
    const manifest = makeManifest();
    const result = await apply(manifest, { host, dryRun: true });

    expect(result.changed.length).toBeGreaterThan(0);
    expect(result.ownershipCorrected).toEqual(["/etc/hermes/config.yaml", SUDOERS_APT]);
    expectNotRan(host, /^chown /);
    expect(host.files.has("/etc/hermes/config.yaml")).toBe(false);
    expectNotRan(host, /^apt-get/);
    // Not even the validation: a dry run installs no sudoers file, so there is
    // nothing staged for visudo to read.
    expectNotRan(host, /^visudo /);
    expect(host.files.has(SUDOERS_APT)).toBe(false);
    expect(host.restarted).toEqual([]);
    expect(host.daemonReloads).toEqual([]);
  });

  test("parseDpkgQuery only counts `install ok installed`", () => {
    const parsed = parseDpkgQuery(
      "curl install ok installed\njq deinstall ok config-files\nnftables install ok installed\n",
    );
    expect([...parsed].sort()).toEqual(["curl", "nftables"]);
  });
});

/**
 * §6.4's gateway. hermetic renders `hermes-dashboard.service` (the dashboard) and does
 * not render the gateway's unit at all: `hermes gateway install --system`
 * writes it, once, on the box that does not have it yet.
 *
 * The tests below are about the seam that creates — a unit hermeticd enables,
 * restarts and drops a file beside, but did not write.
 */
describe("upstream's gateway unit", () => {
  let host: FakeHost;

  beforeEach(() => {
    host = new FakeHost();
    resetAptIndexState();
  });

  const GATEWAY_UNIT_PATH = "/etc/systemd/system/hermes-gateway.service";
  const GATEWAY_DROPIN = "/etc/systemd/system/hermes-gateway.service.d/hermetic.conf";

  /**
   * Upstream's installer runs as root with `HERMES_HOME` set and initialises
   * the home as root — `logs/agent.log` among the rest — so the gateway, which
   * runs as `hermes`, could not open its own log and exited 1 on every start.
   */
  test("the agent's home is chowned back to hermes after the installer, on every real apply", async () => {
    const manifest = makeManifest();
    await apply(manifest, { host });

    expect(
      ranInOrder(host, [/gateway install/, /^chown -R -h hermes:hermes \/data\/hermes\/\.hermes$/]),
    ).toBe(true);

    host.commands.length = 0;
    await apply(manifest, { host });
    expectRan(host, /^chown -R -h hermes:hermes \/data\/hermes\/\.hermes$/, 1);

    host.commands.length = 0;
    await apply(manifest, { host, dryRun: true });
    expectNotRan(host, /^chown /);
  });

  test("the first apply installs it, after the account and before any file", async () => {
    /**
     * `HERMES_HOME` *and* `HOME` both have to reach the installer, and `HOME`
     * has to be the `hermes` account's rather than root's.
     *
     * Upstream names the unit from `_profile_suffix()`, which as of
     * `v2026.9.14` asks whether `HERMES_HOME` is the invoking process's own
     * native `~/.hermes` (`hermes_cli/gateway.py:2015-2041`). Left as root's
     * `/root`, it is not, and the installer writes
     * `hermes-gateway-c5b5bead.service` — a hash of `/data/hermes/.hermes` —
     * which `ensureGatewayUnit` then fails on. With the account's `HOME` the
     * suffix is empty and the name is a fact again.
     */
    const seen: Array<Record<string, string> | undefined> = [];
    host.when(/hermes gateway install/, (_argv, opts) => {
      seen.push(opts?.env);
      return null;
    });

    await apply(makeManifest(), { host });

    const install = host.gatewayInstalls[0]!;
    expect(install.argv).toEqual([
      "/usr/local/bin/hermes",
      "gateway",
      "install",
      "--system",
      "--run-as-user",
      "hermes",
      "--no-start-now",
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.["HERMES_HOME"]).toBe(HERMES_HOME);
    expect(seen[0]?.["HOME"]).toBe(HERMES_ACCOUNT_HOME);

    expect(ranInOrder(host, [/^useradd /, /gateway install/, /^systemctl daemon-reload$/])).toBe(true);
    expect(ranInOrder(host, [new RegExp(`^install -d .* ${HERMES_HOME}$`), /gateway install/])).toBe(
      true,
    );
  });

  /** hermetic writes no unit here — only the drop-in beside it. */
  test("hermeticd never writes the unit file itself", async () => {
    const manifest = makeManifest();
    expect(manifest.files.map((f) => f.path)).not.toContain(GATEWAY_UNIT_PATH);

    const result = await apply(manifest, { host });

    expect(result.changed).not.toContain(GATEWAY_UNIT_PATH);
    expect(result.contentChanged).not.toContain(GATEWAY_UNIT_PATH);
    // …but the drop-in is hermetic's, and it did land.
    expect(result.contentChanged).toContain(GATEWAY_DROPIN);
    expect(host.files.has(GATEWAY_UNIT_PATH)).toBe(true);
  });

  /**
   * `hermes gateway install` enables the unit itself — `start_on_login`
   * defaults true and `--no-start-now` skips only the immediate start — so by
   * the time the units phase asks, `is-enabled` already answers `enabled`.
   * Without the "this apply installed it" clause the gateway would be left
   * installed, enabled and stopped, and `ready` would be a lie.
   */
  test("it is restarted on the apply that installed it, even though it is already enabled", async () => {
    host.when(/^systemctl is-enabled hermes-gateway\.service/, { stdout: "enabled\n" });

    const result = await apply(makeManifest(), { host });

    expect(result.enabled).not.toContain("hermes-gateway.service");
    expect(result.restarted).toContain("hermes-gateway.service");
    expect(host.restarted).toContain("hermes-gateway.service");
  });

  test("a second apply finds the unit and runs no installer", async () => {
    await apply(makeManifest(), { host });
    expect(host.gatewayInstalls).toHaveLength(1);

    const second = await apply(makeManifest(), { host });

    expect(host.gatewayInstalls).toHaveLength(1);
    expect(second.restarted).toEqual([]);
  });

  /** The drop-in is not the unit's own file, so `restart_units` is what moves it. */
  test("a changed drop-in reloads systemd and restarts the gateway alone", async () => {
    await apply(makeManifest(), { host });
    host.restarted.length = 0;

    const result = await apply(
      makeManifest({ gatewayDropInBody: "[Service]\nEnvironment=DISPLAY=:99\n" }),
      { host },
    );

    expect(result.contentChanged).toEqual([GATEWAY_DROPIN]);
    expect(result.restarted).toEqual(["hermes-gateway.service"]);
    // A drop-in is a unit-directory file: systemd has to be told to re-read it.
    expect(host.daemonReloads).toHaveLength(2);
  });

  test("a changed managed config restarts both Hermes units", async () => {
    await apply(makeManifest(), { host });
    host.restarted.length = 0;

    const result = await apply(
      makeManifest({ hermesConfigBody: 'model:\n  provider: "openrouter"\n' }),
      { host },
    );

    expect(result.restarted).toEqual(["hermes-dashboard.service", "hermes-gateway.service"]);
  });

  /**
   * The unit's name is inferred from `HERMES_HOME`, not documented, so an
   * installer that exits 0 and writes something else must stop the apply rather
   * than let the units phase enable and restart a unit systemd has never heard
   * of — which it would do silently, and the box would still reach `ready`.
   */
  test("an installer that writes nothing fails the apply, before any restart", async () => {
    host.when(/hermes gateway install/);

    const err = (await apply(makeManifest(), { host }).catch((e: unknown) => e)) as AgentdError;

    expect(err).toBeInstanceOf(AgentdError);
    expect(err.code).toBe("GATEWAY_UNIT_MISSING");
    expect(err.message).toContain(GATEWAY_UNIT_PATH);
    expect(err.message).toContain(HERMES_HOME);
    expect(err.message).toContain("ls /etc/systemd/system/hermes-gateway*.service");
    // Nothing downstream ran: no unit was touched and no file was written.
    expect(host.restarted).toEqual([]);
    expect(host.daemonReloads).toEqual([]);
    expect(host.files.has("/etc/hermes/config.yaml")).toBe(false);
  });

  test("a unit written under another name is the same failure", async () => {
    host.when(/hermes gateway install/, () => {
      // What a non-default `HERMES_HOME` would have produced: a profile hash.
      host.files.set("/etc/systemd/system/hermes-gateway-deadbeef.service", {
        content: "[Service]\nExecStart=/usr/local/lib/hermes-agent/venv/bin/python\n",
        mode: "0644",
      });
      return {};
    });

    const err = (await apply(makeManifest(), { host }).catch((e: unknown) => e)) as AgentdError;

    expect(err).toBeInstanceOf(AgentdError);
    expect(err.code).toBe("GATEWAY_UNIT_MISSING");
    expect(host.restarted).toEqual([]);
    expectRan(host, /gateway install/, 1);
  });

  /**
   * And the apply after it does not install again. Upstream's installer is not
   * idempotent in the way a second run needs it to be — "already installed" is
   * an error — and a `COMMAND_FAILED` from it would replace the one diagnostic
   * that says what actually went wrong.
   */
  test("the next apply refuses without reinstalling, naming what it found", async () => {
    // The unit as an earlier apply's installer left it, under the wrong name.
    host.files.set("/etc/systemd/system/hermes-gateway-deadbeef.service", {
      content: "[Service]\nExecStart=/usr/local/lib/hermes-agent/venv/bin/python\n",
      mode: "0644",
    });

    const err = (await apply(makeManifest(), { host }).catch((e: unknown) => e)) as AgentdError;

    expect(err).toBeInstanceOf(AgentdError);
    expect(err.code).toBe("GATEWAY_UNIT_MISSING");
    expect(err.message).toContain("/etc/systemd/system/hermes-gateway-deadbeef.service");
    expect(err.detail["found"]).toBe("/etc/systemd/system/hermes-gateway-deadbeef.service");
    // The whole point: the installer never ran, so its own error cannot mask this.
    expectNotRan(host, /gateway install/);
    expect(host.gatewayInstalls).toEqual([]);
    expect(host.restarted).toEqual([]);
  });

  /** Re-asserted every apply, not only the one that installed it. */
  test("a unit that disappeared later is caught on the next apply", async () => {
    await apply(makeManifest(), { host });
    host.files.delete(GATEWAY_UNIT_PATH);
    // …and the installer has stopped writing it, as a changed upstream would.
    host.when(/hermes gateway install/);

    const err = (await apply(makeManifest(), { host }).catch((e: unknown) => e)) as AgentdError;

    expect(err).toBeInstanceOf(AgentdError);
    expect(err.code).toBe("GATEWAY_UNIT_MISSING");
  });

  test("--dry-run runs no installer and writes no unit", async () => {
    await apply(makeManifest(), { host, dryRun: true });

    expect(host.gatewayInstalls).toEqual([]);
    expectNotRan(host, /gateway install/);
    expect(host.files.has(GATEWAY_UNIT_PATH)).toBe(false);
  });
});

/**
 * §6.4's Hermes step. Hermes Agent is not on PyPI, so the install is upstream's
 * own shape: a git checkout at the manifest's `hermes_ref`, a `uv` editable
 * install into `/usr/local/lib/hermes-agent/venv`, one symlink on `PATH`, and a
 * cross-check that the ref really reports the manifest's `hermes_version`.
 */
describe("hermes from the pinned upstream ref", () => {
  let host: FakeHost;

  beforeEach(() => {
    host = new FakeHost();
    resetAptIndexState();
  });

  /** The install commands, in order, with the noise of the rest of apply gone. */
  function hermesCommands(): string[] {
    return host.commands.filter((c) =>
      /^(git|uv) |^ln -sfn \/usr\/local\/lib\/hermes-agent|astral\.sh\/uv|^\/usr\/local\/bin\/hermes /.test(
        c,
      ),
    );
  }

  test("a fresh box clones the ref, makes the venv, installs editable and links", async () => {
    const result = await apply(makeManifest(), { host });

    expect(hermesCommands()).toEqual([
      // uv first, because nothing else in the sequence can run without it.
      "/bin/sh -c curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh",
      "git clone --depth 1 --branch v2026.8.31 https://github.com/NousResearch/hermes-agent.git /usr/local/lib/hermes-agent",
      "uv venv --python 3.11 /usr/local/lib/hermes-agent/venv",
      "uv pip install --python /usr/local/lib/hermes-agent/venv/bin/python -e /usr/local/lib/hermes-agent[all,messaging,bedrock]",
      "ln -sfn /usr/local/lib/hermes-agent/venv/bin/hermes /usr/local/bin/hermes",
      "/usr/local/bin/hermes --version",
      // The checkout stays root's and the units run as `hermes`, which since
      // git 2.35.2 is a repository the service user cannot even read. The
      // exception restores the read without restoring the write.
      "git config --system --get-all safe.directory",
      "git config --system --add safe.directory /usr/local/lib/hermes-agent",
      // A direct clone's HEAD *is* upstream's commit, so that is where
      // `HERMES_REVISION` comes from; the mirror path reads it off the marker
      // instead and never runs this.
      "git -C /usr/local/lib/hermes-agent rev-parse --is-shallow-repository",
      "git -C /usr/local/lib/hermes-agent rev-parse HEAD",
      // …and then the box asks that very `hermes` to write its own gateway
      // unit, which is why this belongs to the install sequence rather than to
      // the units phase.
      "/usr/local/bin/hermes gateway install --system --run-as-user hermes --no-start-now",
    ]);
    expect(result.installed).toContain("hermes-agent@v2026.8.31");
    expect(result.changed).toContain("/usr/local/bin/hermes");
    // The ref is recorded, which is what makes the next apply a no-op.
    expect(host.files.get("/usr/local/lib/hermes-agent/.hermetic-ref")?.content).toBe("v2026.8.31\n");
    expect(host.files.get("/etc/hermes/revision.env")?.content).toBe(
      `HERMES_REVISION=${fakeCommitSha("v2026.8.31")}\n`,
    );
    expect(host.gitSystemConfig.get("safe.directory")).toEqual(["/usr/local/lib/hermes-agent"]);
  });

  test("uv is installed once, from astral's own installer, and never re-installed", async () => {
    await apply(makeManifest(), { host });
    const installer = host.commands.filter((c) => c.includes("astral.sh/uv/install.sh"));
    expect(installer).toHaveLength(1);
    // Neither of the two things upstream's installer does that we refuse.
    expect(installer[0]).toContain("UV_INSTALL_DIR=/usr/local/bin");
    expect(installer[0]).toContain("INSTALLER_NO_MODIFY_PATH=1");

    host.commands.length = 0;
    host.hermesInstalledVersion = null; // force the install path again
    await host.remove("/usr/local/lib/hermes-agent/.hermetic-ref");
    await apply(makeManifest(), { host });
    expectNotRan(host, /astral\.sh/);
  });

  test("a box that already has uv never fetches the installer", async () => {
    host.availableCommands.add("uv");
    await apply(makeManifest(), { host });
    expectNotRan(host, /astral\.sh/);
  });

  test("an OpenAI-compatible provider gets `[all]` and no provider extra", async () => {
    await apply(makeManifest({ provider: "openrouter" }), { host, providerKey: "FIXTURE" });
    const install = host.commands.find((c) => c.startsWith("uv pip install")) ?? "";
    expect(install).toEndWith("-e /usr/local/lib/hermes-agent[all,messaging]");
  });

  test("anthropic gets its own extra alongside `all`", async () => {
    await apply(makeManifest({ provider: "anthropic" }), { host, providerKey: "FIXTURE" });
    const install = host.commands.find((c) => c.startsWith("uv pip install")) ?? "";
    expect(install).toEndWith("-e /usr/local/lib/hermes-agent[all,messaging,anthropic]");
  });

  test("an already-pinned checkout re-clones nothing and rewrites nothing", async () => {
    const manifest = makeManifest();
    await apply(manifest, { host });

    host.commands.length = 0;
    const result = await apply(manifest, { host });

    // The version banner is read to confirm the pin. The two git calls after it
    // are the local-state ones every apply repeats: the `safe.directory` read,
    // which finds what the first apply wrote and adds nothing, and the
    // `rev-parse` behind `HERMES_REVISION`, which resolves to the same commit
    // and leaves the file alone. Neither touches the network.
    expect(hermesCommands()).toEqual([
      "/usr/local/bin/hermes --version",
      "git config --system --get-all safe.directory",
      "git -C /usr/local/lib/hermes-agent rev-parse --is-shallow-repository",
      "git -C /usr/local/lib/hermes-agent rev-parse HEAD",
    ]);
    expect(host.gitSystemConfig.get("safe.directory")).toEqual(["/usr/local/lib/hermes-agent"]);
    expectNotRan(host, /^(uv|ln) /);
    expectNotRan(host, /^git (clone|fetch|checkout)|^git -C \S+ (clone|fetch|checkout)/);
    expect(result.installed).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  test("a pinned checkout built without the messaging extra reinstalls it", async () => {
    // A box installed by a hermeticd that predates `messaging`: the ref and the
    // version match, but nothing records which extras the venv carries.
    const manifest = makeManifest();
    await apply(manifest, { host });
    await host.remove("/usr/local/lib/hermes-agent/.hermetic-extras");

    host.commands.length = 0;
    const result = await apply(manifest, { host });

    const install = host.commands.find((c) => c.startsWith("uv pip install")) ?? "";
    expect(install).toEndWith("-e /usr/local/lib/hermes-agent[all,messaging,bedrock]");
    expect(host.files.get("/usr/local/lib/hermes-agent/.hermetic-extras")?.content).toBe(
      "/usr/local/lib/hermes-agent[all,messaging,bedrock]\n",
    );
    expect(result.installed).toEqual(["hermes-agent@v2026.8.31"]);
  });

  test("a provider switch on a pinned checkout installs the new provider's extra", async () => {
    await apply(makeManifest({ provider: "openrouter" }), { host, providerKey: "FIXTURE" });

    host.commands.length = 0;
    await apply(makeManifest({ provider: "anthropic" }), { host, providerKey: "FIXTURE" });

    const install = host.commands.find((c) => c.startsWith("uv pip install")) ?? "";
    expect(install).toEndWith("-e /usr/local/lib/hermes-agent[all,messaging,anthropic]");
  });

  test("a ref that does not report the pinned version fails the apply", async () => {
    // The tag exists and checks out; its pyproject just says something else.
    host.hermesVersionByRef.set("v2026.7.1", "0.20.0");
    const manifest = makeManifest({ hermes_ref: "v2026.7.1", hermes_version: "0.21.0" });

    const err = (await apply(manifest, { host }).catch((e: unknown) => e)) as AgentdError;
    expect(err).toBeInstanceOf(AgentdError);
    expect(err.code).toBe("MANIFEST_REFUSED");
    expect(err.message).toContain("0.21.0");
    expect(err.message).toContain("v2026.7.1");
    // Nothing claims the box is pinned, so the next apply retries the install.
    expect(host.files.has("/usr/local/lib/hermes-agent/.hermetic-ref")).toBe(false);
  });

  test("an existing checkout at another ref is fetched and detached, never re-cloned", async () => {
    await apply(makeManifest(), { host });
    host.hermesVersionByRef.set("v2026.9.9", "0.22.0");

    host.commands.length = 0;
    await apply(makeManifest({ hermes_ref: "v2026.9.9", hermes_version: "0.22.0" }), { host });

    expect(hermesCommands()).toEqual([
      "git -C /usr/local/lib/hermes-agent fetch --depth 1 https://github.com/NousResearch/hermes-agent.git v2026.9.9",
      "git -C /usr/local/lib/hermes-agent checkout --detach FETCH_HEAD",
      // The venv survives the upgrade; only the editable install re-runs.
      "uv pip install --python /usr/local/lib/hermes-agent/venv/bin/python -e /usr/local/lib/hermes-agent[all,messaging,bedrock]",
      "ln -sfn /usr/local/lib/hermes-agent/venv/bin/hermes /usr/local/bin/hermes",
      "/usr/local/bin/hermes --version",
      "git config --system --get-all safe.directory",
      "git -C /usr/local/lib/hermes-agent rev-parse --is-shallow-repository",
      "git -C /usr/local/lib/hermes-agent rev-parse HEAD",
      // No second `gateway install`: the unit is there, and it is never
      // regenerated. A Hermes upgrade therefore does not move how the gateway
      // is supervised — deliberate, and the risk the plan names.
    ]);
    expect(host.files.get("/usr/local/lib/hermes-agent/.hermetic-ref")?.content).toBe("v2026.9.9\n");
    // The ref moved, so the revision the units advertise moved with it.
    expect(host.files.get("/etc/hermes/revision.env")?.content).toBe(
      `HERMES_REVISION=${fakeCommitSha("v2026.9.9")}\n`,
    );
  });

  /**
   * github.com answering 429 to an unauthenticated clone is the failure this
   * covers: it is a capacity refusal, not a quota a token gets past, and before
   * the retry one of them ended the whole bootstrap with exit 1.
   */
  test("a clone that fails twice is retried, and the third attempt installs", async () => {
    let attempts = 0;
    host.when(/^git clone /, () =>
      ++attempts <= 2 ? { code: 128, stderr: "fatal: ... returned error: 429" } : null,
    );

    await apply(makeManifest(), { host });

    expect(attempts).toBe(3);
    expect(host.sleeps).toContain(5_000);
    expect(host.files.get("/usr/local/lib/hermes-agent/.hermetic-ref")?.content).toBe("v2026.8.31\n");
  });

  test("a clone that never works fails the apply with git's own error", async () => {
    host.when(/^git clone /, { code: 128, stderr: "fatal: ... returned error: 429" });

    const err = (await apply(makeManifest(), { host }).catch((e: unknown) => e)) as AgentdError;

    expect(err).toBeInstanceOf(AgentdError);
    expect(err.code).toBe("COMMAND_FAILED");
    expect(err.message).toContain("429");
    expectRan(host, /^git clone /, 3);
    expect(host.files.has("/usr/local/lib/hermes-agent/.hermetic-ref")).toBe(false);
  });

  test("git is required, and its absence is named rather than left to the clone", async () => {
    const manifest = makeManifest({ packages: [] });
    const err = (await apply(manifest, { host }).catch((e: unknown) => e)) as AgentdError;
    expect(err).toBeInstanceOf(AgentdError);
    expect(err.message).toContain("git is not installed");
    expectNotRan(host, /^git /);
  });

  /**
   * `uv pip install -e` replaces the dependency set under a live process and
   * `git checkout` moves source files Hermes imports lazily, so a running
   * dashboard or gateway can end up half on one ref and half on the other.
   * Stopping is only half of it: neither unit's own file changes on a ref bump,
   * so without the restart pass knowing that Hermes moved, a box would be left
   * stopped, or running the old code out of a rewritten venv.
   */
  test("a ref change stops both units before the swap and restarts them after", async () => {
    await apply(makeManifest(), { host });
    host.hermesVersionByRef.set("v2026.9.9", "0.22.0");

    host.commands.length = 0;
    const result = await apply(makeManifest({ hermes_ref: "v2026.9.9", hermes_version: "0.22.0" }), {
      host,
    });

    expect(host.commands.filter((c) => /^systemctl (stop|restart) |^(git|uv) /.test(c))).toEqual([
      "systemctl stop hermes-dashboard.service",
      "systemctl stop hermes-gateway.service",
      "git -C /usr/local/lib/hermes-agent fetch --depth 1 https://github.com/NousResearch/hermes-agent.git v2026.9.9",
      "git -C /usr/local/lib/hermes-agent checkout --detach FETCH_HEAD",
      "uv pip install --python /usr/local/lib/hermes-agent/venv/bin/python -e /usr/local/lib/hermes-agent[all,messaging,bedrock]",
      "git config --system --get-all safe.directory",
      "git -C /usr/local/lib/hermes-agent rev-parse --is-shallow-repository",
      "git -C /usr/local/lib/hermes-agent rev-parse HEAD",
      "systemctl restart hermes-dashboard.service",
      "systemctl restart hermes-gateway.service",
    ]);
    expect(result.restarted).toEqual(["hermes-dashboard.service", "hermes-gateway.service"]);
  });

  /**
   * A first apply has no unit to stop: the dashboard unit is written by the
   * `files` phase, which runs after this, and the gateway unit by `hermes
   * gateway install`, which needs the very checkout being made.
   */
  test("a fresh box stops nothing, because there is nothing installed to stop", async () => {
    await apply(makeManifest(), { host });

    expectNotRan(host, /^systemctl stop /);
  });

  test("an apply that changes no ref stops nothing", async () => {
    await apply(makeManifest(), { host });

    host.commands.length = 0;
    await apply(makeManifest(), { host });

    expectNotRan(host, /^systemctl stop/);
    expectNotRan(host, /^systemctl restart/);
  });

  test("a dry run plans the install without touching git, uv or the disk", async () => {
    const result = await apply(makeManifest(), { host, dryRun: true });
    expect(hermesCommands()).toEqual([]);
    expect(host.files.has("/usr/local/bin/hermes")).toBe(false);
    expect(result.installed).toContain("hermes-agent@v2026.8.31");
  });

  /**
   * A box that has not taken the dashboard rename yet is running the *old*
   * unit, so it is the one that has to come down before the venv moves under
   * it. Leaving it up puts the only live Hermes on the wrong side of the swap
   * for the whole of it.
   */
  test("a legacy dashboard unit still on disk is stopped before the swap too", async () => {
    await apply(makeManifest(), { host });
    host.seed(LEGACY_DASHBOARD_UNIT, `# ${HERMETIC_RENDERED_MARKER}\n[Service]\n`);
    host.hermesVersionByRef.set("v2026.9.9", "0.22.0");

    host.commands.length = 0;
    await apply(makeManifest({ hermes_ref: "v2026.9.9", hermes_version: "0.22.0" }), { host });

    const after = host.commands;
    expect(after.filter((c) => c.startsWith("systemctl stop"))).toEqual([
      "systemctl stop hermes-dashboard.service",
      "systemctl stop hermes-gateway.service",
      "systemctl stop hermes.service",
    ]);
    // Before git, not after it: the point is the unit is down while the
    // checkout and the venv are being rewritten.
    expect(after.indexOf("systemctl stop hermes.service")).toBeLessThan(
      after.findIndex((c) => c.startsWith("git ")),
    );
  });

  test("a hermes.service hermetic did not write is left running", async () => {
    await apply(makeManifest(), { host });
    host.seed(LEGACY_DASHBOARD_UNIT, "# somebody else's unit\n[Service]\n");
    host.hermesVersionByRef.set("v2026.9.9", "0.22.0");

    host.commands.length = 0;
    await apply(makeManifest({ hermes_ref: "v2026.9.9", hermes_version: "0.22.0" }), { host });

    // Not in `manifest.units`, so the units phase would never start it again;
    // a unit hermetic does not own is not this apply's to stop.
    const after = host.commands;
    expect(after.filter((c) => c.startsWith("systemctl stop"))).toEqual([
      "systemctl stop hermes-dashboard.service",
      "systemctl stop hermes-gateway.service",
    ]);
  });
});

/**
 * The gap between the stop and the restart, which is most of an apply.
 *
 * `ensureHermes` stops both Hermes units before it rewrites the checkout and the
 * venv, and the units phase starts them again — but everything in between (Node,
 * the npm workspaces, the gateway installer, a rendered file, a secret that will
 * not resolve) can throw. The next apply then finds the ref marker and the
 * reported version already matching, concludes Hermes did not change, and
 * restarts nothing: a box with no dashboard and no gateway, and nothing on it
 * that knows. The pending-restart record is what survives the failed process —
 * the same record every other unfinished restart is written to.
 */
describe("a hermes swap that did not finish", () => {
  let host: FakeHost;

  beforeEach(() => {
    host = new FakeHost();
    resetAptIndexState();
  });

  const NEXT = { hermes_ref: "v2026.9.9", hermes_version: "0.22.0" };

  /** A box on the pinned ref with both units installed, then a bump that fails. */
  /** Returns the hook that lets npm work again. */
  async function failMidSwap(): Promise<() => void> {
    await apply(makeManifest(), { host });
    host.hermesVersionByRef.set(NEXT.hermes_ref, NEXT.hermes_version);
    // The web build: after the stop and the venv swap, long before the units
    // phase — which is the whole shape of the problem.
    const fixNpm = host.when(/\bnpm /, { code: 1, stderr: "ECONNRESET registry.npmjs.org" });
    const err = await apply(makeManifest(NEXT), { host }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentdError);
    return fixNpm;
  }

  test("leaves an obligation naming both units, and both units stopped", async () => {
    await failMidSwap();

    expect(pendingUnits(host)).toEqual(["hermes-dashboard.service", "hermes-gateway.service"]);
    // Mode 600 and under hermeticd's own state directory — not beside the
    // checkout, which is the thing a failed apply may have left half-rewritten.
    expect(host.files.get(APPLY_PENDING_PATH)?.mode).toBe("0600");
    expect(host.runningUnits.has("hermes-dashboard.service")).toBe(false);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(false);
  });

  /**
   * The next apply has nothing to install: the ref marker was written before the
   * build failed, so `ensureHermes` returns "unchanged". Without the record that
   * is the end of it and the box stays down.
   */
  test("the next apply restarts both from an unchanged manifest, and clears the record", async () => {
    (await failMidSwap())();

    host.commands.length = 0;
    const result = await apply(makeManifest(NEXT), { host });

    // Nothing reinstalled: this is the repair, not a second swap. The git calls
    // that do run are the local-state pair every apply repeats, neither of
    // which moves the checkout.
    expectNotRan(host, /^uv /);
    expect(host.commands.filter((c) => /^git /.test(c))).toEqual([
      "git config --system --get-all safe.directory",
      "git -C /usr/local/lib/hermes-agent rev-parse --is-shallow-repository",
      "git -C /usr/local/lib/hermes-agent rev-parse HEAD",
    ]);
    expect(result.restarted).toEqual(["hermes-dashboard.service", "hermes-gateway.service"]);
    expect(host.runningUnits.has("hermes-dashboard.service")).toBe(true);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(host.files.has(APPLY_PENDING_PATH)).toBe(false);
  });

  test("a restart that fails keeps the obligation, so the apply after it tries again", async () => {
    (await failMidSwap())();
    host.when(/^systemctl restart /, { code: 1, stderr: "Job failed" });

    const err = await apply(makeManifest(NEXT), { host }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentdError);
    // The unit whose restart failed is still owed, and so is the one after it.
    expect(pendingUnits(host)).toEqual(["hermes-dashboard.service", "hermes-gateway.service"]);
  });

  test("an apply that finishes leaves no record at all", async () => {
    await apply(makeManifest(), { host });
    expect(host.files.has(APPLY_PENDING_PATH)).toBe(false);

    host.hermesVersionByRef.set(NEXT.hermes_ref, NEXT.hermes_version);
    const result = await apply(makeManifest(NEXT), { host });

    expect(result.restarted).toContain("hermes-dashboard.service");
    expect(host.files.has(APPLY_PENDING_PATH)).toBe(false);
  });

  /**
   * A box last applied by a hermeticd that wrote `hermes.stopped` instead, and
   * killed before it could start the units again. The shape of the record
   * changed; the obligation it carries did not, so the upgraded binary reads it
   * once, pays it, and removes it.
   */
  test("a legacy hermes.stopped marker is drained and then removed", async () => {
    await apply(makeManifest(), { host });
    host.restarted.length = 0;
    host.seed(LEGACY_STOP_MARKER_PATH, "hermes-dashboard.service\nhermes-gateway.service\n");

    const result = await apply(makeManifest(), { host });

    expect(result.restarted).toEqual(["hermes-dashboard.service", "hermes-gateway.service"]);
    expect(host.files.has(LEGACY_STOP_MARKER_PATH)).toBe(false);
    expect(host.files.has(APPLY_PENDING_PATH)).toBe(false);
  });
});

/**
 * H16: a crash between a file write and the restart it obliges.
 *
 * The restart set is a *diff*, and a diff only exists while the process does. An
 * apply that writes `hermes-dashboard.service` and dies before the units phase
 * leaves a box whose files are new and whose processes are old — and the next
 * apply sees identical files, computes an empty diff, and restarts nothing. The
 * change is on disk and never takes effect.
 *
 * So the obligation is written down before the file is, and drained on the next
 * entry whether or not that apply has a diff of its own.
 */
describe("a restart the apply owed and did not make", () => {
  let host: FakeHost;

  beforeEach(() => {
    host = new FakeHost();
    resetAptIndexState();
  });

  const CHANGED = {
    hermesUnitBody:
      "[Service]\nExecStart=/usr/local/bin/hermes serve --host 127.0.0.1 --port 9119 --verbose\n",
  };

  /** Write the new unit file, then die before anything can be restarted. */
  async function crashBeforeRestarts(): Promise<void> {
    await apply(makeManifest(), { host });
    host.restarted.length = 0;
    // `daemon-reload` is the first thing the units phase does, after every
    // rendered file is already on disk.
    host.execFaults.push((argv) =>
      argv[1] === "daemon-reload" ? new Error("the box lost power") : null,
    );
    const err = await apply(makeManifest(CHANGED), { host }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    host.execFaults.length = 0;
  }

  test("the crashed apply leaves the new file and a record of what it owes", async () => {
    await crashBeforeRestarts();

    expect(host.files.get(HERMES_UNIT)?.content).toContain("--verbose");
    expect(host.restarted).toEqual([]);
    expect(pendingUnits(host)).toEqual(["hermes-dashboard.service"]);
    // Naming the configuration it was applying, so a record found later says
    // which one it belongs to.
    expect(JSON.parse(host.files.get(APPLY_PENDING_PATH)?.content ?? "{}").config_hash).toBe(
      makeManifest().config_hash,
    );
  });

  test("the retry restarts the owed unit from an empty diff, and clears the record", async () => {
    await crashBeforeRestarts();

    const result = await apply(makeManifest(CHANGED), { host });

    // No file changed on this run — the crashed apply had already written them.
    expect(result.contentChanged).toEqual([]);
    expect(result.restarted).toEqual(["hermes-dashboard.service"]);
    expect(host.restarted).toEqual(["hermes-dashboard.service"]);
    expect(host.files.has(APPLY_PENDING_PATH)).toBe(false);
  });

  test("a restart that fails keeps the unit owed for the apply after it", async () => {
    await crashBeforeRestarts();
    const fixRestart = host.when(/^systemctl restart /, { code: 1, stderr: "Job failed" });

    const err = await apply(makeManifest(CHANGED), { host }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentdError);
    expect(pendingUnits(host)).toEqual(["hermes-dashboard.service"]);

    fixRestart();
    const result = await apply(makeManifest(CHANGED), { host });
    expect(result.restarted).toEqual(["hermes-dashboard.service"]);
    expect(host.files.has(APPLY_PENDING_PATH)).toBe(false);
  });

  test("an apply that finishes records the config it applied, and only then", async () => {
    const manifest = makeManifest();
    host.execFaults.push((argv) =>
      argv[1] === "daemon-reload" ? new Error("the box lost power") : null,
    );
    await apply(manifest, { host }).catch(() => undefined);
    expect(host.files.has(APPLIED_CONFIG_PATH)).toBe(false);

    host.execFaults.length = 0;
    await apply(manifest, { host });

    expect(JSON.parse(host.files.get(APPLIED_CONFIG_PATH)?.content ?? "{}").config_hash).toBe(
      manifest.config_hash,
    );
  });

  test("a dry run records nothing", async () => {
    await apply(makeManifest(), { host, dryRun: true });

    expect(host.files.has(APPLY_PENDING_PATH)).toBe(false);
    expect(host.files.has(APPLIED_CONFIG_PATH)).toBe(false);
  });
});

/**
 * The fleet's own mirror of the Hermes source (§6.4).
 *
 * The laptop pushes `hermes/<ref>.bundle` to the fleet bucket and records its
 * digest in the fleet manifest; a box that finds its ref there installs from
 * those bytes and never contacts github.com. Everything the manifest does not
 * name — an older fleet, a mirror push that failed, an instance role whose
 * policy predates the `hermes/*` grant — falls back to the direct clone, which
 * is what keeps a fleet created before any of this bootable.
 */
describe("hermes from the fleet's mirror", () => {
  let host: FakeHost;

  beforeEach(() => {
    host = new FakeHost();
    resetAptIndexState();
  });

  const REF = "v2026.8.31";
  const MARKER = "/usr/local/lib/hermes-agent/.hermetic-ref";
  /** The commit the mirrored tree was taken from; the bundle's own is hermetic's. */
  const UPSTREAM_SHA = "9f1c0a4e2b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30";

  /** A fleet manifest naming a bundle for `ref`, and (unless told otherwise) the bytes. */
  function seedMirror(
    ref: string,
    opts: { digest?: string; withBytes?: boolean; size?: number } = {},
  ): void {
    const bytes = FakeHost.bundleBytes(ref);
    if (opts.withBytes !== false) host.s3Objects.set(hermesBundleKey(ref), bytes);
    const base = makeFleetManifest();
    const fleet: FleetManifest = {
      ...base,
      hermes: {
        ...base.hermes,
        [ref]: {
          key: hermesBundleKey(ref),
          sha256: opts.digest ?? sha256Of(bytes),
          size: opts.size ?? bytes.length,
          upstream_sha: UPSTREAM_SHA,
        },
      },
    };
    host.seed(FLEET_CACHE_PATH, JSON.stringify(fleet));
  }

  const gitCommands = (): string[] => host.commands.filter((c) => /^git |^s3:GetObject /.test(c));

  test("a fresh box clones the bundle out of the bucket and never reaches github", async () => {
    seedMirror(REF);

    const result = await apply(makeManifest(), { host, getObject: host.getObject });

    expect(gitCommands()).toEqual([
      `s3:GetObject ${TEST_BUCKET} hermes/${REF}.bundle`,
      `git clone ${HERMES_BUNDLE_PATH} /usr/local/lib/hermes-agent`,
      "git -C /usr/local/lib/hermes-agent remote set-url origin " +
        "https://github.com/NousResearch/hermes-agent.git",
      "git config --system --get-all safe.directory",
      "git config --system --add safe.directory /usr/local/lib/hermes-agent",
      // No `rev-parse`: on the mirror path the marker carries the upstream
      // commit, and the checkout's own HEAD is hermetic's synthesized one — the
      // very sha `HERMES_REVISION` exists to stop Hermes asking about.
    ]);
    // Naming the repo is not contacting it: `set-url` is local, and the
    // fallback clone stays the only thing that ever reaches github.com.
    expect(host.commandsMatching(/github\.com/)).toEqual([
      "git -C /usr/local/lib/hermes-agent remote set-url origin " +
        "https://github.com/NousResearch/hermes-agent.git",
    ]);
    expect(result.installed).toContain(`hermes-agent@${REF}`);
    // The staged bundle is the size of the whole tree; it does not stay.
    expect(host.files.has(HERMES_BUNDLE_PATH)).toBe(false);
  });

  test("the marker records the upstream commit, because the bundle's own is not upstream's", async () => {
    seedMirror(REF);

    await apply(makeManifest(), { host, getObject: host.getObject });

    expect(host.files.get(MARKER)?.content).toBe(`${REF}\n${UPSTREAM_SHA}\n`);
    // …and that commit, not the bundle's, is what the units advertise as
    // `HERMES_REVISION`: upstream's update check has to be given a sha that
    // exists on github.com or it answers nothing at all.
    expect(host.files.get("/etc/hermes/revision.env")?.content).toBe(
      `HERMES_REVISION=${UPSTREAM_SHA}\n`,
    );
  });

  /**
   * The failure this test is named after: `/etc/hermes` is not a directory any
   * Ubuntu box ships, and the revision file is written in the *packages* phase
   * — two phases before the rendered `/etc/hermes/config.yaml` whose write
   * would have created it. Every box that had applied before already had the
   * directory, so the bug was invisible until a genuinely new one bootstrapped
   * and `04-apply` died on `ENOENT … open '/etc/hermes/.revision.env.tmp.…'`.
   */
  test("a box with no /etc/hermes yet gets one, rather than an ENOENT out of the packages phase", async () => {
    seedMirror(REF);
    expect(host.dirs.has("/etc/hermes")).toBe(false);

    const result = await apply(makeManifest(), { host, getObject: host.getObject });

    expect(host.files.get("/etc/hermes/revision.env")?.content).toBe(
      `HERMES_REVISION=${UPSTREAM_SHA}\n`,
    );
    expect(result.contentChanged).toContain("/etc/hermes/revision.env");
  });

  /**
   * A one-line marker is what every box installed before the mirror landed has
   * on disk, and it still means "this box is on this ref" — the upgrade must not
   * reinstall Hermes on every box just because the format grew a line.
   */
  test("a one-line marker from an older hermeticd is still an already-pinned box", async () => {
    seedMirror(REF);
    await apply(makeManifest(), { host, getObject: host.getObject });
    await host.writeFile(MARKER, `${REF}\n`, "0644");

    host.commands.length = 0;
    const second = await apply(makeManifest(), { host, getObject: host.getObject });

    // Nothing is re-fetched or re-checked-out. `safe.directory` finds itself
    // already set, and the revision probe stops at the shallowness question:
    // this checkout came from a bundle, so it is not shallow, so the missing
    // second line does *not* license reading HEAD — which here is hermetic's
    // synthesized commit, the one sha upstream's update check cannot resolve.
    expect(gitCommands()).toEqual([
      "git config --system --get-all safe.directory",
      "git -C /usr/local/lib/hermes-agent rev-parse --is-shallow-repository",
    ]);
    expect(second.installed).toEqual([]);
    // So the file the first apply wrote — from the marker it still had — stands.
    expect(host.files.get("/etc/hermes/revision.env")?.content).toBe(
      `HERMES_REVISION=${UPSTREAM_SHA}\n`,
    );
  });

  /**
   * Bytes that fail their digest are never quietly replaced with bytes from
   * somewhere else: a fallback here would turn a pinned install into an
   * unpinned one at exactly the moment something is provably wrong.
   */
  test("a bundle whose digest is wrong fails the apply rather than falling back", async () => {
    seedMirror(REF, { digest: "b".repeat(64) });

    const err = (await apply(makeManifest(), { host, getObject: host.getObject }).catch(
      (e: unknown) => e,
    )) as AgentdError;

    expect(err).toBeInstanceOf(AgentdError);
    expect(err.code).toBe("CHECKSUM_MISMATCH");
    expect(err.message).toContain(`hermes/${REF}.bundle`);
    expectNotRan(host, /^git /);
    expect(host.files.has(MARKER)).toBe(false);
  });

  test("a fleet manifest with no mirror for the ref clones from upstream", async () => {
    host.seed(FLEET_CACHE_PATH, JSON.stringify(makeFleetManifest()));

    await apply(makeManifest(), { host, getObject: host.getObject });

    expectNotRan(host, /^s3:GetObject /);
    expect(host.commandsMatching(/^git clone /)).toEqual([
      `git clone --depth 1 --branch ${REF} https://github.com/NousResearch/hermes-agent.git /usr/local/lib/hermes-agent`,
    ]);
  });

  /**
   * The instance role's S3 read is scoped by the foundation template, so a box
   * on a fleet that has not taken the `hermes/*` widening gets AccessDenied
   * here. Falling back is what keeps it bootable; the warning is what keeps the
   * fallback from being invisible.
   */
  test("an S3 read that fails warns and clones from upstream", async () => {
    seedMirror(REF, { withBytes: false });
    const { emit, events } = collector();

    await apply(makeManifest(), { host, emit, getObject: host.getObject });

    const warning = events.find((e) => e.level === "warn");
    expect(warning?.message).toContain("AccessDenied");
    expect(warning?.message).toContain(`hermes/${REF}.bundle`);
    expect(host.commandsMatching(/^git clone /)).toEqual([
      `git clone --depth 1 --branch ${REF} https://github.com/NousResearch/hermes-agent.git /usr/local/lib/hermes-agent`,
    ]);
  });

  test("an existing checkout fetches the new bundle and keeps its venv", async () => {
    seedMirror(REF);
    await apply(makeManifest(), { host, getObject: host.getObject });
    host.hermesVersionByRef.set("v2026.9.9", "0.22.0");
    seedMirror("v2026.9.9");

    host.commands.length = 0;
    await apply(makeManifest({ hermes_ref: "v2026.9.9", hermes_version: "0.22.0" }), {
      host,
      getObject: host.getObject,
    });

    expect(gitCommands()).toEqual([
      `s3:GetObject ${TEST_BUCKET} hermes/v2026.9.9.bundle`,
      `git -C /usr/local/lib/hermes-agent fetch ${HERMES_BUNDLE_PATH} v2026.9.9`,
      "git -C /usr/local/lib/hermes-agent checkout --detach FETCH_HEAD",
      "git config --system --get-all safe.directory",
    ]);
    // The venv is made once and survives the ref change; only the editable
    // install re-runs, which is the whole reason a bundle is fetched into the
    // existing checkout rather than untarred over it.
    expectNotRan(host, /^uv venv/);
    expect(host.files.has("/usr/local/lib/hermes-agent/venv/bin/python")).toBe(true);
    expect(host.files.get(MARKER)?.content).toBe(`v2026.9.9\n${UPSTREAM_SHA}\n`);
  });

  /**
   * The read is not attempted at all on a box with no fleet cache — a first
   * boot before `bootstrap` has fetched one. It falls back silently, because
   * there is nothing anomalous about it.
   */
  test("no fleet cache means no S3 read and no warning", async () => {
    const { emit, events } = collector();

    await apply(makeManifest(), { host, emit, getObject: host.getObject });

    expectNotRan(host, /^s3:GetObject /);
    expect(events.filter((e) => e.level === "warn")).toEqual([]);
  });

  /**
   * The manifest records a length as well as a digest, and a body that is short
   * is exactly what the length describes. Checked before the bytes are written,
   * so a truncated read never reaches the disk — and refused rather than fallen
   * back from, for the same reason a wrong digest is: these are provably not the
   * bytes the fleet pinned.
   */
  test("a bundle whose length is not the one recorded is refused before it is staged", async () => {
    seedMirror(REF, { size: 999_999 });

    const err = (await apply(makeManifest(), { host, getObject: host.getObject }).catch(
      (e: unknown) => e,
    )) as AgentdError;

    expect(err).toBeInstanceOf(AgentdError);
    expect(err.code).toBe("CHECKSUM_MISMATCH");
    expect(err.message).toContain("999999");
    expect(host.files.has(HERMES_BUNDLE_PATH)).toBe(false);
    expectNotRan(host, /^git /);
  });

  /**
   * A bundle staged by an apply that was killed before git read it is orphaned:
   * the removal on the success path never runs, and the file sits in
   * `/var/lib/hermeticd` at the size of a whole Hermes tree. Both fallback paths
   * have to collect it, because they are the ones that return without staging
   * anything of their own.
   */
  test("a bundle left by an aborted apply is removed even when no mirror is read", async () => {
    host.seed(HERMES_BUNDLE_PATH, "a bundle from a run that never finished");
    host.seed(FLEET_CACHE_PATH, JSON.stringify(makeFleetManifest()));

    await apply(makeManifest(), { host, getObject: host.getObject });

    expect(host.files.has(HERMES_BUNDLE_PATH)).toBe(false);
    expectNotRan(host, /^s3:GetObject /);
  });

  test("…and when the read of the mirror fails", async () => {
    host.seed(HERMES_BUNDLE_PATH, "a bundle from a run that never finished");
    seedMirror(REF, { withBytes: false });

    await apply(makeManifest(), { host, getObject: host.getObject });

    expect(host.files.has(HERMES_BUNDLE_PATH)).toBe(false);
  });
});

/**
 * Node, and the two bundles it builds.
 *
 * `hermes serve` is the headless backend and 404s a browser; the SPA comes from
 * `hermes dashboard`, which serves the Vite bundle at `hermes_cli/web_dist`
 * (`web/vite.config.ts:103`) — not `web/dist`, which nothing ever writes. The
 * dashboard's Chat tab then spawns the Ink TUI, which takes its prebuilt fast
 * path only when `$HERMES_TUI_DIR/dist/entry.js` is there
 * (`hermes_cli/main_tui_launch.py:543-546`) and otherwise npm-installs as the
 * `hermes` user into a root-owned tree. Neither is shipped built, and building
 * them needs a Node apt cannot supply (Ubuntu's is 18, its `npm` is not
 * installed at all, and vite 8 refuses both), so hermeticd installs the official
 * tarball itself and runs npm as root from the checkout root.
 */
describe("the hermes web ui and the node that builds it", () => {
  let host: FakeHost;

  beforeEach(() => {
    host = new FakeHost();
    resetAptIndexState();
  });

  const NODE_DIR = `/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-${process.arch === "x64" ? "x64" : "arm64"}`;
  const ARCH = process.arch === "x64" ? "x64" : "arm64";
  const TARBALL = `node-v${NODE_VERSION}-linux-${ARCH}.tar.xz`;
  const DIST = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const MARKER = "/usr/local/lib/hermes-agent/web/.hermetic-built";
  const WEB_DIST_INDEX = "/usr/local/lib/hermes-agent/hermes_cli/web_dist/index.html";
  const TUI_ENTRY = "/usr/local/lib/hermes-agent/ui-tui/dist/entry.js";
  const NPM_FLAGS =
    "--workspace web --workspace ui-tui --include-workspace-root " +
    "--include=dev --no-audit --no-fund --loglevel=error";
  const NPM_INSTALL = `timeout 900 npm ci ${NPM_FLAGS}`;
  /** Upstream's own fallback for a lockfile `npm ci` will not accept. */
  const NPM_INSTALL_FALLBACK = `timeout 900 npm install --no-save ${NPM_FLAGS}`;
  const NPM_BUILD_WEB = "timeout 900 npm run build --workspace web";
  const NPM_BUILD_TUI = "timeout 900 npm run build --workspace ui-tui";

  /**
   * The node/npm commands that *do* something, in order. The `node --version`
   * probe that decides whether any of them are needed is left out: it runs on
   * every apply by design, including the ones that then do nothing.
   */
  const nodeCommands = (): string[] =>
    host.commands.filter((c) => /nodejs|npm /.test(c) && !c.endsWith("--version"));

  test("a fresh box downloads, verifies, unpacks and links the pinned node", async () => {
    await apply(makeManifest(), { host });

    expect(nodeCommands()).toEqual([
      `curl -fsSL --connect-timeout 10 --max-time 300 --retry 3 -o /usr/local/lib/nodejs/${TARBALL} ${DIST}/${TARBALL}`,
      `curl -fsSL --connect-timeout 10 --max-time 300 --retry 3 -o /usr/local/lib/nodejs/SHASUMS256.txt ${DIST}/SHASUMS256.txt`,
      `timeout 300 tar --no-same-owner -xJf /usr/local/lib/nodejs/${TARBALL} -C /usr/local/lib/nodejs`,
      `ln -sfn ${NODE_DIR}/bin/node /usr/local/bin/node`,
      `ln -sfn ${NODE_DIR}/bin/npm /usr/local/bin/npm`,
      `ln -sfn ${NODE_DIR}/bin/npx /usr/local/bin/npx`,
      NPM_INSTALL,
      NPM_BUILD_WEB,
      NPM_BUILD_TUI,
    ]);

    // Neither download is left behind for the next apply to have to distrust.
    expect(host.files.has(`/usr/local/lib/nodejs/${TARBALL}`)).toBe(false);
    expect(host.files.has("/usr/local/lib/nodejs/SHASUMS256.txt")).toBe(false);
  });

  test("a fresh box never execs the not-yet-installed node binary: the real host throws ENOENT on that spawn, not a non-zero exit", async () => {
    const nodeBin = `${NODE_DIR}/bin/node`;
    // Mimics `Bun.spawn` on a path that does not exist yet: a thrown error, not
    // a failed `ExecResult`. If `ensureNode` ever execs this path before the
    // tarball is unpacked, this trap turns that regression into a rejection
    // instead of green-through-luck.
    host.when(new RegExp(`^${nodeBin} `), () => {
      throw new Error(`ENOENT: no such file or directory, posix_spawn '${nodeBin}'`);
    });

    const result = await apply(makeManifest(), { host });

    expect(nodeCommands()).toEqual([
      `curl -fsSL --connect-timeout 10 --max-time 300 --retry 3 -o /usr/local/lib/nodejs/${TARBALL} ${DIST}/${TARBALL}`,
      `curl -fsSL --connect-timeout 10 --max-time 300 --retry 3 -o /usr/local/lib/nodejs/SHASUMS256.txt ${DIST}/SHASUMS256.txt`,
      `timeout 300 tar --no-same-owner -xJf /usr/local/lib/nodejs/${TARBALL} -C /usr/local/lib/nodejs`,
      `ln -sfn ${NODE_DIR}/bin/node /usr/local/bin/node`,
      `ln -sfn ${NODE_DIR}/bin/npm /usr/local/bin/npm`,
      `ln -sfn ${NODE_DIR}/bin/npx /usr/local/bin/npx`,
      NPM_INSTALL,
      NPM_BUILD_WEB,
      NPM_BUILD_TUI,
    ]);
    expect(result.installed).toContain(`node@${NODE_VERSION}`);
  });

  /**
   * From the checkout root, not from `web/`. That is where upstream installs
   * from (`hermes_cli/main_web_build.py:432-459`), it is the only prefix from
   * which the root `.npmrc`'s `engine-strict` and `min-release-age` apply, and
   * it is the only one that does not leave a `web/package-lock.json` behind for
   * upstream's `_workspace_root` to read differently ever after.
   */
  test("npm runs from the checkout root with our own node in front of apt's, and no progress noise", async () => {
    await apply(makeManifest(), { host });

    expect(host.npmRuns.map((r) => r.cwd)).toEqual([
      "/usr/local/lib/hermes-agent",
      "/usr/local/lib/hermes-agent",
      "/usr/local/lib/hermes-agent",
    ]);
    // The side effect the old `cwd: web/` install had, and the reason it was
    // wrong even where it worked.
    expect(host.files.has("/usr/local/lib/hermes-agent/web/package-lock.json")).toBe(false);
    for (const npm of host.npmRuns) {
      expect(npm.env).toEqual({
        PATH: "/usr/local/bin:/usr/bin:/bin",
        CI: "1",
        // npm's own retry loop: registry.npmjs.org is one more network
        // dependency a first boot has no control over, and recovering inside
        // the attempt costs nothing when the network is fine.
        npm_config_fetch_retries: "5",
        npm_config_fetch_retry_maxtimeout: "60000",
      });
    }
  });

  /**
   * The idempotency gate, and the reason it is three questions rather than one.
   * While hermetic looked for `web/dist/index.html` — a path Vite never writes —
   * the `stat` was always null, so `npm ci` and `vite build` ran on *every*
   * apply: every bootstrap, every `agent rerun`, every upgrade, each capped at
   * 900 s, on a box hermetic otherwise works hard to keep off the network.
   */
  test("a second apply re-downloads nothing, and runs no npm command at all", async () => {
    await apply(makeManifest(), { host });
    expect(host.files.has(WEB_DIST_INDEX)).toBe(true);
    expect(host.files.has(TUI_ENTRY)).toBe(true);
    host.commands.length = 0;
    const npmRunsBefore = host.npmRuns.length;

    const second = await apply(makeManifest(), { host });

    expect(nodeCommands()).toEqual([]);
    expect(host.npmRuns).toHaveLength(npmRunsBefore);
    expect(second.changed).toEqual([]);
    expect(second.installed).toEqual([]);
  });

  /**
   * The dashboard's Chat tab spawns the Ink TUI, and upstream takes its
   * prebuilt fast path — `node --expose-gc $HERMES_TUI_DIR/dist/entry.js` —
   * only when exactly this file is there (`main_tui_launch.py:543-546`).
   * Anything else and the launcher runs `npm install` as the `hermes` user
   * into a root-owned checkout, which EACCESes and kills the tab.
   */
  test("the tui is built where HERMES_TUI_DIR's prebuilt path expects it", async () => {
    await apply(makeManifest(), { host });

    expect(host.files.has("/usr/local/lib/hermes-agent/ui-tui/dist/entry.js")).toBe(true);
  });

  test("the marker names the ref and the node, so a new hermes ref rebuilds the ui", async () => {
    await apply(makeManifest(), { host });
    expect(host.files.get(MARKER)?.content).toBe(`v2026.8.31 node-v${NODE_VERSION}\n`);

    host.hermesVersionByRef.set("v2026.9.9", "0.22.0");
    host.commands.length = 0;
    await apply(makeManifest({ hermes_ref: "v2026.9.9", hermes_version: "0.22.0" }), { host });

    // Node is unchanged, so only the two npm commands run again.
    expect(nodeCommands()).toEqual([NPM_INSTALL, NPM_BUILD_WEB, NPM_BUILD_TUI]);
    expect(host.files.get(MARKER)?.content).toBe(`v2026.9.9 node-v${NODE_VERSION}\n`);
  });

  test("a marker with no dist beside it rebuilds: the bundle is the thing served", async () => {
    await apply(makeManifest(), { host });
    await host.remove(WEB_DIST_INDEX);

    host.commands.length = 0;
    await apply(makeManifest(), { host });

    expect(nodeCommands()).toEqual([NPM_INSTALL, NPM_BUILD_WEB, NPM_BUILD_TUI]);
  });

  /**
   * The marker is the next apply's only reason to skip the build, so writing it
   * for a run whose build failed would leave the box permanently serving a
   * `dist` that was never produced — and `hermes dashboard --skip-build` has
   * nothing to fall back on.
   */
  test("a failed `npm run build` writes no marker, so the next apply builds again", async () => {
    host.when(/npm run build/, { code: 1, stderr: "vite: transform failed" });

    const err = (await apply(makeManifest(), { host }).catch((e: unknown) => e)) as AgentdError;

    expect(err).toBeInstanceOf(AgentdError);
    expect(err.code).toBe("COMMAND_FAILED");
    expect(host.files.has(MARKER)).toBe(false);
    expect(host.files.has(WEB_DIST_INDEX)).toBe(false);
  });

  /**
   * A flaky registry is a first-boot failure with no digest to make it loud, so
   * the install is attempted more than once — and the box comes up rather than
   * waiting for an operator to notice a `rerun`.
   */
  test("npm ci is retried, and a third attempt that works still builds the ui", async () => {
    let attempts = 0;
    host.when(/npm ci/, () =>
      ++attempts <= 2 ? { code: 1, stderr: "ECONNRESET registry.npmjs.org" } : null,
    );

    await apply(makeManifest(), { host });

    expect(attempts).toBe(3);
    expect(host.sleeps).toEqual([5_000, 5_000]);
    expect(host.files.get(MARKER)?.content).toBe(`v2026.8.31 node-v${NODE_VERSION}\n`);
  });

  test("an install that never works fails the apply with npm's own error", async () => {
    host.when(/npm (ci|install --no-save)/, { code: 1, stderr: "ECONNRESET registry.npmjs.org" });

    const err = (await apply(makeManifest(), { host }).catch((e: unknown) => e)) as AgentdError;

    expect(err).toBeInstanceOf(AgentdError);
    expect(err.code).toBe("COMMAND_FAILED");
    expect(err.message).toContain("ECONNRESET");
    expectRan(host, /npm ci/, 3);
    // The fallback is attempted once, not three times: what it exists for is a
    // lockfile that will not reconcile, and that does not improve by waiting.
    expectRan(host, /npm install --no-save/, 1);
    expect(host.files.has(MARKER)).toBe(false);
  });

  /**
   * `npm ci` refuses outright when `package-lock.json` and `package.json`
   * disagree, and a box that will not build a UI over a lockfile it cannot fix
   * is a box that does not come up. Upstream falls back to `npm install
   * --no-save` (`_run_npm_install_deterministic`,
   * `hermes_cli/main_web_build.py:313-345`); this does the same, and `--no-save`
   * is what keeps the fallback from writing the very lockfile the refusal above
   * exists to prevent.
   */
  test("a lockfile npm ci will not accept falls back to npm install --no-save", async () => {
    host.when(/npm ci/, {
      code: 1,
      stderr: "`npm ci` can only install with an existing package-lock.json",
    });

    const result = await apply(makeManifest(), { host });

    expect(nodeCommands().filter((c) => c.startsWith("timeout 900 npm"))).toEqual([
      NPM_INSTALL,
      NPM_INSTALL,
      NPM_INSTALL,
      NPM_INSTALL_FALLBACK,
      NPM_BUILD_WEB,
      NPM_BUILD_TUI,
    ]);
    // No lockfile written anywhere `--no-save` was supposed to protect.
    expect(host.files.has("/usr/local/lib/hermes-agent/web/package-lock.json")).toBe(false);
    expect(host.files.get(MARKER)?.content).toBe(`v2026.8.31 node-v${NODE_VERSION}\n`);
    expect(result.changed).toContain(MARKER);
  });

  /**
   * Forced, as upstream forces it (`hermes_cli/main_web_build.py:319-322,335`):
   * an inherited `NODE_ENV=production` skips the build toolchain and the build
   * dies with `tsc: not found`. `host.exec` merges `process.env`, so hermeticd's
   * own environment is one of the places that inheritance can come from.
   */
  test("every npm install asks for devDependencies by name", async () => {
    host.when(/npm ci/, { code: 1, stderr: "drift" });

    await apply(makeManifest(), { host });

    const installs = host.npmRuns.filter((r) => r.argv.includes("ci") || r.argv.includes("--no-save"));
    expect(installs).not.toHaveLength(0);
    for (const run of installs) expect(run.argv).toContain("--include=dev");
  });

  /**
   * `npm install` is not the fallback for a missing lockfile, because it is not
   * a read-only operation: it *writes* `web/package-lock.json` into the
   * checkout, and upstream's `_workspace_root` then answers `web/` instead of
   * the root for every later `hermes` invocation
   * (`hermes_cli/main_tui_launch.py:89-98`). A checkout that is not the layout
   * hermetic installs from is named as such instead.
   */
  test("a checkout with no root lockfile is refused rather than installed loosely", async () => {
    host.rootLockfile = false;

    const err = (await apply(makeManifest(), { host }).catch((e: unknown) => e)) as AgentdError;

    expect(err).toBeInstanceOf(AgentdError);
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.message).toContain("package-lock.json");
    expectNotRan(host, /npm (ci|install)/);
    expect(host.files.has(MARKER)).toBe(false);
  });

  /**
   * The TUI half of the gate. A box whose `ui-tui/dist/entry.js` is missing has
   * a dashboard whose Chat tab EACCESes, and the marker alone would tell the
   * next apply everything was fine.
   */
  test("a marker with no tui entry beside it rebuilds", async () => {
    await apply(makeManifest(), { host });
    await host.remove(TUI_ENTRY);

    host.commands.length = 0;
    await apply(makeManifest(), { host });

    expect(nodeCommands()).toEqual([NPM_INSTALL, NPM_BUILD_WEB, NPM_BUILD_TUI]);
  });

  /**
   * An older Hermes ref, or a fork, may not ship `web/` at all. npm in a
   * directory that does not exist fails three times over and parks the box in
   * `error` — over a UI the ref never had. Say so and carry on; and leave no
   * marker, so a later ref that does ship `web/` still builds it.
   */
  test("a hermes ref with no web/ says so and applies anyway", async () => {
    host.hermesWeb = false;
    const { emit, events } = collector();

    const result = await apply(makeManifest(), { host, emit });

    expectNotRan(host, /npm (ci|install|run)/);
    expect(host.files.has(MARKER)).toBe(false);
    expect(result.changed).not.toContain(MARKER);
    expect(events.map((e) => e.message)).toContain("no web/ in this hermes ref; nothing to build");
    expect(events.at(-1)?.phase).toBe("done");
  });

  /**
   * The digest check is only as good as the digests: a `SHASUMS256.txt` that
   * did not arrive must stop the install, not be treated as "nothing to
   * compare against".
   */
  test("a SHASUMS fetch that fails unpacks nothing, links nothing and leaves no download", async () => {
    host.when(new RegExp(`${DIST}/SHASUMS256\\.txt$`), {
      code: 22,
      stderr: "The requested URL returned error: 503",
    });

    const err = (await apply(makeManifest(), { host }).catch((e: unknown) => e)) as AgentdError;

    expect(err).toBeInstanceOf(AgentdError);
    expect(err.code).toBe("COMMAND_FAILED");
    expectNotRan(host, /^timeout 300 tar /);
    expectNotRan(host, /^ln -sfn \/usr\/local\/lib\/nodejs/);
    expect(host.files.has("/usr/local/bin/node")).toBe(false);
    // Both halves of the download are cleaned up, including the tarball that
    // did arrive — a half-verified release must not survive to be adopted.
    expect(host.files.has(`/usr/local/lib/nodejs/${TARBALL}`)).toBe(false);
    expect(host.files.has("/usr/local/lib/nodejs/SHASUMS256.txt")).toBe(false);
  });

  test("a tarball whose digest does not match is refused, and nothing is linked", async () => {
    host.curlBodies.set(`${DIST}/${TARBALL}`, "truncated");

    const err = (await apply(makeManifest(), { host }).catch((e: unknown) => e)) as AgentdError;

    expect(err).toBeInstanceOf(AgentdError);
    expect(err.code).toBe("CHECKSUM_MISMATCH");
    expectNotRan(host, /^timeout 300 tar /);
    expectNotRan(host, /^ln -sfn \/usr\/local\/lib\/nodejs/);
    expect(host.files.has("/usr/local/bin/node")).toBe(false);
    // …and the half-download does not survive to be adopted by the next run.
    expect(host.files.has(`/usr/local/lib/nodejs/${TARBALL}`)).toBe(false);
  });

  test("a dry run names node and the bundle without fetching or building either", async () => {
    const result = await apply(makeManifest(), { host, dryRun: true });

    expect(nodeCommands()).toEqual([]);
    expect(result.installed).toContain(`node@${NODE_VERSION}`);
    expect(result.changed).toContain("/usr/local/bin/node");
    expect(result.changed).toContain(MARKER);
    expect(host.files.has(MARKER)).toBe(false);
  });

  test("an arch with no official build is named rather than left to a 404", () => {
    expect(() => nodeArch("riscv64")).toThrow(/no official Node build for riscv64/);
    expect(nodeArch("arm64")).toBe("arm64");
    expect(nodeArch("x64")).toBe("x64");
  });

  test("the digest is picked out of SHASUMS256.txt by file name, not by position", () => {
    const sums = ["aa11  node-v1-linux-x64.tar.gz", "bb22  node-v1-linux-arm64.tar.xz"].join("\n");
    expect(shasumFor(sums, "node-v1-linux-arm64.tar.xz")).toBe("bb22");
    expect(shasumFor(sums, "node-v1-linux-arm64.tar.gz")).toBe(null);
  });
});

/**
 * Three properties of `apply` that are about what it *refuses* or *bounds*
 * rather than what it installs.
 */
describe("apply's refusals and bounds", () => {
  let host: FakeHost;

  beforeEach(() => {
    host = new FakeHost();
    resetAptIndexState();
  });

  /**
   * The version pin used to be `stdout.includes(version)`, and upstream Hermes
   * tags by date — so a box reporting `2026.8.30` satisfied a manifest pinning
   * `2026.8.3`, and the cross-check written to stop a box shipping a version
   * nobody chose passed on precisely that. A prefix is not a version.
   */
  test("a reported version that merely starts with the pinned one is refused", async () => {
    host.hermesVersionByRef.set("v2026.8.3", "2026.8.30");
    const manifest = makeManifest({ hermes_ref: "v2026.8.3", hermes_version: "2026.8.3" });

    const err = (await apply(manifest, { host }).catch((e: unknown) => e)) as AgentdError;

    expect(err).toBeInstanceOf(AgentdError);
    expect(err.code).toBe("MANIFEST_REFUSED");
    expect(err.message).toContain("2026.8.30");
    expect(host.files.has("/usr/local/lib/hermes-agent/.hermetic-ref")).toBe(false);
  });

  /**
   * …and the idempotency shortcut asks the same question, so a box that somehow
   * has `2026.8.30` installed under a manifest pinning `2026.8.3` reinstalls
   * rather than reporting itself already pinned.
   */
  test("the already-pinned shortcut is not taken on a prefix match either", async () => {
    host.hermesVersionByRef.set("v2026.8.3", "2026.8.30");
    host.seed("/usr/local/lib/hermes-agent/.hermetic-ref", "v2026.8.3\n");
    host.seed("/usr/local/bin/hermes", "#!/bin/sh\n", "0755");
    host.hermesInstalledVersion = "2026.8.30";

    await expect(
      apply(makeManifest({ hermes_ref: "v2026.8.3", hermes_version: "2026.8.3" }), { host }),
    ).rejects.toMatchObject({ code: "MANIFEST_REFUSED" });
    // It got as far as trying to install, which is the point: the shortcut did
    // not fire.
    expect(host.commandsMatching(/^git clone|^git -C/).length).toBeGreaterThan(0);
  });

  test("reportsHermesVersion reads a whole token out of the banner", () => {
    const banner = "Hermes Agent v0.21.0 (2026-08-31) · upstream deadbeef\n";
    expect(reportsHermesVersion(banner, "0.21.0")).toBe(true);
    expect(reportsHermesVersion(banner, "0.21")).toBe(false);
    expect(reportsHermesVersion(banner, "21.0")).toBe(false);
    expect(reportsHermesVersion("hermes 2026.8.30\n", "2026.8.3")).toBe(false);
    expect(reportsHermesVersion("hermes 2026.8.3\n", "2026.8.3")).toBe(true);
    // The date in the banner is not a version, however much it looks like one.
    expect(reportsHermesVersion(banner, "2026-08-3")).toBe(false);
  });

  /**
   * Stock apt has no timeouts and no retries. `00-preflight.sh` writes the same
   * bounds into `/etc/apt/apt.conf.d/90hermetic`, but `apply` runs on boxes
   * whose stage 00 predates that file and on every `hermeticd apply` after —
   * so it carries them on its own argv rather than trusting a file it did not
   * write. Unbounded, a sick mirror is not an error: it is a ten-hour install.
   */
  test("every apt-get carries its own timeouts and retries", async () => {
    await apply(makeManifest(), { host });

    const apt = host.commandsMatching(/^apt-get /);
    expect(apt.length).toBeGreaterThan(0);
    for (const command of apt) {
      expect(command).toContain("-o Acquire::Retries=3");
      expect(command).toContain("-o Acquire::http::Timeout=20");
      expect(command).toContain("-o Acquire::https::Timeout=20");
      expect(command).toContain("-o DPkg::Lock::Timeout=120");
    }
    // The options are options, not packages: what was asked for still installed.
    expect(host.installedPackages.has("nftables")).toBe(true);
    expect([...host.installedPackages].some((p) => p.includes("Acquire"))).toBe(false);
    expect(APT_OPTIONS).toContain("Acquire::Retries=3");
  });

  /**
   * The dpkg lock timeout is stated in two places — hermeticd's own argv, and
   * the rendered `/etc/apt/apt.conf.d/91hermetic-dpkg` the *agent's* apt reads
   * — and they have to be the same number, because the whole point is that no
   * one of the three processes sharing that lock fails fast while another
   * holds it. Both read the shared constant; this is the assertion that
   * hermeticd's half actually does.
   */
  test("the dpkg lock timeout is the shared constant, not a second opinion", () => {
    expect(APT_OPTIONS).toContain(`DPkg::Lock::Timeout=${String(APT_LOCK_TIMEOUT_SECONDS)}`);
    expect(APT_LOCK_TIMEOUT_SECONDS).toBe(120);
  });

  /**
   * A malformed file in `/etc/sudoers.d` does not break one grant — sudo
   * rejects the entire ruleset — and on a box with no key pair and no password
   * that is the difference between an agent that can install a package and a
   * box nobody can become root on. So this is the one rendered file apply reads
   * back to a parser before it lets it reach its path.
   */
  test("a sudoers file is validated at a staged path before it is installed", async () => {
    await apply(makeManifest(), { host });

    const visudo = host.commandsMatching(/^visudo /);
    expect(visudo).toEqual([`visudo -c -q -f ${SUDOERS_APT}.new`]);
    // Validated where it cannot yet be read as policy, then renamed into place.
    // The dot in `.new` is what makes the staged name inert: sudo skips any
    // entry in sudoers.d containing a `.` or a `~`.
    expect(host.fsOps).toContain(`rename ${SUDOERS_APT}.new -> ${SUDOERS_APT}`);
    expect(host.files.has(`${SUDOERS_APT}.new`)).toBe(false);
    expect(host.files.get(SUDOERS_APT)?.mode).toBe("0440");

    expect(
      ranInOrder(host, [new RegExp(`^visudo -c -q -f ${SUDOERS_APT}\\.new$`), /^systemctl restart /]),
    ).toBe(true);
  });

  test("a rejected sudoers file fails the apply and lands nowhere", async () => {
    host.when(/^visudo /, {
      code: 1,
      stderr: ">>> /etc/sudoers.d/hermetic-apt.new: syntax error near line 2 <<<",
    });

    const error = (await apply(makeManifest(), { host }).then(
      () => null,
      (e: unknown) => e,
    )) as AgentdError | null;

    expect(error).toBeInstanceOf(AgentdError);
    expect(error?.code).toBe("COMMAND_FAILED");
    // visudo's own words, because they carry the line number.
    expect(error?.message).toContain("syntax error near line 2");
    // Neither the final path nor the staging path is left behind.
    expect(host.files.has(SUDOERS_APT)).toBe(false);
    expect(host.files.has(`${SUDOERS_APT}.new`)).toBe(false);
    expect(host.fsOps).toContain(`remove ${SUDOERS_APT}.new`);
  });

  /**
   * The validation hangs off the same hash compare every other rendered file
   * does, which is the behaviour worth having: a second apply rewrites nothing,
   * so there is nothing to validate. A changed body is validated again.
   */
  test("an unchanged sudoers file is not re-validated; a changed one is", async () => {
    await apply(makeManifest(), { host });
    host.commands.length = 0;

    await apply(makeManifest(), { host });
    expectNotRan(host, /^visudo /);

    const changed = makeManifest({
      sudoersBody: "hermes ALL=(root) NOPASSWD: /usr/bin/apt-get\n",
    });
    const result = await apply(changed, { host });
    expect(host.commandsMatching(/^visudo /)).toEqual([`visudo -c -q -f ${SUDOERS_APT}.new`]);
    expect(result.contentChanged).toContain(SUDOERS_APT);
    expect(host.files.get(SUDOERS_APT)?.content).toBe("hermes ALL=(root) NOPASSWD: /usr/bin/apt-get\n");
  });

  /**
   * A post-step that fails stops the apply, and the deferred-ownership pass is
   * *inside* what it stops. That is the safe half of the choice: a chown is
   * deferred because the account does not exist yet, and the command that was
   * going to create it is the one that just failed — so running the pass anyway
   * chowns onto whatever half-made account the failure left. `apply` is
   * idempotent and is re-entered on every boot, so stopping is a state the
   * system already knows how to leave.
   */
  test("a failed post-step stops the apply before the deferred chowns run", async () => {
    const manifest = makeManifest({
      owner: "worker",
      commands: ["useradd --system worker", "nft -f /etc/hermetic/nftables.hermetic.nft"],
    });
    host.when(/^\/bin\/sh -c nft /, { code: 1, stderr: "nft: syntax error" });

    const err = (await apply(manifest, { host }).catch((e: unknown) => e)) as AgentdError;

    expect(err).toBeInstanceOf(AgentdError);
    expect(err.code).toBe("COMMAND_FAILED");
    // The account the first post-step created exists, and the chown that was
    // waiting for it did not happen: the pass never ran.
    expect(host.users.has("worker")).toBe(true);
    expectNotRan(host, /^chown worker:worker/);
    expect(host.files.get("/etc/hermes/config.yaml")?.ownership).toBeUndefined();
  });

  test("…and the rerun that follows it completes the ownership pass", async () => {
    const manifest = makeManifest({
      owner: "worker",
      commands: ["useradd --system worker", "nft -f /etc/hermetic/nftables.hermetic.nft"],
    });
    let failNft = true;
    host.when(/^\/bin\/sh -c nft /, () => (failNft ? { code: 1, stderr: "nft: syntax error" } : null));
    await expect(apply(manifest, { host })).rejects.toThrow();

    failNft = false;
    const result = await apply(manifest, { host });

    expect(result.ownershipCorrected).toEqual(["/etc/hermes/config.yaml"]);
    expect(host.files.get("/etc/hermes/config.yaml")?.ownership).toBe("worker:worker");
  });
});

/**
 * The one unit `apply` takes away rather than installs.
 *
 * hermetic's dashboard unit was renamed to the name upstream's own restart path
 * looks for, and `apply` has no general rule that removes a unit which stopped
 * being listed in a manifest. Without a deliberate step, a box created before
 * the rename — or a data volume reattached to one created after it — would run
 * the old dashboard and the new one against the same `$HERMES_HOME`.
 */
describe("the superseded hermes.service", () => {
  let host: FakeHost;

  beforeEach(() => {
    host = new FakeHost();
    resetAptIndexState();
  });

  const LEGACY_UNIT = LEGACY_DASHBOARD_UNIT;
  const hermeticWrote = [
    `# ${HERMETIC_RENDERED_MARKER}. Final file, no templating.`,
    "[Unit]",
    "Description=Hermes dashboard",
    "",
    "[Service]",
    "ExecStart=/usr/local/bin/hermes dashboard --no-open",
    "",
  ].join("\n");

  test("it is disabled and removed before the new unit is enabled", async () => {
    host.seed(LEGACY_UNIT, hermeticWrote);
    host.enabledUnits.add("hermes.service");

    const result = await apply(makeManifest(), { host });

    expect(
      ranInOrder(host, [
        /^systemctl disable --now hermes\.service$/,
        /^systemctl daemon-reload$/,
        /^systemctl enable hermes-dashboard\.service$/,
      ]),
    ).toBe(true);
    // Removed, not merely disabled: a file left behind is a unit the next
    // operator can start by hand.
    expect(host.fsOps).toContain(`remove ${LEGACY_UNIT}`);
    expect(host.files.has(LEGACY_UNIT)).toBe(false);
    // One reload, not two: the removal's own reload runs after every rendered
    // file of this apply is already on disk.
    expect(host.daemonReloads).toHaveLength(1);
    expect(result.restarted).toContain("hermes-dashboard.service");
  });

  test("a box that never had it is told to disable nothing", async () => {
    await apply(makeManifest(), { host });
    expectNotRan(host, /^systemctl disable/);
    expect(host.daemonReloads).toHaveLength(1);
  });

  test("a hermes.service hermetic did not write is left where it is, with a warning", async () => {
    host.seed(LEGACY_UNIT, "[Unit]\nDescription=somebody else's hermes\n");
    const { emit, events } = collector();

    await apply(makeManifest(), { host, emit });

    expectNotRan(host, /^systemctl disable/);
    expect(host.files.has(LEGACY_UNIT)).toBe(true);
    const warning = events.find((e) => e.level === "warn" && e.message.includes(LEGACY_UNIT));
    expect(warning?.message).toContain("not rendered by hermetic");
  });

  /**
   * A plan removes nothing and says so in the one place a plan speaks: `changed`.
   * It used to emit "removing hermes.service" — present tense, about a removal
   * that was not happening — and then leave the unit out of `changed` entirely,
   * so the event stream overstated the plan and the plan itself understated it.
   */
  test("a plan reports the removal in changed, and removes nothing", async () => {
    host.seed(LEGACY_UNIT, hermeticWrote);
    host.enabledUnits.add("hermes.service");
    const { emit, events } = collector();

    const result = await apply(makeManifest(), { host, dryRun: true, emit });

    expect(result.changed).toContain(LEGACY_UNIT);
    expect(events.filter((e) => e.message.includes("removing hermes.service"))).toEqual([]);
    expectNotRan(host, /^systemctl disable/);
    expect(host.files.has(LEGACY_UNIT)).toBe(true);
  });

  test("a real removal is reported in changed as well as in the event stream", async () => {
    host.seed(LEGACY_UNIT, hermeticWrote);
    host.enabledUnits.add("hermes.service");
    const { emit, events } = collector();

    const result = await apply(makeManifest(), { host, emit });

    expect(result.changed).toContain(LEGACY_UNIT);
    expect(events.map((e) => e.message)).toContain(
      "removing hermes.service, superseded by hermes-dashboard.service",
    );
  });
});

/**
 * The browser agent's Chrome, in the place an apply has to put it: after apt,
 * because `unzip` is one of the manifest's packages, and before the units,
 * because `hermetic-browser@default.service` executes what comes out of the zip.
 */
describe("the pinned Chrome a browser agent runs", () => {
  let host: FakeHost;

  beforeEach(() => {
    host = new FakeHost();
    resetAptIndexState();
  });

  const ZIP = "PK chrome-for-testing\n";
  const browserManifest = () =>
    makeManifest({
      browser: true,
      packages: ["curl", "git", "jq", "nftables", "unzip"],
    });

  function seedMirror(): void {
    host.s3Objects.set(browserBuildKey(TEST_CHROME_REF), new TextEncoder().encode(ZIP));
    host.seed(
      FLEET_CACHE_PATH,
      JSON.stringify(makeFleetManifest({ browser: { [TEST_CHROME_REF]: ZIP } })),
    );
  }

  test("is unpacked between the packages and the units", async () => {
    seedMirror();

    const result = await apply(browserManifest(), { host, getObject: host.getObject });

    expect(
      ranInOrder(host, [/^apt-get install/, /^unzip /, /^systemctl enable|^systemctl restart/]),
    ).toBe(true);
    expect(result.installed).toContain(`chrome@${TEST_CHROME_REF}`);
    expect(host.files.has(chromeBinaryPath(TEST_CHROME_REF))).toBe(true);
  });

  test("a no-browser agent unpacks nothing and never reads the browser mirror", async () => {
    seedMirror();

    const result = await apply(makeManifest(), { host, getObject: host.getObject });

    expectNotRan(host, /^unzip/);
    expect(result.installed.some((p) => p.startsWith("chrome@"))).toBe(false);
  });

  test("a fleet with no mirrored build fails the apply by name", async () => {
    host.seed(FLEET_CACHE_PATH, JSON.stringify(makeFleetManifest()));

    const err = (await apply(browserManifest(), { host, getObject: host.getObject }).catch(
      (e: unknown) => e,
    )) as AgentdError;

    expect(err.code).toBe("BROWSER_BUILD_MISSING");
    // Before the units: nothing has been enabled that would then crash-loop.
    expect(host.enabledUnits.size).toBe(0);
  });

  /**
   * The superseded tree goes after the restart that stopped running from it, not
   * beside the unpack that replaced it.
   *
   * The unpack is the packages phase and the restart is the units phase, so a
   * prune at the install site deleted files the *live* Chrome was still
   * executing — and anything in between (`ensureHermes`, the web UI build) can
   * fail and leave the restart undone entirely, stranding a unit whose
   * `ExecStart` names a binary that is gone, crash-looping under
   * `Restart=always` until some later apply finishes.
   */
  test("the old Chrome tree is removed after the browser has been restarted onto the new one", async () => {
    seedMirror();
    const old = "141.0.7390.54";
    host.seed(chromeBinaryPath(old), "old chrome");

    await apply(browserManifest(), { host, getObject: host.getObject });

    const removedAt = host.fsOps.indexOf(`remove ${chromeInstallDir(old)}`);
    const restartedAt = host.commands.findIndex((c) => c.startsWith("systemctl restart"));
    expect(removedAt).toBeGreaterThan(-1);
    expect(restartedAt).toBeGreaterThan(-1);
    // Two different logs, so compare by the one thing both see: the unpack.
    expect(host.files.has(chromeBinaryPath(old))).toBe(false);
    expectRan(host, /^unzip/, 1);
  });

  /**
   * The invariant behind both of those, stated once over the whole apply rather
   * than per call site: **no root command may create or chown a path inside the
   * `hermes` account's home.** Every name directly under `/data/hermes` is one
   * the account can replace with a symlink, so a privileged `install`, `chown`
   * or `chmod` aimed at one is an escalation waiting for the account to take it.
   *
   * The home itself is the deliberate exception and is asserted by name: its
   * parent is root's own `/data`, nothing unprivileged can substitute it, and
   * that line is what makes the home the account's in the first place.
   */
  test("no privileged command writes inside the hermes account's home", async () => {
    seedMirror();

    await apply(browserManifest(), { host, getObject: host.getObject });

    const privileged = host.commands.filter((c) => {
      // Dropped privilege already: whatever the path resolves to, the account
      // gains nothing it did not have.
      if (c.startsWith("runuser ")) return false;
      if (!/^(install|chown|chmod)\b/.test(c)) return false;
      /*
       * `-h` is `--no-dereference`, and GNU `chown -R` is `-P` unless told
       * otherwise — so `chown -R -h` changes a symlink it meets rather than
       * following it, and cannot walk out of the tree it was pointed at.
       * `ensureHermesHomeOwnership` is the one privileged command inside this
       * home for that reason, and it is why the flag is not optional there.
       */
      if (/^chown\b/.test(c) && / -h\b/.test(c)) return false;
      const target = c.split(" ").at(-1) ?? "";
      return target.startsWith(`${HERMES_ACCOUNT_HOME}/`);
    });
    expect(privileged).toEqual([]);
  });

  /**
   * The unit's own `ExecStartPre` creates `/data/hermes/browser/<identity>` as
   * `hermes` rather than as root (`render-browser.ts`), which is what keeps the
   * account from pointing a root `install -d` at a symlink of its choosing. It
   * can only do that if the directory above it is the account's — so the apply
   * makes it so, before any browser instance is enabled.
   */
  test("the profile root is made the agent's before the units start", async () => {
    seedMirror();

    await apply(browserManifest(), { host, getObject: host.getObject });

    // As the account, not as root — `/data/hermes` is the account's own home, so
    // a root `install -d` here would follow a symlink the account had put at
    // `browser` and hand its target over.
    expect(
      ranInOrder(host, [
        /^runuser -u hermes -- install -d -m 0700 \/data\/hermes\/browser$/,
        /^systemctl enable/,
      ]),
    ).toBe(true);
  });

  test("a no-browser agent is given no profile root", async () => {
    seedMirror();

    await apply(makeManifest(), { host, getObject: host.getObject });

    // A string test, not an unanchored `.*` regex over every recorded command.
    expect(
      host.commands.some((c) => c.includes("install -d ") && c.endsWith(" /data/hermes/browser")),
    ).toBe(false);
  });

  /**
   * A symlink there is either the escalation attempt the unprivileged
   * `ExecStartPre` exists to prevent, or an operator who meant something by it.
   * Neither is a thing to follow, and neither is a thing to silently replace.
   */
  test("a symlinked profile root fails the apply instead of being followed", async () => {
    seedMirror();
    host.dirs.add("/data/hermes/browser");
    host.symlinks.add("/data/hermes/browser");

    const err = (await apply(browserManifest(), { host, getObject: host.getObject }).catch(
      (e: unknown) => e,
    )) as AgentdError;

    expect(err.code).toBe("AGENT_DIR_UNSAFE");
    expect(host.enabledUnits.size).toBe(0);
  });
});

/**
 * The single-instance browser units hermetic rendered before the per-identity
 * stack (§7.3).
 *
 * They are the reason the per-identity stack could not come up at all on an
 * existing browser agent: `xvfb.service` holds `:99`, `x11vnc.service` holds
 * 5900 and `novnc.service` holds 6080, all as root, and `apply` never prunes a
 * unit that merely stopped being listed — so `xvfb@default.service` and its
 * siblings would crash-loop under `Restart=always` forever.
 */
describe("the superseded single-instance browser units", () => {
  let host: FakeHost;

  beforeEach(() => {
    host = new FakeHost();
    resetAptIndexState();
  });

  const BROWSER_UNITS = [
    "xvfb@default.service",
    "hermetic-wm@default.service",
    "x11vnc@default.service",
    "novnc@default.service",
    "hermetic-browser@default.service",
  ];
  const LEGACY = ["xvfb.service", "x11vnc.service", "novnc.service"];
  const ZIP = "PK chrome-for-testing\n";

  const hermeticWrote = (description: string) =>
    [`# ${HERMETIC_RENDERED_MARKER}. Final file, no templating.`, "[Unit]", description, ""].join("\n");

  /** A browser agent as core renders one: template files written, instances listed. */
  function browserManifest() {
    return makeManifest({
      browser: true,
      packages: ["curl", "git", "jq", "nftables", "unzip"],
      units: [
        "hermeticd.service",
        "hermes-dashboard.service",
        "hermes-gateway.service",
        ...BROWSER_UNITS,
      ],
    });
  }

  beforeEach(() => {
    host.s3Objects.set(browserBuildKey(TEST_CHROME_REF), new TextEncoder().encode(ZIP));
    host.seed(
      FLEET_CACHE_PATH,
      JSON.stringify(makeFleetManifest({ browser: { [TEST_CHROME_REF]: ZIP } })),
    );
    // The template files the units phase resolves each instance from. hermeticd
    // writes them from the manifest on a real box; here they only have to exist.
    for (const template of ["xvfb", "hermetic-wm", "x11vnc", "novnc", "hermetic-browser"]) {
      host.seed(`/etc/systemd/system/${template}@.service`, hermeticWrote(`Description=${template}`));
    }
  });

  /** The box as it is before this apply: three legacy units, enabled and running. */
  function seedLegacy(): void {
    for (const unit of LEGACY) {
      host.seed(`/etc/systemd/system/${unit}`, hermeticWrote(`Description=${unit}`));
      host.enabledUnits.add(unit);
      host.runningUnits.add(unit);
    }
  }

  test("they are disabled and removed before the new instances are enabled", async () => {
    seedLegacy();
    const { emit, events } = collector();

    const result = await apply(browserManifest(), { host, emit, getObject: host.getObject });

    for (const unit of LEGACY) {
      expect(
        ranInOrder(host, [
          new RegExp(`^systemctl disable --now ${unit}$`),
          /^systemctl enable xvfb@default\.service$/,
        ]),
      ).toBe(true);
      // Removed, not merely disabled: a file left behind is a unit the next
      // operator — or the next boot — can start on top of the new stack.
      expect(host.fsOps).toContain(`remove /etc/systemd/system/${unit}`);
      expect(host.files.has(`/etc/systemd/system/${unit}`)).toBe(false);
      expect(result.changed).toContain(`/etc/systemd/system/${unit}`);
      expect(events.map((e) => e.message)).toContain(
        `removing ${unit}, superseded by ${unit.replace(".service", "@default.service")}`,
      );
    }
    expect(host.stopped).toEqual(expect.arrayContaining(LEGACY));
    expect(result.enabled).toEqual(expect.arrayContaining(BROWSER_UNITS));
  });

  test("a browser agent that never had them is told to disable nothing", async () => {
    await apply(browserManifest(), { host, getObject: host.getObject });

    expectNotRan(host, /^systemctl disable/);
    expect(host.fsOps.filter((op) => /^remove \/etc\/systemd\/system/.test(op))).toEqual([]);
  });

  /**
   * A `--no-browser` agent that still carries the old units is a different
   * problem: nothing is competing for the display, and removing a de-listed
   * unit in general is exactly what `apply` does not do.
   */
  test("an agent with no browsers leaves them alone", async () => {
    seedLegacy();

    await apply(makeManifest(), { host, getObject: host.getObject });

    expectNotRan(host, /^systemctl disable/);
    for (const unit of LEGACY) expect(host.files.has(`/etc/systemd/system/${unit}`)).toBe(true);
  });

  test("a unit hermetic did not write is left where it is, with a warning", async () => {
    host.seed("/etc/systemd/system/xvfb.service", "[Unit]\nDescription=somebody else's Xvfb\n");
    host.enabledUnits.add("xvfb.service");
    const { emit, events } = collector();

    await apply(browserManifest(), { host, emit, getObject: host.getObject });

    expectNotRan(host, /^systemctl disable/);
    expect(host.files.has("/etc/systemd/system/xvfb.service")).toBe(true);
    const warning = events.find((e) => e.level === "warn" && e.message.includes("xvfb.service"));
    expect(warning?.message).toContain("not rendered by hermetic");
    expect(warning?.message).toContain("xvfb@default.service");
  });

  test("a plan reports the removals in changed, and removes nothing", async () => {
    seedLegacy();
    const { emit, events } = collector();

    const result = await apply(browserManifest(), {
      host,
      dryRun: true,
      emit,
      getObject: host.getObject,
    });

    for (const unit of LEGACY) {
      expect(result.changed).toContain(`/etc/systemd/system/${unit}`);
      expect(host.files.has(`/etc/systemd/system/${unit}`)).toBe(true);
    }
    expect(events.filter((e) => e.message.startsWith("removing "))).toEqual([]);
    expectNotRan(host, /^systemctl disable/);
  });
});

/**
 * The agent's own Python (`HERMES_AGENT_VENV`): Ubuntu's python3 is
 * externally-managed with no pip and the Hermes venv is root's, so without
 * this a `pip install` has nowhere to go.
 */
describe("the agent's own install trees", () => {
  let host: FakeHost;

  beforeEach(() => {
    host = new FakeHost();
    resetAptIndexState();
  });

  test("the venv is built once, as the account, with the account's HOME", async () => {
    const envs: Record<string, string>[] = [];
    host.execFaults.push((argv, opts) => {
      if (argv.includes("venv") && argv.includes("/data/hermes/.venv"))
        envs.push({ ...(opts?.env ?? {}) });
      return null;
    });
    await apply(makeManifest(), { host });

    expect(
      host.commands.filter((c) => c.includes("uv venv ") && c.endsWith(" /data/hermes/.venv")),
    ).toEqual([
      "runuser -u hermes -- uv venv --no-config --seed --python /usr/bin/python3 /data/hermes/.venv",
    ]);
    // `runuser` keeps root's HOME, and uv's cache would land in /root.
    expect(envs).toEqual([{ HOME: "/data/hermes" }]);

    host.commands.length = 0;
    await apply(makeManifest(), { host });
    expect(host.commands.some((c) => c.includes("uv venv ") && c.endsWith(" /data/hermes/.venv"))).toBe(
      false,
    );
  });

  test("a venv uv could not build warns and leaves the apply standing", async () => {
    host.when(/uv venv --no-config --seed /, { code: 2, stderr: "error: Failed to fetch pip" });
    const { emit, events } = collector();

    await apply(makeManifest(), { host, emit });

    const warn = events.find((e) => e.level === "warn" && e.message.includes("/data/hermes/.venv"));
    expect(warn?.message).toContain("Failed to fetch pip");
  });

  test("the ownership pass also heals the account's install trees", async () => {
    await apply(makeManifest(), { host });
    const chowns = host.commandsMatching(/^chown -R -h hermes:hermes /);
    expect(chowns).toContain("chown -R -h hermes:hermes /data/hermes/.local");
    expect(chowns).toContain("chown -R -h hermes:hermes /data/hermes/.hermes");
  });
});
