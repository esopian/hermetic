/**
 * The fleet's files settings on the box (`files/settings.ts`): `require_cap`
 * on the tailnet gate, `max_bytes` on uploads and request slots,
 * `retention_days` on the inbox — each read per use, so a manifest read
 * reaches the next request.
 */
import { describe, expect, test } from "bun:test";
import {
  FILES_APP_CAP,
  FILES_INBOX_DIR,
  FILES_LIMITS,
  FILES_RETENTION_DAYS,
} from "@hermetic/core/shared";
import { makeFilesSettings } from "../src/files/settings.ts";
import { type Whois, tailscaleWhois } from "../src/rpc.ts";
import { FakeHost } from "./fake-host.ts";
import { AGENT_NODE, MEMBER, TEXT, errorCode, filesBox, openSlot, post, put } from "./files-fixture.ts";

const DAY = 24 * 3600 * 1000;

describe("require_cap: the whois matrix on the files routes", () => {
  const WITH_CAP = "100.64.0.3";
  const WITHOUT_CAP = "100.64.0.4";
  const TAGGED = "100.64.0.5";
  const NO_WHOIS = "203.0.113.9";
  const peers: Record<string, Whois> = {
    [WITH_CAP]: { ...MEMBER, caps: [FILES_APP_CAP] },
    [WITHOUT_CAP]: { ...MEMBER, login: "guest@example.com", caps: ["example.com/cap/other"] },
    [TAGGED]: { ...AGENT_NODE, caps: [FILES_APP_CAP] },
  };

  async function matrix(requireCap: boolean): Promise<Record<string, number>> {
    const settings = makeFilesSettings({ files: { require_cap: requireCap } });
    const box = await filesBox({ settings: settings.current, whois: (ip) => peers[ip] ?? null });
    const out: Record<string, number> = {};
    for (const [label, ip] of Object.entries({ WITH_CAP, WITHOUT_CAP, TAGGED, NO_WHOIS })) {
      out[label] = (await box.fetch("/files", undefined, ip)).status;
    }
    return out;
  }

  test("off: any untagged member; a tagged node and an unknown peer never", async () => {
    expect(await matrix(false)).toEqual({
      WITH_CAP: 200,
      WITHOUT_CAP: 200,
      TAGGED: 403,
      NO_WHOIS: 403,
    });
  });

  test("on: only an untagged member whose whois carries the files capability", async () => {
    expect(await matrix(true)).toEqual({ WITH_CAP: 200, WITHOUT_CAP: 403, TAGGED: 403, NO_WHOIS: 403 });
  });

  test("on: the refusal is a FORBIDDEN naming the capability, audited, and nothing is written", async () => {
    const settings = makeFilesSettings({ files: { require_cap: true } });
    const box = await filesBox({ settings: settings.current, whois: (ip) => peers[ip] ?? null });
    const res = await box.fetch("/files/stage/a.txt", put(TEXT), WITHOUT_CAP);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain(FILES_APP_CAP);
    expect(box.audit).toContain(`files stage refused: login=guest@example.com lacks ${FILES_APP_CAP}`);
    expect(box.host.streamWrites).toEqual([]);
  });

  test("a change takes effect at the next request, with no restart", async () => {
    const settings = makeFilesSettings(null);
    const box = await filesBox({ settings: settings.current, whois: (ip) => peers[ip] ?? null });
    expect((await box.fetch("/files", undefined, WITHOUT_CAP)).status).toBe(200);
    settings.update({ files: { require_cap: true } });
    expect((await box.fetch("/files", undefined, WITHOUT_CAP)).status).toBe(403);
    expect((await box.fetch("/files", undefined, WITH_CAP)).status).toBe(200);
  });

  test("tailscaleWhois reads the CapMap's keys as the caller's capabilities", async () => {
    const host = new FakeHost();
    host.when(/tailscale whois/, {
      stdout: JSON.stringify({
        Node: { Name: "laptop.tailnet.ts.net", Tags: [] },
        UserProfile: { LoginName: "evan@example.com" },
        CapMap: { [FILES_APP_CAP]: [{}], "example.com/cap/x": null },
      }),
    });
    const who = await tailscaleWhois(host)("100.64.0.3");
    expect(who?.caps).toEqual([FILES_APP_CAP, "example.com/cap/x"]);

    host.when(/tailscale whois/, {
      stdout: JSON.stringify({ Node: { Name: "n" }, UserProfile: { LoginName: "l" } }),
    });
    expect((await tailscaleWhois(host)("100.64.0.3"))?.caps).toEqual([]);
  });
});

describe("max_bytes from the manifest", () => {
  test("caps a stage and a request slot; the default until a manifest says otherwise", async () => {
    const settings = makeFilesSettings(null);
    const box = await filesBox({ settings: settings.current });
    const big = new Uint8Array(TEXT.byteLength + 1).fill(0x61);
    expect((await box.fetch("/files/stage/a.txt", put(big))).status).toBe(201);
    expect(settings.current().max_bytes).toBe(FILES_LIMITS.fileBytes);

    settings.update({ files: { max_bytes: TEXT.byteLength } });
    const over = await box.fetch("/files/stage/b.txt", put(big));
    expect(over.status).toBe(413);
    expect(await errorCode(over)).toBe("FILE_TOO_LARGE");
    expect((await box.fetch("/files/stage/c.txt", put(TEXT))).status).toBe(201);

    // A slot the agent opens is clamped to the fleet's cap, whatever it asked for.
    const slot = await openSlot(box.socket, { max_bytes: 1024 * 1024 });
    const listed = (await (await box.fetch("/files/requests")).json()) as {
      requests: Array<{ request_id: string; max_bytes: number }>;
    };
    expect(listed.requests.find((r) => r.request_id === slot.request_id)?.max_bytes).toBe(
      TEXT.byteLength,
    );
    const fulfil = await box.fetch(`/files/requests/${slot.request_id}`, put(big));
    expect(fulfil.status).toBe(413);
  });

  test("a value over the ceiling is clamped to it, never raised past it", () => {
    const settings = makeFilesSettings({ files: { max_bytes: FILES_LIMITS.fileBytes * 4 } });
    expect(settings.current().max_bytes).toBe(FILES_LIMITS.fileBytes);
  });
});

describe("retention_days from the manifest", () => {
  test("drives a committed file's expiry, the listing's retention, and the sweeper", async () => {
    const settings = makeFilesSettings({ files: { retention_days: 2 } });
    const box = await filesBox({ settings: settings.current });
    const staged = (await (await box.fetch("/files/stage/a.txt", put(TEXT))).json()) as { id: string };
    const { path } = (await (await box.fetch(`/files/${staged.id}/commit`, post({}))).json()) as {
      path: string;
    };
    const entry = box.index().entries.find((e) => e.id === staged.id);
    expect(entry?.expires_at).toBe(new Date(box.host.now().getTime() + 2 * DAY).toISOString());

    const listed = (await (await box.fetch("/files")).json()) as { usage: { retention_days: number } };
    expect(listed.usage.retention_days).toBe(2);

    box.host.advance(2 * DAY - 1000);
    await box.service.sweep();
    expect(box.host.files.has(path)).toBe(true);
    box.host.advance(2000);
    const report = await box.service.sweep();
    expect(report.removed).toBe(1);
    expect(box.host.files.has(path)).toBe(false);

    // The disk pass ages dated inbox directories by the same retention.
    const inboxFind = box.host.commands.filter((c) =>
      c.includes(`find ${FILES_INBOX_DIR} -mindepth 1 -maxdepth 1 -name ????-??-??`),
    );
    expect(inboxFind.at(-1)).toContain(`-mmin +${2 * 24 * 60}`);
  });

  test("defaults to 7 days, and is clamped to its bounds", () => {
    expect(makeFilesSettings(null).current().retention_days).toBe(FILES_RETENTION_DAYS.default);
    expect(makeFilesSettings({ files: { retention_days: 0 } }).current().retention_days).toBe(
      FILES_RETENTION_DAYS.min,
    );
    expect(makeFilesSettings({ files: { retention_days: 9999 } }).current().retention_days).toBe(
      FILES_RETENTION_DAYS.max,
    );
  });
});

describe("the settings holder", () => {
  test("logs a change once, and says nothing when a re-read changes nothing", () => {
    const logged: string[] = [];
    const settings = makeFilesSettings(null, (m) => void logged.push(m));
    settings.update(null);
    settings.update({ files: { require_cap: true, retention_days: 3 } });
    settings.update({ files: { require_cap: true, retention_days: 3 } });
    expect(logged).toEqual([
      `files: fleet settings now require_cap=on max_bytes=${FILES_LIMITS.fileBytes} retention_days=3`,
    ]);
  });
});
