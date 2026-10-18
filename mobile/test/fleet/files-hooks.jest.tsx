import { act, render } from "@testing-library/react-native";
import type { PhoneFiles } from "../../src/gateway/files.ts";
import { FleetContext, type FleetContextValue } from "../../src/fleet/FleetProvider.tsx";
import { type FilesCapability, useFiles, useFilesCapability } from "../../src/fleet/hooks.ts";
import { flush } from "../helpers/fakes.ts";

function fakeFiles(host: string, capable: boolean | Error): PhoneFiles & { host: string } {
  return {
    host,
    capability: jest.fn(async () => {
      if (capable instanceof Error) throw capable;
      return capable;
    }),
    stage: jest.fn(),
    commit: jest.fn(),
    requests: jest.fn(),
    request: jest.fn(),
    fulfil: jest.fn(),
    secret: jest.fn(),
    decline: jest.fn(),
    content: jest.fn(),
  };
}

async function harness(opts: {
  files: boolean;
  capable?: boolean | Error;
  hosts?: Record<string, string>;
}) {
  const hosts = opts.hosts ?? { atlas: "fxtr0001-atlas.hermetic.ts.net" };
  const factory = jest.fn((host: string) => fakeFiles(host, opts.capable ?? true));
  const state = {};
  const ctx = {
    files: opts.files ? factory : null,
    fleet: {
      subscribe: () => () => {},
      getState: () => state,
      hostOf: (name: string) => hosts[name] ?? null,
    },
  } as unknown as FleetContextValue;
  const seen: { files: (PhoneFiles & { host?: string }) | null; capability: FilesCapability } = {
    files: null,
    capability: "unknown",
  };
  function Probe({ instance }: { instance: string | null }) {
    const files = useFiles(instance);
    seen.files = files;
    seen.capability = useFilesCapability(files);
    return null;
  }
  const view = await render(
    <FleetContext.Provider value={ctx}>
      <Probe instance="atlas" />
    </FleetContext.Provider>,
  );
  await act(flush);
  return { seen, factory, view, ctx, Probe };
}

test("useFiles builds the files client for the instance's host, and asks its capability", async () => {
  const h = await harness({ files: true });
  expect(h.factory).toHaveBeenCalledWith("fxtr0001-atlas.hermetic.ts.net");
  expect(h.seen.files?.host).toBe("fxtr0001-atlas.hermetic.ts.net");
  expect(h.seen.capability).toBe("yes");
});

test("a box without the files service reads no", async () => {
  const h = await harness({ files: true, capable: false });
  expect(h.seen.capability).toBe("no");
});

test("a box that did not answer stays unknown", async () => {
  const h = await harness({ files: true, capable: new Error("offline") });
  expect(h.seen.capability).toBe("unknown");
});

test("no files client in the build, or no host for the instance: null", async () => {
  expect((await harness({ files: false })).seen.files).toBeNull();
  const h = await harness({ files: true, hosts: {} });
  expect(h.seen.files).toBeNull();
  expect(h.seen.capability).toBe("unknown");
  expect(h.factory).not.toHaveBeenCalled();
});

test("a null instance has no files client", async () => {
  const h = await harness({ files: true });
  await h.view.rerender(
    <FleetContext.Provider value={h.ctx}>
      <h.Probe instance={null} />
    </FleetContext.Provider>,
  );
  expect(h.seen.files).toBeNull();
});
