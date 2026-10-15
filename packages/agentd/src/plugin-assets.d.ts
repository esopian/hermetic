/**
 * Files hermeticd embeds as text (`import x from "…" with { type: "text" }`):
 * the Hermes plugin it installs (`apply/plugins.ts`). Bun inlines the content
 * at `bun build --compile`; this only tells TypeScript the default export is
 * that string.
 */
declare module "*.py" {
  const content: string;
  export default content;
}

declare module "*.yaml" {
  const content: string;
  export default content;
}
