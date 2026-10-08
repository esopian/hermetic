/**
 * The agent's own Python environment (`HERMES_AGENT_VENV`, §6.4).
 *
 * Ubuntu's `/usr/bin/python3` is PEP 668 externally-managed and ships no pip,
 * and the Hermes venv is root's, so an agent that wants a Python package has
 * nowhere it may put one. Upstream's NixOS container mode answers this with a
 * seeded `~/.venv` first on the agent's `PATH` (`nix/nixosModules.nix`), and
 * this is that: a venv the `hermes` account owns, on the data volume so it
 * survives a recreate, which `/etc/profile.d/hermetic-agent.sh` activates for
 * every login shell the account gets.
 */
import { HERMES_ACCOUNT_HOME, HERMES_AGENT_VENV } from "@hermetic/core/shared";
import { asHermes } from "../account-dirs.ts";
import type { Emit } from "../events.ts";
import { opEvent } from "../events.ts";
import type { Host } from "../host.ts";

/**
 * The interpreter the venv is built on. Ubuntu's own, because it is on every
 * box without a download — a uv-managed interpreter would come from GitHub at
 * first boot, the dependency the Hermes mirror exists to avoid.
 */
export const AGENT_VENV_PYTHON = "/usr/bin/python3";

/**
 * Build the venv once, as the account, when it is absent.
 *
 * Never rebuilt: what is inside is the agent's, and replacing it would discard
 * every package it installed. A venv that exists but no longer runs — an image
 * whose `python3` moved — is left for the agent or an operator to rebuild with
 * `uv venv --seed --clear`, rather than wiped by an apply.
 *
 * Best effort. `--seed` fetches pip from PyPI, and a box that cannot reach it
 * yet is still a box Hermes runs on; the next apply tries again. `HOME` is the
 * account's because `runuser` keeps root's, and uv's cache would otherwise be
 * `/root/.cache`, which `hermes` cannot write. `--no-config`, and the
 * account's home as the working directory, because uv reads a `uv.toml` out of
 * whatever directory it starts in — one the account cannot open is a failed
 * build, and one it can is configuration nobody here chose.
 */
export async function ensureAgentVenv(host: Host, emit: Emit, dry: boolean): Promise<void> {
  if (dry) return;
  if ((await host.stat(`${HERMES_AGENT_VENV}/bin/python`)) !== null) return;
  emit(
    opEvent(
      "accounts",
      0.39,
      `creating the agent's Python environment at ${HERMES_AGENT_VENV}`,
      host.now(),
    ),
  );
  const res = await host.exec(
    asHermes(["uv", "venv", "--no-config", "--seed", "--python", AGENT_VENV_PYTHON, HERMES_AGENT_VENV]),
    { env: { HOME: HERMES_ACCOUNT_HOME }, cwd: HERMES_ACCOUNT_HOME },
  );
  if (res.code !== 0) {
    emit(
      opEvent(
        "accounts",
        0.39,
        `could not create ${HERMES_AGENT_VENV} (uv exited ${res.code}: ${res.stderr.trim()}); ` +
          "the agent has no writable Python until the next apply",
        host.now(),
        "warn",
      ),
    );
  }
}
