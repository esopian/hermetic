/**
 * The `app.notify` bridge. The page decides whether to
 * notify; this only checks that what it decided reaches the devkit intact, and
 * that the permission answer is the constant it is supposed to be.
 */
import { describe, expect, test } from "bun:test";
import { isHermeticError } from "@hermetic/core";
import { createNotifier } from "../../src/main/notify.ts";

const silentLog = { line: () => {} };

function capture() {
  const seen: { title: string; body: string; tag?: string }[] = [];
  const notify = createNotifier({
    showNotification: (options) => {
      seen.push(options);
    },
    log: silentLog,
  });
  return { seen, notify };
}

describe("a notification", () => {
  test("reaches the devkit with its title, body and tag", () => {
    const { seen, notify } = capture();
    const result = notify({ title: "corvid", body: "finished the turn", tag: "chat:corvid" });

    expect(seen).toEqual([{ title: "corvid", body: "finished the turn", tag: "chat:corvid" }]);
    expect(result).toEqual({ delivered: true, permission: "granted" });
  });

  test("is granted, always — the app is the one asking", () => {
    const { notify } = capture();
    expect(notify({ title: "a", body: "b" }).permission).toBe("granted");
  });

  test("carries no tag when the page sent none", () => {
    const { seen, notify } = capture();
    notify({ title: "a", body: "b" });
    expect(seen[0]).toEqual({ title: "a", body: "b" });
  });

  test("is trimmed on the way through", () => {
    const { seen, notify } = capture();
    notify({ title: "  corvid  ", body: "  done  " });
    expect(seen[0]).toEqual({ title: "corvid", body: "done" });
  });
});

describe("an empty notification", () => {
  test("is refused rather than shown as a nameless banner", () => {
    const { seen, notify } = capture();
    let error: unknown;
    try {
      notify({ title: "   ", body: "finished the turn" });
    } catch (e) {
      error = e;
    }
    expect(isHermeticError(error) && error.code).toBe("VALIDATION");
    expect(seen).toEqual([]);
  });

  test("an empty body is refused for the same reason", () => {
    const { notify } = capture();
    expect(() => notify({ title: "corvid", body: "" })).toThrow();
  });
});
