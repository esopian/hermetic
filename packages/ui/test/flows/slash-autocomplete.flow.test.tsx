/**
 * The composer's slash-command picker (issue #76): typing a command name lists
 * the bot's commands from the gateway's catalog (`chat.commands`), and
 * accepting one completes it.
 *
 * Through the real composer, the real `bind` and the real `dispatch`, over the
 * fixture backend, whose catalog (`fixture-chat-command.ts`) is read through
 * the live adapter's mapper.
 */
import { HermeticError } from "@hermetic/core";
import { cleanup, screen, userEvent, waitFor } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
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

async function openScribe(): Promise<HTMLTextAreaElement> {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash("#chat/atlas/scribe");
  mountPortal();
  return (await screen.findByRole(
    "textbox",
    { name: /^Message Marshall/ },
    { timeout: 4_000 },
  )) as HTMLTextAreaElement;
}

/**
 * Whether the list is up — a boolean, never the element: a failed assertion on
 * a happy-dom node makes bun print the node's whole graph, which takes minutes.
 */
const open = () => screen.queryByRole("listbox", { name: "Slash commands" }) !== null;
const rows = () => screen.queryAllByRole("option").map((o) => o.textContent ?? "");
const catalogReads = () => harness!.calls.filter((call) => call.name === "chat.commands");

test("/he lists help first; Enter inserts `/help `", async () => {
  const composer = await openScribe();
  // Nothing is asked of the box until a command is being typed.
  expect(catalogReads()).toHaveLength(0);
  await userEvent.type(composer, "/he");
  await waitFor(() => expect(open()).toBe(true), { timeout: 4_000 });
  // A prefix match before a substring match; the skill shows its origin.
  expect(rows()[0]).toStartWith("/help");
  expect(rows()[1]).toContain("/sketch-helper");
  expect(rows()[1]).toContain("skill · bundled");
  // The typed part of the name is what is bold.
  expect(screen.getAllByRole("option")[0]!.querySelector("b")?.textContent).toBe("he");
  expect(composer.getAttribute("aria-expanded")).toBe("true");

  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(composer.value).toBe("/help "));
  expect(open()).toBe(false);
  // Accepting is not sending.
  expect(harness!.calls.some((call) => call.name === "chat.turn")).toBe(false);
  expect(catalogReads()).toHaveLength(1);
});

test("Esc closes the list without changing the text", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "/he");
  await waitFor(() => expect(open()).toBe(true), { timeout: 4_000 });
  await userEvent.keyboard("{Escape}");
  expect(open()).toBe(false);
  expect(composer.value).toBe("/he");
  // The list had Escape, so the conversation is still on screen.
  expect(window.location.hash).toBe("#chat/atlas/scribe");
  // An edit reopens it, from the catalog already read.
  await userEvent.type(composer, "l");
  await waitFor(() => expect(open()).toBe(true));
  expect(rows()[0]).toStartWith("/help");
  expect(catalogReads()).toHaveLength(1);
});

test("arrows move the highlight and Tab accepts it", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "/he");
  await waitFor(() => expect(open()).toBe(true), { timeout: 4_000 });
  await userEvent.keyboard("{ArrowDown}");
  expect(screen.getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
  await userEvent.keyboard("{Tab}");
  await waitFor(() => expect(composer.value).toBe("/sketch-helper "));
});

test("Enter on a command that takes no argument sends it", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "/ver");
  await waitFor(() => expect(rows()[0]).toStartWith("/version"), { timeout: 4_000 });
  await userEvent.keyboard("{Enter}");
  await waitFor(
    () =>
      expect(document.querySelector('[data-chat-command="/version"]')?.textContent ?? "").toContain(
        "Hermes Agent",
      ),
    { timeout: 4_000 },
  );
  expect(composer.value).toBe("");
});

test("a terminal-only command is never listed", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "/");
  await waitFor(() => expect(open()).toBe(true), { timeout: 4_000 });
  expect(rows().some((row) => row.startsWith("/skin"))).toBe(false);
  expect(rows().some((row) => row.startsWith("/goal"))).toBe(true);
});

test("prose with a slash in it shows no list", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "/he");
  await waitFor(() => expect(open()).toBe(true), { timeout: 4_000 });
  // A space ends the name, and the list with it.
  await userEvent.type(composer, " ");
  expect(open()).toBe(false);
  await userEvent.clear(composer);
  await userEvent.type(composer, "run /help later");
  expect(open()).toBe(false);
  await userEvent.clear(composer);
  await userEvent.type(composer, "/usr/local");
  expect(open()).toBe(false);
});

test("a failed catalog read leaves the composer as it was", async () => {
  const composer = await openScribe();
  harness!.intercept("chat.commands", () => {
    throw new HermeticError("CHAT_PROTOCOL", "This gateway does not list its commands");
  });
  await userEvent.type(composer, "/he");
  await waitFor(() => expect(catalogReads()).toHaveLength(1), { timeout: 4_000 });
  expect(open()).toBe(false);
  await userEvent.type(composer, "lp{Enter}");
  await waitFor(
    () =>
      expect(document.querySelector('[data-chat-command="/help"]')?.textContent ?? "").toContain(
        "Available commands:",
      ),
    { timeout: 4_000 },
  );
  expect(screen.queryByRole("alert", { name: /commands/i })).toBeNull();
});
