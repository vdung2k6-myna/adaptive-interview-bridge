import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BridgeConfig } from "../src/config.js";
import { createSpeaker, type SpeakerSocket } from "../src/speech.js";
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
  historyTurns: 20,
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

describe("the bracket around a reply", () => {
  it("opens before the first frame and closes at the end of the turn", () => {
    const socket = fakeSocket();
    const speaker = createSpeaker(socket, config);

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
    const speaker = createSpeaker(socket, config);

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
    const speaker = createSpeaker(socket, config);

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
    const speaker = createSpeaker(socket, config);

    speaker.speak(sentence(0, null));
    speaker.finish();

    assert.deepEqual(socket.sent, [], "no start, no stop, and nothing for the device to discard");
  });

  it("closes only what it opened, so a second finish is harmless", () => {
    const socket = fakeSocket();
    const speaker = createSpeaker(socket, config);

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
    const speaker = createSpeaker(socket, config);
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
    const speaker = createSpeaker(socket, config);
    speaker.speak(sentence(0, wav(1)));

    const [frame] = framesOf(socket.sent);
    const wire = frame!.data as Buffer;
    assert.equal(wire.readUInt8(0), 0, "type 0: Opus");
    assert.equal(wire.readUInt16BE(2), wire.length - 4, "the header declares what it carries");
  });

  it("counts the audio it has sent, which is the only clock on when the device is done", () => {
    const socket = fakeSocket();
    const speaker = createSpeaker(socket, config);
    assert.equal(speaker.sentMs(), 0);

    speaker.speak(sentence(0, wav(3)));
    assert.equal(speaker.sentMs(), 3 * FRAME_MS);
    speaker.speak(sentence(1, wav(2)));
    assert.equal(speaker.sentMs(), 5 * FRAME_MS);

    // The count is the session's, not the turn's: it is what §6 walks back from
    // to know whether the frames coming in are the person or the speaker's tail,
    // and that window does not reset at a turn boundary.
    speaker.finish();
    assert.equal(speaker.sentMs(), 5 * FRAME_MS);
  });

  it("skips a sentence it cannot speak rather than ending the turn", () => {
    const socket = fakeSocket();
    const speaker = createSpeaker(socket, config);

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
    const speaker = createSpeaker(socket, config);

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
    const speaker = createSpeaker(socket, config);

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
