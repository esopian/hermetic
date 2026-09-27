/**
 * The semantic block switch, with one inspectable fallthrough.
 *
 * The many shapes a block takes are **variants, not
 * renderers**. A `tool` switches on its `render` hint and its `status` inside
 * `Tool.tsx`; a `hermetic` switches on `card` inside `Hermetic.tsx`. Adding another renderer here means core grew another semantic kind,
 * which is a deliberate schema change.
 *
 * The `default` branch is not defensive programming. It is the contract: a
 * block whose kind this build has never heard of reaches `UnknownBlock` and is
 * drawn as name and payload, so a `hermes_ref` bump that adds fifty tools
 * changes nothing here and blanks nothing on screen. `blockKind()` is what
 * decides, and it is pure, so the fallthrough is tested without mounting
 * anything as well as with.
 */
import { ActivityNotice, ActivityGroup } from "../Activity.tsx";
import type { ChatBlockOf, ChatBlockView } from "../../../api/index.ts";
import { blockKind } from "../../chat-logic.ts";
import { ApprovalBlock } from "./Approval.tsx";
import { AttachmentBlock } from "./Attachment.tsx";
import { HermeticBlock } from "./Hermetic.tsx";
import { QuestionBlock } from "./Question.tsx";
import { ReasoningBlock } from "./Reasoning.tsx";
import { SourcesBlock } from "./Sources.tsx";
import { TextBlock } from "./Text.tsx";
import { ToolBlock } from "./Tool.tsx";
import { UnknownBlock } from "./Unknown.tsx";

export function Block({
  block,
  now,
  /** This is the last block of a turn still arriving, so prose gets the caret. */
  streaming = false,
  /**
   * The author is the operator, not the bot. Desktop's `user-message-text.tsx`
   * deliberately does not run operator text through its full markdown/KaTeX
   * pipeline — only backtick code spans and fenced blocks — so a typed `$x=1$`
   * or `***text***` shows as the characters the operator typed, not a rendered
   * formula or emphasis. `TextBlock` carries that split; every other block
   * kind is unaffected because only `text` runs markdown at all.
   */
  mine = false,
}: {
  block: ChatBlockView;
  now: number;
  streaming?: boolean;
  mine?: boolean;
}) {
  switch (blockKind(block)) {
    case "text":
      return <TextBlock block={block as ChatBlockOf<"text">} streaming={streaming} plain={mine} />;
    case "reasoning":
      return <ReasoningBlock block={block as ChatBlockOf<"reasoning">} />;
    case "activity":
      return block.kind === "activity" && (block.state === "warning" || block.state === "error") ? (
        <ActivityNotice block={block} />
      ) : (
        <ActivityGroup blocks={[block]} streaming={streaming} />
      );
    case "tool":
      return <ToolBlock block={block as ChatBlockOf<"tool">} />;
    case "attachment":
      return <AttachmentBlock block={block as ChatBlockOf<"attachment">} />;
    case "approval":
      return <ApprovalBlock block={block as ChatBlockOf<"approval">} now={now} />;
    case "question":
      return <QuestionBlock block={block as ChatBlockOf<"question">} />;
    case "sources":
      return <SourcesBlock block={block as ChatBlockOf<"sources">} />;
    case "hermetic":
      return <HermeticBlock block={block as ChatBlockOf<"hermetic">} />;
    default:
      return <UnknownBlock block={block} />;
  }
}

export { ApprovalBlock, AttachmentBlock, HermeticBlock, QuestionBlock };
export { ReasoningBlock, SourcesBlock, TextBlock, ToolBlock, UnknownBlock };
