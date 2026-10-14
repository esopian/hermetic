/**
 * An agent's file request (attachments plan §8.3) over the real `bind` and
 * `dispatch` and the fixture backend: the card draws from the box's slot, a
 * dropped file is delivered and the waiting turn picks it up, a decline and a
 * timeout close the card with words, a file the box refuses keeps it open,
 * and a file that arrives after the agent stopped waiting offers to tell it.
 *
 * Assertions compare strings and booleans, never DOM nodes: a failing
 * `expect(node)` makes bun format the whole portal.
 */
import { cleanup, fireEvent, screen, userEvent, waitFor } from "../dom.ts";
import { afterEach, afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
}, 20_000);

const WAIT = { timeout: 6_000 };

async function ask(prompt: string): Promise<{ pane: Element; card: () => Element | null }> {
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
  await userEvent.type(composer, `${prompt}{Enter}`);
  const card = () => pane.querySelector(".ch-freq");
  await waitFor(() => expect(card()?.textContent ?? "").toContain("Drop a file here or choose…"), WAIT);
  return { pane, card };
}

/** The slot id the card read from the box. */
function requestId(): string {
  const call = harness!.calls.find((c) => c.name === "files.request.get");
  if (call === undefined) throw new Error("the card never read its slot");
  return (call.params as { request_id: string }).request_id;
}

function drop(target: Element, files: File[]): void {
  const dataTransfer = { types: ["Files"], files, dropEffect: "none" };
  fireEvent.dragEnter(target, { dataTransfer });
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}

const button = (card: Element, label: string) =>
  Array.from(card.querySelectorAll("button")).find((b) => b.textContent === label);

const PEM = "-----BEGIN OPENSSH PRIVATE KEY-----\nFIXTURE\n-----END OPENSSH PRIVATE KEY-----\n";

const picks = mkdtempSync(join(tmpdir(), "hermetic-flow-pick-"));
afterAll(() => rmSync(picks, { recursive: true, force: true }));

/** The desktop shell's open dialog, answering `paths` the next time it opens. */
function stubPicker(paths: string[]): void {
  const ctx = harness!.ctx;
  ctx.native = {
    ...(ctx.native ?? {}),
    pickFiles: async () => paths,
  } as NonNullable<typeof ctx.native>;
}

const slotOf = (id: string) => harness!.ctx.hermetic().files.internal.request("atlas", id);

test("the card draws from the box's slot, and a dropped file is delivered", async () => {
  const { pane, card } = await ask("pull the logs E2E_FILE_REQUEST");
  const text = card()!.textContent ?? "";
  expect(text).toContain("▣ File requested");
  expect(text).toMatch(/expires in \d:\d\d:\d\d/);
  expect(text).toContain("“Raw nginx access log for 2026-10-12 01:30–02:30");
  expect(text).toContain("inbox · deleted after 7 days");
  expect(text).toContain(".log .txt .gz · ≤ 256 MB");
  expect(text).toContain("access-2026-10-12.log");
  // The purpose is text, never a link the agent wrote.
  expect(card()!.querySelector(".ch-freq-purpose a") === null).toBe(true);
  // Never folded into the turn's tool group, and never collapsible.
  expect(card()!.closest(".ch-activity-group") === null).toBe(true);
  expect(card()!.querySelector("[aria-expanded]") === null).toBe(true);

  const id = requestId();
  drop(card()!.querySelector(".ch-freq-drop")!, [
    new File(["127.0.0.1 - - GET /\n"], "access-2026-10-12.log", { type: "text/plain" }),
  ]);
  await waitFor(() => expect(card()?.textContent ?? "").toContain("delivered"), WAIT);
  await waitFor(
    () =>
      expect(card()?.textContent ?? "").toMatch(/access-2026-10-12\.log · \d+ B · sha [0-9a-f]{4}…/),
    WAIT,
  );
  expect(harness!.calls.some((c) => c.name === "files.put")).toBe(true);
  // The composer never saw the drop.
  expect(harness!.calls.some((c) => c.name === "files.stage")).toBe(false);
  expect((await slotOf(id)).state).toBe("fulfilled");
  // The waiting turn picked it up.
  await waitFor(() => expect(pane.textContent).toContain("is on the box. Reading it now."), WAIT);
}, 20_000);

test("decline tells the agent, and the card says so", async () => {
  const { pane, card } = await ask("E2E_FILE_REQUEST");
  const id = requestId();
  const decline = Array.from(card()!.querySelectorAll("button")).find(
    (b) => b.textContent === "Decline",
  )!;
  await userEvent.click(decline);
  await waitFor(
    () => expect(card()?.textContent ?? "").toContain("You declined. atlas was told."),
    WAIT,
  );
  expect((await slotOf(id)).state).toBe("declined");
  expect(card()!.querySelector(".ch-freq-drop") === null).toBe(true);
  await waitFor(() => expect(pane.textContent).toContain("Understood — I won't use it."), WAIT);
}, 20_000);

test("a request that times out on the box reads as expired", async () => {
  const { card } = await ask("E2E_FILE_REQUEST");
  const id = requestId();
  harness!.backend().files.expire("atlas", id);
  await waitFor(
    () =>
      expect(card()?.textContent ?? "").toContain("No file within 2 h. Ask atlas to request again."),
    WAIT,
  );
  expect(card()!.querySelector(".ch-freq-drop") === null).toBe(true);
}, 20_000);

test("a file the box refuses keeps the card open with the box's words", async () => {
  const { card } = await ask("E2E_FILE_REQUEST");
  const id = requestId();
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  drop(card()!.querySelector(".ch-freq-drop")!, [new File([PNG], "chart.png", { type: "image/png" })]);
  await waitFor(() => expect(card()?.textContent ?? "").toContain("rejected by box"), WAIT);
  expect(card()!.textContent).toContain("Nothing was stored. Choose another file.");
  expect((await slotOf(id)).state).toBe("open");
  // Still open: another file can be dropped.
  expect(card()!.querySelector(".ch-freq-drop") !== null).toBe(true);
}, 20_000);

test("a key-looking file on a normal request asks, and 'This isn't a secret' overrides D6", async () => {
  const { card } = await ask("E2E_FILE_REQUEST");
  const id = requestId();
  const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nFIXTURE\n-----END OPENSSH PRIVATE KEY-----\n";
  drop(card()!.querySelector(".ch-freq-drop")!, [new File([pem], "notes.txt", { type: "text/plain" })]);
  await waitFor(
    () =>
      expect(card()?.textContent ?? "").toContain(
        "Looks like a private key — it will be stored as a secret.",
      ),
    WAIT,
  );
  // Held for the operator's answer: nothing is sent yet.
  expect(harness!.calls.some((c) => c.name === "files.put")).toBe(false);
  expect(harness!.calls.some((c) => c.name === "files.chunk.open")).toBe(false);
  const override = Array.from(card()!.querySelectorAll("button")).find(
    (b) => b.textContent === "This isn't a secret",
  )!;
  await userEvent.click(override);
  await waitFor(() => expect(harness!.calls.some((c) => c.name === "files.put")).toBe(true), WAIT);
  const put = harness!.calls.find((c) => c.name === "files.put")!;
  expect((put.params as { not_secret?: boolean }).not_secret).toBe(true);
  await waitFor(async () => expect((await slotOf(id)).fulfilled?.class).toBe("file"), WAIT);
}, 20_000);

test("a file delivered after the agent stopped waiting offers to tell it", async () => {
  const { pane, card } = await ask("E2E_FILE_REQUEST_TIMEOUT");
  const id = requestId();
  // The plugin gives up after its wait and the turn ends with `pending`.
  await waitFor(() => expect(pane.textContent).toContain("Nothing has arrived yet."), WAIT);
  drop(card()!.querySelector(".ch-freq-drop")!, [
    new File(["127.0.0.1 - - GET /\n"], "access.log", { type: "text/plain" }),
  ]);
  await waitFor(
    () => expect(card()?.textContent ?? "").toContain("delivered after the turn ended"),
    WAIT,
  );
  expect(card()!.textContent).toMatch(/atlas stopped waiting at \d\d:\d\d\. The file is on the box\./);
  const slot = await slotOf(id);
  const turnsBefore = harness!.calls.filter((c) => c.name === "chat.turn").length;
  const tell = Array.from(card()!.querySelectorAll("button")).find(
    (b) => b.textContent === "Tell atlas & continue",
  )!;
  await userEvent.click(tell);
  await waitFor(
    () => expect(harness!.calls.filter((c) => c.name === "chat.turn").length).toBe(turnsBefore + 1),
    WAIT,
  );
  const sent = harness!.calls.filter((c) => c.name === "chat.turn").at(-1)!;
  expect((sent.params as { message: string }).message).toBe(
    `[hermetic] File for request ${id} delivered: ${slot.fulfilled!.path}`,
  );
  // Remounted, the card never offers to tell the agent a second time.
  cleanup();
  mountPortal();
  const again = await screen.findByRole("textbox", { name: /^Message Marshall/ }, { timeout: 4_000 });
  const pane2 = again.closest(".ch-thread")!;
  await waitFor(() => expect(pane2.querySelector(".ch-freq") !== null).toBe(true), WAIT);
  await waitFor(
    () => expect(harness!.calls.filter((c) => c.name === "files.request.get").length > 2).toBe(true),
    WAIT,
  );
  expect(button(pane2.querySelector(".ch-freq")!, "Tell atlas & continue") === undefined).toBe(true);
  expect(harness!.calls.filter((c) => c.name === "chat.turn").length).toBe(turnsBefore + 1);
}, 20_000);

test("'Store as secret' on a key-looking drop stores it durably in SSM, not just once", async () => {
  const { card } = await ask("E2E_FILE_REQUEST");
  const id = requestId();
  drop(card()!.querySelector(".ch-freq-drop")!, [new File([PEM], "notes.txt", { type: "text/plain" })]);
  await waitFor(() => expect(button(card()!, "Store as secret") !== undefined).toBe(true), WAIT);
  expect(harness!.calls.some((c) => c.name === "files.put")).toBe(false);
  await userEvent.click(button(card()!, "Store as secret")!);
  await waitFor(() => expect(harness!.calls.some((c) => c.name === "files.put")).toBe(true), WAIT);
  const put = harness!.calls.find((c) => c.name === "files.put")!;
  expect((put.params as { secret?: boolean }).secret).toBe(true);
  await waitFor(async () => expect((await slotOf(id)).fulfilled?.class).toBe("secret"), WAIT);
  const ssm = (await slotOf(id)).fulfilled?.ssm_slot ?? "";
  expect(ssm.startsWith("file-")).toBe(true);
  const params = [...harness!.backend().params.keys()];
  expect(params.some((k) => k.endsWith(`/atlas/${ssm}`))).toBe(true);
}, 20_000);

test("a key picked with Choose file… asks first, and Cancel lets the upload go", async () => {
  const { card } = await ask("E2E_FILE_REQUEST");
  const id = requestId();
  const key = join(picks, "deploy-key.txt");
  writeFileSync(key, PEM);
  stubPicker([key]);
  await userEvent.click(button(card()!, "Choose file…")!);
  await waitFor(
    () =>
      expect(card()?.textContent ?? "").toContain(
        "Looks like a private key — it will be stored as a secret.",
      ),
    WAIT,
  );
  expect(harness!.calls.some((c) => c.name === "files.put")).toBe(false);
  const picked = await harness!.calls.find((c) => c.name === "files.pickNative");
  expect(picked !== undefined).toBe(true);
  await userEvent.click(button(card()!, "Cancel")!);
  await waitFor(
    () => expect(harness!.calls.some((c) => c.name === "files.chunk.discard")).toBe(true),
    WAIT,
  );
  expect(card()!.textContent).not.toContain("Looks like a private key");
  // Asked again, the operator stores it as a secret.
  await userEvent.click(button(card()!, "Choose file…")!);
  await waitFor(() => expect(button(card()!, "Store as secret") !== undefined).toBe(true), WAIT);
  await userEvent.click(button(card()!, "Store as secret")!);
  await waitFor(async () => expect((await slotOf(id)).fulfilled?.class).toBe("secret"), WAIT);
  const put = harness!.calls.find((c) => c.name === "files.put")!;
  expect((put.params as { secret?: boolean }).secret).toBe(true);
}, 20_000);

test("a plain picked file is sent with no question", async () => {
  const { card } = await ask("E2E_FILE_REQUEST");
  const id = requestId();
  const log = join(picks, "access.log");
  writeFileSync(log, "127.0.0.1 - - GET /\n");
  stubPicker([log]);
  await userEvent.click(button(card()!, "Choose file…")!);
  await waitFor(async () => expect((await slotOf(id)).state).toBe("fulfilled"), WAIT);
  expect(card()!.textContent).not.toContain("Looks like a private key");
}, 20_000);

test("a file dragged over the card body is neither the composer's nor shown as its drop", async () => {
  const { pane, card } = await ask("E2E_FILE_REQUEST");
  const dataTransfer = { types: ["Files"], files: [new File(["x"], "a.log")], dropEffect: "none" };
  // Elsewhere on the pane, the composer's overlay shows: the check below means something.
  const composer = pane.querySelector(".ch-composer") ?? pane;
  fireEvent.dragEnter(composer, { dataTransfer });
  await waitFor(() => expect(pane.querySelector(".ch-drop") !== null).toBe(true), WAIT);
  const body = card()!.querySelector(".ch-freq-facts")!;
  fireEvent.dragEnter(body, { dataTransfer });
  fireEvent.dragOver(body, { dataTransfer });
  await waitFor(() => expect(pane.querySelector(".ch-drop") === null).toBe(true), WAIT);
  fireEvent.drop(body, { dataTransfer });
  expect(pane.querySelector(".ch-drop") === null).toBe(true);
  expect(harness!.calls.some((c) => c.name === "files.chunk.open")).toBe(false);
  expect(harness!.calls.some((c) => c.name === "files.stage")).toBe(false);
  expect(harness!.calls.some((c) => c.name === "files.put")).toBe(false);
}, 20_000);
