import { botLabel } from "../chat-presentation.ts";
/** One keyboard-owned dialog. Search states its cache boundary instead of pretending to search boxes. */
import { useMemo, useState } from "react";
import type { ChatSelection } from "../chat-state.tsx";
import { useChat } from "../chat-state.tsx";
import { useChatEntry } from "../chat-entry-state.tsx";
import { searchableText } from "../process-events.ts";
import { Dialog } from "../../components/Dialog.tsx";

interface Result {
  key: string;
  name: string;
  detail: string;
  target?: ChatSelection;
  draft?: string;
  message?: string;
  hash?: string;
}
const COMMANDS = [
  { name: "Fleet", hash: "" },
  { name: "Chat", hash: "#chat" },
  { name: "Volumes", hash: "#fleet/volumes" },
  { name: "Settings", hash: "#settings" },
  { name: "Run log", hash: "#settings/runs" },
];

export function QuickJump({ onClose }: { onClose: () => void }) {
  const chat = useChat();
  const entry = useChatEntry();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.startsWith(">"))
      return COMMANDS.filter((c) => c.name.toLowerCase().includes(q.slice(1).trim())).map((c) => ({
        ...c,
        key: c.name,
        detail: "Open existing view",
      }));
    const rows: Result[] = [];
    if (q.startsWith("#")) {
      if (chat.selection)
        for (const session of chat.sessions) {
          const name = session.title ?? session.origin_detail ?? session.id;
          if (!`${name} ${session.id}`.toLowerCase().includes(q.slice(1).trim())) continue;
          rows.push({
            key: session.id,
            name,
            detail: `${session.origin} conversation · reply destination will be shown`,
            target: { ...chat.selection, session: session.id },
          });
        }
      return rows;
    }
    const search = q.startsWith("@") ? q.slice(1).trim() : q;
    for (const swarm of chat.swarms)
      for (const bot of swarm.bots) {
        const address = `${swarm.instance}/${bot.name}`;
        const aliases = [
          address,
          ...(bot.is_default || bot.name === "default" ? [swarm.instance] : []),
          bot.name,
          bot.title ?? "",
        ].filter(Boolean);
        const exact = !q.startsWith("@")
          ? aliases.find((a) => search.startsWith(`${a.toLowerCase()} `))
          : undefined;
        if (!exact && !aliases.some((a) => a.toLowerCase().includes(search))) continue;
        rows.push({
          key: address,
          name: search.includes("/") ? address : botLabel(swarm.instance, bot.name, bot.title),
          detail: exact
            ? "Send if portal origin is established; otherwise review in dock"
            : `${address} · ${swarm.reachable ? "over the tailnet" : "unreachable"}`,
          target: { instance: swarm.instance, bot: bot.name, session: null },
          draft: exact ? query.trim().slice(exact.length).trim() : undefined,
        });
      }
    if (search && !q.startsWith("@") && chat.selection)
      for (const message of chat.messages) {
        // A background event is not a message anybody wrote (`searchableText`).
        const text = searchableText(message);
        if (text.toLowerCase().includes(search))
          rows.push({
            key: `message:${message.id}`,
            name: text.slice(0, 140),
            detail: "Message loaded in this browser",
            target: { ...chat.selection, session: message.session || chat.selection.session },
            message: message.id,
          });
      }
    return rows;
  }, [query, chat.swarms, chat.sessions, chat.messages, chat.selection]);
  const choose = (result: Result | undefined, full: boolean) => {
    if (!result) return;
    if (result.target) {
      if (
        !entry?.open(
          result.target,
          result.draft ? "dock" : full || result.message ? "full" : "dock",
          result.draft,
          result.message,
        )
      )
        return;
    } else {
      window.location.hash = result.hash ?? "";
    }
    onClose();
  };
  return (
    <Dialog
      className="qj"
      modal
      label="Quick jump"
      onDismiss={onClose}
      backdrop={{ className: "qj-backdrop", onClose }}
    >
      <input
        className="qj-input"
        data-autofocus
        aria-label="Jump to a conversation or command"
        placeholder="agent, message, > commands, @ agents, # conversations"
        value={query}
        role="combobox"
        aria-expanded="true"
        aria-controls="quick-jump-results"
        aria-activedescendant={results[index] ? `qj-result-${index}` : undefined}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((n) =>
              results.length
                ? (n + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length
                : 0,
            );
          }
          if (e.key === "Enter") {
            e.preventDefault();
            choose(results[index], !e.shiftKey);
          }
        }}
      />
      <div className="qj-sec">
        {query.startsWith("#")
          ? "Conversations loaded for the current bot"
          : "Agents and messages loaded in this browser"}
      </div>
      <div className="qj-list" id="quick-jump-results" role="listbox">
        {results.map((result, i) => (
          <button
            type="button"
            tabIndex={-1}
            data-focus-skip
            key={result.key}
            id={`qj-result-${i}`}
            className="qj-row"
            role="option"
            aria-selected={i === index}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(result, true)}
          >
            <span>{result.message ? "⌕" : result.hash !== undefined ? ">" : "↗"}</span>
            <span>
              <span className="qj-row-name">{result.name}</span>
              <span className="qj-row-sub">{result.detail}</span>
            </span>
          </button>
        ))}
        {results.length === 0 ? (
          <p className="qj-row">
            {chat.swarmsLoading ? "Reading agents…" : "No matches in loaded conversations."}
          </p>
        ) : null}
      </div>
      {chat.selectionError ? (
        <div role="alert" className="ch-band warn">
          {chat.selectionError}
        </div>
      ) : null}
      <div className="qj-foot">↑↓ choose · Enter full view · Shift+Enter dock · Esc close</div>
    </Dialog>
  );
}
