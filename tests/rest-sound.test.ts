import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const wavPath = new URL("../ios/Steady/rest-done.wav", import.meta.url);
const wav = fs.readFileSync(wavPath);

test("rest-done.wav is one short ding", () => {
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");

  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: Buffer | null = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      audioFormat = wav.readUInt16LE(body);
      channels = wav.readUInt16LE(body + 2);
      sampleRate = wav.readUInt32LE(body + 4);
      bits = wav.readUInt16LE(body + 14);
    } else if (id === "data") {
      data = wav.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }

  assert.equal(audioFormat, 1);
  assert.equal(channels, 1);
  assert.equal(bits, 16);
  assert.ok(sampleRate >= 22050);
  assert.ok(data);
  const samples = data.length / 2;
  const duration = samples / sampleRate;
  assert.ok(duration >= 0.2 && duration <= 0.5, `duration ${duration}`);

  const win = Math.floor(sampleRate * 0.02);
  const rms: number[] = [];
  for (let i = 0; i + win <= samples; i += win) {
    let sum = 0;
    for (let j = 0; j < win; j += 1) {
      const sample = data.readInt16LE((i + j) * 2);
      sum += sample * sample;
    }
    rms.push(Math.sqrt(sum / win) / 32768);
  }
  const peak = Math.max(...rms);
  assert.ok(peak > 0.05, `peak ${peak}`);
  let regions = 0;
  let on = false;
  for (const value of rms) {
    const hot = value > peak * 0.15;
    if (hot && !on) regions += 1;
    on = hot;
  }
  assert.equal(regions, 1);
});

test("the rest cue dings once and does not require a new signing capability", () => {
  const source = fs.readFileSync(new URL("../ios/Steady/RestController.swift", import.meta.url), "utf8");
  const entitlements = fs.readFileSync(new URL("../ios/Steady/Steady.entitlements", import.meta.url), "utf8");
  assert.match(source, /UNNotificationSoundName\("rest-done\.wav"\)/);
  assert.match(source, /notificationOccurred\(\.success\)/);
  assert.match(source, /\[\.banner, \.sound, \.list\]/);
  assert.match(source, /\[\.banner, \.list\]/);
  assert.match(source, /cued/);
  assert.match(source, /Activity\.request/);
  assert.doesNotMatch(source, /interruptionLevel/);
  assert.doesNotMatch(source, /timeSensitive/);
  assert.doesNotMatch(entitlements, /time-sensitive/);
  assert.match(entitlements, /group\.com\.brando454\.steady/);
});
