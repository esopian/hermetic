/**
 * A box with the files service wired into the real RPC handler, over
 * `FakeHost`: the tailnet routes are driven through `makeRpcHandler` (so the
 * `whois` gate is the real one) and the socket through its pure handler.
 */
import { createHash } from "node:crypto";
import type { FileEntry, FileRequest } from "@hermetic/core/schema";
import {
  CONTENT_DIGEST_HEADER,
  FILES_INDEX_PATH,
  HERMES_ACCOUNT_HOME,
  HERMES_HOME,
  formatContentDigest,
} from "@hermetic/core/shared";
import type { MaterialisedFileSecret } from "../src/files/context.ts";
import { type FilesService, makeFilesService } from "../src/files/service.ts";
import { TAGGED_DEVICES_LOGIN, type Whois, makeRpcHandler } from "../src/rpc.ts";
import { FakeHost } from "./fake-host.ts";
import { TEST_NAME } from "./fixtures.ts";

export const OPERATOR_IP = "100.64.0.3";
export const STRANGER_IP = "203.0.113.9";
export const MEMBER: Whois = { login: "evan@example.com", node: "laptop.tailnet.ts.net", tags: [] };
export const AGENT_NODE: Whois = {
  login: TAGGED_DEVICES_LOGIN,
  node: "bravo.tailnet.ts.net",
  tags: ["tag:hermetic"],
};

export const PEM = new TextEncoder().encode(
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAFIXTUREFIXTURE\n-----END RSA PRIVATE KEY-----\n",
);
/** A minimal PNG header: what the sniffer calls `image/png`. */
export const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
export const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
export const TEXT = new TextEncoder().encode("hello, agent\n");

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface BoxOptions {
  peer?: Whois;
  /** Long-poll timer; the default resolves at once, so a wait times out immediately. */
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  materialiseSecret?: (
    slot: string,
    expectName: string,
    check?: (content: Uint8Array) => void,
  ) => Promise<MaterialisedFileSecret>;
  removeSecret?: (name: string) => Promise<void>;
  host?: FakeHost;
  /** How long an upload may go silent before it is cut off, in ms. */
  uploadIdleMs?: number;
  /** The RPC policy's `allowedTags`. */
  allowedTags?: readonly string[];
}

export async function filesBox(options: BoxOptions = {}) {
  const host = options.host ?? new FakeHost();
  // The account's home and `$HERMES_HOME` exist on any box past `05-service`.
  host.dirs.add("/data");
  host.dirs.add(HERMES_ACCOUNT_HOME);
  host.dirs.add(HERMES_HOME);
  host.dirs.add("/run/hermetic");
  const audit: string[] = [];
  const log = (m: string): void => void audit.push(m);
  const service: FilesService = await makeFilesService({
    host,
    name: TEST_NAME,
    hermeticdVersion: "0.1.0",
    log,
    delay: options.delay ?? (async () => undefined),
    ...(options.materialiseSecret ? { materialiseSecret: options.materialiseSecret } : {}),
    ...(options.removeSecret ? { removeSecret: options.removeSecret } : {}),
    ...(options.uploadIdleMs !== undefined ? { uploadIdleMs: options.uploadIdleMs } : {}),
  });
  const rpc = makeRpcHandler({
    host,
    name: TEST_NAME,
    hermeticdVersion: "0.1.0",
    configHash: async () => null,
    whois: async (ip) => (ip.startsWith("100.64.") ? (options.peer ?? MEMBER) : null),
    log,
    files: service.tailnet,
    ...(options.allowedTags ? { allowedTags: options.allowedTags } : {}),
  });
  const fetch = (path: string, init?: RequestInit, ip = OPERATOR_IP): Promise<Response> =>
    rpc(new Request(`http://box${path}`, init), ip);
  const socket = (path: string, init?: RequestInit): Promise<Response> =>
    service.socket(new Request(`http://localhost${path}`, init));
  const index = (): { entries: FileEntry[]; requests: FileRequest[] } =>
    JSON.parse(host.files.get(FILES_INDEX_PATH)?.content ?? '{"entries":[],"requests":[]}');
  return { host, service, rpc, fetch, socket, audit, index };
}

/** A PUT of `bytes` with the headers an upload needs; `extra` overrides any of them. */
export function put(bytes: Uint8Array, extra: Record<string, string> = {}): RequestInit {
  return {
    method: "PUT",
    body: bytes.slice(),
    headers: {
      "content-length": String(bytes.byteLength),
      [CONTENT_DIGEST_HEADER]: formatContentDigest(sha256(bytes)),
      ...extra,
    },
  };
}

export function post(body: unknown): RequestInit {
  const text = JSON.stringify(body);
  return {
    method: "POST",
    body: text,
    headers: { "content-type": "application/json", "content-length": String(text.length) },
  };
}

/** Open a request slot over the socket; the slot as the socket answered it. */
export async function openSlot(
  socket: (path: string, init?: RequestInit) => Promise<Response>,
  body: Record<string, unknown> = {},
): Promise<{ request_id: string; deliver_with: string[]; status: string; expires_at: string }> {
  const res = await socket("/requests", post({ purpose: "the deploy key for staging", ...body }));
  if (res.status !== 201) throw new Error(`open failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as {
    request_id: string;
    deliver_with: string[];
    status: string;
    expires_at: string;
  };
}

export async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}
