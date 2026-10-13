/**
 * The semantic block switch with its one inspectable fallthrough (desktop
 * `blocks/index.tsx`): a kind this build has never heard of reaches
 * `UnknownBlock` and is drawn as name and payload, never as nothing.
 */
import { memo } from "react";
import { blockKind } from "../../client/chat-logic.ts";
import type { ClosedRequest } from "../../client/chat-requests.ts";
import type { ChatBlock } from "../../protocol/types.ts";
import { Markdown } from "../Markdown.tsx";
import { PlainText } from "../PlainText.tsx";
import { ActivityGroup } from "./Activity.tsx";
import { ApprovalCard } from "./Approval.tsx";
import { QuestionCard } from "./Question.tsx";
import {
  ActivityNotice,
  AttachmentBlock,
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
  /** The operator's own words: plain text, never markdown. */
  mine?: boolean;
  closed?: ClosedRequest | undefined;
  pending?: number;
  /** The session the message is in, for a request card's answer. */
  session?: string | null;
  released?: readonly string[];
}

function BlockImpl({
  block,
  now,
  streaming = false,
  mine = false,
  closed,
  pending,
  session = null,
  released = [],
}: BlockProps) {
  switch (blockKind(block)) {
    case "text": {
      const markdown = block.kind === "text" ? block.markdown : "";
      return mine ? (
        <PlainText text={markdown} />
      ) : (
        <Markdown markdown={markdown} streaming={streaming} />
      );
    }
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
      return block.kind === "tool" ? <ToolBlock block={block} /> : null;
    case "attachment":
      return block.kind === "attachment" ? <AttachmentBlock block={block} /> : null;
    case "approval":
      return block.kind === "approval" ? (
        <ApprovalCard
          block={block}
          now={now}
          closed={closed}
          pending={pending ?? 0}
          session={session}
          released={!!block.request_id && released.includes(block.request_id)}
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
        />
      ) : null;
    case "sources":
      return block.kind === "sources" ? <SourcesBlock block={block} /> : null;
    case "hermetic":
      return block.kind === "hermetic" ? <HermeticBlock block={block} /> : null;
    case "process_event":
      return block.kind === "process_event" ? <ProcessEventBlock block={block} /> : null;
    case "subagent":
      return block.kind === "subagent" ? <SubagentLine block={block} /> : null;
    default:
      return <UnknownBlock block={block} />;
  }
}

export const Block = memo(BlockImpl);
