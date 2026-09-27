/**
 * The delta gate: the buffer between the adapter's frames and the caller's,
 * which is what lets a secret split across several `delta` frames be masked
 * as one (§9.2). `chat.ts`'s `send` runs every frame through it.
 */
import type { ChatFrame } from "../schema/index.ts";
import { redactFrame, redactText } from "./chat-redact.ts";

/* ── the delta gate ───────────────────────────────────────────────────────── */

/**
 * How much of the live text is held back before it is emitted.
 *
 * Upstream streams a reply token by token, so a key the model echoes arrives
 * split across several `delta` frames and **no single frame matches any
 * pattern**: `"the key is sk-ant-"` and `"api03-…"` are each clean on their
 * own, and a browser that concatenates them has the key whole. Redaction
 * therefore cannot be per-frame — it has to see the text with its neighbours.
 *
 * Sixty-four characters is comfortably longer than the prefix of any pattern in
 * `chat-redact.ts` (`sk-ant-`, `Bearer `, `aws_secret_access_key=`), so a
 * secret cannot begin before the window and be emitted out of it.
 */
const REDACTION_HOLD = 64;

/**
 * The point at which holding text back is worse than emitting it.
 *
 * The cut below is at whitespace, because no pattern's match spans one — so
 * prose emits continuously, and the only thing that grows the buffer is a
 * single unbroken token. That is a base64 blob, which the patterns cannot
 * recognise anyway, and letting it grow without bound would turn a long tool
 * result into a memory leak and a silent stall in the UI.
 */
const REDACTION_MAX_HOLD = 8192;

const WHITESPACE = /\s/;

/**
 * How much of `buffer` can be masked and emitted now, such that anything still
 * arriving cannot change the masking of what was emitted.
 *
 * Zero means "hold everything": a turn that has said nine characters so far has
 * nothing that is safe to show, and the flush at the end of the turn is what
 * releases it.
 */
export function stableCut(buffer: string): number {
  /**
   * A PEM block is the one secret that spans lines, and its pattern needs both
   * ends to match. Nothing between a `BEGIN` and its `END` may be emitted, at
   * any distance.
   */
  const begin = buffer.lastIndexOf("-----BEGIN ");
  if (begin !== -1 && !buffer.includes("-----END ", begin)) {
    return buffer.length > REDACTION_MAX_HOLD ? buffer.length - REDACTION_HOLD : 0;
  }
  const limit = buffer.length - REDACTION_HOLD - 1;
  if (limit < 0) return 0;
  for (let i = limit; i >= 0; i--) {
    if (WHITESPACE.test(buffer[i] as string)) return i + 1;
  }
  // One long word and no safe place to cut it. Hold, until holding is itself
  // the problem.
  return buffer.length > REDACTION_MAX_HOLD ? limit + 1 : 0;
}

/**
 * The buffer between the adapter's frames and the caller's.
 *
 * Three properties, and all three are what the tests assert. **Order**: text is
 * emitted in the order it arrived, and a non-delta frame flushes whatever was
 * buffered before it so a `block` never overtakes the sentence it interrupted.
 * **Exactly once**: every character is emitted in exactly one frame, so a
 * client concatenating deltas ends with the text it would have had, minus the
 * masking. **Nothing withheld at the end**: every terminal path — the last
 * frame, an abort, a transport failure — flushes, or a turn's last words
 * disappear.
 *
 * Coalescing several input deltas into one output delta is the price, and it is
 * the right one: `seq` is upstream's ordering and the frame carries the seq of
 * the *last* input it contains, which is what a client comparing "have I seen
 * this" needs.
 */
export interface DeltaGate {
  accept(frame: ChatFrame): ChatFrame[];
  flush(): ChatFrame[];
}

export function createDeltaGate(): DeltaGate {
  let pending = "";
  let seq = 0;
  let message = "";

  function flush(): ChatFrame[] {
    if (pending === "") return [];
    const text = redactText(pending);
    pending = "";
    return text === "" ? [] : [{ type: "delta", seq, message, text }];
  }

  function accept(frame: ChatFrame): ChatFrame[] {
    // A block, a done or an error ends whatever was being buffered: those carry
    // their own redaction and they must not arrive before the text they follow.
    if (frame.type !== "delta") return [...flush(), redactFrame(frame)];
    // A delta for a different message is a different sentence; the previous
    // one is finished whether or not upstream said so.
    const out = frame.message === message ? [] : flush();
    message = frame.message;
    seq = frame.seq;
    pending += frame.text;
    const cut = stableCut(pending);
    if (cut <= 0) return out;
    const text = redactText(pending.slice(0, cut));
    pending = pending.slice(cut);
    return text === "" ? out : [...out, { type: "delta", seq, message, text }];
  }

  return { accept, flush };
}
