/**
 * A failed or cut-off turn (desktop `FailureCard.tsx`): one card for every
 * code, its words from `failureView`, its actions from `recoveryPlan`. Retry,
 * Compact and "Start new session" are the latest failure's to offer; an older
 * card keeps Edit and Copy details. Provider-binding fixes live on the
 * desktop, so the phone names them rather than linking.
 */
import * as Clipboard from "expo-clipboard";
import { useEffect, useState } from "react";
import { View } from "react-native";
import {
  failedPrompt,
  failureDetails,
  failureView,
  isLatestFailure,
  recoveryPlan,
} from "../../client/chat-recovery.ts";
import { threadTime } from "../../client/chat-logic.ts";
import type { ChatFailure } from "@hermetic/core/chat-client";
import { useTheme } from "../../theme/theme.tsx";
import { Button } from "../../ui/Button.tsx";
import { haptic } from "../../ui/haptics.ts";
import { Text } from "../../ui/Text.tsx";
import { useChatScope } from "../ChatScope.tsx";

function Recovery({ failure, ids, at }: { failure: ChatFailure; ids: readonly string[]; at: string }) {
  const t = useTheme();
  const scope = useChatScope();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const plan = recoveryPlan(failure);
  const [, wake] = useState(0);
  useEffect(() => {
    if (plan.retryAt === null) return;
    const ms = plan.retryAt - Date.now();
    if (ms <= 0) return;
    const timer = setTimeout(() => wake((n) => n + 1), ms + 1);
    return () => clearTimeout(timer);
  }, [plan.retryAt]);
  const waiting = plan.retryAt !== null && plan.retryAt > Date.now() ? plan.retryAt : null;
  const all = scope?.messages ?? [];
  const prompt = failedPrompt(all, ids);
  const idle = !!scope && !scope.sending && !busy;
  const resend = !!scope && isLatestFailure(all, ids);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setNote("");
    try {
      await work();
    } catch (e) {
      haptic.error();
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const buttons: { label: string; disabled?: boolean; onPress: () => void }[] = [];
  if (plan.retry && resend && scope?.retry)
    buttons.push({
      label: "Retry",
      disabled: !idle || !prompt || waiting !== null,
      onPress: () => prompt && scope.retry?.(prompt),
    });
  if (plan.editMessage && scope?.draft)
    buttons.push({
      label: "Edit message",
      disabled: !prompt,
      onPress: () => prompt && scope.draft?.(prompt),
    });
  if (plan.compact && resend && scope?.compact)
    buttons.push({
      label: "Compact",
      disabled: !idle,
      onPress: () => void run(async () => scope.compact?.()),
    });
  if (plan.newSession && resend && scope?.newSession)
    buttons.push({
      label: "Start new session",
      disabled: !idle || !prompt,
      onPress: () => void run(async () => (prompt ? scope.newSession?.(prompt) : undefined)),
    });
  buttons.push({
    label: "Copy details",
    disabled: busy,
    onPress: () =>
      void run(async () => {
        await Clipboard.setStringAsync(failureDetails(failure, at));
        haptic.success();
        setNote("Copied.");
      }),
  });

  return (
    <View style={{ gap: t.space.sm }}>
      {plan.retry && resend && waiting !== null ? (
        <Text variant="caption" tone="fg2">
          {`Retry available at ${threadTime(new Date(waiting).toISOString(), Date.now())}`}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
        {buttons.map((b) => (
          <Button
            key={b.label}
            label={b.label}
            variant="secondary"
            compact
            disabled={!!b.disabled}
            onPress={b.onPress}
          />
        ))}
      </View>
      {plan.chooseModel || plan.switchProvider || plan.updateApiKey ? (
        <Text variant="caption" tone="fg3">
          {plan.updateApiKey
            ? "Update the API key in the desktop app (Settings → Providers), then retry."
            : plan.chooseModel
              ? "Choose another model for this agent in the desktop app, then retry."
              : "Switch this agent's provider in the desktop app, then retry."}
        </Text>
      ) : null}
      {plan.signInAgain ? (
        <Text
          variant="caption"
          tone="fg3"
        >{`Sign in to ${plan.signInAgain} again on the box, then retry.`}</Text>
      ) : null}
      {scope ? (
        <Text mono variant="caption" tone="fg3" selectable>
          {`Box-side errors: hermetic logs ${scope.instance} --file errors`}
        </Text>
      ) : null}
      {note ? (
        <Text variant="caption" tone="fg2">
          {note}
        </Text>
      ) : null}
    </View>
  );
}

export function FailureCard({
  failure,
  ids = [],
  at = new Date().toISOString(),
}: {
  failure: ChatFailure | null;
  ids?: readonly string[];
  at?: string;
}) {
  const t = useTheme();
  const copy = failureView(failure);
  const tone = copy.tone === "warn" ? t.c.warn : t.c.bad;
  return (
    <View
      testID="failure-card"
      style={{
        borderWidth: 1,
        borderColor: t.c.line,
        borderLeftWidth: t.border.control,
        borderLeftColor: tone,
        backgroundColor: t.c.bg2,
        marginVertical: t.space.xs,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          paddingHorizontal: t.space.md,
          paddingVertical: t.space.sm,
          borderBottomWidth: 1,
          borderBottomColor: t.c.line,
        }}
      >
        <Text
          variant="caption"
          weight={700}
          uppercase
          style={{ flex: 1, letterSpacing: 1, color: tone }}
        >
          {copy.head}
        </Text>
        <Text mono variant="caption" tone="fg3">
          {copy.right}
        </Text>
      </View>
      <View style={{ padding: t.space.md, gap: t.space.sm }}>
        <Text variant="bodySmall" selectable>
          <Text variant="bodySmall" weight={700}>
            {copy.title}
          </Text>{" "}
          {copy.detail}
        </Text>
        {failure ? <Recovery failure={failure} ids={ids} at={at} /> : null}
      </View>
    </View>
  );
}
