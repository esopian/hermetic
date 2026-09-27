/**
 * A fake `rpc.request` with Electrobun's real shape.
 *
 * `createRPC` (devkit `api/shared/rpc.ts`) returns `request` as a proxy over
 * the request *function*: `request(name, params)` sends, and `request.<name>`
 * sends too — except for any name the function already has (`apply`, `call`,
 * `bind`, `name`, `length`, …), which the proxy answers with the function's own
 * property. A fake built on `{}` hides that, which is how `request["apply"]`
 * shipped resolving to `Function.prototype.apply` and sending a request with no
 * method. Every bridge fake builds its `request` here, so a transport that
 * reaches for the property form fails in tests the way it fails in the app.
 */
import type { RpcHandle } from "../src/api/transport-rpc.ts";

export function electrobunRequest(
  ask: (name: string, params: unknown) => Promise<unknown>,
): RpcHandle["request"] {
  const requestFn = (name: string, params: unknown): Promise<unknown> => ask(name, params);
  return new Proxy(requestFn, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver) as unknown;
      return (params: unknown) => requestFn(String(prop), params);
    },
  }) as unknown as RpcHandle["request"];
}
