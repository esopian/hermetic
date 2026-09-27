/**
 * Every failure core can produce carries one of these codes. The CLI maps
 * codes to exit statuses; the server maps them to HTTP statuses. Adding a
 * failure mode means adding a code here first; `schema/errors.ts` builds the
 * Zod enum from this list.
 *
 * Pure values only — no Zod, no `node:*`, nothing that opens a file or a
 * socket — because `shared/index.ts` re-exports from here into the browser and
 * the box. The Zod schemas that validate these shapes live in `schema/*`, which
 * imports this module, never the reverse (`packages/core/test/shared-browser-safe.test.ts`).
 */

export const ERROR_CODES = [
  "ACCOUNT_MISMATCH",
  "FLEET_MISMATCH",
  "NOT_INITIALIZED",
  "NAME_INVALID",
  "NAME_TAKEN",
  "NOT_FOUND",
  "CONFLICT",
  /**
   * A reviewed plan is no longer true: the agent row moved between the plan
   * being made and the plan being applied (§6.7). Its own code rather than
   * `CONFLICT` because a head has to tell it apart from every other refusal.
   * `CONFLICT` covers a lock race, a volume reservation, a teardown or a
   * foundation update already running — none of which a fresh plan fixes — so a
   * head that re-planned on `CONFLICT` would put the operator on a treadmill
   * against a busy fleet, reading the wrong explanation. `PLAN_STALE` means
   * exactly one thing, and the remedy is exactly one thing: read the plan
   * again. `details.moved` names what changed.
   */
  "PLAN_STALE",
  "LOCKED",
  "INVALID_TRANSITION",
  "CONFIRMATION_REQUIRED",
  "AGENTS_EXIST",
  "SG_INBOUND_RULE",
  "SECRETS_DISABLED",
  /**
   * The laptop running `init` is not on a tailnet, so the foundation it is
   * about to create would be unreachable by its own operator (§1, §4.7).
   */
  "TAILSCALE_UNAVAILABLE",
  /** No usable `hermeticd` binary to push: not shipped, not buildable, or the wrong version (§3.6). */
  "HERMETICD_UNAVAILABLE",
  /**
   * The fleet manifest in the bucket records something no reader may act on: an
   * object key outside the release it claims to publish (§3.6).
   *
   * The manifest is the one document the laptop writes and the box obeys, so a
   * key in it is an instruction. A key naming `config/*` or `hermes/*` would
   * have hermeticd run another agent's config tarball as a bootstrap stage, or
   * have `create` mint a one-hour bearer URL for it into a booting instance's
   * user-data. Core refuses it when it reads the manifest (`readFleetManifest`)
   * and hermeticd refuses it again on the box, where the same refusal carries
   * this code's name as an `AgentdError` — deliberately, so an operator reading
   * either log sees one name for one failure.
   *
   * Not a `VALIDATION`: the document parses and the shapes are right. What is
   * wrong is the fleet's published state, and the remedy is to republish it.
   */
  "MANIFEST_REFUSED",
  /**
   * The fleet's foundation is on a *newer* contract than this build of hermetic
   * knows (§6.6). Applying this build's template over it would undo whatever the
   * newer one added, so `init --attach` and `foundation.update` both refuse and
   * ask for the tool to be upgraded instead.
   */
  "FOUNDATION_NEWER",
  /**
   * The change set CloudFormation produced would *replace* a stateful resource —
   * a DynamoDB table or the fleet bucket — which would destroy the fleet's
   * records to update its foundation. There is no override flag: the change set
   * is deleted and the operator is told which resources.
   */
  "FOUNDATION_UNSAFE",
  /** The foundation stack update itself failed or rolled back (§6.6 step 3). */
  "FOUNDATION_UPDATE_FAILED",
  /**
   * The `Network` change set of `apply` kind `network` failed, rolled back, or
   * could not be computed (§5). Its own code rather than
   * `FOUNDATION_UPDATE_FAILED` because the two operations fail for different
   * reasons and are recovered from differently: a failed update is re-run once
   * the template is fixed, while a failed re-network leaves a fleet whose
   * routing may be half-moved and whose `_fleet.network` was never stamped.
   */
  "NETWORK_UPDATE_FAILED",
  /**
   * The named volume is attached to an instance. `agent create --volume` will
   * not steal a disk another box is reading, and `volume delete` will not
   * delete one — either would be guessing about whose memory it is (§1).
   */
  "VOLUME_IN_USE",
  /**
   * The named volume exists but cannot be used for what was asked: hermetic did
   * not create it (no `hermetic:managed` tag), it lives in an availability zone
   * the fleet does not launch into, or EC2 reports it in a state that is
   * neither attachable nor deletable.
   */
  "VOLUME_UNUSABLE",
  /**
   * The agent row names a data volume EC2 no longer has (§6.5). `recreate`
   * refuses rather than creating a fresh disk in its place: an empty volume
   * under the same row would report success on "the same volume" while the
   * agent's memory — the thing §1 calls precious — was silently left behind or
   * gone. The remedy is the operator's to choose, so the message names the
   * missing id and the commands that find or replace the disk.
   */
  "VOLUME_MISSING",
  /**
   * The instance or volume an agent row named is not tagged as that agent's, in
   * this fleet, by hermetic (§6.7). The row is writable by the box it describes,
   * so a recorded id is a hint rather than proof of ownership; `destroy` and
   * `recreate` resolve the resource and read its tags before terminating or
   * deleting it. A mismatch refuses and moves nothing — neither the resource nor
   * the row — because the id may well be somebody else's live box or disk.
   */
  "RESOURCE_NOT_OWNED",
  /**
   * More than one fleet is frozen in this home and nothing said which one to
   * use — no `--fleet`, no `HERMETIC_FLEET`, no default (§4.8). hermetic does
   * not guess which fleet a command was meant for; picking wrong is how an
   * agent gets destroyed in the fleet nobody was looking at.
   */
  "FLEET_REQUIRED",
  /**
   * The account-global fleet directory table could not be reached, created, or
   * read (§4.8). `init` refuses before it creates anything — a fleet that never
   * reaches the directory is a fleet the next laptop cannot find.
   */
  "DIRECTORY_UNAVAILABLE",
  /** The caller is authenticated but not permitted — heads map it to 403. */
  "FORBIDDEN",
  /**
   * The checkout a release would be pushed from has uncommitted changes (§3.6).
   *
   * The release's identity is `build_number` — `git rev-list --count HEAD` —
   * which counts commits and therefore does not move for an edit that was never
   * committed. Publishing from a dirty tree would put contents the operator
   * changed under a number that already describes a different tree, and nobody
   * could rebuild what the fleet ended up running. `HERMETIC_ALLOW_DIRTY=1`
   * overrides, knowingly.
   */
  "WORKING_TREE_DIRTY",
  /**
   * A model provider's catalog endpoint could not be reached, timed out, or
   * answered 5xx (§8.3). Never carries the key that was presented.
   */
  "PROVIDER_UNREACHABLE",
  /** The provider refused the credential (401/403). The key itself never travels. */
  "PROVIDER_AUTH",
  /** The provider answered, but not with a model catalog this build can read. */
  "PROVIDER_MALFORMED",
  /**
   * A bare `--provider` names more than one ready profile and nothing said
   * which (§8.3). hermetic does not pick a credential on an operator's behalf.
   */
  "AMBIGUOUS_PROFILE",
  /** The profile is still bound to agents, so deleting it would unkey them (§8.3). */
  "PROFILE_IN_USE",
  /**
   * The Bedrock model a profile or an agent selects is not in the grant the
   * foundation stack gave this fleet's instance role (§8.3). Never substituted
   * for another model — the operator runs `hermetic foundation update`.
   */
  "MODEL_NOT_GRANTED",
  /**
   * The box's Hermes dashboard could not be reached for a chat turn (§9.2):
   * the laptop is off the tailnet, the instance is stopped, or Hermes is
   * not listening. Distinguished from the codes below because it is the one an
   * operator can usually fix themselves, and the one the UI's offline state
   * renders rather than an error.
   */
  "CHAT_UNREACHABLE",
  /**
   * The dashboard answered, but its SPA HTML carried no session token to scrape
   * (§7.4). Either the page shape moved on a `hermes_ref` bump or
   * something other than Hermes is answering on that port. Never carries the
   * HTML it failed to parse — that page is where the token would have been.
   */
  "CHAT_NO_TOKEN",
  /**
   * A frame arrived that this build cannot read at all: not JSON, not JSON-RPC,
   * or an error object with no code. An *unrecognised* tool or event is not
   * this — that is the `unknown` block, which is the contract (§9.2). This code
   * is for the transport itself being wrong.
   */
  "CHAT_PROTOCOL",
  /**
   * No warm bot backend became available inside the deadline (§9.2).
   * Upstream keeps ~3 warm per gateway and fails an open after 30 seconds; on
   * thirteen unattended boxes that is a dead click, so the wait is surfaced as
   * a frame from the first second and only becomes this code at the end of it.
   */
  "CHAT_NO_SLOT",
  /**
   * The turn reached the agent and the agent failed it — the model refused, the
   * provider errored, a tool died. The transport worked; the conversation did
   * not. Kept separate from the four above so a head can tell "your fleet is
   * unreachable" from "your agent said no".
   */
  "CHAT_TURN_FAILED",
  /**
   * The pinned Chrome for Testing build the CDN served does not match the
   * length and digest this build of hermetic pins (§7.3). Nothing is uploaded:
   * the bytes a fleet's agents would execute are not the bytes this checkout
   * was reviewed against, and no retry makes that true.
   */
  "BROWSER_MIRROR_MISMATCH",
  /**
   * A `browser: true` agent was asked for on a fleet whose foundation predates
   * v14, which is the version that grants the box read on the mirrored browser
   * (§7.3). Refused on the laptop rather than left to fail as a 403 in the
   * bootstrap stage, minutes into a first boot nobody is watching.
   */
  "BROWSER_NEEDS_FOUNDATION_UPDATE",
  /** Input failed schema validation at the boundary — heads map it to 400. */
  "VALIDATION",
  "UNSUPPORTED",
  "ABORTED",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
