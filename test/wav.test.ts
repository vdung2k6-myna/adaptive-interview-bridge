import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWavAudio } from "../src/protocol/wav.js";

/**
 * The platform's sentence audio is a WAV file, not raw samples.
 *
 * The parser is the only thing standing between a container and the Opus
 * encoder, and a parser that is wrong in a quiet way does not throw anywhere —
 * it hands the encoder a header as the first 44 bytes of speech, or a slice of
 * the wrong length, and the gadget plays a click. So the two halves checked here
 * are the ones a header can lie about: what the format chunk says, and where the
 * samples actually start.
 */

/** A minimal 16-bit PCM WAV, canonical header, samples copied in verbatim. */
function wav(
  pcm: Buffer,
  options: {
    sampleRate?: number;
    channels?: number;
    bitsPerSample?: number;
    audioFormat?: number;
    dataSize?: number;
    chunkBeforeData?: Buffer;
  } = {}
): Buffer {
  const sampleRate = options.sampleRate ?? 24000;
  const channels = options.channels ?? 1;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const audioFormat = options.audioFormat ?? 1;
  const before = options.chunkBeforeData ?? Buffer.alloc(0);

  // fmt is written first, then any extra chunk, then the data header — so a
  // `LIST` really is between the format and the samples, where a reader that
  // assumed `data` sat at offset 36 would trip over it.
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(audioFormat, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 16);
  fmt.writeUInt16LE((channels * bitsPerSample) / 8, 20);
  fmt.writeUInt16LE(bitsPerSample, 22);

  const data = Buffer.alloc(8);
  data.write("data", 0);
  data.writeUInt32LE(options.dataSize ?? pcm.length, 4);

  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0);
  riff.writeUInt32LE(4 + fmt.length + before.length + data.length + pcm.length, 4);
  riff.write("WAVE", 8);

  return Buffer.concat([riff, fmt, before, data, pcm]);
}

/** Six samples worth of distinguishable PCM. */
const pcm = Buffer.from([0x01, 0x00, 0x02, 0x00, 0xfd, 0xff, 0x00, 0x00, 0x7f, 0xff, 0x80, 0x00]);

describe("reading the platform's WAV container", () => {
  it("takes the format from the fmt chunk rather than assuming it", () => {
    const audio = parseWavAudio(wav(pcm, { sampleRate: 22050, channels: 2, bitsPerSample: 16 }));
    assert.equal(audio.sampleRate, 22050);
    assert.equal(audio.channels, 2);
    assert.equal(audio.bitsPerSample, 16);
  });

  it("returns the samples with the container stripped", () => {
    const audio = parseWavAudio(wav(pcm));
    assert.equal(audio.pcm.length, pcm.length);
    assert.deepEqual(audio.pcm, pcm);
  });

  it("walks past an unknown chunk rather than reading it as samples", () => {
    // A `LIST` chunk before `data` is legal and must not become audio — the
    // canonical header-at-12 assumption reads it as the first samples.
    const list = Buffer.concat([
      Buffer.from("LIST", "ascii"),
      Buffer.from([0x04, 0x00, 0x00, 0x00]),
      Buffer.from("INFO", "ascii"),
    ]);
    const audio = parseWavAudio(wav(pcm, { chunkBeforeData: list }));
    assert.deepEqual(audio.pcm, pcm);
  });

  it("reads the rest of the buffer for a data chunk declaring no length", () => {
    // Some encoders write a zero size for a streamed body; treating that
    // literally would call real speech empty.
    const audio = parseWavAudio(wav(pcm, { dataSize: 0 }));
    assert.deepEqual(audio.pcm, pcm);
  });

  it("truncates a data chunk that claims more than the buffer carries", () => {
    const audio = parseWavAudio(wav(pcm, { dataSize: 0xffffff00 }));
    assert.deepEqual(audio.pcm, pcm);
  });

  it("refuses a buffer with no RIFF/WAVE signature", () => {
    assert.throws(() => parseWavAudio(Buffer.from("this is opus, honestly")), /RIFF/);
  });

  it("refuses a buffer too short to hold a header", () => {
    assert.throws(() => parseWavAudio(Buffer.from([0x52, 0x49])), /shorter/);
  });

  it("refuses a depth Opus does not encode rather than reinterpreting it", () => {
    assert.throws(() => parseWavAudio(wav(pcm, { bitsPerSample: 8 })), /16-bit PCM/);
  });

  it("refuses a float WAV, whose bytes are not quiet PCM", () => {
    assert.throws(() => parseWavAudio(wav(pcm, { audioFormat: 3 })), /16-bit PCM/);
  });

  it("refuses a data chunk that arrives before its fmt chunk", () => {
    const dataFirst = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from("WAVE", "ascii"),
      Buffer.from("data", "ascii"),
      Buffer.from([0x04, 0x00, 0x00, 0x00]),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
    ]);
    assert.throws(() => parseWavAudio(dataFirst), /before its fmt/);
  });
});
