/** The nine cells of assets/brand/mark.svg, cropped from the same native splash asset. */
import { View } from "react-native";
import Animated, { interpolate, type SharedValue, useAnimatedStyle } from "react-native-reanimated";

const SOURCE = require("../../assets/splash-icon.png");
const SIZE = 120;
const UNIT = SIZE / 220;
const CELL = 60 * UNIT;
const HANDOFF_START_MS = 100;
const HANDOFF_END_MS = 140;
const LIFT_DURATION_MS = 360;
// The cream spine finds the H first; the orange columns follow in overlapping waves.
const PIECES = [
  { column: 0, row: 0, settleAt: 860, settleMs: 720, angle: -22 },
  { column: 1, row: 0, settleAt: 560, settleMs: 640, angle: 0 },
  { column: 2, row: 0, settleAt: 1440, settleMs: 720, angle: 22 },
  { column: 0, row: 1, settleAt: 1040, settleMs: 720, angle: -12 },
  { column: 1, row: 1, settleAt: 0, settleMs: 1, angle: 0 },
  { column: 2, row: 1, settleAt: 1620, settleMs: 720, angle: 12 },
  { column: 0, row: 2, settleAt: 1220, settleMs: 720, angle: 22 },
  { column: 1, row: 2, settleAt: 700, settleMs: 640, angle: 0 },
  { column: 2, row: 2, settleAt: 1800, settleMs: 720, angle: -22 },
] as const;

function Piece({ piece, clock }: { piece: (typeof PIECES)[number]; clock: SharedValue<number> }) {
  const x = piece.column * 80 * UNIT;
  const y = piece.row * 80 * UNIT;
  const style = useAnimatedStyle(() => {
    const lift = Math.max(0, Math.min(1, (clock.value - HANDOFF_END_MS) / LIFT_DURATION_MS));
    const settle = Math.max(0, Math.min(1, (clock.value - piece.settleAt) / piece.settleMs));
    // Smooth acceleration and deceleration make each placement readable without a bounce.
    const offset = lift * lift * (3 - 2 * lift) * (1 - settle * settle * (3 - 2 * settle));
    const center = piece.column === 1 && piece.row === 1;
    return {
      opacity:
        (center ? 1 : 1 - 0.62 * offset) *
        interpolate(clock.value, [HANDOFF_START_MS, HANDOFF_END_MS], [0, 1], "clamp"),
      transform: [
        { translateX: (piece.column - 1) * 18 * offset },
        { translateY: (piece.row - 1) * (piece.column === 1 ? 22 : 13) * offset },
        { rotate: `${piece.angle * offset}deg` },
      ],
    };
  });
  return (
    <Animated.View
      style={[
        { position: "absolute", left: x, top: y, width: CELL, height: CELL, overflow: "hidden" },
        style,
      ]}
    >
      <Animated.Image
        accessible={false}
        source={SOURCE}
        resizeMode="contain"
        style={{ position: "absolute", width: SIZE, height: SIZE, left: -x, top: -y }}
      />
    </Animated.View>
  );
}

export function EntryMark({
  clock,
  animated,
  onLoad,
  onError,
}: {
  clock: SharedValue<number>;
  animated: boolean;
  onLoad(): void;
  onError(): void;
}) {
  // Start on the exact native raster; exchange it for matching cells before they move.
  const still = useAnimatedStyle(() => ({
    opacity: animated
      ? interpolate(clock.value, [0, HANDOFF_START_MS, HANDOFF_END_MS], [1, 1, 0], "clamp")
      : 1,
  }));
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: SIZE, height: SIZE }}
    >
      {animated
        ? PIECES.map((piece) => (
            <Piece key={`${piece.column}:${piece.row}`} piece={piece} clock={clock} />
          ))
        : null}
      <Animated.Image
        testID="entry-mark"
        accessible={false}
        source={SOURCE}
        onLoad={onLoad}
        onError={onError}
        resizeMode="contain"
        style={[{ width: SIZE, height: SIZE }, still]}
      />
    </View>
  );
}
