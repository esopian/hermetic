/**
 * `tool` with `render: file_request | secret_request` — an agent asking the
 * operator for a file or a secret (attachments plan §8.3, §8.4, §8.4b).
 *
 * Like the approval card, it is loud, it is never softened and it never
 * collapses while it is open: the agent may be parked on it. Everything the
 * card states — purpose, destination, accept list, cap, expiry — comes from
 * hermeticd's own slot (`useFileRequest`), never from the tool's arguments,
 * which are the model's words. The purpose is quoted literally: no markdown,
 * no links.
 *
 * Three cards share the head and the facts: a file (`FileCard`), a secret file
 * (the same card in `--warn`, with no preview of any kind), and a text secret
 * (`TextSecretCard`, around `SecretTextInput`). A block whose id the box no
 * longer has is drawn from the tool's recorded result, and says so.
 */
import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, ReactNode } from "react";
import {
  FILES_LIMITS,
  FILES_TTL,
  fileSecretSlot,
  requestFileName,
  sanitizeFileName,
  secretTextSlug,
  shortId,
  sniffMime,
} from "@hermetic/core/shared";
import * as filesApi from "../../../api/files.ts";
import type { FileRequestSlot } from "../../../api/files.ts";
import { fmtBytes } from "../../chat-logic.ts";
import { useChatIfAvailable } from "../../chat-state.tsx";
import {
  baseName,
  capLabel,
  clockHM,
  continueMessage,
  countdown,
  deliveredLate,
  lifetimeLabel,
  markToldLate,
  looksLikeKey,
  requestOrigin,
  resultStatus,
  secretContinueMessage,
  shortSha,
  slotDelivered,
  toldLate,
} from "../../file-request-logic.ts";
import type { RequestToolBlock } from "../../file-request-logic.ts";
import { slotLive, useFileRequest } from "../../use-file-request.ts";
import { useFilePut, useLetGoWhenClosed } from "../../use-file-put.ts";
import type { FilePut } from "../../use-file-put.ts";
import { RedactedText } from "../RedactedText.tsx";
import { SecretTextInput } from "./SecretTextInput.tsx";
import { ToolBlock } from "./Tool.tsx";

export interface FileRequestProps {
  block: RequestToolBlock;
  /** The box the request lives on. */
  instance: string;
  /** Who asked, as the operator knows it: "sindri was told". */
  agent: string;
  /** The turn read web pages or flagged output before it asked. */
  untrusted?: boolean;
  /** When the turn began: the clock "stopped waiting at" reads when nothing better is known. */
  at?: string;
}

export function FileRequestBlock(props: FileRequestProps) {
  // The id is unknown until the box answered: the tool row, waiting.
  if (!props.block.request_id) return <ToolBlock block={props.block} />;
  // Keyed by the id: a provisional id that changes is a different request, and
  // nothing typed, held or dismissed for the old one may carry over to it.
  const request_id = props.block.request_id;
  return (
    <RequestCard
      key={request_id}
      {...props}
      request_id={request_id}
      secret={props.block.render === "secret_request"}
    />
  );
}

/** The same delivery card outside a chat thread, where no tool block exists. */
export function FileRequestCard({
  request_id,
  secret,
  ...props
}: Omit<FileRequestProps, "block"> & { request_id: string; secret: boolean }) {
  return (
    <RequestCard key={request_id} {...props} request_id={request_id} secret={secret} block={null} />
  );
}

/** A second-resolution clock, only while something on the card counts down. */
function useSeconds(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

type RequestCardProps = Omit<FileRequestProps, "block"> & {
  request_id: string;
  secret: boolean;
  block: RequestToolBlock | null;
};

function RequestCard(props: RequestCardProps) {
  const { block, instance, request_id, secret } = props;
  const view = useFileRequest(instance, request_id);
  const now = useSeconds(slotLive(view.slot) && !view.missing);
  const secretAsk = secret;
  if (view.missing) return <GoneCard block={block} request_id={request_id} secret={secretAsk} />;
  const slot = view.slot;
  const notice = view.unreachable ? <Unreachable retry={view.refresh} /> : null;
  if (slot === null) {
    return (
      <Shell
        tone={secretAsk ? "secret" : "file"}
        title={secretAsk ? "◆ Secret requested" : "▣ File requested"}
      >
        <div className="ch-freq-body">
          {notice ?? (
            <div className="ch-freq-note">
              {view.error
                ? `Could not read the request from the box: ${view.error}`
                : "Reading the request from the box…"}
            </div>
          )}
        </div>
      </Shell>
    );
  }
  if (slot.kind === "secret_text") {
    return <TextSecretCard {...props} slot={slot} now={now} refresh={view.refresh} notice={notice} />;
  }
  return <FileCard {...props} slot={slot} now={now} refresh={view.refresh} notice={notice} />;
}

/** Reads kept failing and polling stopped: what the card shows may be stale. */
function Unreachable({ retry }: { retry: () => void }) {
  return (
    <div className="ch-freq-refused" role="alert">
      <span className="ch-freq-tag">box unreachable</span>
      <span>The request could not be read from the box. What this card shows may be out of date.</span>
      <button type="button" className="btn btn-secondary" onClick={retry}>
        Retry
      </button>
    </div>
  );
}

type CardProps = RequestCardProps & {
  slot: FileRequestSlot;
  now: number;
  refresh: () => void;
  /** Set when the box stopped answering. */
  notice: ReactNode;
};

function Shell({
  tone,
  title,
  right,
  children,
  state,
}: {
  tone: "file" | "secret";
  title: string;
  right?: string | null;
  children: ReactNode;
  state?: string;
}) {
  return (
    <section className={`ch-freq ${tone}`} data-state={state} aria-label={title.replace(/^\S+\s/, "")}>
      <div className="ch-card-head">
        <span>{title}</span>
        {right ? <span className="right">{right}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="ch-freq-facts">
      {rows.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Purpose({ text }: { text: string }) {
  return (
    <blockquote className="ch-freq-purpose">
      <RedactedText text={`“${text}”`} />
    </blockquote>
  );
}

function UntrustedBanner({ agent }: { agent: string }) {
  return (
    <div className="ch-freq-untrusted" role="note">
      <b>⚠ untrusted content this turn</b>
      <span>{`${agent} read web pages earlier in this turn. Make sure this request matches what you asked for.`}</span>
    </div>
  );
}

function headRight(slot: FileRequestSlot, now: number): string {
  switch (slot.state) {
    case "open":
    case "receiving":
      return `expires in ${countdown(slot.expires_at, now)}`;
    case "fulfilled":
    case "consumed":
      return "delivered";
    default:
      return slot.state;
  }
}

/** Uploading: progress and the one way out. */
function Progress({ put }: { put: FilePut }) {
  if (put.state.phase !== "uploading") return null;
  const { progress, sent, total } = put.state;
  return (
    <div className="ch-freq-progress">
      <span className="ch-freq-tag">uploading</span>
      <div className="bar">
        <i style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <span className="mono">{`${Math.round(progress * 100)}% · ${fmtBytes(sent)} / ${fmtBytes(total)}`}</span>
      <button type="button" className="btn btn-secondary" onClick={put.cancel}>
        Cancel
      </button>
    </div>
  );
}

/** What the box said no to: the card stays open to try again. */
function Refusal({ message }: { message: string }) {
  return (
    <div className="ch-freq-refused" role="alert">
      <span className="ch-freq-tag">rejected by box</span>
      <span>
        <RedactedText text={message} /> Nothing was stored. Choose another file.
      </span>
    </div>
  );
}

/**
 * The durable slot already holds a secret, and the put stopped to ask
 * (`replace_slot`). "Replace" sends the same source again with `replace`;
 * "Cancel" lets it go and writes nothing (`onCancel`, which calls `put.keep`).
 */
function ReplacePrompt({ slot, put, onCancel }: { slot: string; put: FilePut; onCancel: () => void }) {
  return (
    <div className="ch-freq-keynote" role="alert">
      <span>{`This replaces the stored secret ${slot}.`}</span>
      <div className="ch-freq-actions">
        <button type="button" className="btn btn-primary" onClick={put.replace}>
          Replace
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The put is waiting on the replace question: the slot it would replace. */
function askingToReplace(put: FilePut): string | null {
  return put.state.phase === "error" ? (put.state.replace_slot ?? null) : null;
}

/** The chosen file as core names it: its sanitized name and sniffed type. */
interface Chosen {
  name: string;
  mime: string;
}

function chosenName(raw: string): string {
  const clean = sanitizeFileName(raw);
  return clean.ok ? clean.name : raw;
}

/** A drop or a paste: the head is read for its type, then zeroed. */
async function chosenFile(file: File): Promise<Chosen> {
  const name = chosenName(file.name);
  const head = new Uint8Array(await file.slice(0, FILES_LIMITS.sniffBytes).arrayBuffer());
  try {
    return { name, mime: sniffMime(head, name) };
  } finally {
    head.fill(0);
  }
}

/**
 * A native pick: the page never holds its bytes, so its type is the
 * extension's. That names it as core does for any file the box would take:
 * the hint is used only when it shares the file's extension, and then the
 * two pass or fail the accept list together, whatever the type.
 */
function chosenPick(name: string): Chosen {
  const clean = chosenName(name);
  return { name: clean, mime: sniffMime(new Uint8Array(0), clean) };
}

/** Decline: the box answers, and the slot is re-read. */
function useDecline(instance: string, request_id: string, refresh: () => void) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const decline = (): void => {
    setBusy(true);
    setError(null);
    filesApi
      .decline(instance, request_id)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusy(false);
        refresh();
      });
  };
  return { decline, error, busy };
}

/** A key-looking file on a normal request, held until the operator says which (D6). */
type HeldKey = { kind: "file"; file: File } | { kind: "upload"; upload_id: string; size: number };

const discardUpload = (upload_id: string): void => {
  void filesApi.uploadDiscard(upload_id).catch(() => undefined);
};

/**
 * The native dialog: the main process reads the file, the page gets an upload
 * id and the main process's D6 sniff (`looks_like_key`). A key-looking pick on
 * a normal request goes to `onKey` instead of being sent. The dialog answers
 * whenever the operator is done with it: if by then the slot has closed or the
 * card has left (`isLive`), every upload the pick made is discarded and
 * nothing else happens.
 */
function choose(
  instance: string,
  put: FilePut,
  opts: filesApi.PutOptions,
  onKey: ((held: HeldKey) => void) | null,
  onChosen: (chosen: Chosen) => void,
  isLive: () => boolean,
): void {
  put.clear();
  filesApi
    .pickNative(instance)
    .then(({ files }) => {
      if (!isLive()) {
        for (const file of files) discardUpload(file.upload_id);
        return;
      }
      const [first, ...rest] = files;
      for (const extra of rest) discardUpload(extra.upload_id);
      if (!first) return;
      onChosen(chosenPick(first.name));
      if (onKey !== null && first.looks_like_key) {
        onKey({ kind: "upload", upload_id: first.upload_id, size: first.size });
        return;
      }
      put.putUpload(first.upload_id, first.size, opts);
    })
    .catch(() => undefined);
}

/** Where the slot came from: a warning unless it is this conversation's own. */
function Origin({ slot }: { slot: FileRequestSlot }) {
  const chat = useChatIfAvailable();
  const { own, label } = requestOrigin(slot, chat?.session?.id);
  return own ? label : <span className="ch-freq-warn">{label}</span>;
}

/**
 * The delivery came after the agent stopped waiting (`deliveredLate`): offer
 * to tell it, once per request for the life of the page (`toldLate`).
 */
function LateDelivery({
  instance,
  agent,
  request_id,
  stoppedAt,
  what,
  message,
}: {
  instance: string;
  agent: string;
  request_id: string;
  stoppedAt: string;
  /** "The file" or "The secret". */
  what: string;
  /** What "Tell … & continue" sends. */
  message: string;
}) {
  const chat = useChatIfAvailable();
  const [later, setLater] = useState<"open" | "dismissed" | "sent">(() =>
    toldLate(instance, request_id) ? "sent" : "open",
  );
  if (later === "dismissed") return null;
  return (
    <div className="ch-freq-late">
      <span className="ch-freq-tag">delivered after the turn ended</span>
      <span>{`${agent} stopped waiting at ${clockHM(stoppedAt)}. ${what} is on the box.`}</span>
      {later === "sent" ? (
        <span className="ch-freq-note">{`Sent to ${agent}.`}</span>
      ) : chat ? (
        <div className="ch-freq-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              // Once per request, for the life of the page: a remount
              // must not offer to tell the agent twice.
              if (toldLate(instance, request_id)) {
                setLater("sent");
                return;
              }
              // Not sent (a turn in flight, a closed chat): still offered.
              if (!chat.send(message)) return;
              markToldLate(instance, request_id);
              setLater("sent");
            }}
          >
            {`Tell ${agent} & continue`}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setLater("dismissed")}>
            Later
          </button>
        </div>
      ) : null}
    </div>
  );
}

function FileCard({ block, instance, agent, untrusted, at, slot, now, refresh, notice }: CardProps) {
  const request_id = slot.request_id;
  const put = useFilePut(instance, request_id, refresh);
  const declining = useDecline(instance, request_id, refresh);
  // A key-looking drop or pick on a normal request (D6), held until the
  // operator says which. A ref, not state: the file is never part of a render.
  const held = useRef<HeldKey | null>(null);
  const [keyPrompt, setKeyPrompt] = useState(false);
  // The file last dropped or picked: the preview names it as core will.
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const secret = slot.sensitivity === "secret" || slot.fulfilled?.class === "secret";
  const live = slot.state === "open" || slot.state === "receiving";
  const uploading = put.state.phase === "uploading";
  const asking = askingToReplace(put);
  useLetGoWhenClosed(live, put);

  // Whether a pick that resolves later still has a live slot to go to: the
  // native dialog answers after the operator chose, which may be after the
  // slot closed or the card left. Mounted is its own flag, set in the mount
  // effect's body, so a StrictMode remount does not leave the card dead.
  const liveRef = useRef(live);
  liveRef.current = live;
  const mounted = useRef(false);
  const stillLive = (): boolean => mounted.current && liveRef.current;
  const hold = (next: HeldKey): void => {
    const prev = held.current;
    if (prev?.kind === "upload") discardUpload(prev.upload_id);
    if (!stillLive()) {
      // Nothing left to answer: a held pick's bytes go, and nobody is asked.
      held.current = null;
      if (next.kind === "upload") discardUpload(next.upload_id);
      return;
    }
    held.current = next;
    setKeyPrompt(true);
  };
  /** Hands the held file on (`opts`), or drops it (`null`). */
  const release = (opts: filesApi.PutOptions | null): void => {
    const current = held.current;
    held.current = null;
    setKeyPrompt(false);
    if (current === null) return;
    if (opts === null) {
      if (current.kind === "upload") discardUpload(current.upload_id);
      return;
    }
    if (current.kind === "file") put.putFile(current.file, opts);
    else put.putUpload(current.upload_id, current.size, opts);
  };
  // A card that unmounts with a pick held lets its upload go.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const current = held.current;
      held.current = null;
      if (current?.kind === "upload") discardUpload(current.upload_id);
    };
  }, []);
  // The slot closed under the question (expired, declined, fulfilled from
  // elsewhere): the D6 question has nothing left to answer, so the held file
  // goes — a native pick's bytes in the main process included.
  useEffect(() => {
    if (live || held.current === null) return;
    const current = held.current;
    held.current = null;
    setKeyPrompt(false);
    setChosen(null);
    if (current.kind === "upload") discardUpload(current.upload_id);
  }, [live]);

  const take = async (file: File | undefined): Promise<void> => {
    if (!file || !live || uploading) return;
    put.clear();
    setChosen(await chosenFile(file));
    if (!stillLive()) return;
    if (!secret && (await looksLikeKey(file, file.name))) {
      hold({ kind: "file", file });
      return;
    }
    // The slot can close while the file is read; a put then only earns a refusal.
    if (!stillLive()) return;
    put.putFile(file);
  };
  const pick = (opts: filesApi.PutOptions): void =>
    choose(instance, put, opts, secret ? null : hold, setChosen, stillLive);
  const hintName = slot.name_hint ? baseName(slot.name_hint.replace(/\\/g, "/")) : null;
  // What core's `requestFileName` will call the file: known once one is
  // chosen; before that, the rule in words, never a name it may not use.
  const named = chosen ? requestFileName(slot, chosen.name, chosen.mime) : null;
  const nameRule = hintName
    ? `named after the request's hint (${hintName}) when your file has the same extension, otherwise your file's name`
    : "named after your file";
  const onDrag = (e: DragEvent): void => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onDrop = (e: DragEvent): void => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    void take(e.dataTransfer?.files?.[0]);
  };
  const onPaste = (e: ClipboardEvent): void => {
    const file = e.clipboardData?.files?.[0];
    if (!file) return;
    e.preventDefault();
    e.stopPropagation();
    void take(file);
  };

  const refusal =
    put.state.phase === "error"
      ? asking === null
        ? put.state.message
        : null
      : live && slot.rejected
        ? slot.rejected.message
        : null;
  const onBox = slot.fulfilled ? baseName(slot.fulfilled.path) : named;
  const rows: [string, ReactNode][] = secret
    ? [
        [
          "Stored as",
          !slot.durable
            ? "not stored · just this once"
            : slot.fulfilled?.ssm_slot
              ? `encrypted SSM slot ${slot.fulfilled.ssm_slot}`
              : named
                ? `encrypted SSM slot ${fileSecretSlot(named)}`
                : `encrypted SSM slot file-… · ${nameRule}`,
        ],
        [
          "On the box",
          onBox
            ? `/run/hermetic/files/${onBox} · tmpfs · 0600`
            : `/run/hermetic/files/… · tmpfs · 0600 · ${nameRule}`,
        ],
        ["Never", "written to /data · previewed · cached on this Mac"],
        [
          "Accepts",
          `${slot.accept.length > 0 ? `${slot.accept.join(" ")} · ` : ""}≤ ${capLabel(slot.max_bytes)}`,
        ],
      ]
    : [
        ["Destination", `inbox · deleted after ${Math.round(FILES_TTL.inbox / 86_400)} days`],
        [
          "Accepts",
          `${slot.accept.length > 0 ? `${slot.accept.join(" ")} · ` : "any type · "}≤ ${capLabel(slot.max_bytes)}`,
        ],
        ...(slot.name_hint
          ? ([["Name", <RedactedText key="n" text={slot.name_hint} />]] as [string, ReactNode][])
          : []),
        ["Request", <Origin key="r" slot={slot} />],
      ];

  const done = slot.fulfilled;
  const late = block !== null && deliveredLate(block, slot);
  return (
    <Shell
      tone={secret ? "secret" : "file"}
      title={secret ? "◆ Secret requested" : "▣ File requested"}
      right={headRight(slot, now)}
      state={slot.state}
    >
      {untrusted && live ? <UntrustedBanner agent={agent} /> : null}
      <div className="ch-freq-body">
        {notice}
        <Purpose text={slot.purpose} />
        <Facts rows={rows} />
        {live && !uploading && !keyPrompt && asking === null ? (
          // A button, so the zone is focusable for a paste and a click is "choose…".
          <button
            type="button"
            className="ch-freq-drop"
            onClick={() => pick({})}
            onDragEnter={onDrag}
            onDragOver={onDrag}
            onDrop={onDrop}
            onPaste={onPaste}
          >
            {secret ? "Drop the key here or choose…" : "Drop a file here or choose…"}
          </button>
        ) : null}
        {keyPrompt && live ? (
          <div className="ch-freq-keynote" role="alert">
            <span>Looks like a private key — it will be stored as a secret.</span>
            <div className="ch-freq-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => release({ secret: true })}
              >
                Store as secret
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => release({ not_secret: true })}
              >
                This isn't a secret
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  release(null);
                  setChosen(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {asking !== null && live ? (
          <ReplacePrompt
            slot={asking}
            put={put}
            onCancel={() => {
              put.keep();
              setChosen(null);
            }}
          />
        ) : null}
        <Progress put={put} />
        {refusal && live && !uploading ? <Refusal message={refusal} /> : null}
        {declining.error ? (
          <div className="ch-freq-refused" role="alert">
            <RedactedText text={declining.error} />
          </div>
        ) : null}
        {done && slotDelivered(slot) ? (
          <div className="ch-freq-done">
            <span className="ch-freq-tag">{secret ? "secret delivered" : "delivered"}</span>
            <span>
              {secret ? (
                <>
                  <RedactedText text={baseName(done.path)} />
                  {done.ssm_slot ? ` → slot ${done.ssm_slot}` : " → tmpfs"}
                  {` · ${fmtBytes(done.bytes)} · sha ${shortSha(done.sha256)} · contents never shown`}
                </>
              ) : (
                <>
                  <RedactedText text={baseName(done.path)} />
                  {` · ${fmtBytes(done.bytes)} · sha ${shortSha(done.sha256)} · by ${done.by} · ${clockHM(done.at)}`}
                </>
              )}
            </span>
          </div>
        ) : null}
        {slot.state === "declined" ? (
          <div className="ch-freq-closed">
            <span className="ch-freq-tag">declined</span>
            <span>{`You declined. ${agent} was told.`}</span>
          </div>
        ) : null}
        {slot.state === "expired" ? (
          <div className="ch-freq-closed">
            <span className="ch-freq-tag">expired</span>
            <span>{`No file within ${lifetimeLabel(slot)}. Ask ${agent} to request again.`}</span>
          </div>
        ) : null}
        {late && done ? (
          <LateDelivery
            instance={instance}
            agent={agent}
            request_id={request_id}
            stoppedAt={at ?? slot.created_at}
            what="The file"
            message={continueMessage(request_id, done.path)}
          />
        ) : null}
      </div>
      {live && !uploading && !keyPrompt && asking === null ? (
        <div className="ch-freq-foot">
          <button type="button" className="btn btn-primary" onClick={() => pick({})}>
            Choose file…
          </button>
          {secret ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => pick({ ephemeral: true })}
            >
              Just this once (tmpfs, 1 h)
            </button>
          ) : null}
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={declining.busy}
            onClick={declining.decline}
          >
            Decline
          </button>
        </div>
      ) : null}
    </Shell>
  );
}

function TextSecretCard({
  block,
  instance,
  agent,
  untrusted,
  at,
  slot,
  now,
  refresh,
  notice,
}: CardProps) {
  const request_id = slot.request_id;
  const put = useFilePut(instance, request_id, refresh);
  const declining = useDecline(instance, request_id, refresh);
  const live = slot.state === "open" || slot.state === "receiving";
  const keys = slot.keys ?? [];
  const optional = slot.optional_keys ?? [];
  const slug = slot.slug ?? secretTextSlug(keys);
  const file = `/run/hermetic/files/${slug}.env`;
  const asking = askingToReplace(put);
  useLetGoWhenClosed(live, put);
  const boxError =
    put.state.phase === "error"
      ? asking === null
        ? put.state.message
        : null
      : live && slot.rejected
        ? slot.rejected.message
        : null;
  const done = slot.fulfilled;
  const storedKeys = done?.keys ?? keys;
  return (
    <Shell
      tone="secret"
      title="◆ Secret requested · text"
      right={headRight(slot, now)}
      state={slot.state}
    >
      {untrusted && live ? <UntrustedBanner agent={agent} /> : null}
      <div className="ch-freq-body">
        {notice}
        <Purpose text={slot.purpose} />
        <Facts
          rows={[
            [
              "Keys",
              <span key="k" className="ch-freq-keys">
                {keys.map((k) => (
                  <span key={k}>
                    <b>{k}</b> required
                  </span>
                ))}
                {optional.map((k) => (
                  <span key={k}>
                    <b>{k}</b> optional
                  </span>
                ))}
              </span>,
            ],
            [
              "Stored as",
              slot.durable ? `SSM env-${slug} · ${file}` : `${file} · tmpfs · just this once`,
            ],
            ["Agent gets", "the path and key names, never the value"],
            ["Request", <Origin key="r" slot={slot} />],
          ]}
        />
        {live ? (
          <SecretTextInput
            keys={keys}
            optional_keys={optional}
            {...(slot.input ? { input: slot.input } : {})}
            disabled={declining.busy || asking !== null}
            busy={put.state.phase === "uploading"}
            boxError={boxError}
            onSubmit={(text, as, ephemeral) => {
              put.clear();
              put.putBytes(new TextEncoder().encode(text), `${slug}.env`, { as, ephemeral });
            }}
            onDecline={declining.decline}
          />
        ) : null}
        {asking !== null && live ? <ReplacePrompt slot={asking} put={put} onCancel={put.keep} /> : null}
        <Progress put={put} />
        {declining.error ? (
          <div className="ch-freq-refused" role="alert">
            <RedactedText text={declining.error} />
          </div>
        ) : null}
        {done && slotDelivered(slot) ? (
          <div className="ch-freq-done">
            <span className="ch-freq-tag">secret delivered</span>
            <span>
              {`${storedKeys.join(" ")} → ${done.path} · ${done.format ?? "dotenv"} · ${storedKeys.length} ${storedKeys.length === 1 ? "key" : "keys"} · sha ${shortSha(done.sha256)} · value never shown`}
            </span>
          </div>
        ) : null}
        {slot.state === "declined" ? (
          <div className="ch-freq-closed">
            <span className="ch-freq-tag">declined</span>
            <span>{`You declined. ${agent} was told.`}</span>
          </div>
        ) : null}
        {slot.state === "expired" ? (
          <div className="ch-freq-closed">
            <span className="ch-freq-tag">expired</span>
            <span>{`No secret within ${lifetimeLabel(slot)}. Ask ${agent} to request again.`}</span>
          </div>
        ) : null}
        {done && block !== null && deliveredLate(block, slot) ? (
          <LateDelivery
            instance={instance}
            agent={agent}
            request_id={request_id}
            stoppedAt={at ?? slot.created_at}
            what="The secret"
            message={secretContinueMessage(request_id, done.path, storedKeys)}
          />
        ) : null}
      </div>
    </Shell>
  );
}

/** The box no longer has the slot: what the tool recorded is all there is. */
function GoneCard({
  block,
  request_id,
  secret,
}: {
  block: RequestToolBlock | null;
  request_id: string;
  secret: boolean;
}) {
  const status =
    block === null
      ? "closed"
      : (resultStatus(block.result) ?? (block.status === "running" ? "waiting" : "closed"));
  return (
    <Shell
      tone={secret ? "secret" : "file"}
      title={secret ? "◆ Secret requested" : "▣ File requested"}
      right={status}
      state="gone"
    >
      <div className="ch-freq-body">
        <div className="ch-freq-closed">
          <span className="ch-freq-tag">{status}</span>
          <span>{`Request ${shortId(request_id)} is no longer on the box.`}</span>
        </div>
      </div>
    </Shell>
  );
}
