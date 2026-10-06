import OpusScript from "opusscript";
import { buildWav, parseWavAudio } from "./wav.js";

/**
 * The platform's speech, re-encoded as the device's.
 *
 * The bridge does not synthesize (D3): the endpoint already returns each
 * sentence's audio as it finishes, and this module turns that audio into the
 * Opus frames the device plays. It is the bridge's only code on the hot path, so
 * it is deliberately per-sentence — a caller hands it one sentence's audio and
 * gets that sentence's frames, and nothing here buffers a reply.
 *
 * The bridge does not choose the output format; the hello already did. Before any
 * sentence existed, the bridge told the device it would send Opus at
 * `config.serverRate`, mono, in `config.frameMs` frames, and the device resamples
 * only when the declared rate differs from its speaker. So every sentence leaves
 * here at exactly that rate and channel count: the platform's own audio is
 * resampled to the declared rate when it differs, and downmixed to mono, rather
 * than passed through at a rate or width the device was not promised. What is
 * *not* done is picking a different rate to send at — the one thing a device
 * cannot take back from a hello it has already read.
 *
 * The platform was measured producing 24000 Hz, mono, 16-bit on every sentence of
 * every run, which is the declared rate, so in practice neither the resample nor
 * the downmix does anything. They are here because the alternative to handling a
 * mismatch is a gadget that plays a whole conversation at the wrong pitch.
 *
 * It decodes too, since the bridge carries speech in both directions: the device's
 * packets are the person's own voice (6.1), and this is where they are read back.
 * The two directions are asymmetric in a way worth keeping in view — the encoder is
 * built per sentence and thrown away, and the decoder is built per listening window
 * and thrown away, because Opus carries state and a stateful decoder is a decoder
 * whose answer depends on what it was handed before (D14).
 */

/** The sample rates Opus accepts, which are therefore the only rates a
 *  deployment may declare. */
export type OpusRate = 8000 | 12000 | 16000 | 24000 | 48000;

/** The frame durations Opus encodes, in milliseconds. */
const FRAME_DURATIONS_MS = [2.5, 5, 10, 20, 40, 60];

export interface OpusFraming {
  /** The rate the hello declared — the rate the device will play at. */
  sampleRate: number;
  /** The frame length the hello declared, in ms. */
  frameMs: number;
}

/**
 * Encode PCM into Opus frames, each one packet the device can be handed.
 *
 * One encoder spans the whole buffer rather than a fresh one per frame: Opus is
 * stateful across frames, and resetting it every 60 ms throws away the inter-frame
 * prediction that makes speech cheap to carry. A sentence therefore encodes as one
 * continuous stream, and the encoder is released when it ends — it holds WASM
 * memory, and a turn is many sentences.
 *
 * An empty buffer yields no frames rather than an error. `audioData: null` is the
 * endpoint's own way of saying synthesis produced nothing (5.5), and a sentence
 * with nothing to say is a sentence to skip, not a turn to fail.
 */
export function encodeOpusFrames(pcm: Buffer, channels: number, framing: OpusFraming): Buffer[] {
  const sampleRate = asOpusRate(framing.sampleRate);
  const samplesPerFrame = samplesInFrame(sampleRate, framing.frameMs);
  const bytesPerFrame = samplesPerFrame * channels * 2;

  if (pcm.length === 0) return [];

  const encoder = new OpusScript(sampleRate, channels, OpusScript.Application.AUDIO);
  try {
    const frames: Buffer[] = [];
    for (let offset = 0; offset < pcm.length; offset += bytesPerFrame) {
      const slice = pcm.subarray(offset, offset + bytesPerFrame);
      // A final frame shorter than the rest is padded, not dropped. The tail of a
      // buffer is the end of a word, and Opus cannot encode a partial frame, so
      // the choice is between silence after the last phoneme and losing it.
      const frame = slice.length === bytesPerFrame ? slice : padToFrame(slice, bytesPerFrame);
      frames.push(encoder.encode(frame, samplesPerFrame));
    }
    return frames;
  } finally {
    encoder.delete();
  }
}

/**
 * One sentence's `audioData`, from base64 WAV to frames the device can play (5.1).
 *
 * This is the whole of what the turn's speech path asks for: the container comes
 * off, the PCM is brought to the format the hello promised — mono, at the declared
 * rate — and it leaves as packets. A sentence that arrives at another rate or with
 * more than one channel is normalised rather than refused, because a gadget that
 * plays the whole conversation slightly sharp is harder to diagnose than one that
 * handles the case, and because the platform's rate is a property of a deployment
 * this service does not control.
 */
export function transcodeSentence(wav: Buffer, framing: OpusFraming): Buffer[] {
  const audio = parseWavAudio(wav);
  let samples = toSamples(audio.pcm);

  if (audio.channels > 1) samples = downmix(samples, audio.channels);
  if (audio.sampleRate !== framing.sampleRate) {
    samples = resample(samples, audio.sampleRate, framing.sampleRate);
  }

  return encodeOpusFrames(samplesToBuffer(samples), 1, framing);
}

/**
 * The other direction: the device's Opus, decoded back to samples (6.1).
 *
 * One decoder per listening window, not one per process. Opus is stateful across
 * packets, and a decoder that has already run ahead of the window it is handed
 * decodes the same bytes into a different signal — so the rig's module-level
 * singleton is a defect rather than an optimisation, and two devices sharing one
 * would decode each other's audio (D14). `close()` releases it with the window.
 *
 * The rate is the **device's** — `BRIDGE_DEVICE_RATE`, 16000 Hz — and not the
 * 24000 the hello declares for the downlink. A decoder built at the wrong rate
 * does not produce a wrong pitch; it produces a frame it cannot decode at all,
 * because the sample count is part of what the packet is read as.
 */
export interface OpusDecoder {
  /** One packet's samples, or null if the packet could not be decoded. */
  decode(packet: Buffer): Int16Array | null;
  /** Release the decoder's WASM memory. Idempotent. */
  close(): void;
}

export function createOpusDecoder(sampleRate: number): OpusDecoder {
  const decoder = new OpusScript(asOpusRate(sampleRate), 1, OpusScript.Application.AUDIO);
  let open = true;

  return {
    decode(packet: Buffer): Int16Array | null {
      if (!open || packet.length === 0) return null;
      try {
        return toSamples(decoder.decode(packet));
      } catch {
        // A packet the decoder refuses is one frame of a window, not a failed turn:
        // the frames either side of it are still the person's voice, and the caller
        // records the null and carries on.
        return null;
      }
    },

    close(): void {
      if (!open) return;
      open = false;
      decoder.delete();
    },
  };
}

/**
 * The utterance the endpointer captured, as the file the platform is handed (6.1).
 *
 * The samples are already decoded — one decode per frame, the one the endpointer's
 * verdict was computed from (6.7) — so this concatenates and wraps, and never
 * touches the decoder. That is the difference between this and the rig's
 * `framesToWav`, which decodes the window a second time against a decoder whose
 * state has run ahead in between, so that the audio it judges and the audio it
 * uploads are not the same signal.
 *
 * Frames with no samples are skipped rather than padded, and said so in the count
 * that comes back: silence where a frame failed to decode is a stretch of the
 * person's speech replaced by nothing.
 */
export function framesToWav(
  frames: readonly (Int16Array | null)[],
  sampleRate: number
): { wav: Buffer | null; seconds: number; failed: number } {
  const decoded = frames.filter((frame): frame is Int16Array => frame !== null);
  const failed = frames.length - decoded.length;

  const total = decoded.reduce((count, frame) => count + frame.length, 0);
  if (total === 0) return { wav: null, seconds: 0, failed };

  const joined = new Int16Array(total);
  let at = 0;
  for (const frame of decoded) {
    joined.set(frame, at);
    at += frame.length;
  }

  return { wav: buildWav(joined, sampleRate, 1), seconds: total / sampleRate, failed };
}

/** Narrow a configured number to a rate Opus accepts, or say why not. */
function asOpusRate(rate: number): OpusRate {
  if (rate === 8000 || rate === 12000 || rate === 16000 || rate === 24000 || rate === 48000) {
    return rate;
  }
  throw new Error(
    `${rate} Hz is not a rate Opus encodes; BRIDGE_SERVER_RATE must be one of ` +
      `8000, 12000, 16000, 24000, 48000`
  );
}

/** The samples in one frame, refusing a duration Opus does not have. */
function samplesInFrame(rate: OpusRate, frameMs: number): number {
  if (!FRAME_DURATIONS_MS.includes(frameMs)) {
    throw new Error(
      `${frameMs} ms is not a frame duration Opus encodes; BRIDGE_FRAME_MS must be one of ` +
        FRAME_DURATIONS_MS.join(", ")
    );
  }
  return (rate * frameMs) / 1000;
}

/** A short slice, zero-padded to a full frame. Silence after the last sample is
 *  the only thing Opus can be given for the samples that are missing. */
function padToFrame(slice: Buffer, bytesPerFrame: number): Buffer {
  const frame = Buffer.alloc(bytesPerFrame);
  slice.copy(frame);
  return frame;
}

/** Little-endian 16-bit PCM as samples, on a byte-aligned buffer of its own.
 *  The copy is not gratuitous: `Buffer` memory from a WAV slice can start on an
 *  odd byte, and an `Int16Array` cannot view that. */
function toSamples(pcm: Buffer): Int16Array {
  const samples = new Int16Array(pcm.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2);
  return samples;
}

/** Samples back to the little-endian bytes the encoder takes. */
function samplesToBuffer(samples: Int16Array): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(samples[i]!, i * 2);
  return pcm;
}

/** Fold every channel into one, by average. The hello promises mono, so a stereo
 *  sentence sent as stereo would be played back as something the platform never
 *  produced. */
function downmix(samples: Int16Array, channels: number): Int16Array {
  const frames = Math.floor(samples.length / channels);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[i * channels + c]!;
    out[i] = Math.round(sum / channels);
  }
  return out;
}

/**
 * Linear interpolation, for the mismatch case only. Deliberately the same
 * arithmetic the spike used on hardware, rather than a windowed resampler: it is
 * exact when the rates agree (the measured case), and speech survives it when
 * they do not.
 */
function resample(samples: Int16Array, from: number, to: number): Int16Array {
  const ratio = to / from;
  const out = new Int16Array(Math.floor(samples.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const f = src - i0;
    out[i] = Math.round(samples[i0]! * (1 - f) + samples[i1]! * f);
  }
  return out;
}
