/**
 * The bridge's HTTP routes (`MOBILE_ROUTES`), minus the WebSocket upgrade the
 * server does itself.
 *
 * Every request carries `X-Hermetic-Mobile: 1` or is refused 426; every body is
 * capped at `MAX_PAYLOAD_BYTES`; every route but `health` and `pair` wants a
 * device token paired for the fleet this bridge serves (else 403 `WRONG_FLEET`).
 * Errors are `{code, message, details?}` — wrapped as
 * `{ok:false, error}` on `rpc`, whose success body is `{ok:true, result}`.
 */
import { HermeticError } from "../errors.ts";
import {
  MobilePairRequest,
  MobilePushRegisterRequest,
  MobilePushSettingsRequest,
  MobileRpcRequest,
} from "../schema/index.ts";
import type { ZodType } from "zod";
import {
  type BridgeCtx,
  buildHello,
  guardDeviceFleet,
  guardFleet,
  serving,
  wireError,
} from "./bridge-ctx.ts";
import { forwardRpc } from "./core.ts";
import type { MobileDeviceRow } from "./device-store.ts";
import { bearerOf, redeemPairCode, verifyToken } from "./pairing.ts";
import { MOBILE_PROTOCOL, MOBILE_ROUTES } from "./protocol.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function fail(e: unknown, wrap = false): Response {
  const { status, body } = wireError(e);
  return json(wrap ? { ok: false, error: body } : body, status);
}

async function readBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const text = await req.text();
  if (text.length > MOBILE_PROTOCOL.MAX_PAYLOAD_BYTES) {
    throw new HermeticError("PAYLOAD_TOO_LARGE", "request body too large");
  }
  let value: unknown;
  try {
    value = text === "" ? {} : JSON.parse(text);
  } catch {
    throw new HermeticError("VALIDATION", "request body is not JSON");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new HermeticError("VALIDATION", "request body does not validate", { issues });
  }
  return parsed.data;
}

function authenticate(ctx: BridgeCtx, req: Request): MobileDeviceRow {
  const token = bearerOf(req.headers.get("authorization"));
  const device = verifyToken(ctx.store, token ?? "");
  if (device === null) throw new HermeticError("UNAUTHORIZED", "unknown or revoked device token");
  // A phone paired for another fleet is refused before anything is read or
  // written for it; no SDK to ask at all is 503, not a 500.
  guardDeviceFleet(serving(ctx), device);
  ctx.store.touch(device.device_id, new Date(ctx.clock()).toISOString());
  return device;
}

/**
 * The answer to one HTTP request that is not a WebSocket upgrade. `untimed`
 * lifts the server's idle timeout off this request; it is called only once the
 * request has authenticated and is about to wait on core.
 */
export async function handleHttp(
  ctx: BridgeCtx,
  req: Request,
  source: string,
  untimed: () => void = () => {},
): Promise<Response> {
  const url = new URL(req.url);
  const route = `${req.method} ${url.pathname}`;
  const isRpc = url.pathname === MOBILE_ROUTES.rpc;
  try {
    const version = req.headers.get(MOBILE_PROTOCOL.VERSION_HEADER);
    if (version !== String(MOBILE_PROTOCOL.PROTOCOL_VERSION)) {
      throw new HermeticError("PROTOCOL_MISMATCH", "this bridge speaks mobile protocol 1", {
        protocol: MOBILE_PROTOCOL.PROTOCOL_VERSION,
      });
    }
    const length = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MOBILE_PROTOCOL.MAX_PAYLOAD_BYTES) {
      throw new HermeticError("PAYLOAD_TOO_LARGE", "request body too large");
    }

    switch (route) {
      case `GET ${MOBILE_ROUTES.health}`:
        return json({ ok: true, protocol: MOBILE_PROTOCOL.PROTOCOL_VERSION, fixture: ctx.fixture });

      case `POST ${MOBILE_ROUTES.pair}`: {
        // The limiter is checked before the body is even read.
        ctx.limiter.check(source, ctx.clock());
        const body = await readBody(req, MobilePairRequest);
        // A bridge with no fleet cannot build the `Hello` a pairing answers
        // with; refusing before the code is spent leaves it for a retry.
        const target = serving(ctx).target;
        if (target === null) {
          throw new HermeticError("NOT_INITIALIZED", "this laptop has no fleet to serve");
        }
        // The pairing is for the fleet served now, and is honoured only while it is.
        const { token, device } = redeemPairCode(ctx.store, body, {
          now: ctx.clock(),
          source,
          limiter: ctx.limiter,
          fleet_id: target.fleet_id,
        });
        ctx.emit({ type: "paired", device_id: device.device_id, name: device.name });
        return json({ token, device_id: device.device_id, hello: await buildHello(ctx, device) });
      }

      case `GET ${MOBILE_ROUTES.hello}`: {
        const device = authenticate(ctx, req);
        return json(await buildHello(ctx, device));
      }

      case `POST ${MOBILE_ROUTES.rpc}`: {
        authenticate(ctx, req);
        untimed();
        const body = await readBody(req, MobileRpcRequest);
        const core = serving(ctx);
        guardFleet(core, body.target);
        const result = await forwardRpc(core, body.method, body.params, req.signal);
        if (body.method === "chat.listen") {
          ctx.broadcast({
            type: "listening",
            instances: (result as { instances: string[] }).instances,
          });
        }
        return json({ ok: true, result });
      }

      case `POST ${MOBILE_ROUTES.pushRegister}`: {
        const device = authenticate(ctx, req);
        const body = await readBody(req, MobilePushRegisterRequest);
        ctx.store.setPush(device.device_id, {
          expo_push_token: body.expo_push_token,
          ...(body.previews !== undefined ? { previews: body.previews } : {}),
        });
        return json({ ok: true });
      }

      case `POST ${MOBILE_ROUTES.pushSettings}`: {
        const device = authenticate(ctx, req);
        const body = await readBody(req, MobilePushSettingsRequest);
        const row = ctx.store.setPush(device.device_id, body) ?? device;
        return json({ ok: true, previews: row.previews, enabled: row.enabled });
      }

      default:
        throw new HermeticError("NOT_FOUND", "no such route");
    }
  } catch (e) {
    return fail(e, isRpc);
  }
}
