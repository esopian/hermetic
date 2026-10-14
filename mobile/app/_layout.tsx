/**
 * Root layout: fonts, providers, the stack, and the in-app alert banner.
 * Importing `background.ts` defines the background-refresh task at load time,
 * which TaskManager requires.
 */
import "../src/fleet/background.ts";
import { useFonts } from "expo-font";
import { router, SplashScreen, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { openRoute, type RouteNavigator, routeFor } from "../src/fleet/alerts.ts";
import { appFleetDeps } from "../src/fleet/deps.ts";
import { FleetProvider, useFleetContext } from "../src/fleet/FleetProvider.tsx";
import { secureKv } from "../src/fleet/persist.ts";
import { PrefsProvider } from "../src/prefs/prefs.tsx";
import { FONT_ASSETS } from "../src/theme/fonts.ts";
import { ThemeProvider, useTheme } from "../src/theme/theme.tsx";
import { Banner } from "../src/ui/Banner.tsx";

void SplashScreen.preventAutoHideAsync().catch(() => {});

/** Built once: real, or the fixture kit's when the build asked for it (`deps.ts`). */
const FLEET_DEPS = appFleetDeps();
const NAV: RouteNavigator = {
  push: (href) => router.push(href as never),
  dismissTo: (href) => router.dismissTo(href as never),
};
const openHref = (href: string) => openRoute(href, NAV);

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
          <ThemeProvider storage={secureKv}>
            <PrefsProvider storage={secureKv}>
              <FleetProvider deps={FLEET_DEPS} onOpen={openHref}>
                <Shell />
              </FleetProvider>
            </PrefsProvider>
          </ThemeProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Shell() {
  const t = useTheme();
  const { banner, dismissBanner, status } = useFleetContext();
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(t.c.bg).catch(() => {});
  }, [t.c.bg]);
  return (
    <>
      {/*
        Keyed on the pairing status: signing out (or pairing) left iOS drawing a
        light status bar over the light scheme until relaunch, and a remount
        applies the style again.
      */}
      <StatusBar key={status} style={t.scheme === "dark" ? "light" : "dark"} />
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
        <Stack.Screen name="home" options={{ headerShown: false, title: "Hermetic" }} />
        <Stack.Screen name="settings" options={{ headerShown: false, title: "Settings" }} />
        <Stack.Screen name="search" options={{ headerShown: false, animation: "fade" }} />
        <Stack.Screen name="chat/[instance]/[bot]" options={{ title: "" }} />
        <Stack.Screen name="agent/[name]" options={{ title: "Agent" }} />
        {/* A form sheet is a real UIKit modal (react-native-screens presents it
            with presentViewController, dimmed at every detent by default), so
            VoiceOver already stays inside it. Accessibility-tree dumps such as
            AXe's list every window and still show home under it; that is not
            what VoiceOver reaches, and `accessibilityViewIsModal` on the
            sheet's content would change nothing. */}
        <Stack.Screen
          name="listening"
          options={{
            headerShown: false,
            presentation: "formSheet",
            sheetAllowedDetents: [0.6, 1],
            sheetGrabberVisible: true,
            // A raised surface, so the sheet reads apart from the screen under it.
            contentStyle: { backgroundColor: t.c.bg2 },
          }}
        />
        <Stack.Screen
          name="new-chat"
          options={{
            headerShown: false,
            presentation: "formSheet",
            sheetAllowedDetents: [0.6, 1],
            sheetGrabberVisible: true,
            // A raised surface, so the sheet reads apart from the screen under it.
            contentStyle: { backgroundColor: t.c.bg2 },
          }}
        />
      </Stack>
      <Banner
        alert={banner}
        onDismiss={dismissBanner}
        onOpen={(alert) => {
          dismissBanner();
          openHref(routeFor(alert.data));
        }}
      />
    </>
  );
}
