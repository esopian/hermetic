/**
 * The masked text box on a text secret card (attachments plan §06b, §8.4b):
 * starting mode, the multi-line paste switch, the blocked switch back, Treat
 * as, the submit keys, Esc, D10's refusal of an unrequested key, the
 * placeholder's second click, and that the value never reaches rendered text.
 *
 * Assertions compare strings and booleans, never DOM nodes, so a failure
 * prints a diff rather than the page. Every value is a FIXTURE sentinel.
 */
import { act, cleanup, fireEvent, render } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { SecretTextInput } from "../src/chat/components/blocks/SecretTextInput.tsx";
import type { SecretTextInputProps } from "../src/chat/components/blocks/SecretTextInput.tsx";

afterEach(cleanup);

const TOKEN = "FIXTURE-gh-token-0001";
const DB_USER = "FIXTURE-db-user";
const DB_PASS = "FIXTURE-db-pass-0002";
const DB_URL = "FIXTURE-db-url-0003";
const ENV_BLOCK = `DB_USER=${DB_USER}\nDB_PASS=${DB_PASS}\nDB_URL=${DB_URL}`;

type Call = { text: string; as: string; ephemeral: boolean };

function mount(over: Partial<SecretTextInputProps> = {}) {
  const calls: Call[] = [];
  let declines = 0;
  const props: SecretTextInputProps = {
    keys: ["GITHUB_TOKEN"],
    onSubmit: (text, as, ephemeral) => calls.push({ text, as, ephemeral }),
    onDecline: () => {
      declines++;
    },
    ...over,
  };
  const view = render(<SecretTextInput {...props} />);
  const root = view.container;
  const field = () => root.querySelector<HTMLInputElement | HTMLTextAreaElement>(".sti-real");
  const kind = () => field()?.tagName.toLowerCase() ?? "none";
  const button = (label: string) =>
    Array.from(root.querySelectorAll("button")).find((b) => b.textContent === label) ?? null;
  const buttonStartingWith = (prefix: string) =>
    Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.startsWith(prefix)) ?? null;
  const type = (value: string) => {
    const el = field();
    if (!el) throw new Error("no field");
    fireEvent.input(el, { target: { value } });
  };
  const paste = (text: string) => {
    const el = field();
    if (!el) throw new Error("no field");
    fireEvent.paste(el, { clipboardData: { getData: () => text } });
  };
  const key = (k: string, init: Record<string, unknown> = {}) => {
    const el = field();
    if (!el) throw new Error("no field");
    fireEvent.keyDown(el, { key: k, ...init });
  };
  const status = () => root.querySelector(".sti-status")?.textContent ?? "";
  const masked = () => root.querySelector(".sti-dots")?.textContent ?? "";
  return {
    view,
    root,
    calls,
    declines: () => declines,
    field,
    kind,
    button,
    buttonStartingWith,
    type,
    paste,
    key,
    status,
    masked,
  };
}

describe("starting mode", () => {
  test("auto with one key starts single-line", () => {
    expect(mount().kind()).toBe("input");
  });
  test("auto with two or more keys starts multi-line", () => {
    expect(mount({ keys: ["DB_USER", "DB_PASS"] }).kind()).toBe("textarea");
  });
  test("an explicit input wins over the key count", () => {
    expect(mount({ input: "multi" }).kind()).toBe("textarea");
    cleanup();
    expect(mount({ keys: ["DB_USER", "DB_PASS"], input: "single" }).kind()).toBe("input");
  });
  test("both fields turn off spellcheck, autocorrect, autocapitalize and autocomplete", () => {
    for (const input of ["single", "multi"] as const) {
      const m = mount({ input });
      const el = m.field();
      expect(el?.getAttribute("spellcheck")).toBe("false");
      expect(el?.getAttribute("autocomplete")).toBe("off");
      expect(el?.getAttribute("autocorrect")).toBe("off");
      expect(el?.getAttribute("autocapitalize")).toBe("off");
      expect(el?.hasAttribute("data-1p-ignore")).toBe(true);
      expect(el?.getAttribute("aria-label")).toBe("Secret value for GITHUB_TOKEN");
      expect(m.root.querySelector(".sti-mask")?.getAttribute("aria-hidden")).toBe("true");
      cleanup();
    }
  });
});

describe("single line and multi-line", () => {
  test("a paste with a newline into the single-line field switches and keeps the whole paste", () => {
    const m = mount({ keys: ["DB_USER", "DB_PASS", "DB_URL"], input: "single" });
    m.paste(ENV_BLOCK);
    expect(m.kind()).toBe("textarea");
    expect(m.field()?.value).toBe(ENV_BLOCK);
    expect(m.status()).toContain("multi-line · .env · 3 keys");
    expect(m.status()).toContain("✓ DB_PASS");
  });

  test("the paste lands at the caret, around text already typed", () => {
    const m = mount({ keys: ["GH_APP_KEY"] });
    m.type("FIXTURE-head-");
    const el = m.field() as HTMLInputElement;
    el.setSelectionRange(el.value.length, el.value.length);
    m.paste("line-one\r\nline-two\nline-three");
    expect(m.kind()).toBe("textarea");
    expect(m.field()?.value).toBe("FIXTURE-head-line-one\nline-two\nline-three");
  });

  test("a paste without a newline stays in the single-line field", () => {
    const m = mount();
    m.paste(TOKEN);
    expect(m.kind()).toBe("input");
  });

  test("switching back to single line is blocked while the text has newlines", () => {
    const m = mount({ keys: ["DB_USER", "DB_PASS", "DB_URL"] });
    m.type(ENV_BLOCK);
    fireEvent.click(m.button("Single line") as HTMLButtonElement);
    expect(m.kind()).toBe("textarea");
    expect(m.field()?.value).toBe(ENV_BLOCK);
    expect(m.status()).toContain("This value has 3 lines");
  });

  test("text is kept across a switch", () => {
    const m = mount();
    m.type(TOKEN);
    fireEvent.click(m.button("Multi-line") as HTMLButtonElement);
    expect(m.kind()).toBe("textarea");
    expect(m.field()?.value).toBe(TOKEN);
    fireEvent.click(m.button("Single line") as HTMLButtonElement);
    expect(m.kind()).toBe("input");
    expect(m.field()?.value).toBe(TOKEN);
  });
});

describe("submit", () => {
  test("⏎ submits the single-line field", () => {
    const m = mount();
    m.type(TOKEN);
    expect(m.status()).toContain("raw value detected");
    m.key("Enter");
    expect(m.calls).toEqual([{ text: TOKEN, as: "auto", ephemeral: false }]);
  });

  test("in multi-line ⏎ does not submit and ⌘⏎ does", () => {
    const m = mount({ keys: ["DB_USER", "DB_PASS", "DB_URL"] });
    m.type(ENV_BLOCK);
    m.key("Enter");
    expect(m.calls.length).toBe(0);
    m.key("Enter", { metaKey: true });
    expect(m.calls).toEqual([{ text: ENV_BLOCK, as: "auto", ephemeral: false }]);
  });

  test("Treat as is passed to onSubmit", () => {
    const m = mount({ keys: ["GH_APP_KEY"], input: "multi" });
    fireEvent.click(m.button("Raw value") as HTMLButtonElement);
    const value = `${TOKEN}\nFIXTURE-second-line`;
    m.type(value);
    expect(m.status()).toContain("multi-line · raw (forced)");
    fireEvent.click(m.button("Submit secret") as HTMLButtonElement);
    expect(m.calls).toEqual([{ text: value, as: "raw", ephemeral: false }]);
  });

  test("Just this once submits ephemeral", () => {
    const m = mount();
    m.type(`GITHUB_TOKEN=${TOKEN}`);
    expect(m.status()).toContain("dotenv detected · 1 key");
    fireEvent.click(m.button("Just this once (tmpfs, 1 h)") as HTMLButtonElement);
    expect(m.calls).toEqual([{ text: `GITHUB_TOKEN=${TOKEN}`, as: "auto", ephemeral: true }]);
  });

  test("an unrequested key blocks submit (D10)", () => {
    const m = mount({ input: "multi" });
    m.type(`GITHUB_TOKEN=${TOKEN}\nAWS_SECRET_ACCESS_KEY=${DB_PASS}`);
    // The pasted name is not echoed: it could be a fragment of the secret.
    expect(m.status()).toContain("✗ key on line 2");
    expect(m.status()).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(m.root.querySelector(".sti-issue.bad")?.textContent ?? "").toContain(
      "Line 2 sets a key that was not requested",
    );
    expect(m.button("Submit secret")?.disabled).toBe(true);
    expect(m.button("Just this once (tmpfs, 1 h)")?.disabled).toBe(true);
    m.key("Enter", { metaKey: true });
    expect(m.calls.length).toBe(0);
  });

  test("a placeholder value asks once, then submits on the second click", () => {
    const m = mount();
    m.type("changeme");
    expect(m.root.querySelector(".sti-issue.warn")?.textContent ?? "").toContain("placeholder");
    const submit = m.button("Submit secret") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(m.calls.length).toBe(0);
    expect(submit.textContent).toBe("Submit anyway?");
    fireEvent.click(submit);
    expect(m.calls).toEqual([{ text: "changeme", as: "auto", ephemeral: false }]);
  });

  test("submit is disabled while empty or busy", () => {
    const m = mount();
    expect(m.button("Submit secret")?.disabled).toBe(true);
    cleanup();
    const b = mount({ busy: true });
    b.type(TOKEN);
    expect(b.buttonStartingWith("Submitting")?.disabled).toBe(true);
    b.key("Enter");
    expect(b.calls.length).toBe(0);
  });

  test("the field is cleared after submit", () => {
    const m = mount();
    m.type(TOKEN);
    m.key("Enter");
    expect(m.field()?.value).toBe("");
    expect(m.status()).toContain("waiting for a paste");
    m.key("Enter");
    expect(m.calls.length).toBe(1);
  });

  test("Decline calls onDecline and nothing else", () => {
    const m = mount();
    m.type(TOKEN);
    fireEvent.click(m.button("Decline") as HTMLButtonElement);
    expect(m.declines()).toBe(1);
    expect(m.calls.length).toBe(0);
  });
});

describe("clearing and masking", () => {
  test("Esc clears the box without declining", () => {
    const m = mount();
    m.type(TOKEN);
    m.key("Escape");
    expect(m.field()?.value).toBe("");
    expect(m.declines()).toBe(0);
    expect(m.calls.length).toBe(0);
    expect(m.status()).toContain("waiting for a paste");
  });

  test("unmount empties the field", () => {
    const m = mount();
    m.type(TOKEN);
    const el = m.field() as HTMLInputElement;
    m.view.unmount();
    expect(el.value).toBe("");
  });

  test("the value never reaches rendered text or markup, revealed or not", () => {
    const m = mount({ keys: ["DB_USER", "DB_PASS", "DB_URL"] });
    m.type(ENV_BLOCK);
    for (const v of [DB_USER, DB_PASS, DB_URL]) {
      expect(document.body.textContent?.includes(v)).toBe(false);
      expect(document.body.innerHTML.includes(v)).toBe(false);
    }
    m.key("Alt");
    expect(m.root.querySelector(".sti-field")?.classList.contains("revealed")).toBe(true);
    for (const v of [DB_USER, DB_PASS, DB_URL]) {
      expect(document.body.innerHTML.includes(v)).toBe(false);
    }
    expect(m.field()?.value).toBe(ENV_BLOCK);
  });

  test("the masked view keeps .env key names and one dot per character", () => {
    const m = mount({ keys: ["DB_USER", "DB_PASS", "DB_URL"] });
    m.type(ENV_BLOCK);
    const lines = Array.from(m.root.querySelectorAll(".sti-dots .sti-line")).map((l) => l.textContent);
    expect(lines).toEqual([
      `DB_USER=${"•".repeat(DB_USER.length)}`,
      `DB_PASS=${"•".repeat(DB_PASS.length)}`,
      `DB_URL=${"•".repeat(DB_URL.length)}`,
    ]);
    const gutter = Array.from(m.root.querySelectorAll(".sti-gutter .sti-line")).map(
      (l) => l.textContent,
    );
    expect(gutter).toEqual(["1", "2", "3"]);
    expect(m.status()).toContain(`✓ DB_PASS · ${DB_PASS.length} chars`);
  });

  test("a raw value is all dots", () => {
    const m = mount();
    m.type(TOKEN);
    expect(m.masked()).toBe("•".repeat(TOKEN.length));
  });

  test("⌥ reveals only while held", () => {
    const m = mount();
    m.type(TOKEN);
    const revealed = () => m.root.querySelector(".sti-field")?.classList.contains("revealed") ?? false;
    expect(revealed()).toBe(false);
    m.key("Alt");
    expect(revealed()).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
    });
    expect(revealed()).toBe(false);
    m.key("Alt");
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(revealed()).toBe(false);
  });

  test("copy, cut and drag of the masked value are blocked; revealed, they are the operator's", () => {
    const m = mount();
    m.type(TOKEN);
    const el = () => m.field() as HTMLElement;
    // fireEvent answers dispatchEvent: false when the handler prevented the default.
    expect(fireEvent.copy(el())).toBe(false);
    expect(fireEvent.cut(el())).toBe(false);
    expect(fireEvent.dragStart(el())).toBe(false);
    m.key("Alt");
    expect(fireEvent.copy(el())).toBe(true);
    expect(fireEvent.cut(el())).toBe(true);
    expect(fireEvent.dragStart(el())).toBe(true);
  });

  test("a reveal hides itself after 10 s idle", () => {
    const m = mount();
    m.type(TOKEN);
    const revealed = () => m.root.querySelector(".sti-field")?.classList.contains("revealed") ?? false;
    // The idle timer, caught as ⌥ arms it: no fake clock on the globals React parks on.
    const platform = globalThis.setTimeout;
    const armed: { fn: () => void; ms: number }[] = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      armed.push({ fn, ms: ms ?? 0 });
      return platform(() => undefined, 0);
    }) as typeof setTimeout;
    try {
      m.key("Alt");
    } finally {
      globalThis.setTimeout = platform;
    }
    expect(revealed()).toBe(true);
    const idle = armed.find((t) => t.ms === 10_000);
    expect(idle !== undefined).toBe(true);
    act(() => idle?.fn());
    expect(revealed()).toBe(false);
  });

  test("over 4 KB suggests request_file", () => {
    const m = mount({ keys: ["GH_APP_KEY"], input: "multi" });
    m.type(`FIXTURE-${"k".repeat(70)}\n`.repeat(70));
    expect(m.status()).toContain("request_file");
  });

  test("the box's refusal shows under the field", () => {
    const m = mount({ boxError: "FIXTURE refusal from the box" });
    expect(m.status()).toContain("FIXTURE refusal from the box");
  });
});
