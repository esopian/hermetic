import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

const REPO = "https://github.com/esopian/hermetic";

// The address the site is served from, baked into the sitemap, canonical links and the install
// command. scripts/deploy.ts requires it for production (the custom domain); an unset or empty
// value, as in `astro dev` or a preview build, falls back to the local dev server.
const SITE = process.env["HERMETIC_SITE_URL"] || "http://localhost:4321";

export default defineConfig({
  site: SITE,
  trailingSlash: "ignore",
  // Never inline assets as data: URLs, so the CSP in public/_headers can keep font-src and
  // img-src to 'self' for fonts.
  vite: { build: { assetsInlineLimit: 0 } },
  integrations: [
    starlight({
      title: "hermetic",
      description: "Fleet manager for Hermes agents on AWS.",
      social: [{ icon: "github", label: "GitHub", href: REPO }],
      // Starlight writes og:title/description/url and twitter:card itself; add the share image
      // (the same public/og.png as the marketing pages, layouts/Shell.astro).
      head: [
        { tag: "meta", attrs: { property: "og:image", content: `${SITE}/og.png` } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        { tag: "meta", attrs: { name: "twitter:image", content: `${SITE}/og.png` } },
        { tag: "meta", attrs: { name: "theme-color", content: "#0e0e0d" } },
      ],
      editLink: { baseUrl: `${REPO}/edit/master/site/` },
      customCss: ["./src/styles/fonts.css", "./src/styles/tokens.css", "./src/styles/starlight.css"],
      components: {
        SiteTitle: "./src/components/starlight/SiteTitle.astro",
        ThemeProvider: "./src/components/starlight/ThemeProvider.astro",
        ThemeSelect: "./src/components/starlight/ThemeSelect.astro",
      },
      // One dark theme, square frames, token colours (docs/ui-brief.md, "Look").
      expressiveCode: {
        themes: ["github-dark"],
        useStarlightDarkModeSwitch: false,
        useStarlightUiThemeColors: false,
        styleOverrides: {
          borderRadius: "0",
          borderColor: "var(--line2)",
          codeBackground: "var(--bg2)",
          codeFontFamily: "var(--mono)",
          uiFontFamily: "var(--sans)",
          frames: {
            editorTabBarBackground: "var(--bg)",
            editorActiveTabBackground: "var(--bg2)",
            terminalTitlebarBackground: "var(--bg)",
            terminalBackground: "var(--bg2)",
            frameBoxShadowCssValue: "none",
          },
        },
      },
      // The explainer is an Astro page outside the docs collection, so the validator cannot see it.
      plugins: [starlightLinksValidator({ exclude: ["/explainer/", "/explainer/#*", "/cost/"] })],
      sidebar: [
        "docs/quick-start",
        { label: "Overview", link: "/docs/" },
        // The animated walkthrough (src/pages/explainer.astro), outside the docs collection.
        { label: "Explainer", link: "/explainer/" },
        // The cost page (src/pages/cost.astro), also outside the docs collection.
        { label: "Cost", link: "/cost/" },
        // The mobile companion page (src/pages/mobile.astro), also outside the docs collection.
        { label: "Mobile app", link: "/mobile/" },
        {
          label: "Start here",
          items: ["docs/start/install", "docs/start/first-fleet"],
        },
        // The stream inspector, the CLI commands that look inside a box, and contributing.
        "docs/powertools",
        {
          label: "Concepts",
          items: ["docs/concepts/principles", "docs/concepts/security-model"],
        },
        // Operate is docs/operations.md split one page per section (scripts/sync-docs.ts), in the
        // runbook's own order. Starlight's autogenerate matches file paths under src/content/docs/,
        // not page ids, so the directory names the _synced/ tree.
        { label: "Operate", items: [{ autogenerate: { directory: "_synced/operate" } }] },
        // Generated from the CLI's help text (scripts/cli-reference.ts).
        { label: "Reference", items: ["docs/reference/cli", "docs/reference/exit-codes"] },
      ],
    }),
    sitemap(),
  ],
});
