import { act, fireEvent, screen } from "@testing-library/react-native";
import { ApprovalCard } from "../../src/chat/blocks/Approval.tsx";
import { QuestionCard } from "../../src/chat/blocks/Question.tsx";
import {
  answerOf,
  clarifyPayload,
  closedRequests,
  keepsCard,
  offeredChoices,
  openRequests,
  questionsOf,
} from "../../src/client/chat-requests.ts";
import type { QuestionBlock } from "@hermetic/core/chat-client";
import { approval, question } from "../helpers/fixtures.ts";
import { NOW, renderUi, scope } from "../helpers/render.tsx";

const ok = jest.fn(async () => ({ status: "ok" as const }));

beforeEach(() => ok.mockClear());

describe("approval card", () => {
  test("buttons are exactly block.choices, in order, with the desktop's labels", async () => {
    await renderUi(<ApprovalCard block={approval()} now={NOW} session="s-1" />, scope({ respond: ok }));
    const labels = screen.getAllByRole("button").map((b) => b.props.accessibilityLabel);
    expect(labels).toEqual(["Approve once", "This session", "Always allow", "Deny"]);
  });

  test("a choice the gateway did not offer is never drawn", async () => {
    await renderUi(
      <ApprovalCard block={approval({ choices: ["once", "deny"] })} now={NOW} session="s-1" />,
      scope({ respond: ok }),
    );
    expect(screen.queryByLabelText("This session")).toBeNull();
    expect(screen.queryByLabelText("Always allow")).toBeNull();
    expect(offeredChoices({ choices: [] })).toEqual(["once", "deny"]);
  });

  test("Approve once → chat.respond {choice:'once'} in the message's session, then the outcome", async () => {
    await renderUi(<ApprovalCard block={approval()} now={NOW} session="s-9" />, scope({ respond: ok }));
    await fireEvent.press(screen.getByLabelText("Approve once"));
    expect(ok).toHaveBeenCalledWith({ request_id: "r1", kind: "approval", choice: "once" }, "s-9");
    expect(await screen.findByText("Approved once")).toBeTruthy();
  });

  test("Deny sends deny", async () => {
    await renderUi(<ApprovalCard block={approval()} now={NOW} session="s-1" />, scope({ respond: ok }));
    await fireEvent.press(screen.getByLabelText("Deny"));
    expect(ok).toHaveBeenCalledWith({ request_id: "r1", kind: "approval", choice: "deny" }, "s-1");
    expect(await screen.findByText("Denied")).toBeTruthy();
  });

  test("Always allow takes an inline confirm naming the pattern; Cancel sends nothing", async () => {
    await renderUi(
      <ApprovalCard block={approval({ pattern: "rm -rf *" })} now={NOW} session="s-1" />,
      scope({ respond: ok }),
    );
    await fireEvent.press(screen.getByLabelText("Always allow"));
    expect(screen.getByText("Always allow this command?")).toBeTruthy();
    expect(screen.getByText("rm -rf *")).toBeTruthy();
    expect(ok).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText("Cancel"));
    expect(screen.queryByText("Always allow this command?")).toBeNull();
    expect(ok).not.toHaveBeenCalled();
  });

  test("confirmed Always allow sends always", async () => {
    await renderUi(<ApprovalCard block={approval()} now={NOW} session="s-1" />, scope({ respond: ok }));
    await fireEvent.press(screen.getByLabelText("Always allow"));
    await fireEvent.press(screen.getByLabelText("Always allow"));
    expect(ok).toHaveBeenCalledWith({ request_id: "r1", kind: "approval", choice: "always" }, "s-1");
    expect(await screen.findByText("Always allowed")).toBeTruthy();
  });

  test("an expired box answer reads 'Already answered or expired.'", async () => {
    const expired = jest.fn(async () => ({ status: "expired" as const }));
    await renderUi(
      <ApprovalCard block={approval()} now={NOW} session="s-1" />,
      scope({ respond: expired }),
    );
    await fireEvent.press(screen.getByLabelText("Approve once"));
    expect(await screen.findByText("Already answered or expired.")).toBeTruthy();
  });

  test("a refusal shows the error and keeps the buttons", async () => {
    const refuse = jest.fn(async () => {
      throw new Error("FORBIDDEN: nope");
    });
    await renderUi(
      <ApprovalCard block={approval()} now={NOW} session="s-1" />,
      scope({ respond: refuse }),
    );
    await fireEvent.press(screen.getByLabelText("Approve once"));
    expect(await screen.findByText("FORBIDDEN: nope")).toBeTruthy();
    expect(screen.getByLabelText("Deny")).toBeTruthy();
  });

  test("the head says when it expires", async () => {
    const at = new Date(NOW + 10 * 60_000).toISOString();
    await renderUi(
      <ApprovalCard block={approval({ expires_at: at })} now={NOW} session="s" />,
      scope({ respond: ok }),
    );
    expect(screen.getByText(/^expires /)).toBeTruthy();
  });

  test("past expiry it reads 'Request expired.' and offers nothing", async () => {
    await renderUi(
      <ApprovalCard
        block={approval({ expires_at: new Date(NOW - 1000).toISOString() })}
        now={NOW}
        session="s"
      />,
      scope({ respond: ok }),
    );
    expect(screen.getByText("Request expired.")).toBeTruthy();
    expect(screen.queryByLabelText("Approve once")).toBeNull();
  });

  test("closed by a timeout, it says the command was not run", async () => {
    await renderUi(
      <ApprovalCard
        block={approval()}
        now={NOW}
        session="s"
        closed={{ kind: "timeout", title: "t" }}
      />,
      scope({ respond: ok }),
    );
    expect(screen.getByText("Approval timed out — the command was not run")).toBeTruthy();
  });

  test("without a responder it says where to answer", async () => {
    await renderUi(<ApprovalCard block={approval()} now={NOW} session="s" />, null);
    expect(screen.getByText(/Respond in Hermes/)).toBeTruthy();
  });

  test("more than one open approval says so", async () => {
    await renderUi(
      <ApprovalCard block={approval()} now={NOW} session="s" pending={2} />,
      scope({ respond: ok }),
    );
    expect(screen.getByText("2 approvals pending")).toBeTruthy();
  });
});

const batch = (): QuestionBlock =>
  question({
    prompt: "",
    choices: [],
    questions: [
      {
        id: "q-a",
        prompt: "Branch?",
        choices: ["main (Recommended)", "dev"],
        multi_select: false,
        answer: null,
      },
      { id: "q-b", prompt: "Targets?", choices: ["ios", "android"], multi_select: true, answer: null },
      { id: "q-c", prompt: "Note?", choices: [], multi_select: false, answer: null },
    ],
  });

describe("clarify card", () => {
  test("a batch is one form: N of M answered, confirm only when all are, answers keyed by id", async () => {
    await renderUi(<QuestionCard block={batch()} now={NOW} session="s-1" />, scope({ respond: ok }));
    expect(screen.getByText("0 of 3 answered")).toBeTruthy();
    expect(screen.getByText("turn paused")).toBeTruthy();
    const confirm = screen.getByLabelText("Confirm and continue");
    expect(confirm.props.accessibilityState.disabled).toBe(true);

    await fireEvent.press(screen.getByLabelText("main"));
    await fireEvent.press(screen.getByLabelText("ios"));
    await fireEvent.press(screen.getByLabelText("android"));
    expect(screen.getByText("2 of 3 answered")).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Answer: Note?"), "ship it");
    expect(screen.getByText("3 of 3 answered")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Confirm and continue"));
    expect(ok).toHaveBeenCalledWith(
      {
        request_id: "q1",
        kind: "question",
        answers: { "q-a": "main", "q-b": JSON.stringify(["ios", "android"]), "q-c": "ship it" },
      },
      "s-1",
    );
    expect(await screen.findByText("Response sent.")).toBeTruthy();
    expect(screen.getByText("ios, android")).toBeTruthy();
    expect(screen.queryByText("turn paused")).toBeNull();
  });

  test("'Other' replaces a single-select pick", async () => {
    await renderUi(<QuestionCard block={question()} now={NOW} session="s-1" />, scope({ respond: ok }));
    await fireEvent.press(screen.getByLabelText("dev"));
    await fireEvent.changeText(screen.getByLabelText("Answer: Which branch?"), "feature/x");
    await fireEvent.press(screen.getByLabelText("Confirm and continue"));
    expect(ok).toHaveBeenCalledWith({ request_id: "q1", kind: "question", answer: "feature/x" }, "s-1");
  });

  test("Skip sends skip and settles as Skipped", async () => {
    await renderUi(<QuestionCard block={question()} now={NOW} session="s-1" />, scope({ respond: ok }));
    await fireEvent.press(screen.getByLabelText("Skip"));
    expect(ok).toHaveBeenCalledWith({ request_id: "q1", kind: "question", skip: true }, "s-1");
    expect(await screen.findByText("Skipped")).toBeTruthy();
  });

  test("a box timeout names itself over the prompts and offers late choices into the draft", async () => {
    const draft = jest.fn();
    await renderUi(
      <QuestionCard
        block={question()}
        now={NOW}
        session="s"
        closed={{ kind: "timeout", title: "t" }}
      />,
      scope({ respond: ok, draft }),
    );
    expect(screen.getByText("Timed out")).toBeTruthy();
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("main"));
    });
    expect(draft).toHaveBeenCalledWith('Re: "Which branch?" — my answer: main');
    expect(ok).not.toHaveBeenCalled();
  });

  test("without a responder the choices are reference only", async () => {
    await renderUi(<QuestionCard block={question()} now={NOW} session="s" />, null);
    expect(screen.getByText(/Respond in Hermes/)).toBeTruthy();
  });
});

describe("request rules", () => {
  test("a done notice closes a request; an answered approval card goes, a timed-out one stays", () => {
    const closed = closedRequests([
      {
        kind: "activity",
        category: "notice",
        key: "n",
        title: "x",
        state: "done",
        request_id: "r1",
        reason: "timeout",
      },
      {
        kind: "activity",
        category: "notice",
        key: "m",
        title: "x",
        state: "done",
        request_id: "r2",
        reason: "resolved",
      },
    ]);
    expect(closed.get("r1")?.kind).toBe("timeout");
    expect(keepsCard(approval(), closed.get("r1"))).toBe(true);
    expect(keepsCard(approval({ request_id: "r2" }), closed.get("r2"))).toBe(false);
  });

  test("open: not closed, not released, not expired", () => {
    const blocks = [
      approval({ request_id: "a" }),
      approval({ request_id: "b" }),
      approval({ request_id: "c", expires_at: new Date(NOW - 1).toISOString() }),
    ];
    const open = openRequests(blocks, new Map(), ["b"], NOW);
    expect(open.map((b) => b.request_id)).toEqual(["a"]);
  });

  test("a multi-select answer is a JSON list; the suffix is stripped", () => {
    const [q] = questionsOf(batch().questions ? batch() : question());
    if (!q) throw new Error("no question");
    expect(answerOf(q, { picked: ["main (Recommended)"], text: "" })).toBe("main");
    expect(clarifyPayload("r", questionsOf(question()), [{ picked: [], text: "" }])).toBeNull();
  });
});
