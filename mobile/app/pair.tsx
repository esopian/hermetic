/**
 * Pair: scan the QR the laptop shows (`hermetic mobile pair`, or Settings →
 * Pair a phone in the desktop app), follow the same `hermetic://fleet?v=2&…`
 * link opened as a deep link (`+native-intent.tsx` hands it here as `link`),
 * or paste it. The link carries no secret: it names the fleet, its tailnet and
 * its agents, and the phone reaches them over Tailscale.
 *
 * Nothing pairs on its own. Every way in lands on a confirmation naming the
 * fleet, the tailnet and the agent count, and only a link `readPairingLink`
 * accepts gets that far. Replacing an existing pairing asks once more, and a
 * code for a different tailnet says so (`tailnetChange`).
 *
 * After pairing the stack is dismissed before home replaces it, so a deep
 * link that opened Pair over another screen leaves nothing to swipe back to.
 */
import { CameraView, useCameraPermissions } from "expo-camera";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import {
  KeyboardAwareScrollView,
  type KeyboardAwareScrollViewRef,
} from "react-native-keyboard-controller";
import { useFleetContext } from "../src/fleet/FleetProvider.tsx";
import { useFleetState } from "../src/fleet/hooks.ts";
import { type PairedLink, type PairErrorCopy, readPairingLink } from "../src/fleet/pairing.ts";
import { PairConfirm, PairConfirmActions, tailnetChange } from "../src/pair/PairConfirm.tsx";
import { PairForm } from "../src/pair/PairForm.tsx";
import { useTheme } from "../src/theme/theme.tsx";
import { haptic } from "../src/ui/haptics.ts";
import { Button, Kicker, Screen, Text } from "../src/ui/index.ts";

export default function Pair() {
  const t = useTheme();
  const { pair, status, operatorTailnet, fixture } = useFleetContext();
  const current = useFleetState().link;
  const params = useLocalSearchParams<{ link?: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PairErrorCopy | null>(null);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [pending, setPending] = useState<PairedLink | null>(null);
  const scanned = useRef(false);
  const linked = useRef<string | null>(null);
  const scroller = useRef<KeyboardAwareScrollViewRef>(null);

  const submit = useCallback(
    async (link: PairedLink) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await pair(link);
        haptic.success();
        setPending(null);
        // Drop whatever is under Pair (a deep link pushes it over home or a
        // conversation), so swipe-back cannot return to it.
        if (router.canDismiss()) router.dismissAll();
        router.replace("/home");
      } catch (e) {
        haptic.error();
        setError({
          title: "This phone could not keep the pairing.",
          detail: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, pair],
  );

  /** Every way in stops here: refuse what is not a pairing link, else ask before keeping it. */
  const propose = useCallback(
    (text: string) => {
      const proposal = readPairingLink(text, { operatorTailnet });
      if (!proposal.ok) {
        haptic.error();
        setPending(null);
        setError(proposal.error);
        return;
      }
      setError(null);
      setPending(proposal.link);
    },
    [operatorTailnet],
  );

  const confirm = useCallback(() => {
    if (!pending) return;
    if (status !== "paired" || !current) return void submit(pending);
    // Replacing a working pairing is the one step that loses something: ask again.
    haptic.warning();
    const same = current.payload.fleet_id === pending.payload.fleet_id;
    const change = tailnetChange(pending, current.payload.tailnet);
    const body = same
      ? `This phone is paired with ${current.label} already. Pairing again refreshes its agent list.`
      : `This phone is paired with ${current.label}. Pairing with ${pending.label} forgets that fleet.`;
    Alert.alert(
      change ? "Switch tailnet?" : "Replace the current pairing?",
      change
        ? `${body} The Tailscale app must be signed in to ${change.to} for this phone to reach it.`
        : body,
      [
        { text: "Keep current", style: "cancel" },
        {
          text: change ? "Switch tailnet" : "Replace",
          style: "destructive",
          onPress: () => void submit(pending),
        },
      ],
    );
  }, [pending, status, current, submit]);

  const confirmProps = (link: PairedLink) => ({
    link,
    replacing: status === "paired",
    currentTailnet: status === "paired" ? (current?.payload.tailnet ?? null) : null,
    busy,
    onConfirm: confirm,
    onCancel: () => {
      haptic.select();
      setPending(null);
    },
  });

  // A deep link fills the confirmation; it never pairs by itself.
  const deepLink = typeof params.link === "string" ? params.link : null;
  useEffect(() => {
    if (!deepLink || linked.current === deepLink || status === "loading") return;
    linked.current = deepLink;
    propose(deepLink);
  }, [deepLink, status, propose]);

  const startScan = async () => {
    haptic.select();
    if (scanning) return setScanning(false);
    const ok = permission?.granted || (await requestPermission()).granted;
    if (ok) {
      scanned.current = false;
      setScanning(true);
    } else
      setError({
        title: "Camera access is off.",
        detail: "Allow it in iOS Settings → Hermetic, or paste the link below.",
      });
  };

  return (
    <Screen edges={["top", "bottom"]}>
      <KeyboardAwareScrollView
        ref={scroller}
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: t.space.xl, gap: t.space.lg }}
      >
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Kicker style={{ flex: 1 }}>Hermetic</Kicker>
          {status === "paired" && router.canGoBack() ? (
            <Button label="Cancel" variant="secondary" compact onPress={() => router.back()} />
          ) : null}
        </View>
        <Text variant="display">Pair this phone</Text>
        <Text tone="fg2">
          On your laptop run <Text mono>hermetic mobile pair</Text>, or open Settings → Pair a phone in
          the desktop app, then scan the code it shows.
        </Text>
        <Text variant="bodySmall" tone="fg3">
          The phone talks to the fleet over Tailscale: install the Tailscale app and sign in to the
          fleet's tailnet first.
        </Text>
        {status === "paired" && current ? (
          <View
            style={{
              borderLeftWidth: t.border.control,
              borderLeftColor: t.c.warn,
              paddingLeft: t.space.md,
            }}
          >
            <Text variant="bodySmall" tone="warn">
              {`Paired with ${current.label}. Pairing again replaces it.`}
            </Text>
          </View>
        ) : null}

        {scanning && permission?.granted ? (
          <View
            style={{ height: 300, borderWidth: t.border.seam, borderColor: t.c.fg, overflow: "hidden" }}
          >
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => {
                if (scanned.current) return;
                // Only our links stop the scanner; any other QR is ignored.
                if (!readPairingLink(data, { operatorTailnet }).ok && !/^hermetic:\/\//i.test(data))
                  return;
                scanned.current = true;
                haptic.medium();
                setScanning(false);
                propose(data);
              }}
            />
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                top: 50,
                bottom: 50,
                left: 50,
                right: 50,
                borderWidth: t.border.control,
                borderColor: t.c.acc,
              }}
            />
          </View>
        ) : null}
        <Button
          label={scanning ? "Cancel scan" : "Scan QR code"}
          variant={scanning ? "secondary" : "primary"}
          haptic={false}
          onPress={() => void startScan()}
        />
        {fixture ? (
          <Button
            label="Use fixture fleet"
            variant="secondary"
            onPress={() => {
              haptic.select();
              propose(fixture.link);
            }}
          />
        ) : null}
        {pending ? (
          // The buttons are pinned below the scroll view; the card scrolls itself into view.
          <View
            onLayout={(e) =>
              scroller.current?.scrollTo({ y: Math.max(0, e.nativeEvent.layout.y - t.space.lg) })
            }
          >
            <PairConfirm {...confirmProps(pending)} actions={false} />
          </View>
        ) : null}
        <PairForm busy={busy} error={error} onSubmit={propose} />
      </KeyboardAwareScrollView>
      {pending ? (
        <View
          style={{
            paddingHorizontal: t.space.xl,
            paddingVertical: t.space.md,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: t.c.line2,
            backgroundColor: t.c.bg,
          }}
        >
          <PairConfirmActions {...confirmProps(pending)} />
        </View>
      ) : null}
    </Screen>
  );
}
