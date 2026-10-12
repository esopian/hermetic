/* The Overview path — "The big picture", for anyone. Mostly pictures: what hermetic is for, the
 * coarse moving parts, how you reach an agent, and the five walls that keep it safe.
 * Every scene here is new and prefixed `ov-`; captions stay short and plain. */
(() => {
  /** A row-shaped icon tile: glyph on the left, a label and a one-line sub on the right. */
  const row = (x, y, w, h, glyph, label, sub, o = {}) =>
    icon(x, y, w, h, glyph, `${label}<div class="sub">${sub}</div>`, { ...o, c: `ovr ${o.c || ""}` });

  css(`
    .icn.ovr { flex-direction: row; justify-content: flex-start; text-align: left; gap: 20px; padding: 0 24px; }
    .icn.ovr .g { font-size: 44px; flex: none; width: 56px; text-align: center; }
    .icn.ovr .l { font-size: 21px; }
    .icn.ovr .l .sub { font-weight: 400; letter-spacing: 0; margin-top: 4px; }
    .icn.ov-mini .g { font-size: 44px; }
    .icn.ov-mini .l { font-size: 19px; }
    .zone.ov-ring { border-width: 1.5px; }
    .zone.ov-ring > .zl { font-size: 12px; }
    .ov-wl b { font-size: 25px; font-weight: 900; color: var(--fg); letter-spacing: -0.01em; }
    .ov-wl { font-size: 17px; line-height: 1.45; }
    .bx.ov-snap .t { font-size: 30px; }
    .ov-cap { font-size: 13px; text-align: center; color: var(--fg2); }
  `);

  glossary({
    AWS: "Amazon Web Services — the cloud where every agent's machine runs, in your organisation's own account.",
    upstream: "The original Hermes project, as its authors publish it.",
    "Hermes Desktop":
      "Hermes's own desktop app. It can connect to a remote Hermes dashboard — including a hermetic agent's.",
  });

  /* ------------------------------------------------------------------ 0 · title */
  scene({
    id: "ov-title",
    title: "hermetic, in pictures",
    html: `
      <div style="position:absolute;left:84px;top:150px;width:34px;height:34px;background:var(--ok)" class="pop on"></div>
      ${big(80, 214, "HERMETIC", 136, { b: 0 })}
      ${txt(86, 372, 720, `<span style="font-size:30px;font-weight:700;color:var(--fg)">A team's AI agents, each in its own sealed box.</span><br><span style="font-size:22px">Run from one control panel. Reached only over your private network.</span>`, { b: 0 })}
      ${kick(86, 520, "about six minutes · Space pauses · T shows chapters", { b: 1, st: "color:var(--ok)" })}

      ${zone(900, 80, 640, 500, "the cloud", { b: 0, c: "acc" })}
      ${[0, 1, 2, 3, 4, 5]
        .map((i) =>
          icon(940 + (i % 3) * 200, 130 + Math.floor(i / 3) * 210, 170, 170, "🤖", "", {
            b: i < 3 ? 0 : 1,
            c: "ov-mini acc iso",
            sub: "🔒 sealed",
          }),
        )
        .join("")}
    `,
    beats: [
      {
        c: "This is <b>hermetic</b>: a way to run a whole team's AI agents, each sealed in its own machine in the cloud, from one control panel.",
      },
      {
        c: "In about six minutes: why it exists, the moving parts, how you reach an agent, and the five walls that keep it safe.",
      },
    ],
  });

  /* ------------------------------------------------------------------ 1 · the problem */
  scene({
    id: "ov-problem",
    title: "One agent, one laptop",
    html: `
      ${kick(60, 22, "where most people start", { b: 0 })}
      ${zone(60, 60, 760, 560, "one person's laptop", { b: 0, c: "solid" })}
      ${icon(320, 100, 240, 200, "🤖", "AI agent", { sub: "reads · writes · browses · runs commands", b: 0, c: "acc" })}
      ${icon(100, 400, 210, 180, "🔑", "Your keys", { sub: "in a plain text file", b: 1, c: "warn" })}
      ${icon(335, 400, 210, 180, "📁", "Your files", { sub: "everything you can open", b: 2, c: "warn" })}
      ${icon(570, 400, 210, 180, "👤", "Your accounts", { sub: "it runs as you", b: 2, c: "warn" })}

      ${kick(900, 22, "now give a whole team one each", { b: 3 })}
      ${[
        ["Ana", 900, 60],
        ["Ben", 1130, 60],
        ["Chen", 1360, 60],
        ["Dev", 900, 240],
        ["Eli", 1130, 240],
        ["Fay", 1360, 240],
      ]
        .map(([n, x, y]) =>
          icon(x, y, 200, 160, "💻", n, { sub: "own agent · own keys", b: 3, c: "ov-mini warn" }),
        )
        .join("")}
      ${big(900, 460, "Keys everywhere.<br>Nothing in one place.", 44, { b: 4, st: "color:var(--bad)" })}
    `,
    svg: `
      ${wire("M420 300 C 420 350, 205 350, 205 396", { b: 1, c: "warn" })}
      ${wire("M440 300 L440 396", { b: 2, c: "warn" })}
      ${wire("M460 300 C 460 350, 675 350, 675 396", { b: 2, c: "warn" })}
    `,
    beats: [
      {
        c: "Today an AI agent like <b>Hermes</b> usually lives on one person's computer. It reads, writes, browses and runs commands — that's what makes it useful.",
      },
      {
        c: "To reach an AI model it needs <em>keys</em>, and those usually sit in a plain text file on that same computer.",
      },
      {
        c: "It also runs <em>as you</em>: your files, your logged-in accounts, your network. Whatever it does, it does with your permissions.",
      },
      {
        c: "Now give a team one each. Every agent is another hand-tended computer with its own copy of the keys.",
      },
      {
        c: "Nobody can see the whole set, and every laptop is a place a key can leak. That's the problem hermetic solves.",
      },
    ],
  });

  /* ------------------------------------------------------------------ 2 · the idea */
  const FLEET = [
    ["atlas", 430, 90],
    ["corvid", 712, 90],
    ["finch", 994, 90],
    ["heron", 1276, 90],
    ["lark", 430, 360],
    ["otter", 712, 360],
    ["pike", 994, 360],
    ["wren", 1276, 360],
  ];
  scene({
    id: "ov-idea",
    title: "A fleet of sealed boxes",
    html: `
      ${zone(380, 40, 1180, 580, "your organisation's cloud account · AWS", { b: 0, c: "acc" })}
      ${FLEET.map(([n, x, y], i) =>
        icon(x, y, 240, 220, "🤖", n, { sub: "own machine · own memory", b: i ? 1 : 0, c: "acc iso" }),
      ).join("")}
      ${FLEET.map(([, x, y]) => tag(x + 140, y + 12, "🔒 SEALED", { b: 3, c: "ok" })).join("")}
      ${icon(40, 230, 280, 210, "🖥️", "Control panel", { sub: "on your computer", b: 2, c: "acc" })}
    `,
    svg: `
      ${wire("M320 320 C 370 320, 380 200, 428 200", { b: 2, c: "acc" })}
      ${wire("M320 350 C 370 350, 380 470, 428 470", { b: 2, c: "acc" })}
    `,
    beats: [
      {
        c: "hermetic's idea: give every agent <b>its own machine in the cloud</b>. Not your laptop, not a shared server — one box per agent.",
      },
      {
        c: "Add more and you have a <em>fleet</em>: many agents, each in its own box, all inside one cloud account your organisation controls on AWS.",
      },
      {
        c: "You run the whole fleet from one <b>control panel</b> on your computer: create an agent, update it, rebuild it, or retire it.",
      },
      {
        c: "And every box is <b>sealed</b>: nothing on the internet can knock on it, and it holds only what that one agent needs.",
      },
    ],
  });

  /* ------------------------------------------------------------------ detour · from stock Hermes */
  scene({
    id: "ov-stock",
    title: "Hermes on its own",
    html: `
      ${zone(40, 40, 600, 580, "your own computer", { b: 0, c: "solid" })}
      ${icon(180, 90, 320, 230, "🧠", "Hermes", { sub: "installed straight onto your machine", b: 0, c: "acc" })}
      ${icon(80, 390, 250, 190, "🔑", "Key file", { sub: "your key, in plain text", b: 2, c: "warn" })}
      ${icon(350, 390, 250, 190, "👤", "You", { sub: "it runs as your user", b: 3, c: "warn" })}

      ${row(700, 40, 860, 100, "📜", "Installed by a script", "downloaded from the internet and run on your machine", { b: 1, c: "warn" })}
      ${row(700, 156, 860, 100, "🔑", "Keys in a plain file", "in your home folder, readable by anything running as you", { b: 2, c: "warn" })}
      ${row(700, 272, 860, 100, "👤", "Runs as you", "your files, your logged-in accounts, your network", { b: 3, c: "warn" })}
      ${row(700, 388, 860, 100, "🔄", "Updates itself", "pulls whatever upstream published most recently", { b: 4, c: "warn" })}
      ${row(700, 504, 860, 100, "🚪", "Local only — or open a door", "using it remotely means exposing a port or a public address", { b: 5, c: "warn" })}
    `,
    svg: `
      ${wire("M205 388 C 205 352, 300 356, 300 322", { b: 2, c: "warn" })}
      ${wire("M380 322 C 380 356, 475 352, 475 388", { b: 3, c: "warn", flow: false })}
    `,
    beats: [
      {
        c: "If you've run Hermes yourself, this will look familiar. Here's the usual do-it-yourself setup first — then, piece by piece, what hermetic does differently.",
      },
      {
        c: "You install it by running a script downloaded from the internet, straight onto your own computer, next to everything else you work with.",
      },
      {
        c: "Setup asks for your AI provider's key and saves it to a plain text file in your home folder, where anything running as you can read it.",
      },
      {
        c: "Hermes then runs as you, with everything your user account can touch — your files, your logged-in accounts, your cloud credentials and your network.",
      },
      {
        c: "It updates itself by pulling the latest upstream code, so two installs set up a week apart can quietly be running different versions.",
      },
      {
        c: "And it answers only on that computer. Using it from anywhere else means opening a port or a public web address — and then guarding that door yourself.",
      },
    ],
  });

  const DIFF = [
    [
      "where",
      "📜",
      "Your computer",
      "installed by a script, by hand",
      "☁️",
      "Its own cloud machine",
      "built from the same recipe, every time",
    ],
    [
      "keys",
      "🔑",
      "Plain key file",
      "sitting on your disk",
      "🔐",
      "Encrypted vault",
      "held only in memory on the box — or no key at all",
    ],
    [
      "runs as",
      "👤",
      "Runs as you",
      "your files and your accounts",
      "📦",
      "Runs as its own user",
      "on a machine with nothing of yours on it",
    ],
    [
      "updates",
      "🔄",
      "Updates itself",
      "follows the latest upstream",
      "📌",
      "Pinned version",
      "self-update off; you choose when to upgrade",
    ],
    [
      "access",
      "🚪",
      "Local, or exposed",
      "open a port to use it remotely",
      "🔒",
      "Private network only",
      "no doors open to the internet",
    ],
  ];
  scene({
    id: "ov-diff",
    title: "What changes with hermetic",
    html: `
      ${kick(220, 22, "on its own", { b: 0, st: "color:var(--warn)" })}
      ${kick(880, 22, "in hermetic", { b: 0, st: "color:var(--ok)" })}
      ${DIFF.map(([k, lg, ll, ls, rg, rl, rs], i) => {
        const y = 56 + i * 112;
        return (
          kick(40, y + 43, k, { b: i }) +
          row(220, y, 540, 100, lg, ll, ls, { b: i, x: 5, c: "warn" }) +
          row(880, y, 680, 100, rg, rl, rs, { b: i, h: String(i), c: "ok" })
        );
      }).join("")}
    `,
    svg: DIFF.map((_, i) =>
      wire(`M766 ${106 + i * 112} L872 ${106 + i * 112}`, { b: i, c: "ok", flow: false }),
    ).join(""),
    beats: [
      {
        c: "hermetic keeps Hermes and changes its surroundings. First, where it lives: on its own cloud machine, built from the same recipe every time instead of by hand.",
      },
      {
        c: "Keys move into the cloud's encrypted vault and reach the box only in memory, never on its disk. On Amazon's own AI models (Bedrock), an agent needs no key at all.",
      },
      {
        c: "The agent runs as its own user on its own machine. It can't see your laptop, your files or your other accounts — none of them are there.",
      },
      {
        c: "The Hermes version is pinned. Its self-updater is switched off, and the fleet moves to a new version only when you decide — so you always know what each agent runs.",
      },
      {
        c: "Instead of a local-only page or an opened port, you reach it over your private network, from wherever you are, with no doors open to anyone else.",
      },
      {
        c: "Underneath, it's the same Hermes — unmodified, installed from the same project. Only the box around it, and who holds the keys, has changed.",
      },
    ],
  });

  scene({
    id: "ov-boundary",
    title: "The box is the boundary",
    html: `
      ${zone(40, 50, 700, 570, "Hermes on your laptop", { b: 0, c: "solid" })}
      ${icon(210, 100, 360, 190, "🧠", "Hermes", { sub: "with a terminal", b: 0, c: "warn" })}
      ${icon(70, 410, 200, 170, "📁", "Your files", { b: 0, c: "ov-mini warn" })}
      ${icon(290, 410, 200, 170, "🔑", "Your keys", { b: 0, c: "ov-mini warn" })}
      ${icon(510, 410, 200, 170, "🏦", "Your accounts", { b: 0, c: "ov-mini warn" })}

      ${zone(820, 50, 740, 570, "Hermes in a hermetic box", { b: 1, c: "ok solid" })}
      ${icon(1010, 100, 360, 190, "🧠", "Hermes", { sub: "on a machine of its own", b: 1, c: "ok iso" })}
      ${row(860, 330, 660, 80, "🧰", "Full admin of its own box", "installs whatever a task needs", { b: 1, c: "ok" })}
      ${row(860, 420, 660, 80, "▶️", "Works unattended", "command approvals off by default — yours to turn on", { b: 2, c: "ok" })}
      ${row(860, 510, 660, 80, "🔁", "Worst case: rebuild it", "nothing of yours is inside to lose", { b: 3, c: "ok" })}
    `,
    svg: `
      ${wire("M330 290 C 330 350, 170 350, 170 406", { b: 0, c: "warn" })}
      ${wire("M390 290 L390 406", { b: 0, c: "warn" })}
      ${wire("M450 290 C 450 350, 610 350, 610 406", { b: 0, c: "warn" })}
    `,
    beats: [
      {
        c: "On a laptop, an agent with a terminal can reach everything you can — files, keys, accounts — so it's wise to keep it on a short leash.",
      },
      {
        c: "In hermetic the agent gets a machine of its own, with full admin rights on it. It can install whatever software a task needs without waiting for you.",
      },
      {
        c: "Command approvals are off by default, so an agent can work unattended. You can switch them back on for any agent that should ask first.",
      },
      {
        c: "That's safe because the box itself is the boundary: nothing of yours is inside it, and the worst case is one machine you rebuild.",
      },
    ],
  });

  const CARRY = [
    ["📊", "Hermes dashboard", "on every agent, at a private secure address"],
    ["🖥️", "Hermes Desktop", "connects to an agent — the panel hands you the address and token"],
    ["💬", "Messaging & jobs", "Slack, Telegram, Discord and scheduled jobs keep running"],
    ["🤖", "Several bots", "one agent can host many, each with its own role and model"],
  ];
  scene({
    id: "ov-carry",
    title: "What carries over",
    html: `
      ${kick(60, 40, "what you already know still works", { b: 0 })}
      ${CARRY.map(([g, l, s], i) => icon(60 + i * 380, 90, 340, 320, g, l, { sub: s, b: i, c: "ok" })).join("")}
      ${big(60, 490, "Same Hermes. Sealed box.", 64, { b: 3 })}
    `,
    beats: [
      {
        c: "Plenty stays exactly as you know it. Every agent has Hermes's own <b>dashboard</b>, reached at a private secure address on your tailnet instead of on localhost.",
      },
      {
        c: "Hermes Desktop can connect to a hermetic agent too: the control panel hands you the address and the access token to paste in.",
      },
      {
        c: "Messaging apps like Slack, Telegram and Discord, and scheduled jobs, still run through Hermes's own <em>gateway</em> — which the box keeps running for you.",
      },
      {
        c: "And one agent can host several bots, each with its own role and model. Same Hermes, sealed box — back to the main story.",
      },
    ],
  });

  /* ------------------------------------------------------------------ 3 · inside a box */
  scene({
    id: "ov-box",
    title: "What's inside one box",
    html: `
      ${zone(40, 40, 1520, 380, "one agent's machine · in the cloud", { b: 0, c: "solid" })}
      ${icon(80, 80, 330, 300, "🛠️", "Tools", { sub: "terminal · web search · files · chat apps", b: 1 })}
      ${icon(450, 80, 330, 300, "🧠", "Hermes", { sub: "the agent's brain — open-source, unmodified", b: 0, c: "acc" })}
      ${icon(820, 80, 330, 300, "🌐", "Its own browser", { sub: "a real Chrome window you can watch", b: 2, c: "blue" })}
      ${icon(1190, 80, 330, 300, "📡", "Caretaker", { sub: "sets the box up and reports its health", b: 4, c: "vio" })}
      ${txt(80, 488, 330, "<b>One agent = one machine.</b><br>Nothing shared with its neighbours.", { b: 0, st: "font-size:22px" })}
      ${icon(450, 470, 330, 160, "💾", "Memory disk", { sub: "separate · outlives the machine", b: 3, c: "ok" })}
      ${icon(1190, 470, 330, 160, "📋", "Fleet list", { sub: "in the cloud · your panel reads it", b: 4 })}
    `,
    svg: `
      ${wire("M450 230 L414 230", { b: 1 })}
      ${wire("M780 230 L816 230", { b: 2, c: "blue" })}
      ${wire("M615 380 L615 470", { b: 3, c: "ok", end: false, w: "fat" })}
      ${wire("M1355 380 L1355 466", { b: 4, c: "vio" })}
      ${lbl(1370, 434, "every 30 s", { b: 4 })}
    `,
    beats: [
      {
        c: "Open one box. At its heart is <b>Hermes</b>, the open-source AI agent, exactly as its authors ship it. hermetic changes where it runs, not what it is.",
      },
      {
        c: "Hermes works through tools: a terminal on its own machine, web search, files, and chat apps like Slack or Telegram if you connect them.",
      },
      {
        c: "Every agent also gets <em>its own browser</em> — a real Chrome window it drives, which you can watch and take over.",
      },
      {
        c: "Everything it learns — memory, skills, past conversations — lives on a <b>separate disk</b>. Hold that thought.",
      },
      {
        c: "A small caretaker program sets the box up and reports its health every 30 seconds, so your control panel always knows how each agent is doing.",
      },
    ],
  });

  /* ------------------------------------------------------------------ 4 · the control panel */
  scene({
    id: "ov-panel",
    title: "Your control panel",
    html: `
      ${zone(40, 40, 600, 580, "your computer", { b: 0, c: "solid" })}
      ${icon(80, 90, 250, 210, "🖥️", "Desktop app", { sub: "point and click", b: 0, c: "acc" })}
      ${icon(350, 90, 250, 210, "⌨️", "Command line", { sub: "type it · script it", b: 1, c: "acc" })}
      ${icon(80, 390, 520, 190, "⚙️", "One shared engine", { sub: "same actions · same checks · same rules", b: 2 })}

      ${icon(680, 110, 240, 230, "🚫", "No middleman", { sub: "no hermetic server, no company in between", b: 3, c: "ghost" })}
      ${tag(686, 560, "👥 TEAMMATES SEE THE SAME FLEET", { b: 3, c: "ok" })}

      ${zone(960, 40, 600, 580, "your AWS account", { b: 3, c: "acc" })}
      ${icon(1000, 90, 520, 210, "📋", "Fleet list", { sub: "the shared record of every agent", b: 3 })}
      ${icon(1000, 390, 240, 190, "🤖", "atlas", { sub: "agent", b: 3, c: "acc iso" })}
      ${icon(1280, 390, 240, 190, "🤖", "corvid", { sub: "agent", b: 3, c: "acc iso" })}
    `,
    svg: `
      ${wire("M205 300 L205 386", { b: 2, c: "acc" })}
      ${wire("M475 300 L475 386", { b: 2, c: "acc" })}
      ${wire("M600 485 L956 485", { b: 3, c: "acc" })}
      ${lbl(660, 470, "direct · your own AWS login", { b: 3, c: "acc" })}
    `,
    beats: [
      {
        c: "You manage the fleet from your own computer — with the <b>desktop app</b> if you like to point and click…",
      },
      {
        c: "…or the <b>command line</b>, if you prefer typing or want to automate things.",
      },
      {
        c: "Both sit on one shared engine, so they can always do exactly the same things. Nothing is app-only or command-line-only.",
      },
      {
        c: "That engine talks to your AWS account directly, with your own login — no hermetic server, no company in between. Teammates with access see the same fleet.",
      },
    ],
  });

  /* ------------------------------------------------------------------ 4b · creating an agent */
  const STEPS = [
    ["🏷️", "Name it", "pick a name and an AI model", ""],
    ["🎟️", "One-time pass", "a single-use key to join your private network", "blue"],
    ["☁️", "Machine + disk", "a fresh cloud machine and a new memory disk", "acc"],
    ["🔧", "It sets itself up", "network, disk, settings, Hermes, browser — then checks", "vio"],
    ["✅", "Ready", "on your tailnet and in the fleet list", "ok"],
  ];
  scene({
    id: "ov-create",
    title: "Creating an agent",
    html: `
      ${kick(40, 60, "what one click on create sets off", { b: 0 })}
      ${STEPS.map(([g, l, s, c], i) => icon(40 + i * 310, 100, 270, 260, g, l, { sub: s, b: i, c })).join("")}
      ${kick(40, 446, "status", { b: 0 })}
      ${st(40, 476, "creating", { b: 0, c: "dim" })}
      ${st(970, 476, "bootstrapping", { b: 3, c: "warn" })}
      ${st(1280, 476, "ready", { b: 4, c: "ok" })}
      ${st(970, 576, "stopped · resumes from the failed step", { b: 5, c: "bad" })}
    `,
    svg: `
      ${[0, 1, 2, 3].map((i) => wire(`M${312 + i * 310} 230 L${348 + i * 310} 230`, { b: i + 1, c: "acc" })).join("")}
      ${wire("M152 494 L966 494", { b: 3, flow: false })}
      ${wire("M1116 494 L1276 494", { b: 4, flow: false, c: "ok" })}
      ${wire("M1040 512 L1040 572", { b: 5, flow: false, c: "bad" })}
    `,
    beats: [
      {
        c: "What happens when you press <b>create</b>? You give the agent a name and choose which AI model it should use.",
      },
      {
        c: "hermetic mints a one-time pass to your private network — usable once, within the hour — and locks it in the cloud's vault.",
      },
      {
        c: "Then it starts a fresh cloud machine and a brand-new memory disk for the agent.",
      },
      {
        c: "The machine sets itself up step by step: joins your private network, mounts its memory, fetches its settings, installs Hermes and its browser, and checks it all.",
      },
      {
        c: "When every check passes, the agent shows up as <b>ready</b> — on your tailnet and in the fleet list, for everyone on the team.",
      },
      {
        c: "If a step fails, the box stops there and shows you why. Fix the cause and it resumes from that step instead of starting over.",
      },
    ],
  });

  /* ------------------------------------------------------------------ 5 · reaching an agent */
  const REACH = [
    ["💬", "Chat", "talk to it from the app or the command line", 220],
    ["📊", "Dashboard", "Hermes's own web page, at a private secure address", 350],
    ["👁️", "Live browser", "watch it work — and take the wheel", 480],
  ];
  scene({
    id: "ov-reach",
    title: "How you reach an agent",
    html: `
      ${row(80, 20, 400, 90, "🌍", "The internet", "scanners · bots · strangers", { b: 5, c: "bad" })}
      ${zone(30, 140, 1540, 490, "your private network · tailnet", { b: 1, c: "blue" })}
      ${icon(80, 290, 260, 210, "💻", "You", { sub: "your computer", b: 0, c: "blue" })}
      ${zone(960, 180, 570, 420, "one agent's machine", { b: 0, c: "ok solid" })}
      ${REACH.map(([g, l, s, y], i) => row(1000, y, 490, 110, g, l, s, { b: i + 2, c: "blue" })).join("")}
    `,
    svg: `
      ${wire("M340 380 C 640 380, 700 275, 996 275", { b: 2, c: "blue" })}
      ${wire("M340 396 C 640 396, 700 405, 996 405", { b: 3, c: "blue" })}
      ${wire("M340 412 C 640 412, 700 535, 996 535", { b: 4, c: "blue" })}
      ${wire("M480 65 C 640 65, 740 90, 760 136", { b: 5, c: "bad", end: false })}
      ${pk("M480 65 C 640 65, 740 90, 760 136", { b: 5, c: "bad", dur: 1400 })}
    `,
    svgTop: `<text class="lbl bad up" data-b="5" x="760" y="150" text-anchor="middle" style="font-size:30px;font-weight:900">✕</text>`,
    beats: [
      {
        c: "So how do you talk to an agent? Not over the open internet — its machine has no public door at all.",
      },
      {
        c: "Instead, you and your agents join one <b>private network</b>, a <em>tailnet</em> run by Tailscale. Only devices you've let in are on it.",
      },
      {
        c: "Over it you <b>chat</b> with the agent, from the desktop app or the command line.",
      },
      {
        c: "You can open the agent's own <b>dashboard</b>, Hermes's web control page, at a private secure address.",
      },
      {
        c: "And you can <b>watch its browser live</b> — and take the wheel when it needs a hand with a login or a pop-up.",
      },
      {
        c: "Anyone else on the internet gets nothing. There's no door to knock on, so their attempts never arrive.",
      },
    ],
  });

  /* ------------------------------------------------------------------ 6 · the five walls */
  const WALLS = [
    [
      "account",
      "Locked to one account",
      "every action re-checks it's in your cloud account",
      "one cloud account",
    ],
    [
      "nodoor",
      "No doors to the internet",
      "the cloud lets nothing in; each box has its own firewall",
      "no open doors",
    ],
    [
      "private",
      "Private network only",
      "only devices on your tailnet can reach an agent",
      "private network only",
    ],
    [
      "keys",
      "Keys off your laptop",
      "typed once, kept in an encrypted cloud vault",
      "keys kept off laptops",
    ],
    [
      "rebuild",
      "Rebuild from scratch",
      "any box can be thrown away and built fresh",
      "rebuildable box",
    ],
  ];
  scene({
    id: "ov-walls",
    title: "Five walls",
    html: `
      ${kick(50, 14, "how it stays safe", { b: 0 })}
      ${WALLS.map(([id, name, line], i) => {
        const y = 40 + i * 116;
        return (
          sealBadge(54, y + 8, id, { b: i + 1 }) +
          txt(170, y + 14, 520, `<b>${name}</b><br>${line}`, { b: i + 1, cls: "note ov-wl" })
        );
      }).join("")}
      ${WALLS.map(([, , , ring], i) =>
        zone(740 + 44 * i, 40 + 44 * i, 820 - 88 * i, 580 - 88 * i, ring, {
          b: i + 1,
          c: "acc solid ov-ring pop",
        }),
      ).join("")}
      ${icon(960, 260, 380, 140, "🤖", "one agent", { b: 0, c: "acc iso" })}
      ${st(1004, 584, "🩺 health check · doctor", { b: 6, c: "ok", st: "padding:3px 9px;font-size:12px" })}
    `,
    beats: [
      {
        c: "How does it stay safe? Not with one lock but with <b>five walls</b>, built the same way every time. Watch the counter, top right.",
      },
      {
        c: "Wall one: hermetic is <b>locked to one cloud account</b>. Every action re-checks the account first, so it can't touch the wrong one by mistake.",
        mark: "account",
      },
      {
        c: "Wall two: <b>no doors open to the internet</b>. The cloud's firewall lets nothing in, and every box runs its own firewall as well.",
        mark: "nodoor",
      },
      {
        c: "Wall three: the <b>private network is the only way in</b>. A device that isn't on your tailnet, and allowed by its rules, can't reach an agent.",
        mark: "private",
      },
      {
        c: "Wall four: <b>keys never sit on your laptop</b>. You type a key once; it goes straight to an encrypted vault in AWS, and the box holds it only in memory.",
        mark: "keys",
      },
      {
        c: "Wall five: <b>any box can be rebuilt from scratch</b>. If something looks wrong, throw the machine away and start a clean one.",
        mark: "rebuild",
      },
      {
        c: "And a built-in health check, <em>doctor</em>, compares what's actually running with what should be, so a wall that slips gets noticed.",
      },
    ],
  });

  /* ------------------------------------------------------------------ 7 · memory survives */
  scene({
    id: "ov-memory",
    title: "Memory survives a rebuild",
    html: `
      ${icon(80, 60, 320, 230, "🖥️", "Old machine", { sub: "misbehaving, or out of date", b: 0, c: "acc", x: 1 })}
      ${tag(96, 76, "THROWN AWAY", { b: 1, c: "bad" })}
      ${icon(560, 60, 320, 230, "✨", "Fresh machine", { sub: "clean install, latest setup", b: 1, c: "acc iso" })}
      ${icon(320, 400, 320, 200, "💾", "Memory disk", { sub: "memory · skills · conversations", b: 0, c: "ok" })}

      ${kick(980, 50, "a copy every day · last 7 kept", { b: 2, st: "color:var(--ok)" })}
      ${[1, 2, 3, 4, 5, 6, 7]
        .map((d, i) => bx(980 + i * 84, 80, 76, 96, "📸", `${d}d ago`, { b: 2, c: "xs c ok ov-snap" }))
        .join("")}
      ${icon(980, 240, 580, 190, "🗄️", "Retired agent, memory kept", { sub: "deleting the disk is its own, separate choice", b: 3, c: "ok" })}
      ${big(980, 488, "Machines are cheap.<br>Memory is precious.", 42, { b: 4 })}
    `,
    svg: `
      ${wire("M240 290 L400 400", { b: 0, c: "ok", end: false, w: "fat", x: 1 })}
      ${wire("M720 290 L560 400", { b: 1, c: "ok", end: false, w: "fat" })}
      ${wire("M402 175 L556 175", { b: 1, c: "acc", flow: false })}
    `,
    beats: [
      {
        c: "Remember the separate disk? Here's why. The machine holds only software; the agent's memory lives on its own disk beside it.",
      },
      {
        c: "When a box misbehaves or needs an update, hermetic throws the machine away, builds a fresh one, and plugs the same memory disk back in.",
      },
      {
        c: "That memory disk is also copied automatically every day, and the last seven copies are kept.",
      },
      {
        c: "Even retiring an agent keeps its memory by default. Deleting that disk is a separate, deliberate choice.",
      },
      {
        c: "A kept memory disk can even be handed to a new agent later. Machines are cheap and replaceable; memory is precious.",
      },
    ],
  });

  /* ------------------------------------------------------------------ 8 · recap */
  scene({
    id: "ov-recap",
    title: "The whole picture",
    html: `
      ${zone(30, 40, 370, 580, "you", { b: 0, c: "solid" })}
      ${icon(60, 90, 310, 200, "🖥️", "Control panel", { sub: "desktop app + command line", b: 0, c: "acc" })}
      ${icon(60, 380, 310, 200, "🔒", "Private network", { sub: "your tailnet", b: 2, c: "blue" })}

      ${zone(450, 40, 1110, 580, "your AWS account", { b: 0, c: "acc" })}
      ${icon(490, 90, 300, 190, "📋", "Fleet list", { sub: "every agent, one record", b: 0 })}
      ${kick(840, 86, "five walls · always up", { b: 3, st: "color:var(--acc)" })}
      ${WALLS.map(
        ([id, , , ring], i) =>
          sealBadge(850 + i * 142, 122, id, { b: 3 }) +
          txt(832 + i * 142, 220, 120, ring, { b: 3, cls: "note ov-cap" }),
      ).join("")}
      ${["atlas", "corvid", "finch"]
        .map(
          (n, i) =>
            icon(490 + i * 340, 330, 300, 170, "🤖", n, {
              sub: "own machine · own browser",
              b: 1,
              c: "acc",
            }) +
            bx(490 + i * 340, 534, 300, 64, "💾 Memory disk", "outlives the machine", {
              b: 1,
              c: "sm ok c",
            }),
        )
        .join("")}
    `,
    svg: `
      ${wire("M370 185 L486 185", { b: 0, c: "acc" })}
      ${["640", "980", "1320"].map((x) => wire(`M${x} 500 L${x} 534`, { b: 1, c: "ok", end: false, w: "fat" })).join("")}
      ${wire("M640 330 L640 284", { b: 1, c: "vio" })}
      ${wire("M370 470 C 420 470, 440 415, 486 415", { b: 2, c: "blue" })}
    `,
    beats: [
      {
        c: "Put it together. From one control panel — the desktop app or the command line — you run a fleet that lives in your own AWS account.",
      },
      {
        c: "Each agent is Hermes in its own sealed machine, with its own browser and a memory disk that outlives the machine.",
      },
      {
        c: "You reach agents only through your private network. To the rest of the internet, there are no doors.",
      },
      {
        c: "And five walls stay up the whole time: one account, no open doors, private access, no keys on laptops, and rebuild-anything.",
      },
      {
        c: "That's hermetic: a team's AI agents in sealed boxes, run from one place — with the safe way built in as the easy way.",
      },
    ],
  });

  /* ------------------------------------------------------------------ the path */
  pathway({
    id: "overview",
    title: "The big picture",
    audience: "Anyone",
    level: 1,
    minutes: 6,
    color: "var(--ok)",
    tagline: "What hermetic is for and how it works, in pictures.",
    learn: [
      "Why agents belong in sealed cloud boxes, not on laptops",
      "The moving parts: boxes, control panel, private network",
      "The five walls that keep a fleet safe",
    ],
    next: ["user", "security"],
    outro:
      "That's hermetic: a whole team's AI agents, each in its own sealed box, run from one place. Thanks for watching — pick a path below to go deeper.",
    tally: {
      label: "WALLS",
      unit: "WALL",
      verb: "UP",
      items: [
        {
          id: "account",
          name: "Locked to one cloud account",
          where: "Every action re-checks it's in the one AWS account you chose.",
        },
        {
          id: "nodoor",
          name: "No doors open to the internet",
          where: "The cloud lets nothing in, and every box runs its own firewall.",
        },
        {
          id: "private",
          name: "Private-network-only access",
          where: "Only devices on your tailnet, allowed by its rules, can reach an agent.",
        },
        {
          id: "keys",
          name: "Keys never kept on your laptop",
          where: "Typed once into an encrypted AWS vault; held only in memory on the box.",
        },
        {
          id: "rebuild",
          name: "Any box rebuilt from scratch",
          where: "Machines are throwaway; the agent's memory disk carries over.",
        },
      ],
    },
    chapters: [
      {
        name: "The idea",
        items: [
          "ov-title",
          "ov-problem",
          "ov-idea",
          {
            branch: {
              id: "stock",
              q: "Used Hermes on its own before?",
              hint: "A three-minute detour shows what changes when Hermes moves into a hermetic box.",
              default: 1,
              options: [
                {
                  label: "Yes — show me what changes",
                  sub: "your own Hermes install vs. a hermetic agent",
                  kicker: "detour · 3 min",
                  scenes: ["ov-stock", "ov-diff", "ov-boundary", "ov-carry"],
                  chapter: "Detour · from stock Hermes",
                },
                { label: "No — keep going", sub: "straight on to what's inside a box", scenes: [] },
              ],
            },
          },
        ],
      },
      { name: "How it works", items: ["ov-box", "ov-panel", "ov-create", "ov-reach"] },
      { name: "Staying safe", items: ["ov-walls", "ov-memory"] },
      { name: "Recap", items: ["ov-recap"] },
    ],
  });
})();
