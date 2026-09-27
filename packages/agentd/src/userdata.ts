/**
 * The user-data core writes (§6.2 step 7), read back off the disk cloud-init
 * left it on: a JSON object naming the agent, the name the box should wear, the
 * fleet bucket, a one-hour presigned GET for the release generation's
 * `artifacts/<ver>/<generation>/hermeticd` (§3.6), and
 * that binary's SHA-256. Five fields, and nothing more.
 *
 * It is deliberately the *smallest* thing that lets a stock Ubuntu image become
 * a hermetic agent: a name, somewhere to look, and a verifiable way to get the
 * one binary that can do everything else. Table names, the SSM prefix and the
 * rest of the fleet's resources used to be here too; they now come from the
 * fleet manifest hermeticd fetches from the bucket on its first breath (§4.2),
 * so there is exactly one document to update when a fleet changes shape.
 *
 * It carries no value that matters: user-data is readable by anything on the
 * box and by anyone with `ec2:DescribeInstanceAttribute` (§6.3).
 * `assertNoSecrets` is the belt-and-braces check that keeps it that way, and it
 * walks the schema's own key list so a field added upstream is scanned here
 * without anyone remembering to add it.
 *
 * **The shape is core's** (`UserData` in `@hermetic/core/schema`), not a second
 * interface kept in step by hand. It was two interfaces until `hostname` reached
 * only one of them: the parse here built its result from four literals, dropped
 * the fifth key, and every foundation-v4 box joined the tailnet under its v3
 * name with nothing anywhere throwing. What is left in this file is what is
 * genuinely the box's own — where the blob lives, how to get it out of a
 * cloud-init script, the IMDS client, and the refusals in hermeticd's own error
 * vocabulary.
 */
import { USER_DATA_FIELDS, USER_DATA_OPTIONAL_FIELDS, UserData } from "@hermetic/core/schema";
import { USER_DATA_JSON_PATH } from "@hermetic/core/shared";
import { AgentdError } from "./errors.ts";
import { SECRET_SHAPES } from "./redact.ts";

// Re-exported so the rest of hermeticd (and its tests) keep one import for
// "everything about user-data", rather than each file choosing a door.
export { USER_DATA_FIELDS, USER_DATA_JSON_PATH, USER_DATA_OPTIONAL_FIELDS };
export type { UserData };

/** The presigned URL legitimately contains a signature; only its query may. */
function scannable(field: string, value: string): string {
  if (field !== "hermeticd_url") return value;
  const q = value.indexOf("?");
  return q === -1 ? value : value.slice(0, q);
}

export function assertNoSecrets(data: UserData): void {
  for (const field of [...USER_DATA_FIELDS, ...USER_DATA_OPTIONAL_FIELDS]) {
    const raw = data[field as keyof UserData];
    if (raw === undefined) continue;
    const value = scannable(field, raw);
    for (const { label, re } of SECRET_SHAPES) {
      if (re.test(value)) {
        throw new AgentdError(
          "USERDATA_INVALID",
          `user-data field ${field} looks like a ${label}; user-data carries paths, never values`,
          { field },
        );
      }
    }
  }
}

/**
 * Core's user-data is the cloud-init *script*, with the JSON in a here-doc; IMDS
 * hands back that script verbatim. Accept either the bare JSON (what
 * `/var/lib/cloud/instance/hermetic.json` holds) or the script it came in.
 */
export function extractUserDataJson(raw: string): string {
  const trimmed = raw.trim();
  // `[` too, so a JSON payload of the wrong shape reaches the shape check
  // rather than being reported as "not a hermetic script".
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

  const heredoc = /<<'HERMETIC_JSON'\r?\n([\s\S]*?)\r?\nHERMETIC_JSON/.exec(raw);
  if (heredoc?.[1]) return heredoc[1].trim();

  throw new AgentdError(
    "USERDATA_INVALID",
    `user-data is neither the hermetic JSON blob nor a cloud-init script containing it; ` +
      `read ${USER_DATA_JSON_PATH} instead, which cloud-init writes on first boot`,
    { path: USER_DATA_JSON_PATH },
  );
}

/**
 * Parse the JSON blob cloud-init wrote, through core's schema.
 *
 * Every required field is required: there is no "an older hermetic launched this
 * box" path any more, because a box whose user-data is missing one cannot find
 * its fleet at all, and pretending otherwise would point it at a default that
 * belongs to somebody else. An *optional* field that is present but malformed is
 * a refusal too — absent means a box older than the field, while empty means a
 * launch this hermetic wrote and would otherwise silently mis-name.
 *
 * Unknown keys are ignored rather than refused (the schema strips): this box
 * runs whatever hermeticd its fleet published, which may be older than the
 * laptop that launched it, and a forward-compatible addition must not be a boot
 * that never happens.
 */
export function parseUserData(raw: string): UserData {
  const text = extractUserDataJson(raw);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AgentdError("USERDATA_INVALID", "user-data is not valid JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new AgentdError("USERDATA_INVALID", "user-data is not a JSON object");
  }
  const parsed = UserData.safeParse(json);
  if (!parsed.success) {
    // One name per bad field, in the order the schema declares them, so the
    // message reads the same as the hand-rolled check it replaces.
    const bad = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "(root)")))];
    throw new AgentdError("USERDATA_INVALID", `user-data is missing or malformed: ${bad.join(", ")}`, {
      missing: bad,
    });
  }
  assertNoSecrets(parsed.data);
  return parsed.data;
}

/**
 * IMDSv2 only: a token PUT, then the GET. Behind an interface so tests inject a
 * fixture and the box is the only place a real HTTP call happens.
 */
export interface Imds {
  userData(): Promise<string>;
  region(): Promise<string>;
}

const IMDS_BASE = "http://169.254.169.254";
const TOKEN_TTL = "21600";

export function httpImds(fetchImpl: typeof fetch = fetch): Imds {
  let token: string | null = null;

  async function getToken(): Promise<string> {
    if (token) return token;
    const res = await fetchImpl(`${IMDS_BASE}/latest/api/token`, {
      method: "PUT",
      headers: { "x-aws-ec2-metadata-token-ttl-seconds": TOKEN_TTL },
    });
    if (!res.ok) {
      throw new AgentdError("IMDS_UNAVAILABLE", `IMDSv2 token request failed: ${res.status}`);
    }
    token = await res.text();
    return token;
  }

  async function get(path: string): Promise<string> {
    const res = await fetchImpl(`${IMDS_BASE}${path}`, {
      headers: { "x-aws-ec2-metadata-token": await getToken() },
    });
    if (!res.ok) {
      throw new AgentdError("IMDS_UNAVAILABLE", `IMDS ${path} failed: ${res.status}`);
    }
    return await res.text();
  }

  return {
    userData: () => get("/latest/user-data"),
    region: async () => (await get("/latest/meta-data/placement/region")).trim(),
  };
}

/** Read and parse in one step — what every subcommand starts with. */
export async function loadUserData(imds: Imds): Promise<UserData> {
  return parseUserData(await imds.userData());
}
