import { act, fireEvent, screen, within } from "@testing-library/react-native";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { ActionSheetIOS } from "react-native";
import {
  Composer,
  type ComposerProps,
  composerMode,
  ECHO_MS,
  isAutocorrectEcho,
  questionHint,
} from "../../src/chat/Composer.tsx";
import { type PendingAttachment, pendingAttachment } from "../../src/client/attachments.ts";
import { composerState, threadState } from "../../src/client/chat-logic.ts";
import { renderUi } from "../helpers/render.tsx";

type Handlers = Pick<ComposerProps, "onSend" | "onQueue" | "onSendNow" | "onStop" | "onUnqueue">;

function handlers(): jest.Mocked<Handlers> {
  return {
    onSend: jest.fn(),
    onQueue: jest.fn(),
    onSendNow: jest.fn(),
    onStop: jest.fn(),
    onUnqueue: jest.fn(),
  };
}

function Harness(
  props: Omit<ComposerProps, "draft" | "onDraft" | keyof Handlers> & Handlers & { initial?: string },
) {
  const [draft, setDraft] = useState(props.initial ?? "");
  return <Composer {...props} draft={draft} onDraft={setDraft} />;
}

const base = {
  enabled: true,
  placeholder: "Message…",
  sending: false,
  aborting: false,
  queue: [],
  parked: false,
};

describe("composerMode", () => {
  test("the state table", () => {
    const m = (o: Partial<Parameters<typeof composerMode>[0]>) =>
      composerMode({ enabled: true, sending: false, aborting: false, draft: "", ...o });
    expect(m({})).toBe("send");
    expect(m({ enabled: false })).toBe("disabled");
    expect(m({ sending: true })).toBe("stop");
    expect(m({ sending: true, draft: "more" })).toBe("queue");
    expect(m({ sending: true, aborting: true })).toBe("stopping");
    expect(m({ sending: true, enabled: false, draft: "x" })).toBe("queue");
  });

  test("disabled placeholders come from the thread state", () => {
    const at = (status: string | null, extra: Partial<Parameters<typeof threadState>[0]> = {}) =>
      composerState(
        threadState({ status, reachable: true, reconnecting: false, empty: false, ...extra }),
      );
    expect(at("stopped")).toEqual({
      enabled: false,
      placeholder: "the agent is stopped — start it to send a message",
    });
    expect(at("destroyed").placeholder).toBe("destroyed is terminal — this transcript is read-only");
    expect(at("ready", { reconnecting: true }).placeholder).toBe("reconnecting…");
    expect(at("ready", { reachable: false }).placeholder).toBe("no route to this box");
    expect(at("bootstrapping")).toEqual({ enabled: true, placeholder: "Queue a first message…" });
    expect(at("ready")).toEqual({ enabled: true, placeholder: "Message…" });
  });
});

describe("Composer", () => {
  test("idle: Send is disabled until there is text, then sends and clears", async () => {
    const h = handlers();
    await renderUi(<Harness {...base} {...h} />);
    expect(screen.getByLabelText("Send").props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText("Message"), "  hello  ");
    await fireEvent.press(screen.getByLabelText("Send"));
    expect(h.onSend).toHaveBeenCalledWith("hello");
    expect(screen.getByLabelText("Message").props.value).toBe("");
  });

  test("disabled: the placeholder says why and Send stays off", async () => {
    const h = handlers();
    await renderUi(
      <Harness {...base} {...h} enabled={false} placeholder="no route to this box" initial="x" />,
    );
    expect(screen.getByLabelText("Message").props.placeholder).toBe("no route to this box");
    expect(screen.getByLabelText("Message").props.editable).toBe(false);
    expect(screen.getByLabelText("Send").props.accessibilityState.disabled).toBe(true);
  });

  test("sending with nothing typed: Stop", async () => {
    const h = handlers();
    await renderUi(<Harness {...base} {...h} sending />);
    await fireEvent.press(screen.getByLabelText("Stop turn"));
    expect(h.onStop).toHaveBeenCalled();
    expect(screen.queryByLabelText("Send")).toBeNull();
    expect(screen.queryByText(/Send now steers/)).toBeNull();
  });

  test("sending with text: Queue queues, Send now steers, Stop stays, and a line says which is which", async () => {
    const h = handlers();
    await renderUi(<Harness {...base} {...h} sending initial="first" />);
    expect(screen.getByText("Queue waits for the turn · Send now steers it")).toBeTruthy();
    expect(screen.getByText("Send now")).toBeTruthy();
    // A draft never hides Stop (the desktop's Esc stops whatever is typed):
    // it stays as a round button beside Send now and Queue, and leaves the draft be.
    await fireEvent.press(screen.getByLabelText("Stop turn"));
    expect(h.onStop).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Message").props.value).toBe("first");
    await fireEvent.press(screen.getByLabelText("Queue"));
    expect(h.onQueue).toHaveBeenCalledWith("first");
    await fireEvent.changeText(screen.getByLabelText("Message"), "redirect");
    await fireEvent.press(screen.getByLabelText("Send now"));
    expect(h.onSendNow).toHaveBeenCalledWith("redirect");
  });

  test("queue mode: the input keeps its row; Stop, Send now and Queue sit under it", async () => {
    const h = handlers();
    await renderUi(<Harness {...base} {...h} sending />);
    const before = screen.getByLabelText("Message");
    // Typing switches stop → queue mode without remounting the input (focus and keyboard stay).
    await fireEvent.changeText(before, "steer this");
    expect(screen.getByLabelText("Message")).toBe(before);
    const row = within(screen.getByTestId("composer-input-row"));
    expect(row.getByLabelText("Message")).toBeTruthy();
    for (const label of ["Stop turn", "Send now", "Queue"]) {
      expect(row.queryByLabelText(label)).toBeNull();
      expect(within(screen.getByTestId("composer-queue-actions")).getByLabelText(label)).toBeTruthy();
    }
    // Back to stop mode: the actions row goes, the input is still the same one.
    await fireEvent.changeText(screen.getByLabelText("Message"), "");
    expect(screen.queryByTestId("composer-queue-actions")).toBeNull();
    expect(screen.getByLabelText("Message")).toBe(before);
    expect(row.getByLabelText("Stop turn")).toBeTruthy();
  });

  test("stopping: the button is busy", async () => {
    await renderUi(<Harness {...base} {...handlers()} sending aborting />);
    expect(screen.getByLabelText("Stop turn").props.accessibilityState.busy).toBe(true);
  });

  test("queued rows: send now and remove, and the parked line", async () => {
    const h = handlers();
    await renderUi(
      <Harness
        {...base}
        {...h}
        sending
        parked
        queue={[
          { id: "q1", text: "next thing", at: "2026-10-13T10:00:00.000Z" },
          { id: "q2", text: "after that", at: "2026-10-13T10:00:01.000Z" },
        ]}
      />,
    );
    expect(screen.getByText(/Queue paused · 2\swaiting/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Send now: next thing"));
    expect(h.onSendNow).toHaveBeenCalledWith("next thing", "q1");
    await fireEvent.press(screen.getByLabelText("Remove queued: after that"));
    expect(h.onUnqueue).toHaveBeenCalledWith("q2");
  });

  test("an open question is called out", async () => {
    await renderUi(<Harness {...base} {...handlers()} sending questionOpen />);
    expect(screen.getByText("A question is waiting above · Send now skips it")).toBeTruthy();
  });

  test("an open question over a paused queue is one line, saying paused", async () => {
    await renderUi(
      <Harness
        {...base}
        {...handlers()}
        sending
        parked
        questionOpen
        queue={[{ id: "q1", text: "next thing", at: "2026-10-13T10:00:00.000Z" }]}
      />,
    );
    expect(screen.getByText("A question is waiting above · queue paused, 1\u00a0waiting")).toBeTruthy();
    expect(screen.queryByText(/Queue paused/)).toBeNull();
  });
});

describe("questionHint", () => {
  test("a parked queue says paused; a running one says queued; the count never wraps alone", () => {
    expect(questionHint(0, false)).toBe("A question is waiting above · Send now skips it");
    expect(questionHint(1, true)).toBe("A question is waiting above · queue paused, 1\u00a0waiting");
    expect(questionHint(2, false)).toBe("A question is waiting above · 2\u00a0queued behind it");
  });
});

describe("isAutocorrectEcho", () => {
  test("the corrected text straight after a send is an echo", () => {
    expect(isAutocorrectEcho("And summarize", "And summarise", 30)).toBe(true);
    expect(isAutocorrectEcho("and summarise", "and summarise", 30)).toBe(true);
  });

  test("new typing, an empty field or a late change is not", () => {
    expect(isAutocorrectEcho("o", "And summarise", 30)).toBe(false);
    expect(isAutocorrectEcho("redirect", "first", 30)).toBe(false);
    expect(isAutocorrectEcho("go ahead now", "teh cat sat", 30)).toBe(false);
    expect(isAutocorrectEcho("", "And summarise", 30)).toBe(false);
    expect(isAutocorrectEcho("And summarize", "And summarise", ECHO_MS + 1)).toBe(false);
  });

  test("the composer drops the echo and keeps typing after it", async () => {
    const h = handlers();
    await renderUi(<Harness {...base} {...h} sending initial="and summarise" />);
    await fireEvent.press(screen.getByLabelText("Queue"));
    expect(h.onQueue).toHaveBeenCalledWith("and summarise");
    await fireEvent.changeText(screen.getByLabelText("Message"), "And summarize");
    expect(screen.getByLabelText("Message").props.value).toBe("");
    await fireEvent.changeText(screen.getByLabelText("Message"), "n");
    expect(screen.getByLabelText("Message").props.value).toBe("n");
  });
});

describe("Composer: attachments", () => {
  const photo = (over: Partial<PendingAttachment> = {}): PendingAttachment => ({
    ...pendingAttachment(
      { name: "cat.jpg", uri: "file:///tmp/cat.jpg", mime: "image/jpeg", size: 2048, kind: "image" },
      "a1",
    ),
    ...over,
  });
  const doc = (over: Partial<PendingAttachment> = {}): PendingAttachment => ({
    ...pendingAttachment(
      { name: "notes.pdf", uri: "file:///tmp/notes.pdf", size: 3 * 1024 * 1024, kind: "file" },
      "a2",
    ),
    ...over,
  });
  const attach = () => ({
    onAttach: jest.fn(),
    onRemoveAttachment: jest.fn(),
    onRetryAttachment: jest.fn(),
  });

  test("the attach button shows by capability: hidden, enabled, or disabled with a line", async () => {
    const h = handlers();
    const view = await renderUi(<Harness {...base} {...h} />);
    expect(screen.queryByLabelText("Attach")).toBeNull();
    await view.rerender(<Harness {...base} {...h} {...attach()} canAttach />);
    expect(screen.getByLabelText("Attach").props.accessibilityState.disabled).toBe(false);
    expect(screen.queryByText("This instance has no file service")).toBeNull();
    await view.rerender(<Harness {...base} {...h} {...attach()} canAttach="no-service" />);
    expect(screen.getByLabelText("Attach").props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText("This instance has no file service")).toBeTruthy();
  });

  test("attach opens the sheet and hands back the chosen kind", async () => {
    const sheet = jest
      .spyOn(ActionSheetIOS, "showActionSheetWithOptions")
      .mockImplementation((options, pick) => {
        expect(options.options).toEqual(["Photo library", "Take photo", "Choose file", "Cancel"]);
        pick(2);
      });
    const a = attach();
    await renderUi(<Harness {...base} {...handlers()} {...a} canAttach />);
    await fireEvent.press(screen.getByLabelText("Attach"));
    expect(a.onAttach).toHaveBeenCalledWith("file");
    sheet.mockRestore();
  });

  test("chips: a thumbnail for an image, name and size for a file; remove", async () => {
    const a = attach();
    await renderUi(
      <Harness {...base} {...handlers()} {...a} canAttach attachments={[photo(), doc()]} />,
    );
    const tray = screen.getByTestId("attach-tray");
    expect(within(tray).getByLabelText("cat.jpg")).toBeTruthy();
    expect(within(tray).getByText("notes.pdf")).toBeTruthy();
    expect(within(tray).getByText("3.0 MB")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Remove notes.pdf"));
    expect(a.onRemoveAttachment).toHaveBeenCalledWith("a2");
  });

  test("files with no text send; Send is disabled while a file uploads", async () => {
    const h = handlers();
    const view = await renderUi(
      <Harness {...base} {...h} {...attach()} canAttach attachments={[photo()]} />,
    );
    const send = screen.getByLabelText("Send");
    expect(send.props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(send);
    expect(h.onSend).toHaveBeenCalledWith("");
    await view.rerender(
      <Harness {...base} {...h} {...attach()} canAttach attachments={[photo({ status: "staging" })]} />,
    );
    expect(screen.queryByLabelText("Send")).toBeNull();
    expect(screen.getByLabelText("Uploading…").props.accessibilityState.disabled).toBe(true);
    expect(screen.getByLabelText("Uploading cat.jpg")).toBeTruthy();
  });

  test("while any file uploads, no file leaves the tray and none joins it", async () => {
    const a = attach();
    await renderUi(
      <Harness
        {...base}
        {...handlers()}
        {...a}
        canAttach
        attachments={[photo({ status: "staging" }), doc({ status: "staged" })]}
      />,
    );
    expect(screen.getByLabelText("Remove notes.pdf").props.accessibilityState.disabled).toBe(true);
    expect(screen.getByLabelText("Remove cat.jpg").props.accessibilityState.disabled).toBe(true);
    expect(screen.getByLabelText("Attach").props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByLabelText("Remove notes.pdf"));
    expect(a.onRemoveAttachment).not.toHaveBeenCalled();
  });

  test("a failed file shows its copy, blocks Send, and retries", async () => {
    const h = handlers();
    const a = attach();
    await renderUi(
      <Harness
        {...base}
        {...h}
        {...a}
        canAttach
        initial="look at this"
        attachments={[doc({ status: "failed", error: { code: "FILE_TOO_LARGE", message: "too big" } })]}
      />,
    );
    expect(screen.getByText("That file is too large to attach.")).toBeTruthy();
    expect(screen.getByLabelText("Send").props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByLabelText("Retry notes.pdf"));
    expect(a.onRetryAttachment).toHaveBeenCalledWith("a2");
  });
});

describe("Composer: paste", () => {
  const hasImage = Clipboard.hasImageAsync as jest.Mock;
  afterEach(() => hasImage.mockReset().mockResolvedValue(false));
  const image = {
    type: "image" as const,
    data: "data:image/png;base64,iVBORw0K",
    size: { width: 2, height: 2 },
  };

  test("an image on the clipboard offers the paste control, and its answer goes to onPaste", async () => {
    hasImage.mockResolvedValue(true);
    const onPaste = jest.fn();
    await renderUi(
      <Harness {...base} {...handlers()} canAttach onAttach={jest.fn()} onPaste={onPaste} />,
    );
    expect(await screen.findByText("Image on the clipboard")).toBeTruthy();
    await fireEvent(screen.getByTestId("composer-paste-button"), "press", image);
    expect(onPaste).toHaveBeenCalledWith(image);
  });

  test("a copy heard while open shows or hides the line", async () => {
    let listener: ((e: { contentTypes: string[] }) => void) | undefined;
    (Clipboard.addClipboardListener as jest.Mock).mockImplementationOnce((fn) => {
      listener = fn;
      return { remove: jest.fn() };
    });
    await renderUi(
      <Harness {...base} {...handlers()} canAttach onAttach={jest.fn()} onPaste={jest.fn()} />,
    );
    expect(screen.queryByTestId("composer-paste")).toBeNull();
    await act(async () => listener?.({ contentTypes: ["image"] }));
    expect(screen.getByTestId("composer-paste")).toBeTruthy();
    await act(async () => listener?.({ contentTypes: ["plain-text"] }));
    expect(screen.queryByTestId("composer-paste")).toBeNull();
  });

  test("text on the clipboard: no paste line, and pasted text lands in the draft as typed", async () => {
    const onPaste = jest.fn();
    const h = handlers();
    await renderUi(<Harness {...base} {...h} canAttach onAttach={jest.fn()} onPaste={onPaste} />);
    await act(async () => {});
    expect(screen.queryByTestId("composer-paste")).toBeNull();
    await fireEvent.changeText(screen.getByLabelText("Message"), "pasted words");
    await fireEvent.press(screen.getByLabelText("Send"));
    expect(h.onSend).toHaveBeenCalledWith("pasted words");
    expect(onPaste).not.toHaveBeenCalled();
  });

  test("no paste where the draft cannot take a file", async () => {
    hasImage.mockResolvedValue(true);
    const view = await renderUi(
      <Harness
        {...base}
        {...handlers()}
        canAttach="no-service"
        onAttach={jest.fn()}
        onPaste={jest.fn()}
      />,
    );
    await act(async () => {});
    expect(screen.queryByTestId("composer-paste")).toBeNull();
    await view.rerender(<Harness {...base} {...handlers()} canAttach={false} onPaste={jest.fn()} />);
    await act(async () => {});
    expect(screen.queryByTestId("composer-paste")).toBeNull();
  });
});
