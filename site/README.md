# site

The marketing and docs site for hermetic: Astro + Starlight, deployed to Cloudflare Pages. Agent
instructions and conventions: `site/AGENTS.md` (`site/CLAUDE.md` points at it).

## Run / build / preview

```
bun install
bun run dev        # astro dev, http://localhost:4321
bun run check       # astro check + biome check + sync-docs --check
bun run build       # sync-docs, cli-reference, astro build -> site/dist (+ pagefind index)
bun run preview     # wrangler pages dev dist — the real Cloudflare runtime, incl. _headers/_redirects
bun run deploy      # preview deploy to Cloudflare Pages, verified; --production for production
```

`bun run deploy --help` lists every option; `site/AGENTS.md` "Deploy" says what each check does.
The first local deploy needs `bunx wrangler login`.

From the repo root, `bun run site:dev` / `site:build` / `site:check` / `site:deploy` do the same thing without a
`cd`.

## The explainer

`/explainer/` is an animated walkthrough of hermetic, built from `src/pages/explainer.astro` and the
plain scripts under `public/explainer/`. `bun run dev`, then open `http://localhost:4321/explainer/`.
How it is put together: `site/AGENTS.md` "Explainer".

## Why not a workspace

`site/` is deliberately outside the root `workspaces` (`packages/*`) in the repo's `package.json`.
It has its own `package.json`, `bun.lock`, `tsconfig.json` and `biome.jsonc`; `bun install` at the
repo root never touches it, and nothing under `packages/` imports it or is imported by it. It stays
out of the import-boundary matrix in the root `AGENTS.md` entirely. `site/scripts/cli-reference.ts`
spawns the real CLI as a subprocess (`bun ../packages/cli/src/main.ts --help`) rather than
importing it, which is why the root `bun install` still has to have run before `site`'s build —
that dependency is a spawned process, not an import.

## Deploy setup

One-time setup, by hand, before the first deploy works. `site.yml` (`.github/workflows/site.yml`)
assumes all of this already exists; it creates none of it.

**(a) Cloudflare Pages project.** Cloudflare dashboard → Workers & Pages → Create → Pages → Direct
Upload (not the Git integration — this repo's own release workflow decides when production moves).
Project name `hermetic-site`, production branch `main`.

**(b) API token.** Cloudflare dashboard → My Profile → API Tokens → Create Custom Token. Permission
Account → Cloudflare Pages → Edit, scoped to the one account. Note the account ID shown on the same
page (right sidebar).

**(c) GitHub environment and secrets** (`gh` CLI, run once):

```
gh api -X PUT repos/esopian/hermetic/environments/site-production \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'

# Tags: what a real release deploys from.
gh api -X POST repos/esopian/hermetic/environments/site-production/deployment-branch-policies \
  -f name='v*' -f type=tag

# Branch: workflow_dispatch does not run from the tag named in its `ref` input —
# it runs from the default branch (master), because that is where the
# workflow file it dispatches lives. The environment's policy is checked
# against *that* ref, not against the `ref` input, so a tag-only policy would
# block `gh workflow run site.yml -f ref=vX.Y.Z` with an environment-protection
# error even though the input looks like a tag. Allowing master here is what
# makes manual redeploys work; the workflow itself still only ever builds and
# deploys the tag named in its `ref` input, never master's tree.
gh api -X POST repos/esopian/hermetic/environments/site-production/deployment-branch-policies \
  -f name='master' -f type=branch

gh secret set CLOUDFLARE_API_TOKEN --env site-production
gh secret set CLOUDFLARE_ACCOUNT_ID --env site-production
gh variable set CLOUDFLARE_PAGES_PROJECT --env site-production --body hermetic-site
```

**(d) First deploy.** `site.yml` has to exist on `master` before `workflow_dispatch` can target it
(dispatch only offers workflows already on the default branch), so merge this change first. Then:

```
gh workflow run site.yml -f ref=v0.1.6
```

The workflow runs the same `scripts/deploy.ts` you can run locally, so a failed CI deploy
reproduces on a laptop with `bun run deploy --production` from the tag's checkout.

Any later `v*` tag pushed through the normal release flow (`CONTRIBUTING.md` "Cutting a release")
deploys automatically once `publish` finishes.
