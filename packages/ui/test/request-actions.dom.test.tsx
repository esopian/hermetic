/**
 * The clarify card: one form per request, however many questions it carries.
 *
 * The gateway keeps a turn parked until every question of a batch has an
 * answer, so the card must collect them all and confirm once — a card per
 * question that each said "Response sent." while the turn went on waiting was
 * the bug. These drive the real block renderer with a recording responder.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "./dom.ts";
import type { ReactNode } from "react";
import type { ChatBlockView } from "../src/api/index.ts";
import { Block } from "../src/chat/components/blocks/index.tsx";
import { BotResponses } from "../src/chat/components/BotResponses.tsx";
import type { Decision } from "../src/chat/components/BotResponses.tsx";
import { ChatProvider, useChat } from "../src/chat/chat-state.tsx";
import type { Chat, ChatApi } from "../src/chat/chat-state.tsx";
import type { ClosedRequest } from "../src/chat/chat-requests.ts";
import { ownsEscape } from "../src/lib/focus.ts";

afterEach(cleanup);

const NOW = new Date("2026-10-12T12:00:00Z").getTime();

function draw(value: Record<string, unknown>, respond?: (d: Decision) => Promise<unknown>) {
  const sent: Decision[] = [];
  const block = <Block block={value as unknown as ChatBlockView} now={NOW} />;
  const utils = render(
    respond === undefined ? (
      block
    ) : (
      <BotResponses.Provider
        value={async (decision) => {
          sent.push(decision);
          return respond(decision);
        }}
      >
        {block}
      </BotResponses.Provider>
    ),
  );
  return { ...utils, sent };
}

const ok = async () => ({ status: "ok" });

const batch = {
  kind: "question",
  request_id: "r1",
  prompt: "What to drink?",
  choices: ["Coffee (Recommended)", "Tea"],
  questions: [
    {
      id: "q0",
      prompt: "What to drink?",
      choices: ["Coffee (Recommended)", "Tea"],
      multi_select: false,
      answer: null,
    },
    {
      id: "q1",
      prompt: "When?",
      choices: ["Morning", "Noon", "Night"],
      multi_select: true,
      answer: null,
    },
  ],
};

const confirm = () => screen.getByRole("button", { name: "Confirm and continue" }) as HTMLButtonElement;

describe("a batch clarify", () => {
  test("is one card listing every question", () => {
    const { container } = draw(batch, ok);
    expect(container.querySelectorAll(".ch-card")).toHaveLength(1);
    expect(screen.getByText("What to drink?")).toBeDefined();
    expect(screen.getByText("When?")).toBeDefined();
    expect(screen.getByText("0 of 2 answered")).toBeDefined();
  });

  test("confirms once, with every answer keyed by its question", async () => {
    const { sent } = draw(batch, ok);
    expect(confirm().disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Coffee (Recommended)" }));
    expect(screen.getByText("1 of 2 answered")).toBeDefined();
    // One of two is not enough: the turn would still be waiting.
    expect(confirm().disabled).toBe(true);
    const when = within(screen.getByRole("group", { name: "When?" }));
    fireEvent.click(when.getByRole("checkbox", { name: "Night" }));
    fireEvent.click(when.getByRole("checkbox", { name: "Morning" }));
    expect(when.getByRole("checkbox", { name: "Night" }).getAttribute("aria-checked")).toBe("true");
    expect(confirm().disabled).toBe(false);
    fireEvent.click(confirm());
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Response sent."));
    expect(sent).toEqual([
      {
        request_id: "r1",
        kind: "question",
        // A choice goes out bare, as Hermes Desktop sends it.
        answers: { q0: "Coffee", q1: '["Morning","Night"]' },
      },
    ]);
  });

  test("multi-select toggles, and typed text is one more answer", async () => {
    const { sent } = draw(batch, ok);
    fireEvent.click(screen.getByRole("radio", { name: "Tea" }));
    const when = within(screen.getByRole("group", { name: "When?" }));
    fireEvent.click(when.getByRole("checkbox", { name: "Noon" }));
    fireEvent.click(when.getByRole("checkbox", { name: "Noon" }));
    expect(confirm().disabled).toBe(true);
    fireEvent.click(when.getByRole("checkbox", { name: "Night" }));
    fireEvent.change(screen.getByLabelText("Answer: When?"), { target: { value: " dawn " } });
    fireEvent.click(confirm());
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.answers).toEqual({ q0: "Tea", q1: '["Night","dawn"]' });
  });

  test("Skip declines the whole request", async () => {
    const { sent } = draw(batch, ok);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(sent).toEqual([{ request_id: "r1", kind: "question", skip: true }]));
  });

  test("settles in place to each prompt with its answer, above the status line", async () => {
    const { container } = draw(batch, ok);
    fireEvent.click(screen.getByRole("radio", { name: "Coffee (Recommended)" }));
    const when = within(screen.getByRole("group", { name: "When?" }));
    fireEvent.click(when.getByRole("checkbox", { name: "Morning" }));
    fireEvent.click(when.getByRole("checkbox", { name: "Night" }));
    fireEvent.change(screen.getByLabelText("Answer: When?"), { target: { value: "dawn" } });
    fireEvent.click(confirm());
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Response sent."));
    const settled = container.querySelector(".bm-settled")!;
    expect(Array.from(settled.querySelectorAll("strong"), (el) => el.textContent)).toEqual([
      "What to drink?",
      "When?",
    ]);
    // The answers read bare; multi-select joins.
    expect(Array.from(settled.querySelectorAll(".bm-settled-answer"), (el) => el.textContent)).toEqual([
      "Coffee",
      "Morning, Night, dawn",
    ]);
    expect(settled.lastElementChild?.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("button", { name: "Confirm and continue" }) === null).toBe(true);
    expect(container.querySelectorAll("button.ch-prompt")).toHaveLength(0);
  });

  test("a skipped card settles with every question marked Skipped", async () => {
    const { container } = draw(batch, ok);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Response sent."));
    const settled = container.querySelector(".bm-settled")!;
    expect(Array.from(settled.querySelectorAll("strong"), (el) => el.textContent)).toEqual([
      "What to drink?",
      "When?",
    ]);
    expect(Array.from(settled.querySelectorAll(".bm-settled-skipped"), (el) => el.textContent)).toEqual(
      ["Skipped", "Skipped"],
    );
    expect(settled.querySelectorAll(".bm-settled-answer")).toHaveLength(0);
  });

  test("a replayed lock is pre-staged", () => {
    draw(
      {
        ...batch,
        questions: [
          { ...batch.questions[0], answer: "Coffee" },
          { ...batch.questions[1], answer: '["Noon","late"]' },
        ],
      },
      ok,
    );
    expect(
      screen.getByRole("radio", { name: "Coffee (Recommended)" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByRole("checkbox", { name: "Noon" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Answer: When?") as HTMLInputElement).value).toBe("late");
    expect(confirm().disabled).toBe(false);
  });

  test("an expired answer says so rather than claiming it was sent", async () => {
    draw(batch, async () => ({ status: "expired" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Already answered or expired."),
    );
    // The prompts stay, but nothing is shown as the answer: the box never took it.
    expect(screen.getByText("What to drink?")).toBeDefined();
    expect(screen.queryByText("Skipped") === null).toBe(true);
  });
});

describe("a single question", () => {
  const single = { kind: "question", request_id: "r2", prompt: "Proceed?", choices: ["Yes", "No"] };

  test("a picked choice is the answer", async () => {
    const { sent } = draw(single, ok);
    expect(screen.queryByText(/answered/)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Yes" }));
    fireEvent.click(confirm());
    await waitFor(() => expect(sent).toEqual([{ request_id: "r2", kind: "question", answer: "Yes" }]));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Response sent."));
    expect(document.querySelector(".bm-settled strong")?.textContent).toBe("Proceed?");
    expect(document.querySelector(".bm-settled-answer")?.textContent).toBe("Yes");
  });

  test("typed text replaces the pick, and picking clears the text", async () => {
    const { sent } = draw(single, ok);
    const other = screen.getByLabelText("Answer: Proceed?") as HTMLInputElement;
    fireEvent.click(screen.getByRole("radio", { name: "Yes" }));
    fireEvent.change(other, { target: { value: "only after the backup" } });
    expect(screen.getByRole("radio", { name: "Yes" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("radio", { name: "No" }));
    expect(other.value).toBe("");
    fireEvent.change(other, { target: { value: "only after the backup" } });
    fireEvent.click(confirm());
    await waitFor(() =>
      expect(sent).toEqual([{ request_id: "r2", kind: "question", answer: "only after the backup" }]),
    );
  });

  test("a failed respond is shown and the form stays", async () => {
    draw(single, async () => {
      throw new Error("box unreachable");
    });
    fireEvent.click(screen.getByRole("radio", { name: "Yes" }));
    fireEvent.click(confirm());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("box unreachable"));
    expect(confirm().disabled).toBe(false);
  });
});

describe("with nowhere to respond", () => {
  test("every question of a batch is listed, its choices disabled, with a note", () => {
    const { container } = draw(batch);
    expect(screen.getByText("What to drink?")).toBeDefined();
    expect(screen.getByText("When?")).toBeDefined();
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button.ch-prompt"));
    expect(buttons).toHaveLength(5);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    expect(container.querySelector("input")).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm and continue" })).toBeNull();
    expect(screen.getByText("Respond in Hermes. Choices are shown here for reference.")).toBeDefined();
  });

  test("a request with no id cannot be answered even with a responder", () => {
    const { container } = draw({ ...batch, request_id: null }, ok);
    expect(container.querySelector("input")).toBeNull();
    expect(screen.getByText("Respond in Hermes. Choices are shown here for reference.")).toBeDefined();
  });
});

describe("the rows", () => {
  test("single-select is a radiogroup and multi-select checkboxes, each lettered", () => {
    const { container } = draw(batch, ok);
    const drinkGroup = screen.getByRole("group", { name: "What to drink?" });
    const drink = within(within(drinkGroup).getByRole("radiogroup"));
    expect(drink.getAllByRole("radio")).toHaveLength(2);
    // The prompt names the question's group once; the radiogroup inside is not named again.
    expect(within(drinkGroup).getByRole("radiogroup").hasAttribute("aria-label")).toBe(false);
    const when = within(screen.getByRole("group", { name: "When?" }));
    expect(when.getAllByRole("checkbox")).toHaveLength(3);
    expect(when.queryAllByRole("radio")).toHaveLength(0);
    // Only the multi-select says any number may be picked.
    expect(Array.from(container.querySelectorAll(".bm-question-hint"), (el) => el.textContent)).toEqual(
      ["choose any"],
    );
    const badges = (scope: HTMLElement) =>
      Array.from(scope.querySelectorAll(".bm-badge"), (el) => el.textContent);
    // The choices, then "Other" as the next letter.
    expect(badges(screen.getByRole("group", { name: "When?" }))).toEqual(["A", "B", "C", "D"]);
    fireEvent.click(when.getByRole("checkbox", { name: "Noon" }));
    expect(badges(screen.getByRole("group", { name: "When?" }))).toEqual(["A", "✓", "C", "D"]);
  });

  test("Other is the row after the choices, outside the radiogroup, and Enter in it confirms", async () => {
    const { sent } = draw(
      { kind: "question", request_id: "r3", prompt: "Proceed?", choices: ["Yes"] },
      ok,
    );
    const other = screen.getByLabelText("Answer: Proceed?") as HTMLInputElement;
    expect(other.placeholder).toBe("Other (type your answer)");
    // A text field is not a radio: it sits beside the radiogroup, not in it.
    expect(other.closest("[role=radiogroup]")).toBeNull();
    expect(other.closest(".bm-other")?.previousElementSibling?.getAttribute("role")).toBe("radiogroup");
    fireEvent.change(other, { target: { value: "later" } });
    fireEvent.keyDown(other, { key: "Enter" });
    await waitFor(() =>
      expect(sent).toEqual([{ request_id: "r3", kind: "question", answer: "later" }]),
    );
  });

  test("a question with no choices is a bare text field", () => {
    draw({ kind: "question", request_id: "r4", prompt: "Name it?", choices: [] }, ok);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect((screen.getByLabelText("Answer: Name it?") as HTMLInputElement).placeholder).toBe(
      "Type your answer…",
    );
  });
});

describe("the head", () => {
  const paused = () => screen.queryByText("turn paused") !== null;

  test("says the turn is paused while the card can answer, and stops once it has", async () => {
    draw(batch, ok);
    expect(paused()).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Tea" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Noon" }));
    fireEvent.click(confirm());
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Response sent."));
    expect(paused()).toBe(false);
  });

  test("stops after a skip", async () => {
    draw(batch, ok);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Response sent."));
    expect(paused()).toBe(false);
  });

  test("never says it on a card that cannot answer", () => {
    draw({ ...batch, request_id: null }, ok);
    expect(paused()).toBe(false);
    cleanup();
    draw(batch);
    expect(paused()).toBe(false);
    cleanup();
    draw({ ...batch, expires_at: "2000-01-01T00:00:00Z" }, ok);
    expect(screen.getByText("Request expired.")).toBeDefined();
    expect(paused()).toBe(false);
  });
});

describe("a clarify read back from history", () => {
  const recorded = (answers: (string | null)[]) => ({
    ...batch,
    request_id: null,
    questions: batch.questions.map((q, i) => ({ ...q, answer: answers[i] ?? null })),
  });

  test("with recorded answers reads as settled, with no status line and nothing to press", () => {
    const { container } = draw(recorded(["Coffee", '["Morning","dawn"]']), ok);
    const settled = container.querySelector(".bm-settled")!;
    expect(Array.from(settled.querySelectorAll("strong"), (el) => el.textContent)).toEqual([
      "What to drink?",
      "When?",
    ]);
    expect(Array.from(settled.querySelectorAll(".bm-settled-answer"), (el) => el.textContent)).toEqual([
      "Coffee",
      "Morning, dawn",
    ]);
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.querySelectorAll("button, input")).toHaveLength(0);
    expect(screen.queryByText(/Respond in Hermes/)).toBeNull();
    expect(screen.queryByText("turn paused")).toBeNull();
  });

  test("an empty answer is a skipped question", () => {
    const { container } = draw(recorded(["", ""]));
    expect(
      Array.from(container.querySelectorAll(".bm-settled-skipped"), (el) => el.textContent),
    ).toEqual(["Skipped", "Skipped"]);
  });

  test("with no answers stays read-only: disabled rows and the note", () => {
    const { container } = draw(recorded([null, null]), ok);
    expect(container.querySelector(".bm-settled")).toBeNull();
    const rows = screen.getAllByRole("radio").concat(screen.getAllByRole("checkbox"));
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => (row as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByText("Respond in Hermes. Choices are shown here for reference.")).toBeDefined();
    expect(screen.queryByText("turn paused")).toBeNull();
  });
});

describe("review round 1", () => {
  test("Enter in Other sends nothing while the form is not ready", () => {
    const { sent } = draw(batch, ok);
    const other = screen.getByLabelText("Answer: What to drink?");
    fireEvent.change(other, { target: { value: "water" } });
    // "When?" has no answer yet, so the turn would still be waiting.
    fireEvent.keyDown(other, { key: "Enter" });
    expect(sent).toHaveLength(0);
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("an Enter that commits an IME composition does not confirm", () => {
    const { sent } = draw({ kind: "question", request_id: "r5", prompt: "Name?", choices: [] }, ok);
    const field = screen.getByLabelText("Answer: Name?");
    fireEvent.change(field, { target: { value: "かな" } });
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    expect(sent).toHaveLength(0);
  });

  test("a lock replayed with the suggestion suffix checks its row", () => {
    draw(
      {
        ...batch,
        questions: [{ ...batch.questions[0], answer: "Coffee (Recommended)" }, batch.questions[1]],
      },
      ok,
    );
    expect(
      screen.getByRole("radio", { name: "Coffee (Recommended)" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect((screen.getByLabelText("Answer: What to drink?") as HTMLInputElement).value).toBe("");
  });

  test("a later lock does not refill a question the operator emptied", () => {
    const at = (answer: string | null) => (
      <BotResponses.Provider value={ok}>
        <Block
          block={
            {
              ...batch,
              questions: [{ ...batch.questions[0], answer }, batch.questions[1]],
            } as unknown as ChatBlockView
          }
          now={NOW}
        />
      </BotResponses.Provider>
    );
    const { rerender } = render(at(null));
    const other = screen.getByLabelText("Answer: What to drink?") as HTMLInputElement;
    fireEvent.change(other, { target: { value: "water" } });
    fireEvent.change(other, { target: { value: "" } });
    rerender(at("Tea"));
    expect(screen.getByRole("radio", { name: "Tea" }).getAttribute("aria-checked")).toBe("false");
    expect(other.value).toBe("");
    // An untouched question does take a later lock.
    cleanup();
    const second = render(at(null));
    second.rerender(at("Tea"));
    expect(screen.getByRole("radio", { name: "Tea" }).getAttribute("aria-checked")).toBe("true");
  });

  test("an expired request draws its rows disabled and does not claim the turn", () => {
    draw({ ...batch, expires_at: "2026-10-12T11:59:00Z" }, ok);
    const rows = screen.getAllByRole("radio").concat(screen.getAllByRole("checkbox"));
    expect(rows.every((row) => (row as HTMLButtonElement).disabled)).toBe(true);
    expect((screen.getByLabelText("Answer: When?") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText("turn paused")).toBeNull();
    expect(confirm().disabled).toBe(true);
  });
});

/* ── the approval card (WI-8) ────────────────────────────────────────────── */

const approval = (extra: Record<string, unknown> = {}) => ({
  kind: "approval",
  tool: "terminal",
  summary: "rm -rf build/",
  detail: "dangerous deletion",
  pattern: "rm -rf *",
  request_id: "a1",
  choices: ["once", "session", "always", "deny"],
  ...extra,
});

const buttons = () => screen.queryAllByRole("button").map((b) => b.textContent);

describe("an approval", () => {
  test("offers exactly the gateway's choices, in its order", () => {
    const matrix: [unknown, string[]][] = [
      [
        ["once", "session", "always", "deny"],
        ["Approve once", "This session", "Always allow", "Deny"],
      ],
      // Smart-denied, or session approval off: one-shot only.
      [
        ["once", "deny"],
        ["Approve once", "Deny"],
      ],
      // Permanent approval off.
      [
        ["once", "session", "deny"],
        ["Approve once", "This session", "Deny"],
      ],
      // A block stored before the field existed is the narrowest set.
      [undefined, ["Approve once", "Deny"]],
      // An unknown value is dropped, never drawn.
      [
        ["once", "all", "deny"],
        ["Approve once", "Deny"],
      ],
    ];
    for (const [choices, expected] of matrix) {
      cleanup();
      draw(approval({ choices }), ok);
      expect({ choices, drawn: buttons() }).toEqual({ choices, drawn: expected });
    }
  });

  test("each answer sends its choice and settles to what happened", async () => {
    for (const [label, choice, outcome] of [
      ["Approve once", "once", "Approved once"],
      ["This session", "session", "Allowed this session"],
      ["Deny", "deny", "Denied"],
    ] as const) {
      cleanup();
      const { sent } = draw(approval(), ok);
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe(outcome));
      expect(sent).toEqual([{ request_id: "a1", kind: "approval", choice }]);
      // The command stays on the settled card.
      expect(screen.getByText("rm -rf build/")).toBeDefined();
      expect(buttons()).toEqual([]);
    }
  });

  test("Always allow asks first, naming the pattern and the command, with focus on Cancel", async () => {
    const { sent } = draw(approval(), ok);
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    const step = screen.getByRole("group", { name: "Always allow this command?" });
    expect(within(step).getByText("rm -rf *")).toBeDefined();
    expect(within(step).getByText("rm -rf build/")).toBeDefined();
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(sent).toEqual([]);
    fireEvent.click(within(step).getByRole("button", { name: "Always allow" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Always allowed"));
    expect(sent).toEqual([{ request_id: "a1", kind: "approval", choice: "always" }]);
  });

  test("Escape in the step goes back to the buttons and goes no further", async () => {
    const { sent } = draw(approval(), ok);
    // A stand-in for the shell's own Escape handler (`ChatShell.tsx`): window,
    // capture phase, ahead of the card, standing aside only for `ownsEscape`.
    const stops: KeyboardEvent[] = [];
    const shell = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !ownsEscape(e.target)) stops.push(e);
    };
    // And anything listening after the card, in the bubble phase.
    const after: KeyboardEvent[] = [];
    const bubble = (e: KeyboardEvent) => after.push(e);
    window.addEventListener("keydown", shell, true);
    window.addEventListener("keydown", bubble);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
      fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Escape" });
    } finally {
      window.removeEventListener("keydown", shell, true);
      window.removeEventListener("keydown", bubble);
    }
    expect(screen.queryByRole("group", { name: "Always allow this command?" })).toBeNull();
    expect(buttons()).toEqual(["Approve once", "This session", "Always allow", "Deny"]);
    expect(stops).toHaveLength(0);
    expect(after).toHaveLength(0);
    expect(sent).toEqual([]);
    // Focus is back on the button that opened the step, not dropped on the page.
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Always allow"));
  });

  test("Cancel returns focus to Always allow; an answer leaves it on the card's outcome", async () => {
    draw(approval(), ok);
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Always allow"));
    const deny = screen.getByRole("button", { name: "Deny" });
    deny.focus();
    fireEvent.click(deny);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Denied"));
    expect(document.activeElement?.getAttribute("role")).toBe("status");
  });

  test("a slow answer does not take focus from wherever the operator went meanwhile", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    render(
      <>
        <input aria-label="elsewhere" />
        <BotResponses.Provider
          value={async () => {
            await gate;
            return { status: "ok" };
          }}
        >
          <Block block={approval() as unknown as ChatBlockView} now={NOW} />
        </BotResponses.Provider>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    const elsewhere = screen.getByLabelText("elsewhere");
    elsewhere.focus();
    await act(async () => release());
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Denied"));
    expect(document.activeElement).toBe(elsewhere);
  });

  test("a confirmed Always allow that fails puts focus back on Always allow", async () => {
    render(
      <BotResponses.Provider
        value={async () => {
          throw new Error("tailnet unreachable");
        }}
      >
        <Block block={approval() as unknown as ChatBlockView} now={NOW} />
      </BotResponses.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    const step = screen.getByRole("group", { name: "Always allow this command?" });
    const confirmIt = within(step).getByRole("button", { name: "Always allow" });
    confirmIt.focus();
    fireEvent.click(confirmIt);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("tailnet unreachable"));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Always allow"));
    expect(screen.queryByRole("group", { name: "Always allow this command?" })).toBeNull();
  });

  test("a request that expired while the step was open is not answered", async () => {
    const sent: Decision[] = [];
    render(
      <BotResponses.Provider
        value={async (decision) => {
          sent.push(decision);
          return { status: "ok" };
        }}
      >
        <Block
          block={approval({ expires_at: new Date(Date.now() + 80).toISOString() }) as never}
          now={Date.now()}
        />
      </BotResponses.Provider>,
    );
    // Open while the request is: the step's own check reads the clock at submit.
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    const step = screen.getByRole("group", { name: "Always allow this command?" });
    fireEvent.click(within(step).getByRole("button", { name: "Always allow" }));
    expect(screen.getByText("Request expired.")).toBeDefined();
    expect(buttons()).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("timed out by the box, it says the command was not run and offers nothing", () => {
    render(
      <BotResponses.Provider value={ok}>
        <Block
          block={approval() as unknown as ChatBlockView}
          now={NOW}
          closed={{ kind: "timeout", title: "Request closed" }}
        />
      </BotResponses.Provider>,
    );
    const line = screen.getByRole("status");
    expect(line.textContent).toBe("Approval timed out — the command was not run");
    expect(line.className).toContain("bad");
    expect(screen.getByText("rm -rf build/")).toBeDefined();
    expect(buttons()).toEqual([]);
  });

  test("says how many approvals are pending when more than one is", () => {
    const at = (pending: number) => {
      cleanup();
      render(
        <BotResponses.Provider value={ok}>
          <Block block={approval() as unknown as ChatBlockView} now={NOW} pending={pending} />
        </BotResponses.Provider>,
      );
      return document.querySelector(".bm-approval-pending")?.textContent ?? null;
    };
    expect(at(3)).toBe("3 approvals pending");
    expect(at(1)).toBe(null);
  });
});

/* ── a clarify the box closed, and late answers (WI-6) ───────────────────── */

const single = {
  kind: "question",
  request_id: "q1",
  prompt: "Which branch?",
  choices: ["main (Recommended)", "dev"],
};

/** A card inside a real chat store, so a late choice has a composer draft to fill. */
function drawInChat(
  value: Record<string, unknown>,
  closed?: ClosedRequest,
): { sent: Decision[]; chat: () => Chat } {
  const sent: Decision[] = [];
  let current!: Chat;
  const api: ChatApi = {
    fetchSwarms: async () => ({ swarms: [] }) as never,
    fetchSessions: async () => ({ sessions: [] }) as never,
    fetchHistory: async () =>
      ({ instance: "atlas", bot: "default", session: "S", messages: [] }) as never,
    sendTurn: () => () => {},
    abortTurn: async () => ({ aborted: true }) as never,
  };
  function Harness({ children }: { children: ReactNode }) {
    current = useChat();
    return <>{children}</>;
  }
  render(
    <ChatProvider api={api} eager={false}>
      <BotResponses.Provider
        value={async (decision) => {
          sent.push(decision);
          return { status: "ok" };
        }}
      >
        <Harness>
          <Block block={value as unknown as ChatBlockView} now={NOW} closed={closed} />
        </Harness>
      </BotResponses.Provider>
    </ChatProvider>,
  );
  act(() => {
    current.select("atlas", "default", null);
  });
  return { sent, chat: () => current };
}

describe("a clarify the box closed", () => {
  test("timed out, it keeps the prompt under a Timed out heading, with no form", () => {
    drawInChat(single, { kind: "timeout", title: "Request closed" });
    expect(document.querySelector(".bm-settled-head")?.textContent).toBe("Timed out");
    expect(screen.getByText("Which branch?")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Confirm and continue" })).toBeNull();
    expect(screen.queryByText("turn paused")).toBeNull();
  });

  test("cancelled, it says Cancelled", () => {
    drawInChat(single, { kind: "cancelled", title: "Request closed" });
    expect(document.querySelector(".bm-settled-head")?.textContent).toBe("Cancelled");
  });

  test("a late choice drafts Desktop's sentence and does not call respond", async () => {
    const { sent, chat } = drawInChat(single, { kind: "timeout", title: "Request closed" });
    fireEvent.click(screen.getByRole("button", { name: "main (Recommended)" }));
    await waitFor(() => expect(chat().draft).toBe('Re: "Which branch?" — my answer: main'));
    expect(sent).toEqual([]);
  });

  test("a batch gets no late choices", () => {
    drawInChat(batch, { kind: "timeout", title: "Request closed" });
    expect(document.querySelector(".bm-late")).toBeNull();
  });
});

describe("late choices on a clarify read back from history", () => {
  const recorded = (answer: string) => ({
    kind: "question",
    request_id: null,
    prompt: "Which branch?",
    choices: ["main", "dev"],
    questions: [
      { id: "q0", prompt: "Which branch?", choices: ["main", "dev"], multi_select: false, answer },
    ],
  });

  test("a skipped one offers them, and a pick only drafts", async () => {
    const { sent, chat } = drawInChat(recorded(""));
    expect(screen.getByText("Skipped")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "dev" }));
    await waitFor(() => expect(chat().draft).toBe('Re: "Which branch?" — my answer: dev'));
    expect(sent).toEqual([]);
  });

  test("an answered one does not", () => {
    drawInChat(recorded("main"));
    expect(document.querySelector(".bm-late")).toBeNull();
  });
});

describe("a vault.code request", () => {
  const vault = {
    kind: "question",
    request_id: "srq-b19072d55aac",
    prompt: "Enter the verification code for github.com",
    choices: [],
    vault_code: { site: "github.com", hint: "Open your authenticator app" },
  };
  const code = () => screen.getByLabelText("Verification code for github.com") as HTMLInputElement;
  const submit = () => screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;

  test("is a code card with a masked numeric field and the hint, not the raw-JSON notice", () => {
    const { container } = draw(vault, ok);
    expect(screen.getByText("Enter verification code")).toBeDefined();
    expect(screen.getByText("Open your authenticator app")).toBeDefined();
    expect(code().type).toBe("password");
    expect(code().inputMode).toBe("numeric");
    expect(code().autocomplete).toBe("one-time-code");
    expect(container.textContent).not.toContain("Hermes needs your attention");
    expect(container.textContent).not.toContain("Type your answer");
    expect(submit().disabled).toBe(true);
  });

  test("Submit sends the trimmed code to its request, then clears it", async () => {
    const { sent, container } = draw(vault, ok);
    fireEvent.change(code(), { target: { value: " 246810 " } });
    expect(submit().disabled).toBe(false);
    await act(async () => fireEvent.click(submit()));
    expect(sent).toEqual([{ request_id: "srq-b19072d55aac", kind: "question", answer: "246810" }]);
    await waitFor(() => expect(screen.getByText("Code sent.")).toBeDefined());
    expect(container.querySelector("input")).toBeNull();
    expect(container.innerHTML).not.toContain("246810");
  });

  test("Skip answers empty and clears the card", async () => {
    const { sent, container } = draw(vault, ok);
    fireEvent.change(code(), { target: { value: "1234" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Skip" })));
    expect(sent).toEqual([{ request_id: "srq-b19072d55aac", kind: "question", skip: true }]);
    await waitFor(() => expect(screen.getByText("Skipped. No code sent.")).toBeDefined());
    expect(container.querySelector("input")).toBeNull();
    expect(container.innerHTML).not.toContain("1234");
  });
});
