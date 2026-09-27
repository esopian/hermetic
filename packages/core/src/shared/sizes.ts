/**
 * The named instance profiles' ids (§7.1), as plain values.
 *
 * The Zod enum (`schema/agent.ts` `Size`) and the full compute table (`SIZES`
 * there) are built from this list; the browser, which may not import a schema
 * module, reads the same ids from here. The create presets (`presets.ts`) name
 * a size, and a preset naming a size core does not know would be a create core
 * refuses — so both sides check against one list.
 */
export const SIZE_IDS = [
  "micro",
  "xxsmall",
  "xsmall",
  "small",
  "medium",
  "large",
  "xlarge",
  "xxlarge",
  "3xlarge",
  "gpu-xsmall",
  "gpu-small",
  "gpu-medium",
  "gpu-large",
  "gpu-xlarge",
] as const;

export type SizeId = (typeof SIZE_IDS)[number];

export function isSizeId(value: unknown): value is SizeId {
  return typeof value === "string" && (SIZE_IDS as readonly string[]).includes(value);
}
