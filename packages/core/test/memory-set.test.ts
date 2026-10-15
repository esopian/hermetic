/**
 * `agents.set` choosing or changing an existing agent's Hermes memory provider
 * (`memory_provider`, §6.2): create's refusals asked of the agent as the call
 * leaves it, the row and the uploaded config rewritten together, `none`
 * clearing it, and the provider it already has a no-op.
 */
import { describe, expect, test } from "bun:test";
import { HermeticError } from "../src/errors.ts";
import { MEMORY_HONCHO_CAPABILITY, MEMORY_PROVIDERS } from "../src/schema/index.ts";
import type { Agent } from "../src/schema/index.ts";
import { drain, freshFleet } from "./helpers.ts";

async function errorOfAsync(run: () => Promise<unknown>): Promise<HermeticError | null> {
  try {
    await run();
    return null;
  } catch (e) {
    if (e instanceof HermeticError) return e;
    throw e;
  }
}

/** The text files of a gzipped ustar archive, by path — enough to read a rendered config. */
function untar(gz: Uint8Array<ArrayBuffer>): Map<string, string> {
  const buf = Bun.gunzipSync(gz);
  const text = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\0[\s\S]*$/, "");
  const files = new Map<string, string>();
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    const name = text(header.subarray(0, 100));
    if (name === "") break;
    const prefix = text(header.subarray(345, 500));
    const size = parseInt(text(header.subarray(124, 136)).trim(), 8);
    const body = buf.subarray(off + 512, off + 512 + size);
    files.set(prefix === "" ? name : `${prefix}/${name}`, new TextDecoder().decode(body));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function configOf(backend: ReturnType<typeof freshFleet>["backend"], agent: Agent) {
  const files = untar(new Uint8Array(backend.objects.get(agent.resources.config_key!)!));
  const manifest = JSON.parse(files.get("manifest.json")!) as { memory?: { provider: string } };
  const configYaml = [...files.entries()].find(([p]) => p.endsWith("config.yaml"))?.[1] ?? "";
  return { manifest, configYaml };
}

async function kite(input: Record<string, unknown> = {}) {
  const fleet = freshFleet();
  await drain(fleet.hermetic.agents.create({ name: "kite", size: "small", ...input }));
  const before = (await fleet.backend.store.agents.get("kite"))!;
  return { ...fleet, before };
}

const setEvents = (backend: ReturnType<typeof freshFleet>["backend"]) =>
  backend.events.filter((e) => e.name === "kite" && e.action === "set");

describe("agents.set --memory: create's checks against the resulting agent", () => {
  test("none → hindsight on xsmall is MEMORY_PROVIDER_UNDERSIZED, the row unchanged", async () => {
    const { backend, hermetic, before } = await kite({ size: "xsmall" });
    expect(before.memory).toBeNull();
    const error = await errorOfAsync(() =>
      hermetic.agents.set({ name: "kite", memory_provider: "hindsight" }),
    );
    expect(error?.code).toBe("MEMORY_PROVIDER_UNDERSIZED");
    expect(await backend.store.agents.get("kite")).toEqual(before);
  });

  test("an instance type the operator named is theirs to answer for, as at create", async () => {
    const { backend, hermetic } = await kite({ size: "xsmall", instance_type: "c7g.2xlarge" });
    await hermetic.agents.set({ name: "kite", memory_provider: "hindsight" });
    expect((await backend.store.agents.get("kite"))!.memory).toEqual({ provider: "hindsight" });
  });

  test("a size and a provider in one call are judged together", async () => {
    // Down a size and onto a provider that needs the size given up: refused.
    const down = await kite({ size: "small" });
    const error = await errorOfAsync(() =>
      down.hermetic.agents.set({ name: "kite", size: "xsmall", memory_provider: "hindsight" }),
    );
    expect(error?.code).toBe("MEMORY_PROVIDER_UNDERSIZED");
    expect(await down.backend.store.agents.get("kite")).toEqual(down.before);

    // Up a size and onto a provider only the new size fits: written.
    const up = await kite({ size: "xsmall" });
    await up.hermetic.agents.set({ name: "kite", size: "small", memory_provider: "hindsight" });
    const after = (await up.backend.store.agents.get("kite"))!;
    expect(after.size).toBe("small");
    expect(after.memory).toEqual({ provider: "hindsight" });
  });

  test("honcho on an anthropic agent is MEMORY_LLM_UNSUPPORTED, the row unchanged", async () => {
    // The fixture fleet's default profile is anthropic.
    const { backend, hermetic, before } = await kite();
    expect(before.provider).toBe("anthropic");
    const error = await errorOfAsync(() =>
      hermetic.agents.set({ name: "kite", memory_provider: "honcho" }),
    );
    expect(error?.code).toBe("MEMORY_LLM_UNSUPPORTED");
    expect(error?.message).toInclude(MEMORY_PROVIDERS.honcho.vendors_note!);
    expect(await backend.store.agents.get("kite")).toEqual(before);
  });

  test("a staged binding onto a vendor honcho cannot use refuses it, staged earlier or in the same call", async () => {
    const { backend, hermetic } = await kite({ provider_profile: "openrouter-cheap" });
    // In the same call as the binding.
    const together = await errorOfAsync(() =>
      hermetic.agents.set({
        name: "kite",
        provider_profile: "anthropic-main",
        memory_provider: "honcho",
      }),
    );
    expect(together?.code).toBe("MEMORY_LLM_UNSUPPORTED");
    // After it: the row still runs openrouter, but the apply lands anthropic.
    await hermetic.agents.set({ name: "kite", provider_profile: "anthropic-main" });
    const staged = (await backend.store.agents.get("kite"))!;
    expect(staged.provider).toBe("openrouter");
    expect(staged.pending?.provider).toBe("anthropic");
    const error = await errorOfAsync(() =>
      hermetic.agents.set({ name: "kite", memory_provider: "honcho" }),
    );
    expect(error?.code).toBe("MEMORY_LLM_UNSUPPORTED");
    // `assertMemoryLlm`'s refusal, not the render's backstop.
    expect(error?.message).toInclude(MEMORY_PROVIDERS.honcho.vendors_note!);
    expect(await backend.store.agents.get("kite")).toEqual(staged);
  });

  /**
   * The openviking store guard is for a store in use across a vendor move. A
   * switch onto openviking has none of this agent's in use, and a switch away
   * leaves the store on the volume, so neither is refused for the move.
   */
  test("switching onto or off openviking across a staged embedding flip is not the store guard's", async () => {
    // openrouter embeds remotely; anthropic, staged, would embed locally.
    const onto = await kite({ provider_profile: "openrouter-cheap" });
    await onto.hermetic.agents.set({ name: "kite", provider_profile: "anthropic-main" });
    await onto.hermetic.agents.set({ name: "kite", memory_provider: "openviking" });
    expect((await onto.backend.store.agents.get("kite"))!.memory).toEqual({ provider: "openviking" });

    const off = await kite({ provider_profile: "openrouter-cheap", memory_provider: "openviking" });
    await off.hermetic.agents.set({
      name: "kite",
      provider_profile: "anthropic-main",
      memory_provider: "none",
    });
    const after = (await off.backend.store.agents.get("kite"))!;
    expect(after.memory).toBeNull();
    expect(after.pending?.provider).toBe("anthropic");

    // Staying on openviking across the same flip is still refused.
    const stay = await kite({ provider_profile: "openrouter-cheap", memory_provider: "openviking" });
    const error = await errorOfAsync(() =>
      stay.hermetic.agents.set({ name: "kite", provider_profile: "anthropic-main" }),
    );
    expect(error?.code).toBe("MEMORY_LLM_UNSUPPORTED");
    expect(error?.message).toInclude("empty");
    expect(await stay.backend.store.agents.get("kite")).toEqual(stay.before);
  });

  test("a published hermeticd without memory-honcho refuses the switch, the row unchanged", async () => {
    const { backend, hermetic, before } = await kite({ provider_profile: "openrouter-cheap" });
    const manifest = JSON.parse(new TextDecoder().decode(backend.objects.get("manifest.json")!)) as {
      hermeticd: { capabilities?: string[] };
    };
    manifest.hermeticd.capabilities = (manifest.hermeticd.capabilities ?? []).filter(
      (c) => c !== MEMORY_HONCHO_CAPABILITY,
    );
    backend.objects.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
    const error = await errorOfAsync(() =>
      hermetic.agents.set({ name: "kite", memory_provider: "honcho" }),
    );
    expect(error?.code).toBe("HERMETICD_UNAVAILABLE");
    expect(error?.message).toInclude(MEMORY_HONCHO_CAPABILITY);
    expect(await backend.store.agents.get("kite")).toEqual(before);
  });
});

describe("agents.set --memory: what a switch writes", () => {
  test("a valid change rewrites the row, the config hash and the rendered config", async () => {
    const { backend, hermetic, before } = await kite();
    expect(configOf(backend, before).manifest.memory).toBeUndefined();

    const view = await hermetic.agents.set({ name: "kite", memory_provider: "hindsight" });
    expect(view.memory).toEqual({ provider: "hindsight" });
    const after = (await backend.store.agents.get("kite"))!;
    expect(after.memory).toEqual({ provider: "hindsight" });
    expect(after.config_hash).not.toBe(before.config_hash);
    expect(after.resources.config_key).not.toBe(before.resources.config_key);
    const { manifest, configYaml } = configOf(backend, after);
    expect(manifest.memory?.provider).toBe("hindsight");
    expect(configYaml).toInclude('memory:\n  provider: "hindsight"\n');

    const [event] = setEvents(backend);
    expect(event?.detail).toInclude("memory none → hindsight");
    expect(event?.detail).toInclude("`plan rollout` + `apply`");
  });

  test("hindsight → holographic, then → none clears it; the old provider's data is named as kept", async () => {
    const { backend, hermetic } = await kite({ memory_provider: "hindsight" });
    await hermetic.agents.set({ name: "kite", memory_provider: "holographic" });
    expect((await backend.store.agents.get("kite"))!.memory).toEqual({ provider: "holographic" });

    await hermetic.agents.set({ name: "kite", memory_provider: "none" });
    const after = (await backend.store.agents.get("kite"))!;
    expect(after.memory).toBeNull();
    const { manifest, configYaml } = configOf(backend, after);
    expect(manifest.memory).toBeUndefined();
    expect(configYaml).not.toInclude("memory:\n  provider:");

    const details = setEvents(backend).map((e) => e.detail ?? "");
    expect(details[0]).toInclude("memory hindsight → holographic");
    expect(details[0]).toInclude("hindsight's data stays on the volume");
    expect(details[1]).toInclude("memory holographic → none");
  });

  test("the provider the agent already has is a no-op: no write, no event", async () => {
    const { backend, hermetic, before } = await kite({ memory_provider: "hindsight" });
    const view = await hermetic.agents.set({ name: "kite", memory_provider: "hindsight" });
    expect(view.version).toBe(before.version);
    expect(await backend.store.agents.get("kite")).toEqual(before);
    expect(setEvents(backend)).toEqual([]);
    // `none` on an agent with none, likewise.
    const bare = await kite();
    await bare.hermetic.agents.set({ name: "kite", memory_provider: "none" });
    expect(await bare.backend.store.agents.get("kite")).toEqual(bare.before);
    // Stating nothing at all is still a mistake.
    const error = await errorOfAsync(() => hermetic.agents.set({ name: "kite" }));
    expect(error?.code).toBe("UNSUPPORTED");
  });

  test("an absent choice leaves the provider alone, whatever the fleet default", async () => {
    const { backend, hermetic } = await kite({ memory_provider: "hindsight" });
    await hermetic.settings.set({ default_memory_provider: "holographic" });
    await hermetic.agents.set({ name: "kite", size: "medium" });
    expect((await backend.store.agents.get("kite"))!.memory).toEqual({ provider: "hindsight" });
  });
});
