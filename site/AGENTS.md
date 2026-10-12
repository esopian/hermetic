# site — agent instructions

`site/` is the marketing and docs site for hermetic (Astro + Starlight, deployed to Cloudflare
Pages). It is its own toolchain, separate from everything under `packages/` — see the repo root
`AGENTS.md` "Layout". This file is
`site/`'s equivalent of the root `AGENTS.md`; the root files still apply to everything
else in the repo, but do not describe this directory.

## Audience

The site is for people running hermetic, not people working on it. Keep developer material out:
no fixture mode, no `--fixture`/`HERMETIC_FIXTURE`, no `bun run …` scripts, no checkout setup.
That lives in the repo's `README.md` and `CONTRIBUTING.md`; the site links to them on GitHub.
`scripts/sync-docs.ts` syncs only `docs/operations.md` and drops dev-only sentences
(`stripDevNotes`), and `scripts/cli-reference.ts` filters `--fixture` out of the help text.

One exception: the explainer's "Inside the code" path (`public/explainer/path-contrib.js`) is for
contributors and may show fixture mode and `bun run` scripts. It is labelled for contributors on
every card that links to it, and only the explainer's own picker and cards lead to it.

## Toolchain

Own `package.json`, `bun.lock`, `tsconfig.json`, `biome.jsonc`. Never run `bun install` here from
the root install — it has no effect on `site/`.

```
cd site
bun install
bun run dev        # astro dev
bun run check       # sync + astro check + biome check + sync-docs --check
bun run build       # sync + astro build -> site/dist
bun run preview     # wrangler pages dev dist — the real Cloudflare runtime, incl. _headers/_redirects
bun run deploy      # check, build, deploy a preview to Cloudflare Pages, verify it (see Deploy)
```

The root `package.json` has pass-throughs (`site:dev`, `site:build`, `site:check`, `site:deploy`)
that just `cd site && bun run <script>` — convenience only, not a substitute for running the above from `site/`
when iterating.

## Import boundary

Never import from `packages/` or `@hermetic/*`. The site reads repository *files* at build time
(`docs/*.md`, root `package.json`'s version) and *spawns* the CLI as a subprocess
(`site/scripts/cli-reference.ts` runs `bun ../packages/cli/src/main.ts --help`) — it never imports
core, cli, app or ui source. This keeps `site/` outside the import-boundary matrix in the root
`AGENTS.md` entirely; do not add an import that would put it in scope for that matrix.

## Design system

Dark only — no light theme, no toggle. `src/styles/tokens.css` is the dark token set from
`docs/ui-brief.md` ("Look", the `dark :` line), copied verbatim; `tests/site-tokens.test.ts` at
the repo root fails if the two drift, so change them together and never hand-edit one without the
other. Zero border-radius everywhere; borders are the structure (see `docs/ui-brief.md`), carried
over here the same way.

**Mobile is in scope here**, unlike the app (root `AGENTS.md`: "Mobile is out of scope" is an app-only
rule). Breakpoints at 1080px and 640px; no horizontal page scroll at any width.

No third-party requests at render time: fonts are self-hosted via `@fontsource*`, no analytics, no
external script or stylesheet tag. `public/_headers` carries the CSP that enforces this — a new
external asset needs a CSP change reviewed alongside it, not a silent addition.

## Product claims

Every claim about what hermetic does or guarantees traces to a `docs/design.md` section, named in a
comment beside the claim in source (e.g. `<!-- §5.1 IAM-only, zero inbound ports -->`). When
`docs/design.md` changes, re-check the claims it grounds.

## Docs content

`docs/` in the repo root stays the source of truth. `site/scripts/sync-docs.ts` copies selected
repo docs into the git-ignored `src/content/docs/_synced/` at build time (`bun run sync`, part of
`build`/`check`) — edit the source doc under `docs/`, never the synced copy, which is regenerated
and not committed. The CLI reference (`reference/cli.mdx`) is generated the same way by
`site/scripts/cli-reference.ts`, from the real CLI's `--help` output.

## Landing page

`/` (`src/pages/index.astro`) is composed from `src/components/landing/`, in page order:

- `Blueprint.astro` / `BlueprintScene.astro` (geometry in `blueprint-geometry.ts`): the isometric
  drawing of one agent's machine with numbered callouts, then the zoom-out stages (fleet, your AWS
  account, your Mac over the tailnet). The drawing stays pinned while the captions scroll; "Next →"
  in its title bar steps through the stages and then on to the next section. `#how` is the first
  stage (the header's "How it works").
- `ZeroToAgent.astro`: one shared timeline played as a CLI session or as the app's screens, chosen
  up front ("Play in CLI" / "Play in App") and switchable mid-run without losing its place.
- `AppTour.astro`: five app screens, each with its CLI equivalent.
- `PowerStrip.astro`: the size ladder from `src/data/cost.ts`, linking to `/cost/`.
- `Closing.astro`, and `SheetHead.astro` for the drawing-title-block section heads.

Motion: every animation has a static frame. Under `prefers-reduced-motion`, on phones (640px and
below) and without JS, each stage renders as its own still drawing, "Next →" is hidden, and the
zero-to-agent session shows its finished state. Illustrative data (agent names, account ids,
timings) is fine; formats, commands, flags, stage names and prices must be real (§ comments, and
prices from `src/data/cost.ts`).

## Explainer

`/explainer/` is an animated walkthrough of hermetic in five paths (the big picture, working with
agents, standing up a fleet, inside the code, trust model and seals). The landing hero's "Learn how
it works" button, the header, the footer and the docs sidebar all link into it.

- `src/pages/explainer.astro`: the player's markup on the shared `layouts/Shell.astro` (fonts and
  tokens), plus `src/styles/explainer.css`, which adds only `--blue` and `--vio` to the tokens.
- `public/explainer/*.js`: the player, served as plain classic scripts, unbundled and in a fixed
  order (`SCRIPTS` in `src/data/explainer.ts`), because each file registers itself through the
  engine's globals. `engine.js` is the player: scenes (`scene()`), paths (`pathway()`), branch
  stops, per-path tallies, the landing cards and picker, glossary linking, progress in
  `localStorage`. Its header comment documents the scene markup (`data-b` reveal, `data-x` dim,
  `data-h` highlight). `lib-*.js` are scenes more than one path uses; a path re-narrates a shared
  scene through `overrides: { <id>: { beats } }` instead of copying it. `path-*.js` is one path
  each, plus the scenes only it uses (ids prefixed `ov-`, `use-`, `dep-`, `dev-`, `sec-`).
  `glossary.js` holds the shared terms; a path adds its own with `glossary({...})`.
- `PATHS` in `src/data/explainer.ts` mirrors each path's `pathway({ id, title, audience, minutes,
  tagline })` for the landing cards; `tests/site-explainer.test.ts` at the repo root fails if they
  drift, or if a script under `public/explainer/` is not loaded. Add a path in both places.
- The look is the landing's blueprint: each scene is a drawing sheet on grid paper with orange
  registration marks, under a title block (`DWG <path>-<nn>`, chapter, title, the path's tally,
  `SHEET n OF m`; the codes are `DWG_CODES` in `engine.js`). Shapes are hairline outlines over the
  paper colour, zone labels are filled tabs, big type is 900 uppercase, and wires draw themselves
  in. Restyle through the helpers and `explainer.css`, not per scene. Two opt-ins: `c: "iso"` on
  `bx()` or `icon()` draws a machine as the landing's isometric box (it needs about 16px clear above
  and to the right), and `dim()` draws a dimension line with end ticks.
- Arrows (`wire()`) carry a stream of square packets the way the arrowhead points, so an arrow must
  point the way data actually moves; `flow: false` marks a relation that is not a data flow.
- URLs deep-link as `/explainer/#<path>/<scene>/<beat>` (`#<path>` alone resumes that path);
  `?still` turns transitions and animation off for screenshots, as `prefers-reduced-motion` does:
  every element shows its final state and flows read as dotted lines.
- Narration follows `docs/design.md`, and each beat names the section or file it rests on in its
  reference chips, which is how the Product claims rule applies here. When the spec changes, the
  scene that describes it changes with it.
- The marketing copy style below covers the explainer's landing (headline, lede, picker, path
  cards). Narration and player chrome read like the docs and are held to the docs' standard.
- Runs on any width: the stage scales to fit, and below 640px the controls drop to two rows.

## Cost page

`/cost/` (`src/pages/cost.astro`) prints prices from `src/data/cost.ts`: the size table, gp3 per
GiB-month, a public IPv4 address per month and the default disk sizes, all us-east-1 on-demand list
prices that core also carries. `tests/site-cost.test.ts` at the repo root compares the two and
fails on drift, so a price or size change in core lands here in the same change. The page never
calls a pricing API and says so; the bill is whatever AWS says it is.

## Marketing copy style

No em dashes or en dashes. No "not X but Y" contrast construction. No forced rule-of-three lists,
except the one approved hero tagline. No hype words ("revolutionary", "seamless", "blazing",
"effortless", and the like). Headings in source are sentence case, not title case.

## Installer (`public/install.sh`)

Served at `/install.sh` for `curl -fsSL <site>/install.sh | bash`; the Quick start page renders
the command through `src/components/docs/InstallCommand.astro`, so it follows the site URL.

- Everything runs inside `main "$@"` on the last line, so a truncated download executes nothing.
- Never `sudo`. Fall back to `~/Applications` and `~/.local/bin` when the system paths are not
  writable, and say so.
- Replace only what is ours: an existing `Hermetic.app` must have bundle id `sh.hermetic.app`, an
  existing `hermetic` on PATH must already be a Hermetic shim.
- The shim must stay byte-for-byte what `packages/app/src/main/cli-install.ts` writes.
- Verify the DMG against the sha256 `digest` the GitHub release API publishes.
- Linted by the root `bun run lint:sh` (shellcheck, `-S warning`). Test end to end without a
  release: build a fake DMG with `hdiutil create` and run with `HERMETIC_DMG_FILE=<dmg>
  --app-dir <tmp> --bin-dir <tmp>`; `--dry-run` changes nothing.

## Deploy

`scripts/deploy.ts` is the only deploy path, for a laptop and for CI alike:

```
bun run deploy                          # preview, branch named after the current git branch
bun run deploy --branch review-cost     # preview to a named branch
bun run deploy --production             # production; asks you to type the project name
bun run deploy --dry-run                # every check and the build, nothing uploaded
bun run deploy --verify <url>           # only the HTTP checks, against any URL
```

It runs in order and stops at the first failure: preflight, Cloudflare credentials, check, build,
an inspection of `dist/`, `wrangler pages deploy`, then HTTP verification of the new deployment and
of the production URL (or the preview's branch alias). Nothing is uploaded until every check before
it has passed.

- Production refuses a dirty working tree, always, and a HEAD that no `v*` tag points at (or that
  `HERMETIC_RELEASE_TAG` does not name) unless `--allow-untagged`. It asks before deploying; `--yes`
  skips the question and is required without a terminal. A preview refuses the production branch
  name and needs `--allow-dirty` to upload uncommitted work.
- Credentials: `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` when set, else `bunx wrangler login`.
  Listing the project's deployments proves the token and the project name before the build.
- The build is stamped with the commit (`HERMETIC_BUILD_SHA`, read by `src/data/release.ts`), and
  verification fails unless the deployed footer shows that same commit, so a stale edge or a wrong
  build cannot pass. It also checks `/docs/`, `/explainer/`, `/cost/`, the CSP header from
  `_headers`, `/install.sh` as text/plain, and the `/download` redirect. Add a path to `CHECKS` when
  a page becomes something a release must not break.
- The production URL is `https://<project>.pages.dev` unless `HERMETIC_SITE_URL` says otherwise;
  the Pages production branch is `main` unless `CLOUDFLARE_PRODUCTION_BRANCH` says otherwise.

In CI, a pushed `v*` tag runs `release.yml`'s `publish` job, then its `site` job, which calls
`.github/workflows/site.yml`; that runs `bun scripts/deploy.ts --production --yes` with the tag in
`HERMETIC_RELEASE_TAG` (`tests/ci-contract.test.ts` holds it to that one command, with no relaxing
flag). On GitHub Actions the script folds subprocess output into log groups, raises failures as
annotations and writes the deployed URLs to the job summary. To redeploy an already-released tag
(a docs fix, without cutting a new release):

```
gh workflow run site.yml -f ref=vX.Y.Z
```

One-time Cloudflare/GitHub environment setup (API token, project, secrets): `site/README.md`
"Deploy setup".
