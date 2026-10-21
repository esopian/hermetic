/**
 * Fixture mode: built only when the flag says so, and, when it is, the real
 * stores run over it unchanged.
 */
import type { AttachmentBlock, ChatFrame, ToolBlock } from "@hermetic/core/chat-client";
import { MobileFleetView } from "@hermetic/core/schema";
import {
  FIXTURE_DEMO_PROMPTS,
  FIXTURE_FLEET_ID,
  FIXTURE_GALLERY,
  seedGallery,
  FIXTURE_PUSH_TOKEN,
  FIXTURE_TAILNET,
  fixtureKit,
} from "../../src/fixture/index.ts";
import { createHermeticClient } from "../../src/client/client.ts";
import { pasteAttachments } from "../../src/client/paste.ts";
import { isShareAttachment, isShareTool } from "../../src/client/share-logic.ts";
import type { DemoPrompt } from "../../src/fleet/FleetProvider.tsx";
import { readPairingLink } from "../../src/fleet/pairing.ts";
import { hermeticdRegistrar, PushSync } from "../../src/fleet/push.ts";
import { FleetStore, memoryFile, memoryKv } from "../../src/fleet/store.ts";
import { probeTailscale } from "../../src/gateway/tailscale.ts";
import { InboxStore } from "../../src/inbox/store.ts";

const NOW = "2026-10-13T10:00:00.000Z";

function kit() {
  const k = fixtureKit("1", () => NOW);
  if (!k) throw new Error("fixture kit not built with the flag set");
  return k;
}

/** The fixture fleet paired, with `primary` picked (`null`: none yet, as right after pairing). */
async function pairedFleet(k = kit(), primary: string | null = "atlas") {
  const read = readPairingLink(k.link);
  if (!read.ok) throw new Error(read.error.title);
  const fleet = new FleetStore({
    secure: memoryKv(),
    viewCache: memoryFile(),
    fetch: k.fetch,
    now: () => NOW,
  });
  await fleet.pair(read.link);
  if (primary) await fleet.setPrimary(primary);
  return fleet;
}

describe("fixtureKit", () => {
  test("is nothing without the flag", () => {
    expect(fixtureKit(undefined)).toBeNull();
    expect(fixtureKit("")).toBeNull();
    expect(fixtureKit("0")).toBeNull();
    expect(fixtureKit("true")).toBeNull();
  });

  test("its link pairs with the fixture fleet: main, eleven agents, corvid on a suffixed host", () => {
    const read = readPairingLink(kit().link);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.link.label).toBe("main");
    expect(read.link.payload.fleet_id).toBe(FIXTURE_FLEET_ID);
    expect(read.link.payload.tailnet).toBe(FIXTURE_TAILNET);
    expect(read.link.payload.agents.map((a) => a.name)).toEqual([
      "atlas",
      "corvid",
      "ember",
      "fathom",
      "granite",
      "heron",
      "ibis",
      "juniper",
      "kestrel",
      "lumen",
      "marrow",
    ]);
    expect(read.link.payload.agents.find((a) => a.name === "corvid")?.host).toBe(
      "fxtr0001-corvid-2.hermetic.ts.net",
    );
  });

  test("GET /fleet answers a valid view, and the fleet store takes it", async () => {
    const k = kit();
    const response = await k.fetch("http://fxtr0001-atlas.hermetic.ts.net:7434/fleet");
    expect(MobileFleetView.safeParse(await response.json()).success).toBe(true);
    const fleet = await pairedFleet(k, null);
    expect(await fleet.refresh()).toBe(true);
    const agents = fleet.agents();
    expect(agents).toHaveLength(11);
    expect(agents.find((a) => a.name === "heron")).toMatchObject({ status: "error", live: true });
    // A fresh fixture pairing listens to nothing: the primary picker comes first.
    expect(fleet.listened()).toEqual([]);
    expect(fleet.needsPrimary()).toBe(true);
  });

  test("the Tailscale switch is what the real probe sees", async () => {
    const k = kit();
    const hosts = ["fxtr0001-atlas.hermetic.ts.net", "fxtr0001-ibis.hermetic.ts.net"];
    expect((await probeTailscale({ hosts, fetch: k.fetch })).status).toBe("ok");
    k.tailscale.set("off");
    expect((await probeTailscale({ hosts, fetch: k.fetch })).status).toBe("off");
    k.tailscale.set("unreachable");
    expect((await probeTailscale({ hosts, fetch: k.fetch })).status).toBe("unreachable");
  });

  test("push registration lands in the memory registry, and leaves it", async () => {
    const k = kit();
    const fleet = await pairedFleet(k);
    await fleet.refresh();
    const push = new PushSync({
      fleet,
      registrar: hermeticdRegistrar(k.fetch),
      deviceId: async () => "phone-1",
      token: async () => ({ ok: true, token: k.pushToken }),
      platform: "ios",
      appVersion: "0.1.0",
      previews: () => false,
    });
    const status = await push.enable();
    expect(status.state).toBe("on");
    expect(k.registry.devicesOn("fxtr0001-atlas.hermetic.ts.net")).toEqual([
      expect.objectContaining({
        device_id: "phone-1",
        token: FIXTURE_PUSH_TOKEN,
        listening: "all",
        previews: false,
      }),
    ]);
    // Only the primary is listened, so another agent was never asked.
    expect(k.registry.devicesOn("fxtr0001-juniper.hermetic.ts.net")).toEqual([]);
    await push.disable();
    expect(k.registry.devicesOn("fxtr0001-atlas.hermetic.ts.net")).toEqual([]);
  });

  test("the canned chat client answers the fleet's swarms", async () => {
    const k = kit();
    const swarm = await k.chat.swarm({
      instance: "atlas",
      baseUrl: "https://fxtr0001-atlas.hermetic.ts.net/",
      fleet_id: FIXTURE_FLEET_ID,
    });
    expect(swarm.instance).toBe("atlas");
  });

  test("creating a bot makes it appear in the roster", async () => {
    const k = kit();
    const fleet = await pairedFleet(k);
    const client = createHermeticClient({
      fleet,
      inbox: new InboxStore(memoryFile(), () => NOW),
      fetch: k.fetch,
      openSocket: () => {
        throw new Error("no socket in fixture mode");
      },
      chat: k.chat,
    });
    try {
      const listed = () =>
        client.roster
          .getState()
          .swarms.find((s) => s.instance === "atlas")
          ?.bots.find((b) => b.name === "scout");
      await client.roster.refresh();
      expect(listed()).toBeUndefined();
      const profile = await client.createBot("atlas", {
        name: "scout",
        title: "Scout",
        description: "FIXTURE finds things",
      });
      expect(profile).toMatchObject({
        instance: "atlas",
        bot: "scout",
        description: "FIXTURE finds things",
      });
      expect(listed()).toMatchObject({ title: "Scout", description: "FIXTURE finds things" });
      await expect(client.createBot("atlas", { name: "scout" })).rejects.toMatchObject({
        code: "CONFLICT",
      });
    } finally {
      client.dispose();
    }
  });

  test("chat: a sent prompt is one row, and the conversation observes live from the start", async () => {
    const k = kit();
    const fleet = await pairedFleet(k);
    const client = createHermeticClient({
      fleet,
      inbox: new InboxStore(memoryFile(), () => NOW),
      fetch: k.fetch,
      openSocket: () => {
        throw new Error("no socket in fixture mode");
      },
      chat: k.chat,
    });
    const until = async (ok: () => boolean, ms = 8_000) => {
      const end = Date.now() + ms;
      while (!ok()) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    try {
      const target = { instance: "atlas", bot: "scribe", session: null };
      client.chat.open(target);
      await until(() => client.chat.view(target).history === "ready");
      // Not "Reconnecting…": the fixture's observation has its activity store.
      expect(client.chat.view(target).observe).toBe("live");
      const prompt = "FIXTURE prompt sent once";
      client.chat.send(target, prompt);
      const said = () =>
        client.chat
          .view(target)
          .messages.filter(
            (m) =>
              m.role === "user" && m.blocks.some((b) => b.kind === "text" && b.markdown === prompt),
          );
      await until(() => !client.chat.view(target).live && !client.chat.view(target).sending);
      await until(() => said().every((m) => !m.id.startsWith("local:")));
      expect(said()).toHaveLength(1);
      expect(client.chat.view(target).observe).toBe("live");
    } finally {
      client.dispose();
    }
  }, 20_000);
});

/* ── the demo prompts, and the files they raise ──────────────────────────── */

const ATLAS = {
  instance: "atlas",
  baseUrl: "https://fxtr0001-atlas.hermetic.ts.net/",
  fleet_id: FIXTURE_FLEET_ID,
};
const ATLAS_HOST = "fxtr0001-atlas.hermetic.ts.net";

/** What a frame is, as the expectations below name it: `tool:<render>`, a block kind, or the frame type. */
function kindOf(frame: ChatFrame): string {
  if (frame.type !== "block") return frame.type;
  return frame.block.kind === "tool" ? `tool:${frame.block.render ?? "null"}` : frame.block.kind;
}

/** Every demo prompt's label, and the first frame kind that shows it worked. */
const EXPECTED: Record<string, string> = {
  "Plain reply": "tool:terminal",
  Markdown: "text",
  "Tool rows": "tool:terminal",
  "Background process": "process_event",
  "Message a teammate": "tool:message_agent",
  Approval: "approval",
  "Smart approval": "approval",
  "No session": "approval",
  Batch: "question",
  "One in a batch": "question",
  Blocking: "question",
  "One child": "subagent",
  Parallel: "subagent",
  Background: "subagent",
  "Share files": "tool:file_share",
  "File request": "tool:file_request",
  "Secret file": "tool:file_request",
  "Text secret": "tool:secret_request",
  "Text secret, several keys": "tool:secret_request",
  "Request times out": "tool:file_request",
};

function expectedKind(p: DemoPrompt): string {
  if (p.group === "Errors") return "error";
  if (p.label === "Times out") return p.group === "Approvals" ? "approval" : "question";
  const kind = EXPECTED[p.label];
  if (!kind) throw new Error(`no expectation for the demo prompt "${p.label}"`);
  return kind;
}

describe("FIXTURE_DEMO_PROMPTS", () => {
  test("the kit hands the list to the provider", () => {
    expect(kit().demoPrompts).toBe(FIXTURE_DEMO_PROMPTS);
  });

  test("covers every group, with unique prompts", () => {
    expect([...new Set(FIXTURE_DEMO_PROMPTS.map((p) => p.group))]).toEqual([
      "Text",
      "Tools",
      "Approvals",
      "Questions",
      "Subagents",
      "Errors",
      "Files",
    ]);
    const prompts = FIXTURE_DEMO_PROMPTS.map((p) => p.prompt);
    expect(new Set(prompts).size).toBe(prompts.length);
    expect(FIXTURE_DEMO_PROMPTS.filter((p) => p.group === "Errors")).toHaveLength(10);
  });

  test("every prompt raises a frame of its kind", async () => {
    const k = kit();
    const missed: string[] = [];
    for (const demo of FIXTURE_DEMO_PROMPTS) {
      const want = expectedKind(demo);
      const seen: string[] = [];
      // A prompt that never raises its kind would park (a request waits for
      // hours): the deadline ends the turn and records the miss.
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 5_000);
      for await (const frame of k.chat.send(ATLAS, "default", demo.prompt, {
        signal: controller.signal,
      })) {
        seen.push(kindOf(frame));
        if (seen.includes(want)) break;
      }
      clearTimeout(deadline);
      controller.abort();
      if (!seen.includes(want)) missed.push(`${demo.label}: wanted ${want}, saw ${seen.join(",")}`);
    }
    expect(missed).toEqual([]);
  }, 60_000);

  test("Markdown streams a reply holding a heading, a table, a link and a box image", async () => {
    const k = kit();
    const prompt = FIXTURE_DEMO_PROMPTS.find((p) => p.label === "Markdown")?.prompt ?? "";
    let text = "";
    for await (const frame of k.chat.send(ATLAS, "default", prompt)) {
      if (frame.type === "delta") text += frame.text;
    }
    expect(text).toMatch(/^## /m);
    expect(text).toMatch(/^\| metric \| value \|$/m);
    expect(text).toMatch(/\]\(https:\/\//);
    expect(text).toMatch(/!\[[^\]]+\]\(\/files\/f_[a-z0-9]{12}\/content\)/);
  });
});

describe("E2E_FILE_SHARE on the phone's fixture box", () => {
  test("two share cards and a MEDIA chip, whose bytes the box serves under their digest", async () => {
    const k = kit();
    const settled: ToolBlock[] = [];
    const chips: AttachmentBlock[] = [];
    for await (const frame of k.chat.send(ATLAS, "default", "send me the Q3 numbers E2E_FILE_SHARE")) {
      if (frame.type !== "block") continue;
      const b = frame.block;
      if (b.kind === "tool" && b.render === "file_share" && b.share) settled.push(b);
      if (b.kind === "attachment") chips.push(b);
    }
    expect(settled.map((b) => b.share?.name)).toEqual(["q3-revenue.png", "q3-revenue.csv"]);
    expect(chips).toHaveLength(1);
    const chip = chips[0] as AttachmentBlock;
    expect(chip.file_id).toBe(settled[0]?.share?.share_id);
    expect(isShareAttachment(chip)).toBe(true);
    expect(settled.every((b) => isShareTool(b))).toBe(true);

    const files = k.files(ATLAS_HOST);
    for (const b of settled) {
      const share = b.share as NonNullable<ToolBlock["share"]>;
      const got = await files.content(share.share_id, { maxBytes: 1024 * 1024 });
      expect(got.sha256).toBe(share.sha256);
      expect(got.mime).toBe(share.mime);
      expect(got.bytes.byteLength).toBe(share.bytes);
    }
    // A share is on the box that made it, and on no other.
    await expect(
      k.files("fxtr0001-kestrel.hermetic.ts.net").content(settled[0]?.share?.share_id ?? ""),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  test("the canned transcripts' pictures load from any box", async () => {
    const k = kit();
    const got = await k.files("fxtr0001-kestrel.hermetic.ts.net").content("f_fxqueuedpth1");
    expect(got.mime).toBe("image/png");
    expect(got.bytes.byteLength).toBeGreaterThan(0);
    const shot = await k.files(ATLAS_HOST).content("f_fxgrafana001");
    expect(shot.mime).toBe("image/png");
  });
});

describe("the gallery bot", () => {
  test("its Bot Chat holds the live-only kinds once seeded", async () => {
    const k = kit();
    await seedGallery(k.chat);
    const box = {
      instance: FIXTURE_GALLERY.instance,
      baseUrl: "https://fxtr0001-corvid-2.hermetic.ts.net/",
      fleet_id: FIXTURE_FLEET_ID,
    };
    // The background delegation outlives its turn; its results turn landing is
    // the last thing it schedules, so waiting for it leaves no timer behind.
    const landed = async () =>
      (await k.chat.history(box, FIXTURE_GALLERY.bot)).some((m) =>
        m.blocks.some(
          (b) => b.kind === "text" && b.markdown.includes("Both background tasks are done"),
        ),
      );
    for (let end = Date.now() + 15_000; !(await landed()); ) {
      if (Date.now() > end) throw new Error("the background delegation never reported back");
      await new Promise((r) => setTimeout(r, 50));
    }
    const history = await k.chat.history(box, FIXTURE_GALLERY.bot);
    const kinds = new Set(
      history.flatMap((m) =>
        m.blocks.map((b) => (b.kind === "tool" ? `tool:${b.render ?? "null"}` : b.kind)),
      ),
    );
    for (const kind of [
      "tool:file_share",
      "attachment",
      "subagent",
      "process_event",
      "tool:message_agent",
    ])
      expect(kinds).toContain(kind);
    expect(
      history.some((m) => m.blocks.some((b) => b.kind === "text" && b.markdown.includes("!["))),
    ).toBe(true);
  }, 30_000);

  test("a kit built without seed runs no turn; one with it seeds on the first roster read", async () => {
    const plain = fixtureKit("1", () => NOW);
    const seeded = fixtureKit("1", () => NOW, { seed: true });
    if (!plain || !seeded) throw new Error("no kit");
    const send = jest.spyOn(plain.chat, "send");
    await plain.chat.swarm(ATLAS);
    expect(send).not.toHaveBeenCalled();
    expect(seeded.chat).not.toBe(plain.chat);
  });
});

describe("fixture: sample files for ?attach=", () => {
  test("an image (the box's canned PNG) then a text file, written and described as a picker would", async () => {
    const written = new Map<string, Uint8Array>();
    const k = fixtureKit("1", () => NOW, {
      writeSample: async (name, bytes) => {
        written.set(name, bytes);
        return `file:///cache/${name}`;
      },
    });
    const samples = await k?.sampleFiles();
    expect(samples?.map((f) => [f.name, f.kind, f.mime, f.uri])).toEqual([
      ["fixture-sample.png", "image", "image/png", "file:///cache/fixture-sample.png"],
      ["fixture-notes.txt", "file", "text/plain", "file:///cache/fixture-notes.txt"],
    ]);
    const png = written.get("fixture-sample.png");
    expect([...(png ?? []).slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const f of samples ?? []) expect(f.size).toBe(written.get(f.name)?.byteLength);
  });
});

describe("fixture: the clipboard picture for ?paste=image", () => {
  test("the canned PNG as the paste control answers it, which the paste path takes as one image", async () => {
    const k = fixtureKit("1", () => NOW);
    const pasted = await k?.clipboardImage();
    expect(pasted?.type).toBe("image");
    expect(pasted?.data.startsWith("data:image/png;base64,")).toBe(true);
    expect(pasted?.size.width).toBeGreaterThan(0);
    const written: string[] = [];
    const items = pasted
      ? await pasteAttachments(pasted, async (name) => {
          written.push(name);
          return { uri: `file:///cache/${name}`, size: 1 };
        })
      : [];
    expect(items.map((a) => [a.kind, a.mime, a.status])).toEqual([["image", "image/png", "picked"]]);
    expect(written).toHaveLength(1);
  });
});
