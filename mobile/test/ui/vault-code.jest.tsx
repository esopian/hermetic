import { act, fireEvent, screen } from "@testing-library/react-native";
import { Block } from "../../src/chat/blocks/Block.tsx";
import { question } from "../helpers/fixtures.ts";
import { NOW, renderUi, scope } from "../helpers/render.tsx";

const ok = jest.fn(async () => ({ status: "ok" as const }));
beforeEach(() => ok.mockClear());

const vault = question({
  request_id: "srq-b19072d55aac",
  prompt: "Enter the verification code for github.com",
  choices: [],
  vault_code: { site: "github.com", hint: "Open your authenticator app" },
});
const field = () => screen.getByLabelText("Verification code for github.com");

describe("vault code card", () => {
  test("a masked numeric code field with the hint, not the question's answer box", async () => {
    await renderUi(<Block block={vault} now={NOW} session="s-1" />, scope({ respond: ok }));
    expect(screen.getByText("Enter verification code")).toBeTruthy();
    expect(screen.getByText("Open your authenticator app")).toBeTruthy();
    expect(field().props.secureTextEntry).toBe(true);
    expect(field().props.keyboardType).toBe("number-pad");
    expect(field().props.textContentType).toBe("oneTimeCode");
    expect(screen.queryByText("Hermes needs your attention")).toBeNull();
    expect(screen.queryByPlaceholderText("Type your answer…")).toBeNull();
  });

  test("Submit sends the trimmed code to its request in the message's session, then clears it", async () => {
    await renderUi(<Block block={vault} now={NOW} session="s-9" />, scope({ respond: ok }));
    await fireEvent.changeText(field(), " 246810 ");
    await act(async () => fireEvent.press(screen.getByLabelText("Submit")));
    expect(ok).toHaveBeenCalledWith(
      { request_id: "srq-b19072d55aac", kind: "question", answer: "246810" },
      "s-9",
    );
    expect(await screen.findByText("Code sent.")).toBeTruthy();
    expect(screen.queryByLabelText("Verification code for github.com")).toBeNull();
    expect(JSON.stringify(screen.toJSON())).not.toContain("246810");
  });

  test("Skip answers empty and clears the card", async () => {
    await renderUi(<Block block={vault} now={NOW} session="s-1" />, scope({ respond: ok }));
    await fireEvent.changeText(field(), "1234");
    await act(async () => fireEvent.press(screen.getByLabelText("Skip")));
    expect(ok).toHaveBeenCalledWith(
      { request_id: "srq-b19072d55aac", kind: "question", skip: true },
      "s-1",
    );
    expect(await screen.findByText("Skipped. No code sent.")).toBeTruthy();
    expect(screen.queryByLabelText("Verification code for github.com")).toBeNull();
    expect(JSON.stringify(screen.toJSON())).not.toContain("1234");
  });
});
