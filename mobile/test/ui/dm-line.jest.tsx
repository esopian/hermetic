/**
 * A bot-to-bot DM (`message_agent`) as one line between the prose
 * (`blocks/DmLine.tsx`, `client/message-agent.ts`), never a folded tool step;
 * a call this build cannot read stays an ordinary tool row.
 */
import { screen } from "@testing-library/react-native";
import { Block } from "../../src/chat/blocks/Block.tsx";
import { sections } from "../../src/client/chat-activity.ts";
import { messageAgentLine } from "../../src/client/message-agent.ts";
import { tool } from "../helpers/fixtures.ts";
import { NOW, renderUi, scope } from "../helpers/render.tsx";

const call = (status: "running" | "ok" | "bad", result: unknown) =>
  tool({
    tool_id: "tl-dm",
    name: "message_agent",
    args: { target: "@scribe", message: "Log the granite fix tonight." },
    status,
    result,
    render: "message_agent",
  });

describe("messageAgentLine", () => {
  test("reads the call's state off upstream's acknowledgement", () => {
    expect(messageAgentLine(call("running", null))?.state).toBe("pending");
    expect(messageAgentLine(call("ok", { status: "queued", to: "@scribe" }))).toMatchObject({
      state: "sent",
      bot: "scribe",
      message: "Log the granite fix tonight.",
    });
    expect(
      messageAgentLine(call("ok", JSON.stringify({ status: "ambiguous", error: "unsure" })))?.state,
    ).toBe("ambiguous");
    expect(
      messageAgentLine(call("bad", { error: "machine offline", reason: "runtime_offline" })),
    ).toMatchObject({ state: "failed", error: "machine offline" });
  });

  test("a shape it does not know is no line", () => {
    expect(messageAgentLine(call("ok", "plain text"))).toBeNull();
    expect(messageAgentLine(call("ok", { status: "weird" }))).toBeNull();
    expect(messageAgentLine(tool({ render: "message_agent", args: {} }))).toBeNull();
    expect(messageAgentLine(tool({ name: "terminal" }))).toBeNull();
  });
});

describe("DM line", () => {
  test("a sent DM is '→ bot:' and the message, out of the Tools fold", async () => {
    const sent = call("ok", { status: "queued", to: "@scribe" });
    expect(sections([tool({ status: "ok" }), sent]).map((s) => s.activity)).toEqual([true, false]);
    await renderUi(<Block block={sent} now={NOW} />, scope());
    expect(screen.getByLabelText("Messaged scribe: Log the granite fix tonight.")).toBeTruthy();
    expect(screen.getByText("scribe:")).toBeTruthy();
    expect(screen.getByText("Log the granite fix tonight.")).toBeTruthy();
  });

  test("a refused DM carries upstream's sentence", async () => {
    await renderUi(
      <Block block={call("bad", { error: "machine offline", reason: "runtime_offline" })} now={NOW} />,
      scope(),
    );
    expect(screen.getByText("✕ Couldn't message")).toBeTruthy();
    expect(screen.getByText("machine offline")).toBeTruthy();
  });

  test("an unreadable call is the ordinary tool row", async () => {
    await renderUi(<Block block={call("ok", "plain text")} now={NOW} />, scope());
    expect(screen.queryByTestId("dm-line")).toBeNull();
    expect(screen.getByText("message_agent")).toBeTruthy();
  });
});
