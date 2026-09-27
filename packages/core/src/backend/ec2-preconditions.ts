/**
 * The refusals EC2 makes, as the in-memory `Backend` has to make them.
 *
 * `MemoryBackend` is the double most of core's tests run against, so anything
 * EC2 would refuse and the double accepts is a test that passes here and fails
 * on a real account. These are the preconditions of `AttachVolume`,
 * `DeleteVolume`, `StartInstances`, `StopInstances` and `RebootInstances` as
 * the EC2 API documents them — no more: a refusal EC2 does not have would be
 * just as wrong in the other direction, failing a test that a real account
 * would pass.
 *
 * Every refusal is shaped the way `Ec2Compute` reports one. The AWS layer wraps
 * an SDK throw with `asHermeticError`, which produces `INTERNAL` carrying the
 * EC2 error name in `details.aws_error` — and that detail, not the code, is
 * what core reads: `attach.ts` retries `IncorrectState` and `VolumeInUse` and
 * gives up on anything else. A double answering `NOT_FOUND` for a volume EC2
 * has never heard of would take a different branch there than the real thing.
 *
 * Written as a module taking explicit arguments (AGENTS.md rule 5); it holds no
 * state and knows nothing about the maps `MemoryBackend` keeps.
 */
import { HermeticError } from "../errors.ts";

/** The part of an instance these preconditions read. */
export interface Ec2InstanceFacts {
  instance_id: string;
  state: string;
  /** The availability zone the instance's subnet is in. */
  az: string;
}

/** The part of a volume these preconditions read. */
export interface Ec2VolumeFacts {
  volume_id: string;
  state: string;
  /** The instance holding it, or `null` for a free volume. */
  attached_to: string | null;
  az: string;
}

/**
 * One EC2 refusal, in the shape `Ec2Compute` hands core: the operation's own
 * "could not ..." sentence, EC2's message after the colon, and the EC2 error
 * name in `aws_error`. `asHermeticError` builds exactly this from an SDK throw.
 */
function refusal(
  awsError: string,
  context: string,
  detail: string,
  details: Record<string, unknown>,
): HermeticError {
  return new HermeticError("INTERNAL", `${context}: ${detail}`, { ...details, aws_error: awsError });
}

/**
 * `AttachVolume` takes an instance that is `running` or `stopped`; anything
 * else — `pending`, `stopping`, `shutting-down`, `terminated` — is
 * `IncorrectState`. A `stopped` instance is deliberately allowed: the API
 * accepts it, so refusing it here would fail a test a real account passes.
 */
const ATTACHABLE_INSTANCE_STATES = new Set(["running", "stopped"]);

/**
 * States in which an instance can be started. EC2 answers
 * `IncorrectInstanceState` for everything else, including `stopping` — a stop
 * in flight has to finish before a start is accepted — and for `terminated`,
 * which never comes back.
 */
const STARTABLE_INSTANCE_STATES = new Set(["stopped", "running", "pending"]);

/**
 * `StopInstances` is idempotent over a box that is already off or going off,
 * and accepts one that is still coming up. `terminated` and `shutting-down` are
 * `IncorrectInstanceState`.
 */
const STOPPABLE_INSTANCE_STATES = new Set(["running", "pending", "stopping", "stopped"]);

/**
 * The preconditions of `AttachVolume`. Checked in the order EC2's own answers
 * make legible to an operator: the ids first, then the states of the two
 * resources, then the placement that no state change can fix.
 *
 * `null` for either resource is EC2 having never heard of the id, which for a
 * mutation (unlike a describe) is a throw rather than an empty answer.
 */
export function assertAttachable(
  instanceId: string,
  volumeId: string,
  instance: Ec2InstanceFacts | null,
  volume: Ec2VolumeFacts | null,
): void {
  const context = `could not attach volume ${volumeId} to ${instanceId}`;
  const where = { instanceId, volumeId };
  if (volume === null) {
    throw refusal("InvalidVolume.NotFound", context, `The volume '${volumeId}' does not exist.`, where);
  }
  if (instance === null) {
    throw refusal(
      "InvalidInstanceID.NotFound",
      context,
      `The instance ID '${instanceId}' does not exist.`,
      where,
    );
  }
  if (!ATTACHABLE_INSTANCE_STATES.has(instance.state)) {
    throw refusal(
      "IncorrectState",
      context,
      `Instance '${instanceId}' is '${instance.state}'; a volume can be attached only to a running or stopped instance.`,
      { ...where, instance_state: instance.state },
    );
  }
  /**
   * A volume already on an instance — this one included. EC2 refuses a second
   * attach of a disk it has already handed out; only a Multi-Attach io1/io2
   * volume is exempt, and every volume hermetic creates is gp3 (§7.1).
   */
  if (volume.attached_to !== null) {
    throw refusal(
      "VolumeInUse",
      context,
      `vol ${volumeId} is already attached to an instance (${volume.attached_to}).`,
      { ...where, attached_to: volume.attached_to },
    );
  }
  if (volume.state !== "available") {
    throw refusal("IncorrectState", context, `${volumeId} is not 'available'.`, {
      ...where,
      volume_state: volume.state,
    });
  }
  /**
   * EBS is zonal: a volume can only ever be attached inside its own
   * availability zone, and no waiting changes that. `attach.ts` retries a
   * refusal it does not recognise, so the double has to name this one
   * correctly or a zone mistake would look like a transient to the retry loop.
   */
  if (volume.az !== instance.az) {
    throw refusal(
      "InvalidVolume.ZoneMismatch",
      context,
      `The volume '${volumeId}' is in availability zone ${volume.az} and the instance '${instanceId}' is in ${instance.az}.`,
      { ...where, volume_az: volume.az, instance_az: instance.az },
    );
  }
}

/**
 * `DeleteVolume` needs the volume free. A volume still attached — including one
 * detaching from an instance terminated a moment ago — is `VolumeInUse`, which
 * `attach.ts`'s `waitVolumeReleased` exists to wait out (§6.6).
 *
 * A volume EC2 has never heard of is *not* handled here: `Ec2Compute.deleteVolume`
 * swallows `InvalidVolume.NotFound` because a re-run of an interrupted destroy
 * must not die on the step the first run completed.
 */
export function assertVolumeDeletable(volume: Ec2VolumeFacts): void {
  if (volume.attached_to === null) return;
  throw refusal(
    "VolumeInUse",
    `could not delete volume ${volume.volume_id}`,
    `Volume ${volume.volume_id} is currently attached to ${volume.attached_to}.`,
    { volume_id: volume.volume_id, attached_to: volume.attached_to },
  );
}

/**
 * The state gate the three instance verbs share. EC2 answers
 * `InvalidInstanceID.NotFound` for an id it does not know and
 * `IncorrectInstanceState` for one it knows in the wrong state.
 *
 * `terminate` does not go through this: `Ec2Compute.terminate` reads "never
 * heard of it" as success, because an instance EC2 has forgotten is terminated,
 * which is the goal.
 */
function assertInstanceState(
  verb: string,
  action: string,
  allowed: ReadonlySet<string>,
  instanceId: string,
  instance: Ec2InstanceFacts | null,
): void {
  const context = `could not ${action} instance ${instanceId}`;
  if (instance === null) {
    throw refusal(
      "InvalidInstanceID.NotFound",
      context,
      `The instance ID '${instanceId}' does not exist.`,
      { instanceId },
    );
  }
  if (allowed.has(instance.state)) return;
  throw refusal(
    "IncorrectInstanceState",
    context,
    `The instance '${instanceId}' is '${instance.state}' and is not in a state from which it can be ${verb}.`,
    { instanceId, instance_state: instance.state },
  );
}

export function assertStartable(instanceId: string, instance: Ec2InstanceFacts | null): void {
  assertInstanceState("started", "start", STARTABLE_INSTANCE_STATES, instanceId, instance);
}

export function assertStoppable(instanceId: string, instance: Ec2InstanceFacts | null): void {
  assertInstanceState("stopped", "stop", STOPPABLE_INSTANCE_STATES, instanceId, instance);
}

/**
 * `RebootInstances` asks a *running* guest OS to restart; there is nothing to
 * ask of a box that is off, coming up or gone.
 */
export function assertRebootable(instanceId: string, instance: Ec2InstanceFacts | null): void {
  assertInstanceState("rebooted", "reboot", new Set(["running"]), instanceId, instance);
}
