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
  failedTurnPrompt,
  failureDetails,
  failureView,
  isLatestFailure,
  recoveryPlan,
} from "../../client/chat-recovery.ts";
import type { ChatFailure } from "@hermetic/core/chat-client";
import { useTheme } from "../../theme/theme.tsx";
import { Button } from "../../ui/Button.tsx";
import { haptic } from "../../ui/haptics.ts";
import { Text } from "../../ui/Text.tsx";
import { useChatScope } from "../ChatScope.tsx";
import { chatTime } from "../time.ts";
import { NeedsDot, SoftCard } from "./SoftCard.tsx";

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
  // What Retry sends: the words and the files that went with them.
  const turn = failedTurnPrompt(all, ids);
  const prompt = turn?.text || null;
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
      disabled: !idle || !turn || waiting !== null,
      onPress: () => turn && scope.retry?.(turn),
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
      // Words and files together, as Retry sends them.
      disabled: !idle || !turn,
      onPress: () => void run(async () => (turn ? scope.newSession?.(turn) : undefined)),
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
          {`Retry available at ${chatTime(new Date(waiting).toISOString(), Date.now())}`}
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
    <SoftCard testID="failure-card" edge={tone}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
        <NeedsDot color={tone} />
        <Text variant="bodySmall" weight={600} style={{ flex: 1, color: tone }}>
          {sentence(copy.head)}
        </Text>
        <Text mono variant="caption" tone="fg3">
          {copy.right}
        </Text>
      </View>
      <View style={{ gap: t.space.sm }}>
        <Text variant="bodySmall" selectable>
          <Text variant="bodySmall" weight={700}>
            {copy.title}
          </Text>{" "}
          {copy.detail}
        </Text>
        {failure ? <Recovery failure={failure} ids={ids} at={at} /> : null}
      </View>
    </SoftCard>
  );
}

/** "provider error" → "Provider error": the head reads in sentence case, not as a kicker. */
function sentence(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
