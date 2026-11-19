# Operations runbook

A first real fleet, start to finish. See `docs/design.md` for the authoritative spec and `docs/architecture.md` for how the pieces fit together. Most of this runbook has been exercised against a real AWS account, but `teardown` and `foundation update` themselves are still exercised only against mocked AWS and the fixture backend; a handful of narrower unresolved points are marked **(unverified)** below.

## Prerequisites

- The Hermetic desktop app, and the `hermetic` CLI its **Install Command Line Tool…** menu item puts on your PATH. `README.md` has the install, the one-time quarantine clearance for the unsigned build, and how updates arrive; this runbook assumes both are already in place. A source checkout needs Bun per `.bun-version` instead.
- An AWS profile in `~/.aws/config` with credentials for the account you want to target — SSO, assume-role, or static all work; hermetic reads the profile, never `AWS_PROFILE`/`AWS_ACCESS_KEY_ID` directly (it warns if either is set, since `aws.client()` ignores them).
- One line in your tailnet policy file, pasted by hand **before** you create the OAuth client, because the client form only offers tags that already have an owner:

  ```
  "tagOwners": { "tag:hermetic": ["autogroup:admin"] }
  ```

  That is the only policy edit you make. hermetic writes its own `ssh` and `acls` entries itself once the client exists (§5.2), between `// hermetic:managed` markers, leaving every other byte of the file exactly as you wrote it.
- A Tailscale OAuth client, created by hand in the Tailscale admin console, carrying three scopes — `auth_keys` **write** (mints each agent's join key) and `devices:core` **read + write** (lets `doctor` check device drift and lets `recreate`/`destroy` delete an agent's stale device), both restricted to `tag:hermetic`, plus `policy_file` (lets hermetic keep the entries above current). Tailscale will not restrict `policy_file` to a tag — it is tailnet-wide — and attaches `devices:posture_attributes` and `devices:core:read` to it. There is no API to create this, `init` cannot do it for you. A client with fewer scopes still works: with only `auth_keys` agents come up but stale devices accumulate and `doctor` reports device drift as unchecked; without `policy_file` you paste the `ssh` and `acls` entries yourself (`hermetic policy` prints them and says what is missing). Widening it is a *new* client (Tailscale cannot edit an existing one's scopes) plus a rotation — see below.
- HTTPS Certificates enabled for the tailnet (admin console → DNS; MagicDNS must be on). Every agent serves its dashboard and noVNC at `https://<fleet>-<name>.<tailnet>.ts.net` (the cloud name, §6.1); `init --create` refuses and `hermetic doctor` reports when it is off. The only cost: agent hostnames appear in public Certificate Transparency logs.
- An agent's dashboard asks for no login. Hermes runs in its unauthenticated local mode behind a loopback reverse proxy on the box, so the tailnet ACL is the perimeter: whoever your policy file lets reach `tag:hermetic` on 443 can drive every agent. Keep that ACL tight — there is no second gate, and Hermes's audit log records no per-user identity (§6.4). That is a decision, not an oversight: Hermes does offer a password-gated posture, and hermetic declines it rather than issue and rotate a password per agent for operators already inside the tailnet.
- Enough IAM permission on the profile to create a CloudFormation stack, DynamoDB tables, an S3 bucket, and EC2/SSM resources — the exact policy is the foundation stack's own template **(unverified — never applied)**.

## `hermetic init` walkthrough

**CLI:**

```
hermetic init                 # auto: attaches if a `hermetic` foundation stack exists, else creates one
hermetic init --create        # force create, fail if one already exists
hermetic init --attach        # force attach, fail if none exists
```

You'll be asked for a profile (or pass `--profile`), then a region (defaults to the profile's own). `init` resolves your identity via STS, best-effort reads your account alias and org id, and — before doing anything mutating — shows you the twelve-digit account id and asks you to type it back as a confirmation. Then it pushes the Tailscale OAuth secret to SSM, creates the foundation, and — last of all, once the fleet row is written and your config is frozen, and if the client carries `policy_file` — writes hermetic's `ssh` and `acls` entries into your tailnet policy file, between `// hermetic:managed` markers, with the rest of the file untouched. The policy is last on purpose: if `init` fails after the policy phase, `hermetic policy` shows the blocks it wrote and `hermetic teardown` removes them, which is only true because your config is already frozen by then. Without the scope it prints the snippet instead; paste it before creating any agents, or `create` will succeed but nothing will be reachable. `--skip-policy` turns the write off for a policy deployed from git. `init` also points you at the DNS page to turn on HTTPS Certificates, without which the last provisioning step on every agent fails.

**App:** launched against a home that has never run `init`, the app opens the same flow as a wizard instead of the dashboard: step 1 profile pick, step 2 connection check (an `sts get-caller-identity` spinner that resolves to the identity card or an error+retry), step 3 foundation (tailnet, OAuth secret, network, ACL snippet, HTTPS Certificates check — skipped when attaching), step 4 op progress that swaps in place to the dashboard on success. Step 2 replaces the CLI's typed-twelve-digits gate with an explicit "I verified this is the account I intend to operate" checkbox next to the account id the same STS call resolved — the value it sends back to core (`account_id_typed`) is that same `identity.account_id`, and core still independently re-verifies it, so the safety property is the same even though the app's ceremony is a toggle, not a typed number. `bun run dev:wizard` exercises this without AWS (fixture backend, forced-uninitialized).

Re-targeting an already-initialized home to a different account or fleet is `hermetic init --reset --yes` and nothing else — no flag combination bypasses the typed confirmation.

## What to verify with `doctor`

```
hermetic doctor
```

Reconciles three sources that can silently disagree: the DynamoDB `agents` scan, EC2's own view of managed instances (`hermetic:managed=true` tag), and Tailscale's device list. It also reports the account/fleet guard status and any credential env-var overrides in effect. Run it after `init`, and any time the fleet feels off before you trust `agent ps`.

## The tailnet policy

hermetic keeps three entries in your tailnet policy file and nothing else: the `tag:hermetic` owner (only when nobody else owns the tag — normally you pasted it), the `ssh` rule, and the `acls` rule that opens 22, 443 and 7434 on tagged nodes. The 22 is there because Tailscale checks the network ACL before the `ssh` policy: without it, `tailscale ssh` to an agent is refused however the `ssh` rule reads. They live between `// hermetic:managed` markers; every other byte of the file — comments, key order, your own rules — is written back exactly as it came.

Inside the markers is hermetic's. Edit a line in there by hand and `hermetic policy` calls the block `drifted`, shows you the diff, and the next `hermetic apply` writes hermetic's version back over yours. To keep a change, make it outside the block.

```
hermetic policy            # scope, per-block state, and the diff a write would make
hermetic plan policy       # the same as a plan, steps and diff
hermetic plan policy --json > policy.json && hermetic apply policy.json --yes
```

The write is conditional. `plan policy` records the policy's ETag; `apply` re-reads the file and refuses with `CONFLICT` if it moved in between, so an edit someone made in the admin console is never silently overwritten. A plan that carries no ETag — because the policy could not be read, or Tailscale answered without one — is refused outright rather than written unconditionally; run `hermetic plan policy` again. Before writing, the candidate goes to Tailscale's own `/acl/validate`, which runs your policy's embedded tests — a policy Tailscale would reject never reaches the tailnet. `hermetic policy`, `hermetic plan policy` and `hermetic doctor` call the same endpoint, so all three are also running your embedded ACL tests, on Tailscale's side and storing nothing. Each write appends a `policy.apply` event to `_fleet` with the ETag before and after, never the policy text.

The diff you are shown is only hermetic's own blocks — the marker lines and what is between them, one hunk per key, headed `@@ acls @@`. Nothing from the rest of your file appears in it, including the lines immediately around the block, because that output travels into plans, JSON and logs and your policy file can name people.

`hermetic doctor` reports the same state as one informational line. It is never a finding: on a fleet whose OAuth client lacks `policy_file` there is nothing hermetic can do about it, and a report that says PROBLEMS for ever is one nobody reads.

If you keep the policy in git, run `hermetic init --create --skip-policy` and paste from `hermetic policy` instead — the snippet and the managed blocks are generated from the same source, so they cannot say different things.

### Containing a compromised agent (October 2026)

On 2026-10-25 a researcher published "Tailworm", a set of findings in Tailscale and headscale that had not been coordinated with Tailscale and were unpatched at the time. Their chain is: an authorized Tailscale SSH session gains root on the target through port forwarding; a broad SSH grant then carries that to every server the device may reach; and, on a tailnet without Tailnet Lock, a captured auth key enrolls an attacker's machine as a tagged server. Root on the box adds nothing for hermetic, because the `hermes` account already has passwordless sudo. What matters is how far one compromised agent, or one stolen operator session, can reach from there. Until Tailscale ships a fix, check the following.

- **Your own policy must not let agents reach the rest of the tailnet.** Tailscale's default policy allows everything (`"src": ["*"], "dst": ["*:*"]`, and leaving out both `acls` and `grants` means the same). An agent box is a tagged node running an AI agent with root, and its security group allows any outbound traffic, so on such a tailnet it can open connections to every device you own. Replace allow-all with explicit rules. hermetic itself only needs members to reach `tag:hermetic` on 22, 443 and 7434. `hermetic policy` lists rules that let `tag:hermetic` reach anything else.
- **No `ssh` rule, `autoApprovers` entry or `hosts` alias should give `tag:hermetic`, `autogroup:tagged` or `*` a source, route or exit node.** hermetic writes none of these; check that nothing else does.
- **Treat the fleet as one blast radius.** Every agent box in a fleet shares one instance role, which can read every agent's SSM slots (each agent's provider key, and a new agent's join key until it is used), read every agent's rendered config, and write every agent's row. Agent-scoped roles are planned. Until they land, a compromised agent means every provider key in that fleet is exposed.
- **Host names from the row are checked, not trusted.** A box reports its own tailnet name, and because any box can write any row, hermetic uses a reported name only when it is one hermetic gives that agent, in the fleet's own tailnet. Anything else is ignored: the terminal, chat, dashboard and desktop links use the canonical `<fleet id>-<agent>` name instead, the phone is sent no name for that agent, and `hermetic doctor` reports it as `tailscale_untrusted_name`. A Tailscale `-2` suffix is no longer followed either, since a sibling named `<agent>-2` would wear the same name; delete the stale device and recreate the agent. The check compares against the fleet's tailnet, which is itself stored on the `_fleet` item that the shared role also lets a box rewrite; the desktop terminal additionally refuses any host outside the laptop's own tailnet, but the other links rely on `_fleet` until agent-scoped roles land.
- **Keep Tailscale current.** Agent boxes enable Tailscale's auto-updater on every run of stage 01; a box that has not run it since foundation v11 may not have it. Update laptops and phones as soon as a fix ships. The heartbeat reports each box's `tailscale_version` in `hermetic agent status`.

If you suspect an agent:

1. `hermetic agent destroy <name>`. Destroy deletes the agent's tailnet device only when it is offline and its name matches the row, so afterwards check the Tailscale admin console for any `tag:hermetic` device that is still online or that no agent row names, and delete it there.
2. Rotate every provider key the fleet uses (`hermetic providers update <profile> --api-key-stdin`), then recreate the agents that use it.
3. If the laptop itself is suspect, rotate the OAuth client (below).
4. Review the `_fleet` history for `policy.apply` events you did not make. Treat events and log tails from the suspect fleet as forgeable: any box could have written them.

## Rotate the Tailscale OAuth client

Tailscale cannot change the scopes of a client that already exists, so widening the fleet's client — from `auth_keys` alone to `auth_keys` + `devices:core`, or onto `policy_file` so hermetic can keep the tailnet policy current — is always a new client plus a rotation.

1. In the admin console, create a new OAuth client with every scope: **Auth Keys → Write** and **Devices → Core → Read, Write**, each tagged `tag:hermetic`, plus **Policy File → Write** (tailnet-wide; Tailscale attaches Devices → Posture Attributes and Devices → Core → Read to it). Copy the secret; Tailscale shows it once.
2. Push it. The value comes over stdin or a prompt, never a flag — a flag value lands in your shell history and in hermetic's `runs` table.

   ```
   printf '%s' "$SECRET" | hermetic secrets push _fleet --tailscale-oauth
   ```

   The secret is proved before it is stored: hermetic exchanges it for a token, mints a `tag:hermetic` key, revokes it, and lists the tailnet's devices. A client that cannot mint is refused with `TAILSCALE_UNAVAILABLE` and **nothing is written** — the old secret stays in place and the fleet keeps working. A client that mints but cannot list devices is stored, with a warning naming what is missing.
3. Confirm:

   ```
   hermetic secrets verify _fleet     # /hermetic/<fleet_id>/tailscale/oauth-secret and oauth-client-id both "set"
   hermetic doctor                    # the device list is read rather than skipped
   hermetic policy                    # scope `read + write`, and what hermetic's entries say now
   ```

   The client id is parsed out of the secret and recorded on `_fleet` and in its own slot, so `hermetic config` and the app's Settings view name the client that is actually in use.
4. Delete the old client in the admin console.

Existing agents are unaffected. Auth keys are single-use with a one-hour expiry and are consumed at first boot, so the rotation changes only which client mints *future* keys — no agent needs a recreate.

## Creating the first agent

```
hermetic agent create atlas                          # medium size, bedrock, no extra secrets
hermetic agent create atlas --size small
hermetic agent create atlas --rollback-on-failure    # undo what the run made instead of leaving it to re-run
```

A create that fails leaves the agent half-made *on purpose*: the row names what exists in AWS, and re-running `hermetic agent create atlas` finishes it (or `hermetic agent destroy atlas --yes` clears it). `--rollback-on-failure` chooses the other answer — the run unwinds only what it itself created, in reverse, and rethrows the original error, so you are left with nothing rather than something to finish. It is worth passing in scripts and on a first attempt at a name; it never deletes a volume or an instance the run found rather than made, and on a *resumed* create it leaves the row, the SSM slots and the config alone. If one undo step fails, the rest still run and the row survives, with an event telling you to run `hermetic agent destroy atlas --yes`. Interrupting a create with ctrl-C does *not* roll it back — an interrupt means stop, and the row it leaves is the resumable one you would want.

Takes about 8 minutes end to end (AMI boot, package install, Hermes setup). Watch it with `hermetic agent status atlas` or the dashboard's create-progress drawer, which reattaches to the running op if you close and reopen it. An agent created with no flags is a complete, sealed agent — zero inbound rules, Tailscale-only access, Bedrock through the instance role.

### Configuring Hermes itself

An agent created with no Hermes flags is already usable: hermetic writes the provider wiring, and seeds a model and sane defaults into the agent's own config on first boot. Naming a setting changes who owns it:

```
hermetic agent create atlas --model anthropic/claude-opus-5
hermetic agent create atlas --terminal docker --max-turns 200 --reasoning high
hermetic agent set atlas --model us.anthropic.claude-haiku-4-5-20251001-v1:0
```

**hermetic manages what you tell it to manage.** A setting you name goes into the agent's managed config (`/etc/hermes/config.yaml`), is rewritten on every apply, and cannot be changed on the box — `hermes config set` refuses a managed key, and `hermetic agent set` is what moves it. A setting you leave out is seeded once into the agent's own `$HERMES_HOME/config.yaml` and is then the agent's: change it from its dashboard, and hermetic will not write it again.

The model id is spelled the way the *provider* spells it, and hermetic does not translate: `claude-sonnet-5` on the Anthropic API, `anthropic/claude-sonnet-5` on OpenRouter or the Nous Portal, a `us.`-prefixed inference-profile id on Bedrock. A Bedrock model must also be one the fleet's role may invoke — the foundation policy grants `DEFAULT_BEDROCK_MODEL_IDS` and nothing else.

`agent set` re-renders and re-uploads the agent's config, but nothing reaches a running box on its own: until it is applied, the agent reads as config-`drifted`. Apply it in place with a rollout (`hermetic plan rollout --agent atlas --json > rollout.json`, then `hermetic apply rollout.json`), or let the next `agent rerun` or `agent recreate` carry it.

### The agent boots but the first message fails

`No inference provider configured. Run 'hermes model' …` means Hermes started with no provider or no model. `06-verify` now catches this at bootstrap — `hermeticd stage verify-hermes` fails the stage and names which of provider / model / key is missing — so a *newly created* agent cannot reach you in this state. An agent created before that check existed can:

```
hermetic agent set atlas --model anthropic/claude-sonnet-5   # or the right id for its provider
hermetic agent rerun atlas
```

If the missing piece is the key rather than the model, `hermetic secrets push atlas --provider-key` fills the slot and the next `rerun` materialises it.

## Day to day: `ssh`, `logs`, `rerun`

```
hermetic ssh atlas                  # tailscale ssh, ACL-scoped, no keypair involved
hermetic logs atlas [unit] [-f] [--file agent|errors|gateway]   # streamed over the hermeticd RPC, not a log-shipping pipeline
hermetic agent rerun atlas          # resume a failed bootstrap from its first failed stage
```

`--file` is how you read Hermes rather than systemd: Hermes writes its own errors to `$HERMES_HOME/logs/errors.log` and leaves the journal carrying only its startup banner and uvicorn noise, so a failed agent turn is `hermetic logs atlas --file errors`, not `hermetic logs atlas hermes-gateway`. Stage and bootstrap failures stay on the journal path below. `--file` takes one of `agent`, `errors`, `gateway` and is exclusive with both a `[unit]` argument and `--console` — the CLI refuses the combination rather than silently preferring one.

There is no *automatic* converge. A config change made with `agent set` (secrets mode, provider, size intent, Hermes settings) is re-rendered and re-uploaded immediately, but nothing on a schedule pushes it to the box. It takes effect when you ask for it — `hermetic plan rollout [--agent <name>...]` writes the plan and `hermetic apply` converges each box in place, one at a time, waiting for it to report the new config — or on the agent's next `rerun` or `recreate`. `agent rerun` is for a stuck bootstrap only — the agent must be in `error`; it writes a `command` on the row that `hermeticd` picks up on its own poll and resumes from the failed stage. `rerun` answers `409 CONFLICT` instead of queuing if a previous rerun `command` on that row is still unacknowledged, or `409 LOCKED` if another operator currently holds the agent's lock — retry once whichever is holding it clears.

### Bootstrap failed on a stage

An agent stuck in `error` failed somewhere in bootstrap — a stage script, or a step before any stage even ran (fetching the fleet manifest, downloading or verifying a stage). Both land in `error` the same way, with the same `bootstrap.stages`/message shape. To fix it:

1. `hermetic agent get atlas` (or the dashboard drawer) and read `bootstrap.stages` — the failed stage's `exit_code` and `message` name what went wrong.
2. Read the full stage log on the box: `hermetic logs atlas` streams `/var/log/hermetic/stages/<id>.log` for the failing stage. A stage that already succeeded has a completion marker at `/var/lib/hermeticd/stages/<id>.ok` holding its sha256 — `rerun` skips anything whose marker still matches, so only the failed stage and anything after it actually re-runs. The fleet manifest itself is cached on the box at `/var/lib/hermeticd/fleet.json`, if you need to confirm which release it last saw.
3. Fix the outside cause (a bad SSM value, a full disk, a transient apt mirror — whatever the message points at).
4. `hermetic agent rerun atlas`. Watch `bootstrap.stages` in `agent get`/the dashboard: `hermeticd` resumes at the failed stage with a bumped attempt count and re-runs every stage after it. An agent that sits in `error` for 24 hours without a successful rerun has its runner exit on its own; systemd restarts `hermeticd-bootstrap.service` and the same resume logic picks up where it left off.

## Upgrading

```
hermetic upgrade --hermeticd <ver> [--now] [--no-rollout] [--rollout-wait-ms <ms>]   # fleet-wide only: no name, no --all; rewrites the fleet manifest pointer
hermetic upgrade --hermes <ver> [<name>|--all] [--now]
```

`--hermeticd` is fleet-wide by definition — it takes no `<name>` and no `--all`, and there's no RPC to any box; it rewrites the fleet manifest's version pointer. What happens next depends on the fleet's **hermeticd auto-update** setting, which is on unless you switched it off (`hermetic settings set --no-auto-update-hermeticd`, or Settings → Foundation → "hermeticd updates" in the app; `hermetic settings show` prints it). With it on, and when the release actually changed, `upgrade --hermeticd` — and `hermetic artifacts push`, which does the same after publishing — asks every `ready` or `degraded` agent to take it at once and waits for each box to report the new binary's digest, up to ten minutes (`--rollout-wait-ms <ms>`, at most thirty). A box that has not landed by then is reported as a warning, never a failure: it takes the release at its next update check, which with auto-update on is every five minutes (hermeticd checks the fleet manifest on that interval, so a box that was stopped or busy during the push catches up by itself soon after it is back; a box still on a hermeticd older than the setting checks only at its nightly slot). An agent that another operation holds locked at the time is not asked — the request would collide with that operation's own row writes — and is listed as deferred; it catches up the same way. A stage-only change (same binary) is requested but not waited on, and an unchanged release is nothing to roll out. `--no-rollout` publishes the pointer and skips the request this once; `--now` asks the boxes even when auto-update is off or the release is unchanged (the two together are refused). With auto-update **off**, nothing asks the boxes unless you pass `--now`: each agent's own nightly update tick — a minute in the 03:00–03:59 UTC window picked from a hash of its name, so the fleet doesn't hit S3 in the same minute — is what picks the release up. However a box is prompted, it notices the change by comparing the sha256 of its installed binary against the manifest's, not by comparing version labels; a digest mismatch downloads the new binary first, then the stages, then restarts `hermeticd.service` last, while a stage-only change skips the restart. `hermeticd update --check` on the box reports without writing anything. `--hermes` bumps the pinned version in the render and re-uploads the agent manifest — one agent, or `--all` for the whole fleet, upgraded one at a time. On its own that is all it does: the box keeps running the Hermes it has, and the pin takes effect on the agent's next `recreate`, same as any other config change (the agent reads as config-`drifted` until then, and `hermetic plan rollout --agent <name>` applies it too). Add `--now` to apply it in place: hermetic writes the same converge request a rollout does and waits — up to ten minutes per agent — for the box to report the new config. On the box, hermeticd stops the Hermes gateway and dashboard, checks out the pinned ref, reinstalls the venv and restarts them; the instance, its disks and its tailnet address stay, but **a turn in flight is interrupted**. A box that is not `ready`, `degraded` or `error` keeps the pin and is reported skipped, and one that does not answer in time is reported unconverged rather than failed — `hermetic agent history <name>` shows what its apply did. The app's Lifecycle card offers both: **Upgrade now** is `--now`, **Pin for next recreate** is the pin alone. `--now` beside `--hermes` is that in-place converge; beside `--hermeticd` it only means "ask the boxes to take the release now" (above), not a converge. Hermes memory and skills survive either kind of upgrade because they live on `/data`, never the root volume. hermeticd's version label is `BUILD_VERSIONS.hermeticd` (`packages/core/src/build-versions.ts`), compiled into the binary when `artifacts push` builds it. It is edited by hand, so bump it in any change that alters `packages/agentd`: the label is what `foundation status` and the skew band compare, and an unbumped label reports a stale fleet as current, even though the box itself updates by digest.

**Knowing when to bump Hermes.** hermetic never bumps Hermes for you — the pin is per agent, and which agent goes first is your call. What it does do is tell you there is something to decide: `hermetic foundation status` prints a `hermes` line, and the app's Settings → Foundation card shows the same thing with a badge, comparing the tag this build pins (`hermes_ref`, e.g. `v2026.9.24`) against the tag on upstream's latest GitHub release. The check is advisory and best effort — unauthenticated (GitHub allows 60 requests an hour per IP), five-second ceiling, cached for six hours, and nothing polls it on a timer. When it cannot answer it says "could not check" and why; it never reports "up to date" for a check that did not happen, and it never blocks or fails the command it rides on. Acting on it is one agent at a time:

```
hermetic foundation status                      # ... hermes  pinned 0.21.1 (v2026.9.14) · latest 2026.9.18 · update available
# then, in this repo: set BUILD_VERSIONS.hermes (the semver upstream's pyproject reports)
# and BUILD_VERSIONS.hermes_ref (the tag — v2026.9.4 in this example output; the ref
# this build actually pins is v2026.9.24) together, and rebuild.
hermetic artifacts push                         # mirrors the new ref into the fleet bucket (and, if hermeticd itself changed, rolls that out)
hermetic upgrade atlas --hermes <new semver> --now   # one agent first, reinstalled in place
# or pin it and let the next rebuild install it:
hermetic upgrade atlas --hermes <new semver>
hermetic agent recreate atlas --yes
```

The two-step is not ceremony, and `--now` does not shorten it: an agent row has no ref of its own, every render pins this build's `BUILD_VERSIONS.hermes_ref`, so an in-place upgrade — like a recreate from this checkout — can only reach the ref this build pins. Upstream tagged releases by date until v0.21.5 (`v2026.9.24`) and by SemVer (`vX.Y.Z`) from v0.21.6, so for 0.22 and later the tag and the version move together, but the ref the box checks out still lives in `BUILD_VERSIONS.hermes_ref` and no flag moves it, while `--hermes` pins what `hermes --version` must then report. Bumping only the flag gives you a box that checks out the old ref and fails its own version assertion, which is the apply refusing to ship a version nobody asked for.

A bump also has to reach the fleet bucket, because a box does not clone github.com when the manifest offers it something better. `hermetic artifacts push` — and `init`, and `upgrade --hermes` — builds `hermes/<ref>.bundle` from a shallow fetch of that one tag, staged under `$HERMETIC_HOME/mirror/` and deleted once the bundle is uploaded, uploads it, and records its digest and size in the fleet manifest's `hermes` block (§3.6). Only tags are mirrored: a `hermes_ref` naming a branch is skipped with a warning rather than pinned to a moving target. The step fails soft — a laptop that cannot reach GitHub reports a `mirror_warning` on `artifacts push` and leaves the manifest's `hermes` block as it was, and any box whose ref has no bundle falls back to the direct clone it always used. The fleet must be on **foundation v7** for boxes to read the bundle at all (the agent role's `hermes/*` S3 grant): run `hermetic foundation update` on a fleet created before it, or every agent quietly takes the fallback path.

### Upgrading a fleet from Hermes 0.21.5 to 0.23.1

Do this one box at a time, on a build that pins `hermes: "0.23.1"` and `hermes_ref: "v0.23.1"` (`packages/core/src/build-versions.ts`).

1. **Update the clients first.** Every laptop and the desktop app that operates the fleet must be on this build before any box moves: an older client renders a 0.21 config for a row it did not know had moved.
2. **Publish.** `hermetic artifacts push` mirrors `hermes/v0.23.1.bundle`, uploads the new `hermeticd` and records both in the fleet manifest. A box on an older `hermeticd` refuses a 0.22+ manifest (`hermes-0.22-install`), so this has to land first. The default auto-update takes the new `hermeticd` to running boxes within minutes.
3. **Mixed window.** Until every row is upgraded, rows are on two Hermes versions. A render from this build pins the 0.23.1 ref, so a row still on 0.21.5 cannot take a new config until it is upgraded, and this build does not try:
   - `plan rollout` + `apply`, and the config phase of `artifacts push` and `foundation update`: the row is skipped, with "held on Hermes 0.21.5, and this build renders 0.23.1". The rest of the fleet converges.
   - `agent set` (any setting, including `--memory` and `--model`), and a provider change (`--provider`, `--provider-profile`, `--refresh-profile`): refused with `HERMES_UPGRADE_REQUIRED` (exit 7). Nothing is written or staged.
   - `agent recreate` and `plan recreate`: refused with `HERMES_UPGRADE_REQUIRED` (exit 7) before the old instance is touched. The agent keeps running.
   - A `create` that an older build left half-done is refused the same way when it is resumed.

   The error names the fix: `hermetic upgrade --hermes 0.23.1 <name> --now` (step 5), then repeat the command. Stop, start, pause, resume, rerun, destroy, logs, chat and history are not affected, because they render nothing. The new managed keys (`sessions.auto_prune: false`, `webapp.enabled: false`, `plugins.auto_update_check_hours: 0`) reach a row only when it is upgraded.
4. **Snapshot first.** On a production box take an EBS snapshot of its data volume by hand. The pre-upgrade copy below is a file copy on the same volume, not a snapshot, and there is no `snapshots create` command in this release.
5. **Upgrade a box.** `hermetic upgrade --hermes 0.23.1 <name> --now`, one agent at a time, not `--all` on the first pass. It is refused for an agent whose box has not yet applied its row's current config (pin without `--now` first, then `plan rollout`, or recreate). It waits up to 10 minutes for the agent to have no running session (an unreachable gateway counts as busy), and changes nothing if that wait runs out; `--force` skips the wait and stops Hermes mid-session. The box first fetches the Hermes bundle and the uv, Node and pnpm tarballs while Hermes keeps running; if that fails, Hermes is untouched. It then holds and stops Hermes (including the hermes user's `hermes-worker-*` scopes, where cron jobs, kanban workers and background commands run), confirms nothing still has its files open, copies its state, moves the checkout to 0.23.1 and installs it, and waits up to 5 minutes for the gateway and `/api/health` to report 0.23.1. The install still needs the network for PyPI (`uv sync`), npm (`pnpm install`) and memory plugins. The command waits up to 32 minutes; on a `t4g.small` canary box three runs took 2 minutes 54 seconds to 3 minutes 6 seconds (held 69 to 87 seconds, HTTP down about 81 to 100 seconds from the laptop). A rollback through the gate with the laptop gone ended in 48 to 57 seconds with no network, after the gate failed early (about 40 seconds, `crash-loop`, 3 restarts).
6. **Check the result.** `hermetic agent ps` shows the pin and the box's state. `hermetic logs <name> --file errors` shows Hermes's own errors (`logs <name> --console` reads the serial console if the box's RPC never came up). `hermetic agent history <name>` shows each stage and, on a failure, the last lines of its log and the failure's code. For a Hermes swap it also shows the box's timeline as `upgrade` events: units held, the copy taken with its path, gate started, gate passed or failed with the reason, the copy sealed with its path, and a rollback with the copy it restored from. On the box, `$HERMES_HOME/installs/<id>/` holding only an `.install.lock` and `bootstrap/default.json` is normal for 0.23.1; a venv or an install payload under it is not. What each code means, and what to do:

   - `HERMES_UNITS_ACTIVE`, `HERMES_BACKUP_FAILED`, `HERMES_SWAP_ABORTED`: the swap stopped before the checkout moved. The box runs 0.21.5 on its old state, nothing changed (a stopped Hermes was started again and confirmed up by the same stability window and `/api/health` check), and the row's pin is put back. `HERMES_UNITS_ACTIVE` names a stray process holding Hermes files open or a unit that would not stop. `HERMES_BACKUP_FAILED` is no room for the copy or a copy that did not verify. `HERMES_SWAP_ABORTED` is a failed pre-fetch (bundle, uv, Node or pnpm), an installed version that cannot be read, or no room to copy the venv aside. These are warnings: the command exits 0, and `--all` goes on to the next agent. Fix the cause, then run `hermetic upgrade --hermes 0.23.1 <name> --now` again.
   - `HERMES_UPGRADE_ROLLED_BACK`: the checkout moved and the install, the web build, the start or the 5-minute gate failed. The box is back on 0.21.5 with its old install (put back from a copy set aside during the swap, no network needed) and the state from the copy, and 0.21.5 has been confirmed up. What the failed attempt wrote is in `/data/hermetic-backups/post-<version>-<UTC time>/`, and the row's pin is put back. The command then fails (exit 1) with this code, naming the agent and the version it runs again; with `--all` it stops at that agent, the agents before it stay upgraded, and the ones after it are not attempted and are listed in the error. Files the new Hermes synced into its home before the gate failed (bundled skills, `installs/<id>/.install.lock`) stay; sessions, messages, facts, routines, kanban and files are restored exactly, and both backup directories stay under `/data/hermetic-backups`. The `hermetic-hold.conf` drop-ins on the Hermes units are permanent and inert: they act only while `/var/lib/hermeticd/hermes-upgrade.hold` exists, and it is gone after either outcome. A warning that the rollback "was not tidied" means 0.21.5 is up and only cleanup (sealing the copy, dropping the set-aside install) failed. The box refuses to apply the same config again on its own, including from a reboot's stage rerun, until the laptop sends a new request, so fix the cause and run the upgrade again (`agent rerun` alone does not get past it; a new `plan rollout`/`apply` or `upgrade --now` does). If the command was no longer waiting when the box rolled back (interrupted, or past its 32 minutes), the row still names 0.23.1 and `agent ps` shows 0.23.1 and ready, with no flag (only `agent history` shows `rolled back …`, and `/var/lib/hermeticd/hermes-rolled-back.json` records it on the box). The next `upgrade`, `plan rollout`/`apply` or `artifacts push` puts the row back to 0.21.5 with the config the box ran before, and asks the box to re-apply that config, which swaps nothing. It re-renders nothing for 0.21.5. Then run the upgrade again.
   - `HERMES_ROLLBACK_FAILED`: the rollback itself did not finish, or 0.21.5 did not come up after it (also when an aborted swap's old units do not come back). Hermes is not confirmed up and the units may be held. Nothing was deleted: the event names the copy, the state moved aside and whether the old install was already back (`old_install_restored`). The box makes no resume of its own. Fix the cause on the box over `hermetic ssh <name>`, then send a request with a new id (`upgrade --now` or `plan rollout`/`apply`), which clears the hold. If the old install was back, that apply starts it and gates it first.
   - `HERMES_RESTORE_REFUSED`: a downgrade found no validated copy for the version it was asked to restore (or no room, or an unsafe path). Only the newest copy for that version not already restored from is tried; if it does not validate, the message names its directory, and older copies are never used automatically, since that would drop everything written since. Inspect the named directory. Nothing moved and the box still runs what it ran; the row's pin is put back. A newer Hermes migrates its stores and that cannot be undone, so without the copy there is no downgrade across a minor version; a patch-level downgrade needs none.
   - `HERMES_RESTORE_FAILED`: a downgrade failed after its state or checkout moved, or its gate failed, or a restore was interrupted and finishing it was not part of the move requested. Hermes is down and the units are held. Nothing was deleted: the event names the copy and `moved_aside`. The code (like `HERMES_ROLLBACK_FAILED`) is recorded in `/var/lib/hermeticd/hermes-rolled-back.json`. Fix the cause, then pin the same target again with a new request (`upgrade --hermes <target> --now`): the restore is not repeated, the target is brought up on the restored state and gated. A request for any other version is refused with this code, with the message "the hermes state was restored for X, which was never seen up on it", because the newer state is only in `post-*`. Getting that state back is manual.

   If a swap was interrupted, the box resumes it on its own, every 10 minutes while it is held, except after `HERMES_ROLLBACK_FAILED` or `HERMES_RESTORE_FAILED`. It resumes a held swap once: if hermeticd stops again during that resume (a reboot, or hermeticd itself OOM-killed), the next apply rolls back to 0.21.5 without rebuilding and reports `HERMES_UPGRADE_ROLLED_BACK`, with the cause "hermeticd stopped during the held swap … 2 times". A build the kernel OOM-kills fails as a command (exit 137) and rolls back at once: `hermeticd.service` and `hermeticd-bootstrap.service` run with `OOMPolicy=continue` (drop-in `hermetic-oom.conf` in each unit's `.d` directory, written when `hermeticd serve` starts). Any other failure keeps the new pin, and running the same `hermetic upgrade --hermes 0.23.1 <name> --now` again repairs forward once the cause is fixed (`agent rerun` only re-runs failed bootstrap stages and does not apply a pin).
7. **The copy.** It is at `/data/hermetic-backups/hermes-<old ref>-<UTC time>/` on the box, root-only, on the data volume, so a recreate keeps it and nothing deletes it. Once you are sure you will not roll back, remove it as root over `hermetic ssh <name>` (`sudo rm -rf /data/hermetic-backups/hermes-<old ref>-<UTC time>`). Directories named `post-<version>-<UTC time>` beside it hold state a rollback moved aside; they can go at the same time.
8. **Roll back.** From a build that pins 0.21.5, run `hermetic upgrade --hermes 0.21.5 <name> --now`. hermeticd restores the sealed copy taken when 0.21.5 was left, so state returns to the moment before the upgrade, and moves everything written since aside in a `post-<version>-<UTC time>` directory, then installs the 0.21.5 checkout. The downgrade is gated like an upgrade; if its gate fails the units stay held and the code is `HERMES_RESTORE_FAILED`. Without that copy it refuses with `HERMES_RESTORE_REFUSED` and changes nothing, since a newer Hermes migrates its stores and the migration cannot be reversed.

**Limits at 0.23.1.** Hermes runs with lazy installs off, so nothing is installed on demand. Not installed: the `modal`, `daytona` and `vercel` terminal sandboxes and the `matrix`, `dingtalk`, `feishu`, `wecom`, `teams` and `google-chat` platforms (hermetic offers none; on 0.21.5 they could be fetched on first use), the extras outside the preinstalled set, and MCP stdio servers launched through a bare `npx`, `uvx`, `node` or `uv` command, which this release does not provision. An absolute path to an executable may work and has not been verified. Design §6.4 lists them.

**Canary a free-tier box first.** The 0.23.1 install syncs the full extras set and builds the web UI and TUI with pnpm. On a free-tier or other small box, note the install time and disk use before upgrading others. Measured on `t4g.small` (2 vCPU, 2 GiB), three runs held Hermes for 69 to 87 seconds, of which the web build was 37 to 52 seconds and the runtime gate 45 seconds; a rollback through the gate took 48 to 57 seconds from the failure to the old Hermes being up. With the temporary swapfile the most swap used was 54 MB and available memory bottomed at about 390 MB; before it existed the same build was OOM-killed once in three runs with the browser stopped, and left running, headed Chrome (about 320 to 420 MB) got the build OOM-killed twice, and both rolled back. The pre-upgrade copy of a small home (21 files) was 1.1 MB. A fresh box's `04-apply` took 199.8 seconds in one run on the free-tier size (`t4g.small`, 1834 MB, no swap, holographic memory), with no OOM kill and no bootstrap restart: apt packages (30) 74 seconds, Chrome from the mirror 7, the Hermes checkout 8, uv and the Python environment 29, Node 4, pnpm and the workspace install 6, the web UI build 34 (heap capped at 1024 MB), the TUI 4, the memory plugin, agent venv and plugins 17, units and commands 17; `01-tailscale` took 10.6 seconds, `06-verify` 6.3 and every other stage under a second. Create to ready took 4 minutes 11 seconds, 33 seconds of it the CLI up to the handoff. The `scratch` preset (`t4g.medium`, 4 GiB) with the openviking memory provider took 228 seconds. If it fails there, `voice` is the first extra to drop from `LOCKED_EXTRAS` (`packages/agentd/src/apply/hermes.ts`).

**Small boxes are short of memory.** A `t4g.small` runs with roughly 450 to 600 MB available, which is why hermeticd pins the web build to a 1024 MB V8 heap (`NODE_OPTIONS=--max-old-space-size=1024`). For the same reason a version change stops the browser session (headed Chrome, its X display and the VNC bridge) for as long as Hermes is held, and starts it again when Hermes comes back, on the new version or after a rollback: the build was OOM-killed beside a running Chrome. Even with Hermes and the browser stopped, the build's peak varies from run to run and was once OOM-killed at 1.28 GB, so on a box with under 3 GiB of RAM and no swap, hermeticd also adds a temporary 1 GiB swapfile on the data volume (`/data/hermetic-swap/build.swap`) for the web build and removes it afterwards; the journal shows `adding 1 GiB of temporary swap for the hermes web build` and `removed the temporary swap`. It goes on the data volume because that volume is encrypted and the root disk is not, and swap can hold secrets the box keeps only in memory. The swapfile needs 2 GiB free on the data volume and is skipped, with a warning, when there is less or when `/data` is not mounted. Anyone watching the browser over VNC sees it go away for the upgrade; its profile, with cookies and logins, stays on the data volume, but pages that were open are not reopened. Upstream's `HERMES_WEB_BUILD_LIGHT=1` switch only forces one Rolldown thread and that same minimum heap; a 2-vCPU box already gets one thread by default, so the switch changes nothing on boxes of 2 GiB or less and hermeticd does not set it. If a small box goes unreachable after a failed upgrade while EC2 shows it running, reboot it with `hermetic agent reboot <name>`: one box lost its DHCP lease (`ens5: Could not set DHCPv4 address`) during memory thrash on an attempt made before the heap cap existed, and became unreachable when the one-hour lease expired.

## Stop / start / recreate / destroy semantics

| Command | What happens | Volume |
|---|---|---|
| `agent stop <name>` | EC2 `StopInstances`; heartbeat stops, status → `stopped` | kept (attached, not billed for compute) |
| `agent start <name>` | EC2 `StartInstances` on the existing instance; public IP changes (not an Elastic IP — nothing depends on it, Tailscale's address is what matters) | kept |
| `agent recreate <name> --yes` | Terminates the instance, keeps the volume, re-runs the create sequence against the same volume — a from-scratch box, same data. Clears the row's `bootstrap` and `command` (a fresh bootstrap, not a resumed one) and sets `hermeticd_version` from the fleet manifest's current pointer | kept, reattached |
| `agent destroy <name> --yes [--keep-volume]` | Terminates the instance, deletes its tailnet devices, SSM parameters and S3 config, deletes the data volume, waits for the instance to reach `terminated`, then releases the name: a tombstone is written and the agent row is deleted. Events are never deleted. The name is reusable at once, and a `create` of it is a brand-new agent. | **deleted by default** — pass `--keep-volume` to keep it. A kept volume is released from the name (`agent=<name>` becomes `hermetic:former_agent=<name>`), so a later `create` of the same name starts on a fresh disk; hand the old one over on purpose with `agent create <name> --volume vol-…` |

`recreate` and `destroy` both refuse without `--yes` (`CONFIRMATION_REQUIRED`) and both go through `plan.recreate`/`plan.destroy` first if you want to see the steps before committing — `hermetic plan` prints what a destructive command would do without doing it. `plan destroy` takes the same `--keep-volume`, and its volume step reads `delete` or `keep` accordingly.

Destroy waits for the instance to be `terminated` before it releases the name, and the wait has no time limit; a slow EC2 termination shows as the `instance` phase sitting there, with the agent's lock renewed, and finishes when EC2 does. A destroy that died partway is finished by running it again.

### Reviewing destroyed agents

A destroyed agent has no row, so it is absent from `agent ps` and the dashboard's Agents lens. `hermetic agent destroyed [name] [--limit <n>] [--json]` lists what was destroyed, newest first: when, by whom, how long it lived, and whether its volume was kept or deleted (with the id). The dashboard's **Destroyed** lens, beside Agents and Volumes, shows the same table; a row opens a read-only panel with that incarnation's history. When a name has been reused, `hermetic agent history <name>` shows every incarnation back to back — pass a tombstone's `created_at` and `destroyed_at` (`agent destroyed <name> --json`) as `--since`/`--until` to read one life alone. Agents destroyed before tombstones existed appear as `legacy` entries; running `agent destroy <name>` (or `agent create <name>`) on one releases it, and its volume, if it still names one, is kept and released from the name, never deleted. A kept volume shows in `hermetic volume ls` under `no_agent`, *retained by* the former agent's name.

## Teardown

Deletes the whole CloudFormation foundation (VPC, subnets, security group, IAM role, S3 bucket, DynamoDB tables, event history) — a one-way door for the fleet's shared infrastructure, not for any individual agent's data (agents must already be gone before this runs).

### Prerequisite: destroy every agent first

Teardown's first phase, `agents_check`, throws `AGENTS_EXIST` if any agent row is left (a legacy `destroyed` row does not count). Run `hermetic agent destroy <name> --yes` for each agent — it deletes the agent's EBS volume unless you pass `--keep-volume`, and a kept one is what `--delete-volumes` below sweeps — before touching teardown at all; there is no flag that skips this check.

### See the plan first

```
hermetic plan teardown [--no-purge] [--delete-snapshots] [--delete-volumes] [--no-reset-local]
```

Prints the same phases teardown will run and, separately, the checklist of things it will *not* do — see below. This is read-only: it takes none of the confirmation flags and mutates nothing.

### Flags and their consequences

```
hermetic teardown --yes [--confirm-account-id <12 digits>] \
  [--no-purge] [--delete-snapshots] [--delete-volumes] [--no-reset-local]
```

| Flag | Default | Consequence |
|---|---|---|
| `--yes` | required | gates the destructive command at all (`assertConfirmable`); does **not** by itself stand in for the account-id confirmation below |
| `--no-purge` | purge on | skip deleting the SSM parameters under `/hermetic/` and `/hermes/` |
| `--delete-snapshots` | off | also delete DLM snapshots tagged `hermetic:role=data` |
| `--delete-volumes` | off | also delete leftover EBS volumes tagged `hermetic:managed=true` — **destroys any agent memory/skills left on them**, i.e. the volumes of agents destroyed with `--keep-volume` (and of any destroyed before delete became the default) |
| `--no-reset-local` | reset on | keep this home's frozen `config` row instead of clearing it back to uninitialized; the local run log is archived either way |
| `--confirm-account-id <digits>` | none | supplies the typed-confirmation value non-interactively; without it, an interactive terminal prompts for the twelve digits, and a non-interactive one fails `CONFIRMATION_REQUIRED` |

### The typed confirmation

Teardown confirms the same way `init --reset` does: the frozen account's twelve-digit id, typed back, never a bare `y`. `hermetic teardown --yes` alone in a script still fails — pass `--confirm-account-id`. `hermetic apply <teardown-plan.json>` goes through the identical ceremony: applying a `kind: "teardown"` plan requires `--confirm-account-id` too, and core independently re-checks the digits against the frozen config before doing anything.

```
hermetic teardown --yes                          # interactive: type the account id
hermetic teardown --yes --confirm-account-id 123456789012
hermetic teardown --yes --no-reset-local          # keep this home frozen after teardown
```

### Phases

`agents_check → bucket (empty the versioned S3 bucket, required before CloudFormation will delete it) → stack (DeleteStack, waits for DELETE_COMPLETE) → tailscale (take hermetic's `// hermetic:managed` blocks back out of the tailnet policy) → ssm (if purge) → snapshots (if --delete-snapshots) → volumes (if --delete-volumes) → local (if reset_local) → done`. `tailscale` comes before `ssm` because `--purge` deletes the OAuth secret that write authenticates with, and it can never fail the teardown: a policy hermetic cannot read or write goes back on the manual list below. The `stack` phase emits progress events on a timer while it waits, so a long delete (CloudFormation can legitimately take many minutes) doesn't look hung.

### What stays manual afterwards

Printed as warnings on every plan and on the final `done` event, and always present regardless of flags — hermetic has no API for any of these:

- The Tailscale OAuth client itself — delete it by hand in the Tailscale admin console.
- Any devices still listed on the tailnet.
- The `tagOwners` line you pasted, and — only when the OAuth client could not write the policy file — hermetic's own `ssh` and `acls` entries. With the `policy_file` scope the `tailscale` phase removes those two itself and the receipt says so; without it they are listed here with the reason.

### Recovering from a partial teardown / `DELETE_FAILED`

If `DeleteStack` reports `DELETE_FAILED`, teardown throws an `INTERNAL` error carrying the AWS status reason — resolve whatever CloudFormation is stuck on (a resource it can't delete, usually) and re-run `hermetic teardown` with the same flags. A retry after the stack (and its DynamoDB tables) is already gone is also safe: `agents_check` tolerates the `agents` table not existing at all and treats that as "nothing left to check," so a teardown that got as far as deleting the stack but was interrupted before `local` can simply be re-run to finish the remaining phases.

### `init` while a teardown is mid-flight

The app refuses `init` (and every other mutating request, including a second teardown) with `CONFLICT — teardown in progress` for as long as a teardown op is running, including the moment after `DELETE_COMPLETE` while it is still swapping itself back to uninitialized. There is no way to race a fresh `init` against an in-progress `DELETE_IN_PROGRESS` stack — wait for the op to finish (or fail) and retry.

## Using the dashboard

The Settings view (`,` shortcut or the header's `SETTINGS →` button, `#settings` in the URL) covers the same ground as this runbook from the app: an **Account** panel with the frozen config and a `RUN DOCTOR` button, **Fleet defaults**, **Local** (the run log), and a **DANGER** block that opens the teardown drawer. The drawer walks Review (the live plan plus the same four option checkboxes) → Confirm (both the twelve-digit account id *and* the literal word `teardown`, typed) → Progress (the same phase list, streamed), then falls back to the wizard on its own once `meta.get` reports `initialized: false`. Full visual/behavioral spec: [`docs/ui-brief.md`](ui-brief.md#settings).

### Files and agent requests

Publish this release with `hermetic artifacts push` before relying on file requests from an existing box. Check that the box has updated hermeticd; an older box cannot answer the new files routes. The Hermes files plugin is deployed with the agent configuration and may replace an operator's prior plugin of the same name. Review that plugin before rollout if the box has local customizations.

The app's chat attachment tray and the agent's Files tab handle ordinary files. `hermetic files ls <agent> --requests` lists open requests from the CLI; answer one with `hermetic files put <agent> <path> --request <fr_id>` or decline with `hermetic files decline <agent> <fr_id>`. A text secret goes through standard input, for example `pbpaste | hermetic files put <agent> --request <fr_id> --secret-stdin`; the app sends a text secret in one bounded upload of at most 64 KiB. Secrets requested as durable are stored in SSM and materialized on the box; `--ephemeral` supplies one for an hour in tmpfs instead. `hermetic files rm <agent> <id>` plans removal and, for a durable secret, deletes its SSM slot. The agent must request it again after removal.

File routes are restricted to tailnet members and may additionally require the `hermetic.dev/cap/files` capability. If you enable that gate with `hermetic settings set --files-require-cap on`, add the grant to your own tailnet policy first; hermetic does not write grants. Without the grant, all file routes return 403. To roll back the binary, run `hermetic artifacts push` from the previous committed checkout or supply its binary with `HERMETIC_HERMETICD`, then request rollout as usual. An in-flight upload must be retried after a release change.

## Recovery scenarios

- **Laptop lost or replaced.** Nothing about the fleet lives only on the laptop — `hermetic init` on a fresh machine, same profile, auto-attaches to the existing foundation stack instead of creating a new one. `~/.hermetic/hermetic.db` held only local config and the run log, both reconstructable.
- **Corrupt local database.** An unreadable `hermetic.db` is renamed aside to `hermetic.db.corrupt-<timestamp>` automatically on open, and treated as "nothing frozen yet" — `init` then re-attaches to the existing foundation the same way a new laptop would. The renamed file is left on disk for inspection, never deleted.
- **Lock held by a dead operator.** Every agent-level operation (`create`, `recreate`, `stop`, `start`, `destroy`) takes a per-agent lock with a 10-minute TTL, refreshed while the operation is in progress. If a process dies mid-operation, the lock simply expires — the next operator's call proceeds once `expires` is in the past; no manual unlock command exists or is needed.
- **`ACCOUNT_MISMATCH`.** STS returned a different account than this home's frozen `config.account_id` — including when `AWS_PROFILE` or a static `AWS_ACCESS_KEY_ID` is set in the environment and overrides the profile hermetic thinks it's using. Fix the environment/profile; hermetic will not proceed until STS agrees with the frozen account.
- **`FLEET_MISMATCH`.** STS agrees on the account, but the foundation stack's own tag disagrees with this home's `config.fleet_id` — most often two fleets in one account and the wrong `HERMETIC_HOME`. Point `HERMETIC_HOME` at the right home, or `init --reset --yes` if this home really should target the other fleet.

## Known gaps

Read before relying on any of these in production:

- After Stop on a forwarded chat turn, a send within upstream's `ws_orphan_reap_grace_s` (20 seconds) reattaches the same runtime, and the forwarded relay can deliver the stopped reply into that new turn. The stored transcript stays correct (`packages/core/src/chat/hermes/hermes-chat-turn.ts`, marked `shortcut:`).
- A chat's earlier history (Bot Chats the gateway moved aside) is found by a dashboard walk that is not narrowed by source: a box with more than 20,000 conversation sessions shows only the current root. With Hermes `sessions.auto_archive` on (hermetic never sets it), a moved-aside Bot Chat archived after three idle days drops out of the merged history. A failed walk degrades to the current root with no notice in the app. If the walk fails while the box has no current Bot Chat but does have a moved-aside one, the next send starts a new Bot Chat and the earlier one is not merged into it afterwards; its turns stay on the box.
- An agent row records its Hermes version but not its git ref, and every render uses the ref this build pins (`renderAgentRow`). Until rows record their ref, a row held on another Hermes version can only be moved with `hermetic upgrade --hermes <this build's pin> <name>`. `plan rollout` and `artifacts push` skip it, and `agent set`, a provider change and `agent recreate` refuse it with `HERMES_UPGRADE_REQUIRED` before writing anything. `upgrade --hermes <version>` to a version other than this build's pin is not refused: it pins that version and renders this build's ref, so the box refuses the config (`MANIFEST_REFUSED`). An `agent set` on a row whose upgrade rolled back unwatched also moves the row's config away from the failed request, so nothing puts the old pin back automatically.
- `bws` (Bitwarden Secrets Manager CLI) has no confirmed linux-arm64 prebuilt binary; `--secrets bitwarden` is not fully wired end to end yet.
- Hermes installs via `uv` when present on the box, falling back to the venv's own `pip` otherwise (`packages/agentd/src/apply/index.ts`) — implemented, but only exercised against `packages/agentd/test/fake-host.ts`'s in-memory `Host` double (no real root, systemd, apt, or network), never a real Ubuntu AMI boot. A real systemd-enabled container suite is future work (§11.5).
- `teardown` and `foundation update` themselves have not run against a real AWS account; those two are still exercised only against `aws-sdk-client-mock` and the fixture backend.
- No test drives the shipped app bundle end to end. The page's flow tests run headless over the real RPC bind and dispatch (`packages/ui/test/flows/*.flow.test.tsx`, with `tests/rpc-refusal.test.ts` as the seam), which proves the page against the handlers but not the packaged `Hermetic.app`, its updater, or its window behaviour.
- No DynamoDB Local tests exist yet (§11.2: conditional-write races, TTL lock expiry, `LeadingKeys` scoping, and the 500-agent scan latency guard are all specified but untested against a real DynamoDB-shaped store).
- No end-to-end test in AWS exists yet (§11.7: the full `init → create → ready → upgrade → destroy → teardown` flow, including a real bootstrap-stage boot, against a dedicated test account).
