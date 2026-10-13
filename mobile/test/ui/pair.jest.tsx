import { fireEvent, screen } from "@testing-library/react-native";
import { BridgeError } from "../../src/client/errors.ts";
import { pairErrorCopy, validHost, validPort } from "../../src/client/pairing.ts";
import { PairConfirm } from "../../src/pair/PairConfirm.tsx";
import { PairForm } from "../../src/pair/PairForm.tsx";
import { renderUi } from "../helpers/render.tsx";

describe("PairForm", () => {
  test("manual entry: Pair stays off until host, port and an 8-character code are valid", async () => {
    const onSubmit = jest.fn();
    await renderUi(<PairForm busy={false} error={null} onSubmit={onSubmit} />);
    const pair = () => screen.getByLabelText("Pair");
    expect(pair().props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText("Host"), "100.64.0.7");
    await fireEvent.changeText(screen.getByLabelText("Pairing code"), "abcd-12");
    expect(screen.getByText("6 of 8 characters")).toBeTruthy();
    expect(pair().props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText("Pairing code"), "abcd-1234");
    expect(pair().props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(pair());
    expect(onSubmit).toHaveBeenCalledWith({ host: "100.64.0.7", port: 7877, code: "ABCD1234" });
  });

  test("a non-numeric port is stripped; an out-of-range one blocks", async () => {
    await renderUi(<PairForm busy={false} error={null} onSubmit={jest.fn()} />);
    await fireEvent.changeText(screen.getByLabelText("Port"), "70a");
    expect(screen.getByLabelText("Port").props.value).toBe("70");
    await fireEvent.changeText(screen.getByLabelText("Host"), "laptop");
    await fireEvent.changeText(screen.getByLabelText("Port"), "99999");
    await fireEvent.changeText(screen.getByLabelText("Pairing code"), "ABCD1234");
    expect(screen.getByLabelText("Pair").props.accessibilityState.disabled).toBe(true);
  });

  test("a pasted link fills the fields and proposes the link's target, fleet included", async () => {
    const onSubmit = jest.fn();
    await renderUi(<PairForm busy={false} error={null} onSubmit={onSubmit} />);
    await fireEvent.changeText(
      screen.getByLabelText("Pairing link"),
      "hermetic://pair?host=100.64.0.9&port=7900&code=wxyz-5678&fleet=fxtr0001&name=main",
    );
    expect(onSubmit).toHaveBeenCalledWith({
      host: "100.64.0.9",
      port: 7900,
      code: "WXYZ5678",
      fleet: "fxtr0001",
      name: "main",
    });
    expect(screen.getByLabelText("Host").props.value).toBe("100.64.0.9");
  });

  test("a link that is not a pairing link says so", async () => {
    const onSubmit = jest.fn();
    await renderUi(<PairForm busy={false} error={null} onSubmit={onSubmit} />);
    await fireEvent.changeText(screen.getByLabelText("Pairing link"), "https://example.com");
    await fireEvent(screen.getByLabelText("Pairing link"), "submitEditing");
    expect(screen.getByText("That is not a hermetic://pair link.")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("the bridge's refusal is shown", async () => {
    await renderUi(
      <PairForm
        busy={false}
        error={pairErrorCopy(new BridgeError("PAIR_CODE_INVALID", "bad", 409))}
        onSubmit={jest.fn()}
      />,
    );
    expect(screen.getByText("That code did not work.")).toBeTruthy();
  });
});

describe("PairConfirm", () => {
  test("names the bridge, the fleet and the device name, and pairs only on a tap", async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    await renderUi(
      <PairConfirm
        target={{ host: "100.64.0.9", port: 7900, code: "WXYZ5678", fleet: "fxtr0001", name: "main" }}
        deviceName="FIXTURE phone"
        replacing={false}
        busy={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText("100.64.0.9:7900")).toBeTruthy();
    expect(screen.getByText("main · fxtr0001")).toBeTruthy();
    expect(screen.getByText("FIXTURE phone")).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText("Pair"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByLabelText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("replacing a pairing says so; an IPv6 host is bracketed; no fleet in a typed code", async () => {
    await renderUi(
      <PairConfirm
        target={{ host: "fd7a:115c:a1e0::9", port: 7877, code: "WXYZ5678" }}
        deviceName="iPhone"
        replacing
        busy={false}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />,
    );
    expect(screen.getByText("[fd7a:115c:a1e0::9]:7877")).toBeTruthy();
    expect(screen.getByText(/not named by the code/)).toBeTruthy();
    expect(screen.getByText(/replaces the current pairing/)).toBeTruthy();
    expect(screen.getByLabelText("Replace…")).toBeTruthy();
  });

  test("an already-bracketed IPv6 host is not bracketed twice; a spoofing name is cleaned", async () => {
    await renderUi(
      <PairConfirm
        target={{
          host: "[fd7a:115c:a1e0::9]",
          port: 7877,
          code: "WXYZ5678",
          fleet: "fxtr0001",
          name: `\u202Eniam${"x".repeat(100)}`,
        }}
        deviceName="iPhone"
        replacing={false}
        busy={false}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />,
    );
    expect(screen.getByText("[fd7a:115c:a1e0::9]:7877")).toBeTruthy();
    expect(screen.queryByText(/\[\[/)).toBeNull();
    expect(screen.getByText(`niam${"x".repeat(60)} · fxtr0001`)).toBeTruthy();
    expect(screen.queryByText(/\u202E/)).toBeNull();
  });

  test("a malformed fleet id from a link is not shown as a fleet", async () => {
    await renderUi(
      <PairConfirm
        target={{ host: "100.64.0.9", port: 7877, code: "WXYZ5678", fleet: "evil fleet", name: null }}
        deviceName="iPhone"
        replacing={false}
        busy={false}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />,
    );
    expect(screen.queryByText(/evil fleet/)).toBeNull();
    expect(screen.getByText(/not named by the code/)).toBeTruthy();
  });

  test("an off-tailnet host is flagged under the form", async () => {
    await renderUi(<PairForm busy={false} error={null} onSubmit={jest.fn()} />);
    await fireEvent.changeText(screen.getByLabelText("Host"), "192.168.1.10");
    expect(screen.getByText(/Not a tailnet address/)).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Host"), "100.64.0.9");
    expect(screen.queryByText(/Not a tailnet address/)).toBeNull();
  });
});

describe("pairErrorCopy", () => {
  test("one sentence per failure", () => {
    expect(pairErrorCopy(new BridgeError("PAIR_CODE_INVALID", "x", 409)).title).toBe(
      "That code did not work.",
    );
    expect(pairErrorCopy(new BridgeError("NETWORK", "x"), "1.2.3.4:7877").title).toBe(
      "No bridge answered at 1.2.3.4:7877.",
    );
    expect(pairErrorCopy(new BridgeError("TIMEOUT", "x")).title).toBe("No bridge answered.");
    expect(pairErrorCopy(new BridgeError("PROTOCOL_MISMATCH", "x", 426)).title).toMatch(/same version/);
    expect(pairErrorCopy(new BridgeError("RATE_LIMITED", "x", 429)).title).toBe("Too many tries.");
    expect(pairErrorCopy(new Error("boom"))).toEqual({ title: "Pairing failed.", detail: "boom" });
  });

  test("host and port validation", () => {
    expect(validHost("100.64.0.1")).toBe(true);
    expect(validHost("laptop.tail1234.ts.net")).toBe(true);
    expect(validHost("http://x")).toBe(false);
    expect(validHost("a b")).toBe(false);
    expect(validPort("7877")).toBe(true);
    expect(validPort("0")).toBe(false);
    expect(validPort("65536")).toBe(false);
  });
});
