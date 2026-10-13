import { encodeMobileLink } from "@hermetic/core/shared";
import { fireEvent, screen } from "@testing-library/react-native";
import { type PairedLink, pairingRedirect, readPairingLink } from "../../src/fleet/pairing.ts";
import { PairConfirm } from "../../src/pair/PairConfirm.tsx";
import { PairForm } from "../../src/pair/PairForm.tsx";
import { renderUi } from "../helpers/render.tsx";

const LINK = encodeMobileLink({
  fleet_id: "fxtr0001",
  alias: "main",
  account_id: "123456789012",
  region: "us-west-2",
  tailnet: "hermetic.ts.net",
  agents: [{ name: "atlas" }, { name: "corvid", host: "fxtr0001-corvid-2.hermetic.ts.net" }],
});

function paired(link = LINK): PairedLink {
  const read = readPairingLink(link);
  if (!read.ok) throw new Error(read.error.title);
  return read.link;
}

describe("PairForm", () => {
  test("a pasted link is proposed as soon as it lands", async () => {
    const onSubmit = jest.fn();
    await renderUi(<PairForm busy={false} error={null} onSubmit={onSubmit} />);
    await fireEvent.changeText(screen.getByLabelText("Pairing link"), LINK);
    expect(onSubmit).toHaveBeenCalledWith(LINK);
  });

  test("anything typed is read on Read link (the screen decides what it is)", async () => {
    const onSubmit = jest.fn();
    await renderUi(<PairForm busy={false} error={null} onSubmit={onSubmit} />);
    expect(screen.getByLabelText("Read link").props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText("Pairing link"), "https://example.com");
    expect(onSubmit).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText("Read link"));
    expect(onSubmit).toHaveBeenCalledWith("https://example.com");
  });

  test("a refusal is shown", async () => {
    const read = readPairingLink("https://example.com");
    if (read.ok) throw new Error("accepted a non-link");
    await renderUi(<PairForm busy={false} error={read.error} onSubmit={jest.fn()} />);
    expect(screen.getByText("That is not a Hermetic pairing link.")).toBeTruthy();
  });
});

describe("PairConfirm", () => {
  test("names the fleet, the tailnet and the agent count, says there is no secret, and pairs only on a tap", async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    await renderUi(
      <PairConfirm
        link={paired()}
        replacing={false}
        busy={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText("main · fxtr0001")).toBeTruthy();
    expect(screen.getByText("hermetic.ts.net")).toBeTruthy();
    expect(screen.getByText("2 agents")).toBeTruthy();
    expect(screen.getByText(/no secret in this code/)).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText("Pair"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByLabelText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("replacing says it will ask again", async () => {
    await renderUi(
      <PairConfirm link={paired()} replacing busy={false} onConfirm={jest.fn()} onCancel={jest.fn()} />,
    );
    expect(screen.getByText(/replaces the current pairing/)).toBeTruthy();
    expect(screen.getByLabelText("Replace…")).toBeTruthy();
  });

  test("a hostile alias is shown cleaned", async () => {
    const link = `${LINK.replace("alias=main", `alias=${encodeURIComponent("ev‮il")}`)}`;
    const read = readPairingLink(link);
    // Core's parser may refuse the alias outright; either way nothing raw reaches the screen.
    if (!read.ok) return;
    await renderUi(
      <PairConfirm
        link={read.link}
        replacing={false}
        busy={false}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />,
    );
    expect(screen.queryByText(/‮/)).toBeNull();
  });
});

describe("pairingRedirect", () => {
  test("a hermetic://fleet link opens Pair with the whole link", () => {
    const to = pairingRedirect(LINK);
    expect(to.startsWith("/pair?link=")).toBe(true);
    expect(decodeURIComponent(to.slice("/pair?link=".length))).toBe(LINK);
  });

  test("a path-only /fleet?… arrives the same way", () => {
    const query = LINK.slice(LINK.indexOf("?"));
    expect(decodeURIComponent(pairingRedirect(`/fleet${query}`).slice("/pair?link=".length))).toBe(
      LINK,
    );
  });

  test("anything else is left alone", () => {
    expect(pairingRedirect("/chat/atlas/scribe")).toBe("/chat/atlas/scribe");
    expect(pairingRedirect("hermetic://fleet")).toBe("/pair");
    expect(pairingRedirect("/fleetwood")).toBe("/fleetwood");
  });
});
