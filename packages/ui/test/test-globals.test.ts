/**
 * The fence around this suite's process-global state.
 *
 * `bun test` runs every file of a run in one process, so a module-scope write
 * to a global with no restore is a write on every file evaluated after it —
 * and which file lands last is filesystem readdir order, which differs between
 * macOS and Linux. That is one bug class with two instances so far, and both
 * are fenced here.
 *
 * One owner for `document.hidden`, `document.visibilityState` and the
 * reduced-motion media query: `setup.ts`.
 *
 * `bun test` runs every file of a run in one process, so a module-scope
 * `Object.defineProperty(document, …)` with no restore is a patch on every file
 * evaluated after it. Fifteen files here did exactly that, in two incompatible
 * shapes — a permanent `{ value: true }` data property in ten of them, a getter
 * over a module-local flag in five — and a data property left behind by one
 * file silently replaced another file's getter, so that file's flag stopped
 * meaning anything. Which file lands last is filesystem readdir order, which
 * differs between macOS and Linux: green on a laptop, thirty-nine tests red on
 * CI.
 *
 * `setup.ts` now installs both properties once, as getters over one flag it
 * resets after every test, and exports `setPageHidden`/`flipPageHidden`
 * (re-exported from `dom.ts`) for suites that want a hidden page. This test is
 * the fence around that: no other file in `test/` may patch either property.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const OWNER = "setup.ts";
// Assembled rather than written out, so this file does not match its own needle.
const PATCHES = [
  ...["hidden", "visibilityState"].flatMap((property) => [
    `Object.${"defineProperty"}(document, "${property}"`,
    // Deleting the property is patching it: it takes `setup.ts`'s getter off
    // `document` and leaves happy-dom's own answer underneath, so every later
    // file's `setPageHidden` writes to a flag nothing reads. One suite did
    // exactly this in its `afterEach`.
    `${"deleteProperty"}(document, "${property}"`,
  ]),
  // Reduced motion is the same story with a different global: `setup.ts`
  // answers the motion query for the whole suite and `setReducedMotion` is how
  // a file changes the answer. Assigning `matchMedia` replaces that answer for
  // every file after it.
  `${"matchMedia"} =`,
];

/** Every file under `test/`, as a path relative to this one. */
function filesHere(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(HERE, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    out.push(join(entry.parentPath ?? HERE, entry.name).slice(HERE.length + 1));
  }
  return out;
}

describe("page visibility has one owner in this suite", () => {
  test(`only ${OWNER} patches document.hidden / visibilityState / matchMedia`, () => {
    const offenders: string[] = [];
    for (const rel of filesHere()) {
      if (rel === OWNER) continue;
      const text = readFileSync(join(HERE, rel), "utf8");
      for (const patch of PATCHES) if (text.includes(patch)) offenders.push(`${rel}: ${patch}…`);
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The fleet target: never at module scope.
 *
 * `setFleetTarget` writes module state in `src/api/client.ts` that outlives
 * the file that wrote it. Two fixture modules used to set it once, at module
 * scope, on the theory that once per process is enough — while
 * `api-narrow.test.ts` (which tests a window that knows no fleet) and
 * `flows/bridge.ts` both put it back to null on the way out. Whichever ran
 * last decided, and twenty-eight chat tests refused every read on Linux.
 *
 * So the rule is: set it from inside something that runs per test — a
 * `harness()`, a `fakeServer()`, a `beforeEach` — and never from a file's top
 * level. A top-level statement is the only unindented call there is, which is
 * what this matches: an indented one is inside a function or a hook by
 * construction, and that is exactly the distinction the rule is about. The
 * import line itself is not a call and does not match.
 */
describe("the fleet target is never set at module scope", () => {
  test("every setFleetTarget call sits inside a function or a hook", () => {
    const needle = `${"setFleetTarget"}(`;
    const offenders: string[] = [];
    for (const rel of filesHere()) {
      const lines = readFileSync(join(HERE, rel), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.startsWith(needle)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
