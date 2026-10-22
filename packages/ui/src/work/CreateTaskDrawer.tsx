/**
 * New task (§9.2): which instance's board, what to do, where it starts, who
 * runs it, where its files go, and how urgent it is. Create sends
 * `kanban.create`, re-reads the board and opens the new card.
 */
import { useId, useState } from "react";
import type { ReactNode } from "react";
import { kanbanCreate } from "../api/chat.ts";
import { Drawer, DrawerHead } from "../components/Drawer.tsx";
import { cliEcho } from "./parts.tsx";
import { useWork } from "./work-state.tsx";

type Input = Parameters<typeof kanbanCreate>[0];
type WorkspaceKind = NonNullable<Input["workspace_kind"]>;

const WORKSPACES: [WorkspaceKind, string, string][] = [
  ["dir", "Folder", "always kept"],
  ["worktree", "Git worktree", "kept unless pushed"],
  ["scratch", "Scratch", "deleted when done"],
];

export function CreateTaskDrawer({ instance: initial }: { instance: string | null }) {
  const work = useWork();
  const titleId = useId();
  const on = (work.board?.instances ?? []).filter((i) => i.state === "on");
  const [instance, setInstance] = useState(initial ?? on[0]?.instance ?? "");
  const profiles = on.find((i) => i.instance === instance)?.profiles ?? [];
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [start, setStart] = useState<"triage" | "ready">("triage");
  const [assignee, setAssignee] = useState<string | null>(profiles[0] ?? null);
  const [workspace, setWorkspace] = useState<WorkspaceKind>("dir");
  const [path, setPath] = useState("");
  const [priority, setPriority] = useState(0);
  const [more, setMore] = useState(false);
  const [skills, setSkills] = useState("");
  const [goal, setGoal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const skillList = skills
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const input: Input = {
    instance,
    title: title.trim(),
    ...(body.trim() ? { body: body.trim() } : {}),
    assignee,
    start,
    workspace_kind: workspace,
    // Scratch picks its own path; a typed one would keep the files it promises to delete.
    ...(workspace !== "scratch" && path.trim() ? { workspace_path: path.trim() } : {}),
    priority,
    ...(skillList.length ? { skills: skillList } : {}),
    ...(goal ? { goal_mode: true } : {}),
  };
  // Upstream needs a path for a kept workspace; only scratch picks its own.
  const needsPath = workspace !== "scratch";
  const ready = !busy && instance !== "" && input.title !== "" && (!needsPath || path.trim() !== "");

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const task = await kanbanCreate(input);
      await work.refresh();
      work.openTask(instance, task.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Drawer width={560} className="wk-drawer" onClose={work.closeCreate} labelledBy={titleId}>
      <DrawerHead
        kicker={`New task${instance ? ` · ${instance}` : ""}`}
        title="New task"
        titleId={titleId}
        onClose={work.closeCreate}
      />
      <div className="form wk-form">
        <Field
          label="Instance"
          hint="A task runs on one instance's board. Moving it means recreating it."
        >
          {on.length ? (
            <div className="seg wk-seg" role="group" aria-label="Instance">
              {on.map((i) => (
                <button
                  key={i.instance}
                  type="button"
                  aria-pressed={instance === i.instance}
                  onClick={() => {
                    setInstance(i.instance);
                    setAssignee(i.profiles[0] ?? null);
                  }}
                >
                  {i.instance}
                </button>
              ))}
            </div>
          ) : (
            <span className="wk-warn">No instance has its board on.</span>
          )}
        </Field>
        <Field label="What should get done">
          <input
            className="wiz-input"
            value={title}
            aria-label="Title"
            placeholder="A rough idea is fine"
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="wiz-input wk-answer"
            value={body}
            aria-label="Details"
            placeholder="Details (optional)"
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        <Field label="Start in">
          <div className="seg wk-seg" role="group" aria-label="Start in">
            <button type="button" aria-pressed={start === "triage"} onClick={() => setStart("triage")}>
              Triage<small>an agent writes the spec first</small>
            </button>
            <button type="button" aria-pressed={start === "ready"} onClick={() => setStart("ready")}>
              Ready<small>run as written</small>
            </button>
          </div>
        </Field>
        <Field
          label="Assignee — the profile that runs it"
          hint={
            assignee === null
              ? "Parked: the card sits in Ready and no worker claims it until you assign one."
              : undefined
          }
          warn={assignee === null}
        >
          <div className="seg wk-seg" role="group" aria-label="Assignee">
            {profiles.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={assignee === p}
                onClick={() => setAssignee(p)}
              >
                {p}
              </button>
            ))}
            <button type="button" aria-pressed={assignee === null} onClick={() => setAssignee(null)}>
              Nobody<small>parked</small>
            </button>
          </div>
        </Field>
        <Field label="Workspace — where the files go">
          <div className="seg wk-seg" role="group" aria-label="Workspace">
            {WORKSPACES.map(([k, label, rule]) => (
              <button
                key={k}
                type="button"
                aria-pressed={workspace === k}
                onClick={() => setWorkspace(k)}
              >
                {label}
                <small>{rule}</small>
              </button>
            ))}
          </div>
          <input
            className="wiz-input mono"
            value={needsPath ? path : ""}
            disabled={!needsPath}
            aria-label="Workspace path"
            required={needsPath}
            placeholder={
              needsPath ? "path on the box, e.g. ~/work/invoices" : "chosen by Hermes (optional)"
            }
            onChange={(e) => setPath(e.target.value)}
          />
          {workspace === "scratch" ? (
            <div className="callout warn">
              <b>Scratch is deleted when the task completes</b>, with every file the agent wrote in it.
              Use it for work whose result is the summary, not a file.
            </div>
          ) : null}
        </Field>
        <Field label="Priority — higher runs first">
          <div className="seg wk-seg" role="group" aria-label="Priority">
            {[0, 1, 2, 3].map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={priority === n}
                onClick={() => setPriority(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </Field>
        <button
          type="button"
          className="wk-more"
          aria-expanded={more}
          onClick={() => setMore((v) => !v)}
        >
          <b>{more ? "▾" : "▸"} More</b>
          <span className="mono dim">skills · goal mode</span>
        </button>
        {more ? (
          <>
            <Field label="Skills">
              <input
                className="wiz-input mono"
                value={skills}
                aria-label="Skills"
                placeholder="profile default — e.g. github, csv"
                onChange={(e) => setSkills(e.target.value)}
              />
            </Field>
            <label className="rt-check">
              <input type="checkbox" checked={goal} onChange={(e) => setGoal(e.target.checked)} />
              <span>
                <b>Goal mode</b>
                <small>The worker keeps going until a judge agrees it is done.</small>
              </span>
            </label>
          </>
        ) : null}
        {error ? (
          <div className="callout bad" role="alert">
            {error}
          </div>
        ) : null}
      </div>
      <div className="drawer-foot wk-dfoot">
        <span className="mono wk-cli">{cliEcho("create", input as Record<string, unknown>)}</span>
        <div className="wk-row">
          <span className="wk-sp" />
          <button type="button" className="btn btn-secondary" onClick={work.closeCreate}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!ready}
            onClick={() => void create()}
          >
            Create task →
          </button>
        </div>
      </div>
    </Drawer>
  );
}

function Field({
  label,
  hint,
  warn = false,
  children,
}: {
  label: string;
  hint?: string | undefined;
  warn?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="wk-field">
      <div className="kicker">{label}</div>
      {children}
      {hint ? <span className={`mono wk-hint${warn ? " wk-warn" : ""}`}>{hint}</span> : null}
    </div>
  );
}
