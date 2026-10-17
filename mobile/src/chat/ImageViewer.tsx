/**
 * A transcript picture, full screen: the image fitted inside a square-edged
 * frame, its name as a kicker, and one close button. Opened by tapping any
 * picture in the transcript (`blocks/Picture.tsx`).
 */
import { Image, Modal, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/theme.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Kicker } from "../ui/Kicker.tsx";

export function ImageViewer({
  uri,
  title,
  onClose,
}: {
  /** The picture to show; `null` keeps the viewer shut. */
  uri: string | null;
  title: string;
  onClose(): void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={uri !== null}
      animationType="fade"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View
        testID="image-viewer"
        style={{
          flex: 1,
          backgroundColor: t.c.bg,
          paddingTop: insets.top,
          paddingBottom: insets.bottom + t.space.lg,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: t.space.md,
            paddingHorizontal: t.space.lg,
            paddingVertical: t.space.sm,
            borderBottomWidth: t.border.row,
            borderBottomColor: t.c.line,
          }}
        >
          <Kicker numberOfLines={1} style={{ flex: 1 }}>
            {title || "Image"}
          </Kicker>
          <IconButton icon="close" label="Close image" onPress={onClose} />
        </View>
        <View style={{ flex: 1, padding: t.space.lg }}>
          <View
            style={{
              flex: 1,
              borderWidth: t.border.row,
              borderColor: t.c.line,
              backgroundColor: t.c.bg2,
            }}
          >
            {uri ? (
              <Image
                source={{ uri }}
                accessibilityLabel={title || "Image"}
                resizeMode="contain"
                style={{ flex: 1 }}
              />
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}
