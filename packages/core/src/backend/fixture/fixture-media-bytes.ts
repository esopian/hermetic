/**
 * Media bytes for the fixture's share turns: a short tone as WAV, built here,
 * and a two-second WebM (VP8, 96×54, `ffmpeg -f lavfi -i testsrc2`) kept as
 * base64 because no code here can encode video. Both play in WebKit and in
 * Chromium, so the share card's player draws in either dev renderer.
 */

/** A mono 16-bit PCM WAV of a `hz` tone, `seconds` long, faded in and out. */
export function fixtureWav(seconds = 1.2, hz = 440, rate = 8000): Uint8Array {
  const samples = Math.round(seconds * rate);
  const out = new Uint8Array(44 + samples * 2);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  const fade = rate / 20;
  for (let i = 0; i < samples; i++) {
    const envelope = Math.min(1, i / fade, (samples - i) / fade);
    const value = Math.sin((2 * Math.PI * hz * i) / rate) * envelope * 0.3;
    view.setInt16(44 + i * 2, Math.round(value * 32767), true);
  }
  return out;
}

const WEBM_B64 = [
  "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",
].join("");

/** The fixture's WebM clip. */
export function fixtureWebm(): Uint8Array {
  const binary = atob(WEBM_B64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
