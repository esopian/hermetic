/**
 * The chrome button of the home and conversation bars: a square with a 1px
 * `line` border (no fill) and one line-drawn glyph, square like every other
 * control. Every icon button in the app goes through here, so each one carries
 * an accessibility label and a 44pt tap target.
 */
import { Pressable, View } from "react-native";
import Svg, { Circle, Line, Path } from "react-native-svg";
import { useTheme } from "../theme/theme.tsx";

export type IconName =
  | "gear"
  | "search"
  | "plus"
  | "back"
  | "more"
  | "close"
  | "sent"
  | "star"
  | "eye"
  | "eyeOff"
  | "board";

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
      ) : name === "eye" || name === "eyeOff" ? (
        // Show or hide a masked value: an open eye, struck through once it is shown.
        <>
          <Path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" {...stroke} />
          <Circle cx={12} cy={12} r={3} {...stroke} />
          {name === "eyeOff" ? <Line x1={4} y1={20} x2={20} y2={4} {...stroke} /> : null}
        </>
      ) : name === "board" ? (
        // The kanban board as a checklist: three cards, each with its line.
        <>
          <Path d="M4 4.5h4v4H4zM4 10h4v4H4zM4 15.5h4v4H4z" {...stroke} />
          <Line x1={11} y1={6.5} x2={20} y2={6.5} {...stroke} />
          <Line x1={11} y1={12} x2={20} y2={12} {...stroke} />
          <Line x1={11} y1={17.5} x2={20} y2={17.5} {...stroke} />
        </>
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
  /** Drawn side; the tap target is never under 44pt. */
  size?: number;
  /** Draw the 1px border (the home bar) or a bare glyph (inline). */
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
            alignItems: "center",
            justifyContent: "center",
            // A border only, in the quieter line colour (the desktop's row rule);
            // the press shows as the selection fill.
            borderWidth: ring ? t.border.row : 0,
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
