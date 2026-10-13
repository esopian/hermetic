import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * The phone app's Expo config.
 *
 * No EAS project is created or linked from this repo. Push tokens need an EAS
 * project id, which is read from the environment so each operator can supply
 * their own (`EXPO_PUBLIC_PROJECT_ID`, or `EAS_PROJECT_ID` as EAS itself sets
 * it). Without one the app runs and pairs normally, and push registration is
 * skipped (see README.md). `EXPO_PUBLIC_HERMETIC_FIXTURE=1` builds fixture
 * mode (`src/fixture/`); it is read in the app, not here.
 */
const projectId = process.env.EXPO_PUBLIC_PROJECT_ID || process.env.EAS_PROJECT_ID || undefined;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Hermetic",
  slug: "hermetic-mobile",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  scheme: "hermetic",
  userInterfaceStyle: "automatic",
  backgroundColor: "#0e0e0d",
  ios: {
    bundleIdentifier: "com.hermetic.mobile",
    supportsTablet: false,
    infoPlist: {
      UIBackgroundModes: ["remote-notification", "fetch", "processing"],
      NSCameraUsageDescription:
        "Hermetic uses the camera to scan the pairing QR code shown on your laptop.",
      // The phone talks to the boxes over the tailnet (WireGuard encrypts and
      // authenticates every link; see mobile/AGENTS.md, "Transport security").
      // The Hermes gateway, noVNC and the Tailscale probe are HTTPS through
      // Tailscale Serve and need no exception. hermeticd (`GET /fleet`,
      // `/push/devices`) is plain HTTP on port 7434 inside the tunnel, and ATS
      // blocks cleartext to a public FQDN, which is what a MagicDNS name
      // (`box.tailXXXX.ts.net`) is to iOS. So `ts.net` and its subdomains keep
      // cleartext HTTP: the narrowest exception that covers every operator's
      // tailnet, since the tailnet's own label differs per operator. IP
      // literals (100.64.0.0/10, fd7a:115c:a1e0::/48) are outside ATS anyway.
      // Everything else keeps full ATS.
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: false,
        NSExceptionDomains: {
          "ts.net": { NSIncludesSubdomains: true, NSExceptionAllowsInsecureHTTPLoads: true },
        },
      },
      // `canOpenURL("tailscale://")` answers only for schemes listed here
      // (the Bots screen's "Open Tailscale").
      LSApplicationQueriesSchemes: ["tailscale"],
      NSLocalNetworkUsageDescription:
        "Hermetic connects to your fleet's agents over your Tailscale network.",
    },
  },
  android: {
    package: "com.hermetic.mobile",
    adaptiveIcon: {
      backgroundColor: "#0e0e0d",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-background-task",
    [
      "expo-font",
      {
        fonts: [
          "./assets/fonts/Archivo-Regular.ttf",
          "./assets/fonts/Archivo-Medium.ttf",
          "./assets/fonts/Archivo-SemiBold.ttf",
          "./assets/fonts/Archivo-Bold.ttf",
          "./assets/fonts/Archivo-ExtraBold.ttf",
          "./assets/fonts/Archivo-Black.ttf",
          "./assets/fonts/JetBrainsMono-Regular.ttf",
          "./assets/fonts/JetBrainsMono-Medium.ttf",
          "./assets/fonts/JetBrainsMono-Bold.ttf",
        ],
      },
    ],
    [
      "expo-splash-screen",
      { image: "./assets/splash-icon.png", imageWidth: 120, backgroundColor: "#0e0e0d" },
    ],
    ["expo-notifications", { enableBackgroundRemoteNotifications: true, color: "#ff5a1f" }],
    [
      "expo-camera",
      {
        cameraPermission: "Hermetic uses the camera to scan the pairing QR code shown on your laptop.",
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
  ],
  experiments: { typedRoutes: false },
  extra: {
    ...config.extra,
    eas: projectId ? { projectId } : undefined,
  },
});
