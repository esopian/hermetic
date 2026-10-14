/**
 * `hermetic files …` — files on an agent's box (§9).
 *
 * `files stage` uploads one file to the box's stage area, where a chat turn
 * can attach it by id. `files put` answers a request the agent opened
 * (`request_file`/`request_secret`) with a file or a text secret, and
 * `files decline` says no to one. `files ls` lists what is on a box,
 * `files get` downloads one file (never a secret) and `files rm` removes one
 * entry — planned and confirmed first, because a durable secret's SSM slot
 * goes with it.
 *
 * The file's path and name are positional arguments, and the run log records
 * a command's arguments and output — so `run-log.ts` redacts both for the
 * file commands: a file's name can be as sensitive as its contents. A text
 * secret is read from stdin (`--secret-stdin`), never a flag, and handed to
 * core as an upload id, never an input field.
 */
import { basename, resolve } from "node:path";
import type { Command } from "commander";
import { Command as Cmd, Option } from "commander";
import {
  FilesDeclineInput,
  FilesGetInput,
  FilesListInput,
  FilesPutInput,
  FilesRmInput,
  FilesStageInput,
  HermeticError,
} from "@hermetic/core";
import type {
  FileEntry,
  FileRequest,
  FilesGetEvent,
  FilesListResult,
  FilesPutEvent,
  FilesStageResult,
} from "@hermetic/core";
import { assertConfirmable, confirmPlan } from "../confirm.ts";
import { renderOp } from "../stream.ts";
import { renderTable } from "../table.ts";
import { openCtx } from "../context.ts";
import type { Ctx } from "../context.ts";
import { redactRunOutput } from "../run-log.ts";
import { declare } from "../declare.ts";
import { err, isInteractive, out } from "../io.ts";
import { destructive, globals } from "../options.ts";
import { readSecretText } from "../secret.ts";
import { ValidationFailure, defined, validate } from "../validate.ts";

const stageSchema = declare("files.stage", "files stage", FilesStageInput);
const putSchema = declare("files.put", "files put", FilesPutInput);
const declineSchema = declare("files.decline", "files decline", FilesDeclineInput);
const listSchema = declare("files.list", "files ls", FilesListInput);
const getSchema = declare("files.get", "files get", FilesGetInput);
const rmSchema = declare("files.rm", "files rm", FilesRmInput);

/** The part of core's upload registry `--secret-stdin` uses. */
interface HeldUploads {
  registerBytes(
    name: string,
    bytes: Uint8Array,
    opts?: { secretText?: boolean },
  ): { upload_id: string };
}

/**
 * `--secret-stdin`'s text, held in core's upload registry and marked as a text
 * secret, so core answers only a `request_secret` with it and refuses a file
 * request (which would store every answer under one name, `stdin`). The
 * encoded copy is zeroed once the registry has its own.
 */
export function holdStdinSecret(uploads: HeldUploads, text: string): string {
  const bytes = new TextEncoder().encode(text);
  try {
    return uploads.registerBytes("stdin", bytes, { secretText: true }).upload_id;
  } finally {
    bytes.fill(0);
  }
}

/** `--as raw|env` as the parser names it. */
const AS_FLAG: Readonly<Record<string, "raw" | "dotenv">> = { raw: "raw", env: "dotenv" };

/**
 * `files put`'s flags as `FilesPutInput` fields: what the action spreads into
 * the input it validates against core's own schema, with a flag not given left
 * out rather than sent as `false`.
 */
export function putFlags(opts: Record<string, unknown>): Partial<FilesPutInput> {
  return defined({
    secret: opts["secret"] === true || opts["secretStdin"] === true ? true : undefined,
    ephemeral: opts["ephemeral"] === true ? true : undefined,
    not_secret: opts["notSecret"] === true ? true : undefined,
    replace: opts["replace"] === true ? true : undefined,
    as: typeof opts["as"] === "string" ? AS_FLAG[opts["as"]] : undefined,
  });
}

/**
 * The closing lines of a put, in plain English (§8.7). A text secret reports
 * its key names and format and never a value; a durable secret names its SSM
 * slot; a file names itself, which is why the run's output is not recorded.
 */
export function putLines(e: Extract<FilesPutEvent, { type: "fulfilled" }>): string[] {
  const r = e.result;
  const lines: string[] = [];
  if (r.keys !== undefined) {
    const keys = r.keys.map((k) => `${k} ✓`).join(" ");
    lines.push(
      `  ${r.format ?? "dotenv"} · ${r.keys.length} key${r.keys.length === 1 ? "" : "s"}: ${keys} (value not shown)`,
    );
  }
  if (e.ssm_slot !== undefined) {
    lines.push(`✓ stored in SSM slot ${e.ssm_slot} · materialised to ${r.path}`);
  } else if (r.class === "secret") {
    lines.push(`✓ delivered for this once to ${r.path} · contents never shown`);
  } else {
    lines.push(`✓ delivered ${basename(r.path)} · ${size(r.bytes)} · sha256 ${r.sha256.slice(0, 12)}`);
  }
  return lines;
}

/**
 * Core's refusal of a put onto a stored durable secret asks "Replace it?" in
 * head-neutral words; the CLI's way to say yes is `--replace`, so it adds
 * that. Every other error passes through untouched.
 */
export function putRefusal(e: unknown): unknown {
  if (!(e instanceof HermeticError) || e.details?.["replace_required"] !== true) return e;
  return new HermeticError(e.code, `${e.message} Re-run with --replace to overwrite it.`, e.details);
}

/** One line for a declined request. The purpose is the agent's text, quoted as data. */
export function declineLine(agent: string, r: FileRequest): string {
  return `✓ declined ${r.request_id} · ${agent} was told`;
}

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** How long until `iso`, from `now`: `23h`, `6d`, `expired`, or `-` for never. */
export function expiresIn(iso: string | null, now: number): string {
  if (iso === null) return "-";
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return "?";
  if (ms <= 0) return "expired";
  const m = Math.round(ms / 60_000);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** At most `n` characters on one line: the agent's text, quoted as data. */
function clip(text: string, n: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= n ? line : `${line.slice(0, n - 1)}…`;
}

function entryRow(e: FileEntry, now: number): string[] {
  const kind = e.dir === "secret" ? (e.slot ?? "secret") : e.class;
  return [e.id, e.dir, kind, size(e.bytes), expiresIn(e.expires_at, now), e.name];
}

/** The open request slots: what the agent is waiting for, and how long it will wait. */
export function renderFileRequests(requests: readonly FileRequest[], now: number): string {
  if (requests.length === 0) return "no open requests";
  return renderTable(
    requests.map((r) => [
      r.request_id,
      r.kind === "secret_text" ? "secret text" : `file/${r.sensitivity}`,
      expiresIn(r.expires_at, now),
      clip(r.purpose, 60),
    ]),
    ["REQUEST", "KIND", "EXPIRES", "PURPOSE"],
  );
}

/** `files ls`: the entries, then the open requests, then the box's usage. */
export function renderFilesList(result: FilesListResult, now: number): string {
  const entries = [...result.inbox, ...result.outbox, ...result.secrets];
  const open = result.requests.filter((r) => r.state === "open");
  const parts = [
    entries.length === 0
      ? "no files"
      : renderTable(
          entries.map((e) => entryRow(e, now)),
          ["ID", "WHERE", "KIND", "SIZE", "EXPIRES", "NAME"],
        ),
  ];
  if (open.length > 0) parts.push(`\nopen requests:\n${renderFileRequests(open, now)}`);
  const u = result.usage;
  parts.push(
    `\ninbox ${size(u.inbox_bytes)} · outbox ${size(u.outbox_bytes)} · inbox kept ${u.retention_days}d` +
      (u.disk_used_pct === undefined ? "" : ` · disk ${Math.round(u.disk_used_pct)}% used`),
  );
  return parts.join("\n");
}

function pct(progress: number): string {
  return `${String(Math.round(progress * 100)).padStart(3, " ")}%`;
}

/**
 * Stage one file for a chat turn's `--attach`, and answer its id.
 *
 * The `staged …` line goes to stderr, so `chat --json` keeps stdout to the
 * turn's frames; and the run's recorded output is dropped (`redactRunOutput`),
 * because the line names the file.
 */
export async function stageForTurn(
  ctx: Ctx,
  file: { instance: string; path: string; notSecret: boolean; session?: string | undefined },
): Promise<string> {
  redactRunOutput();
  const input = validate(stageSchema, {
    instance: file.instance,
    source: { path: resolve(file.path) },
    ...defined({
      not_secret: file.notSecret ? true : undefined,
      session: file.session,
    }),
  });
  let staged: FilesStageResult | null = null;
  for await (const e of ctx.hermetic.files.stage(input, { signal: ctx.signal })) {
    if (e.type === "staged") staged = e.file;
  }
  if (staged === null) {
    throw new HermeticError("INTERNAL", "the stage ended without the box's answer");
  }
  await err(`staged ${staged.name} ${size(staged.bytes)} sha256 ${staged.sha256.slice(0, 12)}\n`);
  return staged.id;
}

export function register(program: Command): void {
  const files = new Cmd("files").description(
    "files on an agent's box: stage one for a chat turn, or answer the agent's request",
  );

  files.addCommand(
    globals(new Cmd("stage"))
      .description("upload a file to an agent's stage area, for a chat turn to attach by id")
      .argument("<agent>", "the agent whose box receives the file")
      .argument("<path>", "the file on this laptop")
      .option("--name <name>", "the name to store it under (default: the file's own)")
      .option("--not-secret", "send a file that looks like a private key as a normal file")
      .option("--session <id>", "the chat session the file is for")
      .addHelpText(
        "after",
        "\nImages up to 25 MB, other files up to 256 MB. A staged file is deleted after an\n" +
          "hour unless a chat turn commits it to the agent's inbox.\n",
      )
      .action(async (agent: string, path: string, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(stageSchema, {
          instance: agent,
          source: { path: resolve(path) },
          ...defined({
            name: opts["name"] as string | undefined,
            not_secret: opts["notSecret"] === true ? true : undefined,
            session: opts["session"] as string | undefined,
          }),
        });
        const interactive = !ctx.flags.json && isInteractive();
        let staged: FilesStageResult | null = null;
        let lastTenth = -1;
        for await (const e of ctx.hermetic.files.stage(input, { signal: ctx.signal })) {
          if (ctx.flags.json) {
            await out(`${JSON.stringify(e)}\n`);
            if (e.type === "staged") staged = e.file;
            continue;
          }
          if (e.type === "staged") {
            staged = e.file;
            continue;
          }
          const text = `${pct(e.progress)} ${e.phase.padEnd(7, " ")} ${e.message}`;
          if (interactive) {
            await err(`\r${text}\u001b[K`);
          } else {
            // A pipe gets a line per tenth, not one per percent.
            const tenth = Math.floor(e.progress * 10);
            if (tenth !== lastTenth) {
              lastTenth = tenth;
              await err(`${text}\n`);
            }
          }
        }
        if (interactive) await err("\n");
        if (staged === null) {
          throw new HermeticError("INTERNAL", "the stage ended without the box's answer");
        }
        if (ctx.flags.json) return;
        await out(
          `staged ${staged.name} ${size(staged.bytes)} sha256 ${staged.sha256.slice(0, 12)} id ${staged.id}\n`,
        );
      }),
  );

  files.addCommand(
    globals(new Cmd("put"))
      .description("answer an agent's file or secret request")
      .argument("<agent>", "the agent that asked")
      .argument("[path]", "the file on this laptop (omit with --secret-stdin)")
      .requiredOption("--request <id>", "the request to answer (fr_…)")
      .option("--secret", "store the file as a secret (SSM) even if the request did not ask")
      .option("--ephemeral", "a secret for this once: the box's memory for an hour, never SSM")
      .option("--not-secret", "send a file that looks like a private key as a normal file")
      .option("--replace", "replace the secret the request's SSM slot already holds")
      .option("--secret-stdin", "read a text secret (a token, KEY=value lines, a PEM) from stdin")
      .addOption(
        new Option("--as <format>", "read the secret as one raw value or as .env lines").choices([
          "raw",
          "env",
        ]),
      )
      .addHelpText(
        "after",
        "\nA secret is never accepted as a flag value: pipe it, e.g.\n" +
          "  pbpaste | hermetic files put sindri --request fr_… --secret-stdin\n",
      )
      .action(
        async (
          agent: string,
          path: string | undefined,
          opts: Record<string, unknown>,
          cmd: Command,
        ) => {
          const fromStdin = opts["secretStdin"] === true;
          if (fromStdin && path !== undefined) {
            throw new ValidationFailure([
              { path: "source", message: "give a path or --secret-stdin, not both" },
            ]);
          }
          if (!fromStdin && path === undefined) {
            throw new ValidationFailure([
              { path: "source", message: "give the file's path, or --secret-stdin for a text secret" },
            ]);
          }
          const ctx = await openCtx(cmd);
          const common = putFlags(opts);
          let source: { path: string } | { chunk_upload_id: string };
          if (fromStdin) {
            const text = await readSecretText(`secret for ${agent}`);
            source = {
              chunk_upload_id: holdStdinSecret(ctx.hermetic.files.internal.uploads, text),
            };
          } else {
            source = { path: resolve(path as string) };
          }
          const input = validate(putSchema, {
            instance: agent,
            request_id: opts["request"],
            source,
            ...common,
          });
          const interactive = !ctx.flags.json && isInteractive();
          let done: Extract<FilesPutEvent, { type: "fulfilled" }> | null = null;
          let lastTenth = -1;
          try {
            for await (const e of ctx.hermetic.files.put(input, { signal: ctx.signal })) {
              if (e.type === "fulfilled") done = e;
              if (ctx.flags.json) {
                await out(`${JSON.stringify(e)}\n`);
                continue;
              }
              if (e.type === "fulfilled") continue;
              const text = `${pct(e.progress)} ${e.phase.padEnd(7, " ")} ${e.message}`;
              if (interactive) {
                await err(`\r${text}\u001b[K`);
              } else {
                const tenth = Math.floor(e.progress * 10);
                if (tenth !== lastTenth) {
                  lastTenth = tenth;
                  await err(`${text}\n`);
                }
              }
            }
          } catch (e) {
            throw putRefusal(e);
          }
          if (interactive) await err("\n");
          if (done === null)
            throw new HermeticError("INTERNAL", "the put ended without the box's answer");
          if (ctx.flags.json) return;
          for (const line of putLines(done)) await out(`${line}\n`);
        },
      ),
  );

  files.addCommand(
    globals(new Cmd("decline"))
      .description("say no to an agent's file or secret request; the agent is told")
      .argument("<agent>", "the agent that asked")
      .argument("<request>", "the request to decline (fr_…)")
      .option("--reason <text>", "a short reason the agent is shown")
      .action(async (agent: string, request: string, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(declineSchema, {
          instance: agent,
          request_id: request,
          ...defined({ reason: opts["reason"] as string | undefined }),
        });
        const declined = await ctx.hermetic.files.decline(input, { signal: ctx.signal });
        if (ctx.flags.json) {
          await out(`${JSON.stringify(declined)}\n`);
          return;
        }
        await out(`${declineLine(agent, declined)}\n`);
      }),
  );

  files.addCommand(
    globals(new Cmd("ls"))
      .description("what is on an agent's box: inbox, shared files, stored secrets, open requests")
      .argument("<agent>", "the agent whose box to list")
      .option("--requests", "only the requests still waiting for a file or a secret")
      .action(async (agent: string, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        // The table names files; the run log keeps none of it.
        redactRunOutput();
        const requestsOnly = opts["requests"] === true;
        const input = validate(listSchema, {
          name: agent,
          ...defined({ requests: requestsOnly ? true : undefined }),
        });
        const result = await ctx.hermetic.files.list(input, { signal: ctx.signal });
        if (ctx.flags.json) {
          await out(`${JSON.stringify(requestsOnly ? result.requests : result)}\n`);
          return;
        }
        const now = Date.now();
        await out(
          `${requestsOnly ? renderFileRequests(result.requests, now) : renderFilesList(result, now)}\n`,
        );
      }),
  );

  files.addCommand(
    globals(new Cmd("get"))
      .description("download one file the agent received or shared; secrets never leave the box")
      .argument("<agent>", "the agent whose box holds the file")
      .argument("<id>", "the file (f_…) or share (sh_…) to download")
      .requiredOption("-o, --output <path>", "where to write it; an existing file is never overwritten")
      .action(async (agent: string, id: string, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const output = opts["output"];
        if (typeof output !== "string" || output === "") {
          throw new ValidationFailure([{ path: "dest", message: "give -o <path>" }]);
        }
        const input = validate(getSchema, { name: agent, id, dest: { path: resolve(output) } });
        const interactive = !ctx.flags.json && isInteractive();
        let saved: Extract<FilesGetEvent, { type: "saved" }> | null = null;
        for await (const e of ctx.hermetic.files.get(input, { signal: ctx.signal })) {
          if (e.type === "saved") saved = e;
          if (ctx.flags.json) {
            await out(`${JSON.stringify(e)}\n`);
            continue;
          }
          if (e.type === "saved") continue;
          const text = `${pct(e.progress)} ${e.phase.padEnd(7, " ")} ${e.message}`;
          await err(interactive ? `\r${text}\u001b[K` : `${text}\n`);
        }
        if (interactive) await err("\n");
        if (saved === null) throw new HermeticError("INTERNAL", "the get ended without the file");
        if (ctx.flags.json) return;
        const f = saved.file;
        await out(`saved ${f.name} ${size(f.bytes)} sha256 ${f.sha256.slice(0, 12)} to ${output}\n`);
      }),
  );

  files.addCommand(
    destructive(new Cmd("rm"))
      .description("remove one file, share or stored secret from an agent's box")
      .argument("<agent>", "the agent whose box holds it")
      .argument("<id>", "the file (f_…) or share (sh_…) to remove")
      .addHelpText(
        "after",
        "\nA stored secret's SSM slot (file-<slug>/env-<slug>) is deleted with it; the agent\n" +
          "has to ask for the secret again. The plan names the slot before you confirm.\n",
      )
      .action(async (agent: string, id: string, _opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        // The plan names the file; the run log keeps none of it.
        redactRunOutput();
        assertConfirmable(ctx, `remove ${id} from ${agent}?`);
        const plan = await ctx.hermetic.files.rm(validate(rmSchema, { name: agent, id }), {
          signal: ctx.signal,
        });
        await confirmPlan(ctx, plan, `remove ${id} from ${agent}?`);
        await renderOp(ctx.hermetic.apply({ plan, yes: true }, { signal: ctx.signal }), {
          flags: ctx.flags,
          label: `files rm ${agent} ${id}`,
        });
      }),
  );

  program.addCommand(files);
}
