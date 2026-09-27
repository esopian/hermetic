/**
 * Nothing hermeticd records — a command log, an error's `detail`, a progress
 * line — may carry a secret value (§8.3). Secrets reach subprocesses through the
 * environment or stdin, never argv; this module is the second line of defence
 * for the cases where one leaks in anyway.
 */

/**
 * Credential shapes hermetic can actually encounter on an instance.
 *
 * Every pattern here must match a *whole* credential, not its first segment: a
 * partial match is worse than no match, because it leaves the secret half in
 * the log while looking like the redaction worked. Real tailnet keys are
 * `tskey-<kind>-<keyID>-<secret>`, and Bitwarden machine tokens end in a
 * base64url payload that itself contains `-` and `_`.
 */
export const SECRET_SHAPES: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "tailscale auth key", re: /\btskey-[a-z]+-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/ },
  { label: "bitwarden access token", re: /\b0\.[0-9a-f-]{36}\.[A-Za-z0-9+/=_-]{20,}/ },
  { label: "aws access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  // The model providers, most specific first, so a redaction is labelled with
  // what it actually was. §8.1 puts one of these in every agent's own SSM slot,
  // which means `apply` and the `04-apply` stage both handle one on every boot.
  { label: "anthropic api key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: "openrouter api key", re: /\bsk-or-v1-[A-Za-z0-9]{20,}/ },
  { label: "provider api key", re: /\bsk-[A-Za-z0-9_-]{24,}/ },
  { label: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  /**
   * The last resort, and the only pattern here that does not know what it is
   * looking at.
   *
   * Every shape above is a credential hermetic itself hands to a box. The one
   * this catches is the credential hermetic never sees: an operator's own
   * Bitwarden entry, materialised into `secrets.env` by `bws` and named
   * whatever they called it, riding out in a failed command's stderr. A closed
   * pattern set has nothing to say about that value, and "we did not recognise
   * it" is not a reason to write it to a journal that `GET /logs` ships.
   *
   * What counts as a token here: 32 or more characters from the base64url
   * alphabet, containing upper case, lower case *and* a digit, optionally split
   * into dot-separated segments — and never containing `/`.
   *
   *  - **Dots are part of the run, and the 32 applies to the whole run.** A JWT
   *    is three base64url segments joined by dots and its middle segment is the
   *    payload; matching segment-by-segment would redact the header and leave
   *    the claims, which is the half-redaction this module's own header warns
   *    against. `id_token=<jwt>` goes entirely.
   *  - **`/` is not.** Otherwise a long path is one run and disappears whole,
   *    and a log that says «redacted» where the filename was is a log nobody
   *    can debug from. Splitting on `/` leaves every path segment far short of
   *    32. A token *inside* a URL path still matches, because the run simply
   *    starts after the slash.
   *  - **`=` only as trailing padding**, never inside: `SOME_KEY=<token>` is two
   *    things, and swallowing the name with the value takes the one word that
   *    says which variable leaked.
   *
   * The mixed-case-plus-digit test is what keeps hermeticd's own output
   * readable: a sha256 digest is lower-case hex (no upper case, so it survives
   * — and `CHECKSUM_MISMATCH` needs it to), an instance or volume id is
   * lower-case and short, an ISO timestamp has no lower case, a bucket name has
   * no upper case.
   *
   * Accepted false positives: a long mixed-case-with-digits identifier that is
   * not a secret — an S3 version id, a base64 blob quoted in an error — is
   * redacted anyway. That trade is taken knowingly: this pattern runs last, on
   * output that has already failed, and losing an id is recoverable in a way
   * that leaking a token is not (§8.3).
   */
  {
    label: "high-entropy token",
    re: /(?<![A-Za-z0-9+._-])(?=[A-Za-z0-9+._-]{32,})(?=[A-Za-z0-9+._-]*[a-z])(?=[A-Za-z0-9+._-]*[A-Z])(?=[A-Za-z0-9+._-]*[0-9])[A-Za-z0-9+_-]+(?:\.[A-Za-z0-9+_-]+)*={0,2}(?![A-Za-z0-9+._-])/,
  },
];

export const REDACTED = "«redacted»";

/** Environment variables whose value is always a secret, whatever it looks like. */
const SECRET_ENV_KEYS = /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|AUTHKEY)$/i;

export function looksSecret(value: string): boolean {
  return SECRET_SHAPES.some(({ re }) => re.test(value));
}

/** Replace any secret-shaped substring, keeping the rest of the token readable. */
export function redactValue(value: string): string {
  let out = value;
  for (const { re } of SECRET_SHAPES) {
    out = out.replace(
      new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"),
      REDACTED,
    );
  }
  return out;
}

/**
 * Redact an argv before it is recorded. A `--flag=<secret>` keeps its flag name
 * so the log still says what ran, and loses the value.
 */
export function redactArgv(argv: readonly string[]): string[] {
  return argv.map((token) => {
    const eq = token.indexOf("=");
    if (token.startsWith("--") && eq !== -1) {
      const flag = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (looksSecret(value) || SECRET_ENV_KEYS.test(flag.replace(/^--/, "").replace(/-/g, "_"))) {
        return `${flag}=${REDACTED}`;
      }
      return `${flag}=${redactValue(value)}`;
    }
    return redactValue(token);
  });
}

/** Environment keys only; values are never recorded. */
export function redactEnv(env: Readonly<Record<string, string>> | undefined): string[] {
  return Object.keys(env ?? {}).sort();
}
