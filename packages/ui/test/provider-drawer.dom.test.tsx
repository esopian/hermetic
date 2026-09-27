/**
 * §8.3's provider setup, driven the way an operator drives it.
 *
 * The four behaviours here are the ones that cannot be seen from a pure test:
 * that a draft key produces exactly one catalog read and that the read carries
 * the key; that an answer arriving *after* the provider changed is thrown away;
 * that a failed catalog leaves Save available and offers Retry; and that a
 * custom model id survives a refresh that does not list it.
 */
import { act, cleanup, render, screen, userEvent, waitFor, within } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderCatalog } from "../src/api/index.ts";
import { ProviderDrawer } from "../src/components/settings/ProviderDrawer.tsx";
import { errorBody, fakeServer } from "./fake-transport.ts";
import type { FakeServer, TransportCall } from "./fake-transport.ts";
import { FIXTURE_PROFILES } from "./profiles-fixture.ts";

let server: FakeServer | null = null;
afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
});

const CATALOG = {
  anthropic: {
    label: "Anthropic",
    auth: "api_key",
    env: "ANTHROPIC_API_KEY",
    base_url: null,
    hermes_provider: "anthropic",
    hermes_provider_entry: false,
    default_model: "claude-sonnet-5",
    description: "Claude, keyed",
  },
  openai: {
    label: "OpenAI",
    auth: "api_key",
    env: "OPENAI_API_KEY",
    base_url: "https://api.openai.com/v1",
    hermes_provider: "openai-api",
    hermes_provider_entry: true,
    default_model: "gpt-5.6-luna",
    description: "OpenAI, keyed",
  },
} as unknown as ProviderCatalog;

function catalogReply(provider: string, models: { id: string; name: string }[]) {
  return {
    provider,
    models,
    default_model: models[0]?.id ?? "",
    fetched_at: "2026-09-14T00:00:00.000Z",
  };
}

const ANTHROPIC_MODELS = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-opus-5", name: "Claude Opus 5" },
];
const OPENAI_MODELS = [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }];

function drawer(profile = null as (typeof FIXTURE_PROFILES)[number] | null) {
  return (
    <ProviderDrawer
      profile={profile}
      catalog={CATALOG}
      expectedVersion={3}
      defaultProfile={null}
      onClose={() => {}}
      onSaved={() => {}}
    />
  );
}

/** The key field, typed and then left — which is what commits a draft key. */
async function typeKey(user: ReturnType<typeof userEvent.setup>, value: string) {
  const field = screen.getByLabelText("API key");
  await user.click(field);
  await user.type(field, value);
  await user.tab();
}

describe("ProviderDrawer · catalog", () => {
  test("a draft key produces one read, and the read carries the key", async () => {
    server = fakeServer({
      "providers.models": catalogReply("anthropic", ANTHROPIC_MODELS),
    });
    const user = userEvent.setup();
    render(drawer());

    // Nothing is read before there is a credential to read with.
    expect(server.to("providers.models")).toHaveLength(0);
    expect(screen.getByText(/type a key above/)).toBeTruthy();

    await typeKey(user, "FIXTURE-anthropic");
    await waitFor(() => expect(screen.getByText("claude-opus-5")).toBeTruthy());

    const calls = server.to("providers.models");
    // One read for the whole key, not one per keystroke.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual({ provider: "anthropic", api_key: "FIXTURE-anthropic" });
  });

  test("a catalog that arrives after the provider changed is discarded", async () => {
    let releaseAnthropic: () => void = () => {};
    const anthropicHeld = new Promise<void>((resolve) => {
      releaseAnthropic = resolve;
    });
    server = fakeServer({
      "providers.models": async (call: TransportCall) => {
        const body = call.params as { provider: string };
        if (body.provider === "anthropic") {
          await anthropicHeld;
          return { json: catalogReply("anthropic", ANTHROPIC_MODELS) };
        }
        return { json: catalogReply("openai", OPENAI_MODELS) };
      },
    });
    const user = userEvent.setup();
    render(drawer());

    await typeKey(user, "FIXTURE-anthropic");
    // Anthropic's read is in flight and has painted nothing.
    expect(screen.queryByText("claude-opus-5")).toBeNull();

    await user.selectOptions(screen.getAllByRole("combobox")[0] as HTMLSelectElement, "openai");
    await typeKey(user, "FIXTURE-openai");
    const models = () => screen.getByRole("list", { name: "Models" });
    await waitFor(() => expect(within(models()).getByText("gpt-5.6-luna")).toBeTruthy());

    // Now let the first provider answer. It is a *stale* answer and must not
    // land: an Anthropic catalog under an OpenAI profile is a model id that
    // cannot be invoked.
    await act(async () => {
      releaseAnthropic();
      await anthropicHeld;
    });
    expect(screen.queryByText("claude-opus-5")).toBeNull();
    expect(within(models()).getByText("gpt-5.6-luna")).toBeTruthy();
  });

  test("a failed catalog offers Retry and leaves Save available", async () => {
    let attempt = 0;
    server = fakeServer({
      "providers.models": () => {
        attempt += 1;
        return attempt === 1
          ? errorBody("PROVIDER_UNREACHABLE", "anthropic did not answer in 15s")
          : { json: catalogReply("anthropic", ANTHROPIC_MODELS) };
      },
      "providers.create": {
        // The profile this test types, named rather than taken from the head of
        // the fixture list, which is a different profile now.
        profile: FIXTURE_PROFILES.find((p) => p.id === "an7hr0p1"),
        settings: {},
        persisted: true,
      },
    });
    const user = userEvent.setup();
    render(drawer());

    await user.type(screen.getByLabelText("Name"), "anthropic-main");
    await typeKey(user, "FIXTURE-anthropic");
    await waitFor(() => expect(screen.getByText(/PROVIDER_UNREACHABLE/)).toBeTruthy());

    // Model discovery is not a prerequisite for saving a credential (§8.3).
    const save = screen.getByRole("button", { name: "Create profile" });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/the model above still saves/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("claude-opus-5")).toBeTruthy());

    await user.click(save);
    await waitFor(() => expect(server?.to("providers.create")).toHaveLength(1));
    const body = server.to("providers.create")[0]?.params as Record<string, unknown>;
    expect(body["provider"]).toBe("anthropic");
    expect(body["name"]).toBe("anthropic-main");
    expect(body["api_key"]).toBe("FIXTURE-anthropic");
  });

  test("a custom model id is kept, marked unlisted, and survives a refresh", async () => {
    server = fakeServer({
      "providers.models": catalogReply("anthropic", ANTHROPIC_MODELS),
    });
    const user = userEvent.setup();
    render(drawer());

    await typeKey(user, "FIXTURE-anthropic");
    await waitFor(() => expect(screen.getByText("claude-opus-5")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "Enter custom model ID" }));
    await user.type(screen.getByLabelText("Custom model ID"), "my/private-build");
    await user.click(screen.getByRole("button", { name: "Use" }));

    const list = () => screen.getByRole("list", { name: "Models" });
    // Pinned first, and marked rather than silently dropped.
    expect(within(list()).getAllByRole("button")[0]?.textContent).toContain("my/private-build");
    expect(within(list()).getAllByRole("button")[0]?.textContent).toContain("unlisted");

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(server?.to("providers.models")).toHaveLength(2));
    // Refreshing never moves the selection.
    expect(within(list()).getAllByRole("button")[0]?.textContent).toContain("my/private-build");
    expect(screen.getByText("my/private-build", { selector: "b" })).toBeTruthy();
  });
});

describe("ProviderDrawer · editing", () => {
  test("the provider is fixed, the key field is never prefilled, and the read uses the profile", async () => {
    server = fakeServer({
      "providers.models": catalogReply("anthropic", ANTHROPIC_MODELS),
    });
    // Named, not indexed: this test is about the anthropic profile's catalog
    // read, and the fixture's order is no longer an alias for that.
    render(drawer(FIXTURE_PROFILES.find((p) => p.id === "an7hr0p1") ?? null));

    expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText(/fixed after create/)).toBeTruthy();
    expect((screen.getByLabelText("Rotate key") as HTMLInputElement).value).toBe("");

    await waitFor(() => expect(server?.to("providers.models")).toHaveLength(1));
    expect(server.to("providers.models")[0]?.params).toEqual({ profile: "an7hr0p1" });
  });
});
