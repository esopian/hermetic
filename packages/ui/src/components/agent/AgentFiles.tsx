/**
 * Agent ▸ Files (attachments plan §8.6): what is on the box, metadata only.
 *
 * The head line is the box's usage; then the requests waiting on the operator
 * — from any session, a cron job's included, which is why this reads the box
 * and not the chat — and one table of inbox files, outbox shares and stored
 * secrets. A request is answered with the chat's own card (`FileRequestBlock`),
 * so the deliver flow — the native pick, the key-material prompt, the secret
 * lane — is the one the chat uses, not a second copy of it. Files save through
 * the chat's own Save… (`useFileSave`: the folder dialog, then the download);
 * a secret is never fetched, only deleted, and a delete goes through
 * `files.rm`'s plan and a confirm that names what goes.
 *
 * The box is read only in the states the requests poller reads it in
 * (`filesServiceUp`); any other state is said, not tried and reported as a
 * read error.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { shortId } from "@hermetic/core/shared";
import { ApiError, applyPlan, followOp } from "../../api/index.ts";
import type { AgentView } from "../../api/index.ts";
import { decline, filesList, filesRm } from "../../api/files.ts";
import type { FileRequestView, FilesList, FilesRmPlan } from "../../api/files.ts";
import { FileRequestBlock } from "../../chat/components/blocks/FileRequest.tsx";
import { countdown, shortSha } from "../../chat/file-request-logic.ts";
import type { RequestToolBlock } from "../../chat/file-request-logic.ts";
import { saveErrorText, useFileSave } from "../../chat/use-file-save.ts";
import { isOff } from "../../logic/format.ts";
import { isStalePlan } from "../../logic/destroy-plan.ts";
import { filesServiceUp, useFileRequestsIfAvailable } from "../../state/file-requests-state.tsx";
import {
  ageLabel,
  filesRows,
  openRequests,
  originLabel,
  requestClass,
  rmConsequence,
  sizeLabel,
  truncatePurpose,
  usageLine,
} from "./files-logic.ts";
import type { FilesRow } from "./files-logic.ts";
import type { FileSaveState } from "../../chat/use-file-save.ts";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Ticks every second while a request counts down, else often enough for the age column. */
const COUNTDOWN_TICK_MS = 1000;
const AGE_TICK_MS = 30_000;

/** A clock ticking every `intervalMs`, or not at all when `null`. */
function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * The block a request card is drawn from. The card reads everything it shows
 * from the box's slot by `request_id`; the rest is the shape of a finished
 * tool call with no result, which offers no "tell the agent" (there is no
 * conversation here to tell it in).
 */
function requestBlock(request_id: string, secret: boolean): RequestToolBlock {
  return {
    kind: "tool",
    name: secret ? "request_secret" : "request_file",
    args: null,
    result: null,
    status: "ok",
    render: secret ? "secret_request" : "file_request",
    request_id,
  } as RequestToolBlock;
}

interface RmState {
  row: FilesRow;
  plan: FilesRmPlan | null;
  error: string | null;
  applying: boolean;
}

export function AgentFiles({ agent }: { agent: AgentView }) {
  const name = agent.name;
  const off = isOff(agent);
  const up = filesServiceUp(agent.display_status);
  const poller = useFileRequestsIfAvailable();
  const [list, setList] = useState<FilesList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [generation, setGeneration] = useState(0);
  /** Requests opened with Deliver…, by id; kept open after the slot closes so the card can say how. */
  const [delivering, setDelivering] = useState<Map<string, boolean>>(() => new Map());
  const [declining, setDeclining] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rm, setRm] = useState<RmState | null>(null);

  const refreshPoller = poller?.refresh;
  const reload = useCallback(() => {
    setGeneration((n) => n + 1);
    refreshPoller?.(name);
  }, [refreshPoller, name]);

  // Read the box on open and again whenever `generation` moves (Refresh, after an action).
  useEffect(() => {
    if (!up) return;
    const controller = new AbortController();
    setLoading(true);
    filesList(name, { signal: controller.signal })
      .then((next) => {
        if (controller.signal.aborted) return;
        setList(next);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [name, up, generation]);

  const open = list ? openRequests(list.requests) : [];
  const now = useNow(!up || list === null ? null : open.length > 0 ? COUNTDOWN_TICK_MS : AGE_TICK_MS);

  if (!up) {
    return (
      <div className="dr-pane fl-pane">
        <div className="dr-say">
          <div className="kicker">Files</div>
          <p>
            <b>The instance is {agent.display_status}.</b>{" "}
            {off
              ? "Files live on the box; start it to see them."
              : "Files live on the box; they show once it is ready."}
          </p>
        </div>
      </div>
    );
  }

  const doDecline = (request_id: string): void => {
    setDeclining(request_id);
    setActionError(null);
    decline(name, request_id)
      .catch((e: unknown) => setActionError(`Could not decline: ${message(e)}`))
      .finally(() => {
        setDeclining(null);
        reload();
      });
  };

  const toggleDeliver = (request: FileRequestView): void => {
    setDelivering((prev) => {
      const next = new Map(prev);
      if (next.has(request.request_id)) next.delete(request.request_id);
      else next.set(request.request_id, requestClass(request) === "secret");
      return next;
    });
  };
  const closeDeliver = (request_id: string): void => {
    setDelivering((prev) => {
      const next = new Map(prev);
      next.delete(request_id);
      return next;
    });
    reload();
  };

  const planRm = (row: FilesRow): void => {
    // One delete at a time: a second row never replaces a delete already applying.
    if (rm?.applying) return;
    setRm({ row, plan: null, error: null, applying: false });
    filesRm(name, row.entry.id)
      .then((plan) => setRm((cur) => (cur?.row.entry.id === row.entry.id ? { ...cur, plan } : cur)))
      .catch((e: unknown) =>
        setRm((cur) => (cur?.row.entry.id === row.entry.id ? { ...cur, error: message(e) } : cur)),
      );
  };
  const applyRm = async (state: RmState): Promise<void> => {
    if (state.plan === null) return;
    setRm({ ...state, applying: true, error: null });
    try {
      const accepted = await applyPlan(state.plan);
      followOp(
        accepted.op_id,
        () => undefined,
        (ok, failure) => {
          if (ok) {
            setRm(null);
          } else {
            setRm({
              ...state,
              applying: false,
              error: failure?.message ?? "the delete did not finish",
            });
          }
          reload();
        },
        { replay: true },
      );
    } catch (e) {
      if (e instanceof ApiError && isStalePlan(e.code)) {
        // The box moved since the plan was read: read a fresh one, armed only for it.
        planRm(state.row);
        reload();
        return;
      }
      setRm({ ...state, applying: false, error: message(e) });
    }
  };

  // A Deliver… card stays up after its slot closes, so the operator reads "delivered" there.
  const shownRequests: { id: string; request: FileRequestView | null }[] = open.map((r) => ({
    id: r.request_id,
    request: r,
  }));
  for (const id of delivering.keys()) {
    if (!open.some((r) => r.request_id === id)) shownRequests.push({ id, request: null });
  }
  const rows = list ? filesRows(list) : [];

  return (
    <div className="dr-pane fl-pane">
      <div className="fl-head">
        <div className="kicker">Files</div>
        <span className="mono fl-usage">
          {list ? usageLine(list.usage) : loading ? "reading the box…" : "—"}
        </span>
        <button type="button" className="btn btn-sm btn-secondary" disabled={loading} onClick={reload}>
          Refresh
        </button>
      </div>
      {error ? (
        <div className="fl-error mono" role="alert">
          {`Could not read ${name}'s files: ${error}`}
        </div>
      ) : null}
      {actionError ? (
        <div className="fl-error mono" role="alert">
          {actionError}
        </div>
      ) : null}

      <section className="fl-sec" aria-label="Open requests">
        <h3 className="kicker">
          Open requests <span className="mono">{open.length}</span>
        </h3>
        {list === null ? null : shownRequests.length === 0 ? (
          <p className="hint">No requests waiting on you.</p>
        ) : (
          <table className="fl-table fl-requests">
            <thead>
              <tr>
                <th scope="col">id</th>
                <th scope="col">purpose</th>
                <th scope="col">class</th>
                <th scope="col">expires</th>
                <th scope="col">
                  <span className="sr-only">actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shownRequests.map(({ id, request }) => {
                const secret =
                  delivering.get(id) ?? (request ? requestClass(request) === "secret" : false);
                return (
                  <Fragment key={id}>
                    {request ? (
                      <tr data-request={id}>
                        <td className="mono" title={id}>
                          {shortId(id)}
                        </td>
                        <td className="fl-purpose" title={request.purpose}>
                          {truncatePurpose(request.purpose)}
                        </td>
                        <td className={secret ? "mono fl-secret" : "mono"}>{requestClass(request)}</td>
                        <td className="mono">{countdown(request.expires_at, now)}</td>
                        <td className="fl-acts">
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            aria-expanded={delivering.has(id)}
                            onClick={() => toggleDeliver(request)}
                          >
                            Deliver…
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            disabled={declining === id}
                            onClick={() => doDecline(id)}
                          >
                            Decline
                          </button>
                        </td>
                      </tr>
                    ) : null}
                    {delivering.has(id) ? (
                      <tr className="fl-card-row">
                        <td colSpan={5}>
                          <FileRequestBlock
                            block={requestBlock(id, secret)}
                            instance={name}
                            agent={name}
                          />
                          <div className="fl-card-foot">
                            <button
                              type="button"
                              className="btn btn-sm btn-secondary"
                              onClick={() => closeDeliver(id)}
                            >
                              Close
                            </button>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="fl-sec" aria-label="Inbox · Outbox · Secrets">
        <h3 className="kicker">Inbox · Outbox · Secrets</h3>
        {list === null ? (
          loading ? (
            <p className="hint">Reading the box…</p>
          ) : null
        ) : rows.length === 0 ? (
          <p className="hint">Nothing on the box yet.</p>
        ) : (
          <table className="fl-table fl-entries">
            <thead>
              <tr>
                <th scope="col">dir</th>
                <th scope="col">name</th>
                <th scope="col">size</th>
                <th scope="col">sha256</th>
                <th scope="col">from</th>
                <th scope="col">age</th>
                <th scope="col">
                  <span className="sr-only">actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <EntryRow
                  key={row.entry.id}
                  row={row}
                  agent={name}
                  now={now}
                  onDelete={() => planRm(row)}
                  deleting={rm?.row.entry.id === row.entry.id || rm?.applying === true}
                />
              ))}
            </tbody>
          </table>
        )}
        {rows.some((r) => r.dir === "secret") ? (
          <p className="hint">
            Secret contents are never shown or copied to this Mac. To rotate or replace one, ask the
            agent to request it again.
          </p>
        ) : null}
      </section>

      {rm ? (
        <RmConfirm state={rm} onCancel={() => setRm(null)} onConfirm={() => void applyRm(rm)} />
      ) : null}
    </div>
  );
}

/** A row's save, in a line under its name; `null` when there is nothing to say. */
function saveNote(state: FileSaveState): { text: string; bad: boolean } | null {
  switch (state.phase) {
    case "choosing":
      return { text: "choosing a folder…", bad: false };
    case "saving":
      return {
        text: state.progress === null ? "saving…" : `saving… ${Math.round(state.progress * 100)}%`,
        bad: false,
      };
    case "saved":
      return { text: `Saved ${state.file.name} · ${sizeLabel(state.file.bytes)}`, bad: false };
    case "error":
      return { text: `Not saved — ${saveErrorText(state.code, state.message)}`, bad: true };
    default:
      return null;
  }
}

function EntryRow({
  row,
  agent,
  now,
  onDelete,
  deleting,
}: {
  row: FilesRow;
  agent: string;
  now: number;
  onDelete: () => void;
  deleting: boolean;
}) {
  const { entry, dir } = row;
  const secret = dir === "secret";
  const env = secret && entry.slot?.startsWith("env-") === true;
  // Secrets are never fetched: the hook is there, and never started, for one.
  const saving = useFileSave(secret ? null : agent, entry.id);
  const save = saveNote(saving.state);
  const busy = saving.state.phase === "choosing" || saving.state.phase === "saving";
  return (
    <tr data-entry={entry.id}>
      <td className={secret ? "mono fl-secret" : "mono"}>{dir}</td>
      <td className="fl-name" title={entry.name}>
        <span className="mono">{row.label}</span>
        {save ? (
          <span className={save.bad ? "fl-note bad" : "fl-note"} role={save.bad ? "alert" : "status"}>
            {save.text}
          </span>
        ) : null}
      </td>
      <td className="mono">{sizeLabel(entry.bytes)}</td>
      <td className="mono" title={entry.sha256}>
        {shortSha(entry.sha256)}
      </td>
      <td className="mono">{originLabel(entry, agent)}</td>
      <td className="mono">{ageLabel(entry.created_at, now)}</td>
      <td className="fl-acts">
        {secret ? (
          <>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled
              title="Ask the agent to request it again"
            >
              {env ? "Replace" : "Rotate"}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={deleting}
              aria-label={`Delete ${row.label}`}
              onClick={onDelete}
            >
              Delete
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={busy}
            aria-label={`Save ${entry.name}`}
            onClick={saving.start}
          >
            Save…
          </button>
        )}
      </td>
    </tr>
  );
}

/** The delete's plan, as read, and what it costs, before anything is deleted. */
function RmConfirm({
  state,
  onCancel,
  onConfirm,
}: {
  state: RmState;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { row, plan, error, applying } = state;
  const ssm = plan?.steps.some((s) => s.id === "ssm") ?? false;
  const box = useRef<HTMLElement | null>(null);
  // The confirm opens under the table, maybe out of view: bring it in and put the
  // keyboard on it, once per row asked about.
  const rowId = row.entry.id;
  useEffect(() => {
    const el = box.current;
    if (el === null || rowId === "") return;
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [rowId]);
  return (
    <section ref={box} className="confirm fl-confirm" aria-label={`Delete ${row.label}`}>
      <div className="kicker" style={{ color: "var(--bad)" }}>
        Delete {row.label}
      </div>
      {plan ? (
        <>
          <p className="fl-consequence">{rmConsequence(row.entry, ssm)}</p>
          <div className="steps-list">
            {plan.steps.map((s) => (
              <span key={s.id} className={s.destructive ? "destructive" : undefined}>
                {s.destructive ? "✖" : "·"} {s.id} — {s.description}
              </span>
            ))}
            {plan.warnings.map((w) => (
              <span key={w} className="destructive">
                ⚠ {w}
              </span>
            ))}
          </div>
        </>
      ) : error ? null : (
        <div className="steps-list">
          <span>reading the delete plan…</span>
        </div>
      )}
      {error ? (
        <div className="fl-error mono" role="alert">
          {error}
        </div>
      ) : null}
      <div className="confirm-actions">
        <button type="button" className="btn btn-secondary" disabled={applying} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={plan === null || applying}
          onClick={onConfirm}
        >
          {applying ? "Deleting…" : "Delete"}
        </button>
      </div>
    </section>
  );
}
