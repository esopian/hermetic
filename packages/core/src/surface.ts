import {
  ChatOpenInput as ChatOpenInputSchema,
  ChatCompactInput as ChatCompactInputSchema,
  ChatArchiveInput as ChatArchiveInputSchema,
  ChatRespondInput as ChatRespondInputSchema,
  BotCapabilitiesInput as BotCapabilitiesInputSchema,
  BotProfileInput as BotProfileInputSchema,
  BotCreateInput as BotCreateInputSchema,
  BotUpdateInput as BotUpdateInputSchema,
  BotDeleteInput as BotDeleteInputSchema,
  RoomsListInput as RoomsListInputSchema,
  RoomGetInput as RoomGetInputSchema,
  RoomCreateInput as RoomCreateInputSchema,
  RoomRenameInput as RoomRenameInputSchema,
  RoomDeleteInput as RoomDeleteInputSchema,
  RoomHistoryInput as RoomHistoryInputSchema,
  RoomSendInput as RoomSendInputSchema,
  RoomControlInput as RoomControlInputSchema,
  RoomRespondInput as RoomRespondInputSchema,
  RoutinesListInput as RoutinesListInputSchema,
  RoutineCreateInput as RoutineCreateInputSchema,
  RoutineUpdateInput as RoutineUpdateInputSchema,
  RoutineDeleteInput as RoutineDeleteInputSchema,
  RoutineRunInput as RoutineRunInputSchema,
  RoutineHistoryInput as RoutineHistoryInputSchema,
} from "./schema/index.ts";
/**
 * The command surface itself: which dotted methods exist, which of them stream,
 * what each validates its input against, and the two functions that decide what
 * a head is allowed to print or record about a call.
 *
 * Separate from `hermetic.ts` because it is a *declaration*, not an
 * implementation. `tests/parity.test.ts` reads these three tables and compares
 * them against what the CLI and the server registered as they built themselves;
 * keeping them in the module that also holds two thousand lines of lifecycle
 * code made the contract harder to find than the code it constrains.
 */
import {
  AgentRefInput as AgentRefInputSchema,
  ApplyInput as ApplyInputSchema,
  ArtifactsPushApiInput as ArtifactsPushApiInputSchema,
  ArtifactsPushInput as ArtifactsPushInputSchema,
  ChatListeningInput as ChatListeningInputSchema,
  ChatListenInput as ChatListenInputSchema,
  ChatAbortInput as ChatAbortInputSchema,
  ChatHistoryInput as ChatHistoryInputSchema,
  ChatObserveInput as ChatObserveInputSchema,
  ChatSendInput as ChatSendInputSchema,
  ChatSessionsInput as ChatSessionsInputSchema,
  ChatSwarmsInput as ChatSwarmsInputSchema,
  ConfigShowInput as ConfigShowInputSchema,
  CreateAgentInput as CreateAgentInputSchema,
  DeleteVolumeInput as DeleteVolumeInputSchema,
  DestroyAgentInput as DestroyAgentInputSchema,
  DirectoryStatusInput as DirectoryStatusInputSchema,
  DoctorInput as DoctorInputSchema,
  FleetsListInput as FleetsListInputSchema,
  FleetsAliasInput as FleetsAliasInputSchema,
  FleetsUseInput as FleetsUseInputSchema,
  FoundationStatusInput as FoundationStatusInputSchema,
  FoundationUpdateInput as FoundationUpdateInputSchema,
  HistoryInput as HistoryInputSchema,
  InitInput as InitInputSchema,
  ListAgentsInput as ListAgentsInputSchema,
  ListVolumesInput as ListVolumesInputSchema,
  NetworkStatusInput as NetworkStatusInputSchema,
  LogsInput as LogsInputSchema,
  NotificationsAckInput as NotificationsAckInputSchema,
  NotificationsListInput as NotificationsListInputSchema,
  NotificationsMuteInput as NotificationsMuteInputSchema,
  PresetsGetInput as PresetsGetInputSchema,
  PresetsSetInput as PresetsSetInputSchema,
  PlanDestroyInput as PlanDestroyInputSchema,
  PlanFoundationInput as PlanFoundationInputSchema,
  PlanNetworkInput as PlanNetworkInputSchema,
  PlanPolicyInput as PlanPolicyInputSchema,
  PlanRolloutInput as PlanRolloutInputSchema,
  PlanRecreateInput as PlanRecreateInputSchema,
  PlanTeardownInput as PlanTeardownInputSchema,
  PolicyStatusInput as PolicyStatusInputSchema,
  ProvidersCreateInput as ProvidersCreateInputSchema,
  ProvidersDeleteInput as ProvidersDeleteInputSchema,
  ProvidersListInput as ProvidersListInputSchema,
  ProvidersModelsInput as ProvidersModelsInputSchema,
  ProvidersUpdateInput as ProvidersUpdateInputSchema,
  RecreateAgentInput as RecreateAgentInputSchema,
  RerunInput as RerunInputSchema,
  RunsListInput as RunsListInputSchema,
  SecretsDeleteInput as SecretsDeleteInputSchema,
  SecretsListInput as SecretsListInputSchema,
  SecretsPushInput as SecretsPushInputSchema,
  SecretsVerifyInput as SecretsVerifyInputSchema,
  SetAgentInput as SetAgentInputSchema,
  SettingsGetInput as SettingsGetInputSchema,
  SettingsSetInput as SettingsSetInputSchema,
  SshInput as SshInputSchema,
  TeardownInput as TeardownInputSchema,
  TeardownsListInput as TeardownsListInputSchema,
  UpgradeInput as UpgradeInputSchema,
  VolumeRefInput as VolumeRefInputSchema,
} from "./schema/index.ts";
import type {
  CreateAgentInput,
  InitInput,
  LocalConfig,
  ProvidersCreateInput,
  ProvidersModelsInput,
  ProvidersUpdateInput,
  SecretsPushInput,
} from "./schema/index.ts";

/**
 * The parity contract (§3.2 rule 4). Every dotted path here has exactly one CLI
 * command and one Hono route; `tests/parity.test.ts` fails the build on drift.
 */
export const PUBLIC_METHODS = [
  "chat.open",
  "chat.compact",
  "chat.archive",
  "chat.respond",
  "bots.capabilities",
  "bots.get",
  "bots.create",
  "bots.update",
  "bots.delete",
  "rooms.list",
  "rooms.get",
  "rooms.create",
  "rooms.rename",
  "rooms.delete",
  "rooms.history",
  "rooms.send",
  "rooms.control",
  "rooms.respond",
  "routines.list",
  "routines.create",
  "routines.update",
  "routines.delete",
  "routines.run",
  "routines.history",

  "init",
  "config.show",
  "fleets.list",
  "fleets.use",
  "fleets.alias",
  "directory.status",
  "runs.list",
  "teardowns.list",
  // §4.9: the operator's local inbox. Three methods, all of them a read
  // or a write of the laptop's own SQLite — no AWS, so `inbox` still answers on
  // a laptop whose fleet is unreachable.
  "notifications.list",
  "notifications.ack",
  "notifications.mute",
  // §4.6: this laptop's create presets — one `prefs` row, no AWS.
  "presets.get",
  "presets.set",
  // §9.2: the chat surface — the read-and-send core the adapter
  // answers. Rooms (`rooms.*`) and `chat.respond` are part of the Bot Mode
  // surface, declared above and covered by design.md §9.2.
  "chat.listening",
  "chat.listen",
  "chat.swarms",
  "chat.sessions",
  "chat.history",
  "chat.send",
  "chat.abort",
  // §9.2: a watch on one conversation, independent of any send.
  "chat.observe",
  "artifacts.push",
  "teardown",
  "doctor",
  "foundation.status",
  "foundation.update",
  "policy.status",
  "network.status",
  "agents.create",
  "agents.list",
  "agents.get",
  "agents.set",
  "agents.stop",
  "agents.start",
  "agents.reboot",
  "agents.recreate",
  "agents.destroy",
  "agents.history",
  "agents.rerun",
  "agents.probe",
  "agents.desktop",
  "volumes.list",
  "volumes.get",
  "volumes.delete",
  "secrets.push",
  "secrets.verify",
  "secrets.list",
  "secrets.delete",
  "settings.get",
  "settings.set",
  // §8.3's provider profiles: the named credentials `agent create` picks from,
  // and the live catalog read the picker is filled from.
  "providers.list",
  "providers.create",
  "providers.update",
  "providers.delete",
  "providers.models",
  "ssh",
  "logs",
  "upgrade",
  "plan.destroy",
  "plan.recreate",
  "plan.teardown",
  "plan.foundation",
  "plan.policy",
  "plan.rollout",
  "plan.network",
  "apply",
] as const;

export type PublicMethod = (typeof PUBLIC_METHODS)[number];

/** Long operations that stream `OpEvent`s and accept an `AbortSignal`. */
export const STREAMING_METHODS: readonly PublicMethod[] = [
  "init",
  "teardown",
  "foundation.update",
  "apply",
  "upgrade",
  "agents.create",
  "agents.destroy",
  "agents.recreate",
  "agents.stop",
  "agents.start",
] as const;
/**
 * The schema each public method validates its input against (§3.3, §11.4). The
 * parity test compares these by *identity* to the schema each head validates
 * with, so a route or a command cannot quietly accept a wider shape than core
 * does. Methods that take no input map to an empty object schema rather than
 * borrowing an unrelated one.
 */
export const REQUEST_SCHEMAS = {
  "chat.open": ChatOpenInputSchema,
  "chat.compact": ChatCompactInputSchema,
  "chat.archive": ChatArchiveInputSchema,
  "chat.respond": ChatRespondInputSchema,
  "bots.capabilities": BotCapabilitiesInputSchema,
  "bots.get": BotProfileInputSchema,
  "bots.create": BotCreateInputSchema,
  "bots.update": BotUpdateInputSchema,
  "bots.delete": BotDeleteInputSchema,
  "rooms.list": RoomsListInputSchema,
  "rooms.get": RoomGetInputSchema,
  "rooms.create": RoomCreateInputSchema,
  "rooms.rename": RoomRenameInputSchema,
  "rooms.delete": RoomDeleteInputSchema,
  "rooms.history": RoomHistoryInputSchema,
  "rooms.send": RoomSendInputSchema,
  "rooms.control": RoomControlInputSchema,
  "rooms.respond": RoomRespondInputSchema,
  "routines.list": RoutinesListInputSchema,
  "routines.create": RoutineCreateInputSchema,
  "routines.update": RoutineUpdateInputSchema,
  "routines.delete": RoutineDeleteInputSchema,
  "routines.run": RoutineRunInputSchema,
  "routines.history": RoutineHistoryInputSchema,

  init: InitInputSchema,
  "config.show": ConfigShowInputSchema,
  // §4.8. The list takes nothing (there is one home and one directory), the
  // switch names the one fleet it makes default, and the directory read takes
  // nothing either — there is one table per account.
  "fleets.list": FleetsListInputSchema,
  "fleets.use": FleetsUseInputSchema,
  "fleets.alias": FleetsAliasInputSchema,
  "directory.status": DirectoryStatusInputSchema,
  "runs.list": RunsListInputSchema,
  "teardowns.list": TeardownsListInputSchema,
  // §4.9. The read is newest-first with an optional `since` for a
  // poller; the two writes each name exactly one thing, and say so by refusing
  // a request that names both.
  "notifications.list": NotificationsListInputSchema,
  "notifications.ack": NotificationsAckInputSchema,
  "notifications.mute": NotificationsMuteInputSchema,
  // §4.6. The read takes nothing (one document per laptop); the write is a
  // patch whose stated parts each replace their field, or `reset`.
  "presets.get": PresetsGetInputSchema,
  "presets.set": PresetsSetInputSchema,
  /**
   * §9.2. The roster read takes an optional instance (absent is the
   * whole fleet, which is the rail's default scope); the other four address one
   * bot on one box, because `<instance>/<bot>` is the unit.
   *
   * `chat.send` is *not* in `STREAMING_METHODS` even though it returns an
   * `AsyncIterable`: a turn is a live pipe to a process already running
   * elsewhere, not an op that can be restarted, replayed or resumed.
   */
  "chat.listening": ChatListeningInputSchema,
  "chat.listen": ChatListenInputSchema,
  "chat.swarms": ChatSwarmsInputSchema,
  "chat.sessions": ChatSessionsInputSchema,
  "chat.history": ChatHistoryInputSchema,
  "chat.send": ChatSendInputSchema,
  "chat.abort": ChatAbortInputSchema,
  /**
   * §9.2. Like `chat.send` it returns an `AsyncIterable` and like
   * `chat.send` it is *not* in `STREAMING_METHODS`: an observation is a live
   * watch on a conversation held elsewhere, and there is nothing in a registry
   * to restart, replay or resume. Unlike `chat.send` it never writes, which is
   * what makes reconnecting to it safe.
   */
  "chat.observe": ChatObserveInputSchema,
  // The HTTP surface may name a version and nothing else: a browser must not be
  // able to name a path on the server's filesystem.
  "artifacts.push": ArtifactsPushApiInputSchema,
  teardown: TeardownInputSchema,
  doctor: DoctorInputSchema,
  "foundation.status": FoundationStatusInputSchema,
  "foundation.update": FoundationUpdateInputSchema,
  // Takes nothing: there is one tailnet policy and hermetic manages three
  // blocks in it (§4.7).
  "policy.status": PolicyStatusInputSchema,
  // §5. Takes nothing: there is one fleet open at a time, and one mode on it.
  "network.status": NetworkStatusInputSchema,
  "agents.create": CreateAgentInputSchema,
  "agents.list": ListAgentsInputSchema,
  "agents.get": AgentRefInputSchema,
  "agents.set": SetAgentInputSchema,
  "agents.stop": AgentRefInputSchema,
  "agents.start": AgentRefInputSchema,
  "agents.reboot": AgentRefInputSchema,
  "agents.recreate": RecreateAgentInputSchema,
  "agents.destroy": DestroyAgentInputSchema,
  "agents.history": HistoryInputSchema,
  "agents.rerun": RerunInputSchema,
  // Name-only and read-only, so it validates the same object `agents.get` does.
  "agents.probe": AgentRefInputSchema,
  // §7.4's Desktop attach details. Name-only and read-only for the same reason.
  "agents.desktop": AgentRefInputSchema,
  "volumes.list": ListVolumesInputSchema,
  "volumes.get": VolumeRefInputSchema,
  "volumes.delete": DeleteVolumeInputSchema,
  "secrets.push": SecretsPushInputSchema,
  "secrets.verify": SecretsVerifyInputSchema,
  // One set of fleet-level slots, so the read takes nothing; the delete names
  // the one slug it removes and must carry its own confirmation (§8.2).
  "secrets.list": SecretsListInputSchema,
  "secrets.delete": SecretsDeleteInputSchema,
  // One settings object per fleet, so the read takes nothing and the write is
  // a patch over whatever version the caller read (§4.6).
  "settings.get": SettingsGetInputSchema,
  "settings.set": SettingsSetInputSchema,
  // §8.3. The read takes nothing (there is one set of profiles per fleet), the
  // three writes name the one profile they change, and the catalog read names
  // either a saved profile or a provider plus the draft key being typed.
  "providers.list": ProvidersListInputSchema,
  "providers.create": ProvidersCreateInputSchema,
  "providers.update": ProvidersUpdateInputSchema,
  "providers.delete": ProvidersDeleteInputSchema,
  "providers.models": ProvidersModelsInputSchema,
  ssh: SshInputSchema,
  logs: LogsInputSchema,
  upgrade: UpgradeInputSchema,
  "plan.destroy": PlanDestroyInputSchema,
  "plan.recreate": PlanRecreateInputSchema,
  "plan.teardown": PlanTeardownInputSchema,
  "plan.foundation": PlanFoundationInputSchema,
  "plan.policy": PlanPolicyInputSchema,
  "plan.rollout": PlanRolloutInputSchema,
  // §5: the one plan that names a mode. `apply` gains a `network` kind rather
  // than a method of its own — plan then apply, like `policy` (§3.2 rule 3).
  "plan.network": PlanNetworkInputSchema,
  apply: ApplyInputSchema,
} as const satisfies Record<PublicMethod, unknown>;

/**
 * The CLI's view of the same table. It differs in exactly one place:
 * `artifacts push` may name a local path, because the CLI runs on the laptop
 * that holds the compiled binary.
 */
export const CLI_REQUEST_SCHEMAS = {
  ...REQUEST_SCHEMAS,
  "artifacts.push": ArtifactsPushInputSchema,
} as const satisfies Record<PublicMethod, unknown>;

/**
 * The one-line header every command prints to stderr (§4.7), so `--json` on
 * stdout stays clean and the target is always visible. The UI shows the same
 * line persistently in its header bar.
 */
export function headerLine(config: LocalConfig, opts: { fixture?: boolean } = {}): string {
  const who = config.account_alias ?? config.profile;
  /**
   * §4.8: the fleet comes first, before the account. A home may hold several
   * fleets in one account, so the account no longer identifies which one a
   * command is about — and the whole point of printing this line on every
   * command is that the target is never in doubt.
   *
   * §4.6: the display alias when the fleet has one, its `fleet_id` when it does
   * not. Never blank: a fleet without an alias is not an unnamed fleet, its id
   * is simply what it is called.
   */
  const base = `▸ ${config.name ?? config.fleet_id} · ${who} · ${config.account_id} · ${config.region} · profile ${config.profile}`;
  return opts.fixture ? `${base} · FIXTURE` : base;
}

/**
 * The fields of `CreateAgentInput` that are safe to record or display. Same
 * rule as `redactInitInput`: the `runs` log stores a command's arguments, and
 * an API key typed at create time must not survive the request that carried it
 * (§8.3).
 */
export function redactCreateInput(
  input: CreateAgentInput,
): Omit<CreateAgentInput, "api_key"> & { api_key?: "(redacted)" } {
  const { api_key, ...rest } = input;
  return api_key === undefined ? rest : { ...rest, api_key: "(redacted)" };
}

/**
 * The fields of `InitInput` that are safe to record or display. §8.3: nothing is
 * logged, echoed, or written to disk on the laptop — and the `runs` log (§4.6)
 * stores a command's arguments, so a head recording an `init` invocation must
 * put this through here first rather than the raw input.
 */
export function redactInitInput(input: InitInput): Omit<InitInput, "tailscale_oauth_secret"> & {
  tailscale_oauth_secret?: "(redacted)";
} {
  const { tailscale_oauth_secret, ...rest } = input;
  return tailscale_oauth_secret === undefined
    ? rest
    : { ...rest, tailscale_oauth_secret: "(redacted)" };
}

/**
 * The fields of `SecretsPushInput` that are safe to record or display.
 *
 * One field carries every tier of §8.1 — `value` is the provider key, or the
 * machine account's `bws` token, or the fleet's Tailscale OAuth client secret,
 * or a *shared* provider key bound for `/hermetic/secrets/<slug>`, depending on
 * which flag came with it — so redacting it is the whole job; the flags
 * themselves say only *which* slot was written, which is exactly what a `runs`
 * entry (§4.6) should say.
 *
 * It exists in core because §8.3 is core's promise, not a head's. The CLI
 * redacts on its own way out, but a second head, a resumed op or a test that
 * records what it called must not have to remember to.
 */
export function redactSecretsPushInput(
  input: SecretsPushInput,
): Omit<SecretsPushInput, "value"> & { value?: "(redacted)" } {
  const { value, ...rest } = input;
  return value === undefined ? rest : { ...rest, value: "(redacted)" };
}

/**
 * The fields of the three §8.3 requests that may carry a provider key, safe to
 * record or display.
 *
 * Same rule as `redactCreateInput`: `hermetic runs` stores a command's
 * arguments in SQLite and the portal writes every request it refuses to
 * `portal.log`, so a key typed into provider setup must not survive the request
 * that carried it. It exists in core because §8.3 is core's promise, not a
 * head's.
 */
export function redactProvidersCreateInput(
  input: ProvidersCreateInput,
): Omit<ProvidersCreateInput, "api_key"> & { api_key?: "(redacted)" } {
  const { api_key, ...rest } = input;
  return api_key === undefined ? rest : { ...rest, api_key: "(redacted)" };
}

export function redactProvidersUpdateInput(
  input: ProvidersUpdateInput,
): Omit<ProvidersUpdateInput, "api_key"> & { api_key?: "(redacted)" } {
  const { api_key, ...rest } = input;
  return api_key === undefined ? rest : { ...rest, api_key: "(redacted)" };
}

export function redactProvidersModelsInput(
  input: ProvidersModelsInput,
): Omit<ProvidersModelsInput, "api_key"> & { api_key?: "(redacted)" } {
  const { api_key, ...rest } = input;
  return api_key === undefined ? rest : { ...rest, api_key: "(redacted)" };
}
