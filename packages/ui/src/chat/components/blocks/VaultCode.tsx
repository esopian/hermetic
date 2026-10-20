/**
 * `question` carrying `vault_code` — a site's one-time 2FA code the agent's
 * vault asked for (`vault.code`). A masked code field, the hint when there is
 * one, Submit and Skip, answered through the same `chat.respond` as a single
 * question (core sends it as the request's `value`). The code is a credential:
 * it lives in this component only until it is sent or skipped, and the settled
 * card never shows it.
 */
import { useContext, useId, useState } from "react";
import type { ReactNode } from "react";
import type { ChatBlockOf } from "../../../api/index.ts";
import type { ClosedRequest } from "../../chat-requests.ts";
import { BotResponses, Failure, SENT, useSubmit } from "../BotResponses.tsx";

export function VaultCodeCard({
  block,
  now = Date.now(),
  closed,
}: {
  block: ChatBlockOf<"question">;
  now?: number;
  closed?: ClosedRequest;
}) {
  const respond = useContext(BotResponses);
  const id = useId();
  const { state, busy, submit, settled } = useSubmit(respond);
  const [code, setCode] = useState("");
  const [skipped, setSkipped] = useState(false);
  const site = block.vault_code?.site ?? null;
  const hint = block.vault_code?.hint ?? null;
  const request_id = block.request_id ?? null;
  const expired = !!block.expires_at && Date.parse(block.expires_at) < now;
  const shut = closed && closed.kind !== "answered" ? closed.kind : null;
  const live = !!respond && !!request_id && !shut && !expired;

  const send = (skip: boolean) => {
    if (!request_id || busy) return;
    const answer = code.trim();
    if (!skip && !answer) return;
    setCode("");
    setSkipped(skip);
    void submit(
      skip ? { request_id, kind: "question", skip: true } : { request_id, kind: "question", answer },
    );
  };

  let body: ReactNode;
  if (settled)
    body = (
      <p className="bm-note">
        {state !== SENT ? state : skipped ? "Skipped. No code sent." : "Code sent."}
      </p>
    );
  else if (shut || expired) body = <p className="bm-note">Request closed. No code sent.</p>;
  else if (!live) body = <p className="bm-note">Respond in Hermes to enter the code.</p>;
  else
    body = (
      <form
        className="bm-request-actions"
        onSubmit={(e) => {
          e.preventDefault();
          send(false);
        }}
      >
        {hint ? <p className="bm-note">{hint}</p> : null}
        <input
          className="bm-other-input"
          id={id}
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label={site ? `Verification code for ${site}` : "Verification code"}
          placeholder="Code"
          disabled={busy}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <div className="bm-question-foot">
          <button className="btn bm-skip" type="button" disabled={busy} onClick={() => send(true)}>
            Skip
          </button>
          <button className="btn btn-primary" type="submit" disabled={busy || !code.trim()}>
            Submit
          </button>
        </div>
        <Failure state={state} />
      </form>
    );

  return (
    <div className={live && !settled ? "ch-card acc bm-clarify" : "ch-card muted bm-clarify"}>
      <div className="ch-card-head">
        <span>Enter verification code</span>
        {site ? <span className="right">{site}</span> : null}
      </div>
      <div className="ch-card-body">{body}</div>
    </div>
  );
}
