/**
 * Chat preferences change this laptop, never an agent or fleet setting. The
 * avatar style is kept in this browser; transcript redaction is core's
 * (`chat.settings`, a `prefs` row), because core is what masks a transcript and
 * the CLI on this machine has to agree.
 */
import { useEffect, useState } from "react";
import { setChatAvatarStyle, useChatAvatarStyle } from "../../chat/chat-appearance.ts";
import { Avatar } from "../../chat/components/avatar/Avatar.tsx";
import type { AvatarStyle } from "../../chat/components/avatar/Avatar.tsx";
import { chatSettings } from "../../api/chat.ts";
import { devtap } from "../../chat/devtap.ts";
import type { ChatSettingsView } from "../../api/types.ts";
import {
  Block,
  Callout,
  PageFoot,
  RowNote,
  SavedTick,
  SettingRow,
  SettingsPage,
  useSavedTick,
} from "./Section.tsx";
import "./ChatSection.css";

const STYLES: { value: AvatarStyle; label: string; description: string }[] = [
  { value: "blob", label: "Blob", description: "Layered, rounded shapes · default" },
  { value: "pixel", label: "Pixel", description: "Characters made from pixels" },
  { value: "sigil", label: "Sigil", description: "Mirrored geometric marks" },
];

/**
 * The redaction switch (§9.2). Off by default, so the warning is drawn
 * whenever it is off, not only after it is switched: an operator who never
 * opened this page is the one most in need of reading it.
 */
function RedactionBlock() {
  const [settings, setSettings] = useState<ChatSettingsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticked, flash] = useSavedTick();

  useEffect(() => {
    let live = true;
    // Through a promise, so a transport that refuses synchronously is an
    // error on the block rather than a throw out of the effect.
    Promise.resolve()
      .then(() => chatSettings())
      .then(
        (read) => {
          if (live) setSettings(read);
        },
        (e: unknown) => {
          if (live) setError(e instanceof Error ? e.message : String(e));
        },
      );
    return () => {
      live = false;
    };
  }, []);

  async function save(redact: boolean) {
    setBusy(true);
    setError(null);
    try {
      setSettings(await chatSettings({ redact }));
      // The inspector's page notes hold blocks as they were received; switching
      // masking on must not leave unmasked copies behind (`chat/devtap.ts`).
      if (redact) devtap.clear();
      flash();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Block title="Privacy" right={<SavedTick on={ticked} />}>
      <SettingRow
        label="Redact secrets"
        desc="Mask keys, tokens and passwords in transcripts before they reach this screen."
        htmlFor="chat-redact"
        field="redact"
        state={settings === null ? null : <RowNote>{settings.redact ? "masking" : "showing"}</RowNote>}
      >
        <label className="st-check">
          <input
            id="chat-redact"
            type="checkbox"
            checked={settings?.redact ?? false}
            disabled={settings === null || busy}
            onChange={(e) => void save(e.target.checked)}
            aria-label="Redact secrets in transcripts"
          />
          on
        </label>
      </SettingRow>
      {settings !== null && !settings.redact ? (
        <Callout tone="warn">
          Redaction is off. Transcripts show exactly what the box wrote — a key a bot echoed, a token in
          a tool result — here and in <code>hermetic chat</code> on this laptop. Turn it on before
          sharing your screen. Errors are masked either way.
        </Callout>
      ) : null}
      {error !== null ? <Callout tone="bad">{error}</Callout> : null}
    </Block>
  );
}

export function ChatSection() {
  const selected = useChatAvatarStyle();
  const [ticked, flash] = useSavedTick();
  return (
    <SettingsPage
      section="chat"
      scope="laptop"
      desc="Changes apply at once; the avatar style is kept in this browser."
    >
      <Block title="Appearance" right={<SavedTick on={ticked} />}>
        <fieldset className="chat-avatar-options">
          <legend>Avatar style</legend>
          <div className="chat-avatar-options-grid">
            {STYLES.map(({ value, label, description }) => (
              <label className="chat-avatar-option" key={value} data-selected={selected === value}>
                <input
                  type="radio"
                  name="chat-avatar-style"
                  value={value}
                  checked={selected === value}
                  aria-label={label}
                  onChange={() => {
                    setChatAvatarStyle(value);
                    flash();
                  }}
                />
                <span aria-hidden="true" className="chat-avatar-preview">
                  <Avatar
                    fleet_id="appearance-preview"
                    instance="agent"
                    bot="default"
                    size={64}
                    status="ready"
                    activity="idle"
                    style={value}
                  />
                </span>
                <strong>{label}</strong>
                <span className="st-sl-d">{description}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </Block>
      <RedactionBlock />
      <PageFoot>saves as you change it · this laptop only</PageFoot>
    </SettingsPage>
  );
}
