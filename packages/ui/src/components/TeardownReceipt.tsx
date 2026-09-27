/**
 * §4.6: what a teardown actually did, shown once it has finished — and shown
 * *over the init wizard*, because a teardown with `--reset-local` has by then
 * returned this home to uninitialized and swapped the whole view.
 *
 * The three lists are the point. An op stream says "deleted 13 SSM
 * parameter(s)" and scrolls past; this says what is gone, what is still in the
 * account and which flag would have removed it, and what no flag can reach.
 * Closing it leaves the operator where they now are: at step one of setup.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { listTeardowns, type TeardownReceipt, type TeardownResourceOutcome } from "../api/index.ts";
import { fmtDateTime } from "../logic/format.ts";
import { Dialog } from "./Dialog.tsx";
import { GROUP_TITLES, groupReceipt, receiptFlags, type Disposition } from "../logic/receipt.ts";

function Group({ disposition, items }: { disposition: Disposition; items: TeardownResourceOutcome[] }) {
  return (
    <section className={`tr-group tr-${disposition}`}>
      <h3 className="tr-group-title">
        {GROUP_TITLES[disposition]} <span className="tr-count">{items.length}</span>
      </h3>
      <ul className="tr-list">
        {items.map((item, i) => (
          <li key={`${item.phase}-${i}`}>
            <span className="tr-what">
              {item.what}
              {item.count === null ? null : <span className="tr-n"> × {item.count}</span>}
            </span>
            {item.detail ? <span className="tr-detail">{item.detail}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * §4.6: the Elastic IP block, as ids rather than as prose. The groups above
 * already say that an allocation was kept or released; this is the line the
 * operator copies the allocation id out of, because releasing one by hand means
 * typing it into the EC2 console. Nothing to show when the sweep found nothing,
 * which is every `public` fleet and most `nat` ones.
 */
function Addresses({ receipt }: { receipt: TeardownReceipt }) {
  const kept = receipt.addresses?.kept ?? [];
  const released = receipt.addresses?.released ?? [];
  if (kept.length === 0 && released.length === 0) return null;
  return (
    <section className="tr-group tr-addresses">
      <h3 className="tr-group-title">
        Elastic addresses <span className="tr-count">{kept.length + released.length}</span>
      </h3>
      <ul className="tr-list mono">
        {kept.map((a) => (
          <li key={a.allocation_id}>
            <span className="tr-what">
              {a.allocation_id} {a.public_ip}
            </span>
            <span className="tr-detail">
              {a.associated ? "still associated — release it from the console" : "still allocated"}
            </span>
          </li>
        ))}
        {released.map((id) => (
          <li key={id}>
            <span className="tr-what">{id}</span>
            <span className="tr-detail">released</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReceiptFrame({
  children,
  onClose,
  label,
}: {
  children: ReactNode;
  onClose: () => void;
  label: string;
}) {
  return (
    <Dialog className="tr-backdrop" modal label={label} onDismiss={onClose}>
      <div className="tr-modal">{children}</div>
    </Dialog>
  );
}

export function TeardownReceiptModal({
  receipt,
  onClose,
  failed = null,
}: {
  receipt: TeardownReceipt | null;
  onClose: () => void;
  failed?: string | null;
}) {
  const [showLog, setShowLog] = useState(false);

  if (failed !== null) {
    return (
      <ReceiptFrame onClose={onClose} label="Could not read the teardown record">
        <div className="wiz-error mono">could not read the teardown record: {failed}</div>
        <footer key="actions" className="tr-foot">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Back to setup
          </button>
        </footer>
      </ReceiptFrame>
    );
  }
  if (!receipt) {
    return (
      <ReceiptFrame onClose={onClose} label="Reading teardown record">
        <div className="tr-body" role="status">
          Reading teardown record…
        </div>
        <footer key="actions" className="tr-foot">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </footer>
      </ReceiptFrame>
    );
  }

  const flags = receiptFlags(receipt);
  const groups = groupReceipt(receipt);

  return (
    <ReceiptFrame
      onClose={onClose}
      label={receipt.outcome === "ok" ? "Foundation torn down" : "Teardown failed"}
    >
      <header className="tr-head">
        <h2 id="tr-title" className="tr-title">
          {receipt.outcome === "ok" ? "Foundation torn down" : "Teardown failed"}
        </h2>
        <div className="tr-sub mono">
          {receipt.stack_name} · fleet {receipt.fleet_id} · {receipt.account_id} · {receipt.region}
        </div>
        <div className="tr-sub mono">
          {fmtDateTime(receipt.finished_at)}
          {flags.length > 0 ? ` · ${flags.join(" ")}` : ""}
        </div>
        {receipt.error ? (
          <div className="wiz-error mono">
            {receipt.error.code}: {receipt.error.message}
          </div>
        ) : null}
      </header>

      <div className="tr-body">
        {groups.map(({ disposition, items }) => (
          <Group key={disposition} disposition={disposition} items={items} />
        ))}

        <Addresses receipt={receipt} />

        <button
          type="button"
          className="btn btn-secondary tr-logbtn"
          onClick={() => setShowLog((v) => !v)}
          aria-expanded={showLog}
        >
          {showLog ? "Hide log" : `Show log (${receipt.events.length} events)`}
        </button>
        {showLog ? (
          <pre className="logpane tr-log">
            {receipt.events
              .map(
                (e) => `${e.at}  ${e.phase.padEnd(13)}${e.level === "warn" ? "! " : "  "}${e.message}`,
              )
              .join("\n")}
          </pre>
        ) : null}
      </div>

      <footer key="actions" className="tr-foot">
        <span className="settings-hint mono">
          kept in ~/.hermetic — <code>hermetic teardowns --last</code>
        </span>
        <button type="button" className="btn btn-primary" onClick={onClose} data-autofocus>
          Back to setup
        </button>
      </footer>
    </ReceiptFrame>
  );
}

/**
 * Fetches the newest receipt and shows it. Fetching rather than passing the
 * op's events down is deliberate: the record is on disk, so this survives a
 * portal restart and a browser reload, which is exactly when an operator comes
 * back asking what happened.
 */
export function LastTeardownReceipt({ onClose }: { onClose: () => void }) {
  const [receipt, setReceipt] = useState<TeardownReceipt | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    let alive = true;
    listTeardowns(1).then(
      (found) => {
        if (!alive) return;
        // No receipt is not an error: an older home, or a `teardown` run by a
        // build that did not keep one. Nothing to show, so show nothing.
        if (found.length === 0) close.current();
        else setReceipt(found[0]!);
      },
      (e: unknown) => {
        if (alive) setFailed(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  return <TeardownReceiptModal receipt={receipt} failed={failed} onClose={onClose} />;
}
