import { chatTime } from "../../src/chat/time.ts";

// Local wall-clock dates, so the expectations hold in any time zone.
const NOW = new Date(2026, 9, 13, 18, 0).getTime();
const at = (d: Date) => d.toISOString();
const nbsp = String.fromCharCode(0xa0);

describe("chatTime", () => {
  test("today reads like the home list: 12-hour, no leading zero, AM/PM kept on the line", () => {
    expect(chatTime(at(new Date(2026, 9, 13, 16, 38)), NOW)).toBe(`4:38${nbsp}PM`);
    expect(chatTime(at(new Date(2026, 9, 13, 9, 5)), NOW)).toBe(`9:05${nbsp}AM`);
  });

  test("before today falls back to the rail's forms; nothing usable is a dash", () => {
    expect(chatTime(at(new Date(2026, 9, 9, 12, 0)), NOW)).toBe("Fri");
    expect(chatTime(at(new Date(2026, 8, 2, 12, 0)), NOW)).toBe("Sep 2");
    expect(chatTime(null, NOW)).toBe("—");
    expect(chatTime("not a date", NOW)).toBe("—");
  });
});
