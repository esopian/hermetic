/** Viewer choice updates mounted avatars without changing their identity or explicit previews. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, render, screen, userEvent } from "./dom.ts";
import { CHAT_AVATAR_STYLE_KEY, setChatAvatarStyle } from "../src/chat/chat-appearance.ts";
import { Avatar } from "../src/chat/components/avatar/Avatar.tsx";
import { Face } from "../src/chat/components/Face.tsx";
import { ChatSection } from "../src/components/settings/ChatSection.tsx";

beforeEach(() => {
  setChatAvatarStyle("blob");
  window.localStorage.removeItem(CHAT_AVATAR_STYLE_KEY);
});
afterEach(() => {
  cleanup();
  setChatAvatarStyle("blob");
  window.localStorage.removeItem(CHAT_AVATAR_STYLE_KEY);
});

/** Replace the browser storage accessor; Happy DOM returns bound methods that cannot be spied on reliably. */
function denyStorage(reads = false): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  const storage = window.localStorage;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => {
        if (reads) throw new Error("storage denied");
        return storage.getItem(key);
      },
      setItem: () => {
        throw new Error("storage denied");
      },
    },
  });
  return () => {
    if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
    else Reflect.deleteProperty(window, "localStorage");
  };
}

function Examples() {
  return (
    <>
      <ChatSection />
      <div data-testid="first">
        <Face fleetId="fixture-one" instance="atlas" bot="default" size={32} status="ready" />
      </div>
      <div data-testid="second">
        <Face fleetId="fixture-two" instance="granite" bot="research" size={32} status="ready" />
      </div>
      <div data-testid="fixed">
        <Avatar
          fleet_id="fixture-one"
          instance="atlas"
          bot="default"
          size={32}
          status="ready"
          activity="idle"
          style="sigil"
        />
      </div>
    </>
  );
}
function styleOf(id: string) {
  return screen.getByTestId(id).querySelector("[data-avatar-style]")?.getAttribute("data-avatar-style");
}

test("radio choice immediately updates every default avatar, preserves explicit previews and survives remount", async () => {
  let root = render(<Examples />);
  expect(screen.getByRole("heading", { name: "Appearance" })).toBeDefined();
  expect(screen.getByRole<HTMLInputElement>("radio", { name: "Blob" }).checked).toBe(true);
  expect(styleOf("first")).toBe("blob");
  await userEvent.click(screen.getByRole("radio", { name: "Pixel" }));
  expect(styleOf("first")).toBe("pixel");
  expect(styleOf("second")).toBe("pixel");
  expect(styleOf("fixed")).toBe("sigil");
  expect(
    [...root.container.querySelectorAll(".chat-avatar-preview [data-avatar-style]")].map((node) =>
      node.getAttribute("data-avatar-style"),
    ),
  ).toEqual(["blob", "pixel", "sigil"]);
  expect(window.localStorage.getItem(CHAT_AVATAR_STYLE_KEY)).toBe("pixel");
  root.unmount();
  root = render(<Examples />);
  expect(screen.getByRole<HTMLInputElement>("radio", { name: "Pixel" }).checked).toBe(true);
  expect(styleOf("first")).toBe("pixel");
  await userEvent.click(screen.getByRole("radio", { name: "Sigil" }));
  expect(styleOf("second")).toBe("sigil");
  expect(window.localStorage.getItem(CHAT_AVATAR_STYLE_KEY)).toBe("sigil");
  await userEvent.click(screen.getByRole("radio", { name: "Blob" }));
  expect(styleOf("first")).toBe("blob");
});

test.each(["pixel", "sigil", "blob"])(
  "initial persisted %s preference is used without a settings visit",
  (style) => {
    window.localStorage.setItem(CHAT_AVATAR_STYLE_KEY, style);
    render(<Examples />);
    expect(styleOf("first")).toBe(style);
    expect(styleOf("second")).toBe(style);
  },
);

test("invalid stored values fall back to Blob and storage events synchronize mounted views", () => {
  window.localStorage.setItem(CHAT_AVATAR_STYLE_KEY, "future-style");
  render(<Examples />);
  expect(styleOf("first")).toBe("blob");
  act(() => {
    window.localStorage.setItem(CHAT_AVATAR_STYLE_KEY, "pixel");
    window.dispatchEvent(new StorageEvent("storage", { key: CHAT_AVATAR_STYLE_KEY }));
  });
  expect(styleOf("first")).toBe("pixel");
  expect(screen.getByRole<HTMLInputElement>("radio", { name: "Pixel" }).checked).toBe(true);
  act(() => {
    window.localStorage.removeItem(CHAT_AVATAR_STYLE_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });
  expect(styleOf("second")).toBe("blob");
});

test("a denied write keeps the new choice active even when the old stored value remains readable", async () => {
  window.localStorage.setItem(CHAT_AVATAR_STYLE_KEY, "blob");
  const restore = denyStorage();
  try {
    render(<Examples />);
    await userEvent.click(screen.getByRole("radio", { name: "Pixel" }));
    expect(styleOf("first")).toBe("pixel");
    expect(styleOf("second")).toBe("pixel");
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "Pixel" }).checked).toBe(true);
    expect(window.localStorage.getItem(CHAT_AVATAR_STYLE_KEY)).toBe("blob");
  } finally {
    restore();
  }
});

test("unavailable storage reads fall back safely and native keyboard selection remains usable", async () => {
  window.localStorage.setItem(CHAT_AVATAR_STYLE_KEY, "sigil");
  const restore = denyStorage(true);
  try {
    render(<Examples />);
    expect(styleOf("first")).toBe("blob");
    const radio = screen.getByRole<HTMLInputElement>("radio", { name: "Pixel" });
    radio.focus();
    await userEvent.keyboard(" ");
    expect(radio.checked).toBe(true);
    expect(styleOf("first")).toBe("pixel");
  } finally {
    restore();
  }
});
