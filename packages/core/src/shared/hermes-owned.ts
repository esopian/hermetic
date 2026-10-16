/**
 * The keys hermetic owns in an agent's Hermes config, and the drift check over
 * them (§6.4).
 *
 * An *owned key* is a leaf hermetic set in the managed scope
 * (`/etc/hermes/config.yaml`): the provider wiring, the settings an operator
 * held with `--hold`, and hermetic's own infrastructure keys (`updates.check`,
 * `browser.*`, `platform_hints.*`). Every other key in the agent's config is
 * the agent's, including the ones hermetic seeded, and nothing here looks at
 * them.
 *
 * Shared by both sides of the seam: core derives the owned map from the file it
 * renders and records it in the manifest (`AgentConfig.hermes_owned`), and
 * hermeticd compares the file on the box against that record. One reader on
 * both sides means the two cannot disagree about what a leaf is.
 */

/**
 * The leaves of a config in the shape hermetic renders it, as dotted paths to
 * their scalar text: `model.provider` → `anthropic`.
 *
 * A line reader, not a YAML parser, for the reason `namesKey` in
 * `hermes-check.ts` is one: the file it is written for is hermetic's own output
 * (block mappings, one key per line, two-space indent, scalars on the key's
 * line) and hermeticd must stay small. Comments, blank lines and list items are
 * skipped. A double-quoted scalar is unquoted; anything else is kept as
 * written, so `headed: true` reads `true`. A file reshaped into something this
 * does not read (flow style, a block scalar) yields fewer leaves, which the
 * drift check reports as the keys going missing. That is the honest reading:
 * the file no longer says what hermetic rendered in the shape it rendered it.
 */
export function hermesConfigLeaves(yaml: string): Record<string, string> {
  const leaves: Record<string, string> = {};
  // The open mappings above the current line: their indent and their key.
  const stack: Array<{ indent: number; key: string }> = [];
  for (const line of yaml.split("\n")) {
    if (/^\s*(#|$)/.test(line) || /^\s*-(\s|$)/.test(line)) continue;
    // Each character has one way to match (ReDoS): the key runs to the first
    // colon and is trimmed here, and the rest of the line is checked in code.
    const m = /^(\s*)([^\s:#][^:]*):([\s\S]*)$/.exec(line);
    if (m === null) continue;
    // After the colon: nothing, or whitespace and then a value with no line
    // terminator in it (a CRLF line's `\r` reads as no match, as it always has).
    const rest = m[3] ?? "";
    if (rest !== "" && (!/^\s/.test(rest) || !/^.*$/.test(rest.trimStart()))) continue;
    const indent = (m[1] ?? "").length;
    const key = (m[2] ?? "").trimEnd();
    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop();
    const path = [...stack.map((s) => s.key), key].join(".");
    const value = rest.trim();
    if (value === "") stack.push({ indent, key });
    else leaves[path] = unquote(value);
  }
  return leaves;
}

/** A double-quoted YAML scalar's text, the inverse of `yamlString` in the renderers. */
function unquote(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

/** One owned key whose value on the box is not the one hermetic rendered. */
export interface OwnedKeyDrift {
  readonly key: string;
  readonly expected: string;
  /** What the box's managed file says, or `null` when it no longer names the key. */
  readonly found: string | null;
}

/**
 * The owned keys `yaml` no longer agrees with, in key order.
 *
 * Only keys in `owned` are compared. A key the file carries that `owned` does
 * not name is not hermetic's, and is not reported, whoever added it.
 */
export function hermesOwnedDrift(
  owned: Readonly<Record<string, string>>,
  yaml: string,
): OwnedKeyDrift[] {
  const onBox = hermesConfigLeaves(yaml);
  return Object.keys(owned)
    .sort()
    .flatMap((key) => {
      const expected = owned[key] ?? "";
      const found = Object.hasOwn(onBox, key) ? (onBox[key] ?? null) : null;
      return found === expected ? [] : [{ key, expected, found }];
    });
}
