import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ENDPOINTER_DEFAULTS, type BridgeConfig } from "../src/config.js";
import {
  createListening,
  createVad,
  utteranceFrames,
  vadDecision,
  vadStep,
  type EndpointerConfig,
  type ListeningFrame,
} from "../src/listening.js";
import { frame } from "../src/protocol/framing.js";
import { encodeOpusFrames } from "../src/protocol/opus.js";
import { parseWavAudio } from "../src/protocol/wav.js";

/**
 * When the person has finished speaking, and which of it to send.
 *
 * The device does not say (D9), so everything here is the bridge's own arithmetic
 * over the person's audio: an endpointer that closes a turn on sustained silence
 * after speech, and a trim that uploads the utterance rather than the window it was
 * spoken into. Both halves are the rig's, ported with its measurements — this file is
 * where those measurements are asserted rather than remembered.
 *
 * The two defects the rig produced are asserted in the negative, because each is a
 * silent one: a cumulative speech total closes a turn in a room where nobody spoke,
 * and a per-frame verdict kept in a second array drifts out of step with the frames
 * and degrades every upload to the whole window. Neither throws, and neither shows in
 * a log that only reports what was sent.
 */

const RATE = ENDPOINTER_DEFAULTS.deviceRate;
const FRAME_MS = 60;
const SAMPLES_PER_FRAME = (RATE * FRAME_MS) / 1000;
const FRAMES = (ms: number): number => Math.round(ms / FRAME_MS);

const config: EndpointerConfig = {
  framing: 3,
  frameMs: FRAME_MS,
  ...ENDPOINTER_DEFAULTS,
};

/** A frame's worth of room tone, and one of someone talking over it. */
function pcm(amplitude: number, phase = 0): Buffer {
  const buffer = Buffer.alloc(SAMPLES_PER_FRAME * 2);
  for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
    buffer.writeInt16LE(
      Math.round(amplitude * Math.sin((2 * Math.PI * 220 * (i + phase)) / RATE)),
      i * 2
    );
  }
  return buffer;
}

const speechPcm = pcm(12000);
const roomPcm = pcm(400);

/** One frame as the device would send it: Opus, then the framing header. */
function wire(payload: Buffer): Buffer {
  const [packet] = encodeOpusFrames(payload, 1, { sampleRate: RATE, frameMs: FRAME_MS });
  assert.ok(packet, "the encoder produced a frame");
  return frame(packet, 3);
}

const speechFrame = wire(speechPcm);
const roomFrame = wire(roomPcm);

describe("the endpointer, over frames", () => {
  it("keeps its per-frame verdict on the frame itself, not in a second array", () => {
    // 6.7. The rig kept `frames` and `frameVoiced` side by side, and both defects it
    // produced were that pair drifting apart. Here there is one array and one entry
    // per frame, so the mismatch is unrepresentable — which is asserted by the entry
    // carrying the verdict and the samples it was computed from, next to the bytes.
    const listening = createListening(config);
    listening.open();
    listening.frame(speechFrame);
    listening.frame(roomFrame);

    const { frames } = listening.utterance();
    assert.equal(frames.length, 2, "one entry per frame that arrived");
    for (const entry of frames) {
      assert.equal(typeof entry.voiced, "boolean", "the verdict travels with the frame");
      assert.ok(entry.samples instanceof Int16Array, "and so do the samples it was computed from");
      assert.ok(Buffer.isBuffer(entry.wire), "and the bytes that arrived");
    }
    assert.equal(frames[0]!.voiced, true, "the loud frame was speech");
    assert.equal(frames[1]!.voiced, false, "the quiet one was not");
  });

  it("closes a turn on silence after speech, and only after speech", () => {
    let now = 0;
    const listening = createListening(config, () => now);
    listening.open();

    // A room with nobody in it: loud enough to be noise, never loud enough to be a
    // person. The gate holds at `vadMinRms` until ten quiet frames have taught it the
    // floor, so this is also the shape the opening of every window has.
    const verdicts: string[] = [];
    for (let i = 0; i < FRAMES(ENDPOINTER_DEFAULTS.vadNoSpeechMs) - 1; i++) {
      now += FRAME_MS;
      verdicts.push(listening.frame(roomFrame));
    }
    assert.deepEqual(
      [...new Set(verdicts)],
      ["wait"],
      "background noise is not a turn, however long the window stays open"
    );

    // Then a person speaks, and stops.
    for (let i = 0; i < 6; i++) {
      now += FRAME_MS;
      listening.frame(speechFrame);
    }
    let closed: string = "wait";
    for (let i = 0; i < FRAMES(ENDPOINTER_DEFAULTS.vadSilenceMs); i++) {
      now += FRAME_MS;
      closed = listening.frame(roomFrame);
    }
    assert.equal(closed, "turn", "sustained silence after speech is what closes a turn");
  });

  it("does not cut a person off at a pause inside a sentence", () => {
    // A pause is shorter than the silence threshold, so the turn stays open and the
    // utterance is carried whole. This is the difference between an endpointer and a
    // silence detector, and it is the spec's own scenario.
    let now = 0;
    const listening = createListening(config, () => now);
    listening.open();

    const pause = FRAMES(ENDPOINTER_DEFAULTS.vadSilenceMs) - 1;
    const verdicts: string[] = [];
    for (const kind of ["speech", "pause", "speech", "pause", "speech"] as const) {
      const count = kind === "speech" ? 6 : pause;
      for (let i = 0; i < count; i++) {
        now += FRAME_MS;
        verdicts.push(listening.frame(kind === "speech" ? speechFrame : roomFrame));
      }
    }
    assert.deepEqual([...new Set(verdicts)], ["wait"], "three phrases, one utterance, no turn yet");
  });

  it("counts speech over a sliding window rather than accumulating it", () => {
    // The rig's cumulative total with a gate of 3782 closed a turn 13.9 s into a
    // window with no speech in it: scattered noise adds up given long enough. Each
    // frame here is measured through the same `vadStep` the live path uses, so the
    // assertion is about the state machine and not about a threshold someone typed.
    const v = createVad(0);
    let now = 0;
    for (let i = 0; i < FRAMES(ENDPOINTER_DEFAULTS.vadSpeechWindowMs) * 2; i++) {
      now += FRAME_MS;
      vadStep(v, 700, config);
    }
    assert.equal(v.speechMs, 0, "a long quiet window is still no speech");
    assert.equal(vadDecision(v, now, config), "wait", "and it is not given up on until it has had its time");
  });

  it("gives up on a window nobody spoke into, and says so rather than closing a turn", () => {
    const v = createVad(0);
    const at = ENDPOINTER_DEFAULTS.vadNoSpeechMs;
    assert.equal(vadDecision(v, at - FRAME_MS, config), "wait");
    assert.equal(vadDecision(v, at, config), "giveup", "no turn, but the window is spent");

    // And one that did hear a person is never given up on: it closes instead.
    const heard = createVad(0);
    for (let i = 0; i < 6; i++) vadStep(heard, 12000, config);
    assert.equal(vadDecision(heard, at, config), "wait", "the silence threshold has not been reached yet");
  });

  it("holds a turn open past the cap when the person never stops, and closes it", () => {
    const v = createVad(0);
    for (let i = 0; i < 6; i++) vadStep(v, 12000, config);
    const cap = ENDPOINTER_DEFAULTS.maxTurnMs;
    assert.equal(vadDecision(v, cap - FRAME_MS, config), "wait");
    assert.equal(vadDecision(v, cap, config), "turn", "the backstop for a person who never stops");
  });
});

describe("which part of the window to upload", () => {
  /** A window's worth of entries, speech where the caller says. */
  function window(spec: { total: number; voiced: number[] }): ListeningFrame[] {
    const frames: ListeningFrame[] = [];
    for (let i = 0; i < spec.total; i++) {
      const voiced = spec.voiced.includes(i);
      frames.push({ wire: Buffer.alloc(4), voiced, samples: null, rms: voiced ? 12000 : 400 });
    }
    return frames;
  }

  it("trims to the utterance, and the onset leads the first voiced frame", () => {
    // The window ran long; the person spoke near the end of it.
    const frames = window({ total: 200, voiced: [180, 181, 182, 183, 184, 185, 186] });
    const { frames: upload, onset } = utteranceFrames(frames, config);

    assert.ok(onset > 0, "the onset is inside the window, not at its start");
    assert.equal(
      onset,
      180 - FRAMES(ENDPOINTER_DEFAULTS.onsetLeadMs),
      "the onset leads the first voiced frame, so a soft start is not clipped off"
    );
    assert.equal(upload.length, 200 - onset, "and the upload runs to the end of the window");
    assert.ok(upload.length < frames.length, "which is a fraction of it");
    assert.equal(upload[0]!.voiced, false, "the lead is the quiet frames before the speech");
  });

  it("walks back from the last voiced frame, not forward from the window's start", () => {
    // The rig's run 11: a window holding six 15 s no-speech giveups, one stray
    // transient 31 s in, and the person speaking at the end. Anchoring on the earliest
    // voiced frame uploaded 68.4 s of audio to carry 0.24 s of speech, which the
    // transcriber answered with invented Chinese and Thai (D11).
    const frames = window({ total: 640, voiced: [2, 620, 621, 622] });
    const { frames: upload, onset } = utteranceFrames(frames, config);

    assert.ok(
      onset > 600,
      `the onset follows the utterance rather than the stray blip (was ${onset})`
    );
    assert.equal(upload[0]!.voiced, false, "the blip at frame 2 is not in the upload");
    assert.ok(upload.length < 30, "0.24 s of speech is not 68 s of upload");
  });

  it("keeps a pause inside a sentence inside the utterance", () => {
    // Two phrases with a pause shorter than the silence threshold between them: the
    // walk back crosses the pause, because the pause is not the gap that closed the
    // turn.
    const frames = window({ total: 200, voiced: [100, 101, 102, 103, 104, 105, 106, 120, 121, 122] });
    const { frames: upload, onset } = utteranceFrames(frames, config);
    assert.ok(onset <= 95, "the walk back crossed the internal pause");
    assert.ok(upload.some((f) => f.voiced), "and carried both phrases");
  });

  it("caps the upload at one turn's length, whatever the onset says", () => {
    const frames = window({ total: 900, voiced: [0, 899] });
    const { frames: upload } = utteranceFrames(frames, config);
    assert.ok(
      upload.length <= FRAMES(ENDPOINTER_DEFAULTS.maxTurnMs),
      "nothing longer than a turn belongs in one"
    );
  });

  it("uploads the whole window and says so when there was no speech to trim by", () => {
    const frames = window({ total: 40, voiced: [] });
    const { frames: upload, onset } = utteranceFrames(frames, config);
    assert.equal(onset, -1, "a negative onset is how 'there was nothing to trim by' is said");
    assert.equal(upload.length, 40, "and the caller uploads the window rather than a guessed slice");
  });
});

describe("the utterance that closes a turn", () => {
  it("uploads the frames the verdicts were computed from, and no second decode", () => {
    // 6.1. The frames arrive with the samples the endpointer judged them by, so the
    // upload is those concatenated into one WAV. The rig decoded the window a second
    // time against a decoder whose state had run ahead in between, so that the audio
    // it judged and the audio it uploaded were not the same signal.
    let now = 0;
    const listening = createListening(config, () => now);
    listening.open();

    for (let i = 0; i < 40; i++) {
      now += FRAME_MS;
      listening.frame(roomFrame);
    }
    const utteranceStart = now;
    for (let i = 0; i < 6; i++) {
      now += FRAME_MS;
      listening.frame(speechFrame);
    }
    let verdict = "wait";
    for (let i = 0; i < FRAMES(ENDPOINTER_DEFAULTS.vadSilenceMs); i++) {
      now += FRAME_MS;
      verdict = listening.frame(roomFrame);
    }
    assert.equal(verdict, "turn");

    // The snapshot is taken before the window is cleared, which is what the caller
    // does synchronously at the verdict (6.4).
    const upload = listening.upload();
    assert.ok(upload.wav, "there was something to send");
    assert.equal(upload.failed, 0, "every frame in the utterance decoded when it was judged");

    const audio = parseWavAudio(upload.wav!);
    assert.equal(audio.sampleRate, RATE, "declared at the device's rate, not the hello's");
    assert.equal(audio.channels, 1);

    const seconds = audio.pcm.length / 2 / RATE;
    const windowSeconds = ((40 + 6 + FRAMES(ENDPOINTER_DEFAULTS.vadSilenceMs)) * FRAME_MS) / 1000;
    assert.ok(seconds < windowSeconds, `${seconds}s uploaded out of a ${windowSeconds}s window`);
    // The six speech frames plus the silence that closed the turn, plus the onset
    // lead — and not the forty frames of room tone the window opened with.
    const expected = (6 + FRAMES(ENDPOINTER_DEFAULTS.vadSilenceMs) + FRAMES(ENDPOINTER_DEFAULTS.onsetLeadMs)) * FRAME_MS / 1000;
    assert.ok(
      Math.abs(seconds - expected) <= 2 * FRAME_MS / 1000,
      `${seconds}s of upload, expected about ${expected}s`
    );
    assert.ok(now - utteranceStart >= 0, "the utterance began inside the window");
  });

  it("sends no turn when no frame in the window decoded", () => {
    // 6.3. Audio that yields nothing is not an error and not a turn: the person is
    // left able to take the next one, which is exactly the state they were in.
    const listening = createListening(config);
    listening.open();
    for (let i = 0; i < 6; i++) listening.frame(Buffer.from("not opus at all"));

    const upload = listening.upload();
    assert.equal(upload.wav, null, "nothing decodable, so nothing to send");
    assert.equal(upload.seconds, 0);
    assert.ok(upload.failed > 0, "and the frames that failed are counted rather than hidden");
  });

  it("clears the frames, the verdicts and the endpointer together", () => {
    // 6.7. Clearing the frames and not the verdicts is the rig's run 10: every turn
    // after the first fell back to uploading the whole window, 35.0 s of audio for a
    // 1.5 s utterance, which the transcriber answered with invented Chinese.
    let now = 0;
    const listening = createListening(config, () => now);
    listening.open();
    for (let i = 0; i < 5; i++) {
      now += FRAME_MS;
      listening.frame(speechFrame);
    }

    listening.open();
    const { frames, onset } = listening.utterance();
    assert.equal(frames.length, 0, "a new window starts with no frames");
    assert.equal(onset, -1, "and nothing to trim by");
  });
});
