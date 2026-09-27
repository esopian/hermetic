/**
 * Header bar: the logo, the view navigation, and the bell and theme on the
 * right — nothing else.
 *
 * The fleet switcher and the account and region cells used to sit here; they
 * moved to the env strip (`EnvStrip.tsx`, `FleetMenu.tsx`), which is the line
 * that names where an action lands. That freed the header for
 * `FLEET | CHAT | SETTINGS`, which used to take a 44px row of its own.
 */
import type { ReactNode } from "react";
import { useTheme } from "../state/state.tsx";

/**
 * The app icon's mark (`packages/app/assets/icon-1024.png`), drawn rather than
 * embedded: the 3×3 grid of accent squares with the centre column in the
 * foreground colour and an H cut into the middle. Square corners — the icon's
 * rounded tile is the operating system's shape, not ours. Colours are tokens,
 * so the mark follows the theme instead of carrying the icon's dark tile.
 */
function LogoMark() {
  const cells = [0, 1, 2].flatMap((row) => [0, 1, 2].map((col) => ({ row, col })));
  return (
    <svg className="header-mark" viewBox="0 0 22 22" width="22" height="22" aria-hidden="true">
      {cells.map(({ row, col }) => (
        <rect
          key={`${row}-${col}`}
          x={col * 8}
          y={row * 8}
          width="6"
          height="6"
          fill={col === 1 ? "var(--fg)" : "var(--acc)"}
        />
      ))}
      <path d="M9.2 9.2h1v1.3h1.6V9.2h1v3.6h-1v-1.3h-1.6v1.3h-1z" fill="var(--bg)" />
    </svg>
  );
}

export function Header({
  nav,
  bell,
}: {
  /**
   * The view navigation (`ViewNav`), passed in rather than built here: its
   * badge reads the fleet and the volume inventory, which the shell already
   * holds. Absent before `hermetic init` and in the wizard, where there are no
   * views to move between.
   */
  nav?: ReactNode;
  /**
   * The notification bell (§4.9). Passed in rather than rendered here so
   * the header stays free of the inbox's provider — it is drawn on screens that
   * have one and simply absent on the ones that do not.
   */
  bell?: ReactNode;
}) {
  const [theme, onToggleTheme] = useTheme();

  return (
    <header className="header">
      <div className="header-logo">
        <LogoMark />
        <b>Hermetic</b>
      </div>

      <div className="header-mid">{nav ?? null}</div>

      <div className="header-right">
        {bell ?? null}
        <button
          type="button"
          className="theme-toggle"
          onClick={onToggleTheme}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? "☾ dark" : "☼ light"}
        </button>
      </div>
    </header>
  );
}
