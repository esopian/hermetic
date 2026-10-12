/*
 * Geometry for the landing page's blueprint (BlueprintScene.astro, Blueprint.astro): one agent's
 * machine as an isometric line drawing, the row of five that makes a fleet, the AWS account with
 * the foundation slab under it, and the operator's Mac on the tailnet. All numbers are scene units;
 * each stage's frame is the viewBox the drawing zooms to. Agent names and the account id are
 * illustrative.
 */
import { DEFAULT_DATA_GIB, SIZES } from "../../data/cost";

export type Pt = readonly [number, number];
const C = Math.cos(Math.PI / 6);
export const f = (n: number): number => Math.round(n * 10) / 10;
/** World (x, y, z) to screen, relative to a screen origin. */
const P = (o: Pt, x: number, y: number, z: number): Pt => [o[0] + (x - y) * C, o[1] + (x + y) / 2 - z];
const poly = (...p: Pt[]): string => p.map(([x, y]) => `${f(x)},${f(y)}`).join(" ");
const cuboid = (o: Pt, x: number, y: number, z: number, w: number, d: number, h: number) => ({
  top: poly(P(o, x, y, z + h), P(o, x + w, y, z + h), P(o, x + w, y + d, z + h), P(o, x, y + d, z + h)),
  left: poly(
    P(o, x, y + d, z),
    P(o, x + w, y + d, z),
    P(o, x + w, y + d, z + h),
    P(o, x, y + d, z + h),
  ),
  right: poly(
    P(o, x + w, y, z),
    P(o, x + w, y + d, z),
    P(o, x + w, y + d, z + h),
    P(o, x + w, y, z + h),
  ),
});
/* Text laid onto a face: left face (y const, runs along +x), right face (x const, runs along -y), top. */
const M = f(C * 1000) / 1000;
const onLeft = (p: Pt): string => `matrix(${M} 0.5 0 1 ${f(p[0])} ${f(p[1])})`;
const onRight = (p: Pt): string => `matrix(${M} -0.5 0 1 ${f(p[0])} ${f(p[1])})`;
const onTop = (p: Pt): string => `matrix(${M} 0.5 ${-M} 0.5 ${f(p[0])} ${f(p[1])})`;

const W = 140; // box footprint (x and y)
const H = 120; // box height
const STEP = 300; // screen distance between boxes in the row
export const BUS_Y = -270; // the tailnet line's height above the row
export const DROP_DX = -165; // where each box's tailnet drop falls, relative to the box
const PORT: Pt = P([0, 0], 12, W, 26); // the tailnet port on the left face

const NAMES: Record<number, string> = {
  [-2]: "wren",
  [-1]: "juno",
  0: "atlas",
  1: "corvid",
  2: "kestrel",
};

const box = (i: number) => {
  const o: Pt = [i * STEP, 0];
  const port: Pt = [o[0] + PORT[0], PORT[1]];
  return {
    i,
    o,
    name: NAMES[i] ?? "agent",
    body: cuboid(o, 0, 0, 0, W, W, H),
    vol: cuboid(o, 15, 15, -66, 110, 110, 32),
    bolts: [
      [25, 25],
      [115, 25],
      [115, 115],
      [25, 115],
    ].map(([x = 0, y = 0]) => ({ a: P(o, x, y, -34), b: P(o, x, y, 0) })),
    hermes: onLeft(P(o, 12, W, 86)),
    hermesSub: onLeft(P(o, 12, W, 68)),
    port: poly(P(o, 12, W, 18), P(o, 28, W, 18), P(o, 28, W, 34), P(o, 12, W, 34)),
    portTx: onLeft(P(o, 34, W, 21)),
    right: [92, 77, 62].map((z) => onRight(P(o, W, 128, z))),
    nameTx: onTop(P(o, 14, 128, H)),
    mark: poly(P(o, 14, 14, H), P(o, 32, 14, H), P(o, 32, 32, H), P(o, 14, 32, H)),
    vents: [52, 64, 76, 88, 100].map((y) => [P(o, 58, y, H), P(o, 128, y, H)] as const),
    /* Outbound arrows, drawn from the roof upward: x, roof y, tip y. */
    arrows: (
      [
        [30, -40, -205],
        [52, -48, -218],
        [74, -40, -205],
      ] as const
    ).map(([x, y0, y1]) => ({
      x: o[0] + x,
      y0,
      y1,
      line: `M${o[0] + x},${y0} V${y1 + 10}`,
      head: poly([o[0] + x - 7, y1 + 12], [o[0] + x + 7, y1 + 12], [o[0] + x, y1]),
    })),
    volTx: onLeft(P(o, 26, 125, -58)),
    dropX: o[0] + DROP_DX,
    drop: `M${o[0] + DROP_DX},${BUS_Y} V${f(PORT[1])} H${f(port[0])}`,
    port0: port,
    junction: [o[0] + DROP_DX - 5, BUS_Y - 5] as const,
    /* Where a dropping box's label sits (recreate beat). */
    mid: [o[0], 0] as const,
  };
};
export type Box = ReturnType<typeof box>;
export const ROW: Box[] = [-2, -1, 0, 1, 2].map(box);
export const HERO = ROW[2] as Box;
export const CORVID = ROW[3] as Box;

/* ---------- stage 1: dimension lines and numbered callouts ---------- */
export const vcpu = [Math.min(...SIZES.map((s) => s.vcpu)), Math.max(...SIZES.map((s) => s.vcpu))];
export const mem = [Math.min(...SIZES.map((s) => s.memGib)), Math.max(...SIZES.map((s) => s.memGib))];
const roofA = P([0, 0], 0, W, H);
const roofB = P([0, 0], 0, 0, H);
const nUp: Pt = [-0.5, -C];
const off = (p: Pt, n: Pt, d: number): Pt => [p[0] + n[0] * d, p[1] + n[1] * d];
const volA = P([0, 0], 125, 125, -66);
const volB = P([0, 0], 125, 15, -66);
const nDn: Pt = [0.5, C];
const dim = (a: Pt, b: Pt, n: Pt, label: string, at: number) => {
  const mid: Pt = off([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], n, at);
  const d = n === nUp ? 24 : 20;
  const e = d + 6;
  return {
    main: [off(a, n, d), off(b, n, d)] as const,
    ends: [
      [a, off(a, n, e)],
      [b, off(b, n, e)],
    ] as const,
    label,
    at: `translate(${f(mid[0])} ${f(mid[1])}) rotate(-30)`,
  };
};
export const DIMS = [
  dim(roofA, roofB, nUp, `${vcpu[0]} to ${vcpu[1]} vCPU · ${mem[0]} to ${mem[1]} GiB`, 34),
  dim(volA, volB, nDn, `${DEFAULT_DATA_GIB} GiB gp3`, 40),
];

/* The ✕ where unsolicited inbound stops, on the hero's right face. */
export const XMARK: Pt = [94, 72];

/*
 * Callouts sit on three shared rows, left and right. Each leader leaves its number box level for a
 * short shelf, then runs straight to its target. side -1 = left, 1 = right.
 */
const ROWS = [-206, -52, 118] as const;
const NUM = 26;
const CALLOUTS = [
  { n: 1, side: -1, row: 0, t: "Tailnet", s: "the only way in", to: [DROP_DX, -150] },
  { n: 2, side: -1, row: 1, t: "Hermes", s: "the agent, on the metal", to: [-70, 0] },
  { n: 3, side: -1, row: 2, t: "Data volume", s: "outlives the machine", to: [-50, 146] },
  { n: 4, side: 1, row: 0, t: "Outbound", s: "web, models, packages", to: [74, -150] },
  { n: 5, side: 1, row: 1, t: "hermeticd", s: "installs, applies, reports", to: [62, 2] },
  { n: 6, side: 1, row: 2, t: "Inbound", s: "0 rules, dropped", to: [XMARK[0] + 10, XMARK[1] + 6] },
] as const;
export const CO = CALLOUTS.map((c) => {
  const y = ROWS[c.row];
  const cy = y + NUM / 2;
  const sx = c.side < 0 ? -300 : 274;
  const edge = c.side < 0 ? sx + NUM : sx;
  const shelf = edge - c.side * 22;
  return {
    ...c,
    y,
    sx,
    tx: c.side < 0 ? sx - 12 : sx + NUM + 12,
    anchor: c.side < 0 ? "end" : "start",
    lead: `M${edge},${cy} H${shelf} L${c.to[0]},${c.to[1]}`,
  };
});
/** The inbound probe's path: from callout 6 to the ✕ (the dashed red line). */
export const BLOCKED = CO[5]?.lead ?? "";

/* ---------- stage 4: the operator's Mac ---------- */
export const LO: Pt = [-1010, -620];
export const LAP = {
  base: cuboid(LO, 0, 0, 0, 230, 160, 12),
  panel: poly(P(LO, 0, 0, 12), P(LO, 230, 0, 12), P(LO, 230, 0, 160), P(LO, 0, 0, 160)),
  screen: poly(P(LO, 10, 0, 22), P(LO, 220, 0, 22), P(LO, 220, 0, 150), P(LO, 10, 0, 150)),
  content: onLeft(P(LO, 22, 0, 136)),
  keys: [30, 50, 70, 90, 110].map((y) => [P(LO, 24, y, 12), P(LO, 206, y, 12)] as const),
  port: P(LO, 230, 100, 6),
};
export const LAP_STATUS = ["ok", "ok", "acc", "ok", "warn"] as const;

/* ---------- stage 3: the account frame and the foundation slab ---------- */
export const ACC = { x0: -830, x1: 830, y0: -350, y1: 450 };
export const PL = { x0: -790, x1: 790, top: 250, front: 290, bottom: 380 };
export const FOUNDATION = [
  ["Network", "VPC, 0 inbound rules"],
  ["Agent records", "DynamoDB"],
  ["Config + builds", "S3 bucket"],
  ["Fleet role", "IAM"],
  ["Secrets", "SSM"],
] as const;
export const CELL = (PL.x1 - PL.x0) / FOUNDATION.length;

/* ---------- tailnet paths ---------- */
/** The bus from the account's left edge to the hero's drop (stage 1 onward). */
export const BUS_HERO = `M${ACC.x0},${BUS_Y} H${DROP_DX}`;
/** The bus's continuation across the row (stage 2 onward). */
export const BUS_REST = `M${DROP_DX},${BUS_Y} H${2 * STEP + DROP_DX}`;
const lapPort = `${f(LAP.port[0])},${f(LAP.port[1])}`;
/** The Mac's line down to the bus (stage 4). */
export const LAP_LINE = `M${lapPort} V${BUS_Y} H${ACC.x0}`;
const tail = (b: Box): string => `H${b.dropX} V${f(PORT[1])} H${f(b.port0[0])}`;
/**
 * Packet routes, live drawing only. `from` is the first stage a route carries traffic, `to` the
 * last: the account's edge into each box until the Mac arrives, then the Mac into each box.
 */
export const ROUTES = [
  ...ROW.map((b) => ({
    box: b.i,
    from: b.i === 0 ? 1 : 2,
    to: 3,
    d: `M${ACC.x0 - 120},${BUS_Y} ${tail(b)}`,
  })),
  ...ROW.map((b) => ({ box: b.i, from: 4, to: 4, d: `M${lapPort} V${BUS_Y} ${tail(b)}` })),
];

/* ---------- frames: [x, y, w, h] the drawing shows at each stage, wide and narrow ---------- */
export const WIDE = [
  [-520, -296, 1040, 560],
  [-830, -312, 1660, 580],
  [-870, -385, 1740, 870],
  [-1220, -890, 2080, 1360],
] as const;
export const NARROW = [
  [-318, -300, 636, 560],
  [-470, -310, 940, 580],
  [-870, -385, 1740, 870],
  [-1240, -900, 1400, 1380],
] as const;
export const vb = (r: readonly number[]): string => r.join(" ");
