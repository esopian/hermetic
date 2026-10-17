/**
 * `@hermetic/core/chat-client-fixture`: the canned chat client, for the phone's
 * fixture mode only.
 *
 * `fixtureChatClient` is a `HermesChatClient` (the type `@hermetic/core/chat-client`
 * exports) answered from memory: the fixture fleet's swarms, sessions and
 * scripted turns, with no AWS, no tailnet and no gateway. It is what the phone
 * builds in place of `createHermesChat` when it runs with
 * `EXPO_PUBLIC_HERMETIC_FIXTURE=1`, so a simulator can show every chat state.
 *
 * Dev only. In `mobile/`, only files under `mobile/src/fixture/` may import this
 * door (`tests/boundaries.test.ts`), so a release build cannot reach a canned
 * fleet by accident. `test/chat-client-portable.test.ts` holds this door to the
 * same portability rules as the real one, except that `backend/fixture/` is
 * where it lives.
 */
export { fixtureChatClient } from "./backend/fixture/fixture-chat.ts";
export type { FixtureChatOptions } from "./backend/fixture/fixture-chat.ts";
/**
 * The stack the desktop's fixture mode builds: the chat client wrapped with
 * Bot Mode and a live activity clock, so recorded rows carry real timestamps.
 * The phone's fixture mode uses the same one; the bare client stamps a fixed
 * day and shows every sent prompt twice.
 */
export { createFixtureChatStack } from "./backend/fixture/fixture-chat-stack.ts";
export type { FixtureChatStack, FixtureChatPacing } from "./backend/fixture/fixture-chat-stack.ts";
/**
 * hermeticd's files routes on a fixture box (`/healthz`'s capability, stage,
 * commit, the request routes, and an entry's content), as plain data for a
 * fake `fetch` to wrap; it is also the `E2E_FILE_SHARE` turn's outbox. The
 * phone's real files client runs against it. The stage checks and the `E2E_FILE_TOO_LARGE` /
 * `E2E_FILE_DIGEST` name triggers are the desktop fixture's own, and
 * `FIXTURE_NO_FILES_AGENT` serves no files, as on the desktop.
 */
export {
  E2E_FILE_DIGEST,
  E2E_FILE_TOO_LARGE,
  FIXTURE_NO_FILES_AGENT,
  createFixtureFilesBox,
} from "./backend/fixture/fixture-files-box.ts";
export type {
  FixtureBoxAnswer,
  FixtureBoxRequest,
  FixtureFilesBox,
  FixtureFilesBoxOptions,
} from "./backend/fixture/fixture-files-box.ts";
