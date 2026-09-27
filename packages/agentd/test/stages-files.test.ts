/**
 * The stage files themselves (§4.3). `stages.test.ts` proves the runner runs
 * whatever a release contains; this proves the release *we* ship is shell that
 * parses, orders, and keeps its secrets off argv.
 *
 * `bun run lint:sh` runs shellcheck over the same files, which catches the
 * quoting and `set -e` mistakes a syntax check cannot. This file covers the two
 * things shellcheck has no opinion about: hermetic's own naming contract, and
 * the rule that a stage never puts a credential where `ps` can see it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STAGE_FILE_RE, orderStages } from "@hermetic/core/schema";
import { stageEnv, stageIdOf } from "../src/stages.ts";
import { FakeHost } from "./fake-host.ts";
import { makeFleetManifest, TEST_BUCKET, TEST_NAME } from "./fixtures.ts";

const STAGES_DIR = join(import.meta.dir, "..", "stages");
const FILES = readdirSync(STAGES_DIR).filter((name) => name.endsWith(".sh"));
const read = (file: string): string => readFileSync(join(STAGES_DIR, file), "utf8");

describe("the shipped bootstrap stages (§4.3)", () => {
  test("there are stages, and every name matches the release contract", () => {
    expect(FILES.length).toBeGreaterThan(0);
    for (const file of FILES) expect(file).toMatch(STAGE_FILE_RE);
    // `orderStages` is what the laptop validates a release with and what
    // hermeticd orders a boot by; it must accept this exact set.
    expect(orderStages(FILES)).toEqual([...FILES].sort());
  });

  test("the set covers the boot the design describes, in order", () => {
    expect(orderStages(FILES).map(stageIdOf)).toEqual([
      "00-preflight",
      "01-tailscale",
      "02-data-volume",
      "03-config",
      "04-apply",
      "05-service",
      "06-verify",
    ]);
  });

  test.each(FILES)("%s is bash that parses", (file) => {
    const proc = Bun.spawnSync(["bash", "-n", join(STAGES_DIR, file)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(new TextDecoder().decode(proc.stderr)).toBe("");
    expect(proc.exitCode).toBe(0);
  });

  test.each(FILES)("%s declares bash and fails loudly", (file) => {
    const body = read(file);
    expect(body.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    // Without `set -euo pipefail` a failed command inside a stage is a silent
    // exit 0, which the runner would record as `ok`.
    expect(body).toContain("set -euo pipefail");
  });

  /**
   * §8.3: a secret reaches a process through a file or stdin, never argv —
   * argv is world-readable in `/proc/<pid>/cmdline` for the life of the
   * process. `hermeticd stage secret` writes a 0600 file on tmpfs, and that
   * path is the only thing a stage may pass.
   */
  test.each(FILES)("%s puts no secret on argv", (file) => {
    const body = read(file);
    expect(body).not.toMatch(/tskey-[a-z]/);
    expect(body).not.toMatch(/--auth-key=(?!file:)/);
    expect(body).not.toMatch(/--authkey[= ]/);
    // No `--flag=$(hermeticd stage secret …)`: capturing the value into the
    // command line is the same leak by another route.
    expect(body).not.toMatch(/=\$\([^)]*stage secret/);
    expect(body).not.toMatch(/\bBWS_ACCESS_TOKEN=\S/);
  });

  test("the tailscale stage reads the key from a file and deletes it either way", () => {
    const body = read("01-tailscale.sh");
    expect(body).toContain("stage secret --slot ts-key --out");
    expect(body).toContain("--auth-key=file:");
    expect(body).toContain("--ssh");
    // The tailnet hostname, which is `<fleet>-<agent>` since foundation v3 and
    // falls back to the agent name on a box launched before it.
    expect(body).toContain('--hostname="$HOSTNAME_WANTED"');
    expect(body).toContain('HOSTNAME_WANTED="${HERMETIC_HOSTNAME:-$HERMETIC_NAME}"');
    expect(body).toContain("--advertise-tags=tag:hermetic");
    // The trap is what makes the key's lifetime independent of the join
    // succeeding — the case where a leftover key would matter most.
    expect(body).toMatch(/trap cleanup EXIT/);
    expect(body).toMatch(/rm -f "\$AUTHKEY"/);
    // tmpfs only.
    expect(body).toContain("AUTHKEY=/run/hermetic/");
  });

  test("the destructive and AWS-touching work is delegated to hermeticd, not done in bash", () => {
    expect(read("02-data-volume.sh")).toContain('"$HERMETICD" stage disk-prepare');
    expect(read("03-config.sh")).toContain('"$HERMETICD" stage fetch-config');
    expect(read("04-apply.sh")).toContain('"$HERMETICD" apply --manifest');
    // The last stage asks hermeticd whether the agent can actually answer —
    // the provider, model and key assertions are TypeScript for the same
    // reason the rest is: a bash grep over a YAML file is not a verdict.
    expect(read("06-verify.sh")).toContain('"$HERMETICD" stage verify-hermes');
    // Both Hermes processes, not just the dashboard: an agent whose gateway
    // never started has no messaging channels and no cron, and `ready` would
    // not be the claim §4.3 says it is.
    expect(read("06-verify.sh")).toContain("hermes-gateway.service");
    // No stage formats, partitions or writes fstab itself.
    for (const file of FILES) {
      expect(read(file)).not.toMatch(/\bmkfs|\bwipefs|\bsgdisk|\/etc\/fstab/);
    }
  });

  test("every variable a stage reads is one the runner actually sets", () => {
    const provided = new Set(
      Object.keys(
        stageEnv(
          {
            host: new FakeHost(),
            aws: {} as never,
            name: TEST_NAME,
            bucket: TEST_BUCKET,
            fleet: makeFleetManifest(),
            paramPrefix: `/hermes/${TEST_NAME}/`,
            region: "us-east-1",
          },
          "00-preflight",
        ),
      ),
    );
    // Plus the ones a stage sets for itself.
    provided.add("DEBIAN_FRONTEND");

    for (const file of FILES) {
      for (const match of read(file).matchAll(/\$\{?(HERMETIC[A-Z_]*)\b/g)) {
        expect({ file, variable: match[1] }).toEqual({
          file,
          variable: provided.has(match[1] as string) ? match[1] : `UNSET:${match[1]}`,
        });
      }
    }
  });

  /**
   * §8.3: `/run/hermetic` is where `hermeticd stage secret` drops a 0600 auth
   * key. `mkdir -p` honours the umask (0755 on a stock Ubuntu), which would
   * make that key enumerable by every account on the box.
   */
  test("the tmpfs directory secrets land in is created 0700, not at the umask", () => {
    const body = read("00-preflight.sh");
    expect(body).toContain("install -d -m 0700 /run/hermetic");
    expect(body).not.toMatch(/mkdir -p [^\n]*\/run\/hermetic/);
  });

  /**
   * A reboot, an operator rerun or a new release of this stage must not mint
   * and spend a fresh auth key on a box that is already on the tailnet: the key
   * is single-use and rate-limited.
   */
  test("the tailscale stage is a no-op when the box is already on the tailnet", () => {
    const body = read("01-tailscale.sh");
    expect(body).toMatch(/BackendState[^\n]*Running/);
    // The join, and only the join, is inside the conditional.
    const guarded = body.slice(body.indexOf("BackendState"));
    expect(guarded).toContain("tailscale up");
    expect(guarded).toContain("stage secret --slot ts-key");
    // The fact is recorded outside the conditional — a box that was already up
    // still has to tell the row its address.
    expect(body.indexOf("tailscale_ip=")).toBeGreaterThan(body.indexOf("tailscale up"));
    expect(body.indexOf("tailscale_ip=")).toBeGreaterThan(body.lastIndexOf("rm -f"));
    // Same for the name, and for the same reason.
    expect(body.indexOf("tailscale_dns_name=")).toBeGreaterThan(body.indexOf("tailscale up"));
    expect(body.indexOf("tailscale_dns_name=")).toBeGreaterThan(body.lastIndexOf("rm -f"));
  });

  /**
   * The name the tailnet gave us is not derivable from the name we asked for: a
   * recreate whose predecessor still holds `<name>` is handed `<name>-2`, which
   * is what `serve` publishes and what the certificate is for. The stage reads
   * it out of the same `tailscale status --json` it already greps, without jq,
   * and writes nothing at all when the daemon has no name yet — an empty fact
   * would blank a good value on the row.
   */
  test("the tailscale stage records the name the node was actually given", () => {
    const body = read("01-tailscale.sh");
    expect(body).toContain('sed -n \'s/.*"Self":{[^{}]*"DNSName":"\\([^"]*\\)".*/\\1/p\'');
    // The trailing dot `tailscale` reports is correct DNS and wrong in a URL.
    expect(body).toContain('dns="${dns%.}"');
    const emit = body.slice(body.indexOf('dns="${dns%.}"'));
    expect(emit).toMatch(/if \[ -n "\$dns" \]; then\n\s+echo "tailscale_dns_name=/);
  });

  /**
   * Nothing else on a box upgrades Tailscale: this stage installs only when the
   * binary is absent, hermeticd's apply installs only missing packages, and
   * `unattended-upgrades` allows the Ubuntu security pocket and not
   * pkgs.tailscale.com. So the updater has to be turned on here, it has to be
   * turned on outside the install guard — an existing box is exactly the one
   * that has been stuck on an old release — and it must not be able to fail a
   * boot that has already reached the tailnet. It also has to come last:
   * enabling the updater can restart tailscaled, and a restarting daemon
   * reports neither an address nor a name.
   */
  test("the tailscale stage turns the daemon's own updater on, unguarded and non-fatally", () => {
    const body = read("01-tailscale.sh");
    expect(body).toContain("tailscale set --auto-update");
    // After the join: `tailscale set` wants a daemon that is up and logged in.
    // Anchored on the join block's own progress line rather than the string
    // `tailscale up`, which also appears in this script's header comment.
    expect(body.indexOf("tailscale set --auto-update")).toBeGreaterThan(
      body.indexOf("::progress 0.7 already on the tailnet"),
    );
    // After both facts are written, for the reason above: an update landing
    // mid-stage would otherwise leave the row with no address and no name on a
    // stage that still exited 0.
    expect(body.indexOf("tailscale set --auto-update")).toBeGreaterThan(
      body.indexOf('echo "tailscale_ip=${ip}"'),
    );
    expect(body.indexOf("tailscale set --auto-update")).toBeGreaterThan(
      body.indexOf('echo "tailscale_dns_name=${dns}"'),
    );
    // Outside the `command -v tailscale` guard: pinned to column 0, since every
    // line of that guard's body is indented. A box that already had Tailscale
    // skips the block entirely and must still come out with the updater on.
    // Tolerated rather than checked, too: `--auto-update` is unknown to a
    // Tailscale older than 1.60 and refused outright on a build that cannot
    // update itself.
    expect(body).toMatch(/\nif ! tailscale set --auto-update; then\n/);
  });

  /**
   * The regional EC2 mirror pool has sick members (a 503 backend, hanging IPv6
   * addresses). Untimed, apt waits on one for hours; timed out, it returns a
   * partial index and `hermeticd apply` then cannot find the `universe`
   * packages the browser needs. Preflight is the only place that fixes both for
   * every later apt call on the box, so it must still be doing it.
   */
  test("preflight bounds apt and gives the regional mirror a canonical fallback", () => {
    const body = read("00-preflight.sh");
    // Bounded once, centrally, rather than per caller.
    expect(body).toContain("/etc/apt/apt.conf.d/90hermetic");
    expect(body).toContain('Acquire::Retries "3"');
    expect(body).toContain('Acquire::http::Timeout "20"');
    expect(body).toContain('Acquire::https::Timeout "20"');
    // apt's `mirror` method keeps the regional preference and falls back.
    expect(body).toContain("mirror+file:");
    expect(body).toContain("/etc/apt/mirrors.txt");
    expect(body).toMatch(/priority:1/);
    expect(body).toMatch(/priority:2/);
    // Preflight rewrites sources; refreshing the index is a later stage's job,
    // so no `apt-get update` outside the comment that explains why.
    const code = body.replace(/^\s*#.*$/gm, "");
    expect(code).not.toMatch(/apt-get update/);
  });

  /**
   * A check that runs after the work it guards cannot prevent the failure it
   * names: preflight's own mirror rewrite is built out of `sed`, and every
   * later stage shells out to the rest. `tar` and `xz` are on the list because
   * `hermeticd apply` unpacks the Node release as a `.tar.xz`.
   */
  test("preflight checks its tools before it uses any of them", () => {
    const body = read("00-preflight.sh");
    const check = body.indexOf("for tool in");
    expect(check).toBeGreaterThan(-1);
    for (const tool of ["apt-get", "systemctl", "curl", "sed", "tar", "xz"]) {
      expect(body.slice(check, body.indexOf("\ndone", check))).toContain(tool);
    }
    // Ahead of the apt/mirror block, which is the first thing that shells out.
    expect(check).toBeLessThan(body.indexOf("/etc/apt/apt.conf.d/90hermetic"));
    expect(check).toBeLessThan(body.indexOf("MIRRORS="));
    // …and ahead of the `sed` it would otherwise be reporting on after the fact.
    expect(check).toBeLessThan(body.indexOf("sed -i"));
  });

  /**
   * A stage that hangs is a boot that never ends: the runner has no per-stage
   * timeout and only polls for `rerun` between stages. Plain `timeout` sends
   * SIGTERM and then waits forever for a child that ignores it — which dpkg
   * mid-transaction does — so every apt install here carries a kill-after, and
   * the fallback repairs what a killed dpkg leaves behind before retrying.
   */
  test("the tailscale stage bounds apt with a kill-after and repairs dpkg before retrying", () => {
    const body = read("01-tailscale.sh");
    // `-y` picks out the two that actually install, not the progress echo.
    const installs = body.match(/^\s*.*apt-get install -y.*$/gm) ?? [];
    expect(installs).toHaveLength(2);
    for (const line of installs) expect(line).toContain("timeout -k 30 300 apt-get install");
    // The repair sits between the two attempts, and never fails the stage
    // itself: there is nothing to configure when the first attempt failed for
    // any other reason.
    const repair = body.indexOf("dpkg --configure -a");
    expect(repair).toBeGreaterThan(body.indexOf(installs[0] as string));
    expect(repair).toBeLessThan(body.indexOf(installs[1] as string));
    expect(body).toContain("dpkg --configure -a || true");
    // apt's documented "no parts directory" is `-`; /dev/null is a character
    // device apt is entitled to complain about rather than read as empty.
    expect(body).toContain("-o Dir::Etc::SourceParts=-");
    expect(body).not.toContain("Dir::Etc::SourceParts=/dev/null");
  });

  test("stages report progress, so a slow boot is visible while it is slow", () => {
    for (const file of FILES) {
      expect(read(file)).toMatch(/^echo "::progress /m);
    }
  });
});

/**
 * The apt mirror rewrite in `00-preflight.sh`, run for real.
 *
 * It builds two `sed -E` expressions by interpolating a URI read out of the
 * image's own apt sources, so every character in that URI that means something
 * to an ERE has to be escaped first. It used to escape `.` and nothing else,
 * which is right for the URIs Ubuntu's images happen to carry today and wrong
 * for the first one that carries a `+`, a `(` or a `?`: an unescaped
 * metacharacter either matches something else or makes sed refuse to compile,
 * and this runs in stage 00 — so it takes the whole boot with it.
 *
 * The `-i` is dropped here and the input comes from stdin instead: BSD sed
 * takes an argument for `-i` and GNU sed does not, and the expressions
 * themselves — the thing under test — are read verbatim out of the shipped
 * file either way.
 */
describe("00-preflight's mirror rewrite escapes what sed would otherwise read", () => {
  const source = read("00-preflight.sh");
  const escapeLine = /^\s*pattern="\$\(printf[^\n]*\)"$/m.exec(source)?.[0];
  const expressions = [...source.matchAll(/^\s*-e ("(?:\\#|[^"])*")\s*\\?$/gm)].map((m) => m[1]);

  function run(script: string, args: readonly string[], stdin = ""): string {
    const proc = Bun.spawnSync(["bash", "-c", script, "bash", ...args], {
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toBe("");
    expect(proc.exitCode).toBe(0);
    return new TextDecoder().decode(proc.stdout);
  }

  test("the file still builds its pattern and its two expressions the way this test reads them", () => {
    expect(escapeLine).toBeDefined();
    expect(expressions).toHaveLength(2);
    for (const expression of expressions) expect(expression).toContain("${pattern}");
  });

  test("every ERE metacharacter in the URI is escaped, not just the dots", () => {
    const escaped = run(`set -euo pipefail\nuri="$1"\n${escapeLine}\nprintf '%s' "$pattern"\n`, [
      "http://eu-west-2.ec2.ports.ubuntu.com/u+b(u)n?t[u]*|^$",
    ]);
    for (const meta of ["+", "(", ")", "?", "[", "]", "*", "|", "^", "$", "."]) {
      expect(escaped).toContain(`\\${meta}`);
    }
    // …and nothing that is not a metacharacter is touched, so the pattern is
    // still the URI a human can read in a log.
    expect(escaped).toContain("eu-west-2");
    expect(escaped).toContain("//");
  });

  test("a URI full of metacharacters still rewrites its own stanza and nobody else's", () => {
    const uri = "http://eu-west-2.ec2.ports.ubuntu.com/ubuntu-ports+a(1)?";
    const script =
      `set -euo pipefail\nuri="$1"\nlist="$2"\n${escapeLine}\n` +
      `sed -E ${expressions.map((e) => `-e ${e}`).join(" ")}\n`;

    const rewritten = run(script, [uri, "/etc/apt/mirrors.txt"], `URIs: ${uri}\n`);
    expect(rewritten).toBe("URIs: mirror+file:/etc/apt/mirrors.txt\n");

    // The security stanza beside it names the canonical host and is left alone.
    const other = run(
      script,
      [uri, "/etc/apt/mirrors.txt"],
      "URIs: http://ports.ubuntu.com/ubuntu-ports\n",
    );
    expect(other).toBe("URIs: http://ports.ubuntu.com/ubuntu-ports\n");

    // The legacy one-liner form goes through the second expression.
    const legacy = run(script, [uri, "/etc/apt/mirrors.txt"], `deb ${uri} noble main\n`);
    expect(legacy).toBe("deb mirror+file:/etc/apt/mirrors.txt noble main\n");
  });
});
