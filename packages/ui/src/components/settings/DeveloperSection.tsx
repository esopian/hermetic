/**
 * Settings › This laptop › Developer (§9.2 "Developer tools").
 *
 * The switch is core's (`devtools.settings`, a `prefs` row), like Chat's
 * redaction switch, so the main process gates the capture without asking the
 * page. Off by default, in every build: nothing it turns on depends on a dev
 * renderer or the DevTools port.
 *
 * With the switch off, only the switch is drawn. The page shows only what is
 * built: one tool, the stream inspector.
 */
import { useCallback, useEffect, useState } from "react";
import { chatSettings } from "../../api/chat.ts";
import { devtoolsClear, devtoolsSettings, devtoolsStats } from "../../api/devtools.ts";
import type { DevtoolsSettingsView, DevtoolsStatsView } from "../../api/types.ts";
import { fmtBytes, fmtCount } from "../../chat/inspector-logic.ts";
import { settingsHash } from "../../nav/settings-nav.ts";
import { devtap, useDevtools } from "../../state/devtools-store.ts";
import {
  Block,
  Callout,
  Facts,
  PageFoot,
  RowNote,
  SavedTick,
  SettingRow,
  SettingsPage,
  TextAction,
  useSavedTick,
} from "./Section.tsx";

const CAPTURES: { value: DevtoolsSettingsView["capture"]; label: string }[] = [
  { value: "always", label: "While tools are on" },
  { value: "while_open", label: "While open" },
];

const KEEPS: DevtoolsSettingsView["keep"][] = [1000, 5000, 20000];

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function DeveloperSection() {
  const gate = useDevtools();
  const [settings, setSettings] = useState<DevtoolsSettingsView | null>(null);
  const [stats, setStats] = useState<DevtoolsStatsView | null>(null);
  const [redact, setRedact] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticked, flash] = useSavedTick();

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => devtoolsSettings())
      .then(
        (read) => {
          if (live) setSettings(read);
        },
        (e: unknown) => {
          if (live) setError(message(e));
        },
      );
    return () => {
      live = false;
    };
  }, []);

  const enabled = settings?.enabled ?? false;

  const readStats = useCallback(async () => {
    try {
      setStats(await devtoolsStats());
    } catch {
      // Refused while off; the facts are simply not drawn.
      setStats(null);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStats(null);
      return;
    }
    void readStats();
    let live = true;
    Promise.resolve()
      .then(() => chatSettings())
      .then(
        (s) => {
          if (live) setRedact(s.redact);
        },
        () => {},
      );
    return () => {
      live = false;
    };
  }, [enabled, readStats]);

  async function save(input: Partial<DevtoolsSettingsView>) {
    setBusy(true);
    setError(null);
    try {
      const next = await devtoolsSettings(input);
      setSettings(next);
      gate.saved(next);
      flash();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    setError(null);
    try {
      await devtoolsClear();
      // The page's own reducer notes are part of the capture too.
      devtap.clear();
      await readStats();
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <SettingsPage
      section="developer"
      scope="laptop"
      desc="Debugging tools for this app. They see what the box sends, exactly as it was sent."
    >
      <Block title="Developer tools" right={<SavedTick on={ticked} />}>
        <SettingRow
          label="Enable developer tools"
          desc="Shows the Inspect chip in chat and starts keeping a stream capture in memory."
          htmlFor="devtools-enabled"
          field="enabled"
          state={<RowNote>saves at once</RowNote>}
        >
          <label className="st-check">
            <input
              id="devtools-enabled"
              type="checkbox"
              checked={enabled}
              disabled={settings === null || busy}
              onChange={(e) => void save({ enabled: e.target.checked })}
              aria-label="Enable developer tools"
            />
            on
          </label>
        </SettingRow>
        {error !== null ? <Callout tone="bad">{error}</Callout> : null}
      </Block>
      {settings !== null && enabled ? (
        <>
          <Block title="Tools" right={<span className="st-def">1 on</span>}>
            <SettingRow
              label="Stream inspector"
              desc="An Inspect chip in each thread header opens wire, frames and state for that conversation."
              field="inspector"
              state={<RowNote>⌥⌘I in chat</RowNote>}
            >
              <span className="mono st-def">on</span>
            </SettingRow>
          </Block>
          <Block
            title="Capture"
            right={
              <TextAction onClick={() => void clearAll()} label="Clear captures">
                Clear captures
              </TextAction>
            }
          >
            {stats !== null ? (
              <Facts
                items={[
                  { k: "Conversations", v: fmtCount(stats.conversations) },
                  { k: "Events held", v: fmtCount(stats.records) },
                  { k: "Memory", v: fmtBytes(stats.bytes) },
                  {
                    k: "Dropped (ring)",
                    v: fmtCount(stats.dropped),
                    ...(stats.dropped > 0 ? { tone: "warn" as const } : {}),
                  },
                ]}
              />
            ) : null}
            <SettingRow
              label="When to capture"
              desc="While open captures only while an inspector is open; the default keeps history to look back on."
              field="capture"
              state={<RowNote>saves at once</RowNote>}
            >
              <div className="seg st-seg nt-seg" role="group" aria-label="When to capture">
                {CAPTURES.map((c) => (
                  <button
                    type="button"
                    key={c.value}
                    aria-pressed={settings.capture === c.value}
                    disabled={busy}
                    onClick={() => void save({ capture: c.value })}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </SettingRow>
            <SettingRow
              label="Keep per conversation"
              desc="A ring of the newest events; older ones fall off and are counted."
              field="keep"
              state={<RowNote>saves at once</RowNote>}
            >
              <div className="seg st-seg nt-seg" role="group" aria-label="Keep per conversation">
                {KEEPS.map((k) => (
                  <button
                    type="button"
                    key={k}
                    aria-pressed={settings.keep === k}
                    disabled={busy}
                    onClick={() => void save({ keep: k })}
                  >
                    {fmtCount(k)}
                  </button>
                ))}
              </div>
            </SettingRow>
            <SettingRow
              label="Masking in the inspector"
              desc={
                <>
                  Follows <a href={settingsHash("chat")}>Chat › Redact secrets</a>. Copies are always
                  masked.
                </>
              }
              field="masking"
              state={<RowNote>follows Chat</RowNote>}
            >
              <span className="mono st-def">
                {redact === null ? "—" : redact ? "masking · from Chat" : "showing · from Chat"}
              </span>
            </SettingRow>
            <Callout tone="info">
              Captures live only in this app's memory. They are cleared on quit and never written to
              disk; Copy in the inspector is always masked.
            </Callout>
          </Block>
        </>
      ) : null}
      <PageFoot>saves as you change it · this laptop only</PageFoot>
    </SettingsPage>
  );
}
