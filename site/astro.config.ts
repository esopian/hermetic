import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

const REPO = "https://github.com/esopian/hermetic";

// The production domain is not chosen yet; until it is, the site answers on the Pages project's own hostname.
const SITE = process.env["HERMETIC_SITE_URL"] ?? "https://hermetic-site.pages.dev";

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
      plugins: [starlightLinksValidator()],
      sidebar: [
        "docs/quick-start",
        { label: "Overview", link: "/docs/" },
        {
          label: "Start here",
          items: ["docs/start/install", "docs/start/first-fleet"],
        },
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
