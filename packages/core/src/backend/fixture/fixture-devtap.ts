/**
 * The developer tools against the fixture backend (§9.2 "Developer tools").
 *
 * The fixture chat client makes `ChatFrame`s directly — there is no socket, so
 * the adapter's wire tap never fires — and an inspector opened in
 * `bun run dev:fixture` would show frames with no wire beneath them. This
 * wrapper stands in for the missing layer: each frame the fixture turn yields
 * is preceded by a `wire` record shaped like the Hermes event that would have
 * produced it, marked `synthetic: true` so nobody mistakes it for a capture,
 * and the frame carries that record as its `parent`.
 *
 * Nothing here changes what the client yields, and with the tools off the
 * wrapper hands every frame straight through.
 */
import type { HermesChatClient } from "../../chat/hermes/hermes-chat.ts";
import { tagRecord, type TapSource } from "../../chat/devtap.ts";
import type { ChatFrame } from "../../schema/index.ts";

/** The Hermes event a fixture frame stands in for. */
function wireType(frame: ChatFrame): string {
  switch (frame.type) {
    case "delta":
      return "message.delta";
    case "done":
      return "message.complete";
    case "error":
      return "turn.error";
    case "block":
      switch (frame.block.kind) {
        case "text":
          return "message.start";
        case "reasoning":
          return "reasoning.delta";
        case "tool":
          return frame.block.status === "running" ? "tool.start" : "tool.complete";
        case "unknown":
          return frame.block.name;
        default:
          return `fixture.${frame.block.kind}`;
      }
  }
}

export function withFixtureDevtap(client: HermesChatClient, devtap: TapSource): HermesChatClient {
  return {
    ...client,
    send(box, bot, text, opts = {}) {
      const frames = client.send(box, bot, text, opts);
      return (async function* () {
        const conversation = { instance: box.instance, bot, session: opts.session ?? null };
        let seq = 0;
        for await (const frame of frames) {
          seq += 1;
          const mark = devtap()?.add(conversation, {
            layer: "wire",
            dir: "in",
            type: wireType(frame),
            seq: "seq" in frame && typeof frame.seq === "number" ? frame.seq : seq,
            fate: { kind: "frames", count: 1 },
            synthetic: true,
            payload: {
              jsonrpc: "2.0",
              method: "event",
              params: { type: wireType(frame), seq, payload: frame },
            },
          });
          if (mark) tagRecord(frame, mark);
          yield frame;
        }
      })();
    },
  };
}
