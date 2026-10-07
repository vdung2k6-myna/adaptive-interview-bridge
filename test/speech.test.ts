import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ENDPOINTER_DEFAULTS, type BridgeConfig } from "../src/config.js";
import { createSpeaker, type SpeakerSchedule, type SpeakerSocket } from "../src/speech.js";
import type { TurnSentence } from "../src/turn.js";

/**
 * The bracket is not a detail of the speech, it is the condition for there being
 * any.
 *
 * The firmware discards binary frames that arrive while it is not `speaking`, and
 * discards them silently — so a bridge that encodes perfectly and streams
 * perfectly is *mute*, and its log is indistinguishable from one whose Opus is
 * broken. Nothing on the device side reports it. That is why this file asserts the
 * order of what goes out, not merely that frames went out: `tts start`, then the
 * frames, then `tts stop`, with no frame ever outside the pair.
 *
 * Everything here is the device's side of 5.2, checked against a socket that is
 * only a list. A real socket is not needed to know whether the device would have
 * played it — the device's rule is about the sequence, and the sequence is here.
 */

const RATE = 24000;
const FRAME_MS = 60;
const SAMPLES_PER_FRAME = (RATE * FRAME_MS) / 1000;
const DRAIN_GUARD_MS = ENDPOINTER_DEFAULTS.drainGuardMs;

const config: BridgeConfig = {
  otaPort: 8003,
  wsPort: 8000,
  publicHost: "127.0.0.1",
  deviceSecret: "s".repeat(43),
  allowedDevices: [],
  devicePersonas: new Map(),
  platformUrl: "http://127.0.0.1:4000",
  apiAuthToken: "t".repeat(16),
  framing: 3,
  serverRate: RATE,
  frameMs: FRAME_MS,
  ...ENDPOINTER_DEFAULTS,
  historyTurns: 20,
  commandStep: 10,
  language: "english",
};

interface Sent {
  data: string | Buffer;
  binary: boolean;
}

/** A socket that keeps what it was sent, which is all the device's rule needs. */
function fakeSocket(): SpeakerSocket & { sent: Sent[]; readyState: number } {
  const sent: Sent[] = [];
  return {
    sent,
    readyState: 1,
    send(data: string | Buffer, options?: { binary?: boolean }) {
      sent.push({ data, binary: options?.binary ?? false });
    },
  };
}

/** One frame's worth of tone, in the WAV container the platform sends. */
function wav(count = 1): Buffer {
  const samples = count * SAMPLES_PER_FRAME;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * 12000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function sentence(index: number, audio: Buffer | null): TurnSentence {
  return { index, text: `sentence ${index}`, audio };
}

const jsonOf = (sent: Sent) => JSON.parse(sent.data as string) as Record<string, unknown>;
const framesOf = (sent: Sent[]) => sent.filter((s) => s.binary);
/** What went out, as a sequence: a frame, or the JSON the device was sent. */
const spoken = (sent: Sent[]) => sent.map((s) => (s.binary ? "frame" : jsonOf(s)));

/**
 * A scheduler that runs now. The frames are paced on the turn's own clock (D16), and
 * most of what this file asserts is *what order* things left in — which the pacing
 * does not change, since a turn reserves its slots in the order its frames arrived.
 * So the pacing is taken out of these checks, and asserted on its own below.
 */
const runNow: SpeakerSchedule = (run) => run();

const speakerFor = (socket: SpeakerSocket, clock?: () => number) =>
  createSpeaker(socket, config, clock, runNow);

describe("the bracket around a reply", () => {
  it("opens before the first frame and closes at the end of the turn", () => {
    const socket = fakeSocket();
    const speaker = speakerFor(socket);

    speaker.speak(sentence(0, wav(1)));
    // The start, the sentence's own announcement, and its frame — in that order:
    // the device discards frames outside `speaking`, and its display must name a
    // sentence before that sentence is heard (5.4).
    assert.deepEqual(spoken(socket.sent), [
      { type: "tts", state: "start" },
      { type: "tts", state: "sentence_start", text: "sentence 0" },
      "frame",
    ]);

    speaker.finish();
    assert.deepEqual(jsonOf(socket.sent.at(-1)!), { type: "tts", state: "stop" });
  });

  it("opens once for a reply of many sentences, not once per sentence", () => {
    const socket = fakeSocket();
    const speaker = speakerFor(socket);

    speaker.speak(sentence(0, wav(1)));
    speaker.speak(sentence(1, wav(2)));
    speaker.finish();

    const control = socket.sent.filter((s) => !s.binary).map(jsonOf);
    assert.deepEqual(control, [
      { type: "tts", state: "start" },
      { type: "tts", state: "sentence_start", text: "sentence 0" },
      { type: "tts", state: "sentence_start", text: "sentence 1" },
      { type: "tts", state: "stop" },
    ]);
  });

  it("never sends a frame outside the bracket", () => {
    // The rule the firmware enforces, asserted as a property rather than as a
    // sequence: every frame sits after the start and before the stop.
    const socket = fakeSocket();
    const speaker = speakerFor(socket);

    speaker.speak(sentence(0, wav(1)));
    speaker.speak(sentence(1, null)); // nothing speakable in this one (5.5)
    speaker.speak(sentence(2, wav(1)));
    speaker.finish();

    const start = socket.sent.findIndex((s) => !s.binary && jsonOf(s).state === "start");
    const stop = socket.sent.findIndex((s) => !s.binary && jsonOf(s).state === "stop");
    assert.ok(start >= 0 && stop > start, "the pair exists, in order");
    socket.sent.forEach((s, i) => {
      if (s.binary) assert.ok(i > start && i < stop, `frame ${i} is inside the bracket`);
    });
  });

  it("says nothing at all when a reply has nothing speakable in it (5.5)", () => {
    const socket = fakeSocket();
    const speaker = speakerFor(socket);

    speaker.speak(sentence(0, null));
    speaker.finish();

    assert.deepEqual(socket.sent, [], "no start, no stop, and nothing for the device to discard");
  });

  it("closes only what it opened, so a second finish is harmless", () => {
    const socket = fakeSocket();
    const speaker = speakerFor(socket);

    speaker.speak(sentence(0, wav(1)));
    speaker.finish();
    speaker.finish();
    speaker.finish();

    assert.equal(
      socket.sent.filter((s) => !s.binary).length,
      3,
      "one start, one announcement and one stop"
    );
  });

  it("does not speak to a device that has already gone", () => {
    const socket = fakeSocket();
    const speaker = speakerFor(socket);
    speaker.speak(sentence(0, wav(1)));

    socket.readyState = 3; // CLOSED
    speaker.finish();

    assert.deepEqual(
      socket.sent.filter((s) => !s.binary).map(jsonOf),
      [
        { type: "tts", state: "start" },
        { type: "tts", state: "sentence_start", text: "sentence 0" },
      ],
      "the stop is not sent into a closed socket, and the drop is logged where it happened"
    );
  });
});

describe("what the bracket carries", () => {
  it("carries the declared framing in front of every packet", () => {
    const socket = fakeSocket();
    const speaker = speakerFor(socket);
    speaker.speak(sentence(0, wav(1)));

    const [frame] = framesOf(socket.sent);
    const wire = frame!.data as Buffer;
    assert.equal(wire.readUInt8(0), 0, "type 0: Opus");
    assert.equal(wire.readUInt16BE(2), wire.length - 4, "the header declares what it carries");
  });

  it("counts the audio it has sent for the life of the socket", () => {
    const socket = fakeSocket();
    const speaker = speakerFor(socket);
    assert.equal(speaker.sessionMs(), 0);

    speaker.speak(sentence(0, wav(3)));
    assert.equal(speaker.sessionMs(), 3 * FRAME_MS);
    speaker.speak(sentence(1, wav(2)));
    assert.equal(speaker.sessionMs(), 5 * FRAME_MS);

    // The count is the session's, not the turn's: it is what an operator reads to
    // see how much the bridge has said to this device, and it does not reset at a
    // turn boundary. What a turn needs instead is `drainingUntil` below (6.6).
    speaker.finish();
    assert.equal(speaker.sessionMs(), 5 * FRAME_MS);
  });

  it("arms a drain deadline from this turn's own audio, not the session's", () => {
    // 6.6. The device reopens its microphone before its speaker stops, so the
    // bridge has to know when this turn's audio is over. The deadline is anchored at
    // the moment the bracket opened and measured by this turn's frames alone; taking
    // it from the session total instead would hold the microphone distrusted for every
    // turn a gadget had ever taken.
    let now = 1_000;
    const socket = fakeSocket();
    const speaker = speakerFor(socket, () => now);

    assert.equal(speaker.drainingUntil(), null, "nothing has been spoken, so nothing is playing");

    // First turn: 3 frames, and the clock moves 5s while they stream — the deadline
    // must follow the audio, not the wall clock, or a slow reply would look like a
    // long one.
    speaker.speak(sentence(0, wav(3)));
    now += 5_000;
    speaker.finish();
    assert.equal(speaker.drainingUntil(), 1_000 + 3 * FRAME_MS + DRAIN_GUARD_MS);

    // Second turn: 2 frames. The deadline is this turn's, so it is behind the first
    // one's rather than 8 frames' worth ahead of it.
    now += 10_000;
    speaker.speak(sentence(1, wav(2)));
    speaker.finish();
    assert.equal(
      speaker.drainingUntil(),
      16_000 + 2 * FRAME_MS + DRAIN_GUARD_MS,
      "one reply's worth on the second turn, not two"
    );
  });

  it("leaves the previous deadline standing when a turn says nothing", () => {
    // A reply with nothing speakable in it never opens the bracket and returns from
    // `finish()` at once (5.5). It has no audio of its own to distrust the microphone
    // for, and the previous turn's deadline is about audio that is still playing.
    let now = 1_000;
    const socket = fakeSocket();
    const speaker = speakerFor(socket, () => now);

    speaker.speak(sentence(0, wav(2)));
    speaker.finish();
    const armed = speaker.drainingUntil();

    now += 1_000;
    speaker.speak(sentence(1, null));
    speaker.finish();
    assert.equal(speaker.drainingUntil(), armed, "silence is not a turn's worth of audio");
  });

  it("skips a sentence it cannot speak rather than ending the turn", () => {
    const socket = fakeSocket();
    const speaker = speakerFor(socket);

    // Bytes that are not a WAV: a defect in one sentence, not a reason to drop
    // the rest of a reply that has already been generated.
    speaker.speak(sentence(0, Buffer.from("not a wav at all")));
    speaker.speak(sentence(1, wav(1)));
    speaker.finish();

    assert.equal(framesOf(socket.sent).length, 1, "the speakable sentence was still spoken");
    assert.equal(socket.sent.filter((s) => !s.binary).length, 3, "and it was still bracketed");
  });
});

describe("what the device is told to display (5.4)", () => {
  it("announces each spoken sentence, in order, with its own text", () => {
    const socket = fakeSocket();
    const speaker = speakerFor(socket);

    speaker.speak(sentence(0, wav(1)));
    speaker.speak(sentence(1, wav(1)));
    speaker.finish();

    // The announcement sits between the bracket's start and its own sentence's
    // frames: the firmware shows what is being said, not what has just finished,
    // and text arriving here is the only thing that moves that display.
    assert.deepEqual(spoken(socket.sent), [
      { type: "tts", state: "start" },
      { type: "tts", state: "sentence_start", text: "sentence 0" },
      "frame",
      { type: "tts", state: "sentence_start", text: "sentence 1" },
      "frame",
      { type: "tts", state: "stop" },
    ]);
  });

  it("announces nothing for a sentence the device will not speak (5.5)", () => {
    // The announcement is a claim about audio, so it is made only where audio
    // goes out. A display naming a sentence nobody hears is worse than a display
    // that says nothing: it would leave words on the screen for a sentence the
    // reply never spoke, and stay there through the silence.
    const socket = fakeSocket();
    const speaker = speakerFor(socket);

    speaker.speak(sentence(0, wav(1)));
    speaker.speak(sentence(1, null));
    speaker.speak(sentence(2, wav(1)));
    speaker.finish();

    assert.deepEqual(
      socket.sent.filter((s) => !s.binary).map(jsonOf),
      [
        { type: "tts", state: "start" },
        { type: "tts", state: "sentence_start", text: "sentence 0" },
        { type: "tts", state: "sentence_start", text: "sentence 2" },
        { type: "tts", state: "stop" },
      ],
      "sentence 1 is absent from the display as well as from the audio"
    );
  });
});

describe("the pace of the downlink (D16)", () => {
  /** A clock and a scheduler that move only when the test says so. */
  function timers(start: number) {
    let now = start;
    const pending: { at: number; run: () => void }[] = [];
    return {
      clock: () => now,
      schedule: (run: () => void, delayMs: number) => {
        pending.push({ at: now + delayMs, run });
      },
      /** Run everything due within `ms`, in due order, and land on the far side. */
      advance(ms: number) {
        const until = now + ms;
        for (;;) {
          pending.sort((a, b) => a.at - b.at);
          const next = pending[0];
          if (next === undefined || next.at > until) break;
          pending.shift();
          now = next.at;
          next.run();
        }
        now = until;
      },
      pending: () => pending.length,
    };
  }

  it("sends the lead at once and the rest no faster than realtime", () => {
    // The device decodes from a queue of 20 frames — 1.2s — and drops a frame it has
    // no room for without a line in either log, so a turn must not be written out as
    // fast as the platform produces it. Measured on hardware: 17.46s of audio handed
    // over in about six seconds, of which the device played the first 1.2s.
    const t = timers(1_000);
    const socket = fakeSocket();
    const speaker = createSpeaker(socket, config, t.clock, t.schedule);

    // Ten frames of 60ms: 600ms of audio.
    speaker.speak(sentence(0, wav(10)));

    const lead = framesOf(socket.sent).length;
    assert.ok(lead >= 1 && lead < 10, `the lead went out with the bracket (${lead} frames)`);
    assert.equal(lead + t.pending(), 10, "and every frame is either out or on the clock");
    assert.ok(lead <= 5, `the lead stays well inside the device's 20-frame queue (${lead})`);

    // One frame duration buys exactly one frame, and no more.
    t.advance(FRAME_MS);
    assert.equal(framesOf(socket.sent).length, lead + 1);

    // The close is not sent here: frames of this turn are still on the clock, and a
    // device told to stop discards the frames that follow it (delta 4).
    speaker.finish();
    assert.equal(
      socket.sent.filter((s) => !s.binary && jsonOf(s).state === "stop").length,
      0,
      "the bracket stays open for as long as the audio it qualifies"
    );

    // The deadline is the turn's whole audio rather than the part that has left,
    // because `finish()` arms it while the tail is still on the clock (6.6).
    assert.equal(speaker.drainingUntil(), 1_000 + 10 * FRAME_MS + DRAIN_GUARD_MS);

    t.advance(10 * FRAME_MS);
    assert.equal(framesOf(socket.sent).length, 10, "the turn finishes on its own clock");
    assert.equal(jsonOf(socket.sent.at(-1)!).state, "stop", "and the close follows the last frame");
  });

  it("does not push the first frame past the reply's last text event (5.3)", () => {
    // The pacing is the one thing here that could delay the first audio until after
    // the stream's `done` — the requirement the spec calls the most likely to regress
    // silently. The lead is what stops it: without one, frame 0 would be due a frame
    // duration after the bracket opened, and any lateness in the clock would land it
    // after the text had finished.
    const t = timers(1_000);
    const socket = fakeSocket();
    const speaker = createSpeaker(socket, config, t.clock, t.schedule);

    speaker.speak(sentence(0, wav(4)));
    assert.deepEqual(spoken(socket.sent), [
      { type: "tts", state: "start" },
      { type: "tts", state: "sentence_start", text: "sentence 0" },
      "frame",
      "frame",
      "frame",
      "frame",
    ]);
  });
});
