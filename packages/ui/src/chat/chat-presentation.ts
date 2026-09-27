/** Display names are separate from the instance/profile identity used by URLs and requests. */
export function botLabel(instance: string, bot: string, title?: string | null): string {
  const name = title?.trim();
  if (name && name !== "default") return name;
  return bot === "default" ? instance : bot;
}
