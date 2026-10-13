/**
 * Pair: scan the QR the laptop shows (`hermetic mobile pair`, or Settings →
 * Mobile on the desktop), or paste its link / type host, port and code.
 * The full screen is a later phase; this one already pairs.
 */
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useState } from "react";
import { TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useBridge } from "../src/bridge/BridgeProvider.tsx";
import { isBridgeError } from "../src/client/errors.ts";
import { baseUrlFor, normalisePairCode, parsePairLink } from "../src/client/http.ts";
import { MOBILE_PROTOCOL } from "../src/protocol/constants.ts";
import { useTheme } from "../src/theme/theme.tsx";
import { Button, Kicker, Screen, Text } from "../src/ui/index.ts";

export default function Pair() {
  const t = useTheme();
  const { pair } = useBridge();
  const [link, setLink] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(String(MOBILE_PROTOCOL.DEFAULT_PORT));
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  const submit = async (input: { host: string; port: number; code: string }) => {
    setBusy(true);
    setError(null);
    try {
      await pair({
        baseUrl: baseUrlFor(input.host, input.port),
        code: normalisePairCode(input.code),
        deviceName: Device.deviceName ?? "iPhone",
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      router.replace("/(tabs)");
    } catch (e) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      setError(isBridgeError(e) ? `${e.code}: ${e.message}` : String(e));
    } finally {
      setBusy(false);
    }
  };

  const fromLink = (text: string) => {
    const parsed = parsePairLink(text);
    if (!parsed) {
      setError("That is not a hermetic://pair link.");
      return;
    }
    void submit(parsed);
  };

  const input = {
    borderWidth: t.border.control,
    borderColor: t.c.line2,
    color: t.c.fg,
    fontFamily: t.mono(400),
    fontSize: 15,
    paddingHorizontal: t.space.md,
    minHeight: t.touch.min,
    borderRadius: 0,
  } as const;

  return (
    <Screen edges={["top", "bottom"]}>
      <KeyboardAwareScrollView contentContainerStyle={{ padding: t.space.xl, gap: t.space.lg }}>
        <Kicker>Hermetic</Kicker>
        <Text variant="display">Pair this phone</Text>
        <Text tone="fg2">
          On your laptop run <Text mono>hermetic mobile pair</Text>, or open Settings → Mobile, then
          scan the code.
        </Text>
        {scanning && permission?.granted ? (
          <View style={{ height: 280, borderWidth: t.border.seam, borderColor: t.c.fg }}>
            <CameraView
              style={{ flex: 1 }}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => {
                setScanning(false);
                fromLink(data);
              }}
            />
          </View>
        ) : null}
        <Button
          label={scanning ? "Cancel scan" : "Scan QR code"}
          variant={scanning ? "secondary" : "primary"}
          onPress={async () => {
            if (scanning) return setScanning(false);
            const ok = permission?.granted || (await requestPermission()).granted;
            if (ok) setScanning(true);
            else setError("Camera access is off. Paste the link or enter the code instead.");
          }}
        />
        <Kicker>Or paste the link</Kicker>
        <TextInput
          accessibilityLabel="Pairing link"
          value={link}
          onChangeText={setLink}
          placeholder="hermetic://pair?host=…"
          placeholderTextColor={t.c.fg3}
          autoCapitalize="none"
          autoCorrect={false}
          style={input}
          onSubmitEditing={() => fromLink(link)}
        />
        <Kicker>Or enter it by hand</Kicker>
        <View style={{ flexDirection: "row", gap: t.space.sm }}>
          <TextInput
            accessibilityLabel="Host"
            value={host}
            onChangeText={setHost}
            placeholder="100.x.y.z"
            placeholderTextColor={t.c.fg3}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={[input, { flex: 1 }]}
          />
          <TextInput
            accessibilityLabel="Port"
            value={port}
            onChangeText={setPort}
            keyboardType="number-pad"
            style={[input, { width: 90 }]}
          />
        </View>
        <TextInput
          accessibilityLabel="Pairing code"
          value={code}
          onChangeText={(v) => setCode(v.toUpperCase())}
          placeholder="8-character code"
          placeholderTextColor={t.c.fg3}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={12}
          style={[input, { letterSpacing: 3 }]}
        />
        {error ? (
          <Text tone="bad" variant="bodySmall">
            {error}
          </Text>
        ) : null}
        <Button
          label="Pair"
          busy={busy}
          disabled={!host || !code}
          onPress={() =>
            void submit({ host: host.trim(), port: Number(port) || MOBILE_PROTOCOL.DEFAULT_PORT, code })
          }
        />
      </KeyboardAwareScrollView>
    </Screen>
  );
}
