/**
 * Seam: the cost page's prices (`site/src/data/cost.ts`) must be core's. The site
 * never imports `packages/`, so it carries its own copy of the size table and the
 * gp3, IPv4 and root-disk constants; this test reads both sides and fails if they
 * drift. The `fit` column is the site's own copy and is not compared.
 */
import { describe, expect, test } from "bun:test";
import { SIZES as CORE_SIZES } from "../packages/core/src/schema/agent.ts";
import { CreateAgentInput } from "../packages/core/src/schema/requests.ts";
import { EIP_USD_PER_MONTH } from "../packages/core/src/schema/teardown.ts";
import { GP3_USD_PER_GIB_MONTH as CORE_GP3 } from "../packages/core/src/schema/volumes.ts";
import { DEFAULT_ROOT_GIB as CORE_ROOT } from "../packages/core/src/shared/box.ts";
import {
  agentMonth,
  DEFAULT_ROOT_GIB,
  GP3_USD_PER_GIB_MONTH,
  IPV4_USD_PER_MONTH,
  MIN_DATA_GIB,
  SIZES,
} from "../site/src/data/cost";

const round = (n: number): number => Math.round(n * 100) / 100;

describe("site cost data matches core", () => {
  test("every size, in core's order, with the same instance, shape and price", () => {
    const core = Object.entries(CORE_SIZES).map(([id, s]) => ({
      id,
      instance: s.instance_type,
      vcpu: s.vcpu,
      memGib: s.memGib,
      gpu: s.gpu === undefined ? undefined : `${s.gpu.count} × ${s.gpu.model}, ${s.gpu.memGib} GiB`,
      monthlyUsd: Math.round(s.monthlyUsd),
    }));
    const site = SIZES.map(({ fit: _fit, ...s }) => ({ ...s, monthlyUsd: Math.round(s.monthlyUsd) }));
    expect(site).toEqual(core);
  });

  test("storage, address and root-disk constants", () => {
    expect(GP3_USD_PER_GIB_MONTH).toBe(CORE_GP3);
    expect(IPV4_USD_PER_MONTH).toBe(EIP_USD_PER_MONTH);
    expect(DEFAULT_ROOT_GIB).toBe(CORE_ROOT);
  });

  test("the smallest data volume is the smallest one create accepts", () => {
    const volume = CreateAgentInput.shape.volume_gib;
    expect(volume.safeParse(MIN_DATA_GIB).success).toBe(true);
    expect(volume.safeParse(MIN_DATA_GIB - 1).success).toBe(false);
  });

  test("a stopped agent bills only its disks", () => {
    const lines = agentMonth("medium");
    expect(lines.filter((l) => l.stopped > 0).every((l) => l.label.includes("volume"))).toBe(true);
    expect(round(lines.reduce((n, l) => n + l.running, 0))).toBe(round(196 + 120 * 0.08 + 3.65));
  });
});
