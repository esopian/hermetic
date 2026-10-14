/**
 * Composer attachments (attachments plan §8.1–8.2) over the real `bind` and
 * `dispatch` and the fixture backend: a file dropped on the thread is sent in
 * one streamed upload, staged on the box and carried by `chat.turn` as an id, and the box's
 * own row keeps the chip once the transcript is read again; a message may be
 * files alone; removing a staged chip deletes it on the box; a staging the box
 * refuses reads as words; a box without the files service disables attaching,
 * with the copy that says why; and a seeded image's thumbnail is read through
 * `files.content` into a `blob:` URL this page minted.
 *
 * Assertions compare strings and booleans, never DOM nodes: a failing
 * `expect(node)` makes bun format the whole portal.
 */
import { cleanup, fireEvent, screen, userEvent, waitFor } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { setFleetTarget } from "../../src/api/index.ts";
import { resetThumbnails } from "../../src/chat/thumbnails.ts";
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
  resetThumbnails();
  await harness?.restore();
  harness = null;
  reset();
});

async function openScribe(): Promise<HTMLTextAreaElement> {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
  await harness.ctx.chatOwner.sync();
  setFleetTarget(harness.target);
  gotoHash("#chat/atlas/scribe");
  mountPortal();
  return (await screen.findByRole(
    "textbox",
    { name: /^Message Marshall/ },
    { timeout: 4_000 },
  )) as HTMLTextAreaElement;
}

/** A Finder drop: a drag whose `types` names files, and the `File`s themselves. */
function drop(target: Element, files: File[]): void {
  const dataTransfer = { types: ["Files"], files, dropEffect: "none" };
  fireEvent.dragEnter(target, { dataTransfer });
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}

const thread = (composer: Element) => composer.closest(".ch-thread")!;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test("a dropped file is staged, and the turn carries its id", async () => {
  const composer = await openScribe();
  const pane = thread(composer);
  fireEvent.dragEnter(pane, { dataTransfer: { types: ["Files"], files: [] } });
  // The overlay names the agent the file would land on, and the limits.
  expect(pane.querySelector(".ch-drop")?.textContent).toContain(
    "→ atlas · inbox · deleted after 7 days",
  );
  expect(pane.querySelector(".ch-drop")?.textContent).toContain(
    "images ≤ 25 MB · files ≤ 256 MB · max 10",
  );
  drop(pane, [new File([PNG], "chart.png", { type: "image/png" })]);
  await waitFor(() => expect(pane.querySelector(".ch-file.staged") !== null).toBe(true), {
    timeout: 4_000,
  });
  expect(pane.querySelector(".ch-file-status")?.textContent).toContain("✓ staged");
  // A drop streams to the loopback upload port: one open, no chunk calls.
  expect(harness!.calls.filter((c) => c.name === "files.upload.open")).toHaveLength(1);
  expect(pane.querySelector(".ch-attach-sum")?.textContent).toContain("1 ready");

  await userEvent.type(composer, "look at this{Enter}");
  await waitFor(() => expect(harness!.calls.some((c) => c.name === "chat.turn")).toBe(true), {
    timeout: 4_000,
  });
  const turn = harness!.calls.find((c) => c.name === "chat.turn")!;
  const sent = (turn.params as { attachments?: { file_id: string }[] }).attachments ?? [];
  expect(sent).toHaveLength(1);
  expect(sent[0]!.file_id).toMatch(/^f_/);
  // The tray is empty once the files went with a message.
  expect(pane.querySelector(".ch-file") === null).toBe(true);
  // The local echo's chip, once the box accepted the turn.
  await waitFor(() => expect(pane.textContent).toContain("✓ delivered"), { timeout: 4_000 });
  // The reply names the file, and once the transcript is read again the
  // operator's row is the box's: its chip carries the staged id and the
  // digest, which the local echo never knew.
  await waitFor(
    () =>
      expect(pane.textContent).toContain("I have the 1 attached file: chart.png. Reading them now."),
    { timeout: 4_000 },
  );
  const turnAt = harness!.calls.indexOf(turn);
  await waitFor(
    () => {
      const reread = harness!.calls.slice(turnAt).some((c) => c.name === "chat.history");
      expect(reread).toBe(true);
      const chip = pane.querySelector(`.ch-msg .ch-attach-item[data-file-id="${sent[0]!.file_id}"]`);
      expect(chip?.textContent ?? "").toContain("chart.png");
      expect(chip?.textContent ?? "").toMatch(/✓ delivered · .* · sha [0-9a-f]{4}…/);
    },
    { timeout: 4_000 },
  );
  expect(pane.textContent).toContain("look at this");
});

test("a message can be files alone", async () => {
  const composer = await openScribe();
  const pane = thread(composer);
  drop(pane, [new File(["a,b\n1,2"], "rows.csv", { type: "text/csv" })]);
  await waitFor(() => expect(pane.querySelector(".ch-file.staged") !== null).toBe(true), {
    timeout: 4_000,
  });
  expect(composer.value).toBe("");
  const send = pane.querySelector<HTMLButtonElement>(".ch-send")!;
  expect(send.disabled).toBe(false);
  await userEvent.click(send);
  await waitFor(() => expect(harness!.calls.some((c) => c.name === "chat.turn")).toBe(true), {
    timeout: 4_000,
  });
  const turn = harness!.calls.find((c) => c.name === "chat.turn")!;
  const params = turn.params as { message: string; attachments?: { file_id: string }[] };
  expect(params.message).toBe("");
  expect(params.attachments?.length).toBe(1);
  await waitFor(
    () => expect(pane.textContent).toContain("I have the 1 attached file: rows.csv. Reading them now."),
    { timeout: 4_000 },
  );
  expect(pane.querySelector(".ch-file") === null).toBe(true);
});

test("removing a staged chip deletes it on the box", async () => {
  const composer = await openScribe();
  const pane = thread(composer);
  drop(pane, [new File(["hello"], "notes.txt", { type: "text/plain" })]);
  await waitFor(() => expect(pane.querySelector(".ch-file.staged") !== null).toBe(true), {
    timeout: 4_000,
  });
  // By selector rather than by role: a role query walks the whole portal.
  await userEvent.click(pane.querySelector('button[aria-label="Remove notes.txt"]')!);
  await waitFor(() => expect(harness!.calls.some((c) => c.name === "files.discard")).toBe(true));
  expect(pane.querySelector(".ch-file") === null).toBe(true);
});

test("a staging the box refuses is a readable error chip that blocks Send", async () => {
  const composer = await openScribe();
  const pane = thread(composer);
  drop(pane, [new File(["x"], "dump-E2E_FILE_TOO_LARGE.zip", { type: "application/zip" })]);
  await waitFor(() => expect(pane.querySelector(".ch-file.error") !== null).toBe(true), {
    timeout: 4_000,
  });
  expect(pane.querySelector(".ch-file.error")?.textContent).toContain("too large");
  await userEvent.type(composer, "with a broken file");
  const send = pane.querySelector<HTMLButtonElement>(".ch-send")!;
  expect(send.disabled).toBe(true);
  expect(send.title).toBe("Remove the failed attachments to send");
});

test("a box without the files service disables attaching and says why", async () => {
  harness = await flowHarness();
  // The fixture's `ember` has no files capability; the bridge says so.
  const ember = await harness.ctx.hermetic().files.internal.capability("ember", {});
  expect(ember.files).toBe(false);
  // Atlas answered as ember does, so the scribe thread shows the refusal.
  harness.intercept("files.capability", () => ({ files: false, hermeticd_version: "0.0.0" }));
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
  const attach = thread(composer).querySelector<HTMLButtonElement>(
    'button[aria-label="Attach files"]',
  )!;
  await waitFor(() => expect(attach.disabled).toBe(true));
  expect(attach.title).toBe("Update hermeticd to attach files");
  expect(thread(composer).querySelector(".ch-composer-foot")?.textContent).toContain(
    "Update hermeticd to attach files",
  );
  drop(thread(composer), [new File(["x"], "a.txt")]);
  expect(thread(composer).querySelector(".ch-file") === null).toBe(true);
});

test("a seeded image's thumbnail is a blob: URL this page minted from files.content", async () => {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
  await harness.ctx.chatOwner.sync();
  setFleetTarget(harness.target);
  gotoHash("#chat/atlas/default?session=sx-atlas-portal");
  mountPortal();
  const chip = () => document.querySelector('.ch-attach-item[data-file-id="f_fxqueuedpth1"]');
  await waitFor(() => expect(chip()?.textContent ?? "").toContain("queue-depth.png"), {
    timeout: 4_000,
  });
  const shot = () => chip()?.closest(".ch-attach")?.querySelector("img.ch-shot") ?? null;
  await waitFor(() => expect(shot()?.getAttribute("src") ?? "").toMatch(/^blob:/), {
    timeout: 4_000,
  });
  const reads = harness.calls.filter((c) => c.name === "files.content");
  expect(reads.map((c) => (c.params as { id: string }).id)).toContain("f_fxqueuedpth1");
  // The box path in `href` is never loaded: the chip is not a link.
  expect(chip()?.tagName).toBe("SPAN");
});
