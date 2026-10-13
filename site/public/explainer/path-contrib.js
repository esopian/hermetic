/* The Contributor path — "Inside the code".
 *
 * For developers who will change hermetic: the package map and its import matrix, core's rules,
 * the six-step recipe for adding a core method (walked through on the real `fleets.alias`), the
 * modes, each head and the box, the render → apply seam, the test gates and the dev loop.
 *
 * Wrapped in a function so this file's helpers never collide with another path file's globals.
 */
(() => {
  /* A panel that steps aside completely (not just dims) once its beat has passed, so several
   * panels can share one spot and only the current one shows. */
  css(`
    #cv .dvx.gone { opacity: 0 !important; }
    #cv .dvg { padding: 0 2px; }
    #cv .dvg.hl { outline: 1.5px solid var(--acc); outline-offset: 1px; box-shadow: none;
      background: rgba(255, 90, 31, 0.16); color: #fff; }
    #cv table.dvt { font-size: 14px; }
    #cv table.dvt td { padding: 9px 12px; }
    #cv table.dvt td code { font-size: 12.5px; color: var(--fg); }
    #cv table.dvt2 { font-size: 16px; }
    #cv table.dvt2 td { padding: 12px 12px; line-height: 1.4; }
    #cv table.dvt2 td code { color: var(--fg); }
    #cv .dvs .s { font-size: 12.5px; line-height: 1.5; }
    #cv .dvb .s { font-size: 14px; line-height: 1.6; }
    #cv .list.dvl { gap: 12px; }
    #cv .list.dvl .li { font-size: 17px; line-height: 1.4; }
  `);

  glossary({
    Commander:
      "The Node CLI framework the hermetic CLI is built on. It parses flags as strings, so each command validates them with core's Zod schema.",
    Hutch:
      "The pinned tool (.hutch-version) that builds and launches the Electrobun app, in dev runs and releases.",
    "happy-dom":
      "A DOM written in JavaScript. The UI flow tests render the real app page in it, so no browser is needed.",
    machinery:
      "An app request that wraps no core method: meta, the op registry, streams, the wizard's pre-init helpers. Listed in MACHINERY_RPC.",
    "seam test":
      "A root tests/ file that writes a document the way the laptop does and parses it the way the box does, asserting both ends.",
    Biome:
      "The repo's formatter and linter (biome.jsonc). `bun run lint:biome` fails on any diagnostic.",
    graft: {
      d: "An optional context graph of the repo (graft ask, graft callers, graft skeleton) that coding agents query instead of grepping.",
      link: false,
    },
    rtk: {
      d: "An optional shell-output proxy for coding agents that condenses command output without changing exit codes.",
      link: false,
    },
  });

  /* ------------------------------------------------------------------ worked example: fleets.alias */
  const STEPS = [
    ["schema", "core/src/schema/requests.ts"],
    ["SDK method", "core/src/fleet/fleets.ts · hermetic.ts"],
    ["surface", "core/src/surface.ts"],
    ["CLI command", "cli/src/commands/fleets.ts"],
    ["RPC handler", "app/src/handlers/fleet.ts · dispatch.ts"],
    ["parity test", "tests/parity.test.ts · design.md §9"],
  ];
  const railY = (i) => 86 + i * 93;
  const rail = STEPS.map(
    ([t, s], i) =>
      bx(20, railY(i), 360, 80, t, s, { b: 0, h: i + 1, c: "sm", k: `step ${i + 1}`, a: "lf" }) +
      tag(342, railY(i) + 10, "✓", { b: i + 1, c: "ok" }),
  ).join("");

  const panel = (n, head, body) =>
    code(420, 86, 1160, 316, head, body, { b: n, x: n === 6 ? undefined : n + 1, c: "dvx" });

  scene({
    id: "dev-method",
    title: "Worked example: adding a core method",
    html: `
      ${kick(20, 40, "the recipe · AGENTS.md › parity contract", { b: 0 })}
      ${bx(420, 20, 300, 52, "fleets.alias", "", { b: 0, c: "c fillacc", st: "flex-direction:row" })}
      ${txt(740, 22, 840, "<span class='mono' style='color:var(--fg)'>hermetic fleet alias &lt;fleet-id&gt; &lt;alias&gt; | --clear</span><br>relabel a fleet, by its id only · design.md §4.6, §4.8", { b: 0, st: "font-size:15px" })}
      ${rail}
      ${code(
        420,
        86,
        1160,
        316,
        "agents.md › parity contract › add a new core method",
        `<span class="a">1.</span> Add or extend a Zod schema in <span class="f">packages/core/src/schema/</span>.
<span class="a">2.</span> Add the method to the SDK surface in <span class="f">hermetic.ts</span>, validating input with that schema.
<span class="a">3.</span> Add the dotted path to <span class="f">PUBLIC_METHODS</span> (and <span class="f">STREAMING_METHODS</span> if it is a long operation).
<span class="a">4.</span> Add a CLI command calling <span class="f">declare</span>(path, <span class="s">"command name"</span>, schema); validate with what it returns.
<span class="a">5.</span> Add an RPC handler calling <span class="f">declareRpc</span>(path, schema) and <span class="f">parseInput</span>; wire it into <span class="f">HANDLERS</span>.
<span class="a">6.</span> <span class="f">bun test tests/parity.test.ts</span> — fails on a missing command, a missing handler,
   a schema mismatch, or <span class="f">SURFACE</span> disagreeing.

<span class="c">// "Worked example: grep fleets.alias — it appears in every one of those places,</span>
<span class="c">//  plus §9 of docs/design.md."</span>`,
        { b: 0, x: 1, c: "dvx" },
      )}
      ${panel(
        1,
        "1 · schema — packages/core/src/schema/requests.ts:997",
        `<span class="kw">export const</span> <span class="f">FleetsAliasInput</span> = z
  .object({ fleet: z.string().min(1), alias: FleetName.optional(), clear: z.boolean().optional() })
  .refine((v) =&gt; (v.clear === <span class="kw">true</span>) !== (v.alias !== <span class="kw">undefined</span>), {
    message: <span class="s">"provide an alias or --clear"</span>,
  });
<span class="kw">export type</span> FleetsAliasInput = z.infer&lt;<span class="kw">typeof</span> FleetsAliasInput&gt;;

<span class="c">// One schema, one type. Core parses with it, the CLI validates its flags with it,</span>
<span class="c">// the RPC handler validates its params with it — and the parity test compares the</span>
<span class="c">// three by object identity, so nobody can accept a wider shape than core does.</span>`,
      )}
      ${panel(
        2,
        "2 · the sdk — packages/core/src/fleet/fleets.ts · hermetic.ts:487",
        `<span class="c">// a module with an explicit deps object — never another function in hermetic.ts</span>
<span class="kw">export function</span> <span class="f">createFleets</span>(deps: FleetsDeps) {
  …
  <span class="kw">async function</span> <span class="f">alias</span>(input) {
    <span class="kw">const</span> parsed = <span class="f">parse</span>(FleetsAliasInput, input, <span class="s">"fleet alias"</span>);   <span class="c">// core validates too</span>
    …                                      <span class="c">// NOT_FOUND unless this home froze that fleet id</span>
    <span class="kw">if</span> (!(<span class="kw">await</span> backend.directory.<span class="f">update</span>(next, { alias: entry.name }))) …   <span class="c">// conditional write</span>
  }
}
<span class="c">// packages/core/src/hermetic.ts — assembly only</span>
fleets: { list: fleets.list, use: fleets.use, alias: fleets.alias },`,
      )}
      ${panel(
        3,
        "3 · the surface — packages/core/src/surface.ts",
        `<span class="kw">export const</span> <span class="f">PUBLIC_METHODS</span> = [
  …, <span class="s">"fleets.list"</span>, <span class="s">"fleets.use"</span>, <span class="s">"fleets.alias"</span>, …          <span class="c">// :146 — 90 methods in all</span>
] <span class="kw">as const</span>;
<span class="kw">export const</span> <span class="f">STREAMING_METHODS</span> = [<span class="s">"init"</span>, …, <span class="s">"agents.create"</span>, …];    <span class="c">// long operations only</span>
<span class="kw">export const</span> <span class="f">REQUEST_SCHEMAS</span> = {
  …, <span class="s">"fleets.alias"</span>: FleetsAliasInputSchema, …                      <span class="c">// :275</span>
};
<span class="kw">export const</span> <span class="f">CLI_REQUEST_SCHEMAS</span> = { ...REQUEST_SCHEMAS, <span class="s">"artifacts.push"</span>: … };
<span class="c">// the CLI's table differs in exactly one place: artifacts push may name a local path</span>`,
      )}
      ${panel(
        4,
        "4 · the cli — packages/cli/src/commands/fleets.ts",
        `<span class="kw">const</span> aliasSchema = <span class="f">declare</span>(<span class="s">"fleets.alias"</span>, <span class="s">"fleet alias"</span>, FleetsAliasInput);   <span class="c">// :45</span>

fleet.<span class="f">addCommand</span>(
  <span class="f">globals</span>(<span class="kw">new</span> Cmd(<span class="s">"alias"</span>))
    .argument(<span class="s">"&lt;fleet-id&gt;"</span>, …).argument(<span class="s">"[alias]"</span>, …).option(<span class="s">"--clear"</span>, …)
    .action(<span class="kw">async</span> (fleetId, alias, opts, cmd) =&gt; {
      <span class="kw">const</span> input = <span class="f">validate</span>(aliasSchema, { fleet: fleetId, … });   <span class="c">// Commander's strings → the schema</span>
      <span class="kw">const</span> result = <span class="kw">await</span> ctx.hermetic.fleets.<span class="f">alias</span>(input);
      <span class="kw">if</span> (ctx.flags.json) <span class="kw">await</span> <span class="f">outJson</span>(result); <span class="kw">else</span> <span class="kw">await</span> <span class="f">err</span>(…);
    }),
);`,
      )}
      ${panel(
        5,
        "5 · the rpc handler — packages/app/src/handlers/fleet.ts",
        `<span class="kw">export const</span> fleetsAliasSchema = <span class="f">declareRpc</span>(<span class="s">"fleets.alias"</span>, FleetsAliasInput);   <span class="c">// :56</span>

<span class="kw">export async function</span> <span class="f">fleetsAlias</span>(ctx: HandlerContext, params: unknown) {
  <span class="f">requireWritable</span>(ctx.state);
  <span class="kw">const</span> changed = <span class="kw">await</span> ctx.<span class="f">hermetic</span>().fleets.<span class="f">alias</span>(<span class="f">parseInput</span>(fleetsAliasSchema, params));
  ctx.state.<span class="f">invalidateFleets</span>();
  <span class="kw">return</span> changed;
}
<span class="kw">export const</span> fleetHandlers = { …, <span class="s">"fleets.alias"</span>: fleetsAlias, … };             <span class="c">// :303</span>
<span class="c">// handlers/dispatch.ts:  HANDLERS = { ...agentHandlers, …, ...fleetHandlers, … }</span>`,
      )}
      ${panel(
        6,
        "6 · the gate — tests/parity.test.ts",
        `<span class="kw">const</span> <span class="f">SURFACE</span>: Record&lt;PublicMethod, string&gt; = {
  …, <span class="s">"fleets.alias"</span>: <span class="s">"fleet alias"</span>, …      <span class="c">// :126 — design.md §9's table, transcribed by hand</span>
};

<span class="a">$ bun test tests/parity.test.ts</span>                            <span class="c"># abridged</span>
<span class="s">✓</span> every public method declared a command and a handler
<span class="s">✓</span> every command validates with core's own schema
<span class="s">✓</span> every handler validates with core's own schema
<span class="s">✓</span> dispatch knows exactly the public methods plus the machinery

<span class="c"># and in docs/design.md §9, the command table gains the same row</span>`,
      )}
      ${term(
        420,
        416,
        1160,
        214,
        `<span class="p">$</span> git grep -nE "fleets.alias|FleetsAliasInput = z" -- packages/*/src tests      <span class="c"># abridged</span>
<span class="dvg" data-h="1">packages/core/src/schema/requests.ts:997:export const FleetsAliasInput = z</span>
<span class="dvg" data-h="2">packages/core/src/hermetic.ts:487:    fleets: { list: fleets.list, use: fleets.use, alias: fleets.alias },</span>
<span class="dvg" data-h="3">packages/core/src/surface.ts:146:  "fleets.alias",</span>
<span class="dvg" data-h="3">packages/core/src/surface.ts:275:  "fleets.alias": FleetsAliasInputSchema,</span>
<span class="dvg" data-h="4">packages/cli/src/commands/fleets.ts:45:const aliasSchema = declare("fleets.alias", "fleet alias", FleetsAliasInput);</span>
<span class="dvg" data-h="5">packages/app/src/handlers/fleet.ts:56:export const fleetsAliasSchema = declareRpc("fleets.alias", FleetsAliasInput);</span>
<span class="dvg" data-h="5">packages/app/src/handlers/fleet.ts:303:  "fleets.alias": fleetsAlias,</span>
<span class="dvg" data-h="6">tests/parity.test.ts:126:  "fleets.alias": "fleet alias",</span>`,
        { b: 0, h: 0 },
      )}
    `,
    beats: [
      {
        c: "The recipe in AGENTS.md has six steps, and <code>fleets.alias</code> — relabel a fleet by its id — is the cleanest real example. Grep it and it turns up in exactly the places a new method must touch: schema, SDK, surface, CLI, handler, parity test.",
        r: ["AGENTS.md · Parity contract", "CONTRIBUTING.md · Adding a CLI command"],
      },
      {
        c: "Step one is the input shape: a Zod schema in <code>packages/core/src/schema/</code>. <code>z.infer</code> makes it the one TypeScript type; the <code>refine</code> demands an alias or <code>--clear</code>, never both. Every layer validates against this same object.",
        r: ["packages/core/src/schema/requests.ts:997", "packages/core/src/schema/index.ts"],
      },
      {
        c: "Step two is the behaviour, in a module with an explicit deps object — <code>createFleets(deps)</code> here, <code>{ ctx: CoreContext }</code> for a long op. It re-validates its own input, and <code>hermetic.ts</code> only wires it into the SDK.",
        r: ["packages/core/src/fleet/fleets.ts", "packages/core/src/hermetic.ts:487"],
      },
      {
        c: "Step three declares it. The dotted name joins <code>PUBLIC_METHODS</code>, the whole surface of 90 methods, and its schema joins <code>REQUEST_SCHEMAS</code>. A long operation would also go in <code>STREAMING_METHODS</code>. This file is the contract, kept apart from the code.",
        r: ["packages/core/src/surface.ts:146", "packages/core/src/surface.ts:275"],
      },
      {
        c: "Step four, the CLI. <code>declare()</code> records the method, the command name and the schema — and returns that schema, so the action validates Commander's strings with the very object the parity test inspects. No second copy can drift.",
        r: ["packages/cli/src/commands/fleets.ts:45", "packages/cli/src/declare.ts"],
      },
      {
        c: "Step five, the app. <code>declareRpc()</code> records the same binding and <code>parseInput</code> validates with it. The handler goes in its module's table, which <code>HANDLERS</code> in <code>dispatch.ts</code> merges. The request is named by the method — no verb, no path.",
        r: [
          "packages/app/src/handlers/fleet.ts:56",
          "packages/app/src/declare.ts",
          "handlers/dispatch.ts",
        ],
      },
      {
        c: "Step six: add the row to <code>SURFACE</code> — §9's table, transcribed into the test — update §9 itself, and run <code>bun test tests/parity.test.ts</code>. Core's lists, what each head recorded, and the spec must all agree.",
        r: ["tests/parity.test.ts", "docs/design.md §9", "design.md §11.4"],
      },
    ],
  });

  /* ------------------------------------------------------------------ streaming methods + what parity refuses */
  scene({
    id: "dev-stream",
    title: "Long operations, and what parity refuses",
    html: `
      ${code(
        20,
        20,
        780,
        150,
        "packages/core/src/surface.ts:223 · packages/core/src/schema/ops.ts",
        `<span class="kw">export const</span> <span class="f">STREAMING_METHODS</span> = [<span class="s">"init"</span>, <span class="s">"teardown"</span>, <span class="s">"foundation.update"</span>, <span class="s">"apply"</span>,
  <span class="s">"upgrade"</span>, <span class="s">"agents.create"</span>, <span class="s">"agents.destroy"</span>, <span class="s">"agents.recreate"</span>, …];
<span class="c">// each returns AsyncIterable&lt;OpEvent&gt; and accepts an AbortSignal</span>
OpEvent = { phase, progress: <span class="a">0‥1</span>, message, level?, kind?: <span class="s">"start"</span> | <span class="s">"done"</span>, at }`,
        { b: 0 },
      )}
      ${code(
        20,
        190,
        380,
        210,
        "cli · commands/agent.ts:255",
        `<span class="kw">await</span> <span class="f">renderOp</span>(
  ctx.hermetic.agents.<span class="f">create</span>(input, {
    signal: ctx.signal,   <span class="c">// Ctrl-C</span>
  }),
  { flags: ctx.flags, label: … },
);
<span class="c">// TTY: a spinner · piped: one line</span>
<span class="c">// per event · --json: NDJSON on stdout</span>`,
        { b: 1 },
      )}
      ${code(
        420,
        190,
        380,
        210,
        "app · handlers/agents.ts:107",
        `<span class="kw">const</span> op = ctx.ops.<span class="f">start</span>(
  <span class="s">"agents.create"</span>, input.name,
  (signal) =&gt;
    h.agents.<span class="f">create</span>(input, { signal }),
  { input: recorded, resumable: <span class="kw">true</span> },
);
<span class="kw">return</span> <span class="f">accepted</span>(op);
<span class="c">// → { op_id }, before any event</span>`,
        { b: 2 },
      )}
      ${bx(
        20,
        430,
        780,
        200,
        "the page · ops.subscribe",
        "handlers/streams.ts — every frame is stamped &lt;generation&gt;:&lt;sequence&gt;; a page that resubscribes sends the last one back as its cursor.<br><br>Close the window mid-create: the op keeps running in the main process and the drawer reattaches to it. If the process dies, pending_ops and resume.ts restart it at the next launch.",
        { b: 3, c: "dvb" },
      )}

      ${kick(840, 24, "tests/parity.test.ts refuses", { b: 4 })}
      ${list(
        840,
        52,
        740,
        [
          ["bad", "a public method with <b>no CLI command</b> or <b>no RPC handler</b>"],
          [
            "bad",
            "an SDK method missing from <span class='m'>PUBLIC_METHODS</span> — nothing public hides outside it",
          ],
          [
            "bad",
            "a command or handler validating with <b>a schema that isn't core's own object</b> — compared by identity, not shape",
          ],
          [
            "bad",
            "a command name that disagrees with <span class='m'>SURFACE</span>, and so with design.md §9",
          ],
          [
            "bad",
            "a handler name that is neither a public method nor declared machinery (<span class='m'>MACHINERY_RPC</span>)",
          ],
          [
            "bad",
            "a second, different <span class='m'>declare()</span> for one method — it throws while the head builds",
          ],
        ],
        { b: 4, a: "up dvl" },
      )}
      ${term(
        840,
        360,
        740,
        250,
        `<span class="p">$</span> bun test tests/parity.test.ts                 <span class="c"># abridged</span>
<span class="c">parity: core ↔ CLI ↔ RPC</span>
  <span class="g">✓</span> every command validates with core's own schema
  <span class="g">✓</span> command names are unique
<span class="c">the parity check can fail</span>
  <span class="g">✓</span> a command validating with the wrong schema is caught
  <span class="g">✓</span> a renamed command is caught
  <span class="g">✓</span> two commands with their names swapped are caught
<span class="c">parity: core ↔ RPC handlers</span>
  <span class="g">✓</span> a handler declared against the wrong schema is caught`,
        { b: 5 },
      )}
    `,
    svg: `
      ${wire("M210 172 L210 188", { b: 1, c: "acc" })}
      ${wire("M610 172 L610 188", { b: 2, c: "acc" })}
      ${wire("M610 402 L610 428", { b: 3, c: "ok" })}
    `,
    beats: [
      {
        c: "A long operation differs in one way: it also joins <code>STREAMING_METHODS</code>, returns <code>AsyncIterable&lt;OpEvent&gt;</code> and accepts an <code>AbortSignal</code>. An event's <code>kind</code> marks a phase starting or done, so heads name the right step through a long silence.",
        r: ["packages/core/src/surface.ts:223", "packages/core/src/schema/ops.ts"],
      },
      {
        c: "The CLI consumes the stream itself. <code>renderOp</code> draws a spinner on a terminal, one line per event when piped, NDJSON under <code>--json</code> — everything but the JSON on stderr. Ctrl-C aborts through the signal.",
        r: ["packages/cli/src/stream.ts", "packages/cli/src/context.ts"],
      },
      {
        c: "The app never streams from the request. Its handler starts a background op in the op registry and answers <code>{ op_id }</code> at once. <code>resumable: true</code> records the input — minus any API key — so an interrupted create can be resumed.",
        r: ["packages/app/src/handlers/agents.ts:107", "packages/app/src/ops.ts"],
      },
      {
        c: "The page subscribes to the op's frames. Each carries <code>generation:sequence</code>, so closing the window and coming back reattaches to the same run; a process that died has the op restarted by <code>resume.ts</code> at next launch.",
        r: ["packages/app/src/handlers/streams.ts", "packages/app/src/resume.ts", "design.md §3.4"],
      },
      {
        c: "What the parity test refuses: a method with no command or no handler, a schema that isn't core's own object, a command name that disagrees with §9, and any handler name that is neither public nor declared machinery.",
        r: ["tests/parity.test.ts", "packages/app/src/rpc/registry.ts"],
      },
      {
        c: "And it proves it can fail. A block of mutation tests feeds it a wrong schema, a renamed command and two swapped names, and asserts each one is caught. A gate that cannot go red is not a gate.",
        r: ["tests/parity.test.ts · “the parity check can fail”"],
      },
    ],
  });

  /* ------------------------------------------------------------------ modes */
  scene({
    id: "dev-modes",
    title: "Three modes, one interface",
    html: `
      <table class="cmp dvt up" data-b="0" style="left:20px;top:20px;width:1560px">
        <tr><th style="width:150px">mode</th><th style="width:420px">how to get it</th><th>what it does</th><th style="width:470px">must never touch</th></tr>
        <tr data-b="0"><td>real</td><td>the default · <code>bun run dev</code> · installed Hermetic.app · plain <code>hermetic</code></td><td>the AWS account frozen by <code>init</code>; config and run log in <code>~/.hermetic/hermetic.db</code> (or <code>$HERMETIC_HOME</code>)</td><td>any account but the one in <code>config</code> — <code>ACCOUNT_MISMATCH</code> / <code>FLEET_MISMATCH</code> guard every call</td></tr>
        <tr data-b="1"><td>fixture</td><td><code>--fixture</code> (either side of the subcommand) · <code>HERMETIC_FIXTURE=1</code> · <code>bun run dev:fixture</code></td><td>in-memory <code>MemoryBackend</code>, a fake fleet, no AWS; its own run log in <code>hermetic-fixture.db</code></td><td>any real AWS client; the real <code>hermetic.db</code>; <code>git</code> for the Hermes mirror (canned <code>fixtureHermesMirror</code>)</td></tr>
        <tr data-b="2"><td>fixture-uninit</td><td><code>HERMETIC_UNINIT=1</code> + <code>HERMETIC_FIXTURE=1</code> · <code>bun run dev:wizard</code></td><td>forces the init wizard against the fixture backend</td><td>an already-initialized real home — <code>openState</code> probes first and refuses</td></tr>
      </table>

      ${bx(
        20,
        250,
        500,
        216,
        "fxtr0001 · main",
        "12 agents · current FOUNDATION_VERSION<br>5 provider profiles; anthropic ant00001 is default_profile<br>corvid — a staged pending binding<br>atlas — bedrock revision 1 → update_available<br>heron — failed at stage 02-data-volume",
        { b: 3, c: "ok dvb", k: "the default fleet" },
      )}
      ${bx(
        540,
        250,
        500,
        216,
        "sg7k2m4p · staging",
        "2 agents · one FOUNDATION_VERSION behind<br>→ update_available: true<br><br>--fleet staging · --fleet sg7k2m4p · HERMETIC_FLEET=…<br>--fleet takes an id or an alias; the id wins a collision",
        { b: 3, c: "blue dvb", k: "the second fleet" },
      )}
      ${bx(
        20,
        490,
        1020,
        140,
        "fixture mode never reaches out",
        "FIXTURE_PREFLIGHT (open.ts): no tailscale binary is spawned, api.tailscale.com is never called.<br>fixture.chat.inject / fixture.chat.hint stage a chat arrival; outside fixture mode no fixture namespace exists,<br>and a fixture:false control surface throws UNSUPPORTED before it reads any input.",
        { b: 4, c: "dvb" },
      )}
      ${term(
        1060,
        250,
        520,
        380,
        `<span data-b="0"><span class="p">$</span> bun run dev               <span class="c"># real: wizard or dashboard</span></span>
<span data-b="1"><span class="p">$</span> bun run cli -- agent ps --fixture
<span class="p">$</span> HERMETIC_FIXTURE=1 bun run cli -- doctor
<span class="p">$</span> bun run dev:fixture
<span class="p">$</span> bun run dev:fixture:hmr   <span class="c"># + hot reload</span></span>
<span data-b="2"><span class="p">$</span> bun run dev:wizard
<span class="p">$</span> HERMETIC_FIXTURE_SLOW_STACK_MS=120000 \\
    bun run dev:wizard      <span class="c"># 2-minute fake stack</span></span>
<span data-b="3"><span class="p">$</span> bun run cli -- agent ps \\
    --fixture --fleet staging</span>`,
        { b: 0 },
      )}
    `,
    beats: [
      {
        c: "Three modes, one interface. <b>Real</b> is the default: the AWS account frozen by <code>init</code>, with <code>ACCOUNT_MISMATCH</code> and <code>FLEET_MISMATCH</code> guarding every call. Heads never construct a backend — <code>openHermetic</code> picks one.",
        r: ["packages/core/src/open.ts", "AGENTS.md · Modes"],
      },
      {
        c: "<b>Fixture</b> swaps in the in-memory <code>MemoryBackend</code>: no AWS client of any kind, its own <code>hermetic-fixture.db</code>, and a canned Hermes mirror instead of <code>git</code>. Turn it on with <code>--fixture</code> or <code>HERMETIC_FIXTURE=1</code>.",
        r: ["packages/core/src/backend/fixture/", "packages/core/src/release/hermes-mirror.ts"],
      },
      {
        c: "<b>Fixture-uninitialized</b> forces the init wizard over the fixture backend: <code>bun run dev:wizard</code>. <code>openState</code> probes the home first and refuses to let the flag mask a real home that is already initialized.",
        r: ["packages/app/src/state.ts", "packages/core/src/open.ts · openForInit"],
      },
      {
        c: "The fixture seeds two fleets. <code>fxtr0001</code>, alias main, is the default: 12 agents, five provider profiles, live update cases and one failed boot. <code>sg7k2m4p</code>, alias staging, has two agents and sits a foundation version behind.",
        r: ["packages/core/src/backend/fixture/memory-fixture.ts"],
      },
      {
        c: "Fixture mode never spawns <code>tailscale</code> or calls its API — the preflight is canned. Chat arrivals that would need a real gateway are staged by fixture-only requests that real mode refuses with <code>UNSUPPORTED</code>.",
        r: ["packages/core/src/open.ts · FIXTURE_PREFLIGHT", "packages/app/src/handlers/fixture.ts"],
      },
    ],
  });

  /* ------------------------------------------------------------------ the UI */
  scene({
    id: "dev-ui",
    title: "The page: packages/ui",
    html: `
      ${zone(20, 30, 1000, 600, "packages/ui/src", { b: 0, c: "solid" })}
      ${bx(
        44,
        60,
        952,
        96,
        "components/",
        "rendering only — FleetBoard, AgentDrawer, CreateDrawer, InitWizard, TeardownDrawer, Loading …<br>plus agent/ · create/ · settings/ · notify/ — and chat/ for the chat surface",
        { b: 2, c: "sm dvb" },
      )}
      ${bx(
        44,
        172,
        620,
        136,
        "logic/",
        "pure, DOM-free rules, tested with plain bun test:<br>loading.ts · create-form.ts · destroy-plan.ts · selectors.ts<br>volume-logic.ts · settings-logic.ts · provider-logic.ts · …",
        { b: 2, c: "sm acc dvb", h: 3 },
      )}
      ${bx(684, 172, 312, 136, "state/ · nav/", "React state and navigation:<br>state.tsx · nav-state.tsx<br>fleet-switch.ts · shortcuts.ts", { b: 2, c: "sm dvb" })}
      ${zone(44, 334, 952, 276, "api/ — the typed door to the main process", { b: 1, c: "blue" })}
      ${[
        "client.ts|per-method calls",
        "fleet.ts|fleet-area calls",
        "chat.ts|chat-area calls",
        "streams.ts|open/close readers",
      ]
        .map((p, i) => {
          const [t, s] = p.split("|");
          return bx(64 + i * 230, 356, 214, 62, t, s, { b: 1, c: "xs" });
        })
        .join("")}
      ${bx(64, 436, 912, 70, "transport.ts — the seam", "three verbs: request · subscribe · openStream — nothing above it knows what carries a request", { b: 1, c: "sm" })}
      ${bx(64, 522, 912, 70, "transport-rpc.ts — its one implementation", 'over Electrobun RPC, typed by  import type { HermeticRPC } from "@hermetic/app"', { b: 1, c: "sm blue" })}

      ${bx(
        1060,
        30,
        520,
        124,
        "what the page may import",
        "✓ @hermetic/core/shared — values, browser-safe<br>✓ import type … from @hermetic/app — a devDependency<br>✕ @hermetic/core · ✕ @hermetic/core/schema",
        { b: 0, c: "sm vio dvb" },
      )}
      ${code(
        1060,
        172,
        520,
        200,
        "logic/loading.ts",
        `<span class="kw">export type</span> <span class="f">FleetPhase</span> =
  | <span class="s">"connecting"</span> | <span class="s">"scanning"</span>
  | <span class="s">"reconnecting"</span> | <span class="s">"failed"</span> | <span class="s">"ready"</span>;
<span class="c">// "ready" only once a scan has landed.</span>
<span class="c">// Until then an empty board means</span>
<span class="c">// "not read yet", never "no agents".</span>`,
        { b: 3 },
      )}
      ${bx(
        1060,
        390,
        520,
        112,
        "test/flows/*.flow.test.tsx",
        "the real dashboard in happy-dom → flows/bridge.ts → the real rpc/bind.ts and dispatch → a fixture instance per file",
        { b: 4, c: "sm ok dvb" },
      )}
      ${bx(1060, 522, 520, 70, "Electrobun RPC → main process", "no socket, no port, no HTTP", { b: 1, c: "sm blue" })}
    `,
    svg: `
      ${wire("M976 557 L1058 557", { b: 1, c: "blue" })}
      ${[171, 401, 631, 861].map((x) => wire(`M${x} 418 L${x} 434`, { b: 1, c: "blue" })).join("")}
      ${wire("M520 506 L520 520", { b: 1, c: "blue" })}
    `,
    beats: [
      {
        c: "The UI is <code>packages/ui</code>, React in the app's webview. It may import only <code>@hermetic/core/shared</code> for values and the app's <em>types</em> — so no byte of core or the main process ever reaches the page's bundle.",
        r: ["tests/boundaries.test.ts", "packages/core/test/shared-browser-safe.test.ts"],
      },
      {
        c: "Every call goes through <code>api/</code>. The per-area modules sit on <code>transport.ts</code>, a seam of three verbs — <code>request</code>, <code>subscribe</code>, <code>openStream</code> — and <code>transport-rpc.ts</code>, over Electrobun RPC, is its one implementation.",
        r: ["packages/ui/src/api/transport.ts", "packages/ui/src/api/transport-rpc.ts"],
      },
      {
        c: "Rules live in pure, DOM-free modules under <code>logic/</code>; rendering lives in <code>components/</code>. Put a decision in <code>logic/</code> and it is testable with plain <code>bun test</code>, no DOM at all.",
        r: ["packages/ui/src/logic/", "packages/ui/src/components/", "docs/architecture.md"],
      },
      {
        c: "One rule worth knowing: <code>logic/loading.ts</code>. An empty list is ambiguous, so no screen says 'nothing there' until a read has actually come back; the <code>Loading</code> components render each phase.",
        r: ["packages/ui/src/logic/loading.ts", "packages/ui/src/components/Loading.tsx"],
      },
      {
        c: "End-to-end tests need no browser. The flow tests mount the real page in happy-dom and wire it through <code>flows/bridge.ts</code> to the real <code>bind</code> and <code>dispatch</code>, over a fixture instance of their own.",
        r: ["packages/ui/test/flows/bridge.ts", "tests/rpc-refusal.test.ts", "design.md §11.6"],
      },
    ],
  });

  /* ------------------------------------------------------------------ agentd */
  const STAGES = [
    "00-preflight",
    "01-tailscale",
    "02-data-volume",
    "03-config",
    "04-apply",
    "05-service",
    "06-verify",
  ];
  scene({
    id: "dev-agentd",
    title: "hermeticd: the module map",
    html: `
      ${bx(20, 20, 190, 70, "main.ts", "entry point", { b: 0, c: "sm vio" })}
      ${bx(250, 20, 540, 70, "cli.ts", "hand-parsed subcommands: bootstrap · stage · apply · update · heartbeat · secrets · serve", { b: 0, c: "sm vio" })}
      ${bx(860, 20, 720, 70, "daemon.ts — hermeticd serve", "the systemd service: three loops", { b: 0, c: "sm vio" })}

      ${zone(20, 124, 800, 196, "first boot · bootstrap.ts + stages.ts", { b: 1, c: "acc" })}
      ${STAGES.map((s, i) => bx(36 + i * 112, 150, 104, 52, s, "", { b: 1, c: "xs c", st: "font-size:11px" })).join("")}
      ${txt(40, 220, 760, "fetch the fleet manifest → verify the pinned stage scripts → run them in order. Bash orchestrates; anything that can destroy data, touch AWS or hold a secret is a <span class='mono'>hermeticd stage …</span> subcommand.", { b: 1, st: "font-size:15px" })}

      ${zone(20, 346, 800, 150, "hermeticd apply · apply/index.ts — four primitives", { b: 2, c: "acc" })}
      ${[
        ["packages", "apt.ts · hermes.ts"],
        ["files", "write if sha256 differs"],
        ["units", "restart only what changed"],
        ["commands", "short idempotent steps"],
      ]
        .map(([t, s], i) => bx(40 + i * 195, 374, 180, 98, t, s, { b: 2, c: "sm dvb" }))
        .join("")}

      ${bx(860, 124, 350, 112, "heartbeat.ts", "every 30 s → its own row: health, metrics, degraded", { b: 3, c: "sm dvb" })}
      ${bx(1230, 124, 350, 112, "update/", "nightly self-update: install · state · swap — triggered by digest, not label", { b: 3, c: "sm dvb" })}
      ${bx(860, 252, 350, 104, "rpc.ts", "logs + health on the tailnet; every caller checked with tailscale whois", { b: 3, c: "sm dvb" })}
      ${bx(1230, 252, 350, 104, "request-gate.ts · install-lock.ts", "row-borne converge / update requests → their loop; one on-box lock", { b: 3, c: "sm dvb" })}
      ${bx(860, 374, 720, 122, "imports: @hermetic/core/schema + /shared only", "never core's AWS or command layers — fleet operations aren't in the binary. Built with bun build --compile for linux-arm64.", { b: 0, c: "sm vio ghost dvb" })}

      ${bx(20, 524, 760, 106, "host.ts · interface Host", "exec · readFile · writeFile · stat · mkdir · rename · statfs · now · sleep …<br>the only module allowed to touch the real box", { b: 4, c: "sm acc dvb" })}
      ${bx(820, 524, 744, 106, "test/fake-host.ts", "an in-memory box — dpkg, systemd, a filesystem — that records every command.<br>No root, no systemd, no apt, no network.", { b: 4, c: "sm ok iso dvb" })}
      ${tag(782, 566, "≡", { b: 4, c: "ok" })}
    `,
    svg: `
      ${wire("M210 55 L248 55", { b: 0, c: "vio" })}
      ${wire("M790 55 L858 55", { b: 0, c: "vio" })}
      ${lbl(824, 45, "serve", { b: 0, anchor: "middle" })}
      ${wire("M420 90 L420 122", { b: 1, c: "acc" })}
      ${wire("M420 496 L420 522", { b: 4, c: "acc" })}
    `,
    beats: [
      {
        c: "<code>hermeticd</code> is <code>packages/agentd</code>: one Bun-compiled linux-arm64 binary per box. <code>main.ts</code> hands off to <code>cli.ts</code>, which parses subcommands by hand, and <code>serve</code> starts <code>daemon.ts</code>. It may import only core's schema and shared doors.",
        r: [
          "packages/agentd/src/main.ts",
          "packages/agentd/src/cli.ts",
          "packages/agentd/src/daemon.ts",
        ],
      },
      {
        c: "First boot is <code>bootstrap.ts</code> and <code>stages.ts</code>: fetch the fleet manifest, verify the pinned stage scripts, run <code>00-preflight</code> through <code>06-verify</code>. A failure parks the box in <code>error</code> until <code>agent rerun</code> resumes from that stage.",
        r: ["packages/agentd/src/stages.ts", "packages/agentd/stages/", "design.md §6.3"],
      },
      {
        c: "<code>apply/</code> is <code>hermeticd apply</code>: four idempotent primitives — packages, files written only when the hash differs, units restarted only when their own file changed, and a short list of commands. There is no templating on the box.",
        r: ["packages/agentd/src/apply/index.ts", "design.md §6.4"],
      },
      {
        c: "<code>serve</code> runs three loops: <code>heartbeat.ts</code> every 30 s, the nightly self-update in <code>update/</code>, and <code>rpc.ts</code> for logs and health over the tailnet. Requests arriving on the row go through <code>request-gate.ts</code>.",
        r: [
          "packages/agentd/src/heartbeat.ts",
          "packages/agentd/src/update/",
          "packages/agentd/src/rpc.ts",
        ],
      },
      {
        c: "Every shell and filesystem touch goes through <code>Host</code>. Tests inject <code>fake-host.ts</code>, an in-memory box that records every command, so apply is tested with no root, systemd, apt or network. The bash stages are only shellchecked.",
        r: ["packages/agentd/src/host.ts", "packages/agentd/test/fake-host.ts", "design.md §11.5"],
      },
    ],
  });

  /* ------------------------------------------------------------------ render → apply, and the seams */
  scene({
    id: "dev-render",
    title: "Render on the laptop, apply on the box",
    html: `
      ${zone(20, 30, 640, 400, "laptop · packages/core", { b: 0, c: "acc solid" })}
      ${bx(44, 60, 592, 64, "render/render.ts", "AgentConfig → final files. No templates, no variables.", { b: 0, c: "sm acc dvb" })}
      ${["render-hermes", "render-system", "render-units", "render-browser"]
        .map((t, i) =>
          bx(44 + i * 150, 140, 142, 50, `${t}.ts`, "", { b: 0, c: "xs c", st: "font-size:11px" }),
        )
        .join("")}
      ${code(
        44,
        210,
        592,
        200,
        "schema/hermes.ts · splitHermesSettings",
        `<span class="f">splitHermesSettings</span>(settings, defaultModel, seedDefaults)
  → { managed, seed }

managed → <span class="a">/etc/hermes/config.yaml</span>       every apply
seed    → <span class="a">/etc/hermes/config.seed.yaml</span>  a starting point

<span class="c">// stated by the operator → managed</span>
<span class="c">// SEED_ONLY = { approvals_mode }</span>`,
        { b: 1 },
      )}

      ${bx(700, 150, 240, 150, "agent manifest", "config/&lt;name&gt;/&lt;hash&gt;.tgz in the fleet bucket<br><br>config_hash on the agent's row", { b: 2, c: "sm c dvb" })}

      ${zone(980, 30, 600, 400, "box · hermeticd", { b: 2, c: "ok solid" })}
      ${bx(1004, 60, 552, 110, "stage 03-config", "hermeticd stage fetch-config → parseManifest validates the bundle; a future schema_version is refused (exit 3)", { b: 2, c: "sm dvb" })}
      ${bx(1004, 190, 552, 60, "stage 04-apply → hermeticd apply", "", { b: 3, c: "sm ok" })}
      ${["packages", "files", "units", "commands"]
        .map((t, i) => bx(1004 + i * 140, 264, 132, 60, t, "", { b: 3, c: "xs c" }))
        .join("")}
      ${txt(1004, 340, 552, "Make the disk match the manifest. A second apply of the same manifest changes nothing and restarts nothing.", { b: 3, st: "font-size:15px" })}

      ${zone(20, 460, 1560, 170, "root tests/ — every document the laptop writes and the box reads, asserted from both ends", { b: 4, c: "vio solid" })}
      ${[
        ["user-data", "cloud-init JSON → parseUserData", "tests/user-data.test.ts"],
        ["fleet manifest", "manifest.json → parseFleetManifest", "tests/seams.test.ts"],
        ["agent config", "a config bundle → parseManifest", "tests/seams.test.ts"],
        ["stage env", "stageEnv → stages/*.sh", "tests/seams.test.ts"],
      ]
        .map(([t, s, f], i) =>
          bx(44 + i * 384, 490, 364, 116, t, `${s}<br><br>${f}`, { b: 4, c: "sm vio dvb" }),
        )
        .join("")}
    `,
    svg: `
      ${wire("M660 225 L698 225", { b: 2, c: "acc" })}
      ${wire("M940 225 L978 225", { b: 2, c: "ok" })}
      ${wire("M1280 170 L1280 188", { b: 3, c: "ok" })}
      ${wire("M1280 250 L1280 262", { b: 3, c: "ok" })}
    `,
    beats: [
      {
        c: "Core renders <em>final</em> files on the laptop: <code>render/render.ts</code> fans out to the hermes, system, units and browser renderers, and the box never sees a template. Render snapshots in <code>render.test.ts</code> turn every change into a visible diff.",
        r: ["packages/core/src/render/render.ts", "packages/core/test/render.test.ts"],
      },
      {
        c: "Hermes settings are split by <code>splitHermesSettings</code>: what the operator stated is <em>managed</em>, rewritten on every apply; the rest is a <em>seed</em>, a starting point the agent may change. <code>approvals_mode</code> is always a seed.",
        r: ["packages/core/src/schema/hermes.ts", "packages/core/src/shared/hermes.ts"],
      },
      {
        c: "The files travel as an agent manifest, tarred to <code>config/&lt;name&gt;/&lt;hash&gt;.tgz</code> in the fleet bucket with the hash on the row. Stage 03 fetches it and <code>parseManifest</code> validates it; a future <code>schema_version</code> is refused.",
        r: ["packages/agentd/src/manifest.ts", "docs/architecture.md · The create sequence"],
      },
      {
        c: "Stage 04 runs <code>hermeticd apply</code> over its four primitives. Because the laptop rendered everything, the box's only job is making disk match the manifest — and applying the same manifest twice changes nothing.",
        r: ["packages/agentd/src/apply/index.ts", "design.md §11.5"],
      },
      {
        c: "Each document that crosses this gap has a seam test in root <code>tests/</code> that writes it the way core does and reads it the way hermeticd does. Both unit suites once stayed green while boxes lost a field; 'change the two together' is not a substitute.",
        r: ["tests/seams.test.ts", "tests/user-data.test.ts", "AGENTS.md · Testing"],
      },
    ],
  });

  /* ------------------------------------------------------------------ the dev loop */
  scene({
    id: "dev-loop",
    title: "The dev loop",
    html: `
      ${term(
        20,
        20,
        760,
        310,
        `<span data-b="0"><span class="c"># once per checkout / machine</span>
<span class="p">$</span> bun install
<span class="p">$</span> bun run setup             <span class="c"># toolchain check, hooks, .context/hermetic-home</span>
<span class="p">$</span> bun run app:prepare       <span class="c"># Electrobun devkit; typecheck needs it</span></span>
<span data-b="1">
<span class="c"># the app</span>
<span class="p">$</span> bun run dev:fixture:hmr   <span class="c"># fastest: fixture fleet, UI hot-reloads</span>
<span class="p">$</span> bun run dev:fixture       <span class="c"># bundled page, rebuilds on ui/core edits</span>
<span class="p">$</span> bun run dev:wizard        <span class="c"># forced init wizard, no AWS</span>
<span class="p">$</span> bun run dev               <span class="c"># real mode</span>

<span class="c"># the CLI, from source</span>
<span class="p">$</span> bun run cli -- agent ps --fixture</span>`,
        { b: 0 },
      )}
      ${bx(
        20,
        350,
        760,
        130,
        "scripts/dev-app.ts",
        "runs hutch run &lt;name&gt; in packages/app and ends the session when you quit the app — a lingering watcher holds the machine-wide Electrobun build lock, so only one dev runs per machine (scripts/dev-quit.ts).",
        { b: 2, c: "sm dvb" },
      )}
      ${bx(
        20,
        500,
        760,
        130,
        ":hmr twins · scripts/dev-hmr.ts",
        "Vite serves packages/ui on 127.0.0.1:5273 and the app loads it via HERMETIC_VIEW_URL — dev channel, loopback, must answer (main/view-url.ts). The release page is still Electrobun's bundle: run a plain dev:* once before calling a UI change done.",
        { b: 2, c: "sm dvb" },
      )}

      ${kick(820, 24, "when something fails", { b: 3 })}
      ${bx(820, 50, 760, 96, "~/.hermetic/app.log", "app-fixture.log in fixture mode · path printed at boot · every op start and outcome, every failed request — read the ERROR op:&lt;method&gt; line", { b: 3, c: "sm acc dvb" })}
      ${bx(820, 160, 370, 96, "bun run cli -- runs", "the same ops, persisted, shared with the app's Runs view", { b: 3, c: "sm dvb" })}
      ${bx(1210, 160, 370, 96, "Safari Web Inspector", "Develop → ‹your Mac› → Hermetic: DOM, styles, console, network", { b: 3, c: "sm dvb" })}
      ${bx(820, 270, 760, 106, "on the box", "agent history &lt;name&gt; — the failed stage's last 120 log lines<br>logs &lt;name&gt; --console — the serial console, when RPC never came up<br>logs &lt;name&gt; --file errors — Hermes's own error log", { b: 3, c: "sm dvb" })}

      ${bx(
        820,
        400,
        760,
        230,
        "optional · bun run agent-setup",
        "graft — a context graph of every symbol and caller; a coding agent asks it (graft ask, graft callers, graft skeleton) instead of grepping.<br><br>rtk — condenses shell output for agents; rtk proxy &lt;cmd&gt; when you need it raw.<br><br>Only git-ignored files in the checkout are written. Nothing in the build or the tests needs either.",
        { b: 4, c: "sm vio dvb" },
      )}
    `,
    beats: [
      {
        c: "Once per checkout: <code>bun install</code>, then <code>bun run setup</code>, which checks Bun against <code>.bun-version</code> and <code>uvx</code>, wires the pre-commit hook and points dev runs at <code>.context/hermetic-home</code>. Once per machine: <code>bun run app:prepare</code>.",
        r: ["CONTRIBUTING.md · Setup", "scripts/dev-setup.sh"],
      },
      {
        c: "The fastest inner loop is <code>bun run dev:fixture:hmr</code>: a fixture fleet, no AWS, and UI edits hot-reload in the open window. The CLI runs from source with <code>bun run cli -- …</code>, and takes <code>--fixture</code> too.",
        r: ["package.json · scripts", "scripts/dev-hmr.ts"],
      },
      {
        c: "Each <code>dev*</code> script is <code>hutch run</code>, wrapped by <code>scripts/dev-app.ts</code> so quitting the app ends the session. Vite serves only in development; the shipped page is still Electrobun's bundle.",
        r: ["scripts/dev-app.ts", "scripts/dev-quit.ts", "packages/app/src/main/view-url.ts"],
      },
      {
        c: "When something fails, read <code>~/.hermetic/app.log</code> for the <code>ERROR op:&lt;method&gt;</code> line — it carries core's error code. Then <code>runs</code>, or on the box <code>agent history</code>, which holds the failed stage's log tail.",
        r: ["AGENTS.md · Watching a running app", "packages/app/src/log.ts"],
      },
      {
        c: "Optional: <code>bun run agent-setup</code> installs graft, a context graph a coding agent can query instead of grepping, and rtk, which condenses shell output. Nothing in the build needs either.",
        r: ["CONTRIBUTING.md · Optional agent toolchain", "scripts/agent-setup.sh"],
      },
    ],
  });

  /* ------------------------------------------------------------------ the checklist */
  scene({
    id: "dev-checklist",
    title: "The contribution checklist",
    html: `
      ${term(
        20,
        20,
        760,
        124,
        `<span class="p">$</span> bun run check   <span class="c"># before a commit: typecheck · test · biome · lint · cfn-lint · shellcheck</span>
<span class="p">$</span> bun run ci      <span class="c"># before a push: check + build + audit:dependencies</span>

<span class="p">$</span> git commit -m <span class="g">"feat(cli): add agent recreate"</span>
<span class="c">#   conventional · imperative · subject ≤ 50 characters</span>`,
        { b: 0 },
      )}
      ${list(
        20,
        172,
        760,
        [
          [
            "acc",
            "<b>Core stays quiet:</b> no <span class='m'>console.*</span>, no <span class='m'>process.exit</span> — a typed result or a <span class='m'>HermeticError</span> with a code",
            1,
          ],
          [
            "acc",
            "<b>No <span class='m'>any</span></b> outside <span class='m'>packages/ui</span> — Biome's <span class='m'>noExplicitAny</span>",
            1,
          ],
          ["acc", "<b>No source file over 1500 lines</b> — split before you add to one near it", 1],
          [
            "acc",
            "<b>Owned markers:</b> <span class='m'>TODO(name):</span> <span class='m'>FIXME(name):</span> <span class='m'>PHASE2(name):</span> — never bare",
            1,
          ],
          [
            "acc",
            "<b>Edit-scope discipline:</b> stay in the files you were given; flag the rest, no drive-by edits",
            1,
          ],
        ],
        { a: "up lg" },
      )}
      ${bx(
        20,
        530,
        760,
        100,
        "release commands want a committed tree",
        "init, artifacts push and foundation update refuse with WORKING_TREE_DIRTY on uncommitted or untracked files — the build number is git rev-list --count HEAD.",
        { b: 3, c: "sm warn dvb" },
      )}

      <table class="cmp dvt2 up" data-b="2" style="left:820px;top:20px;width:760px">
        <tr><th style="width:250px">if your change touches</th><th>then</th></tr>
        <tr data-b="2"><td>foundation template / its state</td><td>bump <code>FOUNDATION_VERSION</code> and the sha table in <code>foundation-version.test.ts</code>; add a <code>FOUNDATION_MIGRATIONS</code> step if state must move</td></tr>
        <tr data-b="3"><td>packages/agentd</td><td><code>bun run cli -- artifacts push</code> before <code>agent create</code> / <code>rerun</code> — the version string doesn't move between commits</td></tr>
        <tr data-b="3"><td>hermes_ref / chrome_ref</td><td><code>artifacts push</code> mirrors it; a box picks it up on <code>create</code> or <code>recreate</code></td></tr>
        <tr data-b="4"><td>a rendered file</td><td><code>-u</code> for render snapshots only, after reading the diff — never to paper over a behaviour change</td></tr>
        <tr data-b="4"><td>test fixtures</td><td><code>FIXTURE</code> sentinel values only; the secrets-leak test greps all captured output</td></tr>
        <tr data-b="4"><td>behaviour in the spec</td><td>update the section of <code>docs/design.md</code> in the same PR</td></tr>
      </table>
    `,
    beats: [
      {
        c: "Before a commit, <code>bun run check</code>: typecheck, tests, Biome, lint, cfn-lint and shellcheck. Before a push, <code>bun run ci</code> adds the build and the dependency audit. Commits are conventional and imperative, with a subject of 50 characters or fewer.",
        r: ["CONTRIBUTING.md · Dev loop", "CONTRIBUTING.md · Commit messages"],
      },
      {
        c: "The mechanical rules: no <code>console</code> or <code>process.exit</code> in core, no <code>any</code> outside the UI, no file over 1500 lines, and every deferred-work marker names an owner. Stay inside the files you were given and flag the rest.",
        r: ["scripts/lint.ts", "biome.jsonc", "AGENTS.md · Conventions"],
      },
      {
        c: "Changing the foundation template or its state shape? Bump <code>FOUNDATION_VERSION</code> and the sha table in its test, plus a <code>FOUNDATION_MIGRATIONS</code> step if state must move. Real fleets catch up with <code>hermetic foundation update</code>.",
        r: ["packages/core/src/version.ts", "packages/core/test/foundation-version.test.ts"],
      },
      {
        c: "Changed <code>packages/agentd</code>? Run <code>bun run cli -- artifacts push</code> before <code>agent create</code> or <code>rerun</code>, or the fleet keeps the last-pushed binary; the same goes for a bumped <code>hermes_ref</code> or <code>chrome_ref</code>. Releases also refuse a dirty tree.",
        r: ["packages/core/src/release/artifacts.ts", "packages/core/src/build-versions.ts"],
      },
      {
        c: "<code>-u</code> is for render snapshots only, after reading the diff. Fixtures use <code>FIXTURE</code> sentinels; the secrets-leak test fails on any fixture secret or <code>tskey-</code> in output. A behaviour change updates <code>docs/design.md</code> in the same PR.",
        r: ["packages/core/test/secrets-leak.test.ts", "CONTRIBUTING.md · Where design decisions live"],
      },
    ],
  });

  /* ------------------------------------------------------------------ the path */
  pathway({
    id: "contrib",
    title: "Inside the code",
    audience: "Contributors",
    level: 4,
    minutes: 13,
    color: "var(--vio)",
    tagline: "The layout, the rules, and how to add a core method end to end.",
    learn: [
      "How the five packages fit, and the import matrix that keeps them apart",
      "Adding a core method: schema → surface → CLI → RPC handler → parity test",
      "Fixture mode, the test gates, the dev loop and the review checklist",
    ],
    next: ["security", "deploy"],
    outro:
      "You've seen the map, the six-step recipe for a core method, and the gates every change passes. Pick something small, run bun run dev:fixture:hmr, and let bun run check tell you when you're done.",
    overrides: {
      packages: {
        title: "Five packages, one import matrix",
        beats: [
          {
            c: "Start with the map: five Bun workspaces under <code>packages/</code>, and the boundaries between them are the architecture. <code>core</code> holds every rule and every AWS call; everything else is thin.",
            r: ["AGENTS.md · Layout", "design.md §3.1"],
          },
          {
            c: "Both heads — <code>cli</code>, built on Commander, and <code>app</code>, Electrobun's main process — import core in-process and call the same <code>Hermetic</code> instance. No daemon, no socket, no server in between.",
            r: ["packages/cli/src/program.ts", "packages/app/src/main/index.ts"],
          },
          {
            c: "<code>ui</code> runs in the app's webview and may not import core. Its one door is <code>@hermetic/core/shared</code> — pure values, no Zod, no node — plus <code>import type</code> from the app for <code>HermeticRPC</code>.",
            r: [
              "packages/ui/src/api/transport-rpc.ts",
              "packages/core/test/shared-browser-safe.test.ts",
            ],
          },
          {
            c: "The CLI and the app may not import each other, so a feature can't quietly become CLI-only or app-only: both reach it through core, or neither does.",
            r: ["tests/boundaries.test.ts"],
          },
          {
            c: "<code>agentd</code>, the program on every box, may import only <code>core/schema</code> and <code>core/shared</code>. Core's <code>exports</code> map has exactly those three doors, and core itself depends on no other <code>@hermetic/*</code> package.",
            r: ["packages/core/package.json", "packages/agentd/src/"],
          },
          {
            c: "<code>tests/boundaries.test.ts</code> transpiles every <code>src</code> file and resolves each specifier — <code>import type</code> and escaping relative paths included — to one cell of its <code>ALLOWED</code> table. Change a rule? Edit AGENTS.md and the test together.",
            r: ["tests/boundaries.test.ts", "AGENTS.md · Import boundaries"],
          },
        ],
      },
      core: {
        title: "Inside core: rules and one Backend",
        beats: [
          {
            c: "Every head enters core through <code>open.ts</code>. <code>hermetic.ts</code> only assembles the SDK; a new long operation is its own module taking <code>{ ctx: CoreContext }</code> plus a few deps — never another function in <code>hermetic.ts</code>.",
            r: ["packages/core/src/open.ts", "packages/core/src/context.ts", "AGENTS.md · rule 5"],
          },
          {
            c: "Rule 1: core never talks to a human — no <code>console.*</code>, no <code>process.exit</code>, no prompts. It returns typed results or throws <code>HermeticError</code> with a code; the CLI maps codes to exit statuses, the app to typed RPC errors.",
            r: ["scripts/lint.ts", "packages/core/src/errors.ts"],
          },
          {
            c: "Rules 2 and 3: long operations stream <code>OpEvent</code>s and take an <code>AbortSignal</code>; destructive work is a plan first, applied only once a head has confirmed. And no source file may pass 1500 lines — split before you add.",
            r: ["packages/core/src/agents/plans.ts", "packages/core/src/agents/plan-apply.ts"],
          },
          {
            c: "Every side effect goes through one interface, <code>Backend</code>, with a port per store or service. No AWS SDK client exists outside <code>packages/core/src/aws/</code>.",
            r: ["packages/core/src/backend/types.ts"],
          },
          {
            c: "Two implementations. <code>AwsBackend</code> builds every client through <code>aws.client()</code>, the account guard; <code>MemoryBackend</code> is the in-memory fleet behind fixture mode and the unit tests. Lifecycle code runs unmodified on both.",
            r: ["packages/core/src/aws/client.ts", "packages/core/src/backend/memory.ts"],
          },
        ],
      },
      app: {
        title: "The app's main process",
        beats: [
          {
            c: "The desktop head is <code>packages/app</code>: an Electrobun main process that Hutch builds, with <code>packages/ui</code>'s React page in its webview. The page is loaded from a <code>views://</code> bundle and fetches nothing to render.",
            r: ["packages/app/src/main/index.ts", "packages/app/hutch.config.ts"],
          },
          {
            c: "A request arrives over Electrobun RPC. <code>rpc/bind.ts</code> hands its name to <code>dispatch</code>, which finds the handler in <code>HANDLERS</code>; handlers validate with <code>parseInput</code>, refuse during a teardown, and bind to their fleet through <code>target.ts</code>.",
            r: ["packages/app/src/rpc/bind.ts", "handlers/dispatch.ts", "handlers/shared.ts"],
          },
          {
            c: "Long operations go to the op registry in <code>ops.ts</code>: the handler answers <code>{ op_id }</code>, the run lands in the local <code>runs</code> table, and any page can reattach to its frames.",
            r: ["packages/app/src/ops.ts", "packages/app/src/handlers/streams.ts"],
          },
          {
            c: "<code>poller.ts</code> scans DynamoDB every 60 s and pushes fleet changes. <code>AppState</code> is read per request, never captured, so init, teardown and fleet switches can swap the live instance; <code>chat-owner.ts</code> shares one upstream chat subscription.",
            r: [
              "packages/app/src/poller.ts",
              "packages/app/src/state.ts",
              "packages/app/src/chat-owner.ts",
            ],
          },
          {
            c: "An agent's live desktop is a separate sandboxed webview with no RPC bridge, held to the box's own origin by the navigation rules in <code>main/navigation.ts</code> — never an iframe inside the app page.",
            r: ["packages/app/src/main/navigation.ts", "design.md §3.4"],
          },
          {
            c: "When it misbehaves: the main process logs every op and every failed request to <code>~/.hermetic/app.log</code>, quitting mid-op is refused, and <code>resume.ts</code> restarts interrupted ops at the next launch.",
            r: [
              "packages/app/src/log.ts",
              "packages/app/src/main/close-guard.ts",
              "packages/app/src/resume.ts",
            ],
          },
        ],
      },
      lab: {
        title: "Fixture backend, test isolation, the gates",
        beats: [
          {
            c: "Fixture mode is also the test bed. The same lifecycle code runs against <code>MemoryBackend</code> in unit tests, the dev app and the UI flows, and AWS calls elsewhere are mocked with <code>aws-sdk-client-mock</code>. No test needs an account.",
            r: ["packages/core/src/backend/fixture/", "design.md §11.1"],
          },
          {
            c: "Before <code>init</code>, the app holds a pre-init session whose backend throws <code>NOT_INITIALIZED</code> for every call. The wizard is built against <code>openForInit({ fixture: true })</code>, with three fake profiles.",
            r: ["packages/app/src/state.ts · openState", "packages/core/src/open.ts · openForInit"],
          },
          {
            c: "Isolation is enforced. <code>bunfig.toml</code> preloads <code>tests/preload.ts</code>: a fresh <code>HERMETIC_HOME</code> per test process, with <code>AWS_PROFILE</code> and <code>HERMETIC_FIXTURE</code> unset. Need a home of your own? <code>testHome()</code> or <code>mkdtempSync</code>.",
            r: ["tests/preload.ts", "tests/test-isolation.test.ts", "packages/app/test/home.ts"],
          },
          {
            c: "These are the gates <code>bun run check</code> runs, and each fails the build rather than a review: the import matrix, parity, secret leaks, the browser-safe <code>shared</code>, loopback binds, the foundation version table, the seams and the lint rules.",
            r: ["tests/", "scripts/lint.ts", "CONTRIBUTING.md"],
          },
        ],
      },
      read: {
        title: "Where to read next",
        beats: [
          {
            c: "To go deeper, keep fixture mode running and read the surface: <code>surface.ts</code> lists every method, <code>hermetic.ts</code> wires them. <code>docs/architecture.md</code> maps each package; <code>graft skeleton &lt;file&gt;</code> summarises any one file.",
            r: ["docs/architecture.md", "packages/core/src/surface.ts"],
          },
          {
            c: "Then the two doors every head goes through, <code>open.ts</code> and <code>context.ts</code>, and one method end to end: <code>agents.create</code> through <code>create-agent.ts</code>, the CLI command and the RPC handler.",
            r: ["packages/core/src/agents/lifecycle/create-agent.ts", "AGENTS.md · Start here"],
          },
          {
            c: "Then the edges: the account guard in <code>aws/client.ts</code>, the <code>Backend</code> interface and its in-memory twin, and exactly what render hands to a box.",
            r: ["packages/core/src/aws/client.ts", "packages/core/src/backend/types.ts"],
          },
          {
            c: "Then the box — bootstrap, stages, apply, the daemon — and the gates in root <code>tests/</code> that turn every rule on this path into a build failure.",
            r: ["packages/agentd/", "tests/"],
          },
          {
            c: "Spec questions go to <code>docs/design.md</code>, read by section and never whole — it is about 440 KB. Rules live in <code>AGENTS.md</code>; setup, CI and releases in <code>CONTRIBUTING.md</code>.",
            r: ["docs/design.md", "AGENTS.md", "CONTRIBUTING.md"],
          },
        ],
      },
    },
    chapters: [
      { name: "The map", items: ["packages", "core"] },
      { name: "Adding a method", items: ["dev-method", "dev-stream"] },
      { name: "Modes and heads", items: ["dev-modes", "app", "dev-ui"] },
      { name: "The box", items: ["dev-agentd", "dev-render"] },
      { name: "Working here", items: ["lab", "dev-loop", "dev-checklist", "read"] },
    ],
  });
})();
