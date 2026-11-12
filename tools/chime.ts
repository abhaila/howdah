/**
 * Generates web/public/chime.wav — the one sound the viewer can make (HOW-68 D19).
 *
 * The file this replaces was a 0.70s two-note figure: a jingle, played for something that is
 * already said by a count, an icon and a notification. DESIGN.md "Notifications and sound"
 * asks for a sound that is off by default and, when on, is barely there. So: ONE tone.
 *
 *   160ms · 660 Hz sine · 10ms linear attack · exponential decay · peak −18 dBFS
 *   44.1 kHz · mono · 16-bit PCM
 *
 * The decay reaches −60 dB of the peak by the last sample and the final 5ms are faded to
 * exactly zero, so there is no click at either end. Deterministic: no randomness, no dither —
 * running it twice writes the same bytes, which is what makes the committed file reviewable.
 *
 *   bun tools/chime.ts            # rewrite web/public/chime.wav
 *   bun tools/chime.ts --check    # exit 1 if the committed file is not what this would write
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CHIME = { seconds: 0.16, hz: 660, attackSeconds: 0.01, peakDb: -18, rate: 44_100 } as const;

export function chimeWav(c: typeof CHIME = CHIME): Uint8Array {
  const n = Math.round(c.seconds * c.rate);
  const peak = 10 ** (c.peakDb / 20);
  const attack = Math.round(c.attackSeconds * c.rate);
  const release = Math.round(0.005 * c.rate);
  // e^(-k·t) falls 60 dB over the body of the tone
  const k = Math.log(1000) / (n - attack);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  ascii(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); ascii(8, "WAVE");
  ascii(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, c.rate, true); v.setUint32(28, c.rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const env = i < attack ? i / attack : Math.exp(-k * (i - attack));
    const tail = i >= n - release ? (n - 1 - i) / release : 1;
    const s = Math.sin((2 * Math.PI * c.hz * i) / c.rate) * peak * env * tail;
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}

if (import.meta.main) {
  const path = join(import.meta.dir, "..", "web", "public", "chime.wav");
  const wav = chimeWav();
  if (process.argv.includes("--check")) {
    const same = Buffer.compare(Buffer.from(wav), readFileSync(path)) === 0;
    console.log(same ? "chime.wav is current" : "chime.wav is NOT what tools/chime.ts writes — run `bun tools/chime.ts`");
    process.exit(same ? 0 : 1);
  }
  writeFileSync(path, wav);
  console.log(`wrote ${path} (${wav.length} bytes, ${CHIME.seconds * 1000}ms)`);
}
