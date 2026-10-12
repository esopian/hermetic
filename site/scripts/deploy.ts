// Builds and deploys site/ to Cloudflare Pages, then checks that the deployment actually serves
// this build. The one deploy path: run by hand from a laptop and by .github/workflows/site.yml.
//
//   bun run deploy                         preview deploy, branch named after the current git branch
//   bun run deploy --branch review-cost    preview deploy to a named branch
//   bun run deploy --production            production (the project's production branch); asks first
//   bun run deploy --production --yes      production without the prompt (CI)
//
// Order: preflight (git state, release tag, Cloudflare credentials, project), check and build,
// inspect dist/, deploy with wrangler, verify the deployment over HTTP. Any failure stops the run
// with a non-zero exit and says what to do next. Nothing is uploaded before every preflight check
// and the build have passed.
//
// Production refuses a dirty working tree and a HEAD that no `v*` release tag points at (the site
// follows releases; site/AGENTS.md "Deploy"). `--allow-untagged` relaxes the tag rule for a
// deliberate docs-only redeploy; nothing relaxes the clean-tree rule for production.
//
// Credentials: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID when set (CI), else whatever
// `wrangler login` stored. The token is never printed or passed on a command line.

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

const SITE = dirname(import.meta.dir);
const ROOT = dirname(SITE);
const DIST = join(SITE, "dist");
const PRODUCTION_BRANCH = process.env["CLOUDFLARE_PRODUCTION_BRANCH"] ?? "main";
const env = process.env;
const CI = env["CI"] === "true" || env["GITHUB_ACTIONS"] === "true";
const GHA = env["GITHUB_ACTIONS"] === "true";

/* ------------------------------------------------------------------ terminal */

const color = !("NO_COLOR" in env) && (process.stdout.isTTY === true || GHA || "FORCE_COLOR" in env);
const paint =
  (code: string) =>
  (s: string): string =>
    color ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = paint("1");
const dim = paint("2");
const red = paint("31");
const green = paint("32");
const yellow = paint("33");
const orange = paint("38;5;208");

const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

class DeployError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/** Runs one named step: a header, then ✓ or ✗ with its duration. A throw stops the deploy. */
async function step<T>(title: string, run: () => Promise<T> | T): Promise<T> {
  const started = Date.now();
  out(`${orange("▸")} ${bold(title)}`);
  try {
    const result = await run();
    out(`${green("✓")} ${title} ${dim(secs(Date.now() - started))}`);
    return result;
  } catch (err) {
    out(`${red("✗")} ${title} ${dim(secs(Date.now() - started))}`);
    throw err;
  }
}

const note = (line: string): void => out(`  ${dim(line)}`);
const warn = (line: string): void => {
  out(`  ${yellow("!")} ${line}`);
  if (GHA) out(`::warning::${line}`);
};

/** Streams a child process's output, indented, inside a collapsible group on GitHub Actions. */
function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (GHA) out(`::group::${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const relay = (chunk: Buffer): void => {
      for (const line of chunk.toString().split("\n"))
        if (line.length > 0) out(`    ${dim("│")} ${line}`);
    };
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    child.on("error", reject);
    child.on("close", (code) => {
      if (GHA) out("::endgroup::");
      if (code === 0) resolve();
      else reject(new DeployError(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

/** Runs a command and returns its trimmed stdout, or null when it fails. */
function read(cmd: string, args: string[], cwd = ROOT): string | null {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ arguments */

const { values: args } = parseArgs({
  options: {
    production: { type: "boolean", default: false },
    branch: { type: "string" },
    project: { type: "string" },
    yes: { type: "boolean", short: "y", default: false },
    "skip-check": { type: "boolean", default: false },
    "allow-dirty": { type: "boolean", default: false },
    "allow-untagged": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    verify: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (args.help) {
  out(`${bold("bun run deploy")} [options]   build site/ and deploy it to Cloudflare Pages

  --production        deploy to the production branch (${PRODUCTION_BRANCH}); needs a clean tree and a v* tag at HEAD
  --branch <name>     preview branch name (default: the current git branch)
  --project <name>    Pages project (default: $CLOUDFLARE_PAGES_PROJECT, else wrangler.toml)
  -y, --yes           do not ask before a production deploy (required without a terminal)
  --skip-check        build without running \`bun run check\` first
  --allow-dirty       preview only: deploy a working tree with uncommitted changes
  --allow-untagged    production only: deploy a commit no v* tag points at
  --dry-run           run every check and the build, upload nothing
  --verify <url>      only run the HTTP checks against <url>, expecting HEAD's build
  -h, --help          this text`);
  process.exit(0);
}

/* ------------------------------------------------------------------ preflight */

interface Plan {
  production: boolean;
  project: string;
  branch: string;
  commit: string;
  short: string;
  subject: string;
  dirty: boolean;
  tag: string | null;
  productionUrl: string;
}

function projectName(): string {
  if (args.project !== undefined) return args.project;
  const fromEnv = env["CLOUDFLARE_PAGES_PROJECT"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const toml = readFileSync(join(SITE, "wrangler.toml"), "utf8");
  const name = toml.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  if (name === undefined) throw new DeployError("no Pages project: wrangler.toml has no name");
  return name;
}

/** Cloudflare's own branch alias rules: lowercase, [a-z0-9-], at most 28 characters. */
const alias = (branch: string): string =>
  branch
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28)
    .replace(/-+$/, "");

function gitState(): Pick<Plan, "commit" | "short" | "subject" | "dirty" | "tag"> & {
  gitBranch: string | null;
} {
  const commit = read("git", ["rev-parse", "HEAD"]);
  if (commit === null)
    throw new DeployError("not inside a git checkout", "deploy from a clone of the repository");
  const status = read("git", ["status", "--porcelain"]) ?? "";
  // The tag the workflow passes wins; on a laptop, any v* tag pointing at HEAD.
  const wanted = env["HERMETIC_RELEASE_TAG"];
  let tag: string | null = null;
  if (wanted !== undefined && wanted.length > 0) {
    const target = read("git", ["rev-parse", `${wanted}^{commit}`]);
    if (target === commit) tag = wanted;
  } else {
    const tags = (read("git", ["tag", "--points-at", "HEAD", "--list", "v*"]) ?? "")
      .split("\n")
      .filter(Boolean);
    tag = tags.sort().at(-1) ?? null;
  }
  const head = read("git", ["symbolic-ref", "--short", "-q", "HEAD"]);
  return {
    commit,
    short: commit.slice(0, 7),
    subject: read("git", ["log", "-1", "--pretty=%s"]) ?? "",
    dirty: status.length > 0,
    tag,
    gitBranch: head,
  };
}

async function preflight(): Promise<Plan> {
  return step("Preflight", async () => {
    const git = gitState();
    const project = projectName();
    const production = args.production;

    if (production && args.branch !== undefined && args.branch !== PRODUCTION_BRANCH) {
      throw new DeployError(
        `--production deploys to ${PRODUCTION_BRANCH}; drop --branch ${args.branch}`,
      );
    }
    const branch = production
      ? PRODUCTION_BRANCH
      : (args.branch ?? git.gitBranch ?? `preview-${git.short}`);
    if (!production && alias(branch) === alias(PRODUCTION_BRANCH)) {
      throw new DeployError(
        `branch "${branch}" is the production branch`,
        "use --production to deploy production, or pick another --branch for a preview",
      );
    }
    if (alias(branch).length === 0)
      throw new DeployError(`branch "${branch}" has no usable characters`);

    if (git.dirty) {
      if (production) {
        throw new DeployError(
          "the working tree has uncommitted changes",
          "production deploys only a committed tree: commit or stash, then run again",
        );
      }
      if (!args["allow-dirty"]) {
        throw new DeployError(
          "the working tree has uncommitted changes",
          "commit them, or pass --allow-dirty to preview exactly what is on disk",
        );
      }
      warn("deploying uncommitted changes (--allow-dirty); the deployment will be marked dirty");
    }

    if (production && git.tag === null) {
      const wanted = env["HERMETIC_RELEASE_TAG"];
      const why =
        wanted !== undefined && wanted.length > 0
          ? `HERMETIC_RELEASE_TAG=${wanted} does not point at HEAD (${git.short})`
          : `no v* tag points at HEAD (${git.short})`;
      if (!args["allow-untagged"]) {
        throw new DeployError(
          why,
          "production follows releases: check out the release tag, or pass --allow-untagged",
        );
      }
      warn(`${why}; deploying anyway (--allow-untagged)`);
    }
    if (git.tag !== null) {
      const pkg: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
      const version =
        typeof pkg === "object" && pkg !== null && "version" in pkg ? String(pkg.version) : "";
      if (git.tag !== `v${version}`)
        warn(`tag ${git.tag} differs from package.json version ${version}`);
    }

    const productionUrl = (env["HERMETIC_SITE_URL"] || `https://${project}.pages.dev`).replace(
      /\/$/,
      "",
    );
    note(`project   ${project}`);
    note(
      `target    ${production ? orange(`production (${PRODUCTION_BRANCH})`) : `preview (${branch})`}`,
    );
    note(`commit    ${git.short} ${git.subject}${git.dirty ? yellow(" + uncommitted changes") : ""}`);
    note(`release   ${git.tag ?? "none"}`);
    return { production, project, branch, productionUrl, ...git };
  });
}

/** Proves Cloudflare will accept this deploy before anything is built or uploaded. */
async function credentials(plan: Plan): Promise<void> {
  await step("Cloudflare credentials", async () => {
    const token = env["CLOUDFLARE_API_TOKEN"];
    if (CI && (token === undefined || token.length === 0)) {
      throw new DeployError(
        "CLOUDFLARE_API_TOKEN is not set",
        "CI deploys need the site-production environment secrets",
      );
    }
    if (CI && (env["CLOUDFLARE_ACCOUNT_ID"] ?? "").length === 0) {
      throw new DeployError(
        "CLOUDFLARE_ACCOUNT_ID is not set",
        "CI deploys need the site-production environment secrets",
      );
    }
    if (token === undefined) {
      const who = read("bunx", ["wrangler", "whoami"], SITE);
      if (who === null || /not authenticated/i.test(who)) {
        throw new DeployError(
          "wrangler is not logged in",
          "run `bunx wrangler login` in site/, then deploy again",
        );
      }
      const email = who.match(/associated with the email ([^\s.]+@[^\s]+?)\.?\s/)?.[1];
      note(`signed in${email !== undefined ? ` as ${email}` : ""}`);
    } else {
      note("using CLOUDFLARE_API_TOKEN");
    }
    // Listing deployments needs the same Pages permission a deploy does, and fails on a missing
    // project, so it catches a wrong token scope or a typo in the project name before the build.
    const listed = read(
      "bunx",
      ["wrangler", "pages", "deployment", "list", "--project-name", plan.project],
      SITE,
    );
    if (listed === null) {
      throw new DeployError(
        `cannot read Pages project "${plan.project}"`,
        'check the project name and that the token has Cloudflare Pages: Edit (site/README.md "Deploy setup")',
      );
    }
    note(`project ${plan.project} is reachable`);
  });
}

async function confirm(plan: Plan): Promise<void> {
  if (!plan.production || args.yes || args["dry-run"]) return;
  if (!process.stdin.isTTY) {
    throw new DeployError(
      "a production deploy needs confirmation",
      "pass --yes when there is no terminal to ask",
    );
  }
  out();
  out(
    `  ${orange("●")} This replaces ${bold(plan.productionUrl)} with ${bold(plan.tag ?? plan.short)}.`,
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`  Type the project name (${plan.project}) to continue: `);
  rl.close();
  if (answer.trim() !== plan.project) throw new DeployError("not confirmed; nothing was deployed");
  out();
}

/* ------------------------------------------------------------------ build */

/** Files every good build has; a missing one means the build or sync step went wrong. */
const REQUIRED = [
  "index.html",
  "404.html",
  "_headers",
  "_redirects",
  "install.sh",
  "favicon.svg",
  "docs/index.html",
  "explainer/index.html",
  "explainer/engine.js",
  "cost/index.html",
];

/** The footer stamp the landing page prints (src/components/Footer.astro, src/data/release.ts). */
const STAMP = /built from <span[^>]*>([0-9a-f]{7}|unknown)<\/span>/;

async function build(plan: Plan): Promise<void> {
  const buildEnv: NodeJS.ProcessEnv = { ...env, HERMETIC_BUILD_SHA: plan.commit };
  if (plan.tag !== null) buildEnv["HERMETIC_RELEASE_TAG"] = plan.tag;
  if (!args["skip-check"]) {
    await step("Check (bun run check)", () =>
      run("bun", ["run", "check"], { cwd: SITE, env: buildEnv }),
    );
  }
  await step("Build (bun run build)", async () => {
    rmSync(DIST, { recursive: true, force: true });
    await run("bun", ["run", "build"], { cwd: SITE, env: buildEnv });
  });
  await step("Inspect dist/", () => {
    const missing = REQUIRED.filter((f) => !existsSync(join(DIST, f)));
    if (missing.length > 0) throw new DeployError(`dist/ is missing ${missing.join(", ")}`);
    const stamp = readFileSync(join(DIST, "index.html"), "utf8").match(STAMP)?.[1];
    if (stamp !== plan.short) {
      throw new DeployError(
        `dist/index.html says it was built from ${stamp ?? "nothing"}, expected ${plan.short}`,
      );
    }
    note(`${REQUIRED.length} required files present, stamped ${plan.short}`);
  });
}

/* ------------------------------------------------------------------ deploy */

interface Deployment {
  id: string;
  url: string;
  alias: string | null;
  environment: string;
}

async function deploy(plan: Plan): Promise<Deployment> {
  return step("Deploy (wrangler pages deploy)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hermetic-deploy-"));
    const outputFile = join(dir, "wrangler-output.ndjson");
    try {
      const wranglerArgs = [
        "wrangler",
        "pages",
        "deploy",
        "dist",
        "--project-name",
        plan.project,
        "--branch",
        plan.branch,
        "--commit-hash",
        plan.commit,
        "--commit-message",
        plan.subject.slice(0, 380),
      ];
      if (plan.dirty) wranglerArgs.push("--commit-dirty=true");
      await run("bunx", wranglerArgs, {
        cwd: SITE,
        env: { ...env, WRANGLER_OUTPUT_FILE_PATH: outputFile },
      });

      // Wrangler's machine-readable record of what it did; the printed text is for humans.
      const entries = existsSync(outputFile)
        ? readFileSync(outputFile, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l): unknown => JSON.parse(l))
        : [];
      const detail = entries.find(
        (e): e is Record<string, unknown> =>
          typeof e === "object" &&
          e !== null &&
          (e as Record<string, unknown>)["type"] === "pages-deploy-detailed",
      );
      if (detail === undefined) throw new DeployError("wrangler reported no deployment");
      const deployment: Deployment = {
        id: String(detail["deployment_id"] ?? ""),
        url: String(detail["url"] ?? "").replace(/\/$/, ""),
        alias: typeof detail["alias"] === "string" ? detail["alias"].replace(/\/$/, "") : null,
        environment: String(detail["environment"] ?? ""),
      };
      const expected = plan.production ? "production" : "preview";
      if (deployment.environment !== expected) {
        throw new DeployError(
          `Cloudflare made a ${deployment.environment} deployment, expected ${expected}`,
          `the project's production branch may not be "${PRODUCTION_BRANCH}" (set CLOUDFLARE_PRODUCTION_BRANCH)`,
        );
      }
      note(`deployment ${deployment.id} (${deployment.environment})`);
      return deployment;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/* ------------------------------------------------------------------ verify */

interface Check {
  path: string;
  /** Returns a problem, or null when the response is right. */
  test: (res: Response, body: string) => string | null;
}

const CHECKS = (short: string): Check[] => [
  {
    path: "/",
    test: (res, body) => {
      if (res.status !== 200) return `HTTP ${res.status}`;
      const stamp = body.match(STAMP)?.[1];
      if (stamp !== short) return `serves build ${stamp ?? "unknown"}, expected ${short}`;
      if (!res.headers.get("content-security-policy"))
        return "no Content-Security-Policy (_headers not applied)";
      return null;
    },
  },
  { path: "/docs/", test: (res) => (res.status === 200 ? null : `HTTP ${res.status}`) },
  { path: "/explainer/", test: (res) => (res.status === 200 ? null : `HTTP ${res.status}`) },
  { path: "/explainer/engine.js", test: (res) => (res.status === 200 ? null : `HTTP ${res.status}`) },
  { path: "/cost/", test: (res) => (res.status === 200 ? null : `HTTP ${res.status}`) },
  {
    path: "/install.sh",
    test: (res, body) => {
      if (res.status !== 200) return `HTTP ${res.status}`;
      if (!(res.headers.get("content-type") ?? "").startsWith("text/plain"))
        return "not served as text/plain";
      return body.startsWith("#!") ? null : "does not start with #!";
    },
  },
  {
    path: "/download",
    test: (res) => {
      const to = res.headers.get("location") ?? "";
      return res.status === 302 && to.includes("/releases/")
        ? null
        : `HTTP ${res.status} → ${to || "nowhere"}`;
    },
  },
];

async function probe(base: string, check: Check): Promise<string | null> {
  try {
    const res = await fetch(`${base}${check.path}`, {
      redirect: "manual",
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(15_000),
    });
    const body = res.status === 200 ? await res.text() : "";
    return check.test(res, body);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Polls every check against one URL until all pass or the deadline passes; edges take a moment. */
async function verify(
  label: string,
  base: string,
  short: string,
  budgetMs: number,
  hint = `the upload finished; open ${base} and the Cloudflare dashboard to see what is live`,
): Promise<void> {
  await step(`Verify ${label} ${dim(base)}`, async () => {
    const deadline = Date.now() + budgetMs;
    let failing: Array<[string, string]> = [];
    for (let attempt = 1; ; attempt++) {
      const results = await Promise.all(
        CHECKS(short).map(async (c) => [c.path, await probe(base, c)] as const),
      );
      failing = results.filter((r): r is [string, string] => r[1] !== null);
      if (failing.length === 0) {
        for (const [path] of results) note(`${green("ok")}  ${path}`);
        return;
      }
      if (Date.now() + 5_000 > deadline) break;
      note(`attempt ${attempt}: ${failing.length} of ${results.length} not ready yet, retrying in 5s`);
      await Bun.sleep(5_000);
    }
    for (const [path, problem] of failing) note(`${red("fail")} ${path}: ${problem}`);
    throw new DeployError(`${label} is not serving this build correctly`, hint);
  });
}

/* ------------------------------------------------------------------ main */

function summary(plan: Plan, d: Deployment, startedAt: number): void {
  const live = plan.production ? plan.productionUrl : (d.alias ?? d.url);
  out();
  out(
    `${green("●")} ${bold(plan.production ? "Production is live" : "Preview is live")} ${dim(secs(Date.now() - startedAt))}`,
  );
  out(`  ${bold(live)}`);
  if (live !== d.url) out(`  ${dim(`this deployment: ${d.url}`)}`);
  out(
    `  ${dim(`commit ${plan.short}${plan.tag !== null ? ` · ${plan.tag}` : ""} · deployment ${d.id}`)}`,
  );
  const file = env["GITHUB_STEP_SUMMARY"];
  if (file !== undefined && file.length > 0) {
    const md = [
      `### Site deployed: ${plan.production ? "production" : `preview (${plan.branch})`}`,
      "",
      `| | |`,
      `|---|---|`,
      `| URL | ${live} |`,
      `| Deployment | ${d.url} |`,
      `| Commit | \`${plan.short}\`${plan.tag !== null ? ` (${plan.tag})` : ""} |`,
      `| Checks | ${CHECKS(plan.short).length} paths verified |`,
      "",
    ].join("\n");
    appendFileSync(file, md);
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  if (args.verify !== undefined) {
    const short = read("git", ["rev-parse", "--short=7", "HEAD"]) ?? "unknown";
    out(`${orange("■")} ${bold("hermetic site verify")}`);
    out();
    await verify(
      "site",
      args.verify.replace(/\/$/, ""),
      short,
      30_000,
      `${args.verify} is not serving ${short}`,
    );
    out();
    out(`${green("●")} ${bold("Serving")} ${short}`);
    return;
  }
  out(
    `${orange("■")} ${bold("hermetic site deploy")}${args["dry-run"] ? yellow("  (dry run: nothing is uploaded)") : ""}`,
  );
  out();
  const plan = await preflight();
  if (!args["dry-run"]) await credentials(plan);
  await confirm(plan);
  await build(plan);
  if (args["dry-run"]) {
    out();
    out(`${green("●")} ${bold("Dry run passed")}: dist/ is ready; nothing was uploaded.`);
    return;
  }
  const deployment = await deploy(plan);
  await verify("deployment", deployment.url, plan.short, 90_000);
  if (plan.production) await verify("production", plan.productionUrl, plan.short, 180_000);
  else if (deployment.alias !== null)
    await verify("branch alias", deployment.alias, plan.short, 90_000);
  summary(plan, deployment, startedAt);
}

try {
  await main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  out();
  out(`${red("●")} ${bold("Deploy failed:")} ${message}`);
  if (err instanceof DeployError && err.hint !== undefined) out(`  ${err.hint}`);
  if (GHA) out(`::error title=Site deploy failed::${message}`);
  process.exit(1);
}
