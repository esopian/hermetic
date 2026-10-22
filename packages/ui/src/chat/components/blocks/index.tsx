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
import { memo } from "react";
import { ActivityNotice, ActivityGroup } from "../Activity.tsx";
import type { ChatBlockOf, ChatBlockView } from "../../../api/index.ts";
import { blockKind } from "../../chat-logic.ts";
import { ApprovalBlock } from "./Approval.tsx";
import { AttachmentBlock } from "./Attachment.tsx";
import { CommandBlock } from "./Command.tsx";
import { FileRequestBlock } from "./FileRequest.tsx";
import { HermeticBlock } from "./Hermetic.tsx";
import { isRequestTool } from "../../file-request-logic.ts";
import { KanbanTaskBlock, isKanbanTaskTool } from "./KanbanTask.tsx";
import { ProcessEventBlock } from "./ProcessEvent.tsx";
import { QuestionBlock } from "./Question.tsx";
import { ReasoningBlock } from "./Reasoning.tsx";
import { ShareToolBlock, isShareTool } from "./ShareCard.tsx";
import { SourcesBlock } from "./Sources.tsx";
import { TextBlock } from "./Text.tsx";
import { ToolBlock } from "./Tool.tsx";
import { UnknownBlock } from "./Unknown.tsx";
import { SubagentBlock } from "./Subagent.tsx";
import type { ClosedRequest } from "../../chat-requests.ts";

/**
 * Memoized: a block whose props did not change draws what it drew. `Message`
 * hands every block the transcript's own block object, which keeps its
 * identity while it is unchanged (`chat-message-identity.ts`).
 */
export const Block = memo(function Block({
  block,
  /**
   * The clock a request card reads expiry against. Only an approval or a
   * clarify reads it, so `Message` passes it to those alone and the transcript
   * tick re-renders nothing else.
   */
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
  /** How the box closed this request card, when it did (`closedRequests`). */
  closed,
  /** Open approvals in the turn, for the approval card's "N pending" label. */
  pending,
  /** The conversation's own box and fleet, for a staged file's thumbnail. */
  instance,
  fleetId,
  /** Who a request card names ("sindri was told"); the box's name when absent. */
  agent,
  /** The turn's start, for a request card's "stopped waiting at". */
  at,
  /** The turn read untrusted content before this request card. */
  untrusted = false,
}: {
  block: ChatBlockView;
  now?: number | undefined;
  streaming?: boolean;
  mine?: boolean;
  closed?: ClosedRequest;
  pending?: number;
  instance?: string;
  fleetId?: string;
  agent?: string;
  at?: string;
  untrusted?: boolean;
}) {
  switch (blockKind(block)) {
    case "text":
      return <TextBlock block={block as ChatBlockOf<"text">} streaming={streaming} plain={mine} />;
    case "command":
      return <CommandBlock block={block as ChatBlockOf<"command">} />;
    case "reasoning":
      return <ReasoningBlock block={block as ChatBlockOf<"reasoning">} />;
    case "activity":
      return block.kind === "activity" && (block.state === "warning" || block.state === "error") ? (
        <ActivityNotice block={block} />
      ) : (
        <ActivityGroup blocks={[block]} streaming={streaming} />
      );
    case "tool":
      // A kanban card the agent filed is a task card.
      if (isKanbanTaskTool(block)) {
        return (
          <KanbanTaskBlock block={block as ChatBlockOf<"tool">} {...(instance ? { instance } : {})} />
        );
      }
      // A file the agent shared is a card with Save…, or the box's refusal.
      if (isShareTool(block)) {
        return (
          <ShareToolBlock block={block as ChatBlockOf<"tool">} {...(instance ? { instance } : {})} />
        );
      }
      // A file or secret request draws from the box's slot, so it needs the box.
      return isRequestTool(block) && instance ? (
        <FileRequestBlock
          block={block}
          instance={instance}
          agent={agent ?? instance}
          untrusted={untrusted}
          {...(at ? { at } : {})}
        />
      ) : (
        <ToolBlock block={block as ChatBlockOf<"tool">} />
      );
    case "attachment":
      return (
        <AttachmentBlock
          block={block as ChatBlockOf<"attachment">}
          {...(instance ? { instance } : {})}
          {...(fleetId ? { fleetId } : {})}
        />
      );
    case "approval":
      return (
        <ApprovalBlock
          block={block as ChatBlockOf<"approval">}
          now={now ?? Date.now()}
          closed={closed}
          pending={pending}
        />
      );
    case "question":
      return <QuestionBlock block={block as ChatBlockOf<"question">} now={now} closed={closed} />;
    case "sources":
      return <SourcesBlock block={block as ChatBlockOf<"sources">} />;
    case "hermetic":
      return <HermeticBlock block={block as ChatBlockOf<"hermetic">} />;
    case "process_event":
      // `Thread` draws an event message as a gutter row of its own and never
      // reaches here with one; this is the same content for any other surface.
      return <ProcessEventBlock block={block as ChatBlockOf<"process_event">} />;
    case "subagent":
      return <SubagentBlock block={block} />;
    default:
      return <UnknownBlock block={block} />;
  }
});

export { ApprovalBlock, AttachmentBlock, HermeticBlock, ProcessEventBlock, QuestionBlock };
export { ReasoningBlock, SourcesBlock, TextBlock, ToolBlock, UnknownBlock };
