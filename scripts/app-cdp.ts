#!/usr/bin/env bun
/**
 * `bun run app:cdp <command>`: drive the running dev app over the DevTools
 * protocol.
 *
 * A dev build renders with CEF and listens for DevTools on 127.0.0.1
 * (`packages/app/renderer.ts`), so the window a person sees can be read and
 * clicked from a shell: the thing a coding agent needs to check its own UI
 * change in the real app rather than only in `packages/ui/test/flows`. A
 * release build ships WKWebView and has no such port; this script is for
 * `bun run dev`, `dev:fixture`, `dev:wizard` and their `:hmr` twins.
 *
 * Plain CDP over Bun's own `WebSocket`, no dependency: Playwright's
 * `connectOverCDP` stalls under the repo's pinned Bun (its `ws` shim never
 * completes the handshake), and the commands an agent reaches for are a few
 * protocol calls each. For a Playwright script, run it with Node — see
 * CONTRIBUTING.md ("Driving the dev app").
 *
 * Commands:
 *   targets                  the page targets (url, title)
 *   snapshot                 the accessibility tree, one node per line
 *   text [selector]          innerText of the selector (default: body)
 *   eval <expression>        evaluate in the page, print the JSON result
 *   click <target>           real mouse click at the element's centre
 *   fill <target> <text>     focus, select all, insert text
 *   press <key>              Enter, Escape, Tab, Backspace, ArrowUp/Down/Left/Right
 *   wait <target> [ms]       until the element exists (default 10000 ms)
 *   screenshot [path]        PNG of the page (default: app-screenshot.png)
 *   console [seconds]        stream console output and exceptions (default 10 s)
 *   reload                   reload the page
 *
 * A <target> is a CSS selector, or `text=…` for the first button, link,
 * tab or [role] element whose aria-label or text is that string (whitespace
 * collapsed; an exact match wins over a case-insensitive one, since CSS
 * `text-transform` changes what `innerText` reports).
 *
 * `--port <n>` or `HERMETIC_CDP_PORT` overrides the default port; it must match
 * the one the app was built with.
 */

/** Kept equal to `packages/app/renderer.ts` (`tests/app-cdp.test.ts`). */
export const CDP_PORT_ENV = "HERMETIC_CDP_PORT";
export const DEFAULT_CDP_PORT = 9333;

interface Target {
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
}

class Cdp {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly listeners = new Set<(event: CdpEvent) => void>();

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (message) => {
      const data = JSON.parse(String(message.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
      };
      if (data.id !== undefined) {
        const waiter = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.error) waiter?.reject(new Error(data.error.message));
        else waiter?.resolve(data.result);
      } else if (data.method !== undefined) {
        for (const listener of this.listeners)
          listener({ method: data.method, params: data.params ?? {} });
      }
    };
  }

  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`could not open ${url}`));
    });
    return new Cdp(ws);
  }

  call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(listener: (event: CdpEvent) => void): void {
    this.listeners.add(listener);
  }

  close(): void {
    this.ws.close();
  }
}

/** `--port`, then the environment, then the default. */
export function resolvePort(args: string[], env: Record<string, string | undefined>): number {
  const flag = args.indexOf("--port");
  const raw = flag >= 0 ? args[flag + 1] : env[CDP_PORT_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_CDP_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: "${raw}"`);
  return port;
}

async function pageTargets(port: number): Promise<Target[]> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/list`);
  } catch {
    throw new Error(
      `no DevTools endpoint on 127.0.0.1:${port}. Is a dev build running (\`bun run dev:fixture\`), ` +
        "with the CEF renderer (the dev default; not HERMETIC_RENDERER=native)?",
    );
  }
  const targets = (await response.json()) as Target[];
  return targets.filter((t) => t.type === "page");
}

interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  childIds?: string[];
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
}

/** Roles that add nesting but no meaning; their children are lifted. */
const TRANSPARENT_ROLES = new Set(["generic", "none", "presentation", "InlineTextBox", "LineBreak"]);

/** States worth a bracket after the name. */
const SHOWN_STATES = ["checked", "pressed", "selected", "expanded", "disabled", "focused"];

/**
 * The full accessibility tree as an indented outline — `role "name" [state]`,
 * one node per line — with ignored and purely structural nodes folded away.
 */
export function formatAxTree(nodes: AxNode[]): string {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const childIds = new Set(nodes.flatMap((n) => n.childIds ?? []));
  const roots = nodes.filter((n) => !childIds.has(n.nodeId));
  const lines: string[] = [];

  // `named`: the nearest shown ancestor has a name. Its text children only
  // repeat that name piece by piece, so they are folded away.
  const visit = (node: AxNode, depth: number, named: boolean): void => {
    const role = node.role?.value ?? "";
    const name = (node.name?.value ?? "").replace(/\s+/g, " ").trim();
    const shown =
      !node.ignored &&
      !TRANSPARENT_ROLES.has(role) &&
      !(role === "StaticText" && (name === "" || named));
    if (shown) {
      const states = (node.properties ?? [])
        .filter(
          (p) =>
            SHOWN_STATES.includes(p.name) && p.value?.value !== false && p.value?.value !== "false",
        )
        .map((p) =>
          p.value?.value === true || p.value?.value === "true"
            ? p.name
            : `${p.name}=${String(p.value?.value)}`,
        );
      const value = node.value?.value;
      const parts = [role === "StaticText" ? "text" : role];
      if (name !== "") parts.push(JSON.stringify(name));
      if (value !== undefined && value !== "" && value !== name)
        parts.push(`= ${JSON.stringify(value)}`);
      if (states.length > 0) parts.push(`[${states.join(", ")}]`);
      lines.push(`${"  ".repeat(depth)}${parts.join(" ")}`);
    }
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) {
        const childNamed = shown ? name !== "" && role !== "RootWebArea" : named;
        visit(child, shown ? depth + 1 : depth, childNamed);
      }
    }
  };
  for (const root of roots) visit(root, 0, false);
  return lines.join("\n");
}

const UNSAFE_CHARS: Record<string, string> = {
  "<": "\\u003C",
  ">": "\\u003E",
  "/": "\\u002F",
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\0": "\\0",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/**
 * A string as a JavaScript string literal safe to splice into evaluated code:
 * JSON, with the characters JSON leaves bare (`<`, `>`, `/`, the line
 * separators) escaped too.
 */
export function jsStringLiteral(value: string): string {
  return JSON.stringify(value).replace(/[<>/\b\f\n\r\t\0\u2028\u2029]/g, (c) => UNSAFE_CHARS[c] ?? c);
}

/**
 * The page-side lookup for a <target>, as an expression yielding an Element
 * or null. Serialised as a string literal so the selector or text never needs
 * escaping.
 */
export function findExpression(target: string): string {
  if (!target.startsWith("text=")) return `document.querySelector(${jsStringLiteral(target)})`;
  const text = jsStringLiteral(target.slice("text=".length).trim());
  return `(() => {
    const want = ${text};
    const candidates = [...document.querySelectorAll('button, a, [role], summary, label, input[type="button"], input[type="submit"]')];
    const norm = (s) => (s ?? "").replace(/\\s+/g, " ").trim();
    const names = (el) => [el.getAttribute("aria-label"), el.textContent, el.innerText, el.value].map(norm);
    return candidates.find((el) => names(el).includes(want))
      ?? candidates.find((el) => names(el).some((n) => n.toLowerCase() === want.toLowerCase()))
      ?? null;
  })()`;
}

async function evaluate(cdp: Cdp, expression: string): Promise<unknown> {
  const result = await cdp.call<{
    result: { value?: unknown; description?: string; type: string };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return "value" in result.result ? result.result.value : result.result.description;
}

async function centre(cdp: Cdp, target: string): Promise<{ x: number; y: number }> {
  const point = (await evaluate(
    cdp,
    `(() => {
      const el = ${findExpression(target)};
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
  )) as { x: number; y: number } | null;
  if (point === null) throw new Error(`no element matches ${target}`);
  return point;
}

const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
};

async function press(cdp: Cdp, name: string): Promise<void> {
  const key = KEYS[name];
  if (key === undefined)
    throw new Error(`unknown key "${name}" (one of ${Object.keys(KEYS).join(", ")})`);
  const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode };
  await cdp.call("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...base,
    ...(key.text ? { text: key.text } : {}),
  });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

function remoteObjectText(arg: { value?: unknown; description?: string; type: string }): string {
  if (arg.value !== undefined)
    return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  return arg.description ?? arg.type;
}

async function run(command: string, rest: string[], cdp: Cdp): Promise<void> {
  switch (command) {
    case "snapshot": {
      const { nodes } = await cdp.call<{ nodes: AxNode[] }>("Accessibility.getFullAXTree");
      console.log(formatAxTree(nodes));
      return;
    }
    case "text": {
      const selector = rest[0] ?? "body";
      console.log(await evaluate(cdp, `${findExpression(selector)}?.innerText ?? null`));
      return;
    }
    case "eval": {
      if (rest.length === 0) throw new Error("eval needs an expression");
      const value = await evaluate(cdp, rest.join(" "));
      console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
      return;
    }
    case "click": {
      if (rest[0] === undefined) throw new Error("click needs a target");
      const { x, y } = await centre(cdp, rest[0]);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await cdp.call("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
      console.log(`clicked ${rest[0]} at ${Math.round(x)},${Math.round(y)}`);
      return;
    }
    case "fill": {
      const [selector, ...words] = rest;
      if (selector === undefined || words.length === 0) throw new Error("fill needs a target and text");
      const focused = await evaluate(
        cdp,
        `(() => { const el = ${findExpression(selector)}; if (!el) return false; el.focus(); el.select?.(); return true; })()`,
      );
      if (focused !== true) throw new Error(`no element matches ${selector}`);
      await cdp.call("Input.insertText", { text: words.join(" ") });
      return;
    }
    case "press": {
      if (rest[0] === undefined) throw new Error("press needs a key");
      await press(cdp, rest[0]);
      return;
    }
    case "wait": {
      if (rest[0] === undefined) throw new Error("wait needs a target");
      const deadline = Date.now() + Number(rest[1] ?? 10_000);
      while ((await evaluate(cdp, `${findExpression(rest[0])} !== null`)) !== true) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${rest[0]}`);
        await Bun.sleep(100);
      }
      return;
    }
    case "screenshot": {
      const path = rest[0] ?? "app-screenshot.png";
      const { data } = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" });
      await Bun.write(path, Buffer.from(data, "base64"));
      console.log(path);
      return;
    }
    case "console": {
      const seconds = Number(rest[0] ?? 10);
      cdp.on((event) => {
        if (event.method === "Runtime.consoleAPICalled") {
          const args = (event.params["args"] ?? []) as Array<{
            value?: unknown;
            description?: string;
            type: string;
          }>;
          console.log(`[${String(event.params["type"])}] ${args.map(remoteObjectText).join(" ")}`);
        } else if (event.method === "Runtime.exceptionThrown") {
          const details = event.params["exceptionDetails"] as {
            text: string;
            exception?: { description?: string };
          };
          console.log(`[exception] ${details.exception?.description ?? details.text}`);
        }
      });
      await cdp.call("Runtime.enable");
      await Bun.sleep(seconds * 1000);
      return;
    }
    case "reload": {
      await cdp.call("Page.reload");
      return;
    }
    default:
      throw new Error(`unknown command "${command}" (see the header of scripts/app-cdp.ts)`);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const portFlag = argv.indexOf("--port");
  const positional = portFlag >= 0 ? [...argv.slice(0, portFlag), ...argv.slice(portFlag + 2)] : argv;
  const [command, ...rest] = positional;
  if (command === undefined) {
    console.error(
      "usage: bun run app:cdp <targets|snapshot|text|eval|click|fill|press|wait|screenshot|console|reload> …",
    );
    process.exit(2);
  }
  try {
    const port = resolvePort(argv, process.env);
    const targets = await pageTargets(port);
    if (command === "targets") {
      for (const t of targets) console.log(`${t.url}\t${t.title}`);
      process.exit(0);
    }
    const target = targets[0];
    if (target === undefined) throw new Error(`no page target on 127.0.0.1:${port}`);
    const cdp = await Cdp.open(target.webSocketDebuggerUrl);
    try {
      await run(command, rest, cdp);
    } finally {
      cdp.close();
    }
  } catch (e: unknown) {
    console.error(`app:cdp: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
