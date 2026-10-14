/**
 * A refusal, from the throw to the `ApiError` a component renders.
 *
 * This is a seam test and it lives here because no package may import both
 * sides: `packages/app` throws the refusal, `packages/ui` converts it, and
 * neither is allowed to see the other's half (`tests/boundaries.test.ts`). It
 * is also the test that would have caught the bug it now guards — the app put
 * `code` and `op_id` inside a `body` object, the page reads them as own
 * top-level properties, and *both sides' own tests passed*: the app asserted
 * `.body.code` and the UI's fake threw a flat object nothing in the app ever
 * produced. Each half was right about a shape the other did not have.
 *
 * So nothing here is constructed. The refusal is the one `createRpcBinding`
 * actually throws for a real handler refusal, and it is converted by the real
 * `createRpcTransport`, driven end to end through a fake `Electroview` — the
 * same path the app takes, and a stronger test than calling the conversion
 * directly.
 *
 * The page now reads a refusal flat *and* under `body`, so the end-to-end
 * assertions below survive either shape by design. The first block is what
 * holds the app's own half of the bargain: the thrown value carries the fields
 * as own properties, which is the reading the page prefers and the only one a
 * consumer that is not this transport would find.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { fleetTargetOf, openHermetic } from "@hermetic/core";
import { filesErrorFrom } from "../packages/core/src/aws/files-http.ts";
import { createChatOwner, type ChatOwner } from "../packages/app/src/chat-owner.ts";
import type { HandlerContext } from "../packages/app/src/handlers/ctx.ts";
import { createStreamRegistry } from "../packages/app/src/handlers/streams.ts";
import { InitInFlightError } from "../packages/app/src/init-op.ts";
import { OpRegistry } from "../packages/app/src/ops.ts";
import { createRpcBinding, refusalFor, type RpcOptions } from "../packages/app/src/rpc/bind.ts";
import { AppState, fixedInstance } from "../packages/app/src/state.ts";
import { ApiError } from "../packages/ui/src/api/errors.ts";
import { createRpcTransport, type RpcHandle } from "../packages/ui/src/api/transport-rpc.ts";
import { electrobunRequest } from "../packages/ui/test/electrobun-request.ts";
import type { Transport } from "../packages/ui/src/api/transport.ts";

const owners: ChatOwner[] = [];
afterAll(async () => {
  for (const owner of owners.splice(0)) await owner.stop();
});

async function appContext(): Promise<HandlerContext> {
  const hermetic = await openHermetic({ fixture: true });
  const state = new AppState({
    fixture: true,
    home: ":memory:",
    reopen: fixedInstance(hermetic),
    hermetic,
    target: hermetic.target === null ? null : fleetTargetOf(hermetic.target),
    poller: null,
  });
  const chatOwner = createChatOwner({ hermetic: () => state.hermetic });
  owners.push(chatOwner);
  return {
    state,
    hermetic: () => state.hermetic,
    ops: new OpRegistry(),
    poller: () => state.poller,
    chatOwner,
    fixture: true,
    opts: { fixture: true },
    streams: createStreamRegistry(),
  };
}

/**
 * The page's transport, wired to the app's real request table.
 *
 * `rejectWith`, when given, replaces the answer with that rejection — the one
 * way to exercise a refusal the fixture fleet cannot be made to produce (an
 * `init` already in flight). It is still `bind.ts`'s own `refusalFor` that
 * builds it, so the shape under test is production's either way.
 */
async function pageOverApp(rejectWith?: unknown): Promise<Transport> {
  const ctx = await appContext();
  const captured: { options: RpcOptions | null } = { options: null };
  createRpcBinding({
    defineRPC: (options) => {
      captured.options = options;
      return { defined: true };
    },
    send: () => {},
    ctx,
  });
  const options = captured.options;
  if (options === null) throw new Error("createRpcBinding must call defineRPC synchronously");

  const requests = options.handlers.requests;
  const request = electrobunRequest(async (name, params) => {
    if (rejectWith !== undefined) throw rejectWith;
    const handler = requests[name];
    if (handler === undefined) throw new Error(`The requested method has no handler: ${name}`);
    return await handler(params as never);
  });
  const handle = { request } as unknown as RpcHandle;

  class FakeElectroview {
    rpc?: RpcHandle;
    constructor(init: { rpc?: RpcHandle }) {
      this.rpc = init.rpc;
    }
    static defineRPC(): RpcHandle {
      return handle;
    }
  }
  return createRpcTransport({ Electroview: FakeElectroview });
}

/** Whatever the page's transport rejected with. Fails the test if it resolved. */
async function refusalAtThePage(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (e) {
    return e;
  }
  throw new Error("expected a refusal; the request resolved");
}

describe("what the app actually throws", () => {
  /**
   * The mutation this holds: drop the three assignments in `RpcRefusal`'s
   * constructor and the refusal carries its code only under `body`. The
   * end-to-end tests below stay green — the page reads both shapes on purpose —
   * so this is the assertion that fails, and it is the one that matters:
   * `body`-only was the shape that reached the page as a bare `RPC_FAILED`
   * before the transport learned to look there.
   */
  test("a refusal carries code, message and op_id as own properties", async () => {
    const ctx = await appContext();
    const captured: { options: RpcOptions | null } = { options: null };
    createRpcBinding({
      defineRPC: (options) => {
        captured.options = options;
        return { defined: true };
      },
      send: () => {},
      ctx,
    });
    const requests = captured.options?.handlers.requests;
    if (requests === undefined) throw new Error("no request table");
    const use = requests["fleets.use"];
    if (use === undefined) throw new Error("no `fleets.use` handler");

    const thrown = await Promise.resolve(use({ fleet: "zzzzzzzz" } as never)).catch(
      (e: unknown) => e as Record<string, unknown>,
    );
    expect(Object.hasOwn(thrown as object, "code")).toBe(true);
    expect(Object.hasOwn(thrown as object, "message")).toBe(true);
    expect((thrown as { code?: unknown }).code).toBe("NOT_FOUND");

    const { refusal } = refusalFor(new InitInFlightError("op-42"));
    expect(Object.hasOwn(refusal, "op_id")).toBe(true);
    expect(refusal.op_id).toBe("op-42");
  });
});

describe("a HermeticError from a handler", () => {
  test("reaches the page as an ApiError carrying core's own code", async () => {
    // The mutation this holds: move `code` back inside `body` alone and the
    // page reports `RPC_FAILED`, which is what every code-branching component
    // — NOT_INITIALIZED, FLEET_MISMATCH, NAME_TAKEN — reads instead of its
    // own branch.
    const page = await pageOverApp();
    const thrown = await refusalAtThePage(page.request("fleets.use", { fleet: "zzzzzzzz" }));
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).code).toBe("NOT_FOUND");
  });

  test("keeps the message core wrote for the operator", async () => {
    const page = await pageOverApp();
    const thrown = (await refusalAtThePage(
      page.request("fleets.use", { fleet: "zzzzzzzz" }),
    )) as ApiError;
    expect(thrown.message).not.toBe("");
    expect(thrown.message).toContain("zzzzzzzz");
  });
});

describe("an in-flight init", () => {
  test("carries its op id across the seam, so the wizard can follow it", async () => {
    // `op_id` is a sibling of the error over HTTP and an own property over the
    // bridge; either way the wizard shows the running init instead of a dead
    // end. Built by `refusalFor`, because a second concurrent `init` is not
    // something the fixture fleet can be asked for from here.
    const { refusal } = refusalFor(new InitInFlightError("op-42"));
    const page = await pageOverApp(refusal);
    const thrown = (await refusalAtThePage(page.request("init", {}))) as ApiError;
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown.code).toBe("CONFLICT");
    expect(thrown.opId).toBe("op-42");
  });
});

describe("a validation refusal", () => {
  test("arrives with the issues a form can point at", async () => {
    const page = await pageOverApp();
    const thrown = (await refusalAtThePage(page.request("fleets.use", {}))) as ApiError;
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown.details).toHaveProperty("issues");
  });
});

/**
 * The files refusals a composer chip renders. Each must reach
 * the page as an `ApiError` with the box's code and a sentence an operator can
 * act on — never the file's name, which may be sensitive.
 */
describe("a files refusal", () => {
  const NAME = "FIXTURE-salary-review.xlsx";
  /**
   * The page's `RequestName` union is the UI's to extend when the composer
   * learns these requests; until then the names are passed through untyped.
   * The transport forwards an unmapped name as it is, which is what these
   * requests are called on the bridge.
   */
  const bridge = (name: string): never => name as never;

  test("an oversize text secret is refused without repeating its name", async () => {
    const page = await pageOverApp();
    const thrown = (await refusalAtThePage(
      page.request(bridge("files.secretText.upload"), {
        name: NAME,
        data_b64: "A".repeat(90_000),
      }),
    )) as ApiError;
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown.code).toBe("VALIDATION");
    expect(thrown.message).not.toContain(NAME);
  });

  test("a page that names a laptop path is refused before anything reads it", async () => {
    const page = await pageOverApp();
    const thrown = (await refusalAtThePage(
      page.request(bridge("files.stage"), {
        instance: "atlas",
        source: { path: "/etc/hosts" },
      } as never),
    )) as ApiError;
    expect(thrown.code).toBe("UNSUPPORTED");
  });

  const fromBox: Array<[number, string, string]> = [
    [413, "FILE_TOO_LARGE", "size limit"],
    [507, "DISK_FULL", "low on disk space"],
    [410, "FILE_REQUEST_EXPIRED", "has expired"],
  ];
  for (const [status, code, words] of fromBox) {
    test(`hermeticd's ${status} reaches the page as ${code}, readable`, async () => {
      const box = new Response(JSON.stringify({ error: { code, message: `refused ${NAME}` } }), {
        status,
      });
      const { refusal } = refusalFor(await filesErrorFrom(box, "atlas", NAME));
      const page = await pageOverApp(refusal);
      const thrown = (await refusalAtThePage(
        page.request(bridge("files.discard"), { instance: "atlas", id: "f_aaaaaaaaaaaa" }),
      )) as ApiError;
      expect(thrown).toBeInstanceOf(ApiError);
      expect(thrown.code).toBe(code);
      expect(thrown.message).toContain(words);
      expect(thrown.message).toContain("atlas");
      expect(thrown.message).not.toContain(NAME);
    });
  }
});
