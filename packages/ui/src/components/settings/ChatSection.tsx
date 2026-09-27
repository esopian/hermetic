/** Chat preferences change the viewer's browser, never an agent or fleet setting. */
import { setChatAvatarStyle, useChatAvatarStyle } from "../../chat/chat-appearance.ts";
import { Avatar } from "../../chat/components/avatar/Avatar.tsx";
import type { AvatarStyle } from "../../chat/components/avatar/Avatar.tsx";
import { Block, PageFoot, SavedTick, SettingsPage, useSavedTick } from "./Section.tsx";
import "./ChatSection.css";

const STYLES: { value: AvatarStyle; label: string; description: string }[] = [
  { value: "blob", label: "Blob", description: "Layered, rounded shapes · default" },
  { value: "pixel", label: "Pixel", description: "Characters made from pixels" },
  { value: "sigil", label: "Sigil", description: "Mirrored geometric marks" },
];

export function ChatSection() {
  const selected = useChatAvatarStyle();
  const [ticked, flash] = useSavedTick();
  return (
    <SettingsPage
      section="chat"
      scope="laptop"
      desc="How chat looks on this laptop. Changes apply at once and are kept in this browser."
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
      <PageFoot>saves as you change it · this browser only</PageFoot>
    </SettingsPage>
  );
}
