/**
 * The semantic block switch with its one inspectable fallthrough (desktop
 * `blocks/index.tsx`): a kind this build has never heard of reaches
 * `UnknownBlock` and is drawn as name and payload, never as nothing.
 */
import { isKanbanTaskTool } from "@hermetic/core/shared";
import { memo } from "react";
import { blockKind } from "../../client/chat-logic.ts";
import type { ClosedRequest } from "../../client/chat-requests.ts";
import { isRequestTool } from "../../client/file-request-logic.ts";
import { isDmTool, messageAgentLine } from "../../client/message-agent.ts";
import { isShareAttachment, isShareTool } from "../../client/share-logic.ts";
import type { ChatBlock } from "@hermetic/core/chat-client";
import { Markdown } from "../Markdown.tsx";
import { PlainText } from "../PlainText.tsx";
import { ActivityGroup } from "./Activity.tsx";
import { ApprovalCard } from "./Approval.tsx";
import { DmLine } from "./DmLine.tsx";
import { FileRequestBlock } from "./FileRequest.tsx";
import { KanbanCard, KanbanNotice } from "./KanbanCard.tsx";
import { QuestionCard } from "./Question.tsx";
import { ShareAttachment, ShareToolBlock } from "./ShareCard.tsx";
import {
  ActivityNotice,
  AttachmentBlock,
  CommandBlock,
  HermeticBlock,
  ProcessEventBlock,
  ReasoningBlock,
  SourcesBlock,
  UnknownBlock,
} from "./Simple.tsx";
import { SubagentLine } from "./Subagent.tsx";
import { ToolBlock } from "./Tool.tsx";

export interface BlockProps {
  block: ChatBlock;
  now: number;
  /** The last prose block of a turn still arriving: draw the caret. */
  streaming?: boolean;
  /** Prose of a turn still running that may yet become narration: muted, one step smaller. */
  quiet?: boolean;
  /** The operator's own words: plain text, never markdown. */
  mine?: boolean;
  closed?: ClosedRequest | undefined;
  pending?: number;
  /** The session the message is in, for a request card's answer. */
  session?: string | null;
  released?: readonly string[];
  /** A request card's turn is no longer live on this phone (`openRequests`). */
  stale?: boolean;
}

function BlockImpl({
  block,
  now,
  streaming = false,
  quiet = false,
  mine = false,
  closed,
  pending,
  session = null,
  released = [],
  stale = false,
}: BlockProps) {
  switch (blockKind(block)) {
    case "text": {
      const markdown = block.kind === "text" ? block.markdown : "";
      return mine ? (
        <PlainText text={markdown} />
      ) : (
        <Markdown markdown={markdown} streaming={streaming} quiet={quiet} />
      );
    }
    case "command":
      return block.kind === "command" ? <CommandBlock block={block} /> : null;
    case "reasoning":
      return block.kind === "reasoning" ? <ReasoningBlock block={block} /> : null;
    case "activity":
      if (block.kind !== "activity") return null;
      return block.state === "warning" || block.state === "error" ? (
        <ActivityNotice block={block} />
      ) : (
        <ActivityGroup blocks={[block]} streaming={streaming} />
      );
    case "tool":
      // A file or secret request is a card the operator answers, not a tool row.
      if (isRequestTool(block)) return <FileRequestBlock block={block} now={now} session={session} />;
      if (block.kind !== "tool") return null;
      // A filed kanban card is drawn live from the board, not as a tool row.
      if (isKanbanTaskTool(block)) return <KanbanCard block={block} />;
      // A file the agent shared is a card with Save, not a tool row.
      if (isShareTool(block)) return <ShareToolBlock block={block} />;
      // A bot-to-bot DM is one line between the prose.
      if (isDmTool(block)) return <DmLine line={messageAgentLine(block)} block={block} />;
      return <ToolBlock block={block} />;
    case "attachment":
      if (block.kind !== "attachment") return null;
      // A `MEDIA:` line naming the outbox is a share card, like `share_file`.
      return isShareAttachment(block) ? (
        <ShareAttachment block={block} />
      ) : (
        <AttachmentBlock block={block} />
      );
    case "approval":
      return block.kind === "approval" ? (
        <ApprovalCard
          block={block}
          now={now}
          closed={closed}
          pending={pending ?? 0}
          session={session}
          released={!!block.request_id && released.includes(block.request_id)}
          stale={stale}
        />
      ) : null;
    case "question":
      return block.kind === "question" ? (
        <QuestionCard
          block={block}
          now={now}
          closed={closed}
          session={session}
          released={!!block.request_id && released.includes(block.request_id)}
          stale={stale}
        />
      ) : null;
    case "sources":
      return block.kind === "sources" ? <SourcesBlock block={block} /> : null;
    case "hermetic":
      return block.kind === "hermetic" ? <HermeticBlock block={block} /> : null;
    case "process_event":
      if (block.kind !== "process_event") return null;
      return block.event === "kanban" ? (
        <KanbanNotice block={block} />
      ) : (
        <ProcessEventBlock block={block} />
      );
    case "subagent":
      return block.kind === "subagent" ? <SubagentLine block={block} /> : null;
    default:
      return <UnknownBlock block={block} />;
  }
}

export const Block = memo(BlockImpl);
