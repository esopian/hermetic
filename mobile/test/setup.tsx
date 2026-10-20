/**
 * Jest setup: native modules without a JS fallback are swapped for their
 * published mocks. Client-layer tests need none of this; component tests do.
 */
jest.mock("react-native-worklets", () => require("react-native-worklets/lib/module/mock"));
jest.mock("react-native-reanimated", () => require("react-native-reanimated/mock"));
jest.mock("expo-haptics", () => ({
  selectionAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  impactAsync: jest.fn(async () => {}),
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
}));
// The pasteboard holds no image unless a test says otherwise; the paste
// control is a plain view whose `onPress` a test fires with a payload.
jest.mock("expo-clipboard", () => {
  const { View } = require("react-native");
  return {
    setStringAsync: jest.fn(async () => true),
    hasImageAsync: jest.fn(async () => false),
    getImageAsync: jest.fn(async () => null),
    addClipboardListener: jest.fn(() => ({ remove: jest.fn() })),
    isPasteButtonAvailable: true,
    ContentType: { PLAIN_TEXT: "plain-text", HTML: "html", IMAGE: "image", URL: "url" },
    ClipboardPasteButton: (props: Record<string, unknown>) => <View {...props} />,
  };
});
// The attachment pickers (`src/client/pick-attachment.ts`): cancelled unless a test says otherwise.
jest.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: null })),
  launchCameraAsync: jest.fn(async () => ({ canceled: true, assets: null })),
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true })),
  UIImagePickerPreferredAssetRepresentationMode: {
    Automatic: "automatic",
    Compatible: "compatible",
    Current: "current",
  },
}));
jest.mock("expo-document-picker", () => ({
  getDocumentAsync: jest.fn(async () => ({ canceled: true, assets: null })),
}));
require("react-native-gesture-handler/jestSetup");
// The swipeable's gestures need real worklets; in jest it is a plain wrapper.
jest.mock("react-native-gesture-handler/ReanimatedSwipeable", () => {
  const { forwardRef } = require("react");
  const { View } = require("react-native");
  return {
    __esModule: true,
    default: forwardRef(({ children }: { children: unknown }, _ref: unknown) => (
      <View>{children}</View>
    )),
  };
});
