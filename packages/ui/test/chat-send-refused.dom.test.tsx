/**
 * A message nothing took is never lost (attachments review, Phase 2): a
 * composer whose send is refused keeps its text, a queued row leaves the
 * queue only once a send is accepted, a paste of text that also carries an
 * image of it stays text, and a failure card finds the files its prompt
 * carried even after the transcript was read back from the box.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "./dom.ts";
import { Composer, isFilePaste } from "../src/chat/components/Composer.tsx";
import { useSendQueue } from "../src/chat/chat-queue.ts";
import { failedTurnPrompt } from "../src/chat/chat-recovery.ts";
import type { ChatMessageView } from "../src/api/index.ts";
import type { TurnPrompt } from "../src/chat/chat-conversation-record.ts";

afterEach(cleanup);

describe("a refused send keeps the message", () => {
  function mountComposer(answer: boolean) {
    const sends: string[] = [];
    render(
      <Composer
        destination={{ state: "known", origin: "portal", detail: null }}
        placeholder="Message…"
        enabled
        sending={false}
        onSend={(text) => {
          sends.push(text);
          return answer;
        }}
        onAbort={() => undefined}
      />,
    );
    const input = screen.getByLabelText("Message…") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "keep me" } });
    fireEvent.keyDown(input, { key: "Enter" });
    return { sends, value: () => input.value };
  }

  test("Enter whose send is refused leaves the text in the input", () => {
    const h = mountComposer(false);
    expect(h.sends).toEqual(["keep me"]);
    expect(h.value()).toBe("keep me");
  });

  test("Enter whose send is taken clears it", () => {
    const h = mountComposer(true);
    expect(h.value()).toBe("");
  });

  test("a queued row sent now stays queued when the store refuses it", async () => {
    const target = { instance: "atlas", bot: "scribe", session: null };
    let q!: ReturnType<typeof useSendQueue>;
    let tries = 0;
    function Harness() {
      q = useSendQueue({
        selection: target,
        sending: false,
        turnError: null,
        reconnecting: false,
        send: () => {
          tries += 1;
          return false;
        },
        abort: async () => undefined,
        steer: async () => "refused",
      });
      return null;
    }
    render(<Harness />);
    act(() => q.queueMessage("held"));
    // The drain tried it once and parked the queue on the refusal.
    expect(q.queued.map((r) => r.text)).toEqual(["held"]);
    let taken: boolean | null = null;
    await act(async () => {
      taken = await q.sendQueuedNow(q.queued[0]!.id);
    });
    expect(taken === false).toBe(true);
    expect(tries >= 2).toBe(true);
    expect(q.queued.map((r) => r.text)).toEqual(["held"]);
  });
});

describe("a paste", () => {
  const png = new File([new Uint8Array([1])], "image.png", { type: "image/png" });
  const clip = (files: File[], data: Record<string, string>) => ({
    files: files as unknown as FileList,
    types: Object.keys(data).concat(files.length ? ["Files"] : []),
    getData: (type: string) => data[type] ?? "",
  });

  test("is files only when no words came with them", () => {
    expect(isFilePaste(clip([png], {}))).toBe(true);
    expect(isFilePaste(clip([png], { "text/plain": "  " }))).toBe(true);
    expect(isFilePaste(clip([], { "text/plain": "hi" }))).toBe(false);
  });

  test("of spreadsheet cells or a web page stays text", () => {
    expect(isFilePaste(clip([png], { "text/plain": "a\tb\n1\t2" }))).toBe(false);
    expect(isFilePaste(clip([png], { "text/html": "<table></table>", "text/plain": "" }))).toBe(false);
  });

  test("of a Finder file, whose text is its own name, is the file", () => {
    expect(isFilePaste(clip([png], { "text/plain": "image.png" }))).toBe(true);
  });
});

describe("a failure card's prompt", () => {
  const view = (id: string, role: "user" | "bot", blocks: unknown[]): ChatMessageView =>
    ({
      id,
      session: "S",
      role,
      author: null,
      at: "2026-10-13T00:00:00Z",
      blocks,
      usage: null,
      error: role === "bot" ? "boom" : null,
      incomplete: null,
    }) as unknown as ChatMessageView;
  const files = [{ file_id: "f_1", name: "a.png", size: 1, mime: "image/png" }];
  const remembered: ReadonlyMap<string, TurnPrompt> = new Map([
    ["local:echo-1", { text: "look", attachments: files }],
  ]);

  test("read back from the box still finds the files its prompt carried", () => {
    const messages = [
      view("box:u1", "user", [
        { kind: "text", markdown: "look" },
        { kind: "attachment", name: "a.png", mime: "image/png", bytes: 1, href: "x", file_id: "f_1" },
      ]),
      view("box:b1", "bot", []),
    ];
    expect(failedTurnPrompt(messages, ["box:b1"], remembered)).toEqual({
      text: "look",
      attachments: files,
    });
  });

  test("a text-only prompt never picks up another send's files", () => {
    const messages = [
      view("box:u2", "user", [{ kind: "text", markdown: "look" }]),
      view("box:b2", "bot", []),
    ];
    expect(failedTurnPrompt(messages, ["box:b2"], remembered)).toEqual({
      text: "look",
      attachments: [],
    });
  });
});
