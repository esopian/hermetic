/**
 * The page's half of the developer tools (§9.2 "Developer tools").
 *
 * Three things, each costing nothing while the tools are off:
 *
 * - **The gate** (`DevtoolsProvider`, `useDevtools`): whether the tools are on,
 *   which conversation the inspector is open on, and how wide it is. Seeded
 *   from `meta.get`, which carries `devtools.enabled` so a laptop with the
 *   tools off makes no request it did not make before; the whole settings row
 *   is read only once the tools are on. Every entry point — the Inspect chip,
 *   the dock's `{ }`, the message action, the shortcut, the quick-jump
 *   commands — renders only when `enabled` is true.
 * - **The page's reducer notes** (`devtap`, T3): what the page's turn reducer
 *   did with each frame — a new block, a replacement and its version, an
 *   appended delta, a frame dropped as stale or duplicate, a live message
 *   replaced by a transcript read. Only the page can see this, so it is
 *   recorded here rather than by core. The chat store calls it behind a single
 *   boolean (`devtap.on`), so with the tools off a frame costs one property
 *   read. Bounded per conversation to the same `keep` core's ring uses.
 * - **A tap** (`useTap`): one mounted inspector's subscription to core's
 *   capture of one conversation. Opened when the inspector mounts and closed
 *   (`devtools.untap`) when it unmounts or its conversation changes; nothing is
 *   subscribed while no inspector is on screen.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { devtoolsClear, devtoolsSettings, devtoolsTap } from "../api/devtools.ts";
import type { DevtoolsSettingsView, TapRecordView } from "../api/types.ts";
import { devtap, type Capture } from "../chat/devtap.ts";
import {
  conversationKey,
  sameConversation,
  upsertBounded,
  type ConversationRef,
  type PageNote,
} from "../chat/inspector-logic.ts";
import { useFleetIfAvailable } from "./state.tsx";

export { devtap };

/** The page's notes for one conversation, re-read whenever one is added. */
export function usePageNotes(conversation: ConversationRef): readonly PageNote[] {
  const key = conversationKey(conversation);
  const [notes, setNotes] = useState(() => devtap.notesFor(conversation));
  useEffect(() => {
    setNotes(devtap.notesFor(conversation));
    // A fresh array each time: the capture appends in place.
    return devtap.subscribe(conversation, () => setNotes([...devtap.notesFor(conversation)]));
    // `key` names the conversation; the object may be rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return notes;
}

/* ── the gate ────────────────────────────────────────────────────────────── */

export interface InspectorTarget {
  conversation: ConversationRef;
  /** A message to filter to (`message:<id>`), when it was opened from one. */
  message: string | null;
  /** Bumped on every open, so reopening on the same message re-applies its filter. */
  nonce: number;
}

export interface DevtoolsGate {
  enabled: boolean;
  /** The whole row, once read; null while the tools are off or before the read lands. */
  settings: DevtoolsSettingsView | null;
  /** A write this window made, from Settings › Developer. */
  saved: (settings: DevtoolsSettingsView) => void;
  inspector: InspectorTarget | null;
  open: (conversation: ConversationRef, message?: string | null) => void;
  close: () => void;
  /** Open on this conversation, or close if it is the one open. */
  toggle: (conversation: ConversationRef) => void;
  isOpenOn: (conversation: ConversationRef | null) => boolean;
  width: number;
  setWidth: (px: number) => void;
}

const WIDTH_KEY = "hermetic.inspector.width";
export const INSPECTOR_MIN_WIDTH = 360;
export const INSPECTOR_DEFAULT_WIDTH = 560;

function readWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(raw) && raw >= INSPECTOR_MIN_WIDTH ? raw : INSPECTOR_DEFAULT_WIDTH;
  } catch {
    return INSPECTOR_DEFAULT_WIDTH;
  }
}

const OFF: DevtoolsGate = {
  enabled: false,
  settings: null,
  saved: () => {},
  inspector: null,
  open: () => {},
  close: () => {},
  toggle: () => {},
  isOpenOn: () => false,
  width: INSPECTOR_DEFAULT_WIDTH,
  setWidth: () => {},
};

const DevtoolsContext = createContext<DevtoolsGate>(OFF);

/** The gate, or the tools-off gate outside a provider. */
export function useDevtools(): DevtoolsGate {
  return useContext(DevtoolsContext);
}

export function DevtoolsProvider({ children }: { children: ReactNode }) {
  const fleet = useFleetIfAvailable();
  const fromMeta = (fleet?.meta as { devtools?: { enabled?: boolean } } | null | undefined)?.devtools
    ?.enabled;
  const [local, setLocal] = useState<DevtoolsSettingsView | null>(null);
  const [inspector, setInspector] = useState<InspectorTarget | null>(null);
  const [width, setWidthState] = useState(readWidth);
  const nonce = useRef(0);

  // A boot or refresh read that disagrees with this window's last write is
  // newer than it — another window, or the CLI, moved the switch.
  const lastMeta = useRef(fromMeta);
  useEffect(() => {
    if (lastMeta.current === fromMeta) return;
    lastMeta.current = fromMeta;
    setLocal((held) => (held !== null && held.enabled !== fromMeta ? null : held));
  }, [fromMeta]);

  const enabled = local?.enabled ?? fromMeta === true;

  // The row itself is read only once the tools are on: capture and keep
  // configure the page's own notes.
  useEffect(() => {
    if (!enabled || local !== null) return;
    let live = true;
    Promise.resolve()
      .then(() => devtoolsSettings())
      .then(
        (read) => {
          if (live) setLocal(read);
        },
        () => {},
      );
    return () => {
      live = false;
    };
  }, [enabled, local]);

  useEffect(() => {
    devtap.configure(
      enabled
        ? {
            enabled: true,
            ...(local ? { capture: local.capture as Capture, keep: local.keep as number } : {}),
          }
        : { enabled: false },
    );
    if (!enabled) setInspector(null);
  }, [enabled, local]);

  const open = useCallback((conversation: ConversationRef, message: string | null = null) => {
    nonce.current += 1;
    setInspector({
      conversation: {
        instance: conversation.instance,
        bot: conversation.bot,
        session: conversation.session,
      },
      message,
      nonce: nonce.current,
    });
  }, []);
  const close = useCallback(() => setInspector(null), []);
  const toggle = useCallback((conversation: ConversationRef) => {
    setInspector((current) => {
      if (sameConversation(current?.conversation ?? null, conversation)) return null;
      nonce.current += 1;
      return {
        conversation: {
          instance: conversation.instance,
          bot: conversation.bot,
          session: conversation.session,
        },
        message: null,
        nonce: nonce.current,
      };
    });
  }, []);
  const setWidth = useCallback((px: number) => {
    const next = Math.max(INSPECTOR_MIN_WIDTH, Math.round(px));
    setWidthState(next);
    try {
      window.localStorage.setItem(WIDTH_KEY, String(next));
    } catch {
      // A width that is not remembered is still applied.
    }
  }, []);

  const value = useMemo<DevtoolsGate>(
    () =>
      enabled
        ? {
            enabled: true,
            settings: local,
            saved: setLocal,
            inspector,
            open,
            close,
            toggle,
            isOpenOn: (c) => c !== null && sameConversation(inspector?.conversation ?? null, c),
            width,
            setWidth,
          }
        : { ...OFF, saved: setLocal },
    [enabled, local, inspector, open, close, toggle, width, setWidth],
  );
  return createElement(DevtoolsContext.Provider, { value }, children);
}

/* ── a tap ───────────────────────────────────────────────────────────────── */

export type TapStatus = "opening" | "live" | "ended";

export interface TapView {
  records: readonly TapRecordView[];
  status: TapStatus;
  failure: { code: string; message: string } | null;
  paused: boolean;
  setPaused: (paused: boolean) => void;
  /** Records held while paused, not yet drawn. */
  held: number;
  /** Records this inspector's own ring let fall off. */
  evicted: number;
  /** When the first record this inspector holds was captured. */
  since: number | null;
  clear: () => Promise<void>;
}

/**
 * One inspector's subscription to core's capture of one conversation: the
 * backlog, then live records, bounded to `keep`. Closed on unmount and on a
 * conversation change.
 */
export function useTap(conversation: ConversationRef, keep: number): TapView {
  const key = conversationKey(conversation);
  const [records, setRecords] = useState<readonly TapRecordView[]>([]);
  const [status, setStatus] = useState<TapStatus>("opening");
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null);
  const [paused, setPausedState] = useState(false);
  const [held, setHeld] = useState(0);
  const [evicted, setEvicted] = useState(0);
  const pausedRef = useRef(false);
  const holding = useRef<TapRecordView[]>([]);
  const keepRef = useRef(keep);
  keepRef.current = keep;

  const append = useCallback((batch: readonly TapRecordView[]) => {
    setRecords((ring) => {
      const next = upsertBounded(ring, batch, keepRef.current);
      if (next.evicted > 0) setEvicted((n) => n + next.evicted);
      return next.ring;
    });
  }, []);

  useEffect(() => {
    setRecords([]);
    setStatus("opening");
    setFailure(null);
    setEvicted(0);
    holding.current = [];
    setHeld(0);
    const release = devtap.watch(conversation);
    let live = true;
    const close = devtoolsTap(
      { instance: conversation.instance, bot: conversation.bot, session: conversation.session },
      {
        onRecords: (batch) => {
          if (!live) return;
          setStatus("live");
          if (pausedRef.current) {
            const next = upsertBounded(holding.current, batch, keepRef.current);
            holding.current = next.ring;
            setHeld(next.ring.length);
            return;
          }
          append(batch);
        },
        onEnd: (why) => {
          if (!live) return;
          setStatus("ended");
          setFailure(why);
        },
      },
    );
    return () => {
      live = false;
      close();
      release();
    };
    // `key` names the conversation; the object may be rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, append]);

  const setPaused = useCallback(
    (next: boolean) => {
      pausedRef.current = next;
      setPausedState(next);
      if (!next && holding.current.length > 0) {
        append(holding.current);
        holding.current = [];
        setHeld(0);
      }
    },
    [append],
  );

  const clear = useCallback(async () => {
    await devtoolsClear({
      instance: conversation.instance,
      bot: conversation.bot,
      session: conversation.session,
    });
    devtap.clear(conversation);
    holding.current = [];
    setHeld(0);
    setRecords([]);
    setEvicted(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return {
    records,
    status,
    failure,
    paused,
    setPaused,
    held,
    evicted,
    since: records[0]?.at ?? null,
    clear,
  };
}
