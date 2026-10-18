/**
 * Metro, taught where core's doors are.
 *
 * `mobile/` is not a root workspace, so `@hermetic/core` is not in its
 * `node_modules`. The phone imports core through four doors only
 * (`tests/boundaries.test.ts`): `@hermetic/core/schema`, `/shared`,
 * `/chat-client` and, from `src/fixture/` alone, `/chat-client-fixture`. Each
 * maps to the file `packages/core/package.json` `exports` names for it, and
 * the bare `@hermetic/core` door maps to nothing, so a stray import of it fails
 * the bundle rather than pulling the laptop's SDK onto the phone.
 *
 * Core's own imports (`zod`, sibling `.ts` files with explicit extensions)
 * resolve from where the core file sits: `packages/core/node_modules/zod` is a
 * symlink into the root `node_modules/.bun` store, which is why the root
 * `node_modules` is a watch folder (Metro must see the symlink's target) and a
 * fallback lookup path.
 */
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const MOBILE = __dirname;
const ROOT = path.resolve(MOBILE, "..");
const CORE = path.join(ROOT, "packages", "core");

/** `@hermetic/core/<door>` → the door file (`packages/core/package.json` `exports`). */
const DOORS = {
  "@hermetic/core/schema": path.join(CORE, "src", "schema", "index.ts"),
  "@hermetic/core/shared": path.join(CORE, "src", "shared", "index.ts"),
  "@hermetic/core/chat-client": path.join(CORE, "src", "chat-client.ts"),
  "@hermetic/core/chat-client-fixture": path.join(CORE, "src", "chat-client-fixture.ts"),
};

const config = getDefaultConfig(MOBILE);

config.watchFolders = [...(config.watchFolders ?? []), CORE, path.join(ROOT, "node_modules")];
config.resolver.nodeModulesPaths = [
  path.join(MOBILE, "node_modules"),
  path.join(CORE, "node_modules"),
  path.join(ROOT, "node_modules"),
];

const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const door = DOORS[moduleName];
  if (door) return { type: "sourceFile", filePath: door };
  if (moduleName === "@hermetic/core" || moduleName.startsWith("@hermetic/core/")) {
    throw new Error(
      `${moduleName} is not a door the phone may open (schema, shared, chat-client, chat-client-fixture)`,
    );
  }
  return (upstream ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
