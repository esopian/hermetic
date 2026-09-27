import { z } from "zod";
import { AccountId, FleetIdSchema, Iso, Region } from "./common.ts";

/**
 * The account-global fleet directory: one DynamoDB table, in one region, that
 * records every hermetic fleet in the account. It is provisioned by the SDK and
 * never by a per-fleet CloudFormation stack, because a table owned by one
 * fleet's stack would disappear the moment that fleet was torn down — taking
 * the account's index of the *other* fleets with it.
 *
 * The item shape is deliberately boring: names, ids, a status and a foundation
 * version. It is an index, not a second source of truth — `_fleet` remains
 * authoritative for anything about a fleet's insides (§4.2). What the directory
 * buys is the one question `_fleet` cannot answer without opening the fleet
 * first: *which fleets exist here at all*, and which of them are behind.
 *
 * No secret is ever written here.
 */

export const DIRECTORY_TABLE = "hermetic-directory";
export const DEFAULT_DIRECTORY_REGION = "us-east-1";
export const DIRECTORY_PITR_DAYS = 7;

export const FLEET_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
export const FleetName = z
  .string()
  .regex(
    FLEET_NAME_RE,
    "fleet name must be lowercase alphanumerics and hyphens, ≤31 chars, not starting with a hyphen",
  );
export type FleetName = z.infer<typeof FleetName>;

export const FleetDirectoryStatus = z.enum(["active", "tearing_down", "torn_down"]);
export type FleetDirectoryStatus = z.infer<typeof FleetDirectoryStatus>;

/** One directory item. pk = `name`. */
export const DirectoryEntry = z.object({
  name: FleetName.nullable().default(null),
  fleet_id: FleetIdSchema,
  account_id: AccountId,
  region: Region,
  status: FleetDirectoryStatus,
  stack_id: z.string().min(1),
  foundation_version: z.number().int().nonnegative(),
  /** hermetic build that last wrote this item. */
  hermetic_version: z.string().min(1),
  tailnet: z.string().nullable(),
  created_at: Iso,
  created_by: z.string(),
  updated_at: Iso,
  updated_by: z.string(),
  torn_down_at: Iso.nullable().optional(),
});
export type DirectoryEntry = z.infer<typeof DirectoryEntry>;

/** What `directory.status` reports about the table itself. */
export const DirectoryStatus = z.object({
  region: Region,
  table: z.string(),
  exists: z.boolean(),
  billing_mode: z.string().nullable(),
  pitr_enabled: z.boolean(),
  pitr_recovery_days: z.number().int().nullable(),
  deletion_protection: z.boolean(),
  item_count: z.number().int().nullable(),
  fleets: z.array(DirectoryEntry),
  /**
   * How many items in the table this build could not parse. A row written by a
   * newer hermetic, or half-written, is skipped rather than allowed to take the
   * whole listing down — which means the count is the only place it is visible.
   * `fleets.length + unparseable` is what the table actually holds, and a
   * non-zero value is the signal to upgrade the tool rather than to conclude a
   * fleet has vanished.
   */
  unparseable: z.number().int().nonnegative(),
});
export type DirectoryStatus = z.infer<typeof DirectoryStatus>;

/** One row of `fleets.list`: the union of what is frozen locally and what the directory knows. */
export const FleetListEntry = z.object({
  name: FleetName.nullable().default(null),
  fleet_id: FleetIdSchema.nullable(),
  account_id: AccountId.nullable(),
  region: Region.nullable(),
  /** frozen in this home's local db */
  local: z.boolean(),
  /** present in the directory */
  registered: z.boolean(),
  default: z.boolean(),
  current: z.boolean(),
  status: FleetDirectoryStatus.nullable(),
  foundation_version: z.number().int().nullable(),
  /**
   * The directory's `foundation_version` is behind this build's, and the fleet
   * is `active`. A `tearing_down` or `torn_down` fleet is never "behind": it is
   * going, and offering `foundation update` for it would be offering to update
   * something into nonexistence.
   */
  update_available: z.boolean(),
  updated_at: Iso.nullable(),
});
export type FleetListEntry = z.infer<typeof FleetListEntry>;

export const FleetsListResult = z.object({
  directory_region: Region,
  /** null when the directory was readable; otherwise the error message (list still returns local rows). */
  directory_error: z.string().nullable(),
  fleets: z.array(FleetListEntry),
});
export type FleetsListResult = z.infer<typeof FleetsListResult>;
