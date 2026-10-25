/**
 * Routines (Hermes cron jobs) on the phone: core's own `/api/cron/jobs`
 * sequence (`routineCalls`, the one the desktop's `routines.*` runs) over the
 * gateway's dashboard REST call, each input checked against core's schema first.
 */
import { HermeticError, routineCalls } from "@hermetic/core/chat-client";
import {
  RoutineCreateInput,
  RoutineDeleteInput,
  RoutineHistoryInput,
  RoutineRunInput,
  RoutinesListInput,
  RoutineUpdateInput,
} from "@hermetic/core/schema";
import type { GatewayOps } from "../gateway/transport.ts";

/** A schema refusal as the `VALIDATION` error the desktop's operation throws. */
function valid<T>(parse: () => T): T {
  try {
    return parse();
  } catch (e) {
    const issues = (e as { issues?: { message: string }[] }).issues;
    throw new HermeticError("VALIDATION", issues ? issues.map((i) => i.message).join("; ") : String(e));
  }
}

export type PhoneRoutines = ReturnType<typeof phoneRoutines>;

export function phoneRoutines(rest: GatewayOps["rest"]) {
  const calls = (instance: string) =>
    routineCalls((method, path, body) =>
      rest({ instance, method, path, ...(body === undefined ? {} : { body }) }),
    );
  return {
    list: (p: RoutinesListInput) => calls(p.instance).list(valid(() => RoutinesListInput.parse(p))),
    create: (p: RoutineCreateInput) =>
      calls(p.instance).create(valid(() => RoutineCreateInput.parse(p))),
    update: (p: RoutineUpdateInput) =>
      calls(p.instance).update(valid(() => RoutineUpdateInput.parse(p))),
    delete: (p: RoutineDeleteInput) =>
      calls(p.instance).delete(valid(() => RoutineDeleteInput.parse(p))),
    run: (p: RoutineRunInput) => calls(p.instance).run(valid(() => RoutineRunInput.parse(p))),
    history: (p: RoutineHistoryInput) =>
      calls(p.instance).history(valid(() => RoutineHistoryInput.parse(p))),
  };
}
