# site

The marketing and docs site for hermetic: Astro + Starlight, served by Cloudflare Workers static assets. Agent
instructions and conventions: `site/AGENTS.md` (`site/CLAUDE.md` points at it).

## Run / build / preview

```
bun install
bun run dev        # astro dev, http://localhost:4321
bun run check       # astro check + biome check + sync-docs --check
bun run build       # sync-docs, cli-reference, astro build -> site/dist (+ pagefind index)
bun run preview     # wrangler dev: dist/ on the real Workers runtime, incl. _headers/_redirects
bun run deploy      # preview upload to Cloudflare, verified; --production for production
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

One-time setup, by hand, before the first deploy works. Production deploys are made by hand from a
release tag's checkout; no workflow deploys the site.

The site is a Cloudflare Worker with static assets and no script (`wrangler.toml`): `dist/` is the
asset directory and `public/_headers` and `public/_redirects` apply as they did on Pages. There is
no Pages project and no Git integration; production moves only when a maintainer deploys it.

**(a) Account and domain.** The domain's zone must be on the same Cloudflare account. The account
needs a workers.dev subdomain (Workers & Pages → Overview shows it; the first `wrangler` deploy
offers to register one), which previews and the deploy checks use.

**(b) First production deploy, from a laptop.** The Worker does not exist until something deploys
it, and a preview can only upload a version to an existing Worker. From a clean checkout:

```
cd site
bunx wrangler login
HERMETIC_SITE_URL=https://<your-domain> bun run deploy --production --allow-untagged
```

That creates the Worker `hermetic-site`, attaches the domain (`wrangler deploy --domain`, which
adds the DNS record and certificate) and verifies both the domain and the workers.dev address.
From then on `bun run deploy` uploads previews without touching production.

**(c) Each release.** After `release.yml` publishes a tag, deploy production from that tag:

```
git checkout v<x.y.z>
cd site
HERMETIC_SITE_URL=https://<your-domain> bun run deploy --production
```

The script refuses a tag that does not point at the checkout, builds, deploys and verifies over HTTP
that both the workers.dev address and the domain serve this commit.
