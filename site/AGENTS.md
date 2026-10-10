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
```

The root `package.json` has pass-throughs (`site:dev`, `site:build`, `site:check`) that just `cd
site && bun run <script>` — convenience only, not a substitute for running the above from `site/`
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

A pushed `v*` tag runs `release.yml`'s `publish` job, then its `site` job, which calls
`.github/workflows/site.yml` — that builds and deploys `site/` to Cloudflare Pages production. To
redeploy an already-released tag (a docs fix, without cutting a new release):

```
gh workflow run site.yml -f ref=vX.Y.Z
```

One-time Cloudflare/GitHub environment setup (API token, project, secrets): `site/README.md`
"Deploy setup".
