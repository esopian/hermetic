/**
 * Files the agent shares with the operator (attachments plan §8.5, scenario E)
 * over the real `bind` and `dispatch` and the fixture backend: `share_file`
 * draws a card per file, and so does a reply that names its files only on
 * `MEDIA:` lines (`E2E_MEDIA_SHARE`, what hermetic's platform hint teaches); an image is shown only once its bytes hash to the
 * shared sha256 (and never read for one when the share names no full digest),
 * Save… goes through the folder dialog into the folder it
 * chose, and a refused share shows the box's words instead of a card.
 *
 * Assertions compare strings and booleans, never DOM nodes: a failing
 * `expect(node)` makes bun format the whole portal.
 */
import { cleanup, render, screen, userEvent, waitFor } from "../dom.ts";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HermeticError } from "@hermetic/core";
import { setFleetTarget } from "../../src/api/index.ts";
import { Block } from "../../src/chat/components/blocks/index.tsx";
import { type FakeServer, fakeServer } from "../fake-transport.ts";
import { type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

let harness: FlowHarness | null = null;
let server: FakeServer | null = null;

function reset(): void {
  window.localStorage.removeItem("hermetic.layout");
  window.sessionStorage.clear();
  gotoHash("");
}

beforeEach(reset);

afterEach(async () => {
  cleanup();
  server?.restore();
  server = null;
  await harness?.restore();
  harness = null;
  reset();
}, 20_000);

const WAIT = { timeout: 6_000 };

const folders = mkdtempSync(join(tmpdir(), "hermetic-flow-save-"));
afterAll(() => rmSync(folders, { recursive: true, force: true }));

/** The desktop shell's folder dialog, answering `folder` (null: cancelled) the next time it opens. */
function stubFolder(folder: string | null): void {
  const ctx = harness!.ctx;
  ctx.native = {
    ...(ctx.native ?? {}),
    pickFolder: async () => folder,
  } as NonNullable<typeof ctx.native>;
}

async function share(
  given: FlowHarness | null = null,
  trigger = "E2E_FILE_SHARE",
): Promise<{ pane: Element; cards: () => Element[] }> {
  harness = given ?? (await flowHarness());
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
  await userEvent.type(composer, `send me the Q3 numbers ${trigger}{Enter}`);
  const cards = () => Array.from(pane.querySelectorAll(".ch-share"));
  await waitFor(() => expect(cards().length).toBe(2), WAIT);
  return { pane, cards };
}

const card = (cards: Element[], name: string) =>
  cards.find((c) => (c.querySelector(".ch-attach-item b")?.textContent ?? "") === name);
const saveButton = (el: Element | undefined) =>
  el?.querySelector<HTMLButtonElement>("button.ch-share-save") ?? null;

test("share_file draws one card per file; the chart shows once its sha256 checks out", async () => {
  const { pane, cards } = await share();
  // The MEDIA: line naming the chart again is not a third card, and leaves the prose.
  expect(cards().map((c) => c.querySelector(".ch-attach-item b")?.textContent ?? "")).toEqual([
    "q3-revenue.png",
    "q3-revenue.csv",
  ]);
  expect(pane.textContent ?? "").not.toContain("MEDIA:");
  expect(pane.textContent ?? "").toContain("September is up 8% on August.");
  // Never folded into the turn's tool group.
  expect(cards().every((c) => c.closest(".ch-activity-group") === null)).toBe(true);

  const png = () => card(cards(), "q3-revenue.png");
  await waitFor(
    () => expect(png()?.querySelector("img.ch-shot")?.getAttribute("src") ?? "").toMatch(/^blob:/),
    WAIT,
  );
  expect(harness!.calls.some((c) => c.name === "files.content")).toBe(true);
  expect(png()!.textContent ?? "").toMatch(/PNG.*q3-revenue\.png.* · sha [0-9a-f]{4}… · on box 24 h/);
  expect(png()!.textContent ?? "").not.toContain("preview withheld");
  expect(saveButton(png())?.textContent).toBe("Save…");

  // A CSV is named, never previewed, and never read for one.
  const csv = card(cards(), "q3-revenue.csv")!;
  expect(csv.querySelector("img") === null).toBe(true);
  expect(csv.textContent ?? "").toMatch(/CSV.*q3-revenue\.csv\d+ B · sha [0-9a-f]{4}… · on box 24 h/);
  expect(saveButton(csv)?.textContent).toBe("Save…");
  const contentIds = harness!.calls
    .filter((c) => c.name === "files.content")
    .map((c) => (c.params as { id: string }).id);
  const csvId = csv.getAttribute("data-share-id") ?? "";
  expect(csvId.startsWith("sh_")).toBe(true);
  expect(contentIds.includes(csvId)).toBe(false);
}, 20_000);

test("MEDIA: lines alone, with no share_file call, draw a card per file", async () => {
  const { pane, cards } = await share(null, "E2E_MEDIA_SHARE");
  expect(pane.querySelector(".ch-share-refused") === null).toBe(true);
  expect(cards().map((c) => c.querySelector(".ch-attach-item b")?.textContent ?? "")).toEqual([
    "q3-revenue.png",
    "q3-revenue.csv",
  ]);
  // The lines leave the prose, and the prose on both sides of them stays.
  const text = pane.textContent ?? "";
  expect(text).not.toContain("MEDIA:");
  expect(text).not.toContain("outbox/sh_");
  expect(text).toContain("the CSV behind it.");
  expect(text).toContain("September is up 8% on August.");

  // The image is previewed inline, from bytes that hash to the shared digest.
  const png = () => card(cards(), "q3-revenue.png");
  await waitFor(
    () => expect(png()?.querySelector("img.ch-shot")?.getAttribute("src") ?? "").toMatch(/^blob:/),
    WAIT,
  );
  expect(png()!.textContent ?? "").toMatch(/PNG.*q3-revenue\.png.* · sha [0-9a-f]{4}… · on box 24 h/);
  expect(saveButton(png())?.disabled).toBe(false);

  // The CSV is a card with no preview, and downloads through Save….
  const csv = () => card(cards(), "q3-revenue.csv");
  expect(csv()!.querySelector("img") === null).toBe(true);
  expect(csv()!.textContent ?? "").toMatch(/CSV.*q3-revenue\.csv\d+ B · sha [0-9a-f]{4}…/);
  const folder = mkdtempSync(join(folders, "media-"));
  stubFolder(folder);
  await userEvent.click(saveButton(csv())!);
  await waitFor(() => expect(csv()?.textContent ?? "").toContain("✓ saved q3-revenue.csv"), WAIT);
  expect(readdirSync(folder)).toEqual(["q3-revenue.csv"]);
  expect(
    readFileSync(join(folder, "q3-revenue.csv"), "utf8").startsWith("month,revenue_usd,orders\n"),
  ).toBe(true);
}, 20_000);

test("an image whose bytes do not hash to the shared sha256 is not shown", async () => {
  harness = await flowHarness();
  // The main process rejects bytes whose digest differs from the shared one.
  harness.intercept("files.content", () => {
    throw new HermeticError("FILE_DIGEST_MISMATCH", "the shared image changed");
  });
  const { cards } = await share(harness);
  const png = () => card(cards(), "q3-revenue.png");
  await waitFor(() => expect(png()?.textContent ?? "").toContain("preview withheld"), WAIT);
  expect(png()!.querySelector("img") === null).toBe(true);
  // Still the operator's to save: the download verifies its own digest.
  expect(saveButton(png())?.disabled).toBe(false);
}, 20_000);

test("Save… asks for a folder and saves the share into it, naming no path to the page", async () => {
  const { cards } = await share();
  const folder = mkdtempSync(join(folders, "csv-"));
  stubFolder(folder);
  const csv = () => card(cards(), "q3-revenue.csv");
  await userEvent.click(saveButton(csv())!);
  await waitFor(
    () =>
      expect(csv()?.textContent ?? "").toMatch(/✓ saved q3-revenue\.csv · \d+ B · sha [0-9a-f]{4}…/),
    WAIT,
  );
  expect(harness!.calls.some((c) => c.name === "files.saveNative")).toBe(true);
  const get = harness!.calls.find((c) => c.name === "files.get");
  const params = get?.params as { name: string; id: string; dest: Record<string, unknown> };
  expect(params.name).toBe("atlas");
  expect(params.id).toBe(csv()!.getAttribute("data-share-id") ?? "");
  expect(Object.keys(params.dest)).toEqual(["dest_id"]);
  // The bytes the card named are on disk, under the share's own name.
  expect(readdirSync(folder)).toEqual(["q3-revenue.csv"]);
  expect(
    readFileSync(join(folder, "q3-revenue.csv"), "utf8").startsWith("month,revenue_usd,orders\n"),
  ).toBe(true);
  // The page never heard where it went.
  expect(csv()!.textContent ?? "").not.toContain(folder);
}, 20_000);

test("a cancelled folder dialog saves nothing and says nothing", async () => {
  const { cards } = await share();
  stubFolder(null);
  const csv = () => card(cards(), "q3-revenue.csv");
  await userEvent.click(saveButton(csv())!);
  await waitFor(
    () => expect(harness!.calls.some((c) => c.name === "files.saveNative")).toBe(true),
    WAIT,
  );
  await waitFor(() => expect(saveButton(csv())?.disabled).toBe(false), WAIT);
  expect(harness!.calls.some((c) => c.name === "files.get")).toBe(false);
  expect(csv()!.textContent ?? "").not.toContain("saved");
}, 20_000);

test("a share the box no longer holds says so on Save…", async () => {
  const { cards } = await share();
  const csv = () => card(cards(), "q3-revenue.csv");
  const id = csv()!.getAttribute("data-share-id") ?? "";
  // Past its 24 h on the box, the sweeper took it.
  await harness!.backend().files.remove("atlas", id, {});
  const folder = mkdtempSync(join(folders, "gone-"));
  stubFolder(folder);
  await userEvent.click(saveButton(csv())!);
  await waitFor(() => expect(csv()?.textContent ?? "").toContain("no longer on the box"), WAIT);
  expect(saveButton(csv())?.disabled).toBe(true);
  expect(existsSync(join(folder, "q3-revenue.csv"))).toBe(false);
}, 20_000);

test("a refused share shows the box's words, not a card", () => {
  render(
    <Block
      now={Date.now()}
      instance="atlas"
      block={{
        kind: "tool",
        tool_id: "tl-share-refused",
        name: "share_file",
        server: null,
        args: { path: "/data/hermes/.hermes/.env" },
        result: "share refused: credential path",
        status: "bad",
        exit_code: null,
        duration_ms: 12,
        render: "file_share",
        share: null,
      }}
    />,
  );
  const note = document.querySelector(".ch-share-refused");
  expect(note?.textContent ?? "").toContain("share refused: credential path");
  expect(note?.textContent ?? "").toContain("/data/hermes/.hermes/.env");
  expect(document.querySelector(".ch-share") === null).toBe(true);
  expect(document.querySelector("button.ch-share-save") === null).toBe(true);
});

/** A `MEDIA:` outbox chip for an image, naming `sha256` as the chip would carry it. */
function chip(sha256: string | null) {
  return (
    <Block
      now={Date.now()}
      instance="atlas"
      block={{
        kind: "attachment",
        name: "chart.png",
        mime: "image/png",
        bytes: 2048,
        href: "outbox/sh_0000000chart/chart.png",
        file_id: "sh_0000000chart",
        sha256,
      }}
    />
  );
}

test("an image share naming no full sha256 is never read for a preview; Save… stays", async () => {
  server = fakeServer({
    "files.content": () => ({ mime: "image/png", data_b64: btoa("FIXTURE-png") }),
  });
  for (const sha of [null, "abcdef012345"]) {
    render(chip(sha));
    const shareCard = () => document.querySelector(".ch-share");
    await waitFor(() =>
      expect(shareCard()?.textContent ?? "").toContain("no preview without a verified sha256"),
    );
    expect(shareCard()!.querySelector("img") === null).toBe(true);
    expect(shareCard()!.textContent ?? "").not.toContain("preview withheld");
    expect(saveButton(shareCard() ?? undefined)?.disabled).toBe(false);
    cleanup();
  }
  expect(server.to("files.content").length).toBe(0);
});

test("an image share with a malformed sha256 reads as a mismatch, unread", async () => {
  server = fakeServer({
    "files.content": () => ({ mime: "image/png", data_b64: btoa("FIXTURE-png") }),
  });
  render(chip("not-a-digest-zz"));
  const shareCard = () => document.querySelector(".ch-share");
  await waitFor(() => expect(shareCard()?.textContent ?? "").toContain("preview withheld"));
  expect(shareCard()!.querySelector("img") === null).toBe(true);
  expect(server.to("files.content").length).toBe(0);
});

test("a refusal's tone follows the call: warn is not drawn as bad", () => {
  render(
    <Block
      now={Date.now()}
      instance="atlas"
      block={{
        kind: "tool",
        tool_id: "tl-share-warn",
        name: "share_file",
        server: null,
        args: { path: "/data/hermes/out/big.bin" },
        result: "share refused: over this fleet's cap",
        status: "warn",
        exit_code: null,
        duration_ms: 12,
        render: "file_share",
        share: null,
      }}
    />,
  );
  const note = document.querySelector(".ch-share-refused");
  expect(note?.classList.contains("warn")).toBe(true);
  expect(note?.classList.contains("bad")).toBe(false);
});
