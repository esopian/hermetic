/**
 * The round chrome button of the home and conversation bars: a 44pt circle
 * with a thin ring (no fill) and one line-drawn glyph. Every icon button in the app
 * goes through here, so each one carries an accessibility label and a 44pt
 * tap target.
 */
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Circle, Line, Path } from "react-native-svg";
import { useTheme } from "../theme/theme.tsx";

export type IconName = "gear" | "search" | "plus" | "back" | "more" | "close" | "sent" | "star";

/** One line-drawn glyph on a 24-unit grid, stroked in `color`. */
export function Icon({
  name,
  size = 22,
  color,
  strokeWidth = 1.8,
}: {
  name: IconName;
  size?: number;
  color: string;
  strokeWidth?: number;
}) {
  const stroke = {
    stroke: color,
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === "gear" ? (
        <>
          <Circle cx={12} cy={12} r={3.2} {...stroke} />
          <Path
            d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z"
            {...stroke}
          />
        </>
      ) : name === "search" ? (
        <>
          <Circle cx={10.5} cy={10.5} r={6.5} {...stroke} />
          <Line x1={15.3} y1={15.3} x2={20.5} y2={20.5} {...stroke} />
        </>
      ) : name === "plus" ? (
        <>
          <Line x1={12} y1={4.5} x2={12} y2={19.5} {...stroke} />
          <Line x1={4.5} y1={12} x2={19.5} y2={12} {...stroke} />
        </>
      ) : name === "back" ? (
        <Path d="M15 4.5 7.5 12l7.5 7.5" {...stroke} />
      ) : name === "close" ? (
        <>
          <Line x1={6} y1={6} x2={18} y2={18} {...stroke} />
          <Line x1={18} y1={6} x2={6} y2={18} {...stroke} />
        </>
      ) : name === "sent" ? (
        // The reference's outgoing glyph: a paper plane, point to the upper right.
        <Path d="M21 3 3 10.5l7.5 3L13.5 21 21 3zM10.5 13.5 21 3" {...stroke} />
      ) : name === "star" ? (
        <Path
          d="m12 3.5 2.6 5.3 5.8.85-4.2 4.1 1 5.8L12 16.8l-5.2 2.75 1-5.8-4.2-4.1 5.8-.85z"
          fill={color}
          stroke={color}
          strokeWidth={1}
          strokeLinejoin="round"
        />
      ) : (
        <>
          <Circle cx={5.5} cy={12} r={1.5} fill={color} />
          <Circle cx={12} cy={12} r={1.5} fill={color} />
          <Circle cx={18.5} cy={12} r={1.5} fill={color} />
        </>
      )}
    </Svg>
  );
}

export interface IconButtonProps {
  icon: IconName;
  /** What VoiceOver reads; required, since the button has no text. */
  label: string;
  onPress: () => void;
  /** Drawn diameter; the tap target is never under 44pt. */
  size?: number;
  /** Draw the hairline ring (the home bar) or a bare glyph (inline). */
  ring?: boolean;
  disabled?: boolean;
  testID?: string;
}

export function IconButton({
  icon,
  label,
  onPress,
  size = 44,
  ring = true,
  disabled = false,
  testID,
}: IconButtonProps) {
  const t = useTheme();
  const slop = Math.max(0, (44 - size) / 2);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={slop}
      testID={testID}
      style={({ pressed }) => ({ opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}
    >
      {({ pressed }) => (
        <View
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            alignItems: "center",
            justifyContent: "center",
            // A ring only, in the quieter line colour: a filled disc inside a ring read heavy,
            // in the light scheme above all. The press shows as a soft fill.
            borderWidth: ring ? StyleSheet.hairlineWidth * 2 : 0,
            borderColor: t.c.line,
            backgroundColor: pressed ? t.c.sel : "transparent",
          }}
        >
          <Icon name={icon} size={Math.round(size * 0.48)} color={t.c.fg} />
        </View>
      )}
    </Pressable>
  );
}
