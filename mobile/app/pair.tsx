/**
 * Pair: scan the QR the laptop shows (`hermetic mobile pair`, or Settings →
 * Mobile on the desktop), follow the same `hermetic://pair?…` link opened as
 * a deep link, or paste it / type host, port and code. The token goes to the
 * keychain through the provider; nothing else is kept.
 *
 * Nothing pairs on its own. Every way in — a scan, a deep link, a pasted link,
 * the form — lands on a confirmation naming the bridge, the fleet and the name
 * this phone will send, and only a host on the tailnet (or loopback) gets that
 * far (`pairHostAllowed`). Replacing an existing pairing asks once more.
 */
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useBridge } from "../src/bridge/BridgeProvider.tsx";
import { baseUrlFor, normalisePairCode, parsePairLink } from "../src/client/http.ts";
import {
  deviceNameFor,
  type PairErrorCopy,
  pairErrorCopy,
  pairHostAllowed,
} from "../src/client/pairing.ts";
import { PairConfirm } from "../src/pair/PairConfirm.tsx";
import { PairForm, type PairTarget } from "../src/pair/PairForm.tsx";
import { MOBILE_PROTOCOL } from "../src/protocol/constants.ts";
import { useTheme } from "../src/theme/theme.tsx";
import { haptic } from "../src/ui/haptics.ts";
import { Button, Kicker, Screen, Text } from "../src/ui/index.ts";

export default function Pair() {
  const t = useTheme();
  const { pair, status, credentials } = useBridge();
  const params = useLocalSearchParams<{
    host?: string;
    port?: string;
    code?: string;
    fleet?: string;
    name?: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PairErrorCopy | null>(null);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [pending, setPending] = useState<PairTarget | null>(null);
  const scanned = useRef(false);
  const linked = useRef(false);
  const deviceName = deviceNameFor(Device.deviceName);

  const deepLink: PairTarget | null =
    params.host && params.code
      ? {
          host: String(params.host),
          port: Number(params.port) || MOBILE_PROTOCOL.DEFAULT_PORT,
          code: normalisePairCode(String(params.code)),
          fleet: params.fleet ? String(params.fleet) : null,
          name: params.name ? String(params.name) : null,
        }
      : null;

  const submit = useCallback(
    async (target: PairTarget) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await pair({
          baseUrl: baseUrlFor(target.host, target.port),
          code: normalisePairCode(target.code),
          deviceName,
          expectFleet: target.fleet ?? null,
        });
        haptic.success();
        setPending(null);
        router.replace("/(tabs)");
      } catch (e) {
        haptic.error();
        setPending(null);
        setError(pairErrorCopy(e, `${target.host}:${target.port}`));
      } finally {
        setBusy(false);
      }
    },
    [busy, pair, deviceName],
  );

  /** Every way in stops here: refuse an off-tailnet host, else ask before pairing. */
  const propose = useCallback((target: PairTarget) => {
    const check = pairHostAllowed(target.host);
    if (!check.ok) {
      haptic.error();
      setPending(null);
      setError({ title: `${target.host} is not on your tailnet.`, detail: check.reason });
      return;
    }
    setError(null);
    setPending(target);
  }, []);

  const confirm = useCallback(() => {
    if (!pending) return;
    if (status !== "paired" || !credentials) return void submit(pending);
    // Replacing a working pairing is the one step that loses something: ask again.
    haptic.warning();
    const current = credentials.fleet.alias ?? credentials.fleet.fleet_id;
    Alert.alert(
      "Replace the current pairing?",
      `This phone is paired with ${current} at ${credentials.baseUrl}. Pairing with ${pending.host}:${pending.port} signs it out of that bridge.`,
      [
        { text: "Keep current", style: "cancel" },
        { text: "Replace", style: "destructive", onPress: () => void submit(pending) },
      ],
    );
  }, [pending, status, credentials, submit]);

  // A deep link fills the confirmation; it never pairs by itself.
  useEffect(() => {
    if (!deepLink || linked.current || status === "loading") return;
    linked.current = true;
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
        detail: "Allow it in iOS Settings → Hermetic, or paste the link / enter the code below.",
      });
  };

  return (
    <Screen edges={["top", "bottom"]}>
      <KeyboardAwareScrollView
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: t.space.xl, gap: t.space.lg }}
      >
        <Kicker>Hermetic</Kicker>
        <Text variant="display">Pair this phone</Text>
        <Text tone="fg2">
          On your laptop run <Text mono>hermetic mobile pair</Text>, or open Settings → Mobile in the
          desktop app, then scan the code it shows.
        </Text>
        {status === "paired" && credentials ? (
          <View
            style={{
              borderLeftWidth: t.border.control,
              borderLeftColor: t.c.warn,
              paddingLeft: t.space.md,
            }}
          >
            <Text variant="bodySmall" tone="warn">
              {`Paired with ${credentials.fleet.alias ?? credentials.fleet.fleet_id}. Pairing again replaces it.`}
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
                const parsed = parsePairLink(data);
                if (!parsed) return;
                scanned.current = true;
                haptic.medium();
                setScanning(false);
                propose(parsed);
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
          busy={busy && scanned.current}
          onPress={() => void startScan()}
        />
        {pending ? (
          <PairConfirm
            target={pending}
            deviceName={deviceName}
            replacing={status === "paired"}
            busy={busy}
            onConfirm={confirm}
            onCancel={() => {
              haptic.select();
              setPending(null);
            }}
          />
        ) : null}
        <PairForm initial={deepLink} busy={busy} error={error} onSubmit={propose} />
      </KeyboardAwareScrollView>
    </Screen>
  );
}
