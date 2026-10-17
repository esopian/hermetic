/**
 * One keyboard-owned dialog. It searches what the page already holds and never
 * asks a box for more; in the Chat view it searches conversations first.
 */
import { useMemo, useState } from "react";
import { botLabel } from "../chat-presentation.ts";
import type { ChatSelection } from "../chat-state.tsx";
import { useChat } from "../chat-state.tsx";
import { useChatEntry } from "../chat-entry-state.tsx";
import { conversationCandidates } from "../conversation-search.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { FLEET_HASH } from "../../nav/fleet-nav.ts";
import { useDevtools } from "../../state/devtools-store.ts";

interface Result {
  key: string;
  name: string;
  detail: string;
  target?: ChatSelection;
  draft?: string;
  hash?: string;
  /** A command that does something rather than going somewhere. */
  run?: () => boolean;
}
const COMMANDS = [
  { name: "Chat", hash: "#chat" },
  { name: "Fleet", hash: "#fleet" },
  { name: "Volumes", hash: "#fleet/volumes" },
  { name: "Settings", hash: "#settings" },
  { name: "Run log", hash: "#settings/runs" },
];

/**
 * `chatMode` is the Chat view being on screen: there, a query with no prefix is
 * a conversation search, conversations listed before agents and bots (after
 * an exact-alias quick send, which always leads).
 */
export function QuickJump({ onClose, chatMode = false }: { onClose: () => void; chatMode?: boolean }) {
  const chat = useChat();
  const entry = useChatEntry();
  const devtools = useDevtools();
  const [query, setQuery] = useState("");
  // The highlighted row is held by key, not position: conversation rows arrive
  // with the session and roster reads, after the dialog opened, and a held
  // position would move the highlight to another row or past the end.
  const [selected, setSelected] = useState<string | null>(null);
  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.startsWith(">")) {
      const commands: Result[] = COMMANDS.map((c) => ({
        ...c,
        key: c.name,
        detail: "Open existing view",
      }));
      // The developer tools' two commands exist only while the tools are on.
      if (devtools.enabled) {
        const selection = chat.selection;
        if (selection)
          commands.push({
            key: "devtools:inspect",
            name: "Inspect stream",
            detail: `${selection.instance} / ${selection.bot} · ⌥⌘I`,
            run: () => {
              if (!entry?.open(selection, "full")) return false;
              devtools.open(selection);
              return true;
            },
          });
        commands.push({
          key: "devtools:settings",
          name: "Open Settings › Developer",
          detail: "Developer tools",
          hash: "#settings/developer",
        });
      }
      return commands.filter((c) => c.name.toLowerCase().includes(q.slice(1).trim()));
    }
    const rows: Result[] = [];
    const conversations: Result[] = [];
    if (chatMode && !/^[#@>]/.test(q))
      for (const found of conversationCandidates({
        swarms: chat.swarms,
        sessions: chat.sessions,
        selection: chat.selection,
        query: q,
      }))
        conversations.push({
          key: `conversation:${found.target.instance}/${found.target.bot}/${found.target.session}`,
          name: found.title ?? found.label,
          detail:
            [found.title ? found.label : null, found.preview].filter(Boolean).join(" · ") ||
            `${found.target.instance}/${found.target.bot}`,
          target: found.target,
        });
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
    // `<alias> <text>` is a message for that bot. Its row leads, so Enter
    // sends it rather than opening a conversation the text happens to match.
    const drafts = rows.filter((row) => row.draft !== undefined);
    return [...drafts, ...conversations, ...rows.filter((row) => row.draft === undefined)];
  }, [query, chatMode, chat.swarms, chat.sessions, chat.selection, devtools, entry]);
  const found = results.findIndex((result) => result.key === selected);
  const index = found < 0 ? 0 : found;
  const choose = (result: Result | undefined, full: boolean) => {
    if (!result) return;
    if (result.run) {
      if (!result.run()) return;
    } else if (result.target) {
      if (!entry?.open(result.target, result.draft ? "dock" : full ? "full" : "dock", result.draft))
        return;
    } else {
      window.location.hash = result.hash ?? FLEET_HASH;
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
        placeholder={
          chatMode
            ? "Search conversations…  > commands, @ agents, # this bot"
            : "agent, > commands, @ agents, # conversations"
        }
        value={query}
        role="combobox"
        aria-expanded="true"
        aria-controls="quick-jump-results"
        aria-activedescendant={results[index] ? `qj-result-${index}` : undefined}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(null);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            const next = results[(index + step + results.length) % results.length];
            if (next) setSelected(next.key);
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
          : query.startsWith(">")
            ? "Commands"
            : chatMode && !query.startsWith("@")
              ? "Conversations and agents"
              : "Agents and bots"}
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
            <span>
              {result.hash !== undefined || result.run !== undefined
                ? ">"
                : result.target?.session
                  ? "#"
                  : "↗"}
            </span>
            <span>
              <span className="qj-row-name">{result.name}</span>
              <span className="qj-row-sub">{result.detail}</span>
            </span>
          </button>
        ))}
        {results.length === 0 ? (
          <p className="qj-row">{chat.swarmsLoading ? "Reading agents…" : "No matches."}</p>
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
