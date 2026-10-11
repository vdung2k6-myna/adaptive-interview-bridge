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

/** Everything the bridge logged while `run` ran, as one string. The giveup report is
 *  the whole of what this change adds to a discarded window, so it is asserted as
 *  output rather than inferred from state. */
function capturing(run: () => void): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...a: unknown[]): void => void lines.push(a.map(String).join(" "));
  try {
    run();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

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

    // Then a person speaks, and stops. Ten frames, because the endpointer needs 500 ms
    // of a sliding window to count as speech and six frames is only 360 ms.
    for (let i = 0; i < 10; i++) {
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
      const count = kind === "speech" ? 10 : pause;
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
    for (let i = 0; i < 10; i++) vadStep(heard, 12000, config);
    assert.equal(vadDecision(heard, at, config), "wait", "the silence threshold has not been reached yet");
  });

  it("reports what a discarded window held, and the gate it was judged against", () => {
    // The window that produced this change: one transient, loud enough to pass the
    // gate, in a room where nobody spoke. What the discard has to say is the loudness
    // it threw away and the threshold that judged it — the two numbers the rig printed
    // and the bridge did not, which is why the failure was invisible until a transcript
    // came back (D4). They cannot be read off the sliding window: it ages the transient
    // out long before the giveup is reached and would report zero.
    let now = 0;
    const listening = createListening(config, () => now);
    listening.open();

    const heard = capturing(() => {
      for (let i = 0; i < 20; i++) {
        now += FRAME_MS;
        listening.frame(roomFrame);
      }
      now += FRAME_MS;
      listening.frame(speechFrame);
      let verdict = "wait";
      let guard = 0;
      while (verdict === "wait" && guard++ < FRAMES(ENDPOINTER_DEFAULTS.vadNoSpeechMs) + 10) {
        now += FRAME_MS;
        verdict = listening.frame(roomFrame);
      }
    });

    const reported =
      /no speech in 15s \(loudest (\d+), floor (\d+)\) at gate (\d+), (\d+) frame\(s\) over it/.exec(heard);
    assert.ok(reported, `the discard did not report its numbers:\n${heard}`);
    const [, loudest, , gate, frames] = reported;
    assert.ok(
      Number(loudest) > Number(gate),
      `the loudness it threw away is reported and it did cross the gate (${loudest} vs ${gate})`
    );
    assert.equal(Number(frames), 1, "and how much of the window crossed, which is one frame of it");
  });

  it("says zero when nothing crossed the gate at all", () => {
    let now = 0;
    const listening = createListening(config, () => now);
    listening.open();

    const heard = capturing(() => {
      let verdict = "wait";
      let guard = 0;
      while (verdict === "wait" && guard++ < FRAMES(ENDPOINTER_DEFAULTS.vadNoSpeechMs) + 10) {
        now += FRAME_MS;
        verdict = listening.frame(roomFrame);
      }
    });

    assert.match(
      heard,
      /loudest 0, floor \d+\) at gate \d+, 0 frame\(s\) over it/,
      "a room nobody spoke in reports a loudness of zero, which is the truth of it"
    );
  });

  it("does not close a turn on a burst nobody spoke under, however loud", () => {
    // The field case. A door, a chair, a case set down — loud enough to cross the gate
    // and over inside a fraction of a second. The log holds one at 0.36 s / 6 frames
    // that the platform answered "đi", nine times in one session (D5; the corpus below
    // is the whole of it). Loudness cannot separate these from a person, so what is
    // asserted here is that length can: 4 frames is the shortest in the corpus and 8
    // the longest, and none of them may close a turn.
    for (const burst of [4, 6, 8]) {
      let now = 0;
      const listening = createListening(config, () => now);
      listening.open();

      const verdicts: string[] = [];
      const step = (f: Buffer): void => {
        now += FRAME_MS;
        verdicts.push(listening.frame(f));
      };
      for (let i = 0; i < 20; i++) step(roomFrame);
      for (let i = 0; i < burst; i++) step(speechFrame);
      let guard = 0;
      while (verdicts.at(-1) === "wait" && guard++ < FRAMES(ENDPOINTER_DEFAULTS.vadNoSpeechMs) + 10) {
        step(roomFrame);
      }

      assert.ok(!verdicts.includes("turn"), `a ${burst}-frame burst with no speaker closed a turn`);
      assert.equal(
        verdicts.at(-1),
        "giveup",
        `a ${burst}-frame burst spent the window rather than closing it`
      );
    }
  });

  it("holds a turn open past the cap when the person never stops, and closes it", () => {
    const v = createVad(0);
    for (let i = 0; i < 10; i++) vadStep(v, 12000, config);
    const cap = ENDPOINTER_DEFAULTS.maxTurnMs;
    assert.equal(vadDecision(v, cap - FRAME_MS, config), "wait");
    assert.equal(vadDecision(v, cap, config), "turn", "the backstop for a person who never stops");
  });
});

describe("the 37 turns on record, replayed", () => {
  /**
   * Every turn `bridge-run.log` recorded on 2026-10-06: how long the endpointer counted
   * it as speech, the peak it measured, and what the platform transcribed it as. The
   * peak is the endpointer's own reading, so replaying a turn at it reproduces that
   * turn's frames by construction — what is under test is not the gate but where the
   * line between a sound and an utterance falls.
   *
   * The transcripts are what makes this a measurement rather than an opinion: the
   * eight-frame-and-under group is the one the platform answered with "đi", "Alexa.",
   * "gọi gọi gọi gọi gọi" and single words, and the nine-and-over group is the one it
   * answered with Vietnamese sentences. The one exception at nine frames is
   * "đang cãi lộn mà.", a real sentence sitting inside the noise band — that is the
   * cost of the line, and it is why the line is drawn below it rather than at it.
   */
  const CORPUS: readonly { fr: number; peak: number; text: string }[] = [
    { fr: 4, peak: 12554, text: "mừng ngoài gì?" },
    { fr: 4, peak: 12578, text: "đi" },
    { fr: 5, peak: 11570, text: "đi" },
    { fr: 5, peak: 10528, text: "mười ngày." },
    { fr: 5, peak: 11427, text: "Alexa." },
    { fr: 5, peak: 9088, text: "ở tình huống là nói chung là." },
    { fr: 5, peak: 9164, text: "trả lời theo star là trả lời theo" },
    { fr: 5, peak: 13392, text: "gọi gọi gọi gọi gọi" },
    { fr: 6, peak: 19397, text: "đi" },
    { fr: 6, peak: 16891, text: "đi" },
    { fr: 6, peak: 16314, text: "Ừ." },
    { fr: 6, peak: 15364, text: "đi" },
    { fr: 6, peak: 17032, text: "một làm gì?" },
    { fr: 6, peak: 15004, text: "thế" },
    { fr: 6, peak: 12201, text: "có gì ở ở hải ngoại vậy à, hải" },
    { fr: 7, peak: 11765, text: "ừm." },
    { fr: 7, peak: 17142, text: "đi" },
    { fr: 7, peak: 18659, text: "đi" },
    { fr: 7, peak: 10944, text: "cái là bắt luôn đi vô ngủ." },
    { fr: 7, peak: 13864, text: "ừ." },
    { fr: 8, peak: 16816, text: "Nhiều người cho rằng" },
    { fr: 8, peak: 20395, text: "Alexa." },
    { fr: 9, peak: 21099, text: "đi" },
    { fr: 9, peak: 16529, text: "đi" },
    { fr: 9, peak: 12099, text: "mà lại mấy ấm á, trong đó mấy lạnh á." },
    { fr: 9, peak: 13254, text: "đang cãi lộn mà." },
    { fr: 10, peak: 16203, text: "có cái gì mới không?" },
    { fr: 10, peak: 10875, text: "không trả lời đâu." },
    { fr: 11, peak: 15518, text: "điều gì" },
    { fr: 12, peak: 12688, text: "ở một lần tôi làm việc nhóm là tôi phải bưng" },
    { fr: 13, peak: 14288, text: "không nghe thấy gì luôn." },
    { fr: 17, peak: 17459, text: "có chuyện gì đâu mà cãi." },
    { fr: 17, peak: 20966, text: "phẩm với hành vi là sao?" },
    { fr: 20, peak: 24889, text: "đi" },
    { fr: 22, peak: 19296, text: "có chuyện gì vui không kể tôi nghe." },
    { fr: 23, peak: 17609, text: "cũng ngày nào tôi không bị áp lực." },
    { fr: 29, peak: 24476, text: "có gì vui không nói tôi nghe chơi." },
  ];

  /** One recorded turn, driven back through the state machine at its recorded peak.
   *  Twenty frames of room first, because the floor estimate needs ten quiet frames
   *  before it stops reading zero, and every window in the field opens that way. */
  function replay(fr: number, peak: number): string {
    const v = createVad(0);
    for (let i = 0; i < 20; i++) vadStep(v, 400, config);
    for (let i = 0; i < fr; i++) vadStep(v, peak, config);
    let now = (20 + fr) * FRAME_MS;
    for (let i = 0; i < FRAMES(ENDPOINTER_DEFAULTS.vadNoSpeechMs); i++) {
      const verdict = vadDecision(v, now, config);
      if (verdict !== "wait") return verdict;
      vadStep(v, 400, config);
      now += FRAME_MS;
    }
    return "wait";
  }

  it("is the corpus the line was drawn on, not a sample of it", () => {
    assert.equal(CORPUS.length, 37, "every turn the log recorded");
    assert.equal(CORPUS.filter((t) => t.fr <= 8).length, 22, "the noise band, as measured");
    assert.equal(CORPUS.filter((t) => t.fr >= 9).length, 15, "and everything above it");
  });

  it("does not close a turn on what the platform answered as noise", () => {
    for (const turn of CORPUS.filter((t) => t.fr <= 8)) {
      assert.equal(
        replay(turn.fr, turn.peak),
        "giveup",
        `${turn.fr} frames (peak ${turn.peak}) closed a turn, which the platform answered ${JSON.stringify(turn.text)}`
      );
    }
  });

  it("still closes a turn on everything the platform answered with a sentence", () => {
    for (const turn of CORPUS.filter((t) => t.fr >= 9)) {
      assert.equal(
        replay(turn.fr, turn.peak),
        "turn",
        `${turn.fr} frames (peak ${turn.peak}) no longer closes a turn, and it was ${JSON.stringify(turn.text)}`
      );
    }
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
    for (let i = 0; i < 10; i++) {
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
    const windowSeconds = ((40 + 10 + FRAMES(ENDPOINTER_DEFAULTS.vadSilenceMs)) * FRAME_MS) / 1000;
    assert.ok(seconds < windowSeconds, `${seconds}s uploaded out of a ${windowSeconds}s window`);
    // The ten speech frames plus the silence that closed the turn, plus the onset
    // lead — and not the forty frames of room tone the window opened with.
    const expected = (10 + FRAMES(ENDPOINTER_DEFAULTS.vadSilenceMs) + FRAMES(ENDPOINTER_DEFAULTS.onsetLeadMs)) * FRAME_MS / 1000;
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
