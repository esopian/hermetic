/**
 * The §4.7 admin-console walk's third stop: the tailnet-wide HTTPS
 * Certificates toggle. The wizard as a whole needs a server to mount, but this
 * block is a function of the preflight alone — it links to the DNS page and
 * reports what `cert_domains` says, which is the part an operator acts on.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { InitOauthCheck, InitTailscale } from "../src/api/index.ts";
import {
  CertificatesStep,
  POLICY_NONE_NOTE,
  POLICY_READ_NOTE,
  initRequestBody,
  oauthVerdict,
  readStoredInit,
} from "../src/components/InitWizard.tsx";
import { TAILSCALE_ADMIN_DNS_URL } from "../src/logic/format.ts";

function preflight(over: Partial<InitTailscale> = {}): InitTailscale {
  return {
    ok: true,
    installed: true,
    running: true,
    backend_state: "Running",
    tailnet: "acme.ts.net",
    cert_domains: ["laptop.acme.ts.net"],
    hostname: "laptop",
    addresses: ["100.64.0.1"],
    binary: "/usr/bin/tailscale",
    problem: null,
    ...over,
  };
}

function html(ts: InitTailscale | null): string {
  return renderToStaticMarkup(createElement(CertificatesStep, { ts, onRecheck: () => {} }));
}

describe("CertificatesStep", () => {
  test("is step 3 of the walk and links to the admin DNS page", () => {
    const out = html(preflight());
    expect(out).toContain("3 · HTTPS certificates");
    expect(out).toContain(`href="${TAILSCALE_ADMIN_DNS_URL}"`);
    expect(TAILSCALE_ADMIN_DNS_URL).toBe("https://login.tailscale.com/admin/dns");
  });

  test("says why, and what it costs, before the probe has answered", () => {
    const out = html(null);
    expect(out).toContain("noVNC");
    expect(out).toContain("Certificate Transparency logs");
    // No verdict without a preflight to read one from.
    expect(out).not.toContain("HTTPS certificates: ");
  });

  test("a non-empty cert_domains reads as on, and names the first domain", () => {
    const out = html(preflight({ cert_domains: ["laptop.acme.ts.net"] }));
    expect(out).toContain("HTTPS certificates: on");
    expect(out).toContain("laptop.acme.ts.net");
    expect(out).not.toContain("HTTPS certificates: off");
  });

  test("an empty cert_domains reads as off and offers the re-check", () => {
    // Core sets `ok: false` with a problem of its own in this case; the step
    // still has to say which toggle to go and flip.
    const out = html(preflight({ ok: false, cert_domains: [], problem: "…disabled…" }));
    expect(out).toContain("HTTPS certificates: off");
    expect(out).toContain("re-check");
    expect(out).not.toContain("HTTPS certificates: on");
  });
});

/**
 * The client-secret field's verdict. The fleet's OAuth client carries three
 * scopes — `auth_keys` write, `devices:core` read/write and `policy_file`
 * read/write — and only the first decides whether the wizard may proceed, so
 * the interesting cases are the clients that mint and cannot do one of the
 * others: green verdict, yellow note, Initialize open.
 */
describe("oauthVerdict", () => {
  function check(over: Partial<InitOauthCheck> = {}): InitOauthCheck {
    return {
      ok: true,
      authenticated: true,
      can_mint: true,
      can_list_devices: true,
      revoked: true,
      policy_scope: "write",
      problem: null,
      ...over,
    };
  }

  test("before a verify, it describes what verifying will do", () => {
    expect(oauthVerdict("idle", "tskey-client-kABC123-secret", null, null)).toEqual({
      text: "mints a tag:hermetic key and revokes it",
      tone: "quiet",
      note: null,
    });
    // A value that is not shaped like a client secret is named as such rather
    // than sent to api.tailscale.com to be refused.
    expect(oauthVerdict("idle", "nonsense", null, null).text).toBe("expected tskey-client-…");
  });

  test("all three scopes read green, and say so", () => {
    const v = oauthVerdict("done", "tskey-client-kABC123-secret", check(), null);
    expect(v.tone).toBe("ok");
    expect(v.text).toBe("can mint tag:hermetic keys, list devices and edit the policy file");
    expect(v.note).toBeNull();
  });

  test("policy_file read-only is green, with the paste-it-yourself note", () => {
    const v = oauthVerdict(
      "done",
      "tskey-client-kABC123-secret",
      check({ policy_scope: "read" }),
      null,
    );
    expect(v.tone).toBe("ok");
    // The verdict claims no policy capability it does not have.
    expect(v.text).toBe("can mint tag:hermetic keys and list devices");
    expect(v.note).toBe(POLICY_READ_NOTE);
    expect(v.note).toContain("read but not write");
  });

  test("no policy_file scope at all is green, and says init will not touch the file", () => {
    const v = oauthVerdict(
      "done",
      "tskey-client-kABC123-secret",
      check({ policy_scope: "none" }),
      null,
    );
    expect(v.tone).toBe("ok");
    expect(v.text).toBe("can mint tag:hermetic keys and list devices");
    expect(v.note).toBe(POLICY_NONE_NOTE);
  });

  test("two shortfalls are two notes on one line, and still not red", () => {
    const v = oauthVerdict(
      "done",
      "tskey-client-kABC123-secret",
      check({ can_list_devices: false, policy_scope: "none", problem: "…lacks devices:core…" }),
      null,
    );
    expect(v.tone).toBe("ok");
    expect(v.text).toBe("can mint tag:hermetic keys");
    expect(v.note).toBe(`…lacks devices:core… · ${POLICY_NONE_NOTE}`);
  });

  test("mint-only is still green, with the missing scope as a yellow note", () => {
    const v = oauthVerdict(
      "done",
      "tskey-client-kABC123-secret",
      check({ can_list_devices: false, problem: "…lacks devices:core…" }),
      null,
    );
    // Green: the client works, and Initialize reads `oauth.ok`.
    expect(v.tone).toBe("ok");
    expect(v.text).toBe("can mint tag:hermetic keys and edit the policy file");
    expect(v.note).toBe("…lacks devices:core…");
  });

  test("a client that cannot mint is red, and carries no note", () => {
    const v = oauthVerdict(
      "done",
      "tskey-client-kABC123-secret",
      check({ ok: false, can_mint: false, can_list_devices: false, problem: "HTTP 403" }),
      null,
    );
    expect(v.tone).toBe("bad");
    expect(v.text).toBe("HTTP 403");
    expect(v.note).toBeNull();
  });

  test("an unrevoked probe key is mentioned, and does not change the tone", () => {
    const v = oauthVerdict("done", "tskey-client-kABC123-secret", check({ revoked: false }), null);
    expect(v.tone).toBe("ok");
    expect(v.text).toContain("probe key left to expire");
  });

  test("a failed request reports the transport error, not a verdict", () => {
    const v = oauthVerdict("error", "tskey-client-kABC123-secret", null, "network down");
    expect(v).toEqual({ text: "network down", tone: "bad", note: null });
  });
});

/**
 * The checkbox is positive ("manage the tailnet policy file during init") and
 * the wire field is negative (`skip_policy`), which is exactly the pair that
 * gets inverted. This is the one place the two meet.
 */
describe("initRequestBody", () => {
  function body(over: Partial<Parameters<typeof initRequestBody>[0]> = {}) {
    return initRequestBody({
      profile: "acme",
      region: " us-west-2 ",
      accountId: "123456789012",
      attaching: false,
      tailnet: "acme.ts.net",
      network: "public",
      secret: "tskey-client-kABC123-secret",
      managePolicy: true,
      ...over,
    });
  }

  test("the checked box sends no skip_policy at all — core's default is to manage it", () => {
    const out = body();
    expect(out.skip_policy).toBeUndefined();
    expect("skip_policy" in out).toBe(false);
    // The rest of the create branch is unchanged by this feature.
    expect(out).toMatchObject({
      profile: "acme",
      region: "us-west-2",
      account_id_typed: "123456789012",
      mode: "create",
      tailnet: "acme.ts.net",
      network: "public",
      tailscale_oauth_secret: "tskey-client-kABC123-secret",
    });
  });

  test("clearing the box is --skip-policy on the wire", () => {
    expect(body({ managePolicy: false }).skip_policy).toBe(true);
  });

  test("attach touches no policy either way: no tailnet, no secret, no skip_policy", () => {
    for (const managePolicy of [true, false]) {
      const out = body({ attaching: true, managePolicy });
      expect(out.mode).toBe("attach");
      expect(out.skip_policy).toBeUndefined();
      expect(out.tailnet).toBeUndefined();
      expect(out.tailscale_oauth_secret).toBeUndefined();
    }
  });

  test("no pasted secret means no secret on the wire, and the flag is unaffected", () => {
    const out = body({ secret: "", managePolicy: false });
    expect(out.tailscale_oauth_secret).toBeUndefined();
    expect(out.skip_policy).toBe(true);
  });
});

/**
 * The reattach breadcrumb (§ fix-first 7). `init` is the longest unattended
 * wait in the product; a reloaded tab has to come back to the op that is still
 * running, and it has to come back to it *honestly* — an attach seeded with the
 * create phase list shows a rail of steps the op will never take, under a
 * header of em dashes.
 */
describe("readStoredInit", () => {
  const KEY = "hermetic.init.opId";
  /**
   * This is a pure-logic suite with no DOM behind it, so it brings the one
   * browser API under test — unless another suite in the same run already
   * installed a real one, in which case that is used as-is. Assigning over it
   * is not an option: a DOM's `sessionStorage` is a readonly accessor, and
   * doing so throws only when the whole directory runs, which is the least
   * useful moment to find out.
   */
  const backing = new Map<string, string>();
  const stub: Storage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: (i: number) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  };
  let storage: Storage = stub;
  let installed = false;

  beforeAll(() => {
    const existing = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    if (existing) {
      storage = existing;
      return;
    }
    Object.defineProperty(globalThis, "sessionStorage", { value: stub, configurable: true });
    installed = true;
  });

  afterAll(() => {
    storage.removeItem(KEY);
    // Leave the global exactly as it was found: a suite that legitimately tests
    // the no-storage path must not inherit this one's stub.
    if (installed) Reflect.deleteProperty(globalThis, "sessionStorage");
  });

  function store(raw: string | null): void {
    if (raw === null) storage.removeItem(KEY);
    else storage.setItem(KEY, raw);
  }

  test("nothing stored is nothing to resume", () => {
    store(null);
    expect(readStoredInit()).toBeNull();
  });

  test("reads back the whole record, so step 4 can draw itself", () => {
    const record = {
      opId: "op-7",
      attaching: true,
      profile: "prod",
      region: "us-west-2",
      tailnet: "acme.ts.net",
      accountId: "123456789012",
      policyPhase: true,
    };
    store(JSON.stringify(record));
    expect(readStoredInit()).toEqual(record);
  });

  /**
   * An earlier build wrote the bare op id. Throwing that away would abandon a
   * running foundation create — the exact thing the breadcrumb exists for — so
   * it is read, with the branch defaulting to the safe reading.
   */
  test("an older bare-id breadcrumb still resumes", () => {
    store("op-legacy");
    expect(readStoredInit()).toEqual({
      opId: "op-legacy",
      attaching: false,
      profile: null,
      region: "",
      tailnet: "",
      accountId: null,
      policyPhase: false,
    });
  });

  test("a record with no usable op id is not a resume", () => {
    for (const raw of ['{"opId":""}', '{"attaching":true}', "{}", "{not json"]) {
      store(raw);
      expect(readStoredInit()).toBeNull();
    }
  });

  test("junk in the other fields degrades to defaults rather than throwing", () => {
    // sessionStorage is shared with anything else on this origin, and a wizard
    // that throws on read is a wizard that cannot render at all.
    store('{"opId":"op-9","attaching":"yes","profile":42,"region":null,"policyPhase":1}');
    expect(readStoredInit()).toEqual({
      opId: "op-9",
      attaching: false,
      profile: null,
      region: "",
      tailnet: "",
      accountId: null,
      policyPhase: false,
    });
  });

  test("no secret is ever a field of this record", () => {
    // The OAuth secret lives in component state and nowhere else; this asserts
    // the shape cannot quietly grow a home for it.
    store('{"opId":"op-1"}');
    const resumed = readStoredInit();
    expect(Object.keys(resumed ?? {}).sort()).toEqual([
      "accountId",
      "attaching",
      "opId",
      "policyPhase",
      "profile",
      "region",
      "tailnet",
    ]);
  });
});
