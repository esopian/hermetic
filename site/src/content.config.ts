import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

// Every docs page lives under /docs/. Authored pages sit in src/content/docs/; pages generated
// from the repo's own markdown (scripts/sync-docs.ts, scripts/cli-reference.ts) land in the
// git-ignored src/content/docs/_synced/ and are routed as if the `_synced` segment were not there.
//
// Every page also states its `slug` in frontmatter, and that wins, as it does in Astro's default
// glob loader. starlight-links-validator derives a page's address from the slug or else from the
// file path alone (it never sees this function), so without the slug it would look for
// /start/install/ where the page is really /docs/start/install/.
function docsId({ entry, data }: { entry: string; data: { slug?: unknown } }): string {
  if (typeof data.slug === "string") return data.slug;
  const path = entry
    .replace(/\.mdx?$/, "")
    .replace(/^_synced\//, "")
    .replace(/(^|\/)index$/, "");
  return ["docs", ...path.split("/").filter((s) => s.length > 0)].join("/").toLowerCase();
}

export const collections = {
  docs: defineCollection({ loader: docsLoader({ generateId: docsId }), schema: docsSchema() }),
};
