/**
 * The typed door to the app, as one module: every request is a name and a bag
 * of parameters through the transport seam (`client.ts`, `fleet.ts`,
 * `chat.ts`), the shapes are read back off the bridge contract (`types.ts`),
 * and a stream is a protocol over frames the transport routes (`streams.ts`).
 * Nothing here imports `@hermetic/core` (§3.1).
 */
export * from "./types.ts";
export * from "./client.ts";
export * from "./fleet.ts";
export * from "./chat.ts";
export * from "./streams.ts";
