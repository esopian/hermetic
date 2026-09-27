/**
 * `sources` — where the prose above came from.
 *
 * A `muted` card, so it opens shut by the collapse rule, sitting under the
 * paragraph whose `.ch-cite` markers point into it. Each row carries an
 * anchor id matching its marker, which is what makes a citation a link that
 * goes somewhere rather than a superscript.
 */
import { RedactedText } from "../RedactedText.tsx";
import type { ChatBlockOf } from "../../../api/index.ts";
import { safeHref } from "../../chat-logic.ts";
import { Card, CardBody } from "../Card.tsx";

export function SourcesBlock({ block }: { block: ChatBlockOf<"sources"> }) {
  // A `sources` card whose `items` never arrived is an empty card, not a thrown
  // render — the same rule `RedactedText` applies to prose.
  const items = Array.isArray(block.items) ? block.items : [];
  return (
    <Card verdict="muted" head="Sources" right={items.length}>
      <CardBody tight>
        {items.map((item, i) => {
          // A source list is model-authored URLs by definition. One that is not
          // a real web link is shown, not linked — see `safeHref`.
          const href = safeHref(item.href);
          const Row = href === null ? "span" : "a";
          return (
            <Row
              // The marker's number *is* the position.
              key={i}
              id={`source-${i + 1}`}
              className="ch-src"
              {...(href === null ? {} : { href, rel: "noreferrer noopener", target: "_blank" })}
            >
              <span className="ch-src-n">{i + 1}</span>
              <span>
                <span className="ch-src-t">
                  <RedactedText text={item.title} />
                </span>
                <span className="ch-src-u">
                  <RedactedText text={item.href} />
                </span>
              </span>
              <span className="ch-time">
                <RedactedText text={item.snippet ?? ""} />
              </span>
            </Row>
          );
        })}
      </CardBody>
    </Card>
  );
}
