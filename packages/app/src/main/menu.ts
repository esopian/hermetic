/**
 * The application menu.
 *
 * The menu is built as plain data and handed to an injected setter, so the
 * shape of it can be asserted on a checkout where the devkit has never been
 * projected. `ApplicationMenu.setApplicationMenu` is one call at the edge, made
 * by `main/index.ts`, and nothing in here imports `electrobun/bun`.
 *
 * Items that have a role use it instead of a callback. A role is what tells the
 * OS this is *the* Copy item, which is what gets it ⌘C, the responder-chain
 * wiring, and the enable/disable behaviour that follows the focused control —
 * none of which a function of our own could reproduce, and all of which an
 * operator notices the absence of immediately.
 */

export interface MenuItemModel {
  label?: string;
  /** An OS-standard item (`copy`, `quit`, `minimize`, …). Mutually exclusive with `action`. */
  role?: string;
  /** Only for items with no role; a role carries its own shortcut. */
  accelerator?: string;
  type?: "divider";
  action?: () => void;
  submenu?: MenuItemModel[];
}

export interface MenuActions {
  checkForUpdates(): void;
  installCli(): void;
  /** Reveals a directory in Finder. `main/index.ts` wires it to `Utils.openExternal`. */
  openPath(path: string): void;
}

export interface MenuPaths {
  /** `~/.hermetic` — the database, the config, the portal log core's runs land in. */
  home: string;
  /** `Utils.paths.userLogs` — where the bundle's own crash and launch logs go. */
  userLogs: string;
}

const DIVIDER: MenuItemModel = { type: "divider" };

export function buildMenu(actions: MenuActions, paths: MenuPaths): MenuItemModel[] {
  return [
    {
      label: "Hermetic",
      submenu: [
        { label: "About Hermetic", role: "about" },
        DIVIDER,
        { label: "Check for Updates…", action: () => actions.checkForUpdates() },
        { label: "Install Command Line Tool…", action: () => actions.installCli() },
        {
          label: "Open Logs…",
          submenu: [
            // Two directories because two different failures live in them: what
            // hermetic did is in the home, and why the app would not launch at
            // all is in the bundle's own logs.
            { label: "Hermetic Home", action: () => actions.openPath(paths.home) },
            { label: "Application Logs", action: () => actions.openPath(paths.userLogs) },
          ],
        },
        DIVIDER,
        { label: "Hide Hermetic", role: "hide" },
        { label: "Hide Others", role: "hideOthers" },
        DIVIDER,
        { label: "Quit Hermetic", role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", role: "undo" },
        { label: "Redo", role: "redo" },
        DIVIDER,
        { label: "Cut", role: "cut" },
        { label: "Copy", role: "copy" },
        { label: "Paste", role: "paste" },
        { label: "Select All", role: "selectAll" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { label: "Minimize", role: "minimize" },
        { label: "Zoom", role: "zoom" },
        DIVIDER,
        { label: "Close Window", role: "close" },
      ],
    },
  ];
}

export interface InstallMenuDeps {
  actions: MenuActions;
  paths: MenuPaths;
  /** `ApplicationMenu.setApplicationMenu`, structurally. */
  setApplicationMenu(menu: MenuItemModel[]): void;
}

export function installMenu(deps: InstallMenuDeps): MenuItemModel[] {
  const menu = buildMenu(deps.actions, deps.paths);
  deps.setApplicationMenu(menu);
  return menu;
}
