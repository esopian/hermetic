/**
 * The CLI under test, compiled once and spawned many times.
 *
 * These suites are end-to-end by design (§11.6): the contract is what a real
 * process writes to stdout, to stderr and to its exit code, so they spawn the
 * head rather than calling into it. That made every test pay to transpile the
 * whole CLI-plus-core import graph again — ~280ms of the ~300ms a `hermetic
 * agent ps` test took, times the two hundred-odd spawns in this package.
 *
 * `bun build --compile` does that work once, in about as long as three spawns
 * used to take, and every test after it starts a binary that is already
 * machine code (~180ms, most of it process setup). It is also *closer* to what
 * ships: `bun run build` compiles this same entry point into `dist/hermetic`,
 * so the thing under test is now the thing an operator runs, rather than a
 * source tree run by a development bun.
 *
 * One build per test process, shared by every suite in the package: the
 * promise is the lock, so the twenty concurrent tests Bun may have in flight
 * all await the same compile instead of racing twenty of them.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = Bun.fileURLToPath(new URL("../src/main.ts", import.meta.url));
/**
 * Inside the per-process home `tests/preload.ts` makes and removes at the end
 * of the run. The binary is ~60 MB, and a module-level `process.on("exit")`
 * does not fire at the end of a `bun test` run, so a directory of its own under
 * `tmpdir()` was left behind by every run. The fallback is for a run without
 * the preload, which has already given up on cleaning up after itself.
 */
const OUT = join(
  process.env["HERMETIC_HOME"] ?? mkdtempSync(join(tmpdir(), "hermetic-cli-binary-")),
  "cli-binary",
  "hermetic",
);

let building: Promise<string> | undefined;

/** The compiled CLI's path, compiling it on the first call. */
export function cliBinary(): Promise<string> {
  building ??= compile();
  return building;
}

async function compile(): Promise<string> {
  const proc = Bun.spawn([process.execPath, "build", "--compile", ENTRY, "--outfile", OUT], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // A failed compile must name itself here rather than surfacing as every test
  // in the package failing to spawn a file that is not there.
  if (code !== 0) throw new Error(`compiling the CLI under test failed:\n${stdout}${stderr}`);
  return OUT;
}

/**
 * Materialise a fresh fixture home before concurrent tests share it.
 *
 * The first open of a fixture home writes its two fleets and then the default
 * (`seedFixtureFleets`, `packages/core/src/open.ts`), with no lock between the
 * "is it empty" read and the writes. Concurrent first spawns race it: one sees
 * the fleets another has half-written and reads a home with no default. One
 * read before the suite starts is the fixture's equivalent of having run
 * `init`, and every concurrent spawn after it finds the home settled.
 */
export async function seedFixtureHome(home: string): Promise<void> {
  const proc = Bun.spawn([await cliBinary(), "fleet", "ls", "--json"], {
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, HERMETIC_FIXTURE: "1", HERMETIC_NO_TTY: "1", HERMETIC_HOME: home },
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`seeding the fixture home ${home} failed:\n${stderr}`);
}
