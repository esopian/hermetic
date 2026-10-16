/**
 * The file and secret request cards (`src/chat/blocks/FileRequest.tsx`,
 * `SecretText.tsx`) over a scripted files client: each state draws from the
 * box's slot, the actions reach `fulfil`, `secret` and `decline`, and a text
 * secret's value never appears in the rendered tree.
 */
import type { FileRequest } from "@hermetic/core/schema";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { Block } from "../../src/chat/blocks/Block.tsx";
import { sections } from "../../src/client/chat-activity.ts";
import type { RequestToolBlock } from "../../src/client/file-request-logic.ts";
import type { PhoneFiles } from "../../src/gateway/files.ts";
import { flush } from "../helpers/fakes.ts";
import { tool } from "../helpers/fixtures.ts";
import { NOW, renderUi, scope } from "../helpers/render.tsx";

const mockPick = {
  pickDocument: jest.fn(async () => [] as unknown[]),
  pickFromLibrary: jest.fn(async () => [] as unknown[]),
  readBytes: jest.fn(async () => new Uint8Array(0)),
  discardPicked: jest.fn((file: { uri: string }) => void mockDeleted.push(file.uri)),
};
/** The picker's cache copies the card let go, by URI (`discardPicked`). */
const mockDeleted: string[] = [];
jest.mock("../../src/client/pick-attachment.ts", () => ({
  discardPicked: (file: { uri: string }) => mockPick.discardPicked(file),
  pickDocument: (...a: unknown[]) => mockPick.pickDocument(...(a as [])),
  pickFromLibrary: (...a: unknown[]) => mockPick.pickFromLibrary(...(a as [])),
  readBytes: (...a: unknown[]) => mockPick.readBytes(...(a as [])),
}));

/** A sentinel standing for a secret value: it must never reach the tree. */
const FIXTURE_SECRET_VALUE = "FIXTURE_SECRET_VALUE";
const ID = "fr_fxphone00001";
const LATER = new Date(NOW + 3_600_000).toISOString();
const EARLIER = new Date(NOW - 60_000).toISOString();

function slot(over: Partial<FileRequest> = {}): FileRequest {
  return {
    request_id: ID,
    kind: "file",
    purpose: "The raw access log for the incident window.",
    name_hint: "access.log",
    accept: [".log", ".txt"],
    max_bytes: 1024 * 1024,
    sensitivity: "normal",
    durable: false,
    state: "open",
    created_at: EARLIER,
    expires_at: LATER,
    session_id: "s-1",
    ...over,
  };
}

const textSlot = (over: Partial<FileRequest> = {}): FileRequest =>
  slot({
    kind: "secret_text",
    purpose: "A GitHub token with repo scope.",
    accept: [],
    sensitivity: "secret",
    durable: true,
    keys: ["GITHUB_TOKEN"],
    slug: "github",
    input: "auto",
    name_hint: undefined,
    ...over,
  });

const DELIVERED = {
  path: "/data/hermes/files/inbox/2026-10-13/f_1/access.log",
  sha256: "a".repeat(64),
  bytes: 12,
  by: "operator@example.com",
  at: new Date(NOW).toISOString(),
  class: "file" as const,
};

function requestBlock(over: Partial<RequestToolBlock> = {}): RequestToolBlock {
  return {
    ...tool({ tool_id: "tl-1", name: "request_file", args: { purpose: "model words" } }),
    render: "file_request",
    request_id: ID,
    ...over,
  } as RequestToolBlock;
}

/** A files client whose slot is `current`, changed by what the card does. */
function fakeFiles(initial: FileRequest | Error) {
  let current = initial;
  const files: PhoneFiles = {
    capability: jest.fn(async () => true),
    stage: jest.fn(),
    commit: jest.fn(),
    content: jest.fn(),
    requests: jest.fn(async () => (current instanceof Error ? [] : [current])),
    request: jest.fn(async () => {
      if (current instanceof Error) throw current;
      return current;
    }),
    fulfil: jest.fn(async (request_id) => {
      if (!(current instanceof Error))
        current = { ...current, state: "fulfilled", fulfilled: DELIVERED };
      return { request_id, ...DELIVERED };
    }),
    secret: jest.fn(async (request_id) => {
      if (!(current instanceof Error)) {
        current = {
          ...current,
          state: "fulfilled",
          fulfilled: {
            ...DELIVERED,
            class: "secret",
            path: "/run/hermetic/drop/x/github.env",
            keys: ["GITHUB_TOKEN"],
            format: "raw",
          },
        };
      }
      return { request_id, ...DELIVERED, class: "secret" as const };
    }),
    decline: jest.fn(async () => {
      if (current instanceof Error) throw current;
      current = { ...current, state: "declined", declined: { at: new Date(NOW).toISOString() } };
      return current;
    }),
  };
  return { files, set: (next: FileRequest) => (current = next) };
}

async function draw(block: RequestToolBlock, files: PhoneFiles | null, over = {}) {
  const view = await renderUi(
    <Block block={block} now={NOW} session="s-1" />,
    scope({ files, bot: "scribe", ...over }),
  );
  await act(flush);
  return view;
}

/** Everything the tree renders, props included, as one string. */
const tree = (): string => JSON.stringify(screen.toJSON());

beforeEach(() => {
  mockDeleted.length = 0;
  mockPick.pickDocument.mockReset().mockResolvedValue([]);
  mockPick.pickFromLibrary.mockReset().mockResolvedValue([]);
  mockPick.readBytes.mockReset().mockResolvedValue(new Uint8Array(0));
});

describe("the transcript's split", () => {
  test("a request tool stands alone instead of folding into Tools complete", () => {
    const list = sections([tool({ tool_id: "a" }), requestBlock(), tool({ tool_id: "b" })]);
    expect(list.map((s) => [s.activity, s.blocks.length])).toEqual([
      [true, 1],
      [false, 1],
      [true, 1],
    ]);
  });
});

describe("file request card", () => {
  test("open: the box's purpose and accept list, the warn rule, Choose file and Decline", async () => {
    const { files } = fakeFiles(slot());
    await draw(requestBlock(), files);
    expect(screen.getByText("“The raw access log for the incident window.”")).toBeTruthy();
    expect(screen.queryByText("“model words”")).toBeNull();
    expect(screen.getByText(/\.log \.txt · ≤ 1 MB/)).toBeTruthy();
    expect(screen.getByText("File requested")).toBeTruthy();
    expect(screen.getByLabelText("Choose file")).toBeTruthy();
    expect(screen.getByLabelText("Decline")).toBeTruthy();
    const card = screen.getByTestId(`file-request-${ID}`);
    expect(card.props.style.borderLeftWidth).toBe(3);
  });

  test("Choose file reads the pick and fulfils the slot; the card then says delivered", async () => {
    const { files } = fakeFiles(slot());
    mockPick.pickDocument.mockResolvedValue([
      { name: "access.log", uri: "file:///tmp/access.log", size: 12, kind: "file" },
    ]);
    mockPick.readBytes.mockResolvedValue(new TextEncoder().encode("hello, agent"));
    await draw(requestBlock(), files);
    await fireEvent.press(screen.getByLabelText("Choose file"));
    await act(flush);
    await act(flush);
    expect(files.fulfil).toHaveBeenCalledWith(
      ID,
      expect.objectContaining({ name: "access.log", bytes: expect.any(Uint8Array) }),
    );
    expect((await screen.findAllByText("delivered")).length).toBeGreaterThan(0);
    // The picker's cache copy is gone once read.
    expect(mockDeleted).toEqual(["file:///tmp/access.log"]);
    expect(screen.queryByLabelText("Choose file")).toBeNull();
  });

  test("a pick over the slot's cap is refused before it is read, and its cache copy deleted", async () => {
    const { files } = fakeFiles(slot());
    mockPick.pickDocument.mockResolvedValue([
      { name: "big.log", uri: "file:///tmp/big.log", size: 2 * 1024 * 1024, kind: "file" },
    ]);
    await draw(requestBlock(), files);
    await fireEvent.press(screen.getByLabelText("Choose file"));
    await act(flush);
    expect(mockPick.readBytes).not.toHaveBeenCalled();
    expect(files.fulfil).not.toHaveBeenCalled();
    expect(screen.getByText(/the file is 2\.0 MB; this request takes at most 1 MB/)).toBeTruthy();
    expect(mockDeleted).toEqual(["file:///tmp/big.log"]);
  });

  test("a pick whose extension no .ext accept entry names is refused before it is read", async () => {
    const { files } = fakeFiles(slot());
    mockPick.pickDocument.mockResolvedValue([
      {
        name: "report.pdf",
        uri: "file:///tmp/report.pdf",
        mime: "application/pdf",
        size: 10,
        kind: "file",
      },
    ]);
    await draw(requestBlock(), files);
    await fireEvent.press(screen.getByLabelText("Choose file"));
    await act(flush);
    expect(mockPick.readBytes).not.toHaveBeenCalled();
    expect(files.fulfil).not.toHaveBeenCalled();
    expect(
      screen.getByText(/this request accepts \.log \.txt; the file has another extension/),
    ).toBeTruthy();
    expect(mockDeleted).toEqual(["file:///tmp/report.pdf"]);
  });

  test("a MIME accept entry is left to the box's sniff, not the picker's type", async () => {
    const { files } = fakeFiles(slot({ accept: ["application/yaml"] }));
    mockPick.pickDocument.mockResolvedValue([
      {
        name: "deploy.yaml",
        uri: "file:///tmp/deploy.yaml",
        mime: "application/x-yaml",
        size: 12,
        kind: "file",
      },
    ]);
    mockPick.readBytes.mockResolvedValue(new TextEncoder().encode("name: FIXTURE\n"));
    await draw(requestBlock(), files);
    await fireEvent.press(screen.getByLabelText("Choose file"));
    await act(flush);
    expect(mockPick.readBytes).toHaveBeenCalledWith("file:///tmp/deploy.yaml");
    expect(files.fulfil).toHaveBeenCalledWith(ID, expect.objectContaining({ name: "deploy.yaml" }));
  });

  test("a pick that resolves after the card left is neither read nor sent", async () => {
    const { files } = fakeFiles(slot());
    let resolvePick!: (v: unknown[]) => void;
    mockPick.pickDocument.mockReturnValue(
      new Promise<unknown[]>((r) => {
        resolvePick = r;
      }),
    );
    const view = await draw(requestBlock(), files);
    await fireEvent.press(screen.getByLabelText("Choose file"));
    await view.unmount();
    resolvePick([{ name: "access.log", uri: "file:///tmp/access.log", size: 12, kind: "file" }]);
    await act(flush);
    expect(mockPick.readBytes).not.toHaveBeenCalled();
    expect(files.fulfil).not.toHaveBeenCalled();
    expect(mockDeleted).toEqual(["file:///tmp/access.log"]);
  });

  test("a failed read still deletes the cache copy", async () => {
    const { files } = fakeFiles(slot());
    mockPick.pickDocument.mockResolvedValue([
      { name: "access.log", uri: "file:///tmp/access.log", size: 12, kind: "file" },
    ]);
    mockPick.readBytes.mockRejectedValue(new Error("unreadable"));
    await draw(requestBlock(), files);
    await fireEvent.press(screen.getByLabelText("Choose file"));
    await act(flush);
    expect(files.fulfil).not.toHaveBeenCalled();
    expect(mockDeleted).toEqual(["file:///tmp/access.log"]);
  });

  test("a key-looking pick on a normal request asks first", async () => {
    const { files } = fakeFiles(slot({ accept: [] }));
    mockPick.pickDocument.mockResolvedValue([
      { name: "id_rsa", uri: "file:///tmp/id_rsa", size: 40, kind: "file" },
    ]);
    mockPick.readBytes.mockResolvedValue(
      new TextEncoder().encode("-----BEGIN OPENSSH PRIVATE KEY-----\nFIXTURE\n"),
    );
    await draw(requestBlock(), files);
    await fireEvent.press(screen.getByLabelText("Choose file"));
    await act(flush);
    expect(await screen.findByText(/Looks like a private key/)).toBeTruthy();
    expect(files.fulfil).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText("This isn't a secret"));
    await act(flush);
    expect(files.fulfil).toHaveBeenCalledWith(ID, expect.objectContaining({ not_secret: true }));
  });

  test("Decline reaches the box; the card says the agent was told", async () => {
    const { files } = fakeFiles(slot());
    await draw(requestBlock(), files);
    await fireEvent.press(screen.getByLabelText("Decline"));
    await act(flush);
    await act(flush);
    expect(files.decline).toHaveBeenCalledWith(ID);
    expect(await screen.findByText("You declined. scribe was told.")).toBeTruthy();
  });

  test("expired: no actions, the desktop's wording", async () => {
    const { files } = fakeFiles(
      slot({
        state: "expired",
        expires_at: EARLIER,
        created_at: new Date(NOW - 7_200_000 - 60_000).toISOString(),
      }),
    );
    await draw(requestBlock({ status: "ok", result: { status: "expired" } }), files);
    expect(screen.getByText(/No file within .*\. Ask scribe to request again\./)).toBeTruthy();
    expect(screen.queryByLabelText("Choose file")).toBeNull();
  });

  test("delivered after the turn ended: offers to tell the agent, once", async () => {
    const { files } = fakeFiles(slot({ state: "fulfilled", fulfilled: DELIVERED }));
    const retry = jest.fn(() => true);
    await draw(requestBlock({ status: "ok", result: { status: "pending" } }), files, { retry });
    expect(screen.getByText("delivered after the turn ended")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Tell scribe & continue"));
    expect(retry).toHaveBeenCalledWith(
      `[hermetic] File for request ${ID} delivered: ${DELIVERED.path}`,
    );
    expect(await screen.findByText("Sent to scribe.")).toBeTruthy();
  });

  test("a slot the box no longer has is drawn from the tool's result", async () => {
    const gone = Object.assign(new Error("gone"), { code: "FILE_NOT_FOUND" });
    const { files } = fakeFiles(gone);
    await draw(requestBlock({ status: "ok", result: { status: "fulfilled" } }), files);
    expect(screen.getByText(/is no longer on the box\./)).toBeTruthy();
  });

  test("with no files client the card is read-only and says where to answer", async () => {
    await draw(requestBlock(), null);
    expect(screen.getByText(/Answer it from the desktop app/)).toBeTruthy();
    expect(screen.queryByLabelText("Choose file")).toBeNull();
  });

  test("no request id yet: the plain tool row", async () => {
    await draw(requestBlock({ request_id: null }), fakeFiles(slot()).files);
    expect(screen.queryByTestId(`file-request-${ID}`)).toBeNull();
  });
});

describe("text secret card", () => {
  const secretBlock = () =>
    requestBlock({
      name: "request_secret",
      render: "secret_request",
      args: { keys: ["GITHUB_TOKEN"] },
    });

  test("one key: a masked multi-line field, no chooser; the value never in the tree; Send securely sends it auto", async () => {
    const { files } = fakeFiles(textSlot());
    await draw(secretBlock(), files);
    expect(screen.getByText("Secret requested · text")).toBeTruthy();
    const field = screen.getByLabelText("Secret value for GITHUB_TOKEN");
    expect(field.props.multiline).toBe(true);
    expect(field.props.style.color).toBe("transparent");
    expect(field.props.autoCorrect).toBe(false);
    // The phone has no "Treat as" or input-mode controls.
    expect(screen.queryByText("Treat as")).toBeNull();
    expect(screen.queryByText("Single line")).toBeNull();
    expect(screen.queryByText("Raw value")).toBeNull();
    await fireEvent.changeText(field, FIXTURE_SECRET_VALUE);
    expect(tree()).not.toContain(FIXTURE_SECRET_VALUE);
    expect(screen.getByText(/✓ GITHUB_TOKEN · •••• · 20 chars/)).toBeTruthy();
    expect(screen.getByText(/^raw value detected/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Send securely"));
    await act(flush);
    expect(files.secret).toHaveBeenCalledWith(ID, { text: FIXTURE_SECRET_VALUE, as: "auto" });
    await act(flush);
    expect(await screen.findByText("secret delivered")).toBeTruthy();
    expect(tree()).not.toContain(FIXTURE_SECRET_VALUE);
  });

  test("Show value reveals the field and Hide value masks it again; the value stays out of the tree", async () => {
    const { files } = fakeFiles(textSlot());
    await draw(secretBlock(), files);
    await fireEvent.changeText(
      screen.getByLabelText("Secret value for GITHUB_TOKEN"),
      FIXTURE_SECRET_VALUE,
    );
    await fireEvent.press(screen.getByLabelText("Show value"));
    expect(screen.getByLabelText("Secret value for GITHUB_TOKEN").props.style.color).not.toBe(
      "transparent",
    );
    expect(tree()).not.toContain(FIXTURE_SECRET_VALUE);
    await fireEvent.press(screen.getByLabelText("Hide value"));
    expect(screen.getByLabelText("Secret value for GITHUB_TOKEN").props.style.color).toBe(
      "transparent",
    );
  });

  test("several keys: a multi-line paste box with key chips, values masked", async () => {
    const { files } = fakeFiles(textSlot({ keys: ["DB_USER", "DB_PASS"], slug: "db", input: "multi" }));
    await draw(secretBlock(), files);
    const field = screen.getByLabelText("Secret value for DB_USER, DB_PASS");
    expect(field.props.multiline).toBe(true);
    await fireEvent.changeText(field, `DB_USER=FIXTURE\nDB_PASS=${FIXTURE_SECRET_VALUE}`);
    expect(tree()).not.toContain(FIXTURE_SECRET_VALUE);
    expect(screen.getByText(/✓ DB_USER · ••••/)).toBeTruthy();
    expect(screen.getByText(/✓ DB_PASS · ••••/)).toBeTruthy();
    expect(screen.getByText(/^dotenv detected · 2 keys/)).toBeTruthy();
    // The mask names the key and hides the value.
    expect(screen.getByText(/^DB_PASS=•{20}$/, { includeHiddenElements: true })).toBeTruthy();
  });

  /** The mask's rows as drawn, one string per line of the field's value. */
  const maskLines = (): string[] =>
    screen.getAllByTestId("secret-mask-line", { includeHiddenElements: true }).map((node) => {
      const flat = (c: unknown): string =>
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.map(flat).join("")
            : c && typeof c === "object" && "props" in c
              ? flat((c as { props: { children?: unknown } }).props.children)
              : "";
      return flat(node.props.children);
    });

  test("a 120-character value is one unclamped mask row that wraps with the field", async () => {
    const { files } = fakeFiles(textSlot());
    await draw(secretBlock(), files);
    const value = `${FIXTURE_SECRET_VALUE}_${"x".repeat(120 - FIXTURE_SECRET_VALUE.length - 1)}`;
    expect(value).toHaveLength(120);
    await fireEvent.changeText(screen.getByLabelText("Secret value for GITHUB_TOKEN"), value);
    const rows = maskLines();
    expect(rows).toHaveLength(value.split("\n").length);
    expect(rows[0]).toBe("•".repeat(120));
    for (const node of screen.getAllByTestId("secret-mask-line", { includeHiddenElements: true })) {
      expect(node.props.numberOfLines).toBeUndefined();
    }
    expect(tree()).not.toContain(FIXTURE_SECRET_VALUE);
  });

  test("a blank line between keys keeps its row, so later key names stay on theirs", async () => {
    const { files } = fakeFiles(textSlot({ keys: ["DB_USER", "DB_PASS"], slug: "db" }));
    await draw(secretBlock(), files);
    const value = `DB_USER=FIXTURE\n\nDB_PASS=${FIXTURE_SECRET_VALUE} two words`;
    await fireEvent.changeText(screen.getByLabelText("Secret value for DB_USER, DB_PASS"), value);
    const rows = maskLines();
    expect(rows).toHaveLength(value.split("\n").length);
    expect(rows[1]).toBe(" ");
    // Spaces stay spaces, so the mask breaks where the field does.
    expect(rows[2]).toBe(`DB_PASS=${"•".repeat(FIXTURE_SECRET_VALUE.length)} ••• •••••`);
  });

  test("VoiceOver hears the masked summary, never the value", async () => {
    const { files } = fakeFiles(textSlot());
    await draw(secretBlock(), files);
    const label = "Secret value for GITHUB_TOKEN";
    expect(screen.getByLabelText(label).props.accessibilityValue).toEqual({ text: "empty" });
    await fireEvent.changeText(screen.getByLabelText(label), FIXTURE_SECRET_VALUE);
    for (const revealed of [false, true]) {
      const field = screen.getByLabelText(label);
      expect(field.props.accessibilityValue.text).toMatch(/^masked/);
      expect(JSON.stringify(field.props.accessibilityValue)).not.toContain(FIXTURE_SECRET_VALUE);
      expect(field.props.accessibilityLabel).not.toContain(FIXTURE_SECRET_VALUE);
      if (!revealed) await fireEvent.press(screen.getByLabelText("Show value"));
    }
  });

  test("an unrequested key is an error and nothing can be sent", async () => {
    const { files } = fakeFiles(textSlot({ input: "multi" }));
    await draw(secretBlock(), files);
    await fireEvent.changeText(
      screen.getByLabelText("Secret value for GITHUB_TOKEN"),
      `GITHUB_TOKEN=${FIXTURE_SECRET_VALUE}\nOTHER_KEY=FIXTURE`,
    );
    expect(screen.getAllByText(/not requested/).length).toBeGreaterThan(0);
    await fireEvent.press(screen.getByLabelText("Send securely"));
    expect(files.secret).not.toHaveBeenCalled();
    expect(tree()).not.toContain(FIXTURE_SECRET_VALUE);
  });

  test("a durable request says the phone sends it just this once", async () => {
    const { files } = fakeFiles(textSlot());
    await draw(secretBlock(), files);
    expect(screen.getByText(/just this once from this phone/)).toBeTruthy();
  });
});
