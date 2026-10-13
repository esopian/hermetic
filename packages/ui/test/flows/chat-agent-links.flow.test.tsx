/**
 * The thread header's `Desktop` and `Terminal` links, over a real head.
 *
 * From the Chat view they raise the agent drawer on that section *over* the
 * conversation: the URL stays the chat's, the thread stays mounted underneath,
 * and closing the drawer is back in the same thread with the draft as it was.
 * Inside the drawer's own Chat section the same links just move the drawer.
 */
import { cleanup, fireEvent, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { FIXTURE, type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

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

const NAME = FIXTURE.sseAgent;

/** Listen on kestrel, then open its Bot Chat in the full Chat view. */
async function openChat(): Promise<HTMLElement> {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: NAME, listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash(`#chat/${NAME}/default`);
  mountPortal();
  return await waitFor(
    () => {
      const head = document.querySelector<HTMLElement>(".ch-thead");
      expect(head).not.toBeNull();
      expect(within(head!).getByRole("button", { name: "Terminal" })).toBeDefined();
      return head!;
    },
    { timeout: 4_000 },
  );
}

function composer(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>(".ch-composer .ch-input")!;
}

/** The section the open drawer is on, by its tab. */
function drawerSection(dialog: HTMLElement): string | null {
  return (
    within(dialog)
      .getByRole("tablist", { name: "Agent sections" })
      .querySelector('[role="tab"][aria-selected="true"]')?.id ?? null
  );
}

test("Terminal opens the drawer over the chat, and closing it returns to the same draft", async () => {
  const head = await openChat();
  const user = userEvent.setup();
  fireEvent.change(composer(), { target: { value: "half a thought" } });

  await user.click(within(head).getByRole("button", { name: "Terminal" }));
  const dialog = await waitFor(() => {
    const el = screen.getByRole("dialog");
    expect(el.querySelector(".detail-name")?.textContent).toBe(NAME);
    return el;
  });
  expect(drawerSection(dialog)).toBe("agent-tab-terminal");
  // Still the Chat view underneath, at the chat's own URL.
  expect(document.querySelector(".ch-body")).not.toBeNull();
  expect(window.location.hash).toBe(`#chat/${NAME}/default`);

  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(window.location.hash).toBe(`#chat/${NAME}/default`);
  expect(composer().value).toBe("half a thought");
});

test("over the chat, the drawer's Chat tab closes back to the thread instead of a second copy", async () => {
  const head = await openChat();
  const user = userEvent.setup();
  fireEvent.change(composer(), { target: { value: "still here" } });
  await user.click(within(head).getByRole("button", { name: "Terminal" }));
  const dialog = await waitFor(() => screen.getByRole("dialog"));

  await user.click(within(dialog).getByRole("tab", { name: /Chat/ }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.querySelectorAll(".ch-composer")).toHaveLength(1);
  expect(window.location.hash).toBe(`#chat/${NAME}/default`);
  expect(composer().value).toBe("still here");
});

test("Desktop opens the drawer on its Desktop section", async () => {
  const head = await openChat();
  const user = userEvent.setup();
  await user.click(within(head).getByRole("button", { name: "Desktop" }));
  const dialog = await waitFor(() => screen.getByRole("dialog"));
  expect(drawerSection(dialog)).toBe("agent-tab-desktop");
  expect(document.querySelector(".ch-body")).not.toBeNull();
});

test("inside the drawer's Chat section the links move the drawer", async () => {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: NAME, listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash(`#agent/${NAME}`);
  mountPortal();
  const user = userEvent.setup();
  const dialog = await waitFor(() => screen.getByRole("dialog"), { timeout: 4_000 });
  await waitFor(() =>
    expect(within(dialog).getByRole("tab", { name: /Chat/ }).hasAttribute("disabled")).toBe(false),
  );
  await user.click(within(dialog).getByRole("tab", { name: /Chat/ }));
  const terminal = await waitFor(() => within(dialog).getByRole("button", { name: "Terminal" }), {
    timeout: 4_000,
  });
  await user.click(terminal);
  await waitFor(() => expect(drawerSection(dialog)).toBe("agent-tab-terminal"));
  // One drawer, moved — not a second one opened over it.
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(window.location.hash).toBe(`#agent/${NAME}/terminal`);
});

test("a stopped box offers neither link", async () => {
  // `juniper` is seeded stopped.
  const stopped = "juniper";
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: stopped, listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash(`#chat/${stopped}/default`);
  mountPortal();
  await waitFor(() => expect(screen.getByText(`${stopped} is stopped.`)).toBeDefined(), {
    timeout: 4_000,
  });
  const head = document.querySelector<HTMLElement>(".ch-thead")!;
  expect(within(head).queryByRole("button", { name: "Terminal" })).toBeNull();
  expect(within(head).queryByRole("button", { name: "Desktop" })).toBeNull();
});
