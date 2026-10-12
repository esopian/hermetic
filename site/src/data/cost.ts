/*
 * The numbers the cost page prints. hermetic makes no Cost Explorer call, and neither does this
 * page: every figure is a us-east-1 on-demand list price, rounded, and the bill is whatever AWS
 * says it is.
 *
 * SIZES, GP3_USD_PER_GIB_MONTH, IPV4_USD_PER_MONTH and DEFAULT_ROOT_GIB mirror core
 * (packages/core/src/schema/agent.ts SIZES, schema/volumes.ts, schema/teardown.ts,
 * shared/box.ts). The site never imports packages/, so tests/site-cost.test.ts at the repo root
 * compares the two and fails if they drift: change them together.
 */

export interface SitePrice {
  id: string;
  instance: string;
  vcpu: number;
  memGib: number;
  /** "1 × NVIDIA T4G, 16 GiB" on the G5g profiles. */
  gpu?: string;
  monthlyUsd: number;
  fit: string;
}

/** design.md §7.1: the named profiles, Graviton (Arm) throughout. */
export const SIZES: readonly SitePrice[] = [
  {
    id: "micro",
    instance: "t4g.micro",
    vcpu: 2,
    memGib: 1,
    monthlyUsd: 7,
    fit: "Tiny tasks and lightweight API workers",
  },
  {
    id: "xxsmall",
    instance: "t4g.small",
    vcpu: 2,
    memGib: 2,
    monthlyUsd: 14,
    fit: "Lightweight CLI and automation tasks",
  },
  {
    id: "xsmall",
    instance: "t4g.medium",
    vcpu: 2,
    memGib: 4,
    monthlyUsd: 28,
    fit: "Small, burstable browser-free agents",
  },
  {
    id: "small",
    instance: "r8g.large",
    vcpu: 2,
    memGib: 16,
    monthlyUsd: 86,
    fit: "No-browser agents: chat, API, tool-calling",
  },
  {
    id: "medium",
    instance: "t4g.2xlarge",
    vcpu: 8,
    memGib: 32,
    monthlyUsd: 196,
    fit: "The default. Hermes, a headed browser and a virtual display, with headroom",
  },
  {
    id: "large",
    instance: "r8g.2xlarge",
    vcpu: 8,
    memGib: 64,
    monthlyUsd: 344,
    fit: "Large contexts, multiple browser profiles, heavy local tooling",
  },
  {
    id: "xlarge",
    instance: "r8g.4xlarge",
    vcpu: 16,
    memGib: 128,
    monthlyUsd: 688,
    fit: "Parallel browser sessions and memory-heavy tooling",
  },
  {
    id: "xxlarge",
    instance: "r8g.8xlarge",
    vcpu: 32,
    memGib: 256,
    monthlyUsd: 1376,
    fit: "Large concurrent workloads and local data processing",
  },
  {
    id: "3xlarge",
    instance: "r8g.16xlarge",
    vcpu: 64,
    memGib: 512,
    monthlyUsd: 2752,
    fit: "Fleet-scale processing and very large contexts",
  },
  {
    id: "gpu-xsmall",
    instance: "g5g.xlarge",
    vcpu: 4,
    memGib: 8,
    gpu: "1 × NVIDIA T4G, 16 GiB",
    monthlyUsd: 307,
    fit: "GPU graphics and light CUDA workloads",
  },
  {
    id: "gpu-small",
    instance: "g5g.2xlarge",
    vcpu: 8,
    memGib: 16,
    gpu: "1 × NVIDIA T4G, 16 GiB",
    monthlyUsd: 406,
    fit: "GPU-accelerated tools with more CPU headroom",
  },
  {
    id: "gpu-medium",
    instance: "g5g.4xlarge",
    vcpu: 16,
    memGib: 32,
    gpu: "1 × NVIDIA T4G, 16 GiB",
    monthlyUsd: 604,
    fit: "Balanced GPU compute and browser workloads",
  },
  {
    id: "gpu-large",
    instance: "g5g.8xlarge",
    vcpu: 32,
    memGib: 64,
    gpu: "1 × NVIDIA T4G, 16 GiB",
    monthlyUsd: 1002,
    fit: "CPU-heavy GPU rendering and inference",
  },
  {
    id: "gpu-xlarge",
    instance: "g5g.16xlarge",
    vcpu: 64,
    memGib: 128,
    gpu: "2 × NVIDIA T4G, 32 GiB",
    monthlyUsd: 2003,
    fit: "Dual-GPU accelerated workloads",
  },
];

/** gp3 list price, USD per GiB-month (core: GP3_USD_PER_GIB_MONTH). */
export const GP3_USD_PER_GIB_MONTH = 0.08;
/** A public IPv4 address, $0.005 an hour at 730 hours (core: EIP_USD_PER_MONTH). */
export const IPV4_USD_PER_MONTH = 3.65;
/** design.md §7.1: root volume default (core: DEFAULT_ROOT_GIB). */
export const DEFAULT_ROOT_GIB = 20;
/** design.md §7.1: data volume default. */
export const DEFAULT_DATA_GIB = 100;
/** The smallest data volume `agent create --volume-gib` accepts (core: CreateAgentInput.volume_gib). */
export const MIN_DATA_GIB = 8;

export const sizeById = (id: string): SitePrice => {
  const size = SIZES.find((s) => s.id === id);
  if (size === undefined) throw new Error(`data/cost.ts: no size "${id}"`);
  return size;
};

export interface Line {
  label: string;
  running: number;
  stopped: number;
}

/**
 * One agent's month, running all month and stopped all month, at the default root disk and the
 * given data volume (the default unless stated). A stopped
 * instance bills nothing for compute and gives its auto-assigned public IPv4 back (design.md
 * §7.1); its two gp3 volumes keep billing.
 */
export function agentMonth(id: string, dataGib: number = DEFAULT_DATA_GIB): Line[] {
  const size = sizeById(id);
  const root = DEFAULT_ROOT_GIB * GP3_USD_PER_GIB_MONTH;
  const data = dataGib * GP3_USD_PER_GIB_MONTH;
  return [
    { label: `${size.instance} instance`, running: size.monthlyUsd, stopped: 0 },
    { label: `${DEFAULT_ROOT_GIB} GiB root volume`, running: root, stopped: root },
    { label: `${dataGib} GiB data volume (memory)`, running: data, stopped: data },
    { label: "Public IPv4 address", running: IPV4_USD_PER_MONTH, stopped: 0 },
  ];
}

/** Whole dollars when the figure is whole or large, cents otherwise: $7, $196, $1,376, $20.25. */
export const usd = (n: number): string =>
  n >= 100 || Number.isInteger(n) ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`;
