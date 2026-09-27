/**
 * The fixture-only control surface (§9.2).
 *
 * ## Why it exists
 *
 * The headline acceptance criterion for continuous observation is that an "external Desktop/CLI/
 * routine message arrives without a two-minute wait". Every other fixture
 * scenario can be written down in a table, because it is something the box
 * already holds; this one cannot, because it is an *event* — something that
 * happens while somebody is watching. `bun run dev:fixture` has no gateway to
 * produce one, so before this module the only place the criterion could be
 * demonstrated was a unit test that assembled the fixture client by hand. The
 * mode the repo tells people to use for UI work and demos could not show the
 * feature working at all, and QA had to verify it structurally.
 *
 * ## What it does *not* do
 *
 * It does not pretend to be upstream. A canned member reply does not exercise a
 * real driver, grant, model, relay or request timeout, and nothing here tries
 * to: an injection appends a `user` row to the fixture box's durable transcript
 * and announces it on the hint streams that are open for that bot. No model is
 * run, no backend is warmed, no reply is produced. What it demonstrates is the
 * *portal's* own behaviour — that an observation notices a row it did not put
 * there, that the row reaches every watching tab once, and that the inbox
 * raises one notification for it — which is exactly the half of that criterion
 * that belongs to this repo.
 *
 * ## Why it cannot reach a real account
 *
 * There are two independent guards and neither is a string comparison against
 * an account id. The first is construction: `createHermetic` builds this object
 * only on the `deps.fixture === true` branch, so a real-mode `Hermetic` has
 * `fixture: null` and there is no method to call. The second is the closure:
 * the only thing these methods can write to is a `FixtureChatActivity`, an
 * in-memory table owned by the fixture chat client. It holds no AWS client, no
 * backend and no config, so there is no reachable state in a real account for
 * it to touch even if one were somehow handed to it. `fixture` being `false`
 * with an activity present — which is only constructible by a test — still
 * refuses, so the guard itself can be asserted rather than argued.
 *
 * It is not in `PUBLIC_METHODS`: it is not a §9 command, it has no CLI verb, and
 * `tests/parity.test.ts` neither knows nor should know about it. A head's
 * request over it belongs in `MACHINERY_RPC` with the rest of the requests that
 * wrap no core method, and must refuse when `hermetic.fixture` is null.
 */
import { HermeticError } from "../../errors.ts";
import type { FixtureChatInjectResult } from "../../schema/index.ts";
import { FixtureChatHintInput, FixtureChatInjectInput } from "../../schema/index.ts";
import { CHAT_ERROR_CODES } from "../../chat/hermes/hermes-chat.ts";
import type { FixtureChatActivity, FixtureChatWhere } from "./fixture-chat.ts";
import { fixtureChatReachable } from "./fixture-chat.ts";

export interface FixtureControlsDeps {
  /**
   * Never inferred from the presence of the store below. Core is explicit about
   * which mode it is in everywhere else (`HermeticDeps.fixture` is passed
   * rather than derived from the backend's type) and this is the one surface
   * where getting it wrong would matter most.
   */
  fixture: boolean;
  activity: FixtureChatActivity;
}

export interface FixtureControls {
  chat: {
    inject(input: unknown): FixtureChatInjectResult;
    hint(input: unknown): { watchers: number };
  };
}

function parse<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: unknown } },
  input: unknown,
  what: string,
): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error;
  const detail =
    issues instanceof Error && issues.message.length > 0 ? issues.message : "invalid input";
  throw new HermeticError("VALIDATION", `${what}: ${detail}`, { input: what });
}

export function createFixtureControls(deps: FixtureControlsDeps): FixtureControls {
  /**
   * The refusal, raised before anything is read off the input.
   *
   * `UNSUPPORTED` rather than `FORBIDDEN`: nothing about this is a permission
   * question. The operation does not exist outside fixture mode, which is what
   * a head should tell whoever asked — the server maps it to a 404 on the
   * machinery route rather than a 403 on a resource that is real.
   */
  const only = (): void => {
    if (deps.fixture !== true) {
      throw new HermeticError(
        "UNSUPPORTED",
        "Fixture controls are available in fixture mode only (--fixture / HERMETIC_FIXTURE=1).",
      );
    }
  };

  /**
   * An unreachable box has no transcript and no hint stream, so staging an
   * arrival on one would be a silent no-op that reads as a broken portal. It
   * refuses with the code the rest of chat uses for the same box, so a head
   * that already renders `CHAT_UNREACHABLE` renders this too.
   */
  const addressable = (instance: string): void => {
    if (!fixtureChatReachable(instance)) {
      throw new HermeticError(
        CHAT_ERROR_CODES.UNREACHABLE,
        `${instance}: fixture box is unreachable, so it holds no conversation to inject into`,
        { instance },
      );
    }
  };

  const whereOf = (input: {
    instance: string;
    bot: string;
    session?: string | undefined;
  }): FixtureChatWhere => ({
    instance: input.instance,
    bot: input.bot,
    ...(input.session !== undefined ? { session: input.session } : {}),
  });

  return {
    chat: {
      inject(input: unknown): FixtureChatInjectResult {
        only();
        const parsed = parse(FixtureChatInjectInput, input, "fixture chat inject");
        addressable(parsed.instance);
        const where = whereOf(parsed);
        // Read before the arrival rather than after: the number wanted is how
        // many streams the message was announced on, and `arrive` is what
        // announces it.
        const watchers = deps.activity.watchers(where);
        const message = deps.activity.arrive(
          where,
          parsed.markdown,
          parsed.id,
          // Off the store's own counter, so this row sorts after everything
          // staged before it and an advance-only inbox watermark moves for it.
          deps.activity.stamp(),
        );
        return { message, watchers };
      },

      hint(input: unknown): { watchers: number } {
        only();
        const parsed = parse(FixtureChatHintInput, input, "fixture chat hint");
        addressable(parsed.instance);
        const where = whereOf(parsed);
        const watchers = deps.activity.watchers(where);
        deps.activity.hint(where);
        return { watchers };
      },
    },
  };
}
