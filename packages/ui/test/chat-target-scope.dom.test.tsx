import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import { cleanup, render, screen, userEvent, waitFor, within } from "./dom.ts";
import { ChatProvider, ChatTargetScope } from "../src/chat/chat-state.tsx";
import { ChatView } from "../src/chat/components/ChatView.tsx";
import { harness, sendable, swarmOf } from "./chat-fixtures.tsx";

afterEach(cleanup);

const atlas = { instance: "atlas", bot: "atlas", session: null };
const granite = { instance: "granite", bot: "granite", session: null };

function TwoPanes() {
  const [second, setSecond] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setSecond((value) => !value)}>
        Toggle second pane
      </button>
      <section aria-label="Atlas pane">
        <ChatTargetScope target={atlas}>
          <ChatView withContext={false} withRail={false} />
        </ChatTargetScope>
      </section>
      {second ? (
        <section aria-label="Granite pane">
          <ChatTargetScope target={granite}>
            <ChatView withContext={false} withRail={false} />
          </ChatTargetScope>
        </section>
      ) : null}
    </>
  );
}

describe("target-scoped chat panes", () => {
  test("two visible composers keep their own drafts, turns, and stop controls", async () => {
    const h = harness({ swarms: [swarmOf("atlas"), swarmOf("granite")] });
    render(
      <ChatProvider api={h.api}>
        <TwoPanes />
      </ChatProvider>,
    );
    const atlasPane = screen.getByRole("region", { name: "Atlas pane" });
    const granitePane = screen.getByRole("region", { name: "Granite pane" });
    const atlasInput = await sendable(atlasPane);
    const graniteInput = await sendable(granitePane);

    await userEvent.type(atlasInput, "atlas draft");
    await userEvent.type(graniteInput, "granite turn{Enter}");
    expect(atlasInput.value).toBe("atlas draft");
    expect(h.turns[0]?.instance).toBe("granite");
    expect(h.turns[0]?.bot).toBe("granite");

    await userEvent.type(atlasInput, "{Enter}");
    expect(h.turns[1]?.instance).toBe("atlas");
    expect(h.turns[1]?.message).toBe("atlas draft");
    await userEvent.click(within(atlasPane).getByRole("button", { name: "Stop turn" }));
    await waitFor(() => expect(h.turns[1]?.cancelled).toBe(true));
    expect(h.turns[0]?.cancelled).toBe(false);
  });

  test("closing and reopening a pane keeps its unsent queue in the provider", async () => {
    const h = harness({ swarms: [swarmOf("atlas"), swarmOf("granite")] });
    render(
      <ChatProvider api={h.api}>
        <TwoPanes />
      </ChatProvider>,
    );
    let granitePane = screen.getByRole("region", { name: "Granite pane" });
    let input = await sendable(granitePane);
    await userEvent.type(input, "first{Enter}");
    await userEvent.type(input, "queued{Enter}");
    expect(within(granitePane).getByText("queued")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Toggle second pane" }));
    expect(screen.queryByRole("region", { name: "Granite pane" })).toBeNull();
    expect(h.turns[0]?.cancelled).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Toggle second pane" }));
    granitePane = screen.getByRole("region", { name: "Granite pane" });
    input = await sendable(granitePane);
    expect(input.value).toBe("");
    expect(within(granitePane).getByText("queued")).toBeDefined();
    expect(h.calls.send).toBe(1);
  });
});
