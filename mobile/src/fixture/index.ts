/**
 * Fixture mode (§9.4): the phone against a canned fleet, with no tailnet, no
 * box and no Expo push service. It is what the simulator screenshots run on.
 *
 * `fixtureKit(flag)` answers `null` unless `flag` is `"1"`, and the app passes
 * it `process.env.EXPO_PUBLIC_HERMETIC_FIXTURE` (inlined at build time), so a
 * production build never constructs any of this. When it is on, the kit hands
 * the provider:
 *
 * - `chat` — core's fixture chat stack (`createFixtureChatStack`, in place of
 *   the live Hermes adapter): the same `fixtureChatClient` the desktop runs,
 *   wrapped the same way, with the same scripted-activity store handed to both
 *   halves. A bare `fixtureChatClient` with no activity leaves `observe` inert
 *   (the conversation sits on "Reconnecting…") and records a sent prompt under
 *   its own id beside the phone's placeholder (the prompt shows twice);
 * - `fetch` — a stand-in for the network that answers hermeticd's `GET /fleet`
 *   with a canned `MobileFleetView` for `fxtr0001` (alias `main`, the desktop
 *   fixture's eleven agents), keeps `POST`/`DELETE /push/devices` in an
 *   in-memory registry, and answers the Tailscale probe (`/api/health`) the way
 *   the switchable `tailscale` status says; hermeticd's `GET /healthz` and its
 *   files stage and commit routes are core's fixture files box
 *   (`createFixtureFilesBox`: the desktop fixture's checks and
 *   `E2E_FILE_TOO_LARGE`/`E2E_FILE_DIGEST` name triggers, and `ember` serves no
 *   files), and so are its request routes. The same box is the chat stack's
 *   files service, so the prompts `E2E_FILE_REQUEST`, `E2E_SECRET_REQUEST`,
 *   `E2E_TEXT_SECRET`, `E2E_TEXT_SECRET_MULTI` and `E2E_FILE_REQUEST_TIMEOUT`
 *   open a request slot on it that the phone's request cards answer;
 * - `files` — the real files client (`gateway/files.ts`) over that `fetch`;
 *   The box also serves `GET /files/:id/content` (shared and staged files and
 *   the canned transcripts' pictures) and is the `E2E_FILE_SHARE` turn's
 *   outbox, so share cards, `MEDIA:` chips and seeded images load;
 * - `link` — a pairing link for that fleet, for the Pair screen's "Use fixture
 *   fleet" button;
 * - `demoPrompts` — `FIXTURE_DEMO_PROMPTS`, one prompt per kind of block or
 *   card the fixture can raise, for the conversation's "Demo prompts…" menu
 *   and the `?demo=` deep link;
 * - `sampleFiles` — a canned PNG (the box's seeded `queue-depth.png`) and a
 *   short text file, written to the cache directory, for the conversation's
 *   `?attach=` link (`sample-files.ts`);
 * - `clipboardImage` — the same PNG as the composer's paste control answers a
 *   copied picture, for the conversation's `?paste=image` link;
 * - `drive` — the `hermetic://fixture?…` link's driver (`drive.ts`), which
 *   pairs, listens, picks the primary, sets the avatar style and theme, and
 *   names the route to open, so a screenshot run needs no tap;
 * - `storagePrefix` — fixture pairings and caches are kept under their own
 *   keys and files, never over a real pairing.
 *
 * Everything past the kit is the real code: the fleet store, the gateway
 * transport, the inbox and the probe all run unchanged over these doubles.
 *
 * This directory is the only place in `mobile/` that may import
 * `@hermetic/core/chat-client-fixture` (`tests/boundaries.test.ts`).
 */
import type { HermesChatClient } from "@hermetic/core/chat-client";
import {
  createFixtureChatStack,
  createFixtureFilesBox,
  type FixtureFilesBox,
} from "@hermetic/core/chat-client-fixture";
import type { MobileFleetAgent, MobileFleetView, MobilePushDevice } from "@hermetic/core/schema";
import { cloudName, encodeMobileLink, RPC_PATHS } from "@hermetic/core/shared";
import { createPhoneFiles, type PhoneFilesFactory } from "../gateway/files.ts";
import type { FetchLike } from "../gateway/hermeticd.ts";
import type { PickedFile } from "../client/attachments.ts";
import type { PastedImage } from "../client/paste.ts";
import type { DemoPrompt, FixtureControls } from "../fleet/fixture-types.ts";
import type { TailscaleStatus } from "../gateway/tailscale.ts";
import { drive } from "./drive.ts";
import { cacheWriter, clipboardSample, type SampleWriter, writeSampleFiles } from "./sample-files.ts";

export const FIXTURE_FLEET_ID = "fxtr0001";
export const FIXTURE_ALIAS = "main";
/** `FIXTURE_TAILNET` in `packages/core/src/backend/fixture/memory-fixture.ts`. */
export const FIXTURE_TAILNET = "hermetic.ts.net";
const FIXTURE_ACCOUNT = "123456789012";
const FIXTURE_REGION = "us-west-2";

export const FIXTURE_PUSH_TOKEN = "ExponentPushToken[FIXTURE-phone-token]";

const HEALTHY = { hermes: true, tailscale: true, disk: true } as const;

/**
 * The `main` fixture fleet's eleven agents, as `GET /fleet` would report them
 * (`SEEDS` in `packages/core/src/backend/fixture/fixture-agents.ts`: name,
 * status, address, Hermes version, health). `corvid` came up under a suffixed
 * MagicDNS name, so its host differs from the derived one.
 */
const SEEDS: readonly {
  name: string;
  status: MobileFleetAgent["status"];
  ip: string;
  version: string;
  health: NonNullable<MobileFleetAgent["health"]>;
  dns_host?: string;
}[] = [
  { name: "atlas", status: "ready", ip: "100.64.12.4", version: "0.21.0", health: HEALTHY },
  {
    name: "corvid",
    status: "ready",
    ip: "100.64.12.9",
    version: "0.21.0",
    health: HEALTHY,
    dns_host: "corvid-2",
  },
  {
    name: "ember",
    status: "degraded",
    ip: "100.64.12.17",
    version: "0.14.2",
    health: { hermes: false, tailscale: true, disk: true },
  },
  { name: "fathom", status: "ready", ip: "100.64.12.21", version: "0.14.2", health: HEALTHY },
  { name: "granite", status: "ready", ip: "100.64.12.23", version: "0.21.0", health: HEALTHY },
  {
    name: "heron",
    status: "error",
    ip: "100.64.12.30",
    version: "0.14.2",
    health: { hermes: false, tailscale: true, disk: true },
  },
  { name: "ibis", status: "ready", ip: "100.64.12.31", version: "0.21.0", health: HEALTHY },
  {
    name: "juniper",
    status: "stopped",
    ip: "100.64.12.38",
    version: "0.13.8",
    health: { hermes: false, tailscale: false, disk: true },
  },
  { name: "kestrel", status: "ready", ip: "100.64.12.40", version: "0.21.0", health: HEALTHY },
  {
    name: "lumen",
    status: "ready",
    ip: "100.64.12.44",
    version: "0.21.0",
    health: { hermes: true, tailscale: true, disk: false },
  },
  {
    name: "marrow",
    status: "stopped",
    ip: "100.64.12.47",
    version: "0.14.0",
    health: { hermes: false, tailscale: false, disk: true },
  },
];

const hostOf = (seed: { name: string; dns_host?: string }) =>
  `${cloudName(FIXTURE_FLEET_ID, seed.dns_host ?? seed.name)}.${FIXTURE_TAILNET}`;

/** The canned `GET /fleet` answer. */
export function fixtureFleetView(readAt: string): MobileFleetView {
  return {
    fleet: {
      fleet_id: FIXTURE_FLEET_ID,
      alias: FIXTURE_ALIAS,
      tailnet: FIXTURE_TAILNET,
      region: FIXTURE_REGION,
      account_id: FIXTURE_ACCOUNT,
      foundation_version: 16,
    },
    agents: SEEDS.map((seed) => ({
      name: seed.name,
      status: seed.status,
      tailscale_dns_name: hostOf(seed),
      tailscale_ip: seed.ip,
      version: seed.version,
      health: seed.health,
    })),
    read_at: readAt,
  };
}

/** What `hermetic mobile pair` would print for the fixture fleet. */
export function fixturePairingLink(): string {
  return encodeMobileLink({
    fleet_id: FIXTURE_FLEET_ID,
    alias: FIXTURE_ALIAS,
    account_id: FIXTURE_ACCOUNT,
    region: FIXTURE_REGION,
    tailnet: FIXTURE_TAILNET,
    agents: SEEDS.map((seed) =>
      seed.dns_host ? { name: seed.name, host: hostOf(seed) } : { name: seed.name },
    ),
  });
}

/* ── the memory push registry ───────────────────────────────────────────── */

export interface MemoryPushRegistry {
  /** Registrations by box host, then device id. */
  readonly boxes: Map<string, Map<string, MobilePushDevice>>;
  devicesOn(host: string): MobilePushDevice[];
}

export function memoryPushRegistry(): MemoryPushRegistry {
  const boxes = new Map<string, Map<string, MobilePushDevice>>();
  return { boxes, devicesOn: (host) => [...(boxes.get(host)?.values() ?? [])] };
}

/* ── the switchable Tailscale status ────────────────────────────────────── */

export type FixtureTailscale = Exclude<TailscaleStatus, "unknown">;

export interface FixtureTailscaleSwitch {
  get(): FixtureTailscale;
  set(status: FixtureTailscale): void;
}

function tailscaleSwitch(initial: FixtureTailscale = "ok"): FixtureTailscaleSwitch {
  let status = initial;
  return {
    get: () => status,
    set: (next) => {
      status = next;
    },
  };
}

/* ── the stand-in network ───────────────────────────────────────────────── */

const respond = (body: unknown, status = 200): Response =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Fetch for fixture mode: hermeticd's routes and the Tailscale probe, from
 * memory. Anything else is refused the way a dead network refuses.
 */
export function fixtureFetch(input: {
  registry: MemoryPushRegistry;
  tailscale: FixtureTailscaleSwitch;
  now: () => string;
  /** hermeticd's `/healthz` and files routes; absent, they answer 404 as before. */
  files?: FixtureFilesBox;
}): FetchLike {
  const known = new Set(SEEDS.map(hostOf));
  const agentAt = new Map(SEEDS.map((seed) => [hostOf(seed), seed.name]));
  return async (request, init) => {
    const url = new URL(String(request instanceof Request ? request.url : request));
    const method = (init?.method ?? "GET").toUpperCase();
    const status = input.tailscale.get();
    if (status === "off")
      throw new TypeError("A server with the specified hostname could not be found.");
    if (status === "unreachable") throw new TypeError("The request timed out.");
    if (!known.has(url.hostname))
      throw new TypeError("A server with the specified hostname could not be found.");
    if (url.pathname === "/api/health") return respond({ status: "ok" });
    if (url.pathname === RPC_PATHS.fleet && method === "GET")
      return respond(fixtureFleetView(input.now()));
    if (url.pathname === RPC_PATHS.pushDevices && method === "POST") {
      const device = JSON.parse(String(init?.body ?? "{}")) as MobilePushDevice;
      const box = input.registry.boxes.get(url.hostname) ?? new Map<string, MobilePushDevice>();
      box.set(device.device_id, device);
      input.registry.boxes.set(url.hostname, box);
      return respond({ ok: true });
    }
    if (url.pathname.startsWith(`${RPC_PATHS.pushDevices}/`) && method === "DELETE") {
      const id = decodeURIComponent(url.pathname.slice(RPC_PATHS.pushDevices.length + 1));
      input.registry.boxes.get(url.hostname)?.delete(id);
      return respond({ ok: true });
    }
    const agent = agentAt.get(url.hostname);
    if (input.files && agent !== undefined) {
      const answer = await input.files.serve(agent, {
        method,
        path: url.pathname,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body as Uint8Array | string | null | undefined,
      });
      if (answer?.bytes !== undefined)
        return new Response(answer.bytes as Uint8Array<ArrayBuffer>, {
          status: answer.status,
          headers: { ...answer.headers },
        });
      if (answer !== null) return respond(answer.body, answer.status);
    }
    return respond({ type: "error", code: "NOT_FOUND", message: `no route ${url.pathname}` }, 404);
  };
}

/* ── the demo prompts ───────────────────────────────────────────────────── */

/**
 * One prompt per thing the fixture chat can draw, grouped as the sheet lists
 * them. Each names the trigger core's fixture reacts to (AGENTS.md "Modes",
 * `fixture-chat-demo.ts` for markdown, the process event and the DM); a plain
 * prompt gets the default turn (reasoning, a terminal tool, sources).
 */
export const FIXTURE_DEMO_PROMPTS: readonly DemoPrompt[] = [
  { group: "Text", label: "Plain reply", prompt: "How is the box doing?" },
  { group: "Text", label: "Markdown", prompt: "Summarise it with a table E2E_MARKDOWN" },
  { group: "Tools", label: "Tool rows", prompt: "Check the disk throughput" },
  { group: "Tools", label: "Background process", prompt: "Run the build E2E_PROCESS_EVENT" },
  { group: "Tools", label: "Message a teammate", prompt: "Tell scribe E2E_DM" },
  { group: "Approvals", label: "Approval", prompt: "Resize the volume E2E_APPROVAL" },
  { group: "Approvals", label: "Smart approval", prompt: "Resize the volume E2E_APPROVAL_SMART" },
  { group: "Approvals", label: "No session", prompt: "Resize the volume E2E_APPROVAL_NOSESSION" },
  { group: "Approvals", label: "Times out", prompt: "Resize the volume E2E_APPROVAL_TIMEOUT" },
  { group: "Questions", label: "Batch", prompt: "Plan the rollout E2E_BATCH_CLARIFY" },
  { group: "Questions", label: "One in a batch", prompt: "Plan the rollout E2E_ONE_BATCH_CLARIFY" },
  { group: "Questions", label: "Blocking", prompt: "Plan the rollout E2E_BLOCKING_CLARIFY" },
  { group: "Questions", label: "Times out", prompt: "Plan the rollout E2E_CLARIFY_TIMEOUT" },
  { group: "Subagents", label: "One child", prompt: "Survey the logs E2E_SUBAGENT" },
  { group: "Subagents", label: "Parallel", prompt: "Survey the logs E2E_SUBAGENT_PARALLEL" },
  { group: "Subagents", label: "Background", prompt: "Survey the logs E2E_SUBAGENT_BACKGROUND" },
  ...(
    [
      "RATE_LIMITED",
      "CONTEXT_OVERFLOW",
      "AUTH",
      "AUTH_OAUTH",
      "BILLING",
      "CONTENT_POLICY_BLOCKED",
      "MODEL_NOT_FOUND",
      "LOOP_ERROR",
      "UNCLASSIFIED",
    ] as const
  ).map((code) => ({
    group: "Errors",
    label: code.toLowerCase().replace(/_/g, " "),
    prompt: `Try again E2E_ERROR_${code}`,
  })),
  { group: "Errors", label: "after some text", prompt: "Try again E2E_ERROR_AFTER_TEXT" },
  { group: "Files", label: "Share files", prompt: "Send me the Q3 numbers E2E_FILE_SHARE" },
  { group: "Files", label: "File request", prompt: "I need the access log E2E_FILE_REQUEST" },
  { group: "Files", label: "Secret file", prompt: "I need the deploy key E2E_SECRET_REQUEST" },
  { group: "Files", label: "Text secret", prompt: "I need a token E2E_TEXT_SECRET" },
  {
    group: "Files",
    label: "Text secret, several keys",
    prompt: "I need the keys E2E_TEXT_SECRET_MULTI",
  },
  { group: "Files", label: "Request times out", prompt: "I need the log E2E_FILE_REQUEST_TIMEOUT" },
];

/* ── the demo gallery bot ───────────────────────────────────────────────── */

/**
 * The bot whose Bot Chat the kit fills with the live-only kinds no canned
 * transcript carries — share cards and a `MEDIA:` chip, rich markdown with a
 * box image, parallel and background subagents, a background process event,
 * a DM line — so browsing to it shows them without typing. `corvid`'s `wren`,
 * whose canned transcript is a single message.
 */
export const FIXTURE_GALLERY = { instance: "corvid", bot: "wren" } as const;

/** The demo prompts the gallery bot is sent, by label, in order. */
export const FIXTURE_GALLERY_LABELS = [
  "Markdown",
  "Share files",
  "Parallel",
  "Background",
  "Background process",
  "Message a teammate",
] as const;

/**
 * Send the gallery's prompts to its Bot Chat, one turn after another, each
 * read to its end so the fixture records it (`sentRows`). A turn that fails
 * is skipped; nothing here throws.
 */
export async function seedGallery(chat: HermesChatClient): Promise<void> {
  const box = {
    instance: FIXTURE_GALLERY.instance,
    baseUrl: `https://${hostOf(SEEDS.find((seed) => seed.name === FIXTURE_GALLERY.instance) ?? { name: FIXTURE_GALLERY.instance })}/`,
    fleet_id: FIXTURE_FLEET_ID,
  };
  for (const label of FIXTURE_GALLERY_LABELS) {
    const demo = FIXTURE_DEMO_PROMPTS.find((p) => p.label === label);
    if (!demo) continue;
    try {
      for await (const _frame of chat.send(box, FIXTURE_GALLERY.bot, demo.prompt)) {
        // Read to the end: the fixture records the turn as it is handed over.
      }
    } catch {
      // A seeded turn that fails leaves the gallery one turn short, nothing more.
    }
  }
}

/**
 * `chat`, filling the gallery on the first roster read: lazily, so a kit
 * built and never used (a test, a provider that never reaches the roster)
 * runs no turn.
 */
function withGallery(chat: HermesChatClient): HermesChatClient {
  let started = false;
  const start = (): void => {
    if (started) return;
    started = true;
    void seedGallery(chat);
  };
  return {
    ...chat,
    swarm: (box, opts) => {
      start();
      return chat.swarm(box, opts);
    },
  };
}

/* ── the kit ────────────────────────────────────────────────────────────── */

export interface FixtureKit {
  chat: HermesChatClient;
  fetch: FetchLike;
  /** The real files client over `fetch`, one per box. */
  files: PhoneFilesFactory;
  link: string;
  demoPrompts: readonly DemoPrompt[];
  /** The canned attachments for `?attach=` (`sample-files.ts`): an image, then a text file. */
  sampleFiles(): Promise<PickedFile[]>;
  /** The canned PNG as a paste (`sample-files.ts`), for `?paste=image`. */
  clipboardImage(): Promise<PastedImage>;
  /** The `hermetic://fixture?…` driver (`drive.ts`). */
  drive: NonNullable<FixtureControls["drive"]>;
  /** A sentinel Expo token: the simulator has none, and the memory registry needs one. */
  pushToken: string;
  registry: MemoryPushRegistry;
  tailscale: FixtureTailscaleSwitch;
  /** Keys and file names are prefixed with this, so a fixture pairing never overwrites a real one. */
  storagePrefix: string;
}

/** The seeded transcript picture every fixture box serves; `sampleFiles` reuses its bytes. */
export const FIXTURE_SAMPLE_IMAGE_ID = "f_fxqueuedpth1";

/** The canned PNG's bytes, as the box serves them. */
async function cannedPng(box: FixtureFilesBox): Promise<Uint8Array> {
  const answer = await box.serve("atlas", {
    method: "GET",
    path: `/files/${FIXTURE_SAMPLE_IMAGE_ID}/content`,
  });
  if (!answer?.bytes) throw new Error("the fixture box serves no canned picture");
  return answer.bytes;
}

/**
 * The fixture kit, or `null` when `flag` is not `"1"`. Called with
 * `process.env.EXPO_PUBLIC_HERMETIC_FIXTURE`; nothing is constructed otherwise.
 */
export function fixtureKit(
  flag: string | undefined,
  now: () => string = () => new Date().toISOString(),
  opts: {
    /** Fill the gallery bot (`FIXTURE_GALLERY`) on the first roster read. The app sets it. */
    seed?: boolean;
    /** Where `sampleFiles` writes; the cache directory unless a test says otherwise. */
    writeSample?: SampleWriter;
  } = {},
): FixtureKit | null {
  if (flag !== "1") return null;
  const registry = memoryPushRegistry();
  const tailscale = tailscaleSwitch();
  // What desktop fixture mode builds (`createHermetic`), with a little pacing so
  // a streamed reply looks streamed in the simulator.
  // One fixture box for both halves: a request turn opens its slot on it, and
  // the phone's files client answers that slot over `fetch`.
  const box = createFixtureFilesBox();
  const stack = createFixtureChatStack(true, { delayMs: 40 }, { files: box }).hermes;
  if (!stack) throw new Error("the fixture chat stack built no client");
  const chat = opts.seed ? withGallery(stack) : stack;
  const fetch = fixtureFetch({ registry, tailscale, now, files: box });
  return {
    chat,
    fetch,
    files: (host) => createPhoneFiles({ fetch, host }),
    link: fixturePairingLink(),
    demoPrompts: FIXTURE_DEMO_PROMPTS,
    sampleFiles: async () => writeSampleFiles(await cannedPng(box), opts.writeSample ?? cacheWriter),
    clipboardImage: async () => clipboardSample(await cannedPng(box)),
    drive,
    pushToken: FIXTURE_PUSH_TOKEN,
    registry,
    tailscale,
    storagePrefix: "fixture.",
  };
}
