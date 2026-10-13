/**
 * Pair: scan the QR the laptop shows (`hermetic mobile pair`, or Settings →
 * Mobile on the desktop), follow the same `hermetic://pair?…` link opened as
 * a deep link, or paste it / type host, port and code. The token goes to the
 * keychain through the provider; nothing else is kept.
 */
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useBridge } from "../src/bridge/BridgeProvider.tsx";
import { baseUrlFor, normalisePairCode, parsePairLink } from "../src/client/http.ts";
import { type PairErrorCopy, pairErrorCopy } from "../src/client/pairing.ts";
import { PairForm, type PairTarget } from "../src/pair/PairForm.tsx";
import { MOBILE_PROTOCOL } from "../src/protocol/constants.ts";
import { useTheme } from "../src/theme/theme.tsx";
import { haptic } from "../src/ui/haptics.ts";
import { Button, Kicker, Screen, Text } from "../src/ui/index.ts";

export default function Pair() {
  const t = useTheme();
  const { pair, status, credentials } = useBridge();
  const params = useLocalSearchParams<{ host?: string; port?: string; code?: string; name?: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PairErrorCopy | null>(null);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const scanned = useRef(false);
  const linked = useRef(false);

  const deepLink: PairTarget | null =
    params.host && params.code
      ? {
          host: String(params.host),
          port: Number(params.port) || MOBILE_PROTOCOL.DEFAULT_PORT,
          code: normalisePairCode(String(params.code)),
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
          deviceName: Device.deviceName ?? "iPhone",
        });
        haptic.success();
        router.replace("/(tabs)");
      } catch (e) {
        haptic.error();
        setError(pairErrorCopy(e, `${target.host}:${target.port}`));
      } finally {
        setBusy(false);
      }
    },
    [busy, pair],
  );

  // A deep link pairs at once when this phone is not paired yet; a paired
  // phone shows the link's values and waits for a deliberate tap.
  useEffect(() => {
    if (!deepLink || linked.current || status === "loading") return;
    linked.current = true;
    if (status === "unpaired") void submit(deepLink);
  }, [deepLink, status, submit]);

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
        {deepLink && params.name ? (
          <Text variant="bodySmall" tone="fg2">{`From the link: fleet ${String(params.name)}`}</Text>
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
                void submit({ host: parsed.host, port: parsed.port, code: parsed.code });
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
        <PairForm
          initial={deepLink}
          busy={busy}
          error={error}
          onSubmit={(target) => void submit(target)}
        />
      </KeyboardAwareScrollView>
    </Screen>
  );
}
