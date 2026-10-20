/**
 * An agent's text secret request (attachments plan §8.4b) over the real
 * `bind` and `dispatch` and the fixture backend: the card names the keys and
 * where they go; a single-line value submits on Enter; a multi-line request
 * opens in multi-line mode; "Treat as"
 * reaches the box; and a key nobody asked for blocks the submit (D10). The
 * value is never in the page's text and appears only encoded in the bounded
 * upload request.
 *
 * Assertions compare strings and booleans, never DOM nodes: a failing
 * `expect(node)` makes bun format the whole portal.
 */
import { cleanup, fireEvent, screen, userEvent, waitFor } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
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
const TOKEN = "FIXTURE_github_token_0123456789abcdef";

async function ask(
  prompt: string,
  hash = "#chat/atlas/scribe",
  name = /^Message Marshall/,
): Promise<() => Element | null> {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
  await harness.ctx.chatOwner.sync();
  setFleetTarget(harness.target);
  gotoHash(hash);
  mountPortal();
  const composer = await screen.findByRole("textbox", { name }, { timeout: 4_000 });
  const pane = composer.closest(".ch-thread")!;
  await userEvent.type(composer, `${prompt}{Enter}`);
  // The newest card: a long transcript may already hold older request cards.
  const card = () => Array.from(pane.querySelectorAll(".ch-freq")).at(-1) ?? null;
  await waitFor(() => expect(card()?.querySelector(".sti") !== null).toBe(true), WAIT);
  return card;
}

function requestId(): string {
  const call = harness!.calls.find((c) => c.name === "files.request.get");
  if (call === undefined) throw new Error("the card never read its slot");
  return (call.params as { request_id: string }).request_id;
}

const slotOf = (id: string) => harness!.ctx.hermetic().files.internal.request("atlas", id);
const field = (card: Element) =>
  card.querySelector<HTMLInputElement | HTMLTextAreaElement>(".sti input, .sti textarea")!;
const button = (card: Element, label: string) =>
  Array.from(card.querySelectorAll("button")).find((b) => b.textContent === label);

/** Typed text, as the field's own `input` handler reads it. */
function enter(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  fireEvent.input(el, { target: { value: text } });
}

/** Every string anywhere in a request's parameters. */
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (typeof v === "object" && v !== null) return Object.values(v).flatMap(strings);
  return [];
}

/** A string read as base64, or "" when it is not. */
function unb64(s: string): string {
  try {
    return atob(s);
  } catch {
    return "";
  }
}

/**
 * Nothing the operator typed ever left the card except as one bounded upload: not
 * in the page, not in plain text in any request, and in base64 only in
 * `files.secretText.upload` (the bytes on their way to the main process's upload
 * registry) — never in the `files.put` or anything else that names the upload.
 */
function neverLeaked(value: string, sent = true): void {
  expect(document.body.textContent?.includes(value)).toBe(false);
  const plain: string[] = [];
  const encoded: string[] = [];
  for (const call of harness!.calls) {
    const all = strings(call.params);
    if (all.some((s) => s.includes(value))) plain.push(call.name);
    if (all.some((s) => unb64(s).includes(value))) encoded.push(call.name);
  }
  expect(plain).toEqual([]);
  expect([...new Set(encoded)]).toEqual(sent ? ["files.secretText.upload"] : []);
}

test("a single-line secret submits on Enter and is stored, never shown", async () => {
  const card = await ask("open the PR E2E_TEXT_SECRET");
  const text = card()!.textContent ?? "";
  expect(text).toContain("◆ Secret requested · text");
  expect(text).toContain("GITHUB_TOKEN required");
  expect(text).toContain("SSM env-github · /run/hermetic/files/github.env");
  expect(text).toContain("the path and key names, never the value");
  const id = requestId();
  const el = field(card()!);
  expect(el.tagName).toBe("INPUT");
  enter(el, TOKEN);
  fireEvent.keyDown(el, { key: "Enter" });
  await waitFor(() => expect(card()?.textContent ?? "").toContain("secret delivered"), WAIT);
  expect(card()!.textContent).toMatch(
    /GITHUB_TOKEN → \/run\/hermetic\/files\/github\.env · \w+ · 1 key · .*value never shown/,
  );
  const slot = await slotOf(id);
  expect(slot.fulfilled?.keys).toEqual(["GITHUB_TOKEN"]);
  neverLeaked(TOKEN);
}, 20_000);

test("in a long transcript the newest secret request is a usable card", async () => {
  // `sx-atlas-portal` is the fixture's long catalogue transcript.
  const card = await ask(
    "open the PR E2E_TEXT_SECRET",
    "#chat/atlas/default?session=sx-atlas-portal",
    /^Message /,
  );
  const pane = card()!.closest(".ch-thread")!;
  expect(pane.querySelectorAll("[data-chat-message]").length).toBeGreaterThan(5);
  expect(card()!.textContent).toContain("GITHUB_TOKEN required");
  const id = requestId();
  const el = field(card()!);
  enter(el, TOKEN);
  fireEvent.keyDown(el, { key: "Enter" });
  await waitFor(() => expect(card()?.textContent ?? "").toContain("secret delivered"), WAIT);
  expect((await slotOf(id)).fulfilled?.keys).toEqual(["GITHUB_TOKEN"]);
  neverLeaked(TOKEN);
}, 20_000);

test("a multi-line request opens in multi-line mode and stores every key", async () => {
  const card = await ask("replica creds E2E_TEXT_SECRET_MULTI");
  const id = requestId();
  const el = field(card()!);
  expect(el.tagName).toBe("TEXTAREA");
  enter(el, "DB_USER=FIXTURE_user\nDB_PASS=FIXTURE_pass_value\nDB_URL=postgres://FIXTURE_host/db");
  await userEvent.click(button(card()!, "Submit secret")!);
  await waitFor(() => expect(card()?.textContent ?? "").toContain("secret delivered"), WAIT);
  expect((await slotOf(id)).fulfilled?.keys).toEqual(["DB_USER", "DB_PASS", "DB_URL"]);
  neverLeaked("FIXTURE_pass_value");
}, 20_000);

test("Treat as Raw value reaches the box, durable or just this once", async () => {
  // Durable: the laptop writes the slot, and the box records the format it was told.
  let card = await ask("E2E_TEXT_SECRET");
  let id = requestId();
  await userEvent.click(button(card()!, "Raw value")!);
  enter(field(card()!), "FIXTURE=looks=like=dotenv");
  await userEvent.click(button(card()!, "Submit secret")!);
  // The value starts like a key name: the card asks once before it sends.
  expect(card()!.textContent).toContain("looks like another key name");
  await userEvent.click(button(card()!, "Submit anyway?")!);
  await waitFor(() => expect(card()?.textContent ?? "").toContain("secret delivered"), WAIT);
  let slot = await slotOf(id);
  expect(slot.fulfilled?.format).toBe("raw");
  expect(slot.fulfilled?.keys).toEqual(["GITHUB_TOKEN"]);
  neverLeaked("FIXTURE=looks=like=dotenv");
  cleanup();
  await harness?.restore();
  reset();

  // Just this once: the text goes to the box itself, carrying the operator's choice.
  card = await ask("E2E_TEXT_SECRET");
  id = requestId();
  await userEvent.click(button(card()!, "Raw value")!);
  enter(field(card()!), "FIXTURE=once=like=dotenv");
  await userEvent.click(button(card()!, "Just this once (tmpfs, 1 h)")!);
  await userEvent.click(button(card()!, "Just this once anyway?")!);
  await waitFor(() => expect(card()?.textContent ?? "").toContain("secret delivered"), WAIT);
  expect(harness!.backend().files.lastSecretAs("atlas", id)).toBe("raw");
  slot = await slotOf(id);
  expect(slot.fulfilled?.ssm_slot).toBeUndefined();
  expect(slot.fulfilled?.keys).toEqual(["GITHUB_TOKEN"]);
  neverLeaked("FIXTURE=once=like=dotenv");
}, 30_000);

test("a key that was not requested blocks the submit (D10)", async () => {
  const card = await ask("E2E_TEXT_SECRET_MULTI");
  enter(
    field(card()!),
    "DB_USER=FIXTURE_a\nDB_PASS=FIXTURE_b\nDB_URL=FIXTURE_c\nAWS_SECRET_ACCESS_KEY=FIXTURE_extra",
  );
  await waitFor(
    () =>
      expect(card()?.textContent ?? "").toContain(
        "Line 4 sets a key that was not requested; remove it.",
      ),
    WAIT,
  );
  expect(button(card()!, "Submit secret")!.disabled).toBe(true);
  expect(
    harness!.calls.some((c) => c.name === "files.put" || c.name === "files.secretText.upload"),
  ).toBe(false);
  neverLeaked("FIXTURE_extra", false);
}, 20_000);

test("Esc in the field clears it and keeps the agent's turn running", async () => {
  const card = await ask("open the PR E2E_TEXT_SECRET");
  const el = field(card()!);
  enter(el, TOKEN);
  expect(field(card()!).value).toBe(TOKEN);
  fireEvent.keyDown(el, { key: "Escape" });
  await waitFor(() => expect(field(card()!).value).toBe(""), WAIT);
  // ChatShell's window handler stops a turn on Esc unless the target owns it.
  expect(harness!.calls.some((c) => c.name === "chat.abort")).toBe(false);
  expect(card()!.querySelector(".sti") !== null).toBe(true);
  expect(card()!.getAttribute("data-state")).toBe("open");
  neverLeaked(TOKEN, false);
}, 20_000);

test("Enter that commits an IME composition does not submit", async () => {
  const card = await ask("open the PR E2E_TEXT_SECRET");
  const el = field(card()!);
  enter(el, TOKEN);
  fireEvent.keyDown(el, { key: "Enter", keyCode: 229 });
  fireEvent.keyDown(el, { key: "Enter", isComposing: true });
  expect(harness!.calls.some((c) => c.name === "files.secretText.upload")).toBe(false);
  expect(field(card()!).value).toBe(TOKEN);
  neverLeaked(TOKEN, false);
}, 20_000);
