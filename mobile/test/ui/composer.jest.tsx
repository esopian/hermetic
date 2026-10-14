import { fireEvent, screen, within } from "@testing-library/react-native";
import { useState } from "react";
import {
  Composer,
  type ComposerProps,
  composerMode,
  ECHO_MS,
  isAutocorrectEcho,
} from "../../src/chat/Composer.tsx";
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
    expect(screen.getByText(/Queue paused · 2 waiting/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Send now: next thing"));
    expect(h.onSendNow).toHaveBeenCalledWith("next thing", "q1");
    await fireEvent.press(screen.getByLabelText("Remove queued: after that"));
    expect(h.onUnqueue).toHaveBeenCalledWith("q2");
  });

  test("an open question is called out", async () => {
    await renderUi(<Harness {...base} {...handlers()} sending questionOpen />);
    expect(screen.getByText(/A question is waiting above — Send now skips it/)).toBeTruthy();
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
