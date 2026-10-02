/**
 * Presentation derivations shared by every layout: status colour, health
 * squares, version comparison, sizes, durations. The size table mirrors core's
 * `SIZES` (§7.1); the UI may not import core, so it is restated here.
 */
import {
  PROVIDERS as CORE_PROVIDERS,
  PROVIDERS_LIST,
  agentDesktopClientUrl,
  agentDesktopUrl,
  agentHostname,
  agentHostnameMismatch,
  cloudName,
  legacyCloudNames,
} from "@hermetic/core/shared";
import type { Provider, SizeId } from "@hermetic/core/shared";
import type { AgentView } from "../api/index.ts";

/** Core's naming rules, re-exported so the UI keeps one import for them. */
export { cloudName, legacyCloudNames };

/** Used until `/api/meta.tailnet` is non-null (core has not filled it in yet). */
export const DEFAULT_TAILNET = "hermetic.ts.net";
/**
 * The console URLs the wizard links to and the root disk's bounds are core's
 * own, through the one door the browser may open (`@hermetic/core/shared`):
 * a link target is not something a response should get to decide, and a
 * slider whose maximum differed from the schema's would offer a value the
 * server refuses.
 */
export {
  DEFAULT_ROOT_GIB,
  ROOT_GIB_MAX,
  ROOT_GIB_MIN,
  TAILSCALE_ADMIN_ACL_URL,
  TAILSCALE_ADMIN_DNS_URL,
  TAILSCALE_ADMIN_OAUTH_URL,
  TAILSCALE_DOWNLOAD_URL,
} from "@hermetic/core/shared";
/** gp3 in us-east-1, the same figure core's cost copy uses. */
export const GP3_USD_PER_GIB_MONTH = 0.08;

/**
 * Roughly what a bootstrapped agent occupies on its root disk before it has
 * done any work: Ubuntu, the Hermes venv, Node, `uv`, and the browser stack's
 * snap revisions (§7.1 measures 5.8 GiB on a real box).
 *
 * Informational and UI-only — it has no counterpart in core to be pinned
 * against, because nothing in core branches on it. It exists so the create
 * slider can translate a size into headroom, which is what makes the 8 GiB
 * floor visibly bad without a paragraph saying so.
 */
export const ROOT_BOOTSTRAP_GIB = 6;

/**
 * Deep-link to one EC2 instance in the AWS console. Instances are regional, so
 * both the id and region are required; missing either returns null so the
 * drawer can keep showing a dash (or an unlinked id).
 *
 * Current console path is `/ec2/home` (the older `/ec2/v2/home` still
 * redirects). Hash `#InstanceDetails:instanceId=` opens the instance page.
 */
export function ec2InstanceConsoleUrl(
  instanceId: string | null | undefined,
  region: string | null | undefined,
): string | null {
  if (!instanceId || !region) return null;
  return `https://${region}.console.aws.amazon.com/ec2/home?region=${encodeURIComponent(region)}#InstanceDetails:instanceId=${encodeURIComponent(instanceId)}`;
}

/**
 * Deep-link to one EBS volume in the AWS console, on the tab that has the Tags
 * editor — the Volumes view tells an operator to tag the real one of an
 * ambiguous pair, and tagging is the one thing hermetic will not do for them
 * (it refuses to guess which volume holds the memory, §9). Same shape and same
 * null rule as `ec2InstanceConsoleUrl` above.
 */
export function ebsVolumeConsoleUrl(
  volumeId: string | null | undefined,
  region: string | null | undefined,
): string | null {
  if (!volumeId || !region) return null;
  return `https://${region}.console.aws.amazon.com/ec2/home?region=${encodeURIComponent(region)}#VolumeDetails:volumeId=${encodeURIComponent(volumeId)}`;
}

/** What a gp3 volume of this many GiB bills per month, at `GP3_USD_PER_GIB_MONTH`. */
export function volumeMonthlyUsd(gib: number): number {
  return gib * GP3_USD_PER_GIB_MONTH;
}

/**
 * One row per provider the drawer can offer, in core's order (the order of the
 * segmented control). `id`, `env` and `default_model` are read straight out of
 * core's `PROVIDERS` (`@hermetic/core/shared`), so a provider added to core is
 * offered here without a second table to update; `env` is the variable the key
 * lands in on the instance, which is what the drawer tells the operator to put
 * in the agent's Bitwarden project. Only `hint` — the drawer's one-line copy —
 * is the UI's own.
 */
export interface ProviderOption {
  id: Provider;
  label: string;
  /** null when the provider authenticates as the instance role. */
  env: string | null;
  /**
   * The model an agent gets when the operator names none — shown as the
   * placeholder rather than an empty box that gives no clue how this provider
   * spells a model id.
   */
  default_model: string;
  hint: string;
}

const PROVIDER_HINTS: Readonly<Record<Provider, string>> = {
  bedrock: "instance role — no key on the box",
  anthropic: "Anthropic API, keyed per agent",
  openrouter: "OpenRouter gateway, keyed per agent",
  nous: "Nous Portal inference API, keyed per agent",
  openai: "OpenAI API, keyed per agent",
  vercel: "Vercel AI Gateway, keyed per agent",
};

export const PROVIDERS: readonly ProviderOption[] = PROVIDERS_LIST.map((id) => ({
  id,
  label: id,
  env: CORE_PROVIDERS[id].env,
  default_model: CORE_PROVIDERS[id].default_model,
  hint: PROVIDER_HINTS[id],
}));

export function providerOption(id: ProviderOption["id"]): ProviderOption {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]!;
}

export interface SizeSpec {
  /** Core's own id list (`SIZE_IDS`), so a size this table names is one core accepts. */
  id: SizeId;
  glyph: string;
  instance_type: string;
  vcpu: number;
  memGib: number;
  hourlyUsd: number;
  monthlyUsd: number;
  description: string;
  family: "cpu" | "gpu";
  gpu?: { count: number; memGib: number; model: string };
}

export const SIZES: readonly SizeSpec[] = [
  {
    id: "micro",
    glyph: "μ",
    instance_type: "t4g.micro",
    vcpu: 2,
    memGib: 1,
    hourlyUsd: 7 / 730,
    monthlyUsd: 7,
    description: "tiny tasks",
    family: "cpu",
  },
  {
    id: "xxsmall",
    glyph: "XXS",
    instance_type: "t4g.small",
    vcpu: 2,
    memGib: 2,
    hourlyUsd: 14 / 730,
    monthlyUsd: 14,
    description: "light automation",
    family: "cpu",
  },
  {
    id: "xsmall",
    glyph: "XS",
    instance_type: "t4g.medium",
    vcpu: 2,
    memGib: 4,
    hourlyUsd: 28 / 730,
    monthlyUsd: 28,
    description: "small burstable agents",
    family: "cpu",
  },
  {
    id: "small",
    glyph: "S",
    instance_type: "r8g.large",
    vcpu: 2,
    memGib: 16,
    hourlyUsd: 86 / 730,
    monthlyUsd: 86,
    description: "light agents",
    family: "cpu",
  },
  {
    id: "medium",
    glyph: "M",
    instance_type: "t4g.2xlarge",
    vcpu: 8,
    memGib: 32,
    hourlyUsd: 196 / 730,
    monthlyUsd: 196,
    description: "default",
    family: "cpu",
  },
  {
    id: "large",
    glyph: "L",
    instance_type: "r8g.2xlarge",
    vcpu: 8,
    memGib: 64,
    hourlyUsd: 344 / 730,
    monthlyUsd: 344,
    description: "large contexts",
    family: "cpu",
  },
  {
    id: "xlarge",
    glyph: "XL",
    instance_type: "r8g.4xlarge",
    vcpu: 16,
    memGib: 128,
    hourlyUsd: 688 / 730,
    monthlyUsd: 688,
    description: "parallel workloads",
    family: "cpu",
  },
  {
    id: "xxlarge",
    glyph: "XXL",
    instance_type: "r8g.8xlarge",
    vcpu: 32,
    memGib: 256,
    hourlyUsd: 1376 / 730,
    monthlyUsd: 1376,
    description: "large concurrent work",
    family: "cpu",
  },
  {
    id: "3xlarge",
    glyph: "3XL",
    instance_type: "r8g.16xlarge",
    vcpu: 64,
    memGib: 512,
    hourlyUsd: 2752 / 730,
    monthlyUsd: 2752,
    description: "fleet-scale processing",
    family: "cpu",
  },
  {
    id: "gpu-xsmall",
    glyph: "GPU XS",
    instance_type: "g5g.xlarge",
    vcpu: 4,
    memGib: 8,
    hourlyUsd: 0.42,
    monthlyUsd: 0.42 * 730,
    description: "light CUDA and graphics",
    family: "gpu",
    gpu: { count: 1, memGib: 16, model: "NVIDIA T4G" },
  },
  {
    id: "gpu-small",
    glyph: "GPU S",
    instance_type: "g5g.2xlarge",
    vcpu: 8,
    memGib: 16,
    hourlyUsd: 0.556,
    monthlyUsd: 0.556 * 730,
    description: "GPU tools with CPU headroom",
    family: "gpu",
    gpu: { count: 1, memGib: 16, model: "NVIDIA T4G" },
  },
  {
    id: "gpu-medium",
    glyph: "GPU M",
    instance_type: "g5g.4xlarge",
    vcpu: 16,
    memGib: 32,
    hourlyUsd: 0.828,
    monthlyUsd: 0.828 * 730,
    description: "balanced GPU compute",
    family: "gpu",
    gpu: { count: 1, memGib: 16, model: "NVIDIA T4G" },
  },
  {
    id: "gpu-large",
    glyph: "GPU L",
    instance_type: "g5g.8xlarge",
    vcpu: 32,
    memGib: 64,
    hourlyUsd: 1.372,
    monthlyUsd: 1.372 * 730,
    description: "CPU-heavy GPU work",
    family: "gpu",
    gpu: { count: 1, memGib: 16, model: "NVIDIA T4G" },
  },
  {
    id: "gpu-xlarge",
    glyph: "GPU XL",
    instance_type: "g5g.16xlarge",
    vcpu: 64,
    memGib: 128,
    hourlyUsd: 2.744,
    monthlyUsd: 2.744 * 730,
    description: "dual-GPU workloads",
    family: "gpu",
    gpu: { count: 2, memGib: 32, model: "NVIDIA T4G" },
  },
];

export function sizeSpec(id: string): SizeSpec {
  return SIZES.find((s) => s.id === id) ?? SIZES.find((s) => s.id === "medium")!;
}

export function sizeGlyph(id: string): string {
  return sizeSpec(id).glyph;
}

/**
 * §4.3 statuses that mean an operation is in flight. `creating →
 * bootstrapping → ready`, with `bootstrapping → error` on a failed stage and
 * `error → bootstrapping` on a rerun; there is no `converging` any more.
 */
const BUSY = new Set(["creating", "bootstrapping", "stopping", "destroying"]);

export function isBusy(a: AgentView): boolean {
  return BUSY.has(a.display_status);
}

/**
 * The statuses with no instance answering: the box is powered down or gone.
 * Taken as a bare status rather than a row because the desktop panel is handed
 * the status alone, and both callers have to agree on what "off" means — a
 * panel that offers `Connect →` on a box that is not running is a stream that
 * cannot open.
 */
export function isOffStatus(status: string): boolean {
  return status === "stopped" || status === "destroyed";
}

export function isOff(a: AgentView): boolean {
  return isOffStatus(a.display_status);
}

/**
 * Which lifecycle buttons the agent drawer may show. `destroyed` is terminal in
 * core's state machine (`TRANSITIONS.destroyed` is empty), so every action on a
 * destroyed row would come back `INVALID_TRANSITION` — the drawer must not
 * offer them at all rather than offer them and explain the refusal afterwards.
 */
export interface DrawerActions {
  dashboard: boolean;
  upgrade: boolean;
  rerun: boolean;
  /** `agent reboot`: the OS on the box the agent already has (§6.5). */
  reboot: boolean;
  /** `agent recreate`: a new instance from a fresh disk, same data volume. */
  rebuild: boolean;
  /** The single power button: `start` when off, `stop` when up, none when gone. */
  power: "start" | "stop" | null;
  destroy: boolean;
}

const NO_ACTIONS: DrawerActions = {
  dashboard: false,
  upgrade: false,
  rerun: false,
  reboot: false,
  rebuild: false,
  power: null,
  destroy: false,
};

/**
 * Reboot asks a *running* box's operating system to bounce, so core takes it
 * only from a status that means the instance is up (§6.5). `unreachable` is in
 * the list because it is exactly the case reboot is for: a `ready` row whose
 * heartbeat stopped.
 */
const REBOOTABLE = new Set(["ready", "degraded", "bootstrapping", "error", "unreachable"]);

/** Recreate needs a settled row (§6.5): mid-flight statuses have no edge to it. */
const REBUILDABLE = new Set(["ready", "degraded", "creating", "stopped", "error", "unreachable"]);

export function drawerActions(status: string): DrawerActions {
  if (status === "destroyed") return { ...NO_ACTIONS };
  return {
    dashboard: true,
    upgrade: true,
    rerun: true,
    reboot: REBOOTABLE.has(status),
    rebuild: REBUILDABLE.has(status),
    power: status === "stopped" ? "start" : "stop",
    destroy: true,
  };
}

export interface RebootState {
  pending: boolean;
  label: string;
  reason: string;
}

/**
 * The Reboot button, before and after it is pressed.
 *
 * Reboot is not an op (§6.5): one `RebootInstances` and one row write, so there
 * is no rail to draw and no op-completion toast to raise. What the press does
 * change is the row — core clears `last_heartbeat` — and the box is back when
 * hermeticd heartbeats again. So the press is acknowledged the way `rerun`'s is:
 * the button stays down, pulsing, until the row carries a heartbeat that is not
 * the one it had when the button was pressed (`issued.before`). Compared by
 * value, not by time: the heartbeat is stamped by the box's clock and the press
 * by the laptop's, and a box a few seconds behind would otherwise never count
 * as back. Without this a successful reboot changed nothing on screen until the
 * next fleet scan, and then only by blanking the health checks.
 */
export function rebootState(
  agent: Pick<AgentView, "last_heartbeat">,
  issued: { before: string | null } | null,
): RebootState {
  const beat = agent.last_heartbeat ?? null;
  if (issued !== null && (beat === null || beat === issued.before)) {
    return {
      pending: true,
      label: "Rebooting…",
      reason: "reboot sent; waiting for hermeticd's first heartbeat from the rebooted box",
    };
  }
  return {
    pending: false,
    label: "Reboot",
    reason:
      "Reboot the operating system on this instance; the box, its disks and its tailnet address all stay",
  };
}

/** The health-strip line for an agent with no instance answering. */
export function offlineDetail(status: string): string {
  return status === "destroyed" ? "offline · instance terminated" : "offline · instance stopped";
}

/** The same distinction, short enough for a metric tile's unit slot. */
export function offlineUnit(status: string): string {
  return status === "destroyed" ? "terminated" : "stopped";
}

/**
 * What a legacy destroyed row still has, in place of the actions it cannot
 * run. Only a row written before destroys deleted the row (§6.7) reaches here;
 * a null `volume_id` is the volume that destroy deleted.
 */
export function destroyedSummary(volumeId: string | null | undefined): string {
  return volumeId
    ? `destroyed · legacy record · data volume ${volumeId} retained`
    : "destroyed · legacy record · data volume deleted";
}

export function statusColor(status: string): string {
  if (status === "ready") return "var(--ok)";
  if (status === "degraded") return "var(--warn)";
  if (status === "unreachable" || status === "error") return "var(--bad)";
  if (status === "stopped" || status === "destroyed") return "var(--fg3)";
  return "var(--acc)";
}

/** ok / warn / bad / fg3 when stopped / line2 before the first heartbeat. */
export function healthColors(a: AgentView): string[] {
  const order: Array<"hermes" | "tailscale" | "disk"> = ["hermes", "tailscale", "disk"];
  if (isOff(a)) return order.map(() => "var(--fg3)");
  if (!a.health) return order.map(() => "var(--line2)");
  const health = a.health;
  return order.map((k) => {
    if (health[k]) return "var(--ok)";
    return a.display_status === "degraded" ? "var(--warn)" : "var(--bad)";
  });
}

export function healthTitle(a: AgentView): string {
  if (isOff(a)) return "offline";
  if (!a.health) return "pending";
  const failing = (["hermes", "tailscale", "disk"] as const).filter((k) => !a.health?.[k]);
  return failing.length ? `${failing.join(", ")} failing` : "all checks passing";
}

/**
 * The two filesystems as one number: whichever is fuller, because that is the
 * one about to stop the agent. `/data` filling up costs the agent its memory;
 * the root disk filling up costs it its self-update (`hermeticd` refuses to
 * swap its own binary without room for it) and eventually its journal, so
 * neither is the disk — the worse of them is.
 *
 * `null` when nothing was measured. A root disk the row does not report is
 * *absent*, not empty: it is left out of the comparison entirely rather than
 * counted as 0%, which would let an old hermeticd's silence look like health.
 */
export function worstDisk(m: AgentView["metrics"]): number | null {
  const measured = [m?.disk_pct, m?.root_disk_pct].filter((v): v is number => typeof v === "number");
  return measured.length === 0 ? null : Math.max(...measured);
}

/**
 * Room left on the root filesystem, and whether that is a measurement or a guess.
 *
 * Two sources, and the difference matters enough to be visible in the string:
 * `root_free_mib` is what the box measured on the filesystem it would have to
 * write into, and a reading gets no qualifier. Absent — a row from an older
 * hermeticd — the size and the percentage can be multiplied together instead,
 * but the *volume* is not the *filesystem*: boot partitions and ext4 metadata
 * come off the top, so the product always reads high. On the box that prompted
 * all of this it read ≈1.1 GiB against 962 MiB of truth, and half that gap is a
 * whole self-update. So the estimate is offered with `≈` and never silently.
 *
 * `null` when neither is available, which is a row that has reported no root
 * reading at all.
 */
export function rootFree(
  m: AgentView["metrics"],
  rootGib: number | null | undefined,
): { text: string; measured: boolean } | null {
  const mib = m?.root_free_mib;
  if (typeof mib === "number") {
    return {
      text: mib < 1024 ? `${Math.round(mib)} MiB` : `${(mib / 1024).toFixed(1)} GiB`,
      measured: true,
    };
  }
  const pct = m?.root_disk_pct;
  if (typeof pct !== "number" || !rootGib) return null;
  const gib = (1 - pct / 100) * rootGib;
  return {
    text: gib < 1 ? `≈${Math.round(gib * 1024)} MiB` : `≈${gib.toFixed(1)} GiB`,
    measured: false,
  };
}

/**
 * The one sentence describing both filesystems, used by the fleet cell's
 * tooltip and by the drawer's passing disk check.
 *
 * One function rather than two call sites because they say the same thing about
 * the same row, and the pair drifted apart the first time only one of them
 * learned about the root disk.
 */
export function diskTitle(a: AgentView): string {
  const data = `data disk ${pct(a.metrics?.disk_pct)} of ${a.volume_gib} GiB`;
  const rootPct = a.metrics?.root_disk_pct;
  if (typeof rootPct !== "number") return `${data} · system disk not reported`;
  const free = rootFree(a.metrics, a.root_gib);
  const size = a.root_gib ? ` of ${a.root_gib} GiB` : " full, size not recorded";
  return `${data} · system disk ${pct(rootPct)}${size}${free ? `, ${free.text} free` : ""}`;
}

/**
 * Why the disk check is failing, when it is. hermeticd holds *two* filesystems
 * to one `disk` boolean (§6.4), so "the disk is full" is not an answer an
 * operator can act on — one of them is resized with `--volume-gib` and a
 * recreate, the other is the box's own root disk, and sending someone to the
 * wrong one costs a rebuild. The fuller of the two is the one that tripped it.
 */
export function fullDiskDetail(a: AgentView): string {
  const data = a.metrics?.disk_pct ?? null;
  const root = a.metrics?.root_disk_pct ?? null;
  if (root !== null && root > (data ?? 0)) {
    const free = rootFree(a.metrics, a.root_gib);
    const of = a.root_gib ? ` of ${a.root_gib} GiB` : " (size not recorded)";
    /**
     * Both remedies, in the order they help. "A rebuild is what clears it" was
     * the whole answer here and is only half of one: on an 8 GiB root a rebuild
     * lands back at about 75% and the next Chromium snap revision trips it
     * again, so the operator who follows that advice is back in a week. The
     * lasting fix is a bigger disk, which is now a thing they can ask for.
     */
    return (
      `the system disk is ${pct(root)} full${of}${free ? `, ${free.text} free` : ""} — hermeticd needs room ` +
      "for a new binary and its backup before it will update. A rebuild frees it for now; a bigger " +
      "--root-gib on the recreate keeps it free"
    );
  }
  // `0%` is not a measurement here: an unmounted `/data` reads as empty, and
  // that — not a full volume — is the other way this check goes red.
  if (data !== null && data > 0) {
    return `the data disk is ${pct(data)} full of ${a.volume_gib} GiB${root === null ? "" : ` · system disk ${pct(root)}`}`;
  }
  return "data volume is low or unmounted";
}

export function loadColor(v: number | null | undefined): string {
  if (v === null || v === undefined) return "var(--fg3)";
  if (v > 85) return "var(--bad)";
  if (v > 70) return "var(--warn)";
  return "var(--fg2)";
}

export function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v)}%`;
}

/**
 * How much of a volume a percentage accounts for, in GiB.
 *
 * One decimal below 10 GiB, none above. Rounding to whole GiB throughout is
 * what made a 100 GiB data volume at 0.1% read `0 GiB used` — literally true to
 * the nearest gigabyte, and indistinguishable on screen from a volume nothing
 * had ever written to or from one hermeticd had failed to measure.
 */
export function usedGib(pctUsed: number | null | undefined, sizeGib: number): string {
  if (pctUsed === null || pctUsed === undefined) return "—";
  const gib = (pctUsed / 100) * sizeGib;
  return `${gib < 10 ? gib.toFixed(1) : Math.round(gib)} GiB`;
}

export function width(v: number | null | undefined): string {
  return `${v === null || v === undefined ? 0 : Math.max(0, Math.min(100, v))}%`;
}

/**
 * The name to address the node by: core's `agentHostname`
 * (`@hermetic/core/shared`), with the explicit-argument shape every call site
 * here uses, so each says at a glance whether it passed the real name or is
 * deliberately building the canonical one (the create drawer, previewing a
 * name no node holds yet).
 *
 * `dnsName` is what the node reported about itself (`tailscale_dns_name`), and
 * it wins whenever it is there. Tailscale gives a joining node the name it asks
 * for only if nothing else holds it, and `agent recreate` deletes the old device
 * — unless the fleet's OAuth client predates `devices:core` and carries only
 * `auth_keys`, in which case the replacement comes up as `<name>-2` and MagicDNS
 * keeps pointing `<name>` at the corpse. Serve answers on the real name and the
 * dashboard's rebinding guard admits only that Host, so an "Open dashboard"
 * built from the canonical spelling opens a dead node.
 *
 * `fleetId` is the last argument and optional: since foundation v4 a node
 * joins the tailnet as `<fleet id>-<agent>` (`cloudName`), and a caller that
 * does not know the fleet's id gets the bare agent name.
 */
export function hostname(
  name: string,
  tailnet?: string | null,
  dnsName?: string | null,
  fleetId?: string | null,
): string {
  return agentHostname(
    { name, tailscale_dns_name: dnsName ?? null },
    tailnet ?? DEFAULT_TAILNET,
    cloudName(fleetId, name),
  );
}

/** The canonical spelling, whatever the node ended up called. */
export function canonicalHostname(
  name: string,
  tailnet?: string | null,
  fleetId?: string | null,
): string {
  return hostname(name, tailnet, null, fleetId);
}

/**
 * How a node's real name differs from the one hermetic would give it today —
 * null when they agree, when the node has not reported yet, or when the caller
 * does not know the tailnet. Core's `agentHostnameMismatch`, given the fleet's
 * `legacyCloudNames`.
 *
 * `kind` separates the two cases core separates: a `legacy` node is a healthy
 * box built before the naming rule moved and keeps its hostname until it is
 * recreated, while a `stale` one has had its name taken by a device a
 * `recreate` failed to delete. The drawer must not offer "delete it in the
 * admin console" for the first — that device is the machine the agent is
 * running on. `fleetName` is passed for exactly that test, and is not used to
 * build any name.
 *
 * The null-tailnet clause matters: `DEFAULT_TAILNET` is a good enough guess to
 * *display* a hostname with, and nowhere near good enough to accuse a node of
 * holding the wrong name. Until `/api/meta` lands, `tailnet` is null and every
 * agent that has reported a dns name would otherwise be called stale — the
 * note would flash onto every card on first paint and then vanish. Callers
 * must therefore pass the raw `meta?.tailnet ?? null`, not the defaulted
 * `fleet.tailnet`.
 */
export function hostnameMismatch(
  agent: { name: string; tailscale_dns_name?: string | null },
  tailnet?: string | null,
  fleetId?: string | null,
  fleetName?: string | null,
): { real: string; canonical: string; kind: "legacy" | "stale" } | null {
  if (!tailnet) return null;
  return agentHostnameMismatch(
    agent,
    tailnet,
    cloudName(fleetId, agent.name),
    legacyCloudNames(fleetName, agent.name),
  );
}

/**
 * Where the agent's own Hermes dashboard lives. `/` is the Serve route core
 * renders for `hermes dashboard` on 9119 (`render.ts`'s `tailscaleServeConfig`),
 * so the tailnet hostname alone is the whole URL.
 */
export function dashboardUrl(
  name: string,
  tailnet?: string | null,
  dnsName?: string | null,
  fleetId?: string | null,
): string {
  return `https://${hostname(name, tailnet, dnsName, fleetId)}/`;
}

/**
 * The agent's desktop — noVNC over the `/vnc` route Tailscale Serve publishes
 * for the browser stack (§7.3): core's `agentDesktopUrl`. `browser` names
 * which browser identity to watch, and defaults to the only one an agent runs
 * today.
 */
export function desktopUrl(
  name: string,
  tailnet?: string | null,
  dnsName?: string | null,
  fleetId?: string | null,
  browser?: string,
): string {
  return agentDesktopUrl(
    { name, tailscale_dns_name: dnsName ?? null },
    tailnet ?? DEFAULT_TAILNET,
    cloudName(fleetId, name),
    browser,
  );
}

/**
 * The same desktop, addressed by the URL that actually connects: core's
 * `agentDesktopClientUrl`. noVNC builds its websocket URL from the site root,
 * so it needs `path=` to find the `/vnc` prefix Serve published it under; this
 * is also the form that works on an agent that has not re-applied its manifest
 * yet, where `/vnc/` alone is still a directory listing — which is why the
 * embedded viewer uses this one and "open in a new tab" uses `desktopUrl`.
 */
export function desktopClientUrl(
  name: string,
  tailnet?: string | null,
  dnsName?: string | null,
  fleetId?: string | null,
  browser?: string,
): string {
  return agentDesktopClientUrl(
    { name, tailscale_dns_name: dnsName ?? null },
    tailnet ?? DEFAULT_TAILNET,
    cloudName(fleetId, name),
    browser,
  );
}

/** Semver-ish compare that tolerates a leading `v` and missing segments. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * `/api/meta.hermes_version` is the fleet's latest when the server knows it;
 * `portal.ts` does not pass one, so fall back to the highest version in the fleet.
 */
export function latestHermes(
  agents: AgentView[],
  metaVersion: string | null | undefined,
): string | null {
  if (metaVersion) return metaVersion;
  let best: string | null = null;
  for (const a of agents) {
    if (!best || compareVersions(a.hermes_version, best) > 0) best = a.hermes_version;
  }
  return best;
}

export function isBehind(a: AgentView, latest: string | null): boolean {
  // A destroyed row is never behind: it is terminal (§4.3), so the version it
  // died on is the version it keeps, and painting it warn-orange would put the
  // "needs an upgrade" signal on the one agent that cannot take one. A stopped
  // agent still counts as behind — it picks the upgrade up on its next start.
  if (a.display_status === "destroyed") return false;
  return latest !== null && compareVersions(a.hermes_version, latest) < 0;
}

export function versionColor(a: AgentView, latest: string | null): string {
  return isBehind(a, latest) ? "var(--warn)" : "var(--fg)";
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${String(h).padStart(2, "0")}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

/** Uptime column: age since `created_at`, or `—` for anything not running. */
export function uptime(a: AgentView, now: number): string {
  if (isOff(a) || a.last_heartbeat === null || a.last_heartbeat === undefined) return "—";
  return fmtDuration(now - Date.parse(a.created_at));
}

export function heartbeatAge(a: AgentView): string {
  if (a.heartbeat_age_ms === null) return "never";
  if (a.heartbeat_age_ms < 60_000) return "just now";
  return `${fmtDuration(a.heartbeat_age_ms)} ago`;
}

export function fmtUsd(n: number): string {
  return `$${Math.round(n)}`;
}

export function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toTimeString().slice(0, 8);
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

/**
 * This browser's short timezone name (`PDT`, `GMT+2`), or `""` when the runtime
 * will not say. Every absolute time in this UI is rendered in the operator's
 * local zone, and §4.4 has more than one operator per fleet — a wall clock with
 * no zone on it is a number two people will read differently and both be sure
 * of. Falls back to the IANA id, then to nothing: an unlabelled time is still
 * better than a crash on a runtime with no `Intl`.
 */
export function tzLabel(at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(at);
    const zone = parts.find((p) => p.type === "timeZoneName")?.value;
    if (zone) return zone;
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

/** `fmtClock` with the zone on it, for a wall clock shown on its own. */
export function fmtClockTz(iso: string): string {
  const clock = fmtClock(iso);
  if (clock === "--:--:--") return clock;
  const zone = tzLabel(new Date(iso));
  return zone ? `${clock} ${zone}` : clock;
}

/**
 * One absolute moment, date and time, in the operator's zone and labelled with
 * it. The wizard's teardown banner and the teardown receipt both wanted this
 * and both hand-rolled `new Date(iso).toLocaleString()` — the receipt without
 * an invalid-date guard, so a malformed record rendered "Invalid Date".
 *
 * An unparseable input comes back as the raw string rather than as a dash: this
 * is a record of something that happened, and the bytes that were stored are
 * more use to whoever has to explain them than an em dash is.
 */
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return d.toLocaleString();
  }
}

export function agentCost(a: AgentView): { monthly: string; hourly: string } {
  const spec = sizeSpec(a.size);
  // A destroy that deleted the volume nulls `volume_id` but leaves `volume_gib` on the
  // row as a record of what was there, so billing off the size alone would keep
  // charging for a volume AWS no longer has.
  const storage = a.volume_id ? a.volume_gib * GP3_USD_PER_GIB_MONTH : 0;
  /**
   * The root disk bills too, and at 500 GiB it is not a rounding error.
   *
   * Keyed on `instance_id` rather than on status: the root volume is created
   * and destroyed with the instance (`DeleteOnTermination`), so a *stopped*
   * agent is still paying for it while its compute is free, which is exactly
   * the case the line below has to get right. A row from before `root_gib`
   * existed contributes nothing — its size is genuinely unknown, and guessing
   * today's default would invent a charge.
   */
  const root = a.instance_id ? (a.root_gib ?? 0) * GP3_USD_PER_GIB_MONTH : 0;
  if (a.display_status === "destroyed") {
    return {
      monthly: `≈ ${fmtUsd(storage)}/mo`,
      hourly: storage ? "storage only · data volume retained" : "terminated · no ongoing cost",
    };
  }
  if (isOff(a)) {
    return {
      monthly: `≈ ${fmtUsd(storage + root)}/mo`,
      hourly: "compute stopped · storage only",
    };
  }
  return {
    monthly: `≈ ${fmtUsd(spec.monthlyUsd + storage + root)}/mo`,
    hourly: `~$${spec.hourlyUsd.toFixed(3)}/h compute + ${fmtUsd(storage + root)}/mo gp3`,
  };
}
