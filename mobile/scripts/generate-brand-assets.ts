/** Rebuild the mobile raster assets from the checked-in Hermetic fleet mark. */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = resolve(mobile, "assets");
const mark = readFileSync(resolve(assets, "brand/mark.svg"), "utf8")
  .replace(/^[\s\S]*?<svg[^>]*>/, "")
  .replace(/<\/svg>\s*$/, "");
const background = "#0e0e0d";
const svg = (content: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><title>Hermetic fleet mark</title>${content}</svg>\n`;
const centered = (size: number, content = mark) =>
  `<g transform="translate(${(1024 - size) / 2} ${(1024 - size) / 2}) scale(${size / 220})">${content}</g>`;
const fill = `<rect width="1024" height="1024" fill="${background}"/>`;
const outputs = [
  { name: "icon", source: svg(fill + centered(600)), size: 1024, opaque: true },
  { name: "splash-icon", source: svg(centered(1024)), size: 1024, opaque: false },
  { name: "android-icon-foreground", source: svg(centered(512)), size: 1024, opaque: false },
  { name: "android-icon-background", source: svg(fill), size: 1024, opaque: true },
  {
    name: "android-icon-monochrome",
    source: svg(centered(512, mark.replace(/#[a-fA-F0-9]{6}/g, "#000000"))),
    size: 1024,
    opaque: false,
  },
  { name: "favicon", source: svg(fill + centered(600)), size: 64, opaque: true },
];
mkdirSync(resolve(assets, "brand"), { recursive: true });
for (const { name, source, size, opaque } of outputs) {
  const sourcePath = resolve(assets, "brand", `${name}.svg`);
  const pngPath = resolve(assets, `${name}.png`);
  writeFileSync(sourcePath, source);
  const result = spawnSync(
    "magick",
    [
      "-background",
      "none",
      "-density",
      "384",
      sourcePath,
      "-resize",
      `${size}x${size}`,
      "-strip",
      ...(opaque ? ["-alpha", "off"] : []),
      `${opaque ? "PNG24" : "PNG32"}:${pngPath}`,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0)
    throw new Error(`ImageMagick could not render ${name}`, { cause: result.error });
  console.log(`Generated assets/${name}.png (${size}×${size}, ${opaque ? "opaque RGB" : "RGBA"})`);
}
