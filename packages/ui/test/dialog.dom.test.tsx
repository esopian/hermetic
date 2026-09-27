/**
 * The `Dialog` primitive, on its own. Drawer, Popover, the teardown receipt,
 * the Bot Mode form and quick jump all render through it, so what is pinned
 * here is what each of them inherits: the role and name, `aria-modal` only
 * when modal, the initial-focus rule, Tab wrapping, Escape to the topmost
 * dialog, restoring the opener, and a backdrop whose own click closes while a
 * click inside does not.
 *
 * `drawer-focus.dom.test.tsx` covers the same contract through `Drawer` with
 * nesting; the per-component tests stay until this one has earned their trim.
 */
import { cleanup, fireEvent, render, screen, userEvent } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import type { ReactNode } from "react";
import { Dialog } from "../src/components/Dialog.tsx";

afterEach(cleanup);

function Host({
  modal = false,
  backdrop = false,
  swallow = false,
  children,
}: {
  modal?: boolean;
  backdrop?: boolean;
  swallow?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open ? (
        <Dialog
          className="host-dialog"
          label="Host"
          modal={modal}
          onDismiss={swallow ? undefined : close}
          backdrop={backdrop ? { className: "host-backdrop", onClose: close } : undefined}
        >
          {children}
        </Dialog>
      ) : null}
    </>
  );
}

const TWO = (
  <>
    <button type="button">First</button>
    <button type="button">Second</button>
  </>
);

function focused(): string {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return "nothing";
  if (el === document.body) return "body";
  if (el.getAttribute("role") === "dialog") return "the dialog itself";
  return el.textContent ?? el.tagName;
}

async function open(
  children: ReactNode,
  props: { modal?: boolean; backdrop?: boolean; swallow?: boolean } = {},
) {
  const user = userEvent.setup();
  render(<Host {...props}>{children}</Host>);
  const trigger = screen.getByRole("button", { name: "Open" });
  await user.click(trigger);
  return { user, trigger, dialog: screen.getByRole("dialog", { name: "Host" }) };
}

describe("Dialog", () => {
  test("carries the role, the name, the caller's chrome, and aria-modal only when modal", async () => {
    const { dialog } = await open(TWO);
    expect(dialog.className).toBe("host-dialog");
    expect(dialog.getAttribute("aria-modal")).toBeNull();
    expect(dialog.getAttribute("tabindex")).toBe("-1");
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  test("modal claims aria-modal and locks scroll until it closes", async () => {
    const original = document.body.style.overflow;
    const { user, dialog } = await open(TWO, { modal: true });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
    await user.keyboard("{Escape}");
    expect(document.body.style.overflow).toBe(original);
  });

  test("labelledBy names the dialog from an element inside it", () => {
    render(
      <Dialog className="x" labelledBy="ttl" onDismiss={() => {}}>
        <h2 id="ttl">Titled</h2>
      </Dialog>,
    );
    expect(screen.getByRole("dialog", { name: "Titled" })).toBeTruthy();
  });

  test("initial focus: data-autofocus, else the first focusable, else the root", async () => {
    const a = await open(
      <>
        <button type="button">Skipped</button>
        <input aria-label="Marked" data-autofocus />
      </>,
    );
    expect(document.activeElement === screen.getByRole("textbox", { name: "Marked" })).toBe(true);
    cleanup();
    await open(TWO);
    expect(focused()).toBe("First");
    cleanup();
    await open(<p>nothing to focus</p>);
    expect(focused()).toBe("the dialog itself");
    expect(a.trigger.isConnected).toBe(false);
  });

  test("Tab wraps at both ends instead of leaving", async () => {
    const { user } = await open(TWO);
    expect(focused()).toBe("First");
    await user.tab();
    expect(focused()).toBe("Second");
    await user.tab();
    expect(focused()).toBe("First");
    await user.tab({ shift: true });
    expect(focused()).toBe("Second");
  });

  test("Escape dismisses and focus returns to the opener", async () => {
    const { user, trigger } = await open(TWO);
    expect(document.activeElement === trigger).toBe(false);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement === trigger).toBe(true);
  });

  test("without onDismiss, Escape is swallowed rather than passed to the page", async () => {
    const { user } = await open(TWO, { swallow: true });
    let reachedPage = false;
    const spy = () => {
      reachedPage = true;
    };
    window.addEventListener("keydown", spy);
    try {
      await user.keyboard("{Escape}");
    } finally {
      window.removeEventListener("keydown", spy);
    }
    expect(screen.getByRole("dialog", { name: "Host" })).toBeTruthy();
    expect(reachedPage).toBe(false);
  });

  test("a click on the backdrop closes; a click inside the dialog does not", async () => {
    const { dialog } = await open(TWO, { backdrop: true });
    const backdrop = document.querySelector<HTMLElement>(".host-backdrop");
    if (!backdrop) throw new Error("no backdrop rendered");
    expect(backdrop.contains(dialog)).toBe(true);
    expect(backdrop.getAttribute("role")).toBe("presentation");
    fireEvent.click(screen.getByRole("button", { name: "Second" }));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.click(backdrop);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("Escape reaches only the topmost of two open dialogs", async () => {
    function Stack() {
      const [inner, setInner] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setInner(true)}>
            Open inner
          </button>
          {inner ? (
            <Dialog className="inner" label="Inner" onDismiss={() => setInner(false)}>
              <button type="button">Inner button</button>
            </Dialog>
          ) : null}
        </>
      );
    }
    const { user } = await open(<Stack />);
    const opener = screen.getByRole("button", { name: "Open inner" });
    await user.click(opener);
    expect(screen.getAllByRole("dialog").length).toBe(2);
    expect(focused()).toBe("Inner button");
    await user.keyboard("{Escape}");
    expect(screen.getAllByRole("dialog").length).toBe(1);
    expect(document.activeElement === opener).toBe(true);
  });
});
