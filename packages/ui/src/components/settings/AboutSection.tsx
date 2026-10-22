/**
 * Settings › This laptop › About & updates: which build this is, and whether a
 * newer one exists.
 *
 * The check is the menu's "Check for Updates…" (`app.checkForUpdate`), and its
 * result is the same `app.update` push the footer reads. The app never installs
 * a release itself (`app/src/main/updates.ts` says why), so "update" is the
 * release page, where the DMG is downloaded and installed like the first one.
 */
import { useEffect, useState } from "react";
import { type AppInfo, appInfo, checkForUpdate } from "../../api/app.ts";
import { openExternal } from "../../lib/open-external.ts";
import { type AppUpdate, useAppUpdate } from "../../state/app-update-state.tsx";
import { Block, Callout, Facts, PageFoot, SettingsPage } from "./Section.tsx";
import type { Fact } from "./Section.tsx";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The status fact for the last `app.update`; anything unrecognised reads as not checked. */
export function updateFact(update: AppUpdate | null): Fact {
  switch (update?.status) {
    case "none":
      return { k: "Updates", v: "Up to date", tone: "ok" };
    case "available":
      return {
        k: "Updates",
        v: update.version === undefined ? "Available" : `v${update.version} available`,
        tone: "warn",
      };
    case "error":
      return { k: "Updates", v: "Check failed", tone: "bad" };
    default:
      return { k: "Updates", v: "Not checked" };
  }
}

export function AboutSection() {
  const update = useAppUpdate();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => appInfo())
      .then(
        (read) => {
          if (live) setInfo(read);
        },
        (e: unknown) => {
          if (live) setError(message(e));
        },
      );
    return () => {
      live = false;
    };
  }, []);

  // A dev build has no release channel to compare against, so the updater
  // never asks (`main/updates.ts`) and a button would do nothing.
  const dev = info?.channel === "dev";

  async function check() {
    setBusy(true);
    setError(null);
    try {
      await checkForUpdate();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const primary =
    update?.status === "available" && info !== null ? (
      <button type="button" className="btn btn-primary" onClick={() => openExternal(info.releasesUrl)}>
        {update.version === undefined ? "Download update" : `Download v${update.version}`}
      </button>
    ) : (
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || info === null || dev}
        onClick={() => void check()}
      >
        {busy ? "Checking…" : "Check for updates"}
      </button>
    );

  return (
    <SettingsPage
      section="about"
      scope="readonly"
      desc="The Hermetic build on this laptop, and whether a newer one is out."
      primary={primary}
    >
      {error ? <div className="wiz-error mono">{error}</div> : null}
      <Block title="This build">
        <Facts
          items={[
            { k: "Version", v: info === null ? "—" : `v${info.version}` },
            { k: "Channel", v: info?.channel ?? "—" },
            updateFact(update),
          ]}
        />
        {dev ? (
          <Callout tone="info">
            Dev builds do not check for updates. Release builds check at launch and every six hours.
          </Callout>
        ) : update?.status === "available" ? (
          <Callout tone="warn">
            A newer release is out. Download it from the release page and install it over this one; your
            fleet and settings stay where they are.
          </Callout>
        ) : null}
      </Block>
      <PageFoot>
        The app, its bundled CLI and core ship as one version. Fleet software (hermeticd, Hermes) is
        versioned under Foundation.
      </PageFoot>
    </SettingsPage>
  );
}
