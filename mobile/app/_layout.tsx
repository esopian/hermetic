/**
 * Root layout: fonts, providers, the stack, and the in-app alert banner.
 * Importing `background.ts` defines the background-refresh task at load time,
 * which TaskManager requires.
 */
import "../src/bridge/background.ts";
import { useFonts } from "expo-font";
import { router, SplashScreen, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { BridgeProvider, useBridge } from "../src/bridge/BridgeProvider.tsx";
import { routeFor } from "../src/bridge/notifications.ts";
import { secureStorage } from "../src/bridge/storage.ts";
import { PrefsProvider } from "../src/prefs/prefs.tsx";
import { FONT_ASSETS } from "../src/theme/fonts.ts";
import { ThemeProvider, useTheme } from "../src/theme/theme.tsx";
import { Banner } from "../src/ui/Banner.tsx";

void SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const [loaded, error] = useFonts(FONT_ASSETS);
  useEffect(() => {
    if (loaded || error) void SplashScreen.hideAsync().catch(() => {});
  }, [loaded, error]);
  if (!loaded && !error) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <ThemeProvider storage={secureStorage}>
            <PrefsProvider storage={secureStorage}>
              <BridgeProvider>
                <Shell />
              </BridgeProvider>
            </PrefsProvider>
          </ThemeProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Shell() {
  const t = useTheme();
  const { banner, dismissBanner } = useBridge();
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(t.c.bg).catch(() => {});
  }, [t.c.bg]);
  return (
    <>
      <StatusBar style={t.scheme === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: t.c.bg },
          headerTintColor: t.c.fg,
          headerTitleStyle: { fontFamily: t.sans(800), fontSize: 16 },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: t.c.bg },
          headerBackButtonDisplayMode: "minimal",
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="pair" options={{ headerShown: false, gestureEnabled: false }} />
        {/* The title is what VoiceOver reads on the next screen's back button. */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false, title: "Hermetic" }} />
        <Stack.Screen name="chat/[instance]/[bot]" options={{ title: "" }} />
        <Stack.Screen name="agent/[name]" options={{ title: "Browser" }} />
        <Stack.Screen
          name="listening"
          options={{
            headerShown: false,
            presentation: "formSheet",
            sheetAllowedDetents: [0.6, 1],
            sheetGrabberVisible: true,
            contentStyle: { backgroundColor: t.c.bg },
          }}
        />
      </Stack>
      <Banner
        alert={banner}
        onDismiss={dismissBanner}
        onOpen={(alert) => {
          dismissBanner();
          router.push(routeFor(alert.data) as never);
        }}
      />
    </>
  );
}
