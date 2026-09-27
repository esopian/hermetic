import { useChatEntry } from "../chat-entry-state.tsx";
import { useListeningIfAvailable } from "../../state/listening-state.tsx";

/**
 * Keep the card's details action separate from its direct conversation entry.
 *
 * **Chat on an unwatched box is disabled, not automatic.** Listening is opt-in,
 * local and per fleet (§4.9): a click here starting it would turn a button that
 * reads one conversation into a standing preference change, and the operator
 * who wanted the one conversation would not be told. So the button is disabled
 * and says what to do instead.
 *
 * The title sits on the wrapper rather than on the button, because a disabled
 * control takes no pointer events in most browsers and its own `title` never
 * appears — which is how this arrived looking like an enabled button that did
 * nothing when clicked.
 */
export function FleetChatButton({ instance }: { instance: string }) {
  const entry = useChatEntry();
  const listening = useListeningIfAvailable();
  if (!entry) return null;
  const watched = !listening || listening.instances.includes(instance);
  const why = watched ? `Chat with ${instance}` : `Start listening to ${instance} to chat with it`;
  return (
    <span className="ch-direct" title={why}>
      <button
        type="button"
        className="btn btn-sm"
        aria-label={`Chat with ${instance}`}
        disabled={!watched}
        aria-disabled={!watched}
        title={why}
        onClick={(e) => {
          e.stopPropagation();
          if (!watched) return;
          entry.open({ instance, bot: "default", session: null }, "drawer");
        }}
      >
        Chat
      </button>
    </span>
  );
}
