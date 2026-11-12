/**
 * HOW-68 D19: the viewer's one sound is a short soft tone, and the committed file is exactly
 * what tools/chime.ts writes. Measured from the bytes, so a replaced file cannot quietly bring
 * the jingle back.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHIME, chimeWav } from "../tools/chime";

const file = readFileSync(join(import.meta.dir, "public", "chime.wav"));

describe("chime.wav", () => {
  test("is what the generator writes", () => {
    expect(Buffer.compare(Buffer.from(chimeWav()), file)).toBe(0);
  });

  test("is one short, quiet, mono 16-bit tone that starts and ends in silence", () => {
    const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
    expect(file.toString("latin1", 0, 4)).toBe("RIFF");
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(44_100);
    expect(v.getUint16(34, true)).toBe(16);
    const n = v.getUint32(40, true) / 2;
    const seconds = n / 44_100;
    expect(seconds).toBeLessThanOrEqual(0.2); // the old file was 0.70s
    expect(seconds).toBeCloseTo(CHIME.seconds, 3);
    let peak = 0;
    const samples: number[] = [];
    for (let i = 0; i < n; i++) { const s = v.getInt16(44 + i * 2, true); samples.push(s); peak = Math.max(peak, Math.abs(s)); }
    const peakDb = 20 * Math.log10(peak / 32767);
    expect(peakDb).toBeLessThanOrEqual(-17.5);
    expect(peakDb).toBeGreaterThanOrEqual(-19.5);
    expect(samples[0]).toBe(0);
    expect(samples[n - 1]).toBe(0);
    // ONE note: the zero crossings are evenly spaced (a second pitch would not be). Read over the
    // audible body — the last 40% is under 16-bit resolution of the decay and quantises.
    const crossings: number[] = [];
    for (let i = 1; i < n * 0.6; i++) if (samples[i - 1]! < 0 && samples[i]! >= 0) crossings.push(i);
    const periods = crossings.slice(1).map((c, i) => c - crossings[i]!);
    expect(Math.max(...periods) - Math.min(...periods)).toBeLessThanOrEqual(2);
    expect(44_100 / (periods.reduce((a, b) => a + b, 0) / periods.length)).toBeCloseTo(CHIME.hz, -1);
  });
});
