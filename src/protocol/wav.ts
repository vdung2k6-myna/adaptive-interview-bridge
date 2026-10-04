/**
 * The platform's audio, unwrapped from the container it arrives in.
 *
 * A `sentence` event's `audioData` is base64 of a whole **WAV file**, header and
 * all — the platform's own synthesizer documents its result as "WAV format" and
 * reads the rate back out of that header on its side. Handing those bytes
 * straight to the Opus encoder would feed it the 44-byte RIFF header as the first
 * 44 bytes of speech, which is a click at the front of every sentence and a
 * sample rate taken from nowhere. So the container is parsed once, here, and what
 * leaves this module is PCM plus the properties that describe it.
 *
 * The header is read rather than assumed. `BRIDGE_SERVER_RATE` is the rate this
 * deployment *believes* the platform speaks at; the header is what it actually
 * did, and the two are reported here rather than reconciled here. `opus.ts` is
 * where they are made to agree — by resampling and downmixing to the rate the
 * hello already promised — and it can only do that because this module says what
 * arrived instead of quietly assuming.
 */

/** PCM, the one format Opus encodes. An IEEE-float WAV is not quieter PCM; its
 *  bytes mean something else entirely, so it is refused rather than read. */
const PCM_FORMAT = 1;

/** Opus takes 16-bit samples, so the depth is part of what "WAV" has to mean
 *  here rather than a detail to adapt to. */
const PCM_BITS = 16;

export interface WavAudio {
  /** From the `fmt` chunk — what the platform actually produced. */
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Little-endian signed 16-bit samples, with the container stripped. */
  pcm: Buffer;
}

/**
 * Read a WAV buffer down to its samples.
 *
 * Throws on anything that is not 16-bit PCM that Opus could carry. A caller that
 * would rather not end a turn over a malformed sentence can catch this; the
 * endpoint already reports a failed synthesis as `audioData: null`, so a throw
 * here means the bytes arrived and were the wrong shape, which is a bug worth
 * surfacing rather than a case worth handling.
 */
export function parseWavAudio(buffer: Buffer): WavAudio {
  if (buffer.length < 12) {
    throw new Error(`not a WAV: ${buffer.length} byte(s) is shorter than a RIFF header`);
  }
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV: no RIFF/WAVE signature");
  }

  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null =
    null;

  // Chunks are walked rather than indexed: the header is nominally at offset 12,
  // but a producer may put a `LIST` or `fact` chunk before `data`, and a reader
  // that assumed the canonical layout would read that chunk as samples.
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    // RIFF pads an odd-sized chunk to a word boundary; the pad byte is not part
    // of the next chunk's id.
    const next = body + size + (size % 2);

    if (id === "fmt ") {
      if (body + 16 > buffer.length) throw new Error("not a WAV: the fmt chunk is truncated");
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
      offset = next;
      continue;
    }

    if (id === "data") {
      if (!format) throw new Error("not a WAV: the data chunk arrives before its fmt chunk");
      if (format.audioFormat !== PCM_FORMAT || format.bitsPerSample !== PCM_BITS) {
        throw new Error(
          `not PCM audio Opus can encode: format ${format.audioFormat} at ${format.bitsPerSample} bit, ` +
            `expected 16-bit PCM`
        );
      }
      if (format.channels !== 1 && format.channels !== 2) {
        throw new Error(`not PCM audio Opus can encode: ${format.channels} channels, expected mono or stereo`);
      }
      return {
        sampleRate: format.sampleRate,
        channels: format.channels,
        bitsPerSample: format.bitsPerSample,
        // The declared length is honoured, not trusted: a chunk claiming more
        // than the buffer carries is truncated to what arrived, and a length of
        // zero — which a streaming encoder writes before it knows the size —
        // means the rest of the buffer. Reading the declaration literally in
        // either case would call real speech empty.
        pcm: buffer.subarray(body, size === 0 ? buffer.length : Math.min(next, buffer.length)),
      };
    }

    offset = next;
  }

  throw new Error("not a WAV: no data chunk");
}
