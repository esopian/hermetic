/**
 * Agent ▸ Files, the bell's file-request rows and the fleet table's `▣ n`
 * badge (attachments plan §8.6, scenario D), over the real `bind` and
 * `dispatch` and the fixture backend, whose `corvid` carries one open PDF
 * request from a cron session, two inbox files, an outbox share and two
 * stored secrets (`fixture-files-seed.ts`).
 *
 * Assertions compare strings and booleans, never DOM nodes: a failing
 * `expect(node)` makes bun format the whole portal.
 */
import { cleanup, screen, userEvent, waitFor } from "../dom.ts";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFleetTarget } from "../../src/api/index.ts";
import { type FlowHarness, flowHarness, gotoHash, mountPortal, useTableLayout } from "./bridge.ts";

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
}, 20_000);

const WAIT = { timeout: 6_000 };
const PURPOSE = "The nightly vendor report needs this quarter's signed contract (PDF)";

const scratch = mkdtempSync(join(tmpdir(), "hermetic-flow-files-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The fixture fleet, the page pointed at `hash`, and the portal mounted. */
async function open(hash: string): Promise<FlowHarness> {
  harness = await flowHarness();
  setFleetTarget(harness.target);
  gotoHash(hash);
  mountPortal();
  return harness;
}

/** corvid's drawer, on its Files tab, once the box's listing is drawn. */
async function corvidFiles(): Promise<Element> {
  await open("#agent/corvid/files");
  return await waitFor(() => {
    const pane = document.querySelector(".fl-pane");
    if (pane === null) throw new Error("no Files tab yet");
    expect(pane.querySelector(".fl-entries") !== null).toBe(true);
    return pane;
  }, WAIT);
}

const text = (el: Element | null | undefined): string => el?.textContent ?? "";
const requestRows = (pane: Element) => Array.from(pane.querySelectorAll("tr[data-request]"));
const buttonIn = (el: Element | null | undefined, label: string): HTMLButtonElement | null =>
  Array.from(el?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label,
  ) ?? null;

/** The one open request's id, from the row the tab drew. */
function requestId(pane: Element): string {
  const id = requestRows(pane)[0]?.getAttribute("data-request");
  if (!id) throw new Error("no open request row");
  return id;
}

const slotOf = (id: string) => harness!.ctx.hermetic().files.internal.request("corvid", id);

test("corvid ▸ Files: the usage line, the cron session's request, and every stored entry", async () => {
  const pane = await corvidFiles();
  expect(text(pane.querySelector(".fl-usage"))).toMatch(
    /^inbox \d+(\.\d)? (B|KB|MB) · disk — · retention 7d$/,
  );

  await waitFor(() => expect(requestRows(pane).length).toBe(1), WAIT);
  const row = text(requestRows(pane)[0]);
  expect(row).toContain(PURPOSE);
  expect(row).toContain("normal");
  expect(row).toMatch(/\d+:\d\d:\d\d/);

  const entries = text(pane.querySelector(".fl-entries"));
  for (const name of [
    "vendor-contract-2026.pdf",
    "dashboard.png",
    "vendor-summary.csv",
    "file-github-app-pem",
    "env-github · GITHUB_TOKEN",
  ]) {
    expect(entries).toContain(name);
  }
  // A secret has no Save…, and no laptop path rotates its slot: Rotate is there, and dead.
  const pem = pane.querySelector('tr[data-entry="f_fxcorvidpem1"]');
  expect(buttonIn(pem, "Save…") === null).toBe(true);
  expect(buttonIn(pem, "Rotate")?.disabled).toBe(true);
  // Metadata only: the tab never asked for a byte of content.
  expect(harness!.calls.some((c) => c.name === "files.content" || c.name === "files.get")).toBe(false);
}, 20_000);

test("Decline answers the request on the box, and its row leaves", async () => {
  const pane = await corvidFiles();
  await waitFor(() => expect(requestRows(pane).length).toBe(1), WAIT);
  const id = requestId(pane);
  await userEvent.click(buttonIn(requestRows(pane)[0], "Decline")!);
  await waitFor(() => expect(requestRows(pane).length).toBe(0), WAIT);
  expect(text(pane)).toContain("No requests waiting on you.");
  expect((await slotOf(id)).state).toBe("declined");
}, 20_000);

test("Deliver… opens the chat's request card; a chosen PDF fulfils the slot", async () => {
  const pane = await corvidFiles();
  await waitFor(() => expect(requestRows(pane).length).toBe(1), WAIT);
  const id = requestId(pane);
  const pdf = join(scratch, "contract.pdf");
  writeFileSync(pdf, "%PDF-1.4\n% FIXTURE\n%%EOF\n");
  const ctx = harness!.ctx;
  ctx.native = { ...(ctx.native ?? {}), pickFiles: async () => [pdf] } as NonNullable<
    typeof ctx.native
  >;

  await userEvent.click(buttonIn(requestRows(pane)[0], "Deliver…")!);
  const card = () => pane.querySelector(".fl-card-row .ch-freq");
  await waitFor(() => expect(text(card())).toContain("▣ File requested"), WAIT);
  await waitFor(() => expect(buttonIn(card(), "Choose file…") !== null).toBe(true), WAIT);
  await userEvent.click(buttonIn(card(), "Choose file…")!);
  await waitFor(async () => expect((await slotOf(id)).state).toBe("fulfilled"), WAIT);
  await waitFor(() => expect(text(card())).toContain("delivered"), WAIT);

  // Closing the card re-reads the box: the request is answered, the file is in the inbox.
  await userEvent.click(buttonIn(pane.querySelector(".fl-card-foot"), "Close")!);
  await waitFor(() => expect(requestRows(pane).length).toBe(0), WAIT);
  await waitFor(
    () => expect(text(pane.querySelector(".fl-entries"))).toContain("vendor-contract-q4.pdf"),
    WAIT,
  );
}, 20_000);

test("Save… on an outbox share writes it into the folder the dialog chose", async () => {
  const pane = await corvidFiles();
  const folder = mkdtempSync(join(scratch, "save-"));
  const ctx = harness!.ctx;
  ctx.native = { ...(ctx.native ?? {}), pickFolder: async () => folder } as NonNullable<
    typeof ctx.native
  >;
  const row = () => pane.querySelector('tr[data-entry="sh_fxcorvidcsv1"]');
  await userEvent.click(buttonIn(row(), "Save vendor-summary.csv")!);
  await waitFor(() => expect(text(row())).toContain("Saved vendor-summary.csv"), WAIT);
  expect(existsSync(join(folder, "vendor-summary.csv"))).toBe(true);
}, 20_000);

test("Save… into a folder already holding that name says why in the operator's words", async () => {
  const pane = await corvidFiles();
  const folder = mkdtempSync(join(scratch, "taken-"));
  writeFileSync(join(folder, "vendor-summary.csv"), "FIXTURE already here\n");
  const ctx = harness!.ctx;
  ctx.native = { ...(ctx.native ?? {}), pickFolder: async () => folder } as NonNullable<
    typeof ctx.native
  >;
  const row = () => pane.querySelector('tr[data-entry="sh_fxcorvidcsv1"]');
  await userEvent.click(buttonIn(row(), "Save vendor-summary.csv")!);
  await waitFor(
    () =>
      expect(text(row())).toContain(
        "Not saved — a file with that name is already in that folder — choose another folder",
      ),
    WAIT,
  );
  expect(buttonIn(row(), "Save vendor-summary.csv")?.disabled).toBe(false);
  expect(readFileSync(join(folder, "vendor-summary.csv"), "utf8")).toBe("FIXTURE already here\n");
}, 20_000);

test("Delete on a stored text secret plans, names the SSM slot, and removes the row", async () => {
  const pane = await corvidFiles();
  const row = () => pane.querySelector('tr[data-entry="f_fxcorvidenv1"]');
  expect(row() !== null).toBe(true);
  await userEvent.click(buttonIn(row(), "Delete env-github · GITHUB_TOKEN")!);
  const confirm = () => pane.querySelector(".fl-confirm");
  await waitFor(() => expect(text(confirm())).toContain("SSM slot env-github"), WAIT);
  expect(text(confirm())).toContain("ssm —");
  // The confirm takes the keyboard: its first live button, Cancel.
  expect(document.activeElement?.textContent).toBe("Cancel");
  // Nothing is deleted before the confirm.
  expect(harness!.calls.some((c) => c.name === "apply")).toBe(false);
  await userEvent.click(buttonIn(confirm()?.querySelector(".confirm-actions"), "Delete")!);
  await waitFor(() => expect(row() === null).toBe(true), WAIT);
  expect(confirm() === null).toBe(true);
  expect(harness!.calls.some((c) => c.name === "apply")).toBe(true);
}, 20_000);

test("the fleet table badges corvid's one open request, and nothing on atlas", async () => {
  useTableLayout();
  await open("#fleet");
  const badge = (agent: string) =>
    document.querySelector(`[data-chat-agent="${agent}"] .tag-freq`)?.getAttribute("aria-label") ??
    null;
  await waitFor(() => expect(badge("corvid")).toBe("1 open file request"), WAIT);
  expect(text(document.querySelector('[data-chat-agent="corvid"] .tag-freq'))).toBe("▣ 1");
  expect(badge("atlas")).toBe(null);
  // Only running agents are asked, and only for their open requests.
  const asked = harness!.calls.filter((c) => c.name === "files.list");
  expect(asked.every((c) => (c.params as { requests?: boolean }).requests === true)).toBe(true);
  expect(asked.some((c) => (c.params as { name: string }).name === "juniper")).toBe(false);
}, 20_000);

test("the bell lists the request and opens corvid's Files tab", async () => {
  await open("#fleet");
  const bell = await screen.findByRole("button", { name: /^Notifications/ });
  await waitFor(() => expect(bell.getAttribute("aria-label") ?? "").toMatch(/need you/), WAIT);
  await userEvent.click(bell);
  const row = await waitFor(() => {
    const el = document.querySelector('.nt-freq [data-kind="file_request"]');
    if (el === null) throw new Error("no file-request row yet");
    return el;
  }, WAIT);
  expect(text(row)).toContain(`corvid requested a file: ${PURPOSE.slice(0, 40)}`);
  expect(text(row)).toContain("cron_nightly_vendor_report");
  await userEvent.click(row.querySelector("button.nt-hit")!);
  await waitFor(() => expect(window.location.hash).toBe("#agent/corvid/files"), WAIT);
  await waitFor(() => expect(document.querySelector(".fl-pane") !== null).toBe(true), WAIT);
}, 20_000);
