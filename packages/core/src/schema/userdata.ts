/**
 * The cloud-init user-data blob (§6.2 step 7 / §6.3 step 1): the one document
 * the laptop writes and the *box* reads back, and until now the only wire shape
 * in this repo with a hand-written duplicate on each side.
 *
 * That duplication had a cost, paid once already. `hostname` was added to core's
 * interface, to the cloud-init script, to hermeticd's own `UserData` interface
 * and to every consumer of it — and not to hermeticd's parse, which built its
 * result from four literals and dropped the fifth key on the floor. Nothing
 * threw. `HERMETIC_HOSTNAME` fell back to the agent name, and a foundation-v4
 * fleet went on joining the tailnet under the v3 spelling while the instance
 * tag, the row and the plan all said otherwise.
 *
 * So it lives here, in the one place both sides may import (`@hermetic/core/schema`
 * is agentd's only door, §3.1): one schema, `z.infer` on the laptop, `parse` on
 * the box, and a field that cannot be added to one half.
 *
 * **Strip, not strict.** A box runs whatever hermeticd its fleet published,
 * which may be older than the laptop that just launched it — so a field this
 * schema does not know must be *ignored*, never refused. A strict object here
 * would turn every forward-compatible addition into a fleet that cannot boot.
 * (The reverse direction is what the round-trip test in `tests/user-data.test.ts`
 * pins: everything the laptop writes, the box keeps.)
 */
import { z } from "zod";
export { USER_DATA_JSON_PATH } from "../shared/box.ts";

/**
 * Paths and a digest — never a value (§6.3). User-data is readable by anything
 * on the box and by anyone with `ec2:DescribeInstanceAttribute`, which is why
 * hermeticd re-checks every field against `SECRET_SHAPES` after parsing.
 *
 * Field shapes are deliberately no tighter than they were when this was two
 * hand-written interfaces: `min(1)` and nothing more. What broke was a *dropped
 * field*, not a lax one, and tightening (a `Sha256` regex, a `url()`) here would
 * change which error an operator sees for a blob hermetic itself never writes.
 */
export const UserData = z.object({
  /** The agent name — the key of its DynamoDB row, and its SSM slot prefix. */
  name: z.string().min(1),
  /**
   * The OS hostname, and therefore the name the node asks the tailnet for:
   * `<fleet id>-<agent>` since foundation v4 (`cloudName`), so two fleets in one
   * tailnet do not fight over one MagicDNS label.
   *
   * Optional, because a box launched before v3 carries no such field and falls
   * back to `name` — which is what that box is actually called. Optional is not
   * the same as forgiving: `min(1)` means a *present* hostname must be a real
   * one, since an empty string here is a launch this hermetic wrote and would
   * otherwise silently mis-name.
   */
  hostname: z.string().min(1).optional(),
  /**
   * The fleet bucket. hermeticd cannot read `_fleet` (its DynamoDB access is
   * `LeadingKeys`-scoped to its own row, §5.1), so user-data is what tells it
   * where the fleet manifest, the config tarballs and its own future versions
   * live. Everything else it needs comes from that manifest, which is why this
   * document is five fields and not fifteen.
   */
  bucket: z.string().min(1),
  /**
   * One-hour presigned GET for the `hermeticd` key the fleet manifest records —
   * `artifacts/<version>/<generation>/hermeticd` for any release pushed since
   * releases became immutable generations (§3.6) — resolved through the S3
   * gateway endpoint. It stays presigned because a stock Ubuntu image has no
   * request signer before hermeticd exists.
   *
   * The key comes from the manifest and is never rebuilt from the version: a
   * URL minted for a rebuilt key would point at a path a later push may have
   * moved off, which is exactly the boot failure generations exist to end.
   */
  hermeticd_url: z.string().min(1),
  /** The digest cloud-init checks the downloaded binary against, before running it. */
  hermeticd_sha256: z.string().min(1),
});
export type UserData = z.infer<typeof UserData>;

/**
 * The keys, split by whether a box could legitimately arrive without one —
 * *derived* from the schema rather than restated beside it, so the next field
 * joins both lists (and hermeticd's secret scan) by being declared above and
 * nowhere else. Restating them is precisely the habit that lost `hostname`.
 */
const KEYS = Object.keys(UserData.shape) as Array<keyof UserData>;
const isOptional = (key: keyof UserData): boolean => UserData.shape[key].safeParse(undefined).success;

/** Every field a box must have; absent or empty, it cannot find its fleet at all. */
export const USER_DATA_FIELDS: readonly string[] = KEYS.filter((k) => !isOptional(k));

/** Fields core writes that a box launched before them does not carry. */
export const USER_DATA_OPTIONAL_FIELDS: readonly string[] = KEYS.filter(isOptional);
