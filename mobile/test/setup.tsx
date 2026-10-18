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
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn(async () => true) }));
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
