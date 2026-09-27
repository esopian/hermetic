/**
 * Step 3 of the init wizard, taken apart.
 *
 * "Create the foundation" is five separate errands — confirm the tailnet, paste
 * one line into the tailnet policy, make an OAuth client, turn on HTTPS
 * certificates, paste the client secret — and four of them happen in a browser
 * tab that is not this one. Stacked on one scroll they read as a wall, and an
 * operator who came back from the Tailscale admin console had no way to see how
 * far through they were. Each is a section now, numbered, with a tick that goes
 * green when hermetic can *prove* it is done rather than when the operator has
 * scrolled past it.
 *
 * Still one step: nothing here gates anything the old layout did not gate, and
 * Initialize still opens on `initBlockedReason` alone.
 */
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AclSnippet, InitOauthCheck, InitTailscale } from "../api/index.ts";
import {
  TAILSCALE_ADMIN_ACL_URL,
  TAILSCALE_ADMIN_DNS_URL,
  TAILSCALE_ADMIN_OAUTH_URL,
  TAILSCALE_DOWNLOAD_URL,
} from "../logic/format.ts";
import { ScanBar } from "./Loading.tsx";

/** Anything a pasted value must look like before a probe key is minted for it. */
export const OAUTH_SECRET_SHAPE = /^tskey-client-[A-Za-z0-9]+-\S+$/;

export type OauthTone = "ok" | "bad" | "quiet";
export const OAUTH_TONE: Record<OauthTone, string> = {
  ok: "var(--ok)",
  bad: "var(--bad)",
  quiet: "var(--fg3)",
};

/** The two policy-scope shortfalls, as the note the field shows for each. */
export const POLICY_READ_NOTE =
  "the client can read but not write the policy file: hermetic will print the entries for you to paste";
export const POLICY_NONE_NOTE = "no Policy File scope: init will not touch the policy file";

/** "a", "a and b", "a, b and c" — the capability list, said the way a person would. */
function joinCapabilities(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

/**
 * What the client-secret field says about the pasted value, as data rather than
 * as three nested ternaries inside the form — because there are now three
 * independent answers on one check and the interesting ones are easy to render
 * wrong.
 *
 * `ok` is the mint alone. A client that mints but cannot list devices, or
 * cannot write the policy file, is *verified*: that is exactly what every fleet
 * created before hermetic asked for those scopes carries, Initialize stays open,
 * and the shortfall is a separate yellow `note` — never a red verdict, which
 * would tell an operator to go back and fix something that is not broken.
 */
export function oauthVerdict(
  status: "idle" | "processing" | "done" | "error",
  secret: string,
  oauth: InitOauthCheck | null,
  error: string | null,
): { text: string; tone: OauthTone; note: string | null } {
  if (status === "idle") {
    return {
      text: OAUTH_SECRET_SHAPE.test(secret)
        ? "mints a tag:hermetic key and revokes it"
        : "expected tskey-client-…",
      tone: "quiet",
      note: null,
    };
  }
  if (status === "processing") {
    return { text: "minting a probe key…", tone: "quiet", note: null };
  }
  if (status === "error") {
    return { text: error ?? "could not verify", tone: "bad", note: null };
  }
  if (!oauth?.ok) {
    return { text: oauth?.problem ?? "this client cannot mint keys", tone: "bad", note: null };
  }
  const capabilities = ["mint tag:hermetic keys"];
  if (oauth.can_list_devices) capabilities.push("list devices");
  if (oauth.policy_scope === "write") capabilities.push("edit the policy file");
  const notes: string[] = [];
  if (!oauth.can_list_devices) {
    notes.push(oauth.problem ?? "this client lacks the Devices → Core scope");
  }
  // A shortfall on the policy file changes what `init` *does*, not whether it
  // may run, so it lands beside the device note rather than in the verdict.
  if (oauth.policy_scope === "read") notes.push(POLICY_READ_NOTE);
  else if (oauth.policy_scope === "none") notes.push(POLICY_NONE_NOTE);
  return {
    text: `can ${joinCapabilities(capabilities)}${oauth.revoked ? "" : " (probe key left to expire)"}`,
    tone: "ok",
    note: notes.length === 0 ? null : notes.join(" · "),
  };
}

/**
 * One numbered errand of step 3, with a heading, a tick and an optional action
 * button on the right (the admin-console links live there).
 *
 * `done` is only ever set from something hermetic actually observed — a
 * confirmed tailnet, a mint that succeeded, a non-empty `cert_domains`. There is
 * no "I did it" checkbox: a tick an operator can set themselves reports on their
 * memory, not on the tailnet.
 */
export function SubStep({
  n,
  title,
  done,
  optional = false,
  doneLabel = "done",
  action,
  children,
}: {
  /**
   * The number the Tailscale admin console walk uses. The tailnet section has
   * none on purpose: it is a reading of this machine, not an errand in another
   * tab, and renumbering the walk would renumber four screenshots' worth of
   * instructions that operators follow in order.
   */
  n?: number;
  title: string;
  done: boolean;
  /** Blank is allowed here, so an undone section is not a fault. */
  optional?: boolean;
  /**
   * What the green state is called, when "done" would claim more than was
   * proved. The policy section is the case: the only thing checkable from this
   * side is that the tag is owned, which is a third of what that section asks
   * for.
   */
  doneLabel?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={done ? "wiz-substep is-done" : "wiz-substep"}>
      <div className="acl-head">
        <div className="wiz-substep-head">
          <i
            className="wiz-substep-tick"
            style={{ background: done ? "var(--ok)" : "var(--line2)" }}
            aria-hidden="true"
          />
          <div className="kicker">{n === undefined ? title : `${n} · ${title}`}</div>
          <span className="wiz-substep-state mono">
            {done ? doneLabel : optional ? "optional" : "to do"}
          </span>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * One copyable block of the tailnet policy. Copy falls back to selecting the
 * text when the clipboard API is unavailable (plain-http origins other than
 * localhost) or refuses.
 */
function CopyBlock({ label, purpose, text }: { label: string; purpose?: string; text: string }) {
  const paneRef = useRef<HTMLPreElement | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");
  const copy = () => {
    const selectManually = () => {
      const pane = paneRef.current;
      const selection = window.getSelection();
      if (pane && selection) {
        const range = document.createRange();
        range.selectNodeContents(pane);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setCopyState("manual");
      setTimeout(() => setCopyState("idle"), 3000);
    };
    if (!navigator.clipboard) {
      selectManually();
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => {
        setCopyState("copied");
        setTimeout(() => setCopyState("idle"), 2000);
      },
      () => selectManually(),
    );
  };
  return (
    <div className="acl-part">
      <div className="acl-head">
        <div>
          <span className="mono acl-part-label">{label}</span>
          {purpose ? <span className="acl-part-purpose">{purpose}</span> : null}
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          style={{
            height: 30,
            fontSize: 11,
            ...(copyState === "manual" ? { borderColor: "var(--warn)", color: "var(--warn)" } : null),
          }}
          onClick={copy}
        >
          {copyState === "manual"
            ? "Select & copy manually"
            : copyState === "copied"
              ? "Copied"
              : "Copy"}
        </button>
      </div>
      <pre ref={paneRef} className="logpane acl-pane">
        {text}
      </pre>
    </div>
  );
}

/* ── 1 · the tailnet this machine is on ──────────────────────────────────── */

export function TailnetStep({
  ts,
  status,
  error,
  confirmed,
  onConfirm,
  onProbe,
}: {
  ts: InitTailscale | null;
  status: "idle" | "processing" | "done" | "error";
  error: string | null;
  confirmed: boolean;
  onConfirm: (v: boolean) => void;
  onProbe: () => void;
}) {
  return (
    <SubStep title="Tailnet" done={confirmed}>
      <div className="check-panel">
        <div className="check-head">
          <i
            className={`check-square${status === "processing" ? " pulse" : ""}`}
            style={{
              background:
                status === "done" && ts?.ok
                  ? "var(--ok)"
                  : status === "processing"
                    ? "var(--acc)"
                    : "var(--bad)",
            }}
          />
          <div className="check-title">
            {status === "processing"
              ? "Reading this machine's tailnet"
              : status === "done" && ts?.ok
                ? "This machine is on a tailnet"
                : status === "done" && ts && !ts.installed
                  ? "Tailscale is not installed"
                  : "This machine is not on a tailnet"}
          </div>
        </div>

        {status === "processing" ? (
          <>
            <div className="check-subline mono">tailscale status --json</div>
            <ScanBar />
          </>
        ) : null}

        {status === "done" && ts?.ok ? (
          <div className="check-fade">
            <div className="ident-card">
              <div className="kicker">Tailnet</div>
              <div className="ident-id ident-id-tailnet mono">{ts.tailnet}</div>
              <div className="kv" style={{ marginTop: 14 }}>
                <span className="k">this node</span>
                <span className="v">{ts.hostname ?? "—"}</span>
                <span className="k">address</span>
                <span className="v">{ts.addresses[0] ?? "—"}</span>
                <span className="k">daemon</span>
                <span className="v">{ts.backend_state ?? "—"}</span>
                <span className="k">https certs</span>
                <span className="v">{ts.cert_domains.length > 0 ? "on" : "off"}</span>
              </div>
            </div>
            <div className="found-line create" style={{ marginTop: 16 }}>
              Every agent joins <span className="mono">{ts.tailnet}</span> and nothing else · Serve URLs
              will be <span className="mono">&lt;name&gt;.{ts.tailnet}</span>
            </div>
          </div>
        ) : null}

        {status === "done" && ts && !ts.ok ? (
          <>
            <div className="check-error-box mono">
              {ts.problem ?? "tailscale is not usable on this machine"}
            </div>
            <div className="check-hint mono">
              Tailscale is the only way in to an agent, so a foundation created from here would be
              unreachable.{" "}
              {ts.installed
                ? "Bring it up on this machine, then re-check."
                : "Install it on this machine, sign in to your tailnet, then re-check."}
            </div>
            <div className="check-actions">
              {/*
               * The download page is the first step only when there is nothing
               * installed; a logged-out machine already has Tailscale and needs
               * `tailscale up`, so the link stays available but stops being the
               * primary action.
               */}
              <a
                className={`btn ${ts.installed ? "btn-secondary" : "btn-primary"} wiz-cta`}
                href={TAILSCALE_DOWNLOAD_URL}
                target="_blank"
                rel="noreferrer noopener"
              >
                {ts.installed ? "Get Tailscale ↗" : "Install Tailscale ↗"}
              </a>
              <button
                type="button"
                className={`btn ${ts.installed ? "btn-primary" : "btn-secondary"} wiz-cta`}
                onClick={onProbe}
              >
                Re-check
              </button>
            </div>
          </>
        ) : null}

        {status === "error" ? (
          <>
            <div className="check-error-box mono">{error}</div>
            <div className="check-actions">
              <button type="button" className="btn btn-primary wiz-cta" onClick={onProbe}>
                Retry
              </button>
            </div>
          </>
        ) : null}
      </div>

      {status === "done" && ts?.ok ? (
        <>
          <label
            className="verify-row check-fade"
            // Unlike step 2's, this row is inside a section that has no row gap
            // of its own to sit in.
            style={{ marginTop: 16 }}
          >
            <input
              type="checkbox"
              className="verify-check"
              checked={confirmed}
              onChange={(e) => onConfirm(e.target.checked)}
            />
            <span className="verify-label">
              This is the tailnet the fleet belongs to: <span className="mono">{ts.tailnet}</span>
            </span>
          </label>
          <div className="verify-sub mono check-fade" style={{ marginTop: 10 }}>
            Stamped on `_fleet` at create time and rendered into every agent&apos;s Serve config.
            Changing it later means re-rendering every agent.
          </div>
        </>
      ) : null}
    </SubStep>
  );
}

/* ── 2 · the tailnet policy file ─────────────────────────────────────────── */

export function PolicyStep({
  acl,
  showWholePolicy,
  onShowWholePolicy,
  managePolicy,
  onManagePolicy,
  tagOwned,
  scope,
}: {
  acl: AclSnippet | null;
  showWholePolicy: boolean;
  onShowWholePolicy: (v: boolean) => void;
  managePolicy: boolean;
  onManagePolicy: (v: boolean) => void;
  /**
   * The `tagOwners` line is in the policy file. Proved by the OAuth mint in
   * section 4 and by nothing else — which is why the tick says "tag owned" and
   * not "done": the `ssh` and `acls` blocks are a separate question, and this
   * section asks for all three.
   */
  tagOwned: boolean;
  /** What the verified client may do with the policy file; null before it verifies. */
  scope: InitOauthCheck["policy_scope"] | null;
}) {
  return (
    <SubStep
      n={1}
      title="Tailnet policy"
      done={tagOwned}
      doneLabel="tag owned"
      action={
        <a
          className="btn btn-secondary"
          style={{ height: 30, fontSize: 11 }}
          href={TAILSCALE_ADMIN_ACL_URL}
          target="_blank"
          rel="noreferrer noopener"
        >
          Open policy editor ↗
        </a>
      }
    >
      <div className="name-hint" style={{ color: "var(--fg3)", marginTop: 0, marginBottom: 10 }}>
        Paste this one line into your policy file&apos;s <span className="mono">tagOwners</span> and
        save. Do this first, and by hand: the OAuth client form only offers tags the policy already
        owns, so nothing hermetic could do with the API is available until this line exists. The{" "}
        <span className="mono">ssh</span> and <span className="mono">acls</span> rules are not yours to
        paste — hermetic writes those itself during init, through the API, when the client below carries
        Policy File write.
      </div>
      {/*
        The tick above is set by the *mint* in section 4, not by a checkbox
        here: a client that can mint `tag:hermetic` keys is proof the tagOwners
        entry landed, because Tailscale would not have offered the tag on the
        client form otherwise. It proves nothing about `ssh`/`acls`, so the
        state word is "tag owned" and the line below says who writes those.
      */}
      <div className="name-hint" style={{ color: "var(--fg3)", marginTop: 0, marginBottom: 10 }}>
        {tagOwned
          ? "tagOwners confirmed: the client in section 4 minted a tag:hermetic key, which Tailscale only allows for a tag the policy already owns."
          : "Ticks green once the client secret in section 4 verifies — that mint is the proof this one line landed."}{" "}
        {scope === null
          ? "Whether hermetic can write the ssh and acls blocks itself depends on that client's Policy File scope."
          : scope === "write"
            ? "The client carries Policy File write, so init writes the ssh and acls blocks itself — nothing here checks them, because they do not exist yet."
            : scope === "read"
              ? "That client can read but not write the policy file: init will print the ssh and acls blocks for you to paste."
              : "That client has no Policy File scope: init will not touch the file, so the ssh and acls blocks are yours to paste."}
      </div>
      {acl === null ? (
        <pre className="logpane acl-pane">reading the ACL snippet…</pre>
      ) : (
        <>
          {acl.parts
            .filter((part) => part.key === "tagOwners")
            .map((part) => (
              <CopyBlock
                key={part.key}
                label={`"${part.key}"`}
                purpose={part.purpose}
                text={part.body}
              />
            ))}
          {/*
            The fallback, for a policy that is deployed from git: a write from
            here would be reverted by the next deploy, so those operators want
            all three blocks at once and the checkbox below turned off.
          */}
          <button
            type="button"
            className="linkish mono"
            style={{ marginTop: 8, fontSize: 11 }}
            onClick={() => onShowWholePolicy(!showWholePolicy)}
          >
            {showWholePolicy
              ? "hide all three blocks"
              : "show all three blocks — for a policy file kept in git"}
          </button>
          {showWholePolicy ? (
            <>
              {acl.parts
                .filter((part) => part.key !== "tagOwners")
                .map((part) => (
                  <CopyBlock
                    key={part.key}
                    label={`"${part.key}"`}
                    purpose={part.purpose}
                    text={part.body}
                  />
                ))}
              <CopyBlock label="the whole object" text={acl.snippet} />
            </>
          ) : null}
        </>
      )}
      <label className="verify-row" style={{ marginTop: 14 }}>
        <input
          type="checkbox"
          className="verify-check"
          checked={managePolicy}
          onChange={(e) => onManagePolicy(e.target.checked)}
        />
        <span className="verify-label">Manage the tailnet policy file during init</span>
      </label>
      <div className="name-hint" style={{ color: "var(--fg3)", marginTop: 8 }}>
        Clearing this box is <span className="mono">init --skip-policy</span>: hermetic leaves the file
        alone and you paste all three blocks yourself. Either way it only ever edits the lines between
        its own <span className="mono">{"// hermetic:managed"}</span> markers.
      </div>
    </SubStep>
  );
}

/* ── 3 · the OAuth client ────────────────────────────────────────────────── */

export function OauthClientStep({ done }: { done: boolean }) {
  return (
    <SubStep
      n={2}
      title="OAuth client"
      done={done}
      action={
        <a
          className="btn btn-secondary"
          style={{ height: 30, fontSize: 11 }}
          href={TAILSCALE_ADMIN_OAUTH_URL}
          target="_blank"
          rel="noreferrer noopener"
        >
          Create OAuth client ↗
        </a>
      }
    >
      <div className="infobox" style={{ marginTop: 0 }}>
        <span className="k">description</span>
        <span className="mono">hermetic</span>
        <span className="k">scopes</span>
        <span>
          Auth Keys → <b>Write</b> (tag:hermetic) · Devices → Core → <b>Read</b>, <b>Write</b>{" "}
          (tag:hermetic) · Policy File → <b>Read</b>, <b>Write</b> — nothing else
        </span>
        <span className="k">tags</span>
        <span>
          <span className="mono">tag:hermetic</span> — on Auth Keys and Devices
        </span>
      </div>
      <div className="name-hint" style={{ color: "var(--fg3)" }}>
        Tailscale attaches <span className="mono">devices:posture_attributes</span> and{" "}
        <span className="mono">devices:core:read</span> by itself; leave those. Generate it, copy the
        client secret once — Tailscale never shows it again — and paste it below.
      </div>
    </SubStep>
  );
}

/* ── 4 · HTTPS certificates ──────────────────────────────────────────────── */

/**
 * The tailnet-wide HTTPS Certificates toggle. `cert_domains` is empty exactly
 * when it is off, and every agent ends its apply in `tailscale serve
 * --https=443`, which cannot get a certificate without it — so a tailnet with it
 * off provisions boxes nobody can open. Console-only, like the policy and the
 * OAuth client: a link and a re-check is all hermetic can do.
 */
export function CertificatesStep({
  ts,
  onRecheck,
}: {
  ts: InitTailscale | null;
  onRecheck: () => void;
}) {
  const on = (ts?.cert_domains.length ?? 0) > 0;
  return (
    <SubStep
      n={3}
      title="HTTPS certificates"
      done={on}
      action={
        <a
          className="btn btn-secondary"
          style={{ height: 30, fontSize: 11 }}
          href={TAILSCALE_ADMIN_DNS_URL}
          target="_blank"
          rel="noreferrer noopener"
        >
          Open DNS settings ↗
        </a>
      }
    >
      <div className="name-hint" style={{ color: "var(--fg3)", marginTop: 0 }}>
        Every agent publishes its Hermes dashboard and noVNC at{" "}
        <span className="mono">https://&lt;name&gt;.{ts?.tailnet ?? "<tailnet>"}</span>, and Tailscale
        only issues that certificate for tailnets that have this turned on.
      </div>
      <div className="name-hint" style={{ color: "var(--fg3)" }}>
        MagicDNS must be on first; the names appear in public Certificate Transparency logs — that is
        the only cost.
      </div>
      {ts ? (
        <div className="name-hint" style={{ color: "var(--fg3)" }}>
          {on ? (
            <>
              HTTPS certificates: on · <span className="mono">{ts.cert_domains[0]}</span>
            </>
          ) : (
            <>
              HTTPS certificates: off — enable, then{" "}
              <button type="button" className="linkish mono" onClick={onRecheck}>
                re-check
              </button>
            </>
          )}
        </div>
      ) : null}
    </SubStep>
  );
}

/* ── 5 · the client secret ───────────────────────────────────────────────── */

export function ClientSecretStep({
  secret,
  onSecret,
  onVerify,
  status,
  says,
  done,
}: {
  secret: string;
  /** `verify` is true when the value arrived whole (a paste) and can be proved now. */
  onSecret: (value: string, verify: boolean) => void;
  onVerify: () => void;
  status: "idle" | "processing" | "done" | "error";
  says: { text: string; tone: OauthTone; note: string | null };
  done: boolean;
}) {
  return (
    <SubStep n={4} title="Client secret" done={done} optional>
      <input
        className="wiz-input mono"
        type="password"
        value={secret}
        autoComplete="off"
        spellCheck={false}
        placeholder="tskey-client-…"
        onChange={(e) => onSecret(e.target.value, false)}
        onPaste={(e) => {
          // A whole secret arriving at once is the common case, so verify it
          // without a second click. Anything else falls through to the default
          // paste and the button.
          const pasted = e.clipboardData.getData("text").trim();
          if (!OAUTH_SECRET_SHAPE.test(pasted)) return;
          e.preventDefault();
          onSecret(pasted, true);
        }}
        onBlur={() => {
          if (status === "idle" && OAUTH_SECRET_SHAPE.test(secret)) onVerify();
        }}
      />
      <div className="name-hint" style={{ color: "var(--fg3)" }}>
        Verified by minting one <span className="mono">tag:hermetic</span> key, revoking it, listing the
        tailnet&apos;s devices, and reading the policy file. Stored in SSM, never on this page. Leave
        blank to push one later; no agent can be created until then.
      </div>

      {secret === "" ? null : (
        <div className="check-actions" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ height: 30, fontSize: 11 }}
            disabled={status === "processing"}
            onClick={onVerify}
          >
            {status === "processing" ? "Verifying…" : status === "idle" ? "Verify" : "Re-verify"}
          </button>
          <span className="mono" style={{ fontSize: 11, color: OAUTH_TONE[says.tone] }}>
            {says.text}
          </span>
        </div>
      )}
      {/*
        Verified, and one capability short. Yellow rather than red and below the
        verdict rather than instead of it: the client works, Initialize stays
        open, and what is lost — stale-device cleanup and doctor's device drift —
        is named along with the command that fixes it later.
      */}
      {says.note === null ? null : (
        <div className="name-hint" style={{ color: "var(--warn)", marginTop: 8 }}>
          {says.note}
        </div>
      )}
    </SubStep>
  );
}

/* ── the network: the fleet's egress shape, elected here and movable later ─ */

export function NetworkStep({
  network,
  onNetwork,
}: {
  network: "public" | "nat";
  onNetwork: (n: "public" | "nat") => void;
}) {
  return (
    <div className="wiz-field">
      <div className="kicker">Network</div>
      <div className="seg" role="group" aria-label="Network">
        {(["public", "nat"] as const).map((n) => (
          <button key={n} type="button" aria-pressed={network === n} onClick={() => onNetwork(n)}>
            {n === "public" ? "public (default)" : "nat (fck-nat)"}
          </button>
        ))}
      </div>
      {/*
        This shapes the foundation's VPC, but it is no longer a one-way door:
        §5's `plan network` → `apply` moves a fleet between the two afterwards.
        The hint says so, and says the part that is still expensive — every
        agent already running has to be recreated to follow the move.
      */}
      <div className="name-hint" style={{ color: "var(--fg3)" }}>
        <b>public</b> gives every agent a public IP in a public subnet — nothing listens on it (no
        inbound rules, no keypair; the way in is Tailscale), it is only how the box reaches the
        internet, and it costs $3.65/mo per agent. <b>nat (fck-nat)</b> puts the agents in private
        subnets behind one small NAT instance with a fixed elastic IP to allow-list and working IPv6
        egress, so no agent has a public address at all — flat cost whatever the fleet size (it breaks
        even at about two agents), but every Tailscale session to an agent then goes through a DERP
        relay instead of connecting directly, which is slower.
      </div>
      <div className="name-hint" style={{ color: "var(--fg3)" }}>
        Changeable later: Settings → Foundation → Change network mode plans the move and applies it.
        Agents already running keep the subnets they were launched into, so each one has to be recreated
        afterwards to follow the fleet.
      </div>
    </div>
  );
}
