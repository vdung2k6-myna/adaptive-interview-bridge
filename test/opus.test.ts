import { describe, it } from "node:test";
import assert from "node:assert/strict";
import OpusScript from "opusscript";
import { encodeOpusFrames, transcodeSentence } from "../src/protocol/opus.js";

/**
 * The one piece of the bridge on the hot path.
 *
 * Everything here is checkable without a device: the device's side of the
 * contract is a stream of Opus packets at the rate the hello declared, and Opus
 * is its own oracle — encode a tone, decode it back with a fresh decoder, and if
 * the samples that come out are not the tone that went in, the gadget would have
 * played something else. The hello's promise is checked the same way: whatever
 * the platform sends, what leaves here is mono at the declared rate.
 */

const RATE = 24000;
const FRAME_MS = 60;
const SAMPLES_PER_FRAME = (RATE * FRAME_MS) / 1000; // 1440
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2;

/** A sine as 16-bit samples, the shape the platform's speech arrives in. */
function tone(samples: number, rate = RATE, amplitude = 12000, hz = 440): Int16Array {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amplitude);
  }
  return out;
}

function toPcm(samples: Int16Array): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(samples[i]!, i * 2);
  return pcm;
}

/** The tone wrapped in the WAV container the endpoint sends, mono or interleaved. */
function toneWav(frames: number, options: { sampleRate?: number; channels?: number } = {}): Buffer {
  const sampleRate = options.sampleRate ?? RATE;
  const channels = options.channels ?? 1;
  const mono = tone(frames, sampleRate);

  let samples = mono;
  if (channels > 1) {
    samples = new Int16Array(frames * channels);
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) samples[i * channels + c] = mono[i]!;
    }
  }
  const pcm = toPcm(samples);

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Decode a whole stream of packets with one decoder, as the device would. */
function decodeAll(frames: Buffer[]): Buffer {
  const decoder = new OpusScript(RATE, 1, OpusScript.Application.AUDIO);
  try {
    return Buffer.concat(frames.map((frame) => decoder.decode(frame)));
  } finally {
    decoder.delete();
  }
}

function peak(pcm: Buffer): number {
  let max = 0;
  for (let i = 0; i < pcm.length / 2; i++) max = Math.max(max, Math.abs(pcm.readInt16LE(i * 2)));
  return max;
}

describe("encoding a sentence as Opus frames", () => {
  it("produces one packet per declared frame, with the tail padded not dropped", () => {
    // A second of audio is 16 whole frames and a third of one; dropping the
    // remainder would clip the last word of every sentence.
    const frames = encodeOpusFrames(toPcm(tone(RATE)), 1, { sampleRate: RATE, frameMs: FRAME_MS });
    assert.equal(frames.length, Math.ceil(RATE / SAMPLES_PER_FRAME));
    assert.ok(frames.every((frame) => frame.length > 0), "every frame is a packet the device can play");
  });

  it("round-trips a tone through the decoder it will meet on the device", () => {
    const frames = encodeOpusFrames(toPcm(tone(SAMPLES_PER_FRAME * 3)), 1, {
      sampleRate: RATE,
      frameMs: FRAME_MS,
    });
    const decoded = decodeAll(frames);
    assert.equal(decoded.length, BYTES_PER_FRAME * 3);
    assert.ok(peak(decoded) > 11000, `the tone survived (peak ${peak(decoded)} of 12000)`);
  });

  it("pads a short final frame with silence rather than shortening it", () => {
    const frames = encodeOpusFrames(toPcm(tone(100)), 1, { sampleRate: RATE, frameMs: FRAME_MS });
    assert.equal(frames.length, 1);
    assert.equal(decodeAll(frames).length, BYTES_PER_FRAME, "a full frame came back for 100 samples");
  });

  it("sends nothing for a sentence with nothing in it", () => {
    assert.deepEqual(encodeOpusFrames(Buffer.alloc(0), 1, { sampleRate: RATE, frameMs: FRAME_MS }), []);
  });

  it("refuses a rate Opus does not encode, rather than letting the library guess", () => {
    assert.throws(
      () => encodeOpusFrames(toPcm(tone(100)), 1, { sampleRate: 22050, frameMs: FRAME_MS }),
      /not a rate Opus encodes/
    );
  });

  it("refuses a frame duration Opus does not have", () => {
    assert.throws(
      () => encodeOpusFrames(toPcm(tone(100)), 1, { sampleRate: RATE, frameMs: 30 }),
      /not a frame duration Opus encodes/
    );
  });
});

describe("transcoding a sentence's audioData", () => {
  it("turns the WAV the endpoint sends into frames the device can play", () => {
    const frames = transcodeSentence(toneWav(SAMPLES_PER_FRAME), { sampleRate: RATE, frameMs: FRAME_MS });
    assert.equal(frames.length, 1);
    assert.ok(peak(decodeAll(frames)) > 11000);
  });

  it("resamples audio from another rate to the one the hello declared", () => {
    // The device was told 24000 Hz. A sentence that arrives at a different rate
    // is brought to the declared one rather than sent at a rate nobody promised —
    // the alternative is the whole conversation at the wrong pitch.
    const source = 22050;
    const frames = transcodeSentence(toneWav(source, { sampleRate: source }), {
      sampleRate: RATE,
      frameMs: FRAME_MS,
    });
    // A second of audio, now counted in the declared rate's samples.
    const resampled = Math.floor(source * (RATE / source));
    assert.equal(frames.length, Math.ceil(resampled / SAMPLES_PER_FRAME));
    const decoded = decodeAll(frames);
    assert.ok(
      Math.abs(decoded.length / 2 - resampled) < SAMPLES_PER_FRAME,
      `about a second came back (${decoded.length / 2} samples for ${source} in)`
    );
  });

  it("downmixes a stereo sentence, since the hello promises mono", () => {
    const frames = transcodeSentence(toneWav(SAMPLES_PER_FRAME, { channels: 2 }), {
      sampleRate: RATE,
      frameMs: FRAME_MS,
    });
    assert.equal(frames.length, 1, "one frame of mono from one frame of stereo");
    assert.ok(peak(decodeAll(frames)) > 11000);
  });

  it("refuses bytes that are not a WAV at all", () => {
    assert.throws(
      () => transcodeSentence(Buffer.from("raw opus, no container"), { sampleRate: RATE, frameMs: FRAME_MS }),
      /not a WAV/
    );
  });
});
