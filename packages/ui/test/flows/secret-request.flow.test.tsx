/**
 * An agent's secret file request (attachments plan §8.4) over the real `bind`
 * and `dispatch` and the fixture backend: the card is `--warn`, says where the
 * secret goes and where it never goes, shows no preview of any kind, and once
 * delivered says the contents are never shown — and the key's bytes never
 * reach the page's text. "Just this once" goes to tmpfs, not SSM.
 *
 * Assertions compare strings and booleans, never DOM nodes: a failing
 * `expect(node)` makes bun format the whole portal.
 */
import { cleanup, fireEvent, screen, userEvent, waitFor } from "../dom.ts";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSecretEnvelope, encodeSecretEnvelope } from "@hermetic/core/shared";
import { setFleetTarget } from "../../src/api/index.ts";
import { type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

let harness: FlowHarness | null = null;

function reset(): void {
  window.localStorage.removeItem("hermetic.layout");
  window.sessionStorage.clear();
  gotoHash("");
}

beforeEach(reset);

afterEach(async () => {
  cleanup();
  await harness?.restore();
  harness = null;
  reset();
});

const WAIT = { timeout: 6_000 };
const BODY = "FIXTURE-PEM-BODY-NOT-A-REAL-KEY";
const PEM = `-----BEGIN PRIVATE KEY-----\n${BODY}\n-----END PRIVATE KEY-----\n`;

async function ask(): Promise<{ pane: Element; card: () => Element | null }> {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
  await harness.ctx.chatOwner.sync();
  setFleetTarget(harness.target);
  gotoHash("#chat/atlas/scribe");
  mountPortal();
  const composer = await screen.findByRole(
    "textbox",
    { name: /^Message Marshall/ },
    { timeout: 4_000 },
  );
  const pane = composer.closest(".ch-thread")!;
  await userEvent.type(composer, "mint tokens E2E_SECRET_REQUEST{Enter}");
  const card = () => pane.querySelector(".ch-freq");
  await waitFor(
    () => expect(card()?.textContent ?? "").toContain("Drop the key here or choose…"),
    WAIT,
  );
  return { pane, card };
}

function requestId(): string {
  const call = harness!.calls.find((c) => c.name === "files.request.get");
  if (call === undefined) throw new Error("the card never read its slot");
  return (call.params as { request_id: string }).request_id;
}

const slotOf = (id: string) => harness!.ctx.hermetic().files.internal.request("atlas", id);
const button = (card: Element, label: string) =>
  Array.from(card.querySelectorAll("button")).find((b) => b.textContent === label);

test("the secret card says where the key goes, and never shows it", async () => {
  const { pane, card } = await ask();
  const text = card()!.textContent ?? "";
  expect(card()!.classList.contains("secret")).toBe(true);
  expect(text).toContain("◆ Secret requested");
  // Before a file is chosen the name is the rule, not a promise of the hint.
  const rule =
    "named after the request's hint (github-app.pem) when your file has the same extension, otherwise your file's name";
  expect(text).toContain(`encrypted SSM slot file-… · ${rule}`);
  expect(text).toContain(`/run/hermetic/files/… · tmpfs · 0600 · ${rule}`);
  expect(text.includes("file-github-app-pem")).toBe(false);
  expect(text).toContain("written to /data · previewed · cached on this Mac");
  expect(text).toContain(".pem · ≤ 4 KB");
  expect(button(card()!, "Choose file…") !== undefined).toBe(true);
  expect(button(card()!, "Just this once (tmpfs, 1 h)") !== undefined).toBe(true);
  expect(button(card()!, "Decline") !== undefined).toBe(true);

  const id = requestId();
  const dataTransfer = {
    types: ["Files"],
    files: [new File([PEM], "github-app.pem", { type: "application/x-pem-file" })],
    dropEffect: "none",
  };
  const zone = card()!.querySelector(".ch-freq-drop")!;
  fireEvent.dragEnter(zone, { dataTransfer });
  fireEvent.dragOver(zone, { dataTransfer });
  fireEvent.drop(zone, { dataTransfer });
  await waitFor(() => expect(card()?.textContent ?? "").toContain("secret delivered"), WAIT);
  const done = card()!.textContent ?? "";
  expect(done).toContain("encrypted SSM slot file-github-app-pem");
  expect(done).toContain("/run/hermetic/files/github-app.pem · tmpfs · 0600");
  expect(done).toContain("contents never shown");
  expect(done).toContain("github-app.pem → slot file-github-app-pem");
  // No thumbnail, no preview, no bytes on the page at any point.
  expect(card()!.querySelector("img, .ch-shot, .ch-shot-fake, .ch-attach-thumb, pre") === null).toBe(
    true,
  );
  expect(document.body.textContent?.includes(BODY)).toBe(false);
  const slot = await slotOf(id);
  expect(slot.state).toBe("fulfilled");
  expect(slot.fulfilled?.class).toBe("secret");
  expect(slot.fulfilled?.ssm_slot).toBe("file-github-app-pem");
  await waitFor(() => expect(pane.textContent).toContain("is on the box. Reading it now."), WAIT);
  expect(document.body.textContent?.includes(BODY)).toBe(false);
}, 20_000);

test("'Just this once' sends the picked key to tmpfs, not SSM", async () => {
  const { card } = await ask();
  const id = requestId();
  // The native dialog, played by the main process's own upload registry.
  const uploads = harness!.ctx.hermetic().files.internal.uploads;
  const bytes = new TextEncoder().encode(PEM);
  const { upload_id } = uploads.open({ name: "github-app.pem", size: bytes.byteLength });
  uploads.append(upload_id, 0, bytes);
  uploads.close(upload_id);
  harness!.intercept("files.pickNative", () => ({
    files: [{ upload_id, name: "github-app.pem", size: bytes.byteLength }],
  }));
  await userEvent.click(button(card()!, "Just this once (tmpfs, 1 h)")!);
  await waitFor(() => expect(card()?.textContent ?? "").toContain("secret delivered"), WAIT);
  const put = harness!.calls.find((c) => c.name === "files.put")!;
  expect((put.params as { ephemeral?: boolean }).ephemeral).toBe(true);
  // The page named the upload, never a path.
  expect(JSON.stringify(put.params).includes("/")).toBe(false);
  const slot = await slotOf(id);
  expect(slot.fulfilled?.class).toBe("secret");
  expect(slot.fulfilled?.ssm_slot).toBeUndefined();
  expect(card()!.textContent).toContain("→ tmpfs");
  expect(document.body.textContent?.includes(BODY)).toBe(false);
}, 20_000);

/** A stored secret already in the slot the drop would be written to. */
function seedStored(slot: string, text: string): { param: string; before: string } {
  const bytes = new TextEncoder().encode(text);
  const before = encodeSecretEnvelope({
    name: "github-app.pem",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const param = `/hermes/${harness!.target.fleet_id}/atlas/${slot}`;
  harness!.backend().params.set(param, before);
  return { param, before };
}

function dropKey(card: Element, name: string): void {
  const dataTransfer = {
    types: ["Files"],
    files: [new File([PEM], name, { type: "application/x-pem-file" })],
    dropEffect: "none",
  };
  const zone = card.querySelector(".ch-freq-drop")!;
  fireEvent.dragEnter(zone, { dataTransfer });
  fireEvent.dragOver(zone, { dataTransfer });
  fireEvent.drop(zone, { dataTransfer });
}

const putCalls = () => harness!.calls.filter((c) => c.name === "files.put");

test("a stored secret in the slot asks first; Replace writes over it and delivers", async () => {
  const { card } = await ask();
  const id = requestId();
  const { param, before } = seedStored("file-github-app-pem", "FIXTURE-previous-key");
  // Dropped under another name: the preview names it as core will, after the hint.
  dropKey(card()!, "my-key.pem");
  await waitFor(
    () =>
      expect(card()?.textContent ?? "").toContain(
        "This replaces the stored secret file-github-app-pem.",
      ),
    WAIT,
  );
  const asking = card()!.textContent ?? "";
  expect(asking).toContain("encrypted SSM slot file-github-app-pem");
  expect(asking).toContain("/run/hermetic/files/github-app.pem · tmpfs · 0600");
  expect(asking.includes("rejected by box")).toBe(false);
  expect(asking.includes("my-key.pem")).toBe(false);
  expect(harness!.backend().params.get(param)).toBe(before);
  expect((await slotOf(id)).state).toBe("open");
  expect(putCalls().length).toBe(1);
  expect((putCalls()[0]!.params as { replace?: boolean }).replace).toBeUndefined();

  await userEvent.click(button(card()!, "Replace")!);
  await waitFor(() => expect(card()?.textContent ?? "").toContain("secret delivered"), WAIT);
  expect(putCalls().length).toBe(2);
  expect((putCalls()[1]!.params as { replace?: boolean }).replace).toBe(true);
  const stored = decodeSecretEnvelope(harness!.backend().params.get(param) ?? "");
  expect(new TextDecoder().decode(stored?.bytes)).toBe(PEM);
  expect((await slotOf(id)).fulfilled?.ssm_slot).toBe("file-github-app-pem");
  expect(document.body.textContent?.includes(BODY)).toBe(false);
}, 20_000);

test("Cancel on the replace question writes nothing and leaves the request open", async () => {
  const { card } = await ask();
  const id = requestId();
  const { param, before } = seedStored("file-github-app-pem", "FIXTURE-previous-key");
  dropKey(card()!, "github-app.pem");
  await waitFor(() => expect(button(card()!, "Replace") !== undefined).toBe(true), WAIT);
  expect(card()!.textContent ?? "").toContain("encrypted SSM slot file-github-app-pem");
  await userEvent.click(button(card()!, "Cancel")!);
  await waitFor(() => expect(button(card()!, "Replace") === undefined).toBe(true), WAIT);
  expect(card()!.textContent?.includes("This replaces the stored secret")).toBe(false);
  // The preview forgets the cancelled file: back to the rule, no name.
  const after = card()!.textContent ?? "";
  expect(after).toContain("encrypted SSM slot file-… · named after");
  expect(after.includes("file-github-app-pem")).toBe(false);
  // Back to choosing: the drop zone and the foot are offered again.
  expect(card()!.querySelector(".ch-freq-drop") !== null).toBe(true);
  expect(button(card()!, "Choose file…") !== undefined).toBe(true);
  expect(putCalls().length).toBe(1);
  expect(harness!.backend().params.get(param)).toBe(before);
  expect((await slotOf(id)).state).toBe("open");
}, 20_000);

const picks = mkdtempSync(join(tmpdir(), "hermetic-flow-secret-pick-"));
afterAll(() => rmSync(picks, { recursive: true, force: true }));

test("the slot expiring under the replace question lets a native pick's upload go", async () => {
  const { card } = await ask();
  const id = requestId();
  const { param, before } = seedStored("file-github-app-pem", "FIXTURE-previous-key");
  const key = join(picks, "github-app.pem");
  writeFileSync(key, PEM);
  const ctx = harness!.ctx;
  ctx.native = {
    ...(ctx.native ?? {}),
    pickFiles: async () => [key],
  } as NonNullable<typeof ctx.native>;
  await userEvent.click(button(card()!, "Choose file…")!);
  await waitFor(() => expect(button(card()!, "Replace") !== undefined).toBe(true), WAIT);
  // Core kept the pick registered for the answer; nothing discarded it yet.
  expect(harness!.calls.some((c) => c.name === "files.chunk.discard")).toBe(false);
  harness!.backend().files.expire("atlas", id);
  await waitFor(() => expect(card()?.textContent ?? "").toContain("expired"), WAIT);
  await waitFor(
    () => expect(harness!.calls.some((c) => c.name === "files.chunk.discard")).toBe(true),
    WAIT,
  );
  expect(card()!.textContent?.includes("This replaces the stored secret")).toBe(false);
  expect(putCalls().length).toBe(1);
  expect(harness!.backend().params.get(param)).toBe(before);
}, 20_000);
