/**
 * The installation lock (§6.5).
 *
 * Two processes install code on a box — the bootstrap runner and the
 * self-update — and for the minute or two after stage `05-service` they are
 * both alive. The updater can ask systemd whether the bootstrap unit is busy;
 * the bootstrap runner cannot ask the same question back, because
 * `hermeticd.service` is `active` whether it is installing or idle. Hence a
 * file, and hence the liveness check that answers the old objection to one: a
 * lock whose holder is gone is litter, not a lock.
 */
import { describe, expect, test } from "bun:test";
import { BOOT_ID_PATH } from "../src/update/index.ts";
import {
  INSTALL_LOCK_PATH,
  installLockIsLive,
  parseInstallLock,
  readInstallLock,
  takeInstallLock,
  waitForInstallLock,
} from "../src/install-lock.ts";
import { FakeHost } from "./fake-host.ts";

const BOOT = "6f3b2c1a-0000-4000-8000-000000000001";

/** A box whose kernel reports a boot id, with `live` pids in `/proc`. */
function box(live: number[] = []): FakeHost {
  const host = new FakeHost();
  host.seed(BOOT_ID_PATH, `${BOOT}\n`);
  for (const pid of live) host.livePids.add(pid);
  return host;
}

/** A lock file as another process would have left it. */
function seedLock(
  host: FakeHost,
  lock: { holder: string; pid: number; boot_id?: string | null },
): void {
  host.seed(
    INSTALL_LOCK_PATH,
    JSON.stringify({
      holder: lock.holder,
      pid: lock.pid,
      boot_id: lock.boot_id === undefined ? BOOT : lock.boot_id,
      taken_at: "2026-09-16T03:11:00.000Z",
    }),
  );
}

describe("one installer at a time, across processes (§6.5)", () => {
  test("a lock a live process holds refuses the other installer", async () => {
    const host = box([4242]);
    seedLock(host, { holder: "bootstrap", pid: 4242 });

    expect(await takeInstallLock(host, "update", { pid: 99 })).toBeNull();
    // Untouched: refusing is not taking it over.
    expect(await readInstallLock(host)).toMatchObject({ holder: "bootstrap", pid: 4242 });
  });

  test("and lets it through the moment the holder releases", async () => {
    const host = box([4242]);
    const held = await takeInstallLock(host, "bootstrap", { pid: 4242 });
    expect(held).not.toBeNull();
    expect(await takeInstallLock(host, "update", { pid: 99 })).toBeNull();

    await held?.release();

    const second = await takeInstallLock(host, "update", { pid: 99 });
    expect(second).not.toBeNull();
    expect(await readInstallLock(host)).toMatchObject({ holder: "update", pid: 99 });
  });

  /**
   * The objection a lock file has to answer: it outlives the process that took
   * it. A holder that is gone from `/proc` took nothing with it.
   */
  test("a lock whose holder is gone is taken over", async () => {
    const host = box();
    seedLock(host, { holder: "update", pid: 4242 });

    const lock = await takeInstallLock(host, "bootstrap", { pid: 99 });

    expect(lock).not.toBeNull();
    expect(await readInstallLock(host)).toMatchObject({ holder: "bootstrap", pid: 99 });
  });

  /**
   * The other half of it: pids are recycled across a reboot, so a pid that is
   * live today says nothing about a lock written before the box came up.
   */
  test("a lock from a previous boot is taken over, live pid or not", async () => {
    const host = box([4242]);
    seedLock(host, { holder: "bootstrap", pid: 4242, boot_id: "00000000-dead-4000-8000-000000000000" });

    const lock = await takeInstallLock(host, "update", { pid: 99 });

    expect(lock).not.toBeNull();
    expect(await readInstallLock(host)).toMatchObject({ holder: "update", pid: 99 });
  });

  test("a lock nobody can read names nobody, so it is taken over", async () => {
    const host = box([4242]);
    host.seed(INSTALL_LOCK_PATH, "{ this is not json");

    const lock = await takeInstallLock(host, "update", { pid: 99 });

    expect(lock).not.toBeNull();
    expect(parseInstallLock("{ this is not json")).toBeNull();
    expect(parseInstallLock(JSON.stringify({ holder: "nobody", pid: 1 }))).toBeNull();
  });

  /**
   * A boot id the kernel does not publish (a container) drops back to the pid,
   * which is the same fallback the swap marker makes.
   */
  test("no boot id to compare falls back to the pid alone", async () => {
    const host = new FakeHost();
    host.livePids.add(4242);
    seedLock(host, { holder: "bootstrap", pid: 4242, boot_id: null });

    expect(await installLockIsLive(host, (await readInstallLock(host)) ?? never(), 99)).toBe(true);
    expect(await takeInstallLock(host, "update", { pid: 99 })).toBeNull();
  });

  /**
   * `link(2)` is `EPERM` on overlayfs and on anything mounted `nolink`. A lock
   * that treated that as fatal would refuse every install on a box where
   * everything else works.
   */
  test("a filesystem that refuses hard links still locks", async () => {
    const host = box([4242]);
    host.fsFaults.push((op) =>
      op === "link" ? Object.assign(new Error("EPERM: not permitted"), { code: "EPERM" }) : null,
    );

    const lock = await takeInstallLock(host, "update", { pid: 99 });
    expect(lock).not.toBeNull();
    expect(await readInstallLock(host)).toMatchObject({ holder: "update", pid: 99 });

    // And it is still a lock: a live holder refuses the other installer.
    host.livePids.add(99);
    expect(await takeInstallLock(host, "bootstrap", { pid: 4242 })).toBeNull();
  });

  test("releasing a lock somebody else has since taken removes nothing", async () => {
    const host = box();
    const held = await takeInstallLock(host, "update", { pid: 99 });
    // The updater died; its lock went stale and the bootstrap runner took over.
    const second = await takeInstallLock(host, "bootstrap", { pid: 4242 });
    expect(second).not.toBeNull();

    await held?.release();

    expect(await readInstallLock(host)).toMatchObject({ holder: "bootstrap", pid: 4242 });
  });

  test("the waiter takes the lock as soon as it is free", async () => {
    const host = box();
    seedLock(host, { holder: "update", pid: 4242 });

    const lock = await waitForInstallLock(host, "bootstrap", { pid: 99, timeoutMs: 60_000 });

    expect(lock.record).toMatchObject({ holder: "bootstrap", pid: 99 });
  });

  /**
   * And gives up loudly rather than installing alongside somebody:
   * `hermeticd-bootstrap.service` is `Restart=on-failure`, so giving up is a
   * retry a minute later rather than a dead box.
   */
  test("the waiter gives up on a lock that is held for too long", async () => {
    const host = box([4242]);
    seedLock(host, { holder: "update", pid: 4242 });
    const said: string[] = [];

    const waiting = waitForInstallLock(host, "bootstrap", {
      pid: 99,
      timeoutMs: 30_000,
      pollMs: 5_000,
      log: (m) => said.push(m),
    });

    await expect(waiting).rejects.toMatchObject({ code: "CONFLICT" });
    // Said once, not once per poll.
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("waiting for the update installer");
  });
});

/** A `never` for the type checker: every call site above has already asserted. */
function never(): never {
  throw new Error("unreachable");
}
