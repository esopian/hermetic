import { useState } from "react";
import { useListeningIfAvailable } from "../state/listening-state.tsx";

export function ListeningSignal({ on }: { on: boolean }) {
  return (
    <svg
      className="listening-signal"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path className="listening-wave" d="M4 9v6M8 5v14M12 2v20M16 5v14M20 9v6" />
      <path className="listening-mute" data-muted={!on} d="m2 2 20 20" />
    </svg>
  );
}

/** Listening opts an instance and all of its bots into chat and alerts. */
export function ListenButton({ instance }: { instance: string }) {
  const listening = useListeningIfAvailable();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  if (!listening) return null;
  const confirmed = listening.instances.includes(instance);
  const on = optimistic ?? confirmed;
  const pending = listening.pending.includes(instance) || optimistic !== null;
  const toggle = async () => {
    setOptimistic(!confirmed);
    try {
      await listening.setListening(instance, !confirmed);
    } finally {
      setOptimistic(null);
    }
  };
  return (
    <button
      type="button"
      role="switch"
      className="btn listening-toggle"
      aria-label={`Listen to ${instance}`}
      aria-checked={on}
      aria-busy={pending}
      disabled={listening.loading || pending}
      title={
        on
          ? "Disconnect this instance from chat and alerts"
          : "Connect this instance to chat and alerts"
      }
      onClick={(event) => {
        event.stopPropagation();
        void toggle();
      }}
    >
      <span className="listening-toggle-thumb">
        <ListeningSignal on={on} />
      </span>
      <span className="listening-toggle-label">{on ? "Listening" : "Listen"}</span>
    </button>
  );
}

export function ListeningBand({ instance }: { instance: string }) {
  const listening = useListeningIfAvailable();
  if (!listening) return null;
  const on = listening.instances.includes(instance);
  return (
    <div className="listening-band" data-listening={on}>
      <ListeningSignal on={on} />
      <span>{on ? "Listening" : "Not listening"}</span>
      {on && <span className="listening-band-detail">Chat + alerts</span>}
    </div>
  );
}

export function ListeningConnection({ instance }: { instance: string }) {
  const listening = useListeningIfAvailable();
  if (!listening) return null;
  const on = listening.instances.includes(instance);
  return (
    <div className="listening-connection" data-listening={on}>
      <span className="mono">{on ? "Chat & alerts connected" : "Chat & alerts off"}</span>
      <ListenButton instance={instance} />
    </div>
  );
}

export function ListeningMark({ instance }: { instance: string }) {
  const listening = useListeningIfAvailable();
  if (!listening?.instances.includes(instance)) return null;
  return (
    <span
      className="listening-indicator"
      role="img"
      title="Listening · chat and alerts connected"
      aria-label="Listening"
    >
      <ListeningSignal on />
    </span>
  );
}

/** Errors remain visible even when one or more instances are already watched. */
export function ListeningNotice({ instances }: { instances: string[] }) {
  const listening = useListeningIfAvailable();
  if (!listening || listening.loading) return null;
  const watched = instances.some((instance) => listening.instances.includes(instance));
  if (watched && !listening.error) return null;
  return (
    <div className="skew-wrap">
      <div className="skew-band warn" role="alert">
        <div className="skew-text">
          <b>
            {listening.error
              ? "Listening settings could not be saved or loaded"
              : "No instances are being watched"}
          </b>
          <p>
            {listening.error ??
              "Choose Listen on an instance to connect its bots to chat and receive alerts."}
          </p>
        </div>
        {listening.error ? (
          <button type="button" className="btn btn-sm" onClick={() => void listening.refresh()}>
            Reload settings
          </button>
        ) : null}
      </div>
    </div>
  );
}
