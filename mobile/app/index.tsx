/** Entry: wait for the stored pairing, then go to Pair or the Bots list. */
import { Redirect } from "expo-router";
import { View } from "react-native";
import { useBridge } from "../src/bridge/BridgeProvider.tsx";
import { useTheme } from "../src/theme/theme.tsx";

export default function Index() {
  const { status } = useBridge();
  const t = useTheme();
  if (status === "loading") return <View style={{ flex: 1, backgroundColor: t.c.bg }} />;
  return <Redirect href={status === "paired" ? "/(tabs)" : "/pair"} />;
}
