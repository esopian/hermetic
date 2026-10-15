import { agentParamPath } from "../backend/constants.ts";
import type { CoreContext } from "../context.ts";
import { HermeticError } from "../errors.ts";
import { evt } from "../events.ts";
import {
  type FileEntry,
  FilesRmInput,
  type FilesListResult,
  type FilesRmPlanFile,
  type OpEvent,
  type Plan,
  type PlanStep,
} from "../schema/index.ts";
import { isEnvSecretSlot, isFileSecretSlot } from "../shared/files.ts";
import { validateName } from "../shared/naming.ts";
import { filesRefusal } from "./errors.ts";

/**
 * `files.rm` (§9): remove one entry from an agent's box — an inbox file, an
 * outbox share or a stored secret — planned first and executed by `apply`
 * (§3.2 rule 3), because a durable secret's removal also deletes its SSM slot
 * (`file-<slug>`/`env-<slug>`), which nothing can put back.
 *
 * The plan names the entry, its class and, for a durable secret, the exact SSM
 * parameter it deletes. Its typed `options.file` is what `apply` holds the box
 * to: the same id, directory, class, bytes (`sha256`) and slot, or `PLAN_STALE`.
 * The SSM slot goes first. If that deletion fails, the box entry remains as a
 * visible retry record; if the box deletion fails, a retry can remove its
 * entry because deleting an already absent SSM parameter succeeds.
 *
 * Op events and error messages never name the file, nor the slot (a slug of
 * the file's name); only the plan's steps, which the operator reads before
 * confirming, and an error's details do.
 */

export interface RmDeps {
  ctx: CoreContext;
}

function parseInput(input: unknown): FilesRmInput {
  const result = FilesRmInput.safeParse(input);
  if (result.success) return result.data;
  throw new HermeticError("VALIDATION", "files rm input does not validate", {
    issues: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  });
}

/** A slot the SSM step may delete: an agent's own `file-<slug>` or `env-<slug>`, nothing else. */
function isDurableSlot(slot: string | undefined): slot is string {
  return slot !== undefined && (isFileSecretSlot(slot) || isEnvSecretSlot(slot));
}

function findEntry(listing: FilesListResult, id: string): FileEntry | undefined {
  return [...listing.inbox, ...listing.outbox, ...listing.secrets].find((e) => e.id === id);
}

function entryKind(entry: FileEntry): string {
  switch (entry.dir) {
    case "outbox":
      return "shared file";
    case "secret":
      return entry.slot && isEnvSecretSlot(entry.slot) ? "stored text secret" : "stored secret file";
    case "inbox":
      return entry.class === "image" ? "inbox image" : "inbox file";
    default:
      return `${entry.dir} file`;
  }
}

export function createFilesRm(deps: RmDeps) {
  const { ctx } = deps;

  /**
   * `files.rm`: the plan. A read — the box's listing and nothing else — so a
   * head can show it as freely as any other plan.
   */
  async function rm(input: unknown, opts: { signal?: AbortSignal } = {}): Promise<Plan> {
    const parsed = parseInput(input);
    validateName(parsed.name);
    const agent = parsed.name;
    await ctx.guardFleet();
    await ctx.getAgent(agent);
    const listing = await ctx.backend.files.list(agent, opts);
    const entry = findEntry(listing, parsed.id);
    if (entry === undefined) throw filesRefusal("FILE_NOT_FOUND", agent);

    const slot = entry.dir === "secret" && isDurableSlot(entry.slot) ? entry.slot : undefined;
    const file: FilesRmPlanFile = {
      id: entry.id,
      dir: entry.dir,
      class: entry.class,
      sha256: entry.sha256,
      ...(slot ? { slot } : {}),
    };
    const steps: PlanStep[] = [
      {
        id: "box",
        description: `delete the ${entryKind(entry)} ${entry.name} (${entry.id}) from ${agent}'s box`,
        destructive: true,
      },
    ];
    const warnings: string[] = [];
    if (slot !== undefined) {
      steps.unshift({
        id: "ssm",
        description: `delete the SSM parameter ${agentParamPath(ctx.fleetId(), agent, slot)}`,
        destructive: true,
      });
      warnings.push(
        `${agent} loses this secret now and at every later boot; it has to ask for it again`,
      );
    } else if (entry.dir === "secret") {
      warnings.push("this secret has no SSM slot recorded; only the box's copy is deleted");
    }
    const config = ctx.requireConfig();
    return {
      kind: "files-rm",
      target: agent,
      options: { file },
      steps,
      warnings,
      summary: {
        account_id: config.account_id,
        region: config.region,
        fleet_id: config.fleet_id,
        stack_id: null,
      },
    };
  }

  /**
   * Execute a `files-rm` plan (`plan-apply.ts`). The box is read again first:
   * an entry that moved, changed class, holds other bytes or names another slot
   * is not the one the operator approved.
   */
  async function* applyRm(plan: Plan, opts: { signal?: AbortSignal } = {}): AsyncIterable<OpEvent> {
    const agent = validateName(plan.target);
    const file = plan.options.file;
    if (file === undefined) {
      throw new HermeticError("PLAN_STALE", "this files rm plan does not say which entry it removes", {
        kind: plan.kind,
        target: plan.target,
      });
    }
    if (file.slot !== undefined && !isDurableSlot(file.slot)) {
      throw new HermeticError(
        "VALIDATION",
        `${agent}: a files rm plan may only delete a file-* or env-* slot`,
        {
          name: agent,
        },
      );
    }
    await ctx.guardFleet();
    await ctx.getAgent(agent);
    const at = ctx.nowIso;
    yield evt("check", 0.1, `re-reading ${agent}'s files`, at(), undefined, "start");
    const listing = await ctx.backend.files.list(agent, opts);
    const entry = findEntry(listing, file.id);
    const slotNow = entry?.dir === "secret" && isDurableSlot(entry.slot) ? entry.slot : undefined;
    if (
      entry === undefined ||
      entry.dir !== file.dir ||
      entry.class !== file.class ||
      entry.sha256 !== file.sha256 ||
      slotNow !== file.slot
    ) {
      throw new HermeticError(
        "PLAN_STALE",
        `${agent}: the entry this plan removes has changed or is gone; plan it again`,
        { name: agent, id: file.id },
      );
    }
    yield evt("check", 0.2, "the entry is the one planned", at(), undefined, "done");

    if (file.slot !== undefined) {
      const path = agentParamPath(ctx.fleetId(), agent, file.slot);
      yield evt("ssm", 0.3, "deleting the secret's SSM slot", at(), undefined, "start");
      try {
        await ctx.backend.secrets.delete(path);
      } catch (e) {
        throw new HermeticError(
          e instanceof HermeticError ? e.code : "INTERNAL",
          `${agent}: the SSM parameter could not be deleted; the box entry remains, so plan its deletion again`,
          { name: agent, id: file.id, ssm_slot: file.slot, ssm_path: path },
        );
      }
      yield evt("ssm", 0.6, "deleted the secret's SSM slot", at(), undefined, "done");
    }

    yield evt(
      "box",
      file.slot === undefined ? 0.3 : 0.7,
      `deleting ${file.id} from ${agent}'s box`,
      at(),
      undefined,
      "start",
    );
    try {
      await ctx.backend.files.remove(agent, file.id, opts);
    } catch (e) {
      if (file.slot === undefined) throw e;
      throw new HermeticError(
        e instanceof HermeticError ? e.code : "INTERNAL",
        `${agent}: the SSM parameter was deleted, but the box entry remains; plan its deletion again`,
        { name: agent, id: file.id, ssm_slot: file.slot },
      );
    }
    yield evt("box", 1, `deleted ${file.id}`, at(), undefined, "done");
  }

  return { rm, applyRm };
}
