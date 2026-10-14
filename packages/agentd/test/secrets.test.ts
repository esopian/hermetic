/**
 * `hermeticd secrets materialise` and the environment file it writes (§8.3).
 *
 * The thing being pinned here is that the file is *always* written: core's
 * rendered `hermes-dashboard.service` names it in an unconditional `EnvironmentFile=`,
 * and systemd refuses to start a unit whose environment file is missing — so a
 * Bedrock box with no provider key and no Bitwarden project still has to end up
 * with an empty file, not with none.
 *
 * There is deliberately nothing here about a dashboard login. Hermes runs in
 * local mode behind a loopback nginx proxy, so the box has no browser gate to
 * configure and hermeticd writes no `HERMES_DASHBOARD_*` variables at all.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { GetParameterCommand, GetParametersByPathCommand } from "@aws-sdk/client-ssm";
import { FILES_SECRET_DIR, encodeSecretEnvelope } from "@hermetic/core/shared";
import { envLine, materialiseSecrets, SECRETS_ENV_DIR, SECRETS_ENV_PATH } from "../src/apply/index.ts";
import { makeAws } from "../src/aws.ts";
import { FLEET_CACHE_PATH } from "../src/fleet.ts";
import { MANIFEST_PATH } from "../src/manifest.ts";
import { run } from "../src/main.ts";
import { USER_DATA_JSON_PATH } from "../src/userdata.ts";
import { BoxHost as FakeHost } from "./fake-box.ts";
import {
  RecordingSink,
  TEST_AGENTS_TABLE,
  TEST_EVENTS_TABLE,
  makeFleetManifest,
  makeManifest,
  makeUserDataJson,
  type ManifestOverrides,
} from "./fixtures.ts";
import { captureOutput } from "./quiet.ts";

// The commands these tests drive write their progress and log lines to the
// process's own streams; kept out of the run's output (`quiet.ts`).
captureOutput();

const HOSTNAME = "research-1.tail1234.ts.net";

/** `ParameterNotFound` as the SSM client surfaces it: a name, not a status. */
function parameterNotFound(): Error {
  const e = new Error("Parameter not found");
  e.name = "ParameterNotFound";
  return e;
}

interface RigOptions extends ManifestOverrides {
  /** Values for this agent's own slots, by slot name. */
  slots?: Readonly<Record<string, string>>;
  /** `bws secret list` output, when the manifest asks for Bitwarden. */
  bitwardenSecrets?: ReadonlyArray<{ key: string; value: string }>;
}

function rig(options: RigOptions = {}) {
  const { slots = {}, bitwardenSecrets, ...manifestOverrides } = options;
  const host = new FakeHost();
  if (bitwardenSecrets) {
    host.handlers.push((argv) =>
      argv[0] === "bws" ? { code: 0, stdout: JSON.stringify(bitwardenSecrets), stderr: "" } : null,
    );
  }
  host.seed(USER_DATA_JSON_PATH, makeUserDataJson());
  host.seed(FLEET_CACHE_PATH, JSON.stringify(makeFleetManifest()));
  host.seed(
    MANIFEST_PATH,
    JSON.stringify(makeManifest({ tailscale_hostname: HOSTNAME, ...manifestOverrides })),
  );

  const ssm = new RecordingSink();
  ssm.byCommand.set("GetParameterCommand", (command) => {
    const name = (command as GetParameterCommand).input.Name ?? "";
    const slot = name.slice(name.lastIndexOf("/") + 1);
    const value = slots[slot];
    if (value === undefined) throw parameterNotFound();
    return { Parameter: { Value: value } };
  });
  // The durable file secrets are listed, one level, under the same prefix.
  ssm.byCommand.set("GetParametersByPathCommand", (command) => {
    const path = (command as GetParametersByPathCommand).input.Path ?? "";
    return {
      Parameters: Object.entries(slots).map(([slot, value]) => ({
        Name: `${path}/${slot}`,
        Value: value,
      })),
    };
  });

  const aws = makeAws({
    ddb: new RecordingSink(),
    ssm,
    s3: new RecordingSink(),
    agentsTable: TEST_AGENTS_TABLE,
    eventsTable: TEST_EVENTS_TABLE,
    now: () => host.now(),
  });

  return {
    host,
    ssm,
    materialise: () => run(["secrets", "materialise"], host, { aws: () => aws }),
    apply: () => run(["apply"], host, { aws: () => aws }),
    env: () => host.files.get(SECRETS_ENV_PATH)?.content ?? null,
  };
}

/** Everything the command wrote to stderr while it ran. */
async function captureStderr(body: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await body();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

describe("the tmpfs environment file (§8.3)", () => {
  test("a keyed provider's slot becomes its one variable, and nothing else", async () => {
    const r = rig({ provider: "nous", slots: { "provider-key": "nous-FIXTURE-KEY" } });

    let code = -1;
    await captureStderr(async () => void (code = await r.materialise()));

    expect(code).toBe(0);
    expect(r.env()).toBe("NOUS_API_KEY=nous-FIXTURE-KEY\n");
    expect(host0600(r.host)).toBe(true);
    // Local-mode Hermes has no browser gate, so no box writes one.
    expect(r.env()).not.toContain("HERMES_DASHBOARD");
    // This agent's own subtree, and only it — no fleet-wide slot is read.
    expect(r.ssm.commandCalls(GetParameterCommand).map((c) => c.input.Name)).toEqual([
      "/hermes/research-1/provider-key",
    ]);
    // Nothing waited on: there is no read here that is allowed to be retried.
    expect(r.host.sleeps).toEqual([]);
  });

  test("bedrock with no bitwarden project still writes an empty environment file", async () => {
    // Bedrock authenticates by instance role, so there is no provider key
    // either: nothing whatsoever to put in the file, which must exist anyway.
    const r = rig({ provider: "bedrock", secrets_mode: "none" });

    let code = -1;
    const stderr = await captureStderr(async () => void (code = await r.materialise()));

    expect(code).toBe(0);
    expect(r.env()).toBe("\n");
    expect(host0600(r.host)).toBe(true);
    expect(stderr).toContain("writing an empty environment file");
    // A box with nothing to fetch asks SSM for nothing at all.
    expect(r.ssm.commandCalls(GetParameterCommand)).toEqual([]);
  });

  test("a bitwarden project's secrets are listed into the same file", async () => {
    const r = rig({
      provider: "bedrock",
      secrets_mode: "bitwarden",
      slots: { "bws-token": "0.FIXTURE.token" },
      bitwardenSecrets: [{ key: "GITHUB_TOKEN", value: "FIXTURE-gh" }],
    });

    let code = -1;
    await captureStderr(async () => void (code = await r.materialise()));

    expect(code).toBe(0);
    expect(r.env()).toBe("GITHUB_TOKEN=FIXTURE-gh\n");
    expect(host0600(r.host)).toBe(true);
    // The token reaches `bws` through the environment, never through argv.
    expect(r.host.commandsMatching(/^bws /)[0]).not.toContain("0.FIXTURE.token");
  });

  /**
   * Without the provider key Hermes cannot serve at all, so a read that fails
   * there fails the unit rather than starting a box that will only ever 401 its
   * model provider.
   */
  test("a provider key that cannot be read is still fatal", async () => {
    const r = rig({ provider: "nous", slots: { "provider-key": "nous-FIXTURE-KEY" } });
    r.ssm.byCommand.set("GetParameterCommand", () => {
      const e = new Error("User is not authorized to perform: ssm:GetParameter");
      e.name = "AccessDeniedException";
      return e;
    });

    await expect(captureStderr(async () => void (await r.materialise()))).rejects.toThrow(
      /not authorized/,
    );
    expect(r.env()).toBe(null);
  });

  /**
   * `apply` rewrites `secrets.env` whole on a box whose provider needs a key,
   * which makes it the second author of a file `hermetic-secrets.service` also
   * writes. The two must agree byte for byte, or every apply would flap the
   * file and restart Hermes for nothing.
   */
  test("`hermeticd apply` writes exactly what `secrets materialise` wrote", async () => {
    const r = rig({ provider: "nous", slots: { "provider-key": "nous-FIXTURE-KEY" } });

    let code = -1;
    await captureStderr(async () => void (code = await r.apply()));

    expect(code).toBe(0);
    expect(r.env()).toBe("NOUS_API_KEY=nous-FIXTURE-KEY\n");
    expect(host0600(r.host)).toBe(true);
  });

  /**
   * `/run/hermetic` is 0711 now — traversable by `hermes`, still not listable —
   * and a box booted before that has a 0700 one, which `mkdir` would leave as
   * it is. So the mode is set, not just asked for.
   */
  test("the tmpfs directory is made 0711 even when it already existed", async () => {
    const r = rig({ provider: "bedrock", secrets_mode: "none" });
    r.host.dirs.add(SECRETS_ENV_DIR);

    await captureStderr(async () => void (await r.materialise()));

    expect(r.host.chmods).toContainEqual([SECRETS_ENV_DIR, "0711"]);
    expect(host0600(r.host)).toBe(true);
  });

  /**
   * `hermeticd apply` (stage 04, and a converge) re-materialises the durable
   * file secrets from SSM — even on a Bedrock box, where no other slot is read
   * and so no AWS context would otherwise exist.
   */
  test("`hermeticd apply` re-materialises the durable file secrets", async () => {
    const bytes = new TextEncoder().encode("FIXTURE-PEM\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const r = rig({
      provider: "bedrock",
      secrets_mode: "none",
      slots: { "file-app-pem": encodeSecretEnvelope({ name: "app.pem", bytes, sha256 }) },
    });

    let code = -1;
    await captureStderr(async () => void (code = await r.apply()));

    expect(code).toBe(0);
    expect(r.host.files.get(`${FILES_SECRET_DIR}/app.pem`)?.mode).toBe("0600");
    expect(r.host.commands).toContain(`chown hermes:hermes -- ${FILES_SECRET_DIR}/app.pem`);
    expect(r.ssm.commandCalls(GetParametersByPathCommand).map((c) => c.input.Path)).toEqual([
      "/hermes/research-1",
    ]);
  });
});

describe("Aws.getParametersByPath", () => {
  test("follows NextToken to the last page, one level, decrypted", async () => {
    const ssm = new RecordingSink();
    ssm.responses.push(
      {
        Parameters: [
          { Name: "/p/a", Value: "1" },
          { Name: "/p/b", Value: "2" },
        ],
        NextToken: "t1",
      },
      { Parameters: [{ Name: "/p/c", Value: "3" }], NextToken: "t2" },
      { Parameters: [] },
    );
    const aws = makeAws({
      ddb: new RecordingSink(),
      ssm,
      s3: new RecordingSink(),
      agentsTable: TEST_AGENTS_TABLE,
      eventsTable: TEST_EVENTS_TABLE,
      now: () => new Date(0),
    });

    expect(await aws.getParametersByPath("/p")).toEqual([
      { name: "/p/a", value: "1" },
      { name: "/p/b", value: "2" },
      { name: "/p/c", value: "3" },
    ]);
    const inputs = ssm.commandCalls(GetParametersByPathCommand).map((c) => c.input);
    expect(inputs.map((i) => i.NextToken)).toEqual([undefined, "t1", "t2"]);
    expect(
      inputs.every((i) => i.Path === "/p" && i.Recursive === false && i.WithDecryption === true),
    ).toBe(true);
  });
});

describe("EnvironmentFile quoting", () => {
  /**
   * systemd's env-file parser is not a shell: it strips a value's outer
   * whitespace and lets a leading quote open a string. A provider key never
   * contains either, but a secret out of the operator's own Bitwarden project
   * can contain anything at all.
   */
  test("a value with a space and a # round-trips", async () => {
    const host = new FakeHost();
    host.handlers.push((argv) =>
      argv[0] === "bws"
        ? {
            code: 0,
            stdout: JSON.stringify([{ key: "NOTE", value: "corr#ect horse #battery" }]),
            stderr: "",
          }
        : null,
    );

    await materialiseSecrets({
      host,
      bitwarden: { token: "0.FIXTURE.token", project: "research-1" },
    });

    expect(host.files.get(SECRETS_ENV_PATH)?.content).toBe("NOTE='corr#ect horse #battery'\n");
  });

  test("quotes and backslashes are escaped the way systemd unescapes them", () => {
    expect(envLine("K", "plain-value_1.2/3:4")).toBe("K=plain-value_1.2/3:4");
    expect(envLine("K", "it's")).toBe("K='it\\'s'");
    expect(envLine("K", "back\\slash")).toBe("K='back\\\\slash'");
    // Leading and trailing spaces survive only inside quotes.
    expect(envLine("K", " padded ")).toBe("K=' padded '");
    expect(envLine("K", "")).toBe("K=''");
  });
});

/** The file and the tmpfs directory above it are both closed to other accounts. */
function host0600(host: FakeHost): boolean {
  return host.files.get(SECRETS_ENV_PATH)?.mode === "0600";
}
