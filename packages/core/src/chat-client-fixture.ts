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
