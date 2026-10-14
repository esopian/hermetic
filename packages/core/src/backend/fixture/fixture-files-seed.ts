/**
 * The fixture boxes' Files tab: what `files.list` shows on the seeded `main`
 * fleet, with real bytes behind every entry that is not a secret, so
 * `files.get` and `files.content` work on them in fixture mode.
 *
 * Two agents carry a full set — `atlas` and `corvid`: an inbox PDF and PNG,
 * one outbox CSV the agent shared, a durable file secret
 * (`file-github-app-pem`) and a durable text secret (`env-github`, keys
 * `GITHUB_TOKEN`). The SSM parameters behind the two secrets are *not* seeded:
 * the fixture fleet's parameter set is what `plan teardown`'s golden output
 * counts, and removing an absent parameter is not a failure (`secrets.delete`).
 * `corvid` also has one open request raised by a scheduled job
 * rather than a chat session, so the bell has something no conversation
 * explains.
 *
 * Every value is a `FIXTURE` sentinel and nothing here is a real credential.
 * Timestamps follow the wall clock, not the fixture's frozen `now`, because the
 * Files tab counts expiry down against the operator's clock.
 */
import { createHash } from "node:crypto";
import type { FileEntry } from "../../schema/index.ts";
import { FILES_OUTBOX_DIR, FILES_SECRET_DIR, FILES_TTL } from "../../shared/files.ts";
import { HERMES_HOME } from "../../shared/hermes.ts";
import type { MemoryBackend } from "../memory.ts";
import { fixturePng } from "./fixture-chat-files.ts";
import { FIXTURE_OPERATOR_LOGIN, type MemoryFileEntry } from "./memory-files.ts";

/** The agents with seeded files, on the `main` fleet. */
export const FIXTURE_FILES_AGENTS = ["atlas", "corvid"] as const;

/** The scheduled job's session the seeded open request names: not a chat session. */
export const FIXTURE_FILES_CRON_SESSION = "cron_nightly_vendor_report";

/** Per agent, the fixed ids of what is seeded. */
export const FIXTURE_FILES_IDS = {
  atlas: {
    pdf: "f_fxatlaspdf01",
    png: "f_fxatlaspng01",
    csv: "sh_fxatlascsv01",
    pem: "f_fxatlaspem01",
    env: "f_fxatlasenv01",
  },
  corvid: {
    pdf: "f_fxcorvidpdf1",
    png: "f_fxcorvidpng1",
    csv: "sh_fxcorvidcsv1",
    pem: "f_fxcorvidpem1",
    env: "f_fxcorvidenv1",
  },
} as const satisfies Record<(typeof FIXTURE_FILES_AGENTS)[number], Record<string, string>>;

const enc = new TextEncoder();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A one-page PDF with a line of text, built by hand with a correct xref table. */
export function fixturePdf(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 72 720 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc.encode(out);
}

const VENDOR_CSV = [
  "vendor,invoices,total_usd,overdue",
  "Acme Supply FIXTURE,4,12840.00,0",
  "Globex FIXTURE,2,3120.50,1",
  "Initech FIXTURE,7,22015.75,2",
  "",
].join("\n");

/** Shaped like a PEM so the box's key sniff would flag it; the body is a sentinel, not a key. */
const FIXTURE_PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "FIXTUREgithubAppKeyFIXTUREgithubAppKeyFIXTURE",
  "-----END PRIVATE KEY-----",
  "",
].join("\n");

/** The canonical `KEY="value"` form a stored text secret holds. */
const FIXTURE_GITHUB_ENV = 'GITHUB_TOKEN="FIXTUREseededGithubTokenFIXTURE01"\n';

function inboxEntry(
  agent: string,
  id: string,
  name: string,
  mime: string,
  bytes: Uint8Array,
  created: Date,
): MemoryFileEntry {
  const rel = `inbox/${created.toISOString().slice(0, 10)}/${id}/${name}`;
  return {
    id,
    agent,
    name,
    bytes,
    mime,
    sha256: sha256(bytes),
    class: mime.startsWith("image/") ? "image" : "file",
    state: "inbox",
    created_at: created.toISOString(),
    expires_at: new Date(created.getTime() + FILES_TTL.inbox * 1000).toISOString(),
    rel,
    path: `${HERMES_HOME}/${rel}`,
  };
}

/**
 * Seed the Files tab on whichever of `FIXTURE_FILES_AGENTS` this backend has.
 * Idempotent per backend: a second call replaces the entries and adds no
 * second request.
 */
export function seedFixtureAgentFiles(backend: MemoryBackend, wallNow: Date = new Date()): void {
  for (const agent of FIXTURE_FILES_AGENTS) {
    if (!backend.agents.has(agent)) continue;
    const ids = FIXTURE_FILES_IDS[agent];
    const hoursAgo = (h: number): Date => new Date(wallNow.getTime() - h * 3_600_000);

    const pdf = inboxEntry(
      agent,
      ids.pdf,
      "vendor-contract-2026.pdf",
      "application/pdf",
      fixturePdf(`Vendor contract FIXTURE for ${agent}`),
      hoursAgo(30),
    );
    const png = inboxEntry(agent, ids.png, "dashboard.png", "image/png", fixturePng(48), hoursAgo(5));
    const csvBytes = enc.encode(VENDOR_CSV);
    const shared = hoursAgo(2);
    const csv: MemoryFileEntry = {
      id: ids.csv,
      agent,
      name: "vendor-summary.csv",
      bytes: csvBytes,
      mime: "text/csv",
      sha256: sha256(csvBytes),
      class: "file",
      state: "outbox",
      created_at: shared.toISOString(),
      expires_at: new Date(shared.getTime() + FILES_TTL.outbox * 1000).toISOString(),
      rel: `outbox/${ids.csv}/vendor-summary.csv`,
      path: `${FILES_OUTBOX_DIR}/${ids.csv}/vendor-summary.csv`,
      note: "Invoices per vendor, from the contract PDF",
    };
    for (const e of [pdf, png, csv]) backend.files.entries.set(e.id, e);

    const secrets: Array<{ id: string; slot: string; name: string; text: string; keys?: string[] }> = [
      { id: ids.pem, slot: "file-github-app-pem", name: "github-app.pem", text: FIXTURE_PEM },
      {
        id: ids.env,
        slot: "env-github",
        name: "github.env",
        text: FIXTURE_GITHUB_ENV,
        keys: ["GITHUB_TOKEN"],
      },
    ];
    for (const s of secrets) {
      const bytes = enc.encode(s.text);
      const digest = sha256(bytes);
      const entry: FileEntry = {
        id: s.id,
        dir: "secret",
        class: "secret",
        name: s.name,
        bytes: bytes.byteLength,
        mime: s.keys ? "text/plain" : "application/octet-stream",
        sha256: digest,
        created_at: hoursAgo(72).toISOString(),
        expires_at: null,
        path: `${FILES_SECRET_DIR}/${s.name}`,
        from: { kind: "operator", login: FIXTURE_OPERATOR_LOGIN, node: "fixture" },
        slot: s.slot,
        ...(s.keys ? { keys: s.keys } : {}),
      };
      backend.files.seedSecret(agent, entry);
    }
  }

  if (backend.agents.has("corvid")) {
    const already = backend.files
      .requestsFor("corvid")
      .some((r) => r.session_id === FIXTURE_FILES_CRON_SESSION);
    if (!already) {
      backend.files.openRequest(
        "corvid",
        {
          purpose:
            "The nightly vendor report needs this quarter's signed contract (PDF) to cite renewal terms.",
          name_hint: "vendor-contract-q4.pdf",
          accept: [".pdf"],
        },
        { session_id: FIXTURE_FILES_CRON_SESSION, ttl_s: 7 * 24 * 3600 },
      );
    }
  }
}
