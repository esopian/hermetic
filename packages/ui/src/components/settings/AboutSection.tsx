/**
 * Settings › This laptop › About & updates: which build this is, and whether a
 * newer one exists.
 *
 * The check is the menu's "Check for Updates…" (`app.checkForUpdate`), and its
 * result is the same `app.update` push the footer reads. A newer release is
 * downloaded and checked against the release signing key in the main process
 * (`app/src/main/updates.ts`); once it verifies, "Restart to update"
 * (`app.installUpdate`) installs it. One that cannot be verified is offered as
 * a download from the release page instead.
 */
import { useEffect, useState } from "react";
import { type AppInfo, appInfo, checkForUpdate, installUpdate } from "../../api/app.ts";
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
    case "downloading":
      return {
        k: "Updates",
        v: update.version === undefined ? "Downloading" : `Downloading v${update.version}`,
      };
    case "ready":
      return {
        k: "Updates",
        v: update.version === undefined ? "Ready to install" : `v${update.version} ready`,
        tone: "ok",
      };
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
  /** Which request is in flight; the check stays open while its native dialog is up. */
  const [busy, setBusy] = useState<"check" | "install" | null>(null);
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

  async function run(which: "check" | "install", request: () => Promise<unknown>) {
    setBusy(which);
    setError(null);
    try {
      await request();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  }

  const version = update?.version === undefined ? "" : ` v${update.version}`;
  const primary =
    update?.status === "ready" ? (
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy !== null}
        onClick={() => void run("install", installUpdate)}
      >
        {busy === "install" ? "Restarting…" : "Restart to update"}
      </button>
    ) : update?.status === "available" && info !== null ? (
      <button type="button" className="btn btn-primary" onClick={() => openExternal(info.releasesUrl)}>
        {`Download${version}`}
      </button>
    ) : (
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy !== null || info === null || dev || update?.status === "downloading"}
        onClick={() => void run("check", checkForUpdate)}
      >
        {update?.status === "downloading"
          ? "Downloading…"
          : busy === "check"
            ? "Checking…"
            : "Check for updates"}
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
        ) : update?.status === "ready" ? (
          <Callout tone="ok">
            Downloaded and verified against Hermetic&apos;s release signing key. Restart to install it;
            your fleet and settings stay where they are.
          </Callout>
        ) : update?.status === "available" ? (
          <Callout tone="warn">
            A newer release is out, but this app could not download and verify it. Download it from the
            release page and install it over this one; your fleet and settings stay where they are.
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
