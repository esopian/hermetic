/**
 * Fixtures shared by the hermeticd suite: a manifest shaped exactly like the one
 * `packages/core/src/render.ts` produces, and a recording AWS command sink.
 *
 * The recorder stands in for `aws-sdk-client-mock`: it captures the real
 * `UpdateCommand` / `PutCommand` / `GetCommand` objects the code under test
 * builds, so assertions read their `input` — the same thing
 * `mock.commandCalls(UpdateCommand)` gives, without a dependency agentd cannot
 * resolve (`aws-sdk-client-mock` is core's devDependency, not agentd's).
 */
import type { AgentConfig, BrowserIdentity, FleetManifest } from "@hermetic/core/schema";
import {
  FleetManifest as FleetManifestSchema,
  browserIdentities,
  browserBuildKey,
  releaseKey,
} from "@hermetic/core/schema";
import { createHash } from "node:crypto";
import { parseManifest } from "../src/manifest.ts";
import type { CommandSink } from "../src/aws.ts";

export const TEST_NAME = "research-1";

export interface ManifestOverrides {
  secrets_mode?: AgentConfig["secrets_mode"];
  provider?: AgentConfig["provider"];
  hermesUnitBody?: string;
  hermes_version?: string;
  hermes_ref?: string;
  packages?: string[];
  commands?: string[];
  /**
   * The units the manifest asks for. Defaults to the two hermeticd renders plus
   * upstream's gateway; set it to include one core does not render either
   * (nginx's package-provided `nginx.service`).
   */
  units?: string[];
  /** Defaults to the single Tailscale source; set to exercise another vendor's key. */
  apt_sources?: AgentConfig["apt_sources"];
  /** The serve hostname; on a real box this is always `<name>.<tailnet>`. */
  tailscale_hostname?: string;
  /**
   * What the managed Hermes config asks to restart when it changes. Set it to
   * `[]` to render the same manifest without the declaration, which is what an
   * older core would have produced.
   */
  configRestartUnits?: string[];
  /** The managed Hermes config's body; change it to exercise a content drift. */
  hermesConfigBody?: string;
  /** The gateway drop-in's body; change it to exercise a content drift. */
  gatewayDropInBody?: string;
  /** The `/etc/sudoers.d/hermetic-apt` body; change it to exercise a re-validation. */
  sudoersBody?: string;
  /**
   * Who the managed Hermes config belongs to. `root` on a real box; set it to
   * an account hermeticd does not create to exercise the refusal.
   */
  owner?: string;
  /**
   * A browser agent: the `browsers` list core derives from `browser: true`
   * (`browserIdentities`), plus the Chrome build it pins. Defaults to no
   * browser, which is what most of the suite is about.
   */
  browser?: boolean;
  /** The pinned Chrome for Testing build; only read when `browser` is true. */
  chrome_ref?: string;
  /** Override the identities themselves, for the cases core would never render. */
  browsers?: BrowserIdentity[];
  /**
   * The approvals mode the manifest states, and therefore what `verify-hermes`
   * expects Hermes to resolve. Defaults to `off`, which is what core renders
   * for an agent whose operator said nothing; `null` omits the field, which is
   * what a document rendered before it looks like.
   */
  approvals_mode?: AgentConfig["approvals_mode"] | null;
}

/** The Chrome build the browser fixtures pin. */
export const TEST_CHROME_REF = "153.0.8010.12";

const hermeticdUnit = `[Unit]
Description=hermeticd node agent (0.1.0)

[Service]
ExecStart=/usr/local/bin/hermeticd serve
`;

export function makeManifest(overrides: ManifestOverrides = {}): AgentConfig {
  const secrets_mode = overrides.secrets_mode ?? "none";
  /*
   * `browser: false` no longer means "an agent without one" — there is no such
   * agent. It means **a manifest that names no browsers**, which is what a
   * document rendered before the browser stack looks like, and hermeticd still
   * has to keep applying one of those. Defaulted off so that every test which
   * is not about the browser exercises that older shape.
   */
  const browsers = overrides.browsers ?? (overrides.browser ? browserIdentities() : []);
  const files = [
    {
      path: "/etc/hermetic/nftables.hermetic.nft",
      mode: "0644",
      content: "#!/usr/sbin/nft -f\nflush ruleset\ntable inet hermetic { }\n",
    },
    {
      path: "/etc/hermes/config.yaml",
      mode: "0640",
      content: overrides.hermesConfigBody ?? 'model:\n  provider: "bedrock"\n',
      // Root-owned so Hermes treats /etc/hermes as its managed scope; group
      // `hermes` so the service can still read it (see `render.ts`).
      owner: overrides.owner ?? "root",
      group: overrides.owner ?? "hermes",
      // A file that names units it is not: both Hermes processes read it.
      restart_units: overrides.configRestartUnits ?? [
        "hermes-dashboard.service",
        "hermes-gateway.service",
      ],
    },
    {
      path: "/etc/systemd/system/hermes-dashboard.service",
      mode: "0644",
      content:
        overrides.hermesUnitBody ??
        "[Service]\nExecStart=/usr/local/bin/hermes serve --host 127.0.0.1 --port 9119\n",
    },
    {
      path: "/etc/systemd/system/hermeticd.service",
      mode: "0644",
      content: hermeticdUnit,
    },
    /**
     * hermetic's half of upstream's gateway unit (§6.4). It is in the fixture
     * because it is in every manifest core renders, and because it is the one
     * rendered file that reaches a unit hermeticd did not write — the path is
     * under `/etc/systemd/system` but is not `<unit>`, so only its
     * `restart_units` gets the gateway bounced.
     */
    {
      path: "/etc/systemd/system/hermes-gateway.service.d/hermetic.conf",
      mode: "0644",
      content:
        overrides.gatewayDropInBody ??
        "[Unit]\nRequires=hermetic-secrets.service\n\n[Service]\nEnvironmentFile=/run/hermetic/secrets.env\n",
      restart_units: ["hermes-gateway.service"],
    },
    // The agent's sudoers grant (§6.4). It is in the fixture rather than in
    // one test's manifest because it is in every manifest core renders, and
    // because it is the one rendered file apply validates before installing —
    // every apply test should be walking that path.
    {
      path: "/etc/sudoers.d/hermetic-apt",
      mode: "0440",
      content: overrides.sudoersBody ?? "hermes ALL=(ALL:ALL) NOPASSWD: ALL\n",
      owner: "root",
      group: "root",
    },
  ];

  return parseManifest({
    schema_version: 1,
    name: TEST_NAME,
    size: "medium",
    instance_type: "t4g.2xlarge",
    provider: overrides.provider ?? "bedrock",
    secrets_mode,
    // Omitted together when this fixture stands for a pre-browser-stack
    // manifest, exactly as such a document omits them.
    ...(browsers.length > 0 ? { browsers, chrome_ref: overrides.chrome_ref ?? TEST_CHROME_REF } : {}),
    hermes_version: overrides.hermes_version ?? "0.21.0",
    hermes_ref: overrides.hermes_ref ?? "v2026.8.31",
    // What core renders for an agent whose operator said nothing about
    // approvals (`HERMES_DEFAULTS`), and therefore what `verify-hermes` expects
    // Hermes to resolve. `null` renders the older document that states no mode.
    ...(overrides.approvals_mode === null ? {} : { approvals_mode: overrides.approvals_mode ?? "off" }),
    config_hash: "abc123def4567890",
    // `git` is in core's rendered list because Hermes installs from a checkout.
    packages: overrides.packages ?? [
      "curl",
      "git",
      "jq",
      "nftables",
      ...(secrets_mode === "bitwarden" ? ["bws"] : []),
    ],
    apt_sources: overrides.apt_sources ?? [
      {
        name: "tailscale",
        uri: "https://pkgs.tailscale.com/stable/ubuntu noble main",
        key_url: "https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg",
      },
    ],
    files,
    units: overrides.units ?? [
      "hermeticd.service",
      "hermes-dashboard.service",
      "hermes-gateway.service",
    ],
    // No account here, exactly as `render.ts` no longer renders one: the
    // `hermes` user is hermeticd's `ensureAccounts` step, which runs before
    // files and units rather than after them.
    commands: overrides.commands ?? ["nft -f /etc/hermetic/nftables.hermetic.nft"],
    tailscale_serve: {
      enabled: true,
      hostname: overrides.tailscale_hostname ?? TEST_NAME,
      routes: [{ path: "/", target: "http://127.0.0.1:9119", description: "Hermes dashboard" }],
    },
  });
}

export const TEST_BUCKET = "hermetic-fleet-123456789012";
export const TEST_FLEET_ID = "fxtr0001";
/** What a v4 box is called: `<fleet id>-<agent>` (core's `cloudName`). */
export const TEST_HOSTNAME = `${TEST_FLEET_ID}-${TEST_NAME}`;
export const TEST_AGENTS_TABLE = "hermetic-fxtr0001-agents";
export const TEST_EVENTS_TABLE = "hermetic-fxtr0001-events";
export const TEST_VERSION = "0.1.0";

/** The exact user-data JSON core's `userData()` writes (§6.2 step 7). */
export function makeUserDataJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: TEST_NAME,
    hostname: TEST_HOSTNAME,
    bucket: TEST_BUCKET,
    hermeticd_url: `https://${TEST_BUCKET}.s3.us-east-1.amazonaws.com/artifacts/0.1.0/hermeticd?X-Amz-Signature=deadbeef`,
    hermeticd_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ...overrides,
  });
}

export function sha256Of(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The stage set the fixtures ship: three files, in order, with real digests. */
export const TEST_STAGE_BODIES: Readonly<Record<string, string>> = {
  "00-preflight.sh": "#!/usr/bin/env bash\nset -euo pipefail\necho preflight\n",
  "01-tailscale.sh": "#!/usr/bin/env bash\nset -euo pipefail\necho tailscale\n",
  "02-data-volume.sh": "#!/usr/bin/env bash\nset -euo pipefail\necho volume\n",
};

/**
 * The release generation the fixtures publish under
 * (`artifacts/<version>/<generation>/…`). A literal rather than a computed
 * digest: these bodies are stand-ins, so the id only has to be *a* generation,
 * and a fixed one keeps the keys in failure output readable.
 */
export const TEST_GENERATION = "a1b2c3d4e5f60718";

export interface FleetManifestOverrides {
  version?: string;
  /**
   * The generation the release is published under. `null` produces the flat
   * pre-generation keys an older hermetic wrote, which every box still has to
   * be able to fetch from.
   */
  generation?: string | null;
  /** Stage file name → body. Defaults to `TEST_STAGE_BODIES`. */
  stages?: Readonly<Record<string, string>>;
  /** The hermeticd binary bytes to publish a digest for; omitted when null. */
  binary?: string | null;
  /** Digests written into the manifest that do NOT match the bytes served. */
  corrupt?: Readonly<Record<string, string>>;
  /**
   * Mirrored Chrome builds: `chrome_ref` → the zip's bytes. The digest and the
   * length recorded are of those very bytes, so a test that wants a mismatch
   * has to ask for one (`corruptBrowser`) rather than getting one by accident.
   */
  browser?: Readonly<Record<string, string | Uint8Array>>;
  /** Digests and sizes for `browser` entries that do NOT match the bytes. */
  corruptBrowser?: Readonly<Record<string, { sha256?: string; size?: number }>>;
}

/**
 * Which release file, if any, the manifest records at `key` — and `null` for
 * every other key in the bucket.
 *
 * Every S3 double below resolves through this, which makes "the box fetches
 * exactly the objects the manifest records" a property of the whole suite
 * rather than of one test. A consumer that rebuilds `artifacts/<version>/…`
 * from the version label gets `NoSuchKey`, which is what it deserves: a release
 * is an immutable generation and the manifest is the only thing that knows
 * which one is live.
 */
export function releaseFileAt(fleet: FleetManifest, key: string): string | null {
  for (const [name, entry] of Object.entries(fleet.hermeticd.files)) {
    if (entry.key === key) return name;
  }
  return null;
}

/**
 * The fleet manifest as `artifacts.ts` writes it (§1). Digests are computed
 * from the very bodies `makeS3` serves, so a test that wants a mismatch has to
 * ask for one (`corrupt`) rather than getting one by accident.
 */
export function makeFleetManifest(overrides: FleetManifestOverrides = {}): FleetManifest {
  const version = overrides.version ?? TEST_VERSION;
  const generation = overrides.generation === undefined ? TEST_GENERATION : overrides.generation;
  const keyOf = (file: string): string => releaseKey(version, file, generation ?? undefined);
  const stages = overrides.stages ?? TEST_STAGE_BODIES;
  const binary = overrides.binary === undefined ? "ELF-hermeticd" : overrides.binary;
  const files: Record<string, { key: string; sha256: string; size: number }> = {};
  if (binary !== null) {
    files["hermeticd"] = {
      key: keyOf("hermeticd"),
      sha256: overrides.corrupt?.["hermeticd"] ?? sha256Of(binary),
      size: binary.length,
    };
  }
  for (const [file, body] of Object.entries(stages)) {
    files[`stages/${file}`] = {
      key: keyOf(`stages/${file}`),
      sha256: overrides.corrupt?.[`stages/${file}`] ?? sha256Of(body),
      size: body.length,
    };
  }

  const browser: Record<string, { key: string; sha256: string; size: number; url: string }> = {};
  for (const [ref, body] of Object.entries(overrides.browser ?? {})) {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const wrong = overrides.corruptBrowser?.[ref];
    browser[ref] = {
      key: browserBuildKey(ref),
      sha256: wrong?.sha256 ?? sha256Of(bytes),
      size: wrong?.size ?? bytes.byteLength,
      url: `https://cdn.playwright.dev/builds/cft/${ref}/linux-arm64/chrome-linux-arm64.zip`,
    };
  }

  return FleetManifestSchema.parse({
    schema_version: 1,
    fleet_id: "fxtr0001",
    region: "us-east-1",
    hermetic_version: "0.1.0",
    hermeticd: { version, ...(generation === null ? {} : { generation }), files },
    ...(Object.keys(browser).length > 0 ? { browser } : {}),
    resources: {
      bucket: TEST_BUCKET,
      stack_id:
        "arn:aws:cloudformation:us-east-1:123456789012:stack/hermetic-fxtr0001/11111111-2222-3333-4444-555555555555",
      agents_table: TEST_AGENTS_TABLE,
      events_table: TEST_EVENTS_TABLE,
      param_prefix: "/hermes/",
      vpc_id: "vpc-0123456789abcdef0",
      subnet_ids: ["subnet-0123456789abcdef0"],
      security_group_id: "sg-0123456789abcdef0",
      instance_profile_arn: "arn:aws:iam::123456789012:instance-profile/hermetic-fxtr0001",
      role_arn: "arn:aws:iam::123456789012:role/hermetic-fxtr0001",
    },
    updated_at: "2026-09-01T00:00:00.000Z",
    updated_by: "evan@example.com",
  });
}

/** Captured commands, in order, exactly as the SDK would have received them. */
export class RecordingSink implements CommandSink {
  readonly calls: unknown[] = [];
  /** Queue of responses (or thrown errors) consumed in order. */
  readonly responses: Array<unknown | Error> = [];
  /** Per-constructor-name overrides, consulted before `responses`. */
  readonly byCommand = new Map<string, (command: unknown) => unknown>();

  async send(command: unknown): Promise<unknown> {
    this.calls.push(command);
    const named = this.byCommand.get(command?.constructor?.name ?? "");
    if (named) {
      const result = named(command);
      if (result instanceof Error) throw result;
      return result;
    }
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    return next ?? {};
  }

  /** `mock.commandCalls(UpdateCommand)`, hand-rolled. */
  commandCalls<T>(ctor: new (...args: never[]) => T): T[] {
    return this.calls.filter((c): c is T => c instanceof ctor);
  }
}

/** A `ConditionalCheckFailedException` as the SDK surfaces it. */
export function conditionalCheckFailed(): Error {
  const e = new Error("The conditional request failed");
  e.name = "ConditionalCheckFailedException";
  return e;
}
