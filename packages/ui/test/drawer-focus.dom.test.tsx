/**
 * The focus contract `src/focus.ts` documents and `Drawer` promises with
 * `aria-modal="true"`, exercised as keystrokes rather than as arithmetic.
 *
 * `test/focus.test.ts` already pins `nextTrapTarget` — the maths — but the
 * maths was never the bug: the bug was Tab walking out of an `aria-modal`
 * dialog into the fleet behind it, and closing a drawer dropping focus onto
 * `<body>` so the next keystroke went nowhere. Both are only visible with a
 * real document, a real `activeElement` and a real Tab.
 */
import { cleanup, fireEvent, render, screen, userEvent } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import { Drawer } from "../src/components/Drawer.tsx";

afterEach(cleanup);

/** A trigger outside the dialog, so "focus went back to the trigger" is a real claim. */
function Host({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open drawer
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Close from outside
      </button>
      {open ? (
        <Drawer width={520} onClose={() => setOpen(false)}>
          {children}
        </Drawer>
      ) : null}
    </>
  );
}

const TWO_BUTTONS = (
  <>
    <button type="button">Reboot</button>
    <button type="button">Destroy</button>
  </>
);

/**
 * What has focus, as something readable. Node identity is the assertion, but
 * `expect(activeElement).toBe(node)` prints an entire happy-dom element on
 * failure — pages of it — so the comparison is made here and the message is a
 * name.
 */
function focused(): string {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return "nothing";
  if (el === document.body) return "body";
  if (el.getAttribute("role") === "dialog") return "the dialog itself";
  return el.textContent ?? el.tagName;
}

async function openDrawer(children: React.ReactNode) {
  const user = userEvent.setup();
  render(<Host>{children}</Host>);
  const trigger = screen.getByRole("button", { name: "Open drawer" });
  await user.click(trigger);
  return { user, trigger };
}

describe("Drawer · the focus trap", () => {
  test("nested modal closes once, restores parent focus, and reference-counts scroll lock", async () => {
    const original = document.body.style.overflow;
    function Nested() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open child
          </button>
          {open ? (
            <Drawer width={300} onClose={() => setOpen(false)}>
              <input aria-label="Child field" data-autofocus />
            </Drawer>
          ) : null}
        </>
      );
    }
    const { user, trigger } = await openDrawer(<Nested />);
    const parentOpener = screen.getByRole("button", { name: "Open child" });
    await user.click(parentOpener);
    expect(document.body.style.overflow).toBe("hidden");
    await user.keyboard("{Escape}");
    expect(screen.getAllByRole("dialog").length).toBe(1);
    expect(document.activeElement === parentOpener).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement === trigger).toBe(true);
    expect(document.body.style.overflow).toBe(original);
  });

  test("removing a parent never steals focus from a surviving child", async () => {
    function Siblings() {
      const [parent, setParent] = useState(false);
      const [child, setChild] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setParent(true)}>
            Open parent
          </button>
          <button type="button" onClick={() => setParent(false)}>
            Remove parent
          </button>
          {parent ? (
            <Drawer width={300} onClose={() => setParent(false)}>
              <button type="button" onClick={() => setChild(true)}>
                Open child
              </button>
            </Drawer>
          ) : null}
          {child ? (
            <Drawer width={250} onClose={() => setChild(false)}>
              <input aria-label="Child field" data-autofocus />
            </Drawer>
          ) : null}
        </>
      );
    }
    const user = userEvent.setup();
    render(<Siblings />);
    const opener = screen.getByRole("button", { name: "Open parent" });
    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Open child" }));
    const childField = screen.getByRole("textbox");
    fireEvent.click(screen.getByRole("button", { name: "Remove parent" }));
    expect(document.activeElement === childField).toBe(true);
    await user.keyboard("{Escape}");
    expect(document.activeElement === opener).toBe(true);
  });

  test("focus lands inside the dialog on open, not on the trigger behind it", async () => {
    const { trigger } = await openDrawer(TWO_BUTTONS);
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(focused()).toBe("Reboot");
    expect(document.activeElement === trigger).toBe(false);
  });

  test("Tab from the last focusable wraps to the first instead of leaving", async () => {
    const { user } = await openDrawer(TWO_BUTTONS);

    await user.tab();
    expect(focused()).toBe("Destroy");
    // The regression this catches: without the trap the next Tab reaches the
    // "Open drawer" button behind the backdrop, in a dialog that told assistive
    // technology nothing outside it was reachable.
    await user.tab();
    expect(focused()).toBe("Reboot");
  });

  test("Shift+Tab from the first focusable wraps to the last", async () => {
    const { user } = await openDrawer(TWO_BUTTONS);
    expect(focused()).toBe("Reboot");

    await user.tab({ shift: true });
    expect(focused()).toBe("Destroy");
  });

  test("closing returns focus to whatever opened it", async () => {
    const { user, trigger } = await openDrawer(TWO_BUTTONS);
    expect(document.activeElement === trigger).toBe(false);

    // Closed from outside the dialog, so the restore is the trap's doing and
    // not a side effect of the click that closed it.
    await user.click(screen.getByRole("button", { name: "Close from outside" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement === trigger).toBe(true);
  });

  test("a drawer with nothing focusable in it focuses the dialog itself", async () => {
    // The plan-still-loading state: a drawer whose body is a skeleton. Focus
    // must not be left on `<body>`, where Esc and Tab reach nobody.
    const { user } = await openDrawer(<div>reading the destroy plan…</div>);
    expect(focused()).toBe("the dialog itself");

    // …and Tab holds it there rather than walking out into the page.
    await user.tab();
    expect(focused()).toBe("the dialog itself");
    await user.tab({ shift: true });
    expect(focused()).toBe("the dialog itself");
  });
});
