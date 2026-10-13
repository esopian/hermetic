/**
 * `question` — the clarify card (desktop `BotResponses.tsx` `QuestionCard`).
 * One card per request however many questions it carries: a batch is one
 * form, "N of M answered", sent whole as `answers` keyed by each question's
 * id; a single question sends `answer`. Choices are lettered rows (radio, or
 * checkbox when multi-select), "Other" is a free-text row, Skip declines,
 * "Confirm and continue" is disabled until every question has an answer.
 * Settled, the card collapses to what was asked and what went back. In a turn
 * no longer live on this phone (`stale`), its choices are drawn disabled.
 */
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import {
  answerOf,
  answerText,
  bare,
  type ClosedRequest,
  clarifyPayload,
  EMPTY_STAGE,
  EXPIRED,
  GONE,
  lateAnswer,
  letter,
  pick,
  type QuestionEntry,
  questionsOf,
  replayed,
  SENT,
  STALE,
  type Stage,
  skippedAnswer,
  typeOther,
} from "../../client/chat-requests.ts";
import type { QuestionBlock } from "@hermetic/core/chat-client";
import { useTheme } from "../../theme/theme.tsx";
import { Button } from "../../ui/Button.tsx";
import { haptic } from "../../ui/haptics.ts";
import { Text } from "../../ui/Text.tsx";
import { useChatScope } from "../ChatScope.tsx";
import { useSubmit } from "./respond.ts";

function Choice({
  q,
  index,
  choice,
  checked,
  disabled,
  onPick,
}: {
  q: QuestionEntry;
  index: number;
  choice: string;
  checked: boolean;
  disabled: boolean;
  onPick?: () => void;
}) {
  const t = useTheme();
  const plain = bare(choice);
  const suffix = choice.slice(plain.length);
  return (
    <Pressable
      accessibilityRole={q.multi_select ? "checkbox" : "radio"}
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={plain}
      disabled={disabled}
      onPress={() => {
        haptic.select();
        onPick?.();
      }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.md,
        minHeight: t.touch.min,
        paddingHorizontal: t.space.md,
        borderWidth: 1,
        borderColor: checked ? t.c.acc : t.c.line2,
        backgroundColor: pressed ? t.c.sel : checked ? t.c.bg3 : "transparent",
        opacity: disabled && !checked ? 0.55 : 1,
      })}
    >
      <View
        style={{
          width: 22,
          height: 22,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1,
          borderColor: checked ? t.c.acc : t.c.line2,
          backgroundColor: checked ? t.c.acc : "transparent",
          borderRadius: q.multi_select ? 0 : 11,
        }}
      >
        <Text mono variant="caption" weight={700} style={{ color: checked ? t.c.accFg : t.c.fg2 }}>
          {q.multi_select && checked ? "✓" : letter(index)}
        </Text>
      </View>
      <Text variant="bodySmall" style={{ flex: 1 }}>
        {plain}
        {suffix ? (
          <Text variant="caption" tone="fg3">
            {suffix}
          </Text>
        ) : null}
      </Text>
    </Pressable>
  );
}

function Summary({
  questions,
  values,
  status,
  heading,
}: {
  questions: QuestionEntry[];
  values: (string | null)[] | null;
  status?: string;
  heading?: string;
}) {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.sm }}>
      {heading ? (
        <Text weight={700} tone="warn" variant="bodySmall">
          {heading}
        </Text>
      ) : null}
      {questions.map((q, i) => {
        const value = values ? (values[i] ?? null) : null;
        return (
          <View key={q.id ?? i} style={{ gap: 2 }}>
            <Text weight={700} variant="bodySmall">
              {q.prompt}
            </Text>
            {values ? (
              <Text variant="bodySmall" tone={skippedAnswer(value) ? "fg3" : "fg2"}>
                {answerText(q, value)}
              </Text>
            ) : null}
          </View>
        );
      })}
      {status ? (
        <Text variant="caption" tone="fg3">
          {status}
        </Text>
      ) : null}
    </View>
  );
}

/** After a skip or a close: a choice drafts a late answer into the composer, nothing is sent. */
function LateChoices({ q }: { q: QuestionEntry }) {
  const t = useTheme();
  const scope = useChatScope();
  if (!scope?.draft || q.choices.length === 0) return null;
  const draft = scope.draft;
  return (
    <View style={{ gap: t.space.xs }}>
      <Text variant="caption" tone="fg3">
        Answer anyway: a choice drafts a message, nothing is sent.
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.xs }}>
        {q.choices.map((choice, i) => (
          <Button
            key={`${i}-${choice}`}
            label={bare(choice)}
            variant="secondary"
            compact
            onPress={() => draft(lateAnswer(q.prompt, bare(choice)))}
          />
        ))}
      </View>
    </View>
  );
}

const CLOSED_HEADING: Partial<Record<ClosedRequest["kind"], string>> = {
  timeout: "Timed out",
  cancelled: "Cancelled",
};

export function QuestionCard({
  block,
  now,
  closed,
  session,
  released = false,
  stale = false,
}: {
  block: QuestionBlock;
  now: number;
  closed?: ClosedRequest | undefined;
  session: string | null;
  released?: boolean;
  /** Its turn is no longer live on this phone: nothing can be answered here (`openRequests`). */
  stale?: boolean;
}) {
  const t = useTheme();
  const { live, state, busy, submit, settled } = useSubmit(session);
  const questions = questionsOf(block);
  const [stages, setStages] = useState<Stage[]>(() => questions.map(replayed));
  const [sent, setSent] = useState<(string | null)[] | null>(null);
  const locks = JSON.stringify(questions.map((q) => q.answer));
  useEffect(() => {
    setStages((current) =>
      questions.map((q, i) => {
        const stage = current[i] ?? EMPTY_STAGE;
        return stage.touched || q.answer === null ? stage : replayed(q);
      }),
    );
  }, [locks, questions.length]);

  const request_id = block.request_id ?? null;
  const recorded = !request_id && questions.some((q) => q.answer !== null);
  const answerable = live && !!request_id;
  const shut = closed && closed.kind !== "answered" ? closed.kind : null;
  const expired = !!block.expires_at && Date.parse(block.expires_at) < now;
  const done = settled || (released && !state);
  const paused = answerable && !stale && !expired && !done && !shut;
  const single = questions.length === 1 ? (questions[0] ?? null) : null;

  const edit = (index: number, next: (stage: Stage, q: QuestionEntry) => Stage) =>
    setStages((current) =>
      questions.map((q, i) =>
        i === index ? next(current[i] ?? EMPTY_STAGE, q) : (current[i] ?? EMPTY_STAGE),
      ),
    );

  let body: ReactNode;
  if (recorded)
    body = (
      <>
        <Summary questions={questions} values={questions.map((q) => q.answer)} />
        {single && skippedAnswer(single.answer) ? <LateChoices q={single} /> : null}
      </>
    );
  else if (answerable && done) {
    const values = state === SENT ? sent : null;
    body = (
      <>
        <Summary questions={questions} values={values} status={state || (released ? SENT : GONE)} />
        {single && state === SENT && skippedAnswer(values?.[0] ?? null) ? (
          <LateChoices q={single} />
        ) : null}
      </>
    );
  } else if (shut)
    body = (
      <>
        <Summary
          questions={questions}
          values={shut === "skipped" ? questions.map(() => null) : null}
          {...(CLOSED_HEADING[shut] ? { heading: CLOSED_HEADING[shut] } : {})}
        />
        {single ? <LateChoices q={single} /> : null}
      </>
    );
  else if (!answerable || stale)
    body = (
      <>
        {questions.map((q, i) => (
          <View key={q.id ?? i} style={{ gap: t.space.xs }}>
            <Text weight={700}>{q.prompt}</Text>
            {q.choices.map((choice, index) => (
              <Choice
                key={`${index}-${choice}`}
                q={q}
                index={index}
                choice={choice}
                checked={false}
                disabled
              />
            ))}
          </View>
        ))}
        <Text variant="caption" tone="fg3">
          {answerable ? STALE : "Respond in Hermes. Choices are shown here for reference."}
        </Text>
      </>
    );
  else {
    const values = questions.map((q, i) => answerOf(q, stages[i] ?? EMPTY_STAGE));
    const answered = values.filter((v) => v !== null).length;
    const ready = answered === questions.length;
    const locked = busy || expired;
    const confirm = () => {
      if (locked || !ready || !request_id) return;
      const payload = clarifyPayload(request_id, questions, stages);
      if (!payload) return;
      setSent(values);
      void submit(payload);
    };
    body = (
      <>
        {questions.length > 1 ? (
          <Text mono variant="caption" tone={ready ? "ok" : "fg2"}>
            {`${answered} of ${questions.length} answered`}
          </Text>
        ) : null}
        {questions.map((q, i) => {
          const stage = stages[i] ?? EMPTY_STAGE;
          return (
            <View key={q.id ?? i} accessibilityRole="radiogroup" style={{ gap: t.space.xs }}>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: t.space.sm }}>
                <Text weight={700} style={{ flex: 1 }}>
                  {q.prompt}
                </Text>
                {q.multi_select && q.choices.length > 0 ? (
                  <Text mono variant="caption" tone="fg3">
                    choose any
                  </Text>
                ) : null}
              </View>
              {q.choices.map((choice, index) => (
                <Choice
                  key={`${index}-${choice}`}
                  q={q}
                  index={index}
                  choice={choice}
                  checked={stage.picked.includes(choice)}
                  disabled={locked}
                  onPick={() => edit(i, (s, entry) => pick(s, entry, choice))}
                />
              ))}
              <TextInput
                keyboardAppearance={t.scheme}
                accessibilityLabel={`Answer: ${q.prompt}`}
                selectionColor={t.c.acc}
                cursorColor={t.c.acc}
                placeholder={q.choices.length > 0 ? "Other (type your answer)" : "Type your answer…"}
                placeholderTextColor={t.c.fg3}
                editable={!locked}
                value={stage.text}
                onChangeText={(text) => edit(i, (s, entry) => typeOther(s, entry, text))}
                onSubmitEditing={confirm}
                returnKeyType="done"
                style={{
                  minHeight: t.touch.min,
                  borderWidth: 1,
                  borderColor: stage.text.trim() ? t.c.acc : t.c.line2,
                  color: t.c.fg,
                  fontFamily: t.sans(400),
                  fontSize: 14,
                  paddingHorizontal: t.space.md,
                  borderRadius: 0,
                }}
              />
            </View>
          );
        })}
        {expired ? (
          <Text variant="bodySmall" tone="fg2">
            {EXPIRED}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", gap: t.space.sm }}>
          <Button
            label="Skip"
            variant="secondary"
            disabled={locked}
            style={{ flex: 1 }}
            onPress={() => {
              if (!request_id) return;
              setSent(questions.map(() => null));
              void submit({ request_id, kind: "question", skip: true });
            }}
          />
          <Button
            label="Confirm and continue"
            disabled={locked || !ready}
            busy={busy}
            style={{ flex: 2 }}
            onPress={confirm}
          />
        </View>
      </>
    );
  }

  const muted = recorded || done || !!shut || (answerable && stale);
  return (
    <View
      testID={`question-${request_id ?? "none"}`}
      style={{
        borderWidth: 1,
        borderColor: t.c.line,
        borderLeftWidth: t.border.control,
        borderLeftColor: muted ? t.c.line2 : t.c.acc,
        backgroundColor: t.c.bg2,
        marginVertical: t.space.xs,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: t.space.md,
          paddingVertical: t.space.sm,
          borderBottomWidth: 1,
          borderBottomColor: t.c.line,
        }}
      >
        <Text variant="caption" weight={700} uppercase style={{ flex: 1, letterSpacing: 1 }}>
          question
        </Text>
        {paused ? (
          <Text mono variant="caption" tone="acc">
            turn paused
          </Text>
        ) : null}
      </View>
      <View style={{ padding: t.space.md, gap: t.space.md }}>
        {body}
        {state && state !== SENT && state !== GONE ? (
          <Text accessibilityRole="alert" variant="caption" tone="bad">
            {state}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
