import { openSeparateSession } from "../../src/client/new-session.ts";

function client() {
  const sent: [string, string][] = [];
  const opened: string[] = [];
  return {
    sent,
    opened,
    gateway: {
      open: jest.fn(async (input: { instance: string; bot: string }) => ({
        ...input,
        session: "new-1",
      })),
    },
    chat: {
      open: (t: { session: string | null }) => {
        opened.push(String(t.session));
      },
      sendMessage: (t: { session: string | null }, text: string) => {
        sent.push([String(t.session), text]);
        return true;
      },
    },
  };
}

const T = { instance: "atlas", bot: "scribe" };

describe("openSeparateSession", () => {
  test("on screen: the prompt goes into the new session, which is watched and answered", async () => {
    const c = client();
    expect(await openSeparateSession(c, T, "try again", () => true)).toEqual({
      instance: "atlas",
      bot: "scribe",
      session: "new-1",
    });
    expect(c.sent).toEqual([["new-1", "try again"]]);
    expect(c.opened).toEqual(["new-1"]);
  });

  test("the operator left meanwhile: the prompt is still sent, nothing is watched or answered", async () => {
    const c = client();
    expect(await openSeparateSession(c, T, "try again", () => false)).toBeNull();
    expect(c.sent).toEqual([["new-1", "try again"]]);
    expect(c.opened).toEqual([]);
  });

  test("no prompt: nothing is sent", async () => {
    const c = client();
    await openSeparateSession(c, T, undefined, () => true);
    expect(c.sent).toEqual([]);
  });
});
