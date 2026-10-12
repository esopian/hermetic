/* hermetic explainer — a beat-driven scene player with several pathways.
 *
 * Scenes live in one library (scene()). A pathway (pathway()) is a playlist of scene ids grouped
 * into chapters, with optional branch stops that splice a detour in, optional per-path narration
 * (overrides), and an optional tally (seals, walls, …) its beats award with `mark`.
 *
 * Inside a scene: an element carrying data-b="n" is revealed at beat n, data-x="n" dims it from beat
 * n, data-h="a,b" outlines it on exactly those beats. An arrowed wire() carries a one-way dot flow.
 * Beats carry the narration (c), code references (r), and optionally the mark they award (mark).
 */

/* ---------------------------------------------------------------- the security path's tally */
const SEALS = [
  {
    id: "boundaries",
    name: "Package boundaries",
    where:
      "tests/boundaries.test.ts — the import matrix; agentd can't reach fleet ops, ui can't reach core",
  },
  {
    id: "account",
    name: "Frozen account",
    where: "aws/client.ts — every AWS client re-verifies STS before send(); ACCOUNT_MISMATCH",
  },
  {
    id: "triple",
    name: "Fleet identity triple",
    where: "{account_id, region, fleet_id} on every mutation; FLEET_MISMATCH; app/target.ts",
  },
  {
    id: "named",
    name: "Fleet-named resources",
    where: "hermetic-<fleet_id>-* names; hermetic:fleet_id tag on every lookup and the DLM target",
  },
  {
    id: "sg",
    name: "Zero inbound rules",
    where: "Security group with no ingress; create refuses if one appears; doctor verifies",
  },
  {
    id: "iam",
    name: "Fleet-scoped IAM",
    where:
      "Box role reads /hermes/<fleet>/* only; never /hermetic/*; no Scan, RunInstances, PutParameter",
  },
  {
    id: "tailnet",
    name: "Tailnet is the perimeter",
    where: "tag:hermetic ACL on 22/443/7434; managed policy blocks; validate + If-Match",
  },
  {
    id: "supply",
    name: "Content-addressed releases",
    where: "Generations by sha256, manifest written last, MANIFEST_REFUSED, presigned 1h URL",
  },
  {
    id: "pin",
    name: "Pinned Hermes",
    where: "hermes_ref from the fleet bucket; image-provenance.json blocks `hermes update`",
  },
  {
    id: "nft",
    name: "Host firewall",
    where: "nftables policy drop; accept only lo + tailscale0 (render-system.ts)",
  },
  {
    id: "loopback",
    name: "Loopback-only listeners",
    where: "Everything binds 127.0.0.1; render-network-invariants.test.ts; nginx owns the whole conf",
  },
  {
    id: "instance",
    name: "Instance is the boundary",
    where: "One agent = one instance, kernel, volume, role binding; root inside by design",
  },
  {
    id: "browser",
    name: "Contained browser",
    where: "Chrome as `hermes`, AppArmor keeps the sandbox on, CDP on loopback, no snap",
  },
  {
    id: "secrets",
    name: "Secret path",
    where: "Slot & push → SSM → tmpfs 0600; never git, user-data, AMI, SQLite, /data or logs",
  },
  {
    id: "noport",
    name: "No control port",
    where: "Commands ride the DynamoDB row; the box's only RPC is logs/health behind tailscale whois",
  },
  {
    id: "app",
    name: "Portless desktop app",
    where: "No socket, no port; views:// only; noVNC in a sandboxed webview with no RPC bridge",
  },
  {
    id: "chat",
    name: "Chat redaction door",
    where: "chat-seal.ts / chat-redact.ts; core owns Hermes's shapes; no transcript stored",
  },
  {
    id: "cas",
    name: "Optimistic concurrency + TTL locks",
    where: "version CAS on every write; 10-min locks; fleet lock during teardown",
  },
  {
    id: "plan",
    name: "Plan → confirm → apply",
    where: "Core never asks; heads confirm; typed account id for teardown",
  },
  {
    id: "lab",
    name: "Sealed lab",
    where: "Fixture backend, no network in tests, fresh HERMETIC_HOME, secrets-leak test",
  },
];
const SEAL_INDEX = Object.fromEntries(SEALS.map((s, i) => [s.id, i]));

/* ---------------------------------------------------------------- markup helpers (global, used by scenes) */
function at(o = {}) {
  let a = "";
  if (o.b != null) a += ` data-b="${o.b}"`;
  if (o.x != null) a += ` data-x="${o.x}"`;
  if (o.h != null) a += ` data-h="${o.h}"`;
  if (o.id) a += ` id="${o.id}"`;
  return a;
}
const px = (x, y, w, h) =>
  `left:${x}px;top:${y}px;${w != null ? `width:${w}px;` : ""}${h != null ? `height:${h}px;` : ""}`;
function bx(x, y, w, h, t, s = "", o = {}) {
  return `<div class="bx ${o.c || ""} ${o.a || "up"}"${at(o)} style="${px(x, y, w, h)}${o.st || ""}">${o.k ? `<div class="k">${o.k}</div>` : ""}${t ? `<div class="t">${t}</div>` : ""}${s ? `<div class="s">${s}</div>` : ""}${o.html || ""}</div>`;
}
function zone(x, y, w, h, l, o = {}) {
  return `<div class="zone ${o.c || ""}"${at(o)} style="${px(x, y, w, h)}${o.st || ""}"><div class="zl">${l}</div>${o.html || ""}</div>`;
}
function tag(x, y, t, o = {}) {
  return `<div class="tag ${o.c || ""} ${o.a || "pop"}"${at(o)} style="${px(x, y)}${o.st || ""}">${t}</div>`;
}
function term(x, y, w, h, body, o = {}) {
  return `<div class="term ${o.c || ""} ${o.a || "up"}"${at(o)} style="${px(x, y, w, h)}${o.st || ""}">${body}</div>`;
}
function code(x, y, w, h, head, body, o = {}) {
  return `<div class="code ${o.c || ""} ${o.a || "up"}"${at(o)} style="${px(x, y, w, h)}${o.st || ""}"><span class="h">${head}</span>${body}</div>`;
}
function txt(x, y, w, html, o = {}) {
  return `<div class="${o.cls || "note"} ${o.a || "up"}"${at(o)} style="${px(x, y, w)}${o.st || ""}">${html}</div>`;
}
function big(x, y, html, size, o = {}) {
  return `<div class="big ${o.a || "up"}"${at(o)} style="${px(x, y)}font-size:${size}px;${o.st || ""}">${html}</div>`;
}
function kick(x, y, t, o = {}) {
  return `<div class="kick ${o.a || "up"}"${at(o)} style="${px(x, y)}${o.st || ""}">${t}</div>`;
}
function st(x, y, t, o = {}) {
  return `<div class="st ${o.c || ""} ${o.a || "pop"}"${at(o)} style="${px(x, y)}${o.st || ""}">${t}</div>`;
}
function list(x, y, w, items, o = {}) {
  return `<div class="list ${o.a || "up"}"${at(o)} style="${px(x, y, w)}${o.st || ""}">${items
    .map((it) => {
      const [cls, html, b] = Array.isArray(it) ? it : ["", it];
      return `<div class="li ${cls} ${b != null ? "up" : ""}"${b != null ? ` data-b="${b}"` : ""}><i></i><div>${html}</div></div>`;
    })
    .join("")}</div>`;
}
/** A numbered badge for a tally mark; the number is the mark's position in the current path's tally. */
function sealBadge(x, y, id, o = {}) {
  return `<div class="seal pop ${o.c || ""}" data-mark="${id}"${at(o)} style="${px(x, y)}${o.st || ""}"><div><b>··</b><span class="u">SEAL</span></div></div>`;
}
/** An icon tile: a big glyph over a label, for the low-text pathways. */
function icon(x, y, w, h, glyph, label, o = {}) {
  return `<div class="icn ${o.c || ""} ${o.a || "pop"}"${at(o)} style="${px(x, y, w, h)}${o.st || ""}"><div class="g">${glyph}</div>${label ? `<div class="l">${label}</div>` : ""}${o.sub ? `<div class="sub">${o.sub}</div>` : ""}</div>`;
}

/* svg helpers */
function wire(d, o = {}) {
  const m = o.end === false ? "" : ` marker-end="url(#ar-${o.c || "fg"})"`;
  const ms = o.start ? ` marker-start="url(#as-${o.c || "fg"})"` : "";
  const line = `<path class="wire ${o.c || ""} ${o.w || ""}" pathLength="1" d="${d}"${m}${ms}${at(o)}/>`;
  // Data moves one way: the direction the arrowhead points. A wire with no head, or a head at
  // both ends, is a relation rather than a flow and gets no dots.
  const flows = o.flow !== false && o.end !== false && !o.start;
  return flows
    ? `${line}<path class="flow ${o.c || ""} ${o.w || ""}" d="${d}"${at({ b: o.b, x: o.x })}/>`
    : line;
}
function dline(d, o = {}) {
  return `<path class="dline up" d="${d}"${at(o)} style="${o.st || ""}"/>`;
}
/** A drafting dimension line: a hairline with a short tick across each end, and an optional label
 * at its midpoint. Purely a measure or a span, never a data flow. */
function dim(x1, y1, x2, y2, o = {}) {
  const lab =
    o.l != null
      ? `<text class="dim-t" x="${(x1 + x2) / 2 + (o.dx || 0)}" y="${(y1 + y2) / 2 + (o.dy ?? -8)}" text-anchor="middle">${o.l}</text>`
      : "";
  return `<g class="dim ${o.c || ""} up"${at(o)}><path class="dim-l" pathLength="1" d="M${x1} ${y1} L${x2} ${y2}" marker-start="url(#tk)" marker-end="url(#tk)"/>${lab}</g>`;
}
/** A single dot that runs a path and fades — only for things that never arrive (blocked probes). */
function pk(d, o = {}) {
  const lab = o.l ? `<text x="10" y="-9">${o.l}</text>` : "";
  return `<g class="pk ${o.c || ""}" data-d="${d}" data-dur="${o.dur || 2200}" data-ph="${o.ph || 0}"${at(o)}><circle r="${o.r || 6}"/>${lab}</g>`;
}
function lbl(x, y, t, o = {}) {
  return `<text class="lbl ${o.c || ""} up" x="${x}" y="${y}" text-anchor="${o.anchor || "start"}"${at(o)}>${t}</text>`;
}
const COLORS = {
  fg: "#a8a59c",
  acc: "#ff5a1f",
  ok: "#37c27f",
  bad: "#ef4d3f",
  blue: "#5aa9ff",
  warn: "#e8b03a",
  vio: "#b48cff",
};
// Drafting arrowheads: long, narrow and one size whatever the stroke. `tk` is a dimension tick.
const DEFS = `<defs>${Object.entries(COLORS)
  .map(
    ([k, v]) =>
      `<marker id="ar-${k}" viewBox="0 0 12 10" refX="10" refY="5" markerWidth="16" markerHeight="13" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,1 L12,5 L0,9 z" fill="${v}"/></marker>` +
      `<marker id="as-${k}" viewBox="0 0 12 10" refX="2" refY="5" markerWidth="16" markerHeight="13" markerUnits="userSpaceOnUse" orient="auto"><path d="M12,1 L0,5 L12,9 z" fill="${v}"/></marker>`,
  )
  .join(
    "",
  )}<marker id="tk" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M5,0 L5,10" stroke="${COLORS.fg}" stroke-width="1.5"/></marker></defs>`;

/* ---------------------------------------------------------------- registries */
const LIB = {};
const PATHS = [];
const GLOSSARY = {};
function scene(def) {
  if (LIB[def.id]) throw new Error(`scene ${def.id} registered twice`);
  LIB[def.id] = def;
}
function pathway(def) {
  PATHS.push(def);
}
function glossary(terms) {
  Object.assign(GLOSSARY, terms);
}
/** Scene-specific styles from a path file. */
function css(text) {
  const s = document.createElement("style");
  s.textContent = text;
  document.head.appendChild(s);
}

// The scene and path files are plain scripts that call these helpers as globals.
Object.assign(globalThis, {
  scene,
  pathway,
  glossary,
  css,
  bx,
  zone,
  tag,
  term,
  code,
  txt,
  big,
  kick,
  st,
  list,
  sealBadge,
  icon,
  wire,
  dline,
  dim,
  pk,
  lbl,
  SEALS,
  SEAL_INDEX,
});

/* ---------------------------------------------------------------- progress (localStorage) */
const STORE_KEY = "hermetic-explainer:v2";
function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || { paths: {} };
  } catch {
    return { paths: {} };
  }
}
function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(STORE));
  } catch {
    /* private mode: progress is simply not kept */
  }
}
const STORE = loadStore();
function pathState(id) {
  STORE.paths[id] ??= { si: 0, bi: 0, done: false, choices: {}, furthest: 0 };
  return STORE.paths[id];
}

/* ---------------------------------------------------------------- resolving a path into a sequence */
function pathById(id) {
  return PATHS.find((p) => p.id === id);
}
function resolveScene(path, ref, chapter) {
  const id = typeof ref === "string" ? ref : ref.id;
  const base = LIB[id];
  if (!base) throw new Error(`path ${path.id}: unknown scene ${id}`);
  const ov = { ...(path.overrides?.[id] || {}), ...(typeof ref === "string" ? {} : ref) };
  return { ...base, ...ov, id, ch: ov.ch || chapter };
}
/** The playable sequence for a path given its branch choices: scenes, branch stops, an end card. */
function sequence(path) {
  const choices = pathState(path.id).choices;
  const out = [];
  for (const ch of path.chapters) {
    for (const item of ch.items) {
      if (item && typeof item === "object" && item.branch) {
        const br = item.branch;
        out.push(branchScene(path, br, ch.name));
        const pick = choices[br.id];
        if (pick != null) {
          const opt = br.options[pick];
          for (const ref of opt.scenes || []) out.push(resolveScene(path, ref, opt.chapter || ch.name));
        }
      } else out.push(resolveScene(path, item, ch.name));
    }
  }
  out.push(endScene(path));
  return out;
}

/* ---------------------------------------------------------------- generated scenes: branch stop, end card */
function branchScene(path, br, chapter) {
  const pick = pathState(path.id).choices[br.id];
  const def = br.default ?? br.options.length - 1;
  const cards = br.options
    .map(
      (o, i) => `
      <button type="button" class="choice ${pick === i ? "picked" : ""} up" data-b="0" data-opt="${i}"
        style="${px(160 + i * (1280 / br.options.length), 300, 1280 / br.options.length - 40, 220)}">
        <div class="ck">${o.kicker || (i === def ? "default" : "option")}</div>
        <div class="ct">${o.label}</div>
        <div class="cs">${o.sub || ""}</div>
      </button>`,
    )
    .join("");
  return {
    id: `branch-${br.id}`,
    kind: "branch",
    branch: br,
    ch: chapter,
    title: br.title || "Choose your route",
    html: `
      ${kick(160, 90, br.kicker || "a fork in the path", { b: 0, st: "color:var(--acc)" })}
      ${big(156, 124, br.q, 52, { b: 0 })}
      ${txt(160, 218, 1280, br.hint || "", { b: 0, st: "font-size:20px" })}
      ${cards}
      <div class="countdown up" data-b="0" style="${px(160, 560, 1280)}"></div>`,
    beats: [
      {
        c:
          br.say ||
          `${br.q} Pick a route — or keep watching and we'll take “${br.options[def].label}”.`,
        d: 16000,
      },
    ],
    mount(cv) {
      cv.querySelectorAll(".choice").forEach((btn) => {
        btn.addEventListener("click", () => choose(br, Number(btn.dataset.opt)));
      });
    },
  };
}
function choose(br, opt) {
  const path = P.path;
  pathState(path.id).choices[br.id] = opt;
  saveStore();
  P.seq = sequence(path);
  buildTimeline();
  buildToc();
  const at = P.seq.findIndex((s) => s.id === `branch-${br.id}`);
  go(at + 1, 0, true);
  setPlaying(true);
}

function endScene(path) {
  const nexts = (path.next || []).map(pathById).filter(Boolean);
  return {
    id: "end",
    kind: "end",
    ch: "Done",
    title: `${path.title} — complete`,
    html: `
      <div class="pop" data-b="0" style="position:absolute;left:160px;top:96px;width:40px;height:40px;background:${path.color || "var(--acc)"}"></div>
      ${big(156, 150, `You've finished<br>${path.title}.`, 72, { b: 0 })}
      ${txt(160, 330, 900, path.outro || "", { b: 0, st: "font-size:21px" })}
      ${kick(160, 420, nexts.length ? "where to go next" : "", { b: 0 })}
      ${nexts
        .map(
          (n, i) => `
        <button type="button" class="choice up" data-b="0" data-path="${n.id}" style="${px(160 + i * 430, 452, 400, 170)}">
          <div class="ck" style="color:${n.color}">${n.audience}</div>
          <div class="ct">${n.title}</div>
          <div class="cs">${n.tagline}</div>
        </button>`,
        )
        .join("")}
      <button type="button" class="choice up" data-b="0" data-home="1" style="${px(1100, 96, 340, 110)}">
        <div class="ck">all paths</div><div class="ct">⌂ All paths</div>
      </button>`,
    beats: [
      {
        c:
          path.outroSay ||
          `That's the ${path.title} path. Pick another route below, or press <code>H</code> for all paths.`,
        d: 600000,
      },
    ],
    mount(cv) {
      cv.querySelectorAll("[data-path]").forEach((b) => {
        b.addEventListener("click", () => openPath(b.dataset.path, 0, 0));
      });
      cv.querySelector("[data-home]")?.addEventListener("click", showHome);
    },
  };
}

/* ---------------------------------------------------------------- player */
const P = {
  path: null,
  seq: [],
  si: 0,
  bi: 0,
  playing: true,
  speed: 1,
  elapsed: 0,
  last: 0,
  stampTimer: 0,
  els: [],
  pks: [],
};

function plain(html) {
  return html.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, " ");
}
function beatDur(b) {
  if (b.d) return b.d;
  const n = plain(b.c || "").length;
  return Math.max(4200, Math.min(15000, 1700 + n * 46));
}

const $ = (s) => document.querySelector(s);
/** No motion: `?still` (screenshots) or the reader's reduced-motion setting. */
const REDUCED = window.matchMedia?.("(prefers-reduced-motion: reduce)");
const STILL = () => document.body.classList.contains("still") || !!REDUCED?.matches;

function fit() {
  const vp = $("#viewport");
  const W = vp.clientWidth,
    H = vp.clientHeight;
  const s = Math.min(W / 1606, H / 906);
  const stage = $("#stage");
  stage.style.transform = `scale(${s})`;
  stage.style.left = `${(W - 1606 * s) / 2}px`;
  stage.style.top = `${(H - 906 * s) / 2}px`;
}

function buildTimeline() {
  const tl = $("#tl");
  tl.innerHTML = "";
  let prevCh = null;
  P.seq.forEach((sc, i) => {
    const seg = document.createElement("div");
    seg.className = `seg${prevCh && sc.ch !== prevCh ? " chapstart" : ""}${sc.kind ? ` ${sc.kind}` : ""}`;
    seg.style.flex = sc.kind ? "0.6" : String(sc.beats.length);
    seg.innerHTML = `<div class="fill"></div>`;
    seg.addEventListener("click", (e) => {
      const r = seg.getBoundingClientRect();
      const frac = (e.clientX - r.left) / r.width;
      go(i, Math.min(sc.beats.length - 1, Math.floor(frac * sc.beats.length)));
    });
    seg.addEventListener("mousemove", (e) => {
      const tip = $("#tl .tip");
      tip.style.display = "block";
      tip.textContent =
        sc.kind === "branch" ? `⑂ ${sc.title}` : `${String(i + 1).padStart(2, "0")} · ${sc.title}`;
      tip.style.left = `${e.clientX - tl.getBoundingClientRect().left}px`;
    });
    seg.addEventListener("mouseleave", () => {
      $("#tl .tip").style.display = "none";
    });
    tl.appendChild(seg);
    prevCh = sc.ch;
  });
  const tip = document.createElement("div");
  tip.className = "tip";
  tl.appendChild(tip);
}

function buildToc() {
  const path = P.path;
  const chapters = [];
  P.seq.forEach((sc, i) => {
    let ch = chapters.find((c) => c.name === sc.ch);
    if (!ch) {
      ch = { name: sc.ch, items: [] };
      chapters.push(ch);
    }
    ch.items.push([i, sc]);
  });
  $("#toc h2").textContent = path.title;
  $("#toc .sub").textContent = `${path.audience} · about ${path.minutes} minutes · ${path.tagline}`;
  $("#toc .cols").innerHTML = chapters
    .map(
      (c) =>
        `<div class="ch"><h3>${c.name}</h3>${c.items
          .map(
            ([i, sc]) =>
              `<a data-i="${i}"><span class="i">${sc.kind === "branch" ? "⑂" : sc.kind === "end" ? "■" : String(i + 1).padStart(2, "0")}</span><span>${sc.title}</span></a>`,
          )
          .join("")}</div>`,
    )
    .join("");
  $("#toc .other").innerHTML = `<h3>other paths</h3>${PATHS.filter((p) => p !== path)
    .map(
      (p) =>
        `<a data-p="${p.id}"><span class="i" style="color:${p.color}">■</span><span>${p.title}</span></a>`,
    )
    .join("")}<a data-home="1"><span class="i">⌂</span><span>All paths</span></a>`;
  $("#toc")
    .querySelectorAll("a[data-i]")
    .forEach((a) => {
      a.addEventListener("click", () => {
        go(Number(a.dataset.i), 0);
        toggleToc(false);
      });
    });
  $("#toc")
    .querySelectorAll("a[data-p]")
    .forEach((a) => {
      a.addEventListener("click", () => {
        toggleToc(false);
        openPath(a.dataset.p);
      });
    });
  $("#toc a[data-home]").addEventListener("click", () => {
    toggleToc(false);
    showHome();
  });
}
function toggleToc(force) {
  const t = $("#toc");
  const open = force ?? !t.classList.contains("open");
  t.classList.toggle("open", open);
  if (open) $("#gloss").classList.remove("open");
}
function toggleGloss(force) {
  const g = $("#gloss");
  const open = force ?? !g.classList.contains("open");
  g.classList.toggle("open", open);
  if (open) $("#toc").classList.remove("open");
}

function measure(g) {
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", g.dataset.d);
  $("#measure").appendChild(p);
  return { path: p, len: p.getTotalLength() };
}

/** The drawing-number prefix for a path: the prefix its own scene ids carry. */
const DWG_CODES = { overview: "OV", user: "USE", deploy: "DEP", contrib: "DEV", security: "SEC" };
function dwgCode(path) {
  return DWG_CODES[path.id] || path.id.slice(0, 3).toUpperCase();
}

function tallyOf(path) {
  return path?.tally || null;
}
function markIndex(id) {
  const t = tallyOf(P.path);
  return t ? t.items.findIndex((m) => m.id === id) : -1;
}

function mountScene() {
  const sc = P.seq[P.si];
  const cv = $("#cv");
  cv.innerHTML =
    `<svg class="wires" viewBox="0 0 1600 660">${DEFS}${sc.svg || ""}</svg>` +
    `<div class="lay">${sc.html || ""}</div>` +
    `<svg class="wires top" viewBox="0 0 1600 660" style="z-index:3">${DEFS}${sc.svgTop || ""}</svg>`;
  $("#measure").innerHTML = "";
  // Number every badge from the current path's own tally.
  const t = tallyOf(P.path);
  cv.querySelectorAll("[data-mark]").forEach((el) => {
    const i = markIndex(el.dataset.mark);
    el.querySelector("b").textContent = i >= 0 ? String(i + 1).padStart(2, "0") : "··";
    const u = el.querySelector(".u");
    if (u && t) u.textContent = t.unit;
    if (i < 0) el.classList.add("hide");
  });
  P.els = [...cv.querySelectorAll("[data-b],[data-x],[data-h]")];
  P.pks = [...cv.querySelectorAll("g.pk")].map((g) => ({ g, ...measure(g) }));
  $("#hdr .chap").textContent = sc.ch;
  $("#hdr .ttl").textContent = sc.title;
  const real = P.seq.filter((s) => !s.kind).length;
  const n = P.seq.slice(0, P.si + 1).filter((s) => !s.kind).length;
  // The title block names the sheet the way the landing's drawings do: DWG <path>-<nn>.
  const sheet = sc.kind === "branch" ? "FORK" : sc.kind === "end" ? "END" : String(n).padStart(2, "0");
  $("#hdr .dwg").textContent = `DWG ${dwgCode(P.path)}-${sheet}`;
  $("#hdr .sheet").textContent =
    `SHEET ${String(Math.min(n, real)).padStart(2, "0")} OF ${String(real).padStart(2, "0")}`;
  $("#cap .n").textContent =
    sc.kind === "branch" ? "⑂" : sc.kind === "end" ? "■" : String(n).padStart(2, "0");
  $("#cap .k").textContent = `OF ${real}`;
  document.body.dataset.kind = sc.kind || "scene";
  if (sc.mount) sc.mount(cv);
}

/** Wrap the first mention of each glossary term in the caption so it explains itself on hover. */
function glossify(root) {
  const def = (t) => (typeof GLOSSARY[t] === "string" ? GLOSSARY[t] : GLOSSARY[t].d);
  const terms = Object.keys(GLOSSARY)
    .filter((t) => typeof GLOSSARY[t] === "string" || GLOSSARY[t].link !== false)
    .sort((a, b) => b.length - a.length);
  if (!terms.length) return;
  const used = new Set();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (used.size >= 3) break;
    if (node.parentElement.closest("code, .gl")) continue;
    for (const t of terms) {
      if (used.has(t)) continue;
      const re = new RegExp(
        `(^|[^\\w-])(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=$|[^\\w-])`,
        "i",
      );
      const m = node.data.match(re);
      if (!m) continue;
      used.add(t);
      const start = m.index + m[1].length;
      const mid = node.splitText(start);
      mid.splitText(m[2].length);
      const span = document.createElement("span");
      span.className = "gl";
      span.dataset.def = def(t);
      span.textContent = mid.data;
      mid.replaceWith(span);
      break;
    }
  }
}

function applyBeat(announce) {
  const sc = P.seq[P.si];
  const b = sc.beats[P.bi];
  for (const el of P.els) {
    const on = el.dataset.b == null || P.bi >= Number(el.dataset.b);
    el.classList.toggle("on", on);
    if (el.dataset.x != null) el.classList.toggle("gone", P.bi >= Number(el.dataset.x));
    if (el.dataset.h != null)
      el.classList.toggle("hl", el.dataset.h.split(",").map(Number).includes(P.bi));
  }
  const say = $("#cap .say");
  say.innerHTML = b.c || "";
  glossify(say);
  $("#cap .refs").innerHTML = (b.r || []).map((r) => `<span>${r}</span>`).join("");
  $("#cap .bt").textContent = sc.kind ? "" : `beat ${P.bi + 1}/${sc.beats.length}`;
  if (sc.onBeat) sc.onBeat(P.bi, $("#cv"));
  updateTally();
  const mark = b.mark || b.seal;
  if (announce && mark && markIndex(mark) >= 0) stamp(mark);
  const url = `#${P.path.id}/${sc.id}/${P.bi + 1}`;
  if (location.hash !== url) history.replaceState(null, "", url);
  const ps = pathState(P.path.id);
  ps.si = P.si;
  ps.bi = P.bi;
  ps.furthest = Math.max(ps.furthest || 0, P.si / Math.max(1, P.seq.length - 1));
  if (sc.kind === "end") {
    ps.done = true;
    ps.furthest = 1;
  }
  saveStore();
}

function earnedMarks() {
  const got = new Set();
  for (let i = 0; i <= P.si; i++) {
    const sc = P.seq[i];
    const upto = i === P.si ? P.bi : sc.beats.length - 1;
    for (let j = 0; j <= upto; j++) {
      const m = sc.beats[j].mark || sc.beats[j].seal;
      if (m && markIndex(m) >= 0) got.add(m);
    }
  }
  return got;
}
function updateTally() {
  const t = tallyOf(P.path);
  const box = $("#hdr .seals");
  box.style.display = t ? "" : "none";
  if (!t) return;
  const got = earnedMarks();
  const sq = box.querySelector(".sq");
  if (sq.dataset.path !== P.path.id) {
    sq.dataset.path = P.path.id;
    sq.style.gridTemplateColumns = `repeat(${Math.min(10, t.items.length)}, 9px)`;
    sq.innerHTML = t.items.map((s) => `<b title="${s.name}"></b>`).join("");
    box.querySelector(".lab").textContent = t.label;
  }
  [...sq.children].forEach((b, i) => {
    b.classList.toggle("on", got.has(t.items[i].id));
  });
  box.querySelector(".cnt").textContent = `${String(got.size).padStart(2, "0")}/${t.items.length}`;
}
function stamp(id) {
  const t = tallyOf(P.path);
  const i = markIndex(id);
  const s = t.items[i];
  const el = $("#stamp");
  el.querySelector(".k").textContent =
    `${t.unit} ${String(i + 1).padStart(2, "0")} OF ${t.items.length} ${t.verb || "EARNED"}`;
  el.querySelector(".n").textContent = s.name;
  el.querySelector(".w").textContent = s.where || "";
  el.classList.add("show");
  clearTimeout(P.stampTimer);
  P.stampTimer = setTimeout(() => el.classList.remove("show"), 3600);
}

function go(si, bi, announce = false) {
  si = Math.max(0, Math.min(P.seq.length - 1, si));
  const changed = si !== P.si || !$("#cv").children.length || P.mounted !== P.seq[si];
  P.si = si;
  P.bi = Math.max(0, Math.min(P.seq[si].beats.length - 1, bi));
  P.elapsed = 0;
  if (changed) {
    P.mounted = P.seq[si];
    mountScene();
    // let the browser paint the hidden state first so the reveal transitions run
    requestAnimationFrame(() => requestAnimationFrame(() => applyBeat(announce)));
  } else applyBeat(announce);
  drawProgress();
}
function next() {
  const sc = P.seq[P.si];
  if (sc.kind === "branch" && pathState(P.path.id).choices[sc.branch.id] == null) {
    // Nobody chose: take the default route.
    return choose(sc.branch, sc.branch.default ?? sc.branch.options.length - 1);
  }
  if (P.bi < sc.beats.length - 1) go(P.si, P.bi + 1, true);
  else if (P.si < P.seq.length - 1) go(P.si + 1, 0, true);
  else setPlaying(false);
}
function prev() {
  if (P.bi > 0) go(P.si, P.bi - 1);
  else if (P.si > 0) go(P.si - 1, P.seq[P.si - 1].beats.length - 1);
}
function setPlaying(v) {
  P.playing = v;
  $("#play").textContent = v ? "❚❚ PAUSE" : "▶ PLAY";
}
function setSpeed() {
  const steps = [0.75, 1, 1.25, 1.5, 2];
  P.speed = steps[(steps.indexOf(P.speed) + 1) % steps.length];
  $("#speed").textContent = `${P.speed}×`;
}

function drawProgress() {
  if (!P.path) return;
  const segs = $("#tl").querySelectorAll(".seg");
  const sc = P.seq[P.si];
  const frac = Math.min(1, P.elapsed / beatDur(sc.beats[P.bi]));
  segs.forEach((s, i) => {
    const f = s.firstChild;
    s.classList.toggle("cur", i === P.si);
    f.style.width = i < P.si ? "100%" : i > P.si ? "0%" : `${((P.bi + frac) / sc.beats.length) * 100}%`;
  });
  $("#cap .bar").style.width = `${frac * 100}%`;
  let total = 0,
    done = 0;
  P.seq.forEach((s, i) => {
    if (s.kind) return;
    const d = s.beats.reduce((a, b) => a + beatDur(b), 0);
    total += d;
    if (i < P.si) done += d;
    if (i === P.si) done += s.beats.slice(0, P.bi).reduce((a, b) => a + beatDur(b), 0) + P.elapsed;
  });
  const mm = (ms) =>
    `${Math.floor(ms / 60000)}:${String(Math.floor((ms / 1000) % 60)).padStart(2, "0")}`;
  $("#time").textContent = `${mm(done / P.speed)} / ${mm(total / P.speed)}`;
  if (sc.kind === "branch") {
    const left = Math.max(0, Math.ceil((beatDur(sc.beats[0]) - P.elapsed) / 1000 / P.speed));
    const cd = $("#cv .countdown");
    const def = sc.branch.options[sc.branch.default ?? sc.branch.options.length - 1];
    if (cd)
      cd.textContent = P.playing
        ? `continuing with “${def.label}” in ${left}s — or click a route`
        : "paused — click a route to continue";
  }
}

function tick(now) {
  const dt = P.last ? now - P.last : 0;
  P.last = now;
  const blocked =
    !P.path || $("#toc").classList.contains("open") || $("#gloss").classList.contains("open");
  if (P.playing && !blocked) {
    P.elapsed += dt * P.speed;
    if (P.elapsed >= beatDur(P.seq[P.si].beats[P.bi])) next();
  }
  for (const k of P.pks) {
    if (
      (k.g.dataset.b != null && !k.g.classList.contains("on")) ||
      k.g.classList.contains("gone") ||
      !k.len
    )
      continue;
    const dur = Number(k.g.dataset.dur);
    // Without motion a probe rests near the end of its run, where it is stopped.
    const t = STILL() ? 0.86 : (now / dur + Number(k.g.dataset.ph)) % 1;
    const p = k.path.getPointAtLength(t * k.len);
    k.g.setAttribute("transform", `translate(${p.x},${p.y})`);
    const fade = t < 0.08 ? t / 0.08 : t > 0.92 ? (1 - t) / 0.08 : 1;
    k.g.style.opacity = String(fade);
  }
  drawProgress();
  requestAnimationFrame(tick);
}

/* ---------------------------------------------------------------- home: path cards + picker */
const PICKER = [
  {
    q: "What brings you here?",
    options: [
      { label: "I'll use agents someone else set up", go: "user" },
      { label: "I'll set up or run a fleet", go: "deploy" },
      { label: "I'll work on hermetic's code", go: "contrib" },
      { label: "I'm evaluating it", next: 1 },
    ],
  },
  {
    q: "What do you need to judge?",
    options: [
      { label: "What it is and roughly how it works", next: 2 },
      { label: "Whether it's safe: trust boundaries and threats", go: "security" },
    ],
  },
  {
    q: "Have you used Hermes on its own before?",
    options: [
      { label: "Yes", go: "overview", choices: { stock: 0 } },
      { label: "No, or not sure", go: "overview", choices: { stock: 1 } },
    ],
  },
];

function levelDots(n) {
  return [1, 2, 3, 4].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("");
}
function renderHome() {
  const cards = PATHS.map((p) => {
    const ps = STORE.paths[p.id];
    const pct = ps ? Math.round((ps.furthest || 0) * 100) : 0;
    const status = ps?.done ? "completed" : pct > 0 ? `${pct}% · resume` : "not started";
    return `
      <button type="button" class="pcard" data-p="${p.id}" style="--c:${p.color}">
        <div class="top"><span class="aud">${p.audience}</span><span class="lvl" title="technical depth">${levelDots(p.level)}</span></div>
        <div class="pt">${p.title}</div>
        <div class="pg">${p.tagline}</div>
        <ul>${(p.learn || []).map((l) => `<li>${l}</li>`).join("")}</ul>
        <div class="foot"><span>≈ ${p.minutes} min · ${sequence(p).filter((s) => !s.kind).length} scenes</span><span class="stt">${status}</span></div>
        <div class="pbar"><div style="width:${ps?.done ? 100 : pct}%"></div></div>
      </button>`;
  }).join("");
  $("#home .cards").innerHTML = cards;
  $("#home .cards")
    .querySelectorAll(".pcard")
    .forEach((c) => {
      c.addEventListener("click", () => {
        const ps = STORE.paths[c.dataset.p];
        if (ps && !ps.done && ps.si > 0) openPath(c.dataset.p, ps.si, ps.bi);
        else openPath(c.dataset.p, 0, 0);
      });
    });
  renderPicker(0, {});
}
function renderPicker(qi, choices) {
  const q = PICKER[qi];
  const el = $("#home .picker");
  el.innerHTML = `<div class="pq">${q.q}</div><div class="po">${q.options
    .map((o, i) => `<button type="button" data-o="${i}">${o.label}</button>`)
    .join("")}</div>${qi ? `<button type="button" class="restart">↺ start over</button>` : ""}`;
  el.querySelectorAll("[data-o]").forEach((b) => {
    b.addEventListener("click", () => {
      const o = q.options[Number(b.dataset.o)];
      if (o.next != null) return renderPicker(o.next, choices);
      const p = pathById(o.go);
      if (o.choices) Object.assign(pathState(p.id).choices, o.choices);
      saveStore();
      el.innerHTML = `<div class="pq">We'd start with <b style="color:${p.color}">${p.title}</b>.</div>
        <div class="po"><button type="button" class="go">▶ Start ${p.title}</button><button type="button" class="restart">↺ start over</button></div>`;
      el.querySelector(".go").addEventListener("click", () => openPath(p.id, 0, 0));
      el.querySelector(".restart").addEventListener("click", () => renderPicker(0, {}));
      $("#home .cards")
        .querySelectorAll(".pcard")
        .forEach((c) => {
          c.classList.toggle("rec", c.dataset.p === p.id);
        });
    });
  });
  el.querySelector(".restart")?.addEventListener("click", () => renderPicker(0, {}));
}
function showHome() {
  P.path = null;
  setPlaying(false);
  document.body.classList.add("at-home");
  renderHome();
  if (location.hash !== "#home") history.replaceState(null, "", "#home");
}
function openPath(id, si = null, bi = 0) {
  const path = pathById(id);
  if (!path) return showHome();
  document.body.classList.remove("at-home");
  P.path = path;
  P.seq = sequence(path);
  P.mounted = null;
  const ps = pathState(id);
  if (si == null) si = ps.done ? 0 : ps.si || 0;
  if (si === 0 && bi === 0 && ps.done) ps.done = false;
  P.si = 0;
  buildTimeline();
  buildToc();
  fit();
  go(si, bi);
  setPlaying(true);
}

function route() {
  const m = location.hash.match(/^#([\w-]+)(?:\/([\w-]+))?(?:\/(\d+))?/);
  if (!m || m[1] === "home" || !pathById(m[1])) return showHome();
  const path = pathById(m[1]);
  if (P.path !== path) {
    P.path = path;
    P.seq = sequence(path);
  }
  const si = m[2] ? P.seq.findIndex((s) => s.id === m[2]) : -1;
  openPath(m[1], si >= 0 ? si : null, m[3] ? Number(m[3]) - 1 : 0);
}

/* ---------------------------------------------------------------- boot */
function buildGlossary() {
  $("#gloss .cols").innerHTML = Object.keys(GLOSSARY)
    .sort((a, b) => a.localeCompare(b))
    .map(
      (t) =>
        `<div class="g"><b>${t}</b><span>${typeof GLOSSARY[t] === "string" ? GLOSSARY[t] : GLOSSARY[t].d}</span></div>`,
    )
    .join("");
}
function boot() {
  if (location.search.includes("still")) document.body.classList.add("still");
  buildGlossary();
  fit();
  window.addEventListener("resize", fit);
  $("#play").addEventListener("click", () => setPlaying(!P.playing));
  $("#prev").addEventListener("click", prev);
  $("#next").addEventListener("click", () => next());
  $("#prevs").addEventListener("click", () => go(P.bi > 0 ? P.si : P.si - 1, 0));
  $("#nexts").addEventListener("click", () => go(P.si + 1, 0, true));
  $("#speed").addEventListener("click", setSpeed);
  $("#tocbtn").addEventListener("click", () => toggleToc());
  $("#homebtn").addEventListener("click", showHome);
  $("#glossbtn").addEventListener("click", () => toggleGloss());
  $("#hdr .brand").addEventListener("click", showHome);
  window.addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea")) return;
    if (e.key === "g" || e.key === "G") return toggleGloss();
    if (e.key === "Escape") {
      toggleToc(false);
      toggleGloss(false);
      return;
    }
    if (!P.path) return;
    if (e.key === " ") {
      e.preventDefault();
      setPlaying(!P.playing);
    } else if (e.key === "ArrowRight" && e.shiftKey) go(P.si + 1, 0, true);
    else if (e.key === "ArrowLeft" && e.shiftKey) go(P.si - 1, 0);
    else if (e.key === "ArrowRight") next();
    else if (e.key === "ArrowLeft") prev();
    else if (e.key === "Home") go(0, 0);
    else if (e.key === "End") go(P.seq.length - 1, 0);
    else if (e.key === "t" || e.key === "T") toggleToc();
    else if (e.key === "h" || e.key === "H") showHome();
    else if (e.key === "s" || e.key === "S") setSpeed();
  });
  window.addEventListener("hashchange", () => {
    const want = location.hash;
    const cur = P.path ? `#${P.path.id}/${P.seq[P.si].id}/${P.bi + 1}` : "#home";
    if (want !== cur) route();
  });
  route();
  requestAnimationFrame(tick);
}
window.addEventListener("DOMContentLoaded", boot);

// Read by the check and sweep tooling.
Object.assign(globalThis, {
  LIB,
  PATHS,
  GLOSSARY,
  sequence,
  beatDur,
  pathState,
  P,
  go,
  setPlaying,
  openPath,
  choose,
});
