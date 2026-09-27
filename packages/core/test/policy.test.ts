/**
 * §4.7's tailnet policy surface: `policy.status`, `plan.policy`, and the
 * `apply` of a policy plan.
 *
 * The property every test here is really about is the one in `hujson.ts`'s
 * header: hermetic owns the lines between its markers and nothing else. So the
 * assertions are less "the right rule is there" than "the operator's file came
 * back the way they wrote it, with hermetic's three entries in it".
 */
import { describe, expect, test } from "bun:test";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFoundation } from "../src/backend/memory.ts";
import { HermeticError } from "../src/errors.ts";
import { applyManagedBlocks, parseHujson, readManagedBlocks } from "../src/fleet/hujson.ts";
import {
  BLOCK_UNPARSABLE,
  POLICY_UNREADABLE,
  aclSnippet,
  aclSnippetParts,
  hermeticBlocks,
  managedDiff,
  sameManagedEntry,
} from "../src/fleet/policy.ts";
import { FLEET_KEY } from "../src/schema/index.ts";
import { drain, testHermetic } from "./helpers.ts";

function fleet(mutate: (backend: MemoryBackend) => void = () => {}) {
  const backend = seedFixtureFoundation(new MemoryBackend());
  mutate(backend);
  return { backend, hermetic: testHermetic({ backend, config: FIXTURE_CONFIG }) };
}

describe("policy.status", () => {
  /**
   * The fixture policy is an operator's: it already owns `tag:hermetic` (they
   * had to, before the OAuth client could be created) and has none of
   * hermetic's blocks. That is the state every real fleet starts in.
   */
  test("reads the scope, the per-block state, the etag and the diff", async () => {
    const { hermetic } = fleet();
    const report = await hermetic.policy.status();
    expect(report.scope).toBe("write");
    expect(report.managed).toBe("absent");
    expect(report.etag).toBe('"fixture-policy-1"');
    expect(report.blocks).toEqual([
      {
        key: "tagOwners",
        state: "skipped",
        reason: expect.stringContaining("already owned outside hermetic's block"),
      },
      { key: "ssh", state: "absent", reason: null },
      { key: "acls", state: "absent", reason: null },
    ]);
    expect(report.diff).toContain("+    // hermetic:managed begin");
    expect(report.diff).toContain("tag:hermetic:7434");
  });

  /** Once written, there is nothing to say and nothing to show. */
  test("is `current` with no diff after an apply", async () => {
    const { hermetic } = fleet();
    await drain(hermetic.apply({ plan: await hermetic.plan.policy(), yes: true }));
    const report = await hermetic.policy.status();
    expect(report.managed).toBe("current");
    expect(report.diff).toBeNull();
    expect(report.blocks.filter((b) => b.state === "current").map((b) => b.key)).toEqual([
      "ssh",
      "acls",
    ]);
  });

  /** An entry edited by hand inside hermetic's markers is drift, and is shown. */
  test("a hand-edited block is `drifted`, with a diff that says how", async () => {
    const { backend, hermetic } = fleet();
    await drain(hermetic.apply({ plan: await hermetic.plan.policy(), yes: true }));
    backend.policyText = backend.policyText.replace("tag:hermetic:7434", "tag:hermetic:9999");
    const report = await hermetic.policy.status();
    expect(report.managed).toBe("drifted");
    expect(report.blocks.find((b) => b.key === "acls")?.state).toBe("drifted");
    expect(report.diff).toContain("-");
    expect(report.diff).toContain("tag:hermetic:7434");
  });

  /**
   * No scope at all: `unavailable`, never an empty report. An unchecked policy
   * and a clean one look identical from the outside and only one of them is
   * fine — the same rule `doctor`'s device list follows.
   */
  test("no policy scope is `unavailable`, not `absent`", async () => {
    const { hermetic } = fleet((b) => {
      b.policyScope = "none";
    });
    const report = await hermetic.policy.status();
    expect(report.scope).toBe("none");
    expect(report.managed).toBe("unavailable");
    expect(report.etag).toBeNull();
    expect(report.diff).toBeNull();
    expect(report.blocks.every((b) => b.state === "skipped")).toBe(true);
  });

  /** A read-only client can still see the drift; it just cannot fix it. */
  test("a read-only client reports the drift it cannot write", async () => {
    const { hermetic } = fleet((b) => {
      b.policyScope = "read";
    });
    const report = await hermetic.policy.status();
    expect(report.scope).toBe("read");
    expect(report.managed).toBe("absent");
    expect(report.diff).not.toBeNull();
  });

  /**
   * The `tagOwners` skip is not squeamishness: two `"tag:hermetic"` keys in one
   * object is invalid HuJSON. When nothing outside a managed block owns the tag
   * — a policy written from scratch — hermetic does write it.
   */
  test("writes tagOwners when nobody else owns the tag", async () => {
    const { hermetic } = fleet((b) => {
      b.policyText = b.policyText.replace('    "tag:hermetic": ["autogroup:admin"],\n', "");
    });
    const report = await hermetic.policy.status();
    expect(report.blocks.find((b) => b.key === "tagOwners")?.state).toBe("absent");
    expect(report.diff).toContain("autogroup:admin");
  });
});

describe("plan.policy", () => {
  test("one step per block plus the write, which is the destructive one", async () => {
    const { hermetic } = fleet();
    const plan = await hermetic.plan.policy();
    expect(plan.kind).toBe("policy");
    expect(plan.target).toBe("tailnet");
    expect(plan.steps.map((s) => s.id)).toEqual(["tagOwners", "ssh", "acls", "write"]);
    expect(plan.steps.filter((s) => s.destructive).map((s) => s.id)).toEqual(["write"]);
    // Carried as data, so `apply` never reads the prose back (§3.2 rule 3).
    expect(plan.options.etag).toBe('"fixture-policy-1"');
  });

  /**
   * The two things the operator confirming this must be told: that hermetic
   * touches nothing outside its markers, and exactly what it is about to write.
   */
  test("warns about the markers and carries the diff", async () => {
    const { hermetic } = fleet();
    const plan = await hermetic.plan.policy();
    const warnings = plan.warnings.join("\n");
    expect(warnings).toContain("hermetic:managed begin");
    expect(warnings).toContain("byte for byte");
    expect(warnings).toContain("unified diff");
    expect(warnings).toContain("tag:hermetic:443");
  });

  /** A plan against a policy hermetic cannot write says so before it is applied. */
  test("says the apply will be refused when the client is read-only", async () => {
    const { hermetic } = fleet((b) => {
      b.policyScope = "read";
    });
    const plan = await hermetic.plan.policy();
    expect(plan.warnings.join("\n")).toContain("`hermetic apply` will be refused");
  });

  /** Nothing to do is a plan too, with no destructive step in it. */
  test("a current policy plans a write step that is not destructive", async () => {
    const { hermetic } = fleet();
    await drain(hermetic.apply({ plan: await hermetic.plan.policy(), yes: true }));
    const plan = await hermetic.plan.policy();
    expect(plan.steps.every((s) => !s.destructive)).toBe(true);
    expect(plan.steps.at(-1)!.description).toContain("nothing to write");
  });
});

describe("apply(plan.policy())", () => {
  test("writes hermetic's blocks and returns every other byte unchanged", async () => {
    const { backend, hermetic } = fleet();
    const before = backend.policyText;
    const events = await drain(hermetic.apply({ plan: await hermetic.plan.policy(), yes: true }));

    expect(events.map((e) => e.phase)).toEqual(["fetch", "fetch", "render", "validate", "done"]);
    expect(events.at(-1)!.message).toContain("ssh, acls");
    expect(events.at(-1)!.message).toContain("tagOwners left as you wrote it");

    const blocks = readManagedBlocks(backend.policyText);
    expect(Object.keys(blocks).sort()).toEqual(["acls", "ssh"]);
    // The operator's comments, groups and rules survive verbatim.
    for (const line of before.split("\n")) {
      if (line.trim().length > 0) expect(backend.policyText).toContain(line);
    }
    // And the ETag moved, so a second plan is needed before a second write.
    expect(backend.policyEtag()).toBe('"fixture-policy-2"');
  });

  /** A second apply is a no-op: `applyManagedBlocks` reports nothing changed. */
  test("is idempotent, and says so rather than writing again", async () => {
    const { backend, hermetic } = fleet();
    await drain(hermetic.apply({ plan: await hermetic.plan.policy(), yes: true }));
    const written = backend.policyText;
    const events = await drain(hermetic.apply({ plan: await hermetic.plan.policy(), yes: true }));
    expect(events.at(-1)!.message).toContain("already says what hermetic would say");
    expect(backend.policyText).toBe(written);
    expect(backend.policyEtag()).toBe('"fixture-policy-2"');
  });

  /** The `_fleet` ledger records the etags, and never the policy text (§8.3). */
  test("records a `policy.apply` event with the etags and no policy", async () => {
    const { backend, hermetic } = fleet();
    await drain(hermetic.apply({ plan: await hermetic.plan.policy(), yes: true }));
    const events = await backend.store.events.query(FLEET_KEY, 50);
    const applied = events.find((e) => e.action === "policy.apply")!;
    expect(applied.detail).toContain('"fixture-policy-1"');
    expect(applied.detail).toContain('"fixture-policy-2"');
    expect(applied.detail).not.toContain("autogroup:member");
  });

  /**
   * The reason the ETag rides on the plan: someone editing the policy in the
   * admin console between the plan and the apply must not have their edit
   * silently overwritten.
   */
  test("a policy that moved between the plan and the apply is a CONFLICT", async () => {
    const { backend, hermetic } = fleet();
    const plan = await hermetic.plan.policy();
    backend.policyText = backend.policyText.replace(
      '"group:ops": ["ops@example.com"],',
      '"group:ops": ["ops@example.com", "sam@example.com"],',
    );
    // Simulate the console's own write: the etag moves with it.
    await backend.tailscale.setPolicy(backend.policyText, backend.policyEtag());
    const edited = backend.policyText;

    const error = await drain(hermetic.apply({ plan, yes: true })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HermeticError);
    expect((error as HermeticError).code).toBe("CONFLICT");
    expect((error as HermeticError).message).toContain("hermetic plan policy");
    expect(backend.policyText).toBe(edited);
  });

  /** No scope: FORBIDDEN, naming the scope and the rotation that grants it. */
  test("a client without policy_file is FORBIDDEN and writes nothing", async () => {
    const { backend, hermetic } = fleet();
    const plan = await hermetic.plan.policy();
    const before = backend.policyText;
    backend.policyScope = "none";
    const error = await drain(hermetic.apply({ plan, yes: true })).catch((e: unknown) => e);
    expect((error as HermeticError).code).toBe("FORBIDDEN");
    expect((error as HermeticError).message).toContain("policy_file");
    expect(backend.policyText).toBe(before);
  });

  /** Read-only lands on the same refusal, from the validate rather than the read. */
  test("a read-only client is FORBIDDEN at the validate, before any write", async () => {
    const { backend, hermetic } = fleet();
    const plan = await hermetic.plan.policy();
    const before = backend.policyText;
    backend.policyScope = "read";
    const error = await drain(hermetic.apply({ plan, yes: true })).catch((e: unknown) => e);
    expect((error as HermeticError).code).toBe("FORBIDDEN");
    expect(backend.policyText).toBe(before);
  });

  /**
   * Validate before write, so a policy Tailscale would reject never reaches the
   * tailnet — and nothing is written when it would have.
   */
  test("a policy the API rejects is VALIDATION, and nothing is written", async () => {
    const { backend, hermetic } = fleet();
    const plan = await hermetic.plan.policy();
    const before = backend.policyText;
    let asked = 0;
    backend.tailscale.validatePolicy = async () => {
      asked += 1;
      return { ok: false, message: "line 9, column 5: unexpected token" };
    };
    const error = await drain(hermetic.apply({ plan, yes: true })).catch((e: unknown) => e);
    expect((error as HermeticError).code).toBe("VALIDATION");
    expect((error as HermeticError).message).toContain("line 9, column 5");
    expect(asked).toBe(1);
    expect(backend.policyText).toBe(before);
  });

  /** Core never asks "are you sure"; it insists the head did (§3.2 rule 3). */
  test("refuses without `yes`", async () => {
    const { hermetic } = fleet();
    const plan = await hermetic.plan.policy();
    const error = await drain(hermetic.apply({ plan, yes: false })).catch((e: unknown) => e);
    expect((error as HermeticError).code).toBe("CONFIRMATION_REQUIRED");
  });
});

/**
 * Formatting is not drift.
 *
 * Tailscale does not store the policy file the way it was posted: it stores
 * what it parsed, re-printed in its own style — one member to a line, tab
 * indent, values aligned into a column. Observed on a real tailnet: hermetic
 * wrote its `ssh` rule as one line and read back six. A textual comparison
 * called that `drifted`, so the next `plan policy` proposed the identical rule,
 * the write came back reformatted again, and the fleet churned ETags for ever
 * with neither side wrong about anything.
 *
 * The fixture reformats the same way (`backend/memory.ts`), which is what makes
 * these tests the regression rather than a description of one.
 */
describe("formatting is not drift", () => {
  test("a block the tailnet reformatted is `current`, with no diff and no write", async () => {
    const { backend, hermetic } = fleet();
    await drain(hermetic.apply({ plan: await hermetic.plan.policy(), yes: true }));
    // What came back is not what hermetic posted — this is the premise.
    expect(backend.policyText).toContain('\t"action": "accept",');
    expect(backend.policyText).not.toContain(hermeticBlocks().find((b) => b.key === "ssh")!.body);

    const written = backend.policyText;
    const writes = backend.mutations.filter((m) => m === "tailscale.setPolicy").length;
    const report = await hermetic.policy.status();
    expect(report.managed).toBe("current");
    expect(report.blocks.filter((b) => b.state === "current").map((b) => b.key)).toEqual([
      "ssh",
      "acls",
    ]);
    expect(report.diff).toBeNull();

    // And the apply that follows it writes nothing at all.
    const events = await drain(hermetic.apply({ plan: await hermetic.plan.policy(), yes: true }));
    expect(events.at(-1)!.message).toContain("already says what hermetic would say");
    expect(backend.policyText).toBe(written);
    expect(backend.mutations.filter((m) => m === "tailscale.setPolicy").length).toBe(writes);
  });

  /** A rule that really did change is still drift, and is still written. */
  test("a port removed from the block is `drifted`, and only that block is rewritten", async () => {
    const { backend, hermetic } = fleet();
    await drain(hermetic.apply({ plan: await hermetic.plan.policy(), yes: true }));
    backend.policyText = backend.policyText.replace('"tag:hermetic:443",', "");

    const report = await hermetic.policy.status();
    expect(report.managed).toBe("drifted");
    expect(report.blocks.find((b) => b.key === "acls")!.state).toBe("drifted");
    expect(report.blocks.find((b) => b.key === "ssh")!.state).toBe("current");
    expect(report.diff).toContain("@@ acls @@");
    expect(report.diff).toContain("tag:hermetic:443");
    // The `ssh` block is semantically current, so it is not in the write set and
    // therefore cannot appear in the diff either.
    expect(report.diff).not.toContain("@@ ssh @@");

    await drain(hermetic.apply({ plan: await hermetic.plan.policy(), yes: true }));
    expect((await hermetic.policy.status()).managed).toBe("current");
  });

  /** Key order is formatting too: the canonical form sorts object keys. */
  test("the same rule with its keys in another order is not drift", () => {
    const ssh = hermeticBlocks().find((b) => b.key === "ssh")!;
    const reordered = [
      "{",
      '\t"users":  ["autogroup:nonroot", "root"],',
      '\t"dst":    ["tag:hermetic"],',
      '\t"src":    ["autogroup:member"],',
      '\t"action": "accept",',
      "},",
    ].join("\n");
    expect(sameManagedEntry(reordered, ssh)).toEqual({ same: true, reason: null });
  });

  /**
   * Array order is not formatting — `["a", "b"]` and `["b", "a"]` are different
   * rules to Tailscale — so it stays drift.
   */
  test("a reordered array is drift, because the tailnet reads it as one", () => {
    const ssh = hermeticBlocks().find((b) => b.key === "ssh")!;
    const swapped = ssh.body.replace('["autogroup:nonroot", "root"]', '["root", "autogroup:nonroot"]');
    expect(sameManagedEntry(swapped, ssh).same).toBe(false);
  });

  /**
   * A hand edit gone wrong between the markers cannot be compared, so it is
   * drift with a reason rather than a crash: the answer to it is the rewrite
   * `apply` already offers.
   */
  test("a block body that will not parse is drift, with a reason", () => {
    const acls = hermeticBlocks().find((b) => b.key === "acls")!;
    expect(sameManagedEntry('{ "action": "accept" ', acls)).toEqual({
      same: false,
      reason: BLOCK_UNPARSABLE,
    });
  });
});

/**
 * The paste-ready snippet and the managed blocks come out of the same entries,
 * so a port added to one is in the other. This is the assertion that keeps them
 * from drifting the way the 7434 rule once did.
 */
describe("one source of truth", () => {
  test("the snippet and the managed blocks say the same thing", async () => {
    const { backend, hermetic } = fleet();
    await drain(hermetic.apply({ plan: await hermetic.plan.policy(), yes: true }));
    const blocks = readManagedBlocks(backend.policyText);
    const whole = JSON.parse(aclSnippet().split("\n").slice(1).join("\n")) as {
      ssh: unknown[];
      acls: unknown[];
    };
    // Each managed body is the snippet's entry, comma and all. Read back with
    // the HuJSON parser rather than `JSON.parse`, because what comes back is
    // whatever the tailnet stored — the fixture, like Tailscale, re-prints the
    // block in its own style, trailing commas and all.
    expect(parseHujson(blocks["ssh"]!.replace(/,$/, ""))).toEqual(whole.ssh[0]);
    expect(parseHujson(blocks["acls"]!.replace(/,$/, ""))).toEqual(whole.acls[0]);
  });

  test("the parts carry a purpose the heads can label a paste with", () => {
    for (const part of aclSnippetParts()) expect(part.purpose.length).toBeGreaterThan(0);
  });
});

describe("managedDiff", () => {
  const KEYS = ["ssh", "acls"];

  test("is empty when the managed ranges say the same thing", () => {
    const text = [
      "{",
      '  "ssh": [',
      "    // hermetic:managed begin",
      '    { "a": 1 },',
      "    // hermetic:managed end",
      "  ],",
      "}",
    ].join("\n");
    expect(managedDiff(text, text, KEYS)).toBe("");
  });

  /**
   * The whole point of diffing ranges rather than the document: an operator's
   * rule two lines from hermetic's block is not hermetic's business, and a
   * policy file names people (§8.3).
   */
  test("never shows a line from outside hermetic's markers", () => {
    const before = [
      "{",
      '  "groups": {',
      '    "group:ops": ["ops@example.com"],',
      "  },",
      '  "acls": [',
      '    { "action": "accept", "src": ["group:ops"], "dst": ["tag:build:22"] },',
      "  ],",
      "}",
    ].join("\n");
    const after = applyManagedBlocks(before, [
      { key: "acls", container: "array", body: '{ "action": "accept" },' },
    ]);
    const diff = managedDiff(before, after.text, ["acls"]);
    expect(diff).toContain("@@ acls (new block at end of container) @@");
    expect(diff).toContain("+    // hermetic:managed begin");
    expect(diff).not.toContain("ops@example.com");
    expect(diff).not.toContain("tag:build:22");
    expect(diff).not.toContain("group:ops");
  });

  /** A body edited inside the markers is a hunk with the markers as context. */
  test("an edited block diffs against itself, markers as context", () => {
    const before = applyManagedBlocks(
      ["{", '  "acls": [', '    { "keep": "mine" },', "  ],", "}"].join("\n"),
      [{ key: "acls", container: "array", body: '{ "dst": ["tag:hermetic:443"] },' }],
    ).text;
    const after = applyManagedBlocks(before, [
      { key: "acls", container: "array", body: '{ "dst": ["tag:hermetic:22"] },' },
    ]).text;
    const diff = managedDiff(before, after, ["acls"]);
    expect(diff).toContain("@@ acls @@");
    expect(diff).toContain('-    { "dst": ["tag:hermetic:443"] },');
    expect(diff).toContain('+    { "dst": ["tag:hermetic:22"] },');
    // The markers are context, and the operator's own entry is not there at all.
    expect(diff).toContain("     // hermetic:managed begin");
    expect(diff).not.toContain("keep");
  });

  /** Keys hermetic is not writing contribute nothing. */
  test("a key with no change is not a hunk", () => {
    const before = ["{", '  "ssh": [],', '  "acls": [],', "}"].join("\n");
    const after = applyManagedBlocks(before, [
      { key: "acls", container: "array", body: '{ "a": 1 },' },
    ]).text;
    const diff = managedDiff(before, after, KEYS);
    expect(diff).toContain("@@ acls");
    expect(diff).not.toContain("@@ ssh");
  });
});

/**
 * The `acls` rule is the network half of the SSH grant. The `ssh` block says
 * who may `tailscale ssh` to a tagged node; Tailscale still checks the network
 * ACL first, so without 22 in `dst` an operator the `ssh` block allows gets a
 * refused connection. Asserted on the rendered entry rather than described in
 * prose, because "one grant, two blocks" is exactly the pairing that drifted.
 */
describe("what the acls block opens", () => {
  test("22, 443 and 7434, in that order, in both spellings", () => {
    const acls = hermeticBlocks().find((b) => b.key === "acls")!;
    const entry = JSON.parse(acls.body.replace(/,$/, "")) as { dst: string[] };
    expect(entry.dst).toEqual(["tag:hermetic:22", "tag:hermetic:443", "tag:hermetic:7434"]);

    const snippet = JSON.parse(aclSnippet().split("\n").slice(1).join("\n")) as {
      acls: Array<{ dst: string[] }>;
    };
    expect(snippet.acls[0]!.dst).toEqual(entry.dst);
  });
});

/**
 * Which member of `tagOwners` owns `tag:hermetic` is a question about *where*
 * a key is, and it used to be answered by scanning lines for text. Both of the
 * ways that got it wrong are here.
 */
describe("who owns tag:hermetic", () => {
  /**
   * `line.split("//")[0]` cut this line at the `//` of the URL and lost the
   * owner that follows it on the same line — so hermetic read "nobody owns the
   * tag" and would have written a second `"tag:hermetic"` into the same object,
   * which is invalid HuJSON.
   */
  test("a `//` inside a string does not hide the owner after it", async () => {
    const { hermetic } = fleet((b) => {
      b.policyText = b.policyText.replace(
        '    "tag:hermetic": ["autogroup:admin"],\n',
        '    "tag:docs": ["https://wiki.example.com/owners"], "tag:hermetic": ["autogroup:admin"],\n',
      );
    });
    const report = await hermetic.policy.status();
    expect(report.blocks.find((b) => b.key === "tagOwners")?.state).toBe("skipped");
  });

  /** A commented-out owner owns nothing; block comments were never stripped. */
  test("an owner inside a block comment is not an owner", async () => {
    const { backend, hermetic } = fleet((b) => {
      b.policyText = b.policyText.replace(
        '    "tag:hermetic": ["autogroup:admin"],\n',
        '    /* "tag:hermetic": ["autogroup:admin"], */\n',
      );
    });
    const report = await hermetic.policy.status();
    expect(report.blocks.find((b) => b.key === "tagOwners")?.state).toBe("absent");
    await drain(hermetic.apply({ plan: await hermetic.plan.policy(), yes: true }));
    expect(Object.keys(readManagedBlocks(backend.policyText)).sort()).toEqual([
      "acls",
      "ssh",
      "tagOwners",
    ]);
  });

  /** hermetic's own block is not "outside" it: a written tag stays written. */
  test("the owner hermetic wrote is not read back as somebody else's", async () => {
    const { hermetic } = fleet((b) => {
      b.policyText = b.policyText.replace('    "tag:hermetic": ["autogroup:admin"],\n', "");
    });
    await drain(hermetic.apply({ plan: await hermetic.plan.policy(), yes: true }));
    const report = await hermetic.policy.status();
    expect(report.blocks.find((b) => b.key === "tagOwners")?.state).toBe("current");
    expect(report.managed).toBe("current");
  });
});

/**
 * A policy nobody can read is one fact, not three or four. The bug this fixes
 * was cosmetic in the way that matters: the same paragraph on every block line
 * and in every warning, next to a write step claiming the policy "already says
 * what hermetic would say" — which it may or may not, because nothing read it.
 */
describe("an unreadable policy says so once", () => {
  test("every block carries the short state and the sentence is on the report", async () => {
    const { hermetic } = fleet((b) => {
      b.policyScope = "none";
    });
    const report = await hermetic.policy.status();
    expect(report.blocks.map((b) => b.reason)).toEqual([
      POLICY_UNREADABLE,
      POLICY_UNREADABLE,
      POLICY_UNREADABLE,
    ]);
    expect(report.scope_reason).toBeNull();
  });

  test("the plan warns once and the write step says what actually happened", async () => {
    const { hermetic } = fleet((b) => {
      b.policyScope = "none";
    });
    const plan = await hermetic.plan.policy();
    expect(plan.warnings.filter((w) => w.includes("cannot read the tailnet policy")).length).toBe(1);
    expect(plan.warnings.length).toBe(2);
    expect(plan.steps.at(-1)!.description).toBe("nothing to write: the policy file could not be read");
    expect(plan.steps.at(-1)!.destructive).toBe(false);
    // And nothing to apply it with (§4.7): no ETag was ever read.
    expect(plan.options.etag).toBeUndefined();
  });
});

/**
 * The `If-Match` is the safety argument, not an optimisation: a plan with no
 * ETag cannot be executed without turning the write into an unconditional
 * overwrite of a document read at some unknown earlier time.
 */
describe("apply refuses a plan with no ETag", () => {
  test("an unreadable-policy plan is VALIDATION, and writes nothing", async () => {
    const { backend, hermetic } = fleet((b) => {
      b.policyScope = "none";
    });
    const plan = await hermetic.plan.policy();
    backend.policyScope = "write";
    const before = backend.policyText;
    const error = await drain(hermetic.apply({ plan, yes: true })).catch((e: unknown) => e);
    expect((error as HermeticError).code).toBe("VALIDATION");
    expect((error as HermeticError).message).toContain("hermetic plan policy");
    expect(backend.policyText).toBe(before);
  });

  test("an empty ETag is no ETag", async () => {
    const { backend, hermetic } = fleet();
    const plan = await hermetic.plan.policy();
    const error = await drain(
      hermetic.apply({ plan: { ...plan, options: { etag: "" } }, yes: true }),
    ).catch((e: unknown) => e);
    expect((error as HermeticError).code).toBe("VALIDATION");
    expect(backend.mutations).not.toContain("tailscale.setPolicy");
  });
});

/**
 * §4.7: `write` is claimed only when validate answers 200. A 400 — the
 * operator's own embedded ACL tests failing, say — proves nothing about the
 * scope, and claiming the scope on it told operators they could run an `apply`
 * that Tailscale would refuse.
 */
describe("the write scope is proved, not assumed", () => {
  test("a validate that fails for any other reason is `read`, with the reason", async () => {
    const { hermetic } = fleet((b) => {
      b.tailscale.validatePolicy = async () => ({ ok: false, message: "test(s) failed" });
    });
    const report = await hermetic.policy.status();
    expect(report.scope).toBe("read");
    expect(report.scope_reason).toContain("could not prove policy_file write");
    expect(report.scope_reason).toContain("test(s) failed");
  });

  test("the plan warns with that reason rather than the flat read-only note", async () => {
    const { hermetic } = fleet((b) => {
      b.tailscale.validatePolicy = async () => ({ ok: false, message: "HTTP 429" });
    });
    const plan = await hermetic.plan.policy();
    expect(plan.warnings.some((w) => w.includes("could not prove policy_file write"))).toBe(true);
    expect(plan.warnings.some((w) => w.includes("can read the tailnet policy file but not"))).toBe(
      false,
    );
  });

  test("a 403 from validate is an answer, and carries no reason", async () => {
    const { hermetic } = fleet((b) => {
      b.policyScope = "read";
    });
    const report = await hermetic.policy.status();
    expect(report.scope).toBe("read");
    expect(report.scope_reason).toBeNull();
  });
});
