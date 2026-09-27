/**
 * Core owns masking. This component only distinguishes its existing marker visually.
 *
 * `text` is typed as a string and every block field that reaches here is typed
 * as one in `core/src/schema/chat.ts` — but a transcript is *data*, read back
 * out of the local database or off a gateway, and a block persisted by an
 * older build or produced by a version this one has never met can arrive with
 * a field simply absent. Zod validates at core's boundary; nothing revalidates
 * on the way to the DOM.
 *
 * So the normalisation lives here, at the one funnel every piece of prose in
 * the chat passes through, rather than as `?? ""` at forty call sites where
 * the forty-first is the one that is forgotten. §9.2: an unrecognised shape
 * renders, it never disappears — and an uncaught `TypeError` in a leaf is how
 * a whole thread disappears.
 */
export function RedactedText({ text }: { text: string | null | undefined }) {
  const value = typeof text === "string" ? text : "";
  return value.split(/(\[redacted\]|‹redacted by hermetic›)/gi).map((part, index) =>
    /^(?:\[redacted\]|‹redacted by hermetic›)$/i.test(part) ? (
      <span className="ch-redacted" key={index}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}
