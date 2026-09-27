/**
 * The one equality this whole layout exists for.
 *
 * `HERMES_HOME` is not merely *a* directory on the data volume — it is
 * `$HOME/.hermes` of the account Hermes runs as. Upstream's
 * `get_default_hermes_root()` returns `HERMES_HOME` unchanged whenever it is
 * outside the invoking user's `~/.hermes`, and every awkward branch in its
 * installer hangs off that case: a mandatory `--run-as-user`,
 * `_hermes_home_for_target_user()` remapping the path, the venv remapped with
 * it, and `hermes-gateway.service` reached only through a custom-root fallback.
 * Keeping the two the same is what makes none of that apply, so it is worth a
 * test of its own rather than being left implicit in a render snapshot.
 */
import { describe, expect, test } from "bun:test";
import {
  HERMES_ACCOUNT_HOME,
  HERMES_HOME,
  HERMES_MANAGED_CONFIG,
  HERMES_SEED_CONFIG,
  HERMES_USER_CONFIG,
} from "../src/schema/index.ts";

describe("the hermes account's home", () => {
  test("HERMES_HOME is exactly $HOME/.hermes of the hermes account", () => {
    expect(HERMES_ACCOUNT_HOME).toBe("/data/hermes");
    expect(HERMES_HOME).toBe(`${HERMES_ACCOUNT_HOME}/.hermes`);
  });

  /** The user scope is inside the root, not beside it — `hermes config` reads it there. */
  test("the agent's own config sits at the root of HERMES_HOME", () => {
    expect(HERMES_USER_CONFIG).toBe(`${HERMES_HOME}/config.yaml`);
  });

  /**
   * The data volume is `/data`, so both of the above are on it and survive a
   * `recreate`; the managed scope is not, and must not be — it is hermetic's
   * half of the configuration, rewritten from the laptop on every apply.
   */
  test("the managed scope is off the data volume", () => {
    expect(HERMES_ACCOUNT_HOME.startsWith("/data/")).toBe(true);
    expect(HERMES_MANAGED_CONFIG.startsWith("/etc/")).toBe(true);
    expect(HERMES_SEED_CONFIG.startsWith("/etc/")).toBe(true);
  });
});
