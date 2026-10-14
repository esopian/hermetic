/**
 * The request card's two hooks against fake APIs: `useFileRequest` backs off a
 * failing read and stops with Retry, and `useFilePut` never leaves an upload
 * behind — a cancel, an unmount, a refusal or a replacing job each discard it,
 * and a replaced job never reaches `files.put`.
 *
 * Assertions compare strings, numbers and booleans, never DOM nodes.
 */
import { act, cleanup, render } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { FileRequestSlot } from "../src/api/files.ts";
import { type FilePut, type PutApi, useFilePut, useLetGoWhenClosed } from "../src/chat/use-file-put.ts";
import {
  FILE_REQUEST_BACKOFF_MAX_MS,
  FILE_REQUEST_MAX_FAILURES,
  type FileRequestView,
  type PollTimers,
  backoffMs,
  useFileRequest,
} from "../src/chat/use-file-request.ts";

afterEach(cleanup);

/** Let every settled promise's continuation run. */
const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

describe("useFileRequest", () => {
  function fakeTimers() {
    const armed: { fn: () => void; ms: number; cleared: boolean }[] = [];
    const timers: PollTimers = {
      setTimeout: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        armed.push(t);
        return t;
      },
      clearTimeout: (h) => {
        (h as { cleared: boolean }).cleared = true;
      },
    };
    /** Fire the newest pending timer; answers its delay. */
    const fire = async (): Promise<number> => {
      const t = armed.at(-1);
      if (!t || t.cleared) throw new Error("nothing armed");
      t.cleared = true;
      await act(async () => t.fn());
      await flush();
      return t.ms;
    };
    return { armed, timers, fire };
  }

  function mount(requestGet: () => Promise<FileRequestSlot>, timers: PollTimers) {
    let view: FileRequestView | null = null;
    function Probe() {
      view = useFileRequest("atlas", "fr_000000000001", { requestGet }, timers);
      return null;
    }
    render(<Probe />);
    return () => view as unknown as FileRequestView;
  }

  test("a failing read backs off 2, 4, 8 … s and stops with unreachable; Retry starts again", async () => {
    const { armed, timers, fire } = fakeTimers();
    let reads = 0;
    const view = mount(() => {
      reads += 1;
      return Promise.reject(Object.assign(new Error("FIXTURE box down"), { code: "INTERNAL" }));
    }, timers);
    await flush();
    const delays: number[] = [];
    while (armed.some((t) => !t.cleared)) delays.push(await fire());
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
    expect(reads).toBe(FILE_REQUEST_MAX_FAILURES);
    expect(view().unreachable).toBe(true);
    expect(view().error).toBe("FIXTURE box down");
    expect(view().missing).toBe(false);
    await act(async () => view().refresh());
    await flush();
    expect(reads).toBe(FILE_REQUEST_MAX_FAILURES + 1);
    expect(view().unreachable).toBe(false);
    expect(armed.at(-1)?.ms).toBe(2_000);
  });

  test("the backoff is capped at 60 s", () => {
    expect(backoffMs(1)).toBe(2_000);
    expect(backoffMs(6)).toBe(FILE_REQUEST_BACKOFF_MAX_MS);
    expect(backoffMs(20)).toBe(FILE_REQUEST_BACKOFF_MAX_MS);
  });

  test("a slot or instance the box does not have is missing, and polling stops", async () => {
    for (const code of ["FILE_NOT_FOUND", "NOT_FOUND"]) {
      const { armed, timers } = fakeTimers();
      const view = mount(() => Promise.reject(Object.assign(new Error("gone"), { code })), timers);
      await flush();
      expect(view().missing).toBe(true);
      expect(armed.length).toBe(0);
      cleanup();
    }
  });
  test("a changed request id reads as unread at once, and the old id's read never lands", async () => {
    const { timers } = fakeTimers();
    const pending: Record<string, (slot: FileRequestSlot) => void> = {};
    const requestGet = (_instance: string, request_id: string) =>
      new Promise<FileRequestSlot>((resolve) => {
        pending[request_id] = resolve;
      });
    let view: FileRequestView | null = null;
    function Probe({ id }: { id: string }) {
      view = useFileRequest("atlas", id, { requestGet }, timers);
      return null;
    }
    const slotFor = (request_id: string) =>
      ({ request_id, state: "open", purpose: request_id }) as unknown as FileRequestSlot;
    const { rerender } = render(<Probe id="fr_00000000000a" />);
    await flush();
    await act(async () => pending.fr_00000000000a!(slotFor("fr_00000000000a")));
    expect((view as unknown as FileRequestView).slot?.request_id).toBe("fr_00000000000a");
    rerender(<Probe id="fr_00000000000b" />);
    // The first render under the new id already drops the old slot.
    expect((view as unknown as FileRequestView).slot === null).toBe(true);
    await flush();
    await act(async () => pending.fr_00000000000b!(slotFor("fr_00000000000b")));
    expect((view as unknown as FileRequestView).slot?.request_id).toBe("fr_00000000000b");
  });
});

describe("useFilePut", () => {
  type Handlers = Parameters<PutApi["putUpload"]>[4];

  function fakeApi(opts: { holdAppend?: boolean } = {}) {
    const discarded: string[] = [];
    const closed: string[] = [];
    const puts: { upload_id: string; handlers: Handlers }[] = [];
    let opened = 0;
    const releases: (() => void)[] = [];
    const api = {
      chunkOpen: async () => {
        opened += 1;
        return { upload_id: `up_${opened}` };
      },
      chunkAppend: () =>
        opts.holdAppend ? new Promise<void>((resolve) => releases.push(resolve)) : Promise.resolve(),
      chunkClose: async () => ({}),
      chunkDiscard: async (upload_id: string) => {
        discarded.push(upload_id);
        return { discarded: true };
      },
      putUpload: (
        _instance: string,
        _request_id: string,
        upload_id: string,
        _o: unknown,
        handlers: Handlers,
      ) => {
        puts.push({ upload_id, handlers });
        return () => closed.push(upload_id);
      },
    } as unknown as PutApi;
    return { api, discarded, closed, puts, releases };
  }

  function mount(api: PutApi) {
    let put: FilePut | null = null;
    let settled = 0;
    function Probe() {
      put = useFilePut("atlas", "fr_000000000001", () => (settled += 1), api);
      return null;
    }
    const view = render(<Probe />);
    return { put: () => put as unknown as FilePut, settled: () => settled, view };
  }

  const file = (name: string) => new File(["FIXTURE bytes\n"], name, { type: "text/plain" });

  test("cancel mid-put closes the stream and discards the upload", async () => {
    const fake = fakeApi();
    const m = mount(fake.api);
    act(() => m.put().putFile(file("a.log")));
    await flush();
    expect(fake.puts.map((p) => p.upload_id)).toEqual(["up_1"]);
    act(() => m.put().cancel());
    expect(fake.closed).toEqual(["up_1"]);
    expect(fake.discarded).toEqual(["up_1"]);
    expect(m.put().state.phase).toBe("idle");
  });

  test("an unmount mid-put closes the stream and discards the upload", async () => {
    const fake = fakeApi();
    const m = mount(fake.api);
    act(() => m.put().putFile(file("a.log")));
    await flush();
    m.view.unmount();
    expect(fake.closed).toEqual(["up_1"]);
    expect(fake.discarded).toEqual(["up_1"]);
  });

  test("the box's refusal discards the upload and shows the refusal", async () => {
    const fake = fakeApi();
    const m = mount(fake.api);
    act(() => m.put().putFile(file("a.log")));
    await flush();
    act(() =>
      fake.puts[0]?.handlers.onDone({ type: "error", code: "FILE_TYPE_REJECTED", message: "FIXTURE" }),
    );
    expect(fake.discarded).toEqual(["up_1"]);
    expect(m.put().state.phase).toBe("error");
    expect(m.settled()).toBe(1);
  });

  test("a second job stops the first: its upload is discarded and it never reaches files.put", async () => {
    const fake = fakeApi({ holdAppend: true });
    const m = mount(fake.api);
    act(() => m.put().putFile(file("first.log")));
    await flush();
    act(() => m.put().putFile(file("second.log")));
    await flush();
    // The first job's upload went the moment it was replaced.
    expect(fake.discarded).toEqual(["up_1"]);
    // Both sends finish their chunks; only the current one is put.
    for (const release of fake.releases) release();
    await flush();
    await flush();
    expect(fake.puts.map((p) => p.upload_id)).toEqual(["up_2"]);
    expect(fake.discarded).toEqual(["up_1"]);
  });

  test("text bytes are held only for the replace question: Cancel zeroes them", async () => {
    const fake = fakeApi();
    const m = mount(fake.api);
    const bytes = new TextEncoder().encode("GITHUB_TOKEN=FIXTURE");
    act(() => m.put().putBytes(bytes, "github.env"));
    await flush();
    act(() =>
      fake.puts[0]?.handlers.onDone({
        type: "error",
        code: "CONFLICT",
        message: "FIXTURE",
        replace_slot: "env-github",
      }),
    );
    const state = m.put().state;
    expect(state.phase === "error" ? state.replace_slot : null).toBe("env-github");
    expect(bytes.some((b) => b !== 0)).toBe(true);
    act(() => m.put().keep());
    expect(bytes.every((b) => b === 0)).toBe(true);
    expect(m.put().state.phase).toBe("idle");
    expect(fake.puts.length).toBe(1);
  });

  test("Replace sends the held bytes again with replace, then zeroes them", async () => {
    const fake = fakeApi();
    const opts: unknown[] = [];
    const api = {
      ...fake.api,
      putUpload: (i: string, r: string, u: string, o: unknown, h: Handlers) => {
        opts.push(o);
        return fake.api.putUpload(i, r, u, o as never, h);
      },
    } as PutApi;
    const m = mount(api);
    const bytes = new TextEncoder().encode("GITHUB_TOKEN=FIXTURE");
    act(() => m.put().putBytes(bytes, "github.env", { as: "dotenv" }));
    await flush();
    act(() =>
      fake.puts[0]?.handlers.onDone({
        type: "error",
        code: "CONFLICT",
        message: "FIXTURE",
        replace_slot: "env-github",
      }),
    );
    act(() => m.put().replace());
    await flush();
    expect(opts).toEqual([{ as: "dotenv" }, { as: "dotenv", replace: true }]);
    expect(bytes.some((b) => b !== 0)).toBe(true);
    act(() => fake.puts[1]?.handlers.onDone({ type: "fulfilled", result: {} as never }));
    expect(bytes.every((b) => b === 0)).toBe(true);
    expect(m.put().state.phase).toBe("idle");
  });

  test("a refusal without replace_slot zeroes the text at once", async () => {
    const fake = fakeApi();
    const m = mount(fake.api);
    const bytes = new TextEncoder().encode("GITHUB_TOKEN=FIXTURE");
    act(() => m.put().putBytes(bytes, "github.env"));
    await flush();
    act(() => fake.puts[0]?.handlers.onDone({ type: "error", code: "VALIDATION", message: "FIXTURE" }));
    expect(bytes.every((b) => b === 0)).toBe(true);
    act(() => m.put().replace());
    expect(fake.puts.length).toBe(1);
  });

  test("a native pick held for the question is discarded on Cancel, reused on Replace", async () => {
    const fake = fakeApi();
    const m = mount(fake.api);
    const ask = (n: number) =>
      act(() =>
        fake.puts[n]?.handlers.onDone({
          type: "error",
          code: "CONFLICT",
          message: "FIXTURE",
          replace_slot: "file-deploy-pem",
        }),
      );
    act(() => m.put().putUpload("up_pick", 10));
    ask(0);
    // Kept for the answer: core kept it registered too.
    expect(fake.discarded).toEqual([]);
    act(() => m.put().replace());
    expect(fake.puts.map((p) => p.upload_id)).toEqual(["up_pick", "up_pick"]);
    ask(1);
    act(() => m.put().keep());
    expect(fake.discarded).toEqual(["up_pick"]);
  });

  /** The card's pairing: the put, and the slot's liveness that `useLetGoWhenClosed` watches. */
  function mountCard(api: PutApi) {
    let put: FilePut | null = null;
    function Probe({ live }: { live: boolean }) {
      put = useFilePut("atlas", "fr_000000000001", () => undefined, api);
      useLetGoWhenClosed(live, put);
      return null;
    }
    const view = render(<Probe live={true} />);
    return {
      put: () => put as unknown as FilePut,
      close: () => act(() => view.rerender(<Probe live={false} />)),
    };
  }

  const askReplace = (fake: ReturnType<typeof fakeApi>, n: number, slot: string) =>
    act(() =>
      fake.puts[n]?.handlers.onDone({
        type: "error",
        code: "CONFLICT",
        message: "FIXTURE",
        replace_slot: slot,
      }),
    );

  test("the slot closing under the replace question zeroes the held text", async () => {
    const fake = fakeApi();
    const m = mountCard(fake.api);
    const bytes = new TextEncoder().encode("GITHUB_TOKEN=FIXTURE");
    act(() => m.put().putBytes(bytes, "github.env"));
    await flush();
    askReplace(fake, 0, "env-github");
    expect(bytes.some((b) => b !== 0)).toBe(true);
    m.close();
    expect(bytes.every((b) => b === 0)).toBe(true);
    expect(m.put().state.phase).toBe("idle");
    // Nothing is left to send: a late Replace is a no-op.
    act(() => m.put().replace());
    expect(fake.puts.length).toBe(1);
  });

  test("the slot closing under the replace question discards a held native pick", async () => {
    const fake = fakeApi();
    const m = mountCard(fake.api);
    act(() => m.put().putUpload("up_pick", 10));
    askReplace(fake, 0, "file-deploy-pem");
    expect(fake.discarded).toEqual([]);
    m.close();
    expect(fake.discarded).toEqual(["up_pick"]);
  });

  test("a slot closing with no question pending lets nothing go", async () => {
    const fake = fakeApi();
    const m = mountCard(fake.api);
    act(() => m.put().putUpload("up_pick", 10));
    act(() => fake.puts[0]?.handlers.onDone({ type: "error", code: "VALIDATION", message: "FIXTURE" }));
    const before = fake.discarded.length;
    m.close();
    expect(fake.discarded.length).toBe(before);
    expect(m.put().state.phase).toBe("error");
  });

  test("a native pick replacing an in-flight put closes and discards the old one", async () => {
    const fake = fakeApi();
    const m = mount(fake.api);
    act(() => m.put().putUpload("up_a", 10));
    act(() => m.put().putUpload("up_b", 10));
    expect(fake.closed).toEqual(["up_a"]);
    expect(fake.discarded).toEqual(["up_a"]);
    expect(fake.puts.map((p) => p.upload_id)).toEqual(["up_a", "up_b"]);
  });
});
