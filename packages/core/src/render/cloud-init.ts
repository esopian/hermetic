import { HermeticError } from "../errors.ts";
import { USER_DATA_JSON_PATH, UserData } from "../schema/userdata.ts";

/**
 * The cloud-init user-data script (§6.3, "runs once, ~10 lines"). It does the
 * minimum to get `hermeticd` running and then gets out of the way: write the
 * JSON blob core built, fetch the binary through the presigned URL (which
 * resolves via the S3 gateway endpoint, so the request never leaves AWS), verify
 * the SHA-256, install it, and hand over to `hermeticd bootstrap --install`,
 * which writes the oneshot unit the staged bootstrap runs under and starts it
 * (§4.1). Everything else the box needs — the tables, its SSM prefix, the
 * stages — comes from the *fleet manifest* it fetches from the bucket, so
 * user-data carries five fields and nothing that could go stale.
 *
 * The *shape* of that blob is `UserData` in `schema/userdata.ts`, which
 * `packages/agentd` parses the other end of. It used to be an interface here and
 * a second one there, kept in step by hand; one field reached only one of them,
 * and every v4 box came up wearing its v3 name. Core cannot import agentd — the
 * boundary runs one way (§3.1) — but both may import the schema, so now they do.
 */

export { USER_DATA_JSON_PATH } from "../schema/userdata.ts";
export const HERMETICD_INSTALL_PATH = "/usr/local/bin/hermeticd";
export const HEREDOC_DELIMITER = "HERMETIC_JSON";

/**
 * What core writes into the blob. The schema's type, not a restatement of it:
 * `userDataJson` below validates against the same object hermeticd parses, so a
 * blob that would not survive the trip cannot be built here in the first place.
 */
export type UserDataFields = UserData;

/**
 * The JSON blob, exactly as `hermeticd` will re-read it from disk. Always one
 * line, and asserted never to contain the here-doc delimiter — the script embeds
 * it verbatim, and a newline or a stray `HERMETIC_JSON` would truncate the file
 * the box then fails to parse.
 */
export function userDataJson(fields: UserDataFields): string {
  /**
   * Validated on the way *out*, against the schema the box validates on the way
   * in. A blob that hermeticd would refuse must never reach an instance: the
   * refusal would land eight minutes later, on a box with no operator attached,
   * as a bootstrap that cannot start.
   */
  const parsed = UserData.safeParse(fields);
  if (!parsed.success) {
    const fields_ = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))];
    throw new HermeticError(
      "INTERNAL",
      `the user-data hermetic built is not valid (${fields_.join(", ")}); nothing was launched`,
      { issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) },
    );
  }
  const json = JSON.stringify(parsed.data);
  if (json.includes("\n") || json.includes(HEREDOC_DELIMITER)) {
    throw new HermeticError(
      "INTERNAL",
      "user-data JSON must be a single line containing no here-doc delimiter",
      { fields: Object.keys(fields) },
    );
  }
  return json;
}

/**
 * @param json The exact JSON `hermeticd bootstrap` expects, embedded as a
 *   here-doc so the box never has to parse EC2 metadata twice.
 */
export function cloudInitUserData(json: string): string {
  const field = (name: string) => `sed -n 's/.*"${name}":"\\([^"]*\\)".*/\\1/p' ${USER_DATA_JSON_PATH}`;
  // No python3, no jq: a stock Ubuntu image is guaranteed neither, and this
  // script runs before a single package has been installed (§6.3).
  return `#!/bin/bash
set -euo pipefail
install -d -m 0755 "$(dirname ${USER_DATA_JSON_PATH})"
cat > ${USER_DATA_JSON_PATH} <<'${HEREDOC_DELIMITER}'
${json.trim()}
${HEREDOC_DELIMITER}
chmod 0644 ${USER_DATA_JSON_PATH}
name="$(${field("name")})"
host="$(${field("hostname")})"
url="$(${field("hermeticd_url")})"
want="$(${field("hermeticd_sha256")})"
[ -n "$name" ] && [ -n "$url" ] && [ -n "$want" ]
hostnamectl set-hostname "${"${host:-$name}"}"
curl -fsSL --retry 5 -o /tmp/hermeticd "$url"
echo "$want  /tmp/hermeticd" | sha256sum -c -
install -m 0755 /tmp/hermeticd ${HERMETICD_INSTALL_PATH}
exec ${HERMETICD_INSTALL_PATH} bootstrap --install
`;
}
