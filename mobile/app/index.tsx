/** Entry: wait for the stored pairing, then go to Pair or home. */
import { Redirect } from "expo-router";
import { View } from "react-native";
import { useFleetContext } from "../src/fleet/FleetProvider.tsx";
import { useTheme } from "../src/theme/theme.tsx";

export default function Index() {
  const { status } = useFleetContext();
  const t = useTheme();
  if (status === "loading") return <View style={{ flex: 1, backgroundColor: t.c.bg }} />;
  return <Redirect href={status === "paired" ? "/home" : "/pair"} />;
}
