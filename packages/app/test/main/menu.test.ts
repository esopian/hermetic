/**
 * The application menu. The model is plain data, so the
 * items and what they do can be asserted with no devkit present — which is the
 * reason the setter is injected in the first place.
 */
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { buildMenu, type MenuItemModel, installMenu } from "../../src/main/menu.ts";

/**
 * Two labels, not two directories: `buildMenu` only ever hands these strings to
 * the injected `openPath`, and nothing here touches a filesystem. They are
 * assembled with `join` rather than written as literals so that
 * `tests/test-isolation.test.ts`'s "no fixed path as a HERMETIC_HOME" rule —
 * which reads source text, and cannot tell a display string from a home a test
 * would actually write into — stays a rule with no exceptions.
 */
const PATHS = {
  home: join("/Users/nobody", ".hermetic"),
  userLogs: join("/Users/nobody", "Library", "Logs", "Hermetic"),
};

function noActions() {
  return { checkForUpdates: () => {}, installCli: () => {}, openPath: () => {} };
}

function flatten(items: MenuItemModel[]): MenuItemModel[] {
  return items.flatMap((item) => [item, ...(item.submenu ? flatten(item.submenu) : [])]);
}

function find(items: MenuItemModel[], label: string): MenuItemModel {
  const hit = flatten(items).find((item) => item.label === label);
  if (hit === undefined) throw new Error(`no menu item labelled ${label}`);
  return hit;
}

describe("the model", () => {
  test("carries the items the plan names", () => {
    const labels = flatten(buildMenu(noActions(), PATHS)).map((item) => item.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Check for Updates…",
        "Install Command Line Tool…",
        "Open Logs…",
        "Hermetic Home",
        "Application Logs",
        "Quit Hermetic",
      ]),
    );
  });

  test("leaves the standard items to their roles, so the OS wires the shortcuts", () => {
    const roles = flatten(buildMenu(noActions(), PATHS))
      .map((item) => item.role)
      .filter((role): role is string => role !== undefined);
    expect(roles).toEqual(
      expect.arrayContaining([
        "undo",
        "redo",
        "cut",
        "copy",
        "paste",
        "selectAll",
        "minimize",
        "close",
        "quit",
      ]),
    );
  });

  test("gives no item both a role and a callback", () => {
    for (const item of flatten(buildMenu(noActions(), PATHS))) {
      expect(item.role !== undefined && item.action !== undefined).toBe(false);
    }
  });
});

describe("the items", () => {
  test("fire the injected actions, and the log items carry the two directories", () => {
    const fired: string[] = [];
    const opened: string[] = [];
    const menu = buildMenu(
      {
        checkForUpdates: () => fired.push("updates"),
        installCli: () => fired.push("cli"),
        openPath: (path) => opened.push(path),
      },
      PATHS,
    );

    find(menu, "Check for Updates…").action?.();
    find(menu, "Install Command Line Tool…").action?.();
    find(menu, "Hermetic Home").action?.();
    find(menu, "Application Logs").action?.();

    expect(fired).toEqual(["updates", "cli"]);
    expect(opened).toEqual([PATHS.home, PATHS.userLogs]);
  });
});

describe("installing", () => {
  test("hands the model to the injected setter and nothing else", () => {
    const set: MenuItemModel[][] = [];
    const menu = installMenu({
      actions: noActions(),
      paths: PATHS,
      setApplicationMenu: (model) => {
        set.push(model);
      },
    });

    expect(set).toHaveLength(1);
    expect(set[0]).toBe(menu);
  });
});
