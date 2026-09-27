/**
 * `hermeticd bootstrap` — two things, and no more (§4.1, §4.2).
 *
 * `--install` is what cloud-init's last line runs. It writes a oneshot systemd
 * unit and starts it, then exits. That indirection buys the two properties a
 * first boot needs and a cloud-init script cannot give: the boot survives the
 * SSH session and the cloud-init timeout that started it, and systemd retries
 * it (`Restart=on-failure`, one minute apart) without anyone watching. The unit
 * body lives here, in TypeScript, so it is a value a test can read rather than
 * a here-doc in a shell script nobody runs under test.
 *
 * The bare `hermeticd bootstrap` is the runner that unit executes: read
 * user-data, fetch and cache the fleet manifest, hand off to the stage runner
 * (`stages.ts`). Everything that used to live in this file — Tailscale, the
 * data volume, the config pull, the apply — is now an ordered bash stage
 * fetched from S3, so the boot sequence can change without a new binary on
 * every box.
 */
import type { FleetManifest } from "@hermetic/core/schema";
import type { Aws } from "./aws.ts";
import type { Host } from "./host.ts";
import { must } from "./host.ts";
import type { UserData } from "./userdata.ts";
import { agentParamPrefix, cacheFleetManifest } from "./fleet.ts";
import { reportBootFailure, runStages } from "./stages.ts";
import type { StagesOutcome } from "./stages.ts";
import { waitForInstallLock } from "./install-lock.ts";
import type { Emit } from "./events.ts";
import { opEvent } from "./events.ts";
import { redactValue } from "./redact.ts";

export const BOOTSTRAP_UNIT = "hermeticd-bootstrap.service";
export const BOOTSTRAP_UNIT_PATH = `/etc/systemd/system/${BOOTSTRAP_UNIT}`;

/**
 * `Type=oneshot`: the boot is a task that finishes, not a daemon. No
 * `RemainAfterExit` — the unit is deliberately re-triggerable, so
 * `systemctl start hermeticd-bootstrap` from an SSH session actually runs the
 * boot again instead of being a silent no-op. `Restart=on-failure` covers the
 * runner giving up after 24 hours of waiting for a rerun, and `RestartSec=60`
 * keeps a box whose network is down from spinning. `After=network-online.target`
 * because the first thing a stage does is reach S3.
 *
 * `journal+console` and not `journal`: the serial console is the only channel
 * that survives a boot which fails *before* it can report. The row needs
 * DynamoDB, `hermetic logs` needs the tailnet, and both of those are things a
 * stage has to bring up — so a box that dies early is silent on every path
 * except this one, which `ec2:GetConsoleOutput` reads with no cooperation from
 * the box at all (§6.3). Every line the runner prints is redacted before it is
 * printed (`stages.ts`, §8.3), so the console carries the same text the journal
 * already did; it is only read by a wider audience.
 */
export function bootstrapUnitBody(): string {
  return `[Unit]
Description=hermetic staged bootstrap
Documentation=https://github.com/esopian/hermetic
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/hermeticd bootstrap
Restart=on-failure
RestartSec=60
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=multi-user.target
`;
}

/**
 * `--no-block`: cloud-init is what called us, and waiting for a boot that takes
 * minutes would hold up the very unit that has to finish for the box to be
 * usable. The runner reports its own progress on the row, which is where an
 * operator is looking anyway.
 */
export async function installBootstrapUnit(host: Host): Promise<void> {
  await host.writeFile(BOOTSTRAP_UNIT_PATH, bootstrapUnitBody(), "0644");
  await must(host, ["systemctl", "daemon-reload"]);
  await must(host, ["systemctl", "enable", "--now", "--no-block", BOOTSTRAP_UNIT]);
}

export interface BootstrapDeps {
  readonly host: Host;
  readonly aws: Aws;
  readonly userData: UserData;
  readonly region: string;
  /** Already fetched and cached by `main.ts`'s context, or refetched here. */
  readonly fleet: FleetManifest;
  readonly emit?: Emit;
  readonly log?: (line: string) => void;
}

/**
 * The runner (§4.2). The fleet manifest is refreshed before the stages run, so
 * a box rebooting into a fleet that has moved on picks up the new release
 * rather than replaying the one it booted with.
 */
export async function bootstrap(deps: BootstrapDeps): Promise<StagesOutcome> {
  const { host, aws, userData } = deps;
  const emit = deps.emit ?? (() => {});
  try {
    return await runBootstrap(deps);
  } catch (e) {
    // `runStages` already reports the failures it owns; this covers everything
    // before it — a manifest that will not parse, a cache write that failed.
    // The second transition is a no-op (the row is already `error`), so the
    // row and the event log say the same thing either way.
    await reportBootFailure(aws, userData.name, e);
    emit(
      opEvent("done", 1, redactValue(e instanceof Error ? e.message : String(e)), host.now(), "error"),
    );
    throw e;
  }
}

async function runBootstrap(deps: BootstrapDeps): Promise<StagesOutcome> {
  const { host, aws, userData } = deps;
  const emit = deps.emit ?? (() => {});

  // The manifest was fetched (or recovered from the cache) by `bootContext`,
  // which is the only place that can do it: it is the document that names the
  // DynamoDB tables the `aws` client here was built from.
  const fleet = deps.fleet;
  await cacheFleetManifest(host, fleet);
  emit(
    opEvent("manifest", 0.02, `fleet manifest names hermeticd ${fleet.hermeticd.version}`, host.now()),
  );

  /**
   * The other installer on this box is the self-update inside
   * `hermeticd.service`, which stage `05-service` itself starts — so from `05`
   * onwards both are alive and both write `/opt/hermetic/stages` (§6.5). The
   * updater defers while this unit is active, which covers that direction; this
   * covers the other, where systemd has nothing useful to say because
   * `hermeticd.service` is `active` whether it is installing or idle.
   *
   * Waiting rather than refusing: an update in flight finishes in under a
   * minute, and this unit's `Restart=on-failure`/`RestartSec=60` turns a
   * genuine timeout into another attempt rather than a dead box.
   */
  const lock = await waitForInstallLock(host, "bootstrap", {
    ...(deps.log ? { log: deps.log } : {}),
  });
  try {
    return await runStages({
      host,
      aws,
      name: userData.name,
      ...(userData.hostname === undefined ? {} : { hostname: userData.hostname }),
      bucket: userData.bucket,
      fleet,
      paramPrefix: agentParamPrefix(fleet, userData.name),
      region: deps.region,
      ...(deps.emit ? { emit: deps.emit } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    });
  } finally {
    await lock.release();
  }
}
