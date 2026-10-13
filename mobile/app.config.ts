import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * The phone app's Expo config.
 *
 * No EAS project is created or linked from this repo. Push tokens need an EAS
 * project id, which is read from the environment so each operator can supply
 * their own (`EXPO_PUBLIC_PROJECT_ID`, or `EAS_PROJECT_ID` as EAS itself sets
 * it). Without one the app runs and pairs normally, and push registration is
 * skipped (see README.md).
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
      // The bridge is plain HTTP/WS on the tailnet (WireGuard encrypts the
      // link; see mobile/AGENTS.md, "Transport security"). ATS never covers IP
      // literals, so 127.0.0.1, 100.64.0.0/10 and fd7a:115c:a1e0::/48 need
      // nothing. `NSAllowsLocalNetworking` covers `localhost` (an unqualified
      // name). A MagicDNS name (`laptop.tailXXXX.ts.net`) is a public FQDN to
      // ATS, so `ts.net` and its subdomains get cleartext HTTP — the narrowest
      // exception that covers every tailnet, since the tailnet's own label
      // differs per operator. Everything else keeps full ATS; noVNC is HTTPS.
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: false,
        NSAllowsLocalNetworking: true,
        NSExceptionDomains: {
          "ts.net": { NSIncludesSubdomains: true, NSExceptionAllowsInsecureHTTPLoads: true },
        },
      },
      NSLocalNetworkUsageDescription: "Hermetic connects to the bridge running on your laptop.",
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
