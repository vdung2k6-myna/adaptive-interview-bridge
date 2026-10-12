import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MUSIC_GAIN_DB_DEFAULT } from "../src/config.js";
import { chooseTrack, decodeTrack, listTrackNames, musicTools, playTrack } from "../src/music.js";
import { parseWavAudio } from "../src/protocol/wav.js";
import type { TurnSentence } from "../src/turn.js";

/** A speaker that records what it was told and does nothing else — the narrowing `playTrack`
 *  asks for, which is why this test needs no socket, no clock and no schedule. */
function recordingSpeaker(): {
  sentences: TurnSentence[];
  finishes: () => number;
  speaker: { speak(sentence: TurnSentence): void; finish(): void };
} {
  const sentences: TurnSentence[] = [];
  let finishes = 0;
  return {
    sentences,
    finishes: () => finishes,
    speaker: {
      speak: (sentence) => void sentences.push(sentence),
      finish: () => void (finishes += 1),
    },
  };
}

/** A second of a 440 Hz tone at the rate the fixture decodes to. */
function tone(count: number): Int16Array {
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 44100) * 12000);
  }
  return samples;
}

const FIXTURE = fileURLToPath(new URL("./fixtures/tone-440.mp3", import.meta.url));
const NOT_AUDIO = fileURLToPath(new URL("./fixtures/not-audio.mp3", import.meta.url));
const MISSING = fileURLToPath(new URL("./fixtures/no-such-file.mp3", import.meta.url));

describe("decoding a track of the bridge's own", () => {
  it("gives the samples the speaker path takes, at the file's own rate", async () => {
    const track = await decodeTrack(FIXTURE);

    assert.ok(track, "the fixture decodes");
    // The file's rate, not the device's: the resampler every reply already passes through is
    // where 44100 becomes the 24000 the device is told to expect, and this module does not
    // keep a second one.
    assert.equal(track.sampleRate, 44100);
    assert.equal(track.samples.length, 44100, "one second of it");
    assert.ok(track.samples instanceof Int16Array, "mono, as the device takes it");

    // The tone is checked by its *shape* and not by its level, because the level is the
    // encoder's business and the shape is not: 440 Hz crosses zero 880 times a second, which
    // a decode producing silence, or noise, or samples at the wrong rate would not. Its level
    // is measured in the fixture's own terms rather than assumed — ffmpeg wrote this one at a
    // peak of 3899, and a test asserting a loud tone would be asserting ffmpeg's defaults.
    let crossings = 0;
    for (let i = 1; i < track.samples.length; i++) {
      if (track.samples[i - 1]! < 0 !== track.samples[i]! < 0) crossings++;
    }
    assert.ok(crossings > 800 && crossings < 960, `440 Hz survived the decode: ${crossings} zero crossings`);
  });

  it("refuses a file that is not audio, rather than playing silence as a track", async () => {
    // Measured: junk decodes to zero samples and reports zero *errors*, so a caller that read
    // the decoder's error list would play a second of nothing and call it music.
    assert.equal(await decodeTrack(NOT_AUDIO), null);
  });

  it("refuses a file it cannot read, and says so rather than throwing", async () => {
    assert.equal(await decodeTrack(MISSING), null);
  });

  it("leaves the event loop free while it decodes, which is why it is a worker", async () => {
    // The whole point of the worker-backed decoder: a caller reaches here while the platform's
    // reply is still streaming and still being spoken, and that reply's frames are delivered by
    // timers. Decoding on this thread blocks them — 843 ms measured for a four-and-a-half-minute
    // track — and the device's twenty-frame queue empties inside that block.
    //
    // Asserted as an ordering rather than as a duration, so it does not become a test of how fast
    // this machine is: a timer due *during* the decode has to fire before the decode resolves.
    let loopWasFree = false;
    const timer = setTimeout(() => {
      loopWasFree = true;
    }, 1);

    const track = await decodeTrack(FIXTURE);
    clearTimeout(timer);

    assert.ok(track, "the fixture still decodes");
    assert.ok(loopWasFree, "a timer due during the decode fired before it resolved");
  });
});

describe("what the bridge offers the model of its own", () => {
  it("names its tools so that they are not the gadget's, and offers none with no directory", () => {
    const offered = musicTools("/srv/music");

    // The name is what tells the model which of the two catalogues it is reaching for, and what
    // lets the sink route the call back here rather than to the gadget. The gadget's own tools are
    // `self.` because they are about the gadget; these are about the bridge's machine.
    assert.deepEqual(offered.map((tool) => tool.name), [
      "bridge.play_music",
      "bridge.stop_music",
      // The shelf, and the reason the two above can be answered when what the person said is not
      // what a file is called: a model shown the names can choose, where a matcher cannot.
      "bridge.list_music",
    ]);
    assert.ok(offered.every((tool) => tool.name.startsWith("bridge.")));

    // A tool the model can only be told "that did not work" about is worse than one it was never
    // offered: it reaches for it, and the person hears an account of a failure the bridge knew
    // about before they spoke. So this is the same gate the grammar is behind.
    assert.deepEqual(musicTools(""), []);
  });

  it("answers with the tracks it holds, read at the call rather than held", async () => {
    // Read at the call so that a track added to the library is offered on the next turn, and
    // without the folder it was filed in, which is not a thing a person says.
    const dir = mkdtempSync(join(tmpdir(), "bridge-list-"));
    writeFileSync(join(dir, "Kenny G - Songbird.mp3"), "");
    assert.deepEqual(await listTrackNames(dir), { ok: true, names: ["Kenny G - Songbird"] });

    writeFileSync(join(dir, "Nhac khong loi 2.mp3"), "");
    mkdirSync(join(dir, "Album One"));
    writeFileSync(join(dir, "Album One", "Deep Track.mp3"), "");
    const again = await listTrackNames(dir);
    assert.ok(again.ok, "a directory that can be read");
    assert.deepEqual(again.names, ["Deep Track", "Kenny G - Songbird", "Nhac khong loi 2"]);

    // Nothing to play is an answer and not a fault, as it is for a request.
    assert.deepEqual(await listTrackNames(""), {
      ok: false,
      detail: "this bridge has no music directory",
    });
  });

  it("describes each tool as a schema the platform can hand a model", () => {
    for (const tool of musicTools("/srv/music")) {
      assert.equal(typeof tool.description, "string");
      assert.ok(tool.description.length > 0, `${tool.name} says what it does`);
      const schema = tool.inputSchema as { type?: unknown; properties?: unknown };
      assert.equal(schema.type, "object", `${tool.name} takes an object`);
      assert.equal(typeof schema.properties, "object");
    }

    // What the person said, in their own words and unfiltered: whether a name matches a file is
    // the directory's answer, and a catalogue that promised a particular track would be promising
    // something it cannot know.
    const play = musicTools("/srv/music")[0]!;
    assert.ok((play.inputSchema as { properties: Record<string, unknown> }).properties["query"]);
  });
});

describe("the file a request names", () => {
  /** A directory of names and nothing else: `chooseTrack` lists a directory, and never opens a
   *  file, so a track here is a name that exists rather than audio that decodes. A real directory
   *  is used rather than a fake `readdir` because the listing is half of what is under test. */
  function library(...names: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "bridge-music-"));
    for (const name of names) writeFileSync(join(dir, name), "");
    return dir;
  }

  it("finds a name however the hyphen in it arrives", () => {
    // Measured on the deployment 2026-10-11: "Un-Break My Heart" is the file, and the platform
    // returned "unbreak my heart" — one word where the name has two, which a whole-word search then
    // found nothing in. The file exists; saying it does not is the one answer a person cannot act on.
    const dir = library("Toni Braxton - Un-Break My Heart.mp3", "Lionel Richie - Hello.mp3");

    return Promise.all([
      chooseTrack(dir, "unbreak my heart"),
      chooseTrack(dir, "un break my heart"),
      chooseTrack(dir, "Un-Break My Heart"),
    ]).then(([joined, spaced, asWritten]) => {
      for (const choice of [joined, spaced, asWritten]) {
        assert.ok(choice.ok, "each writing of the name finds the file");
        assert.match(choice.path, /Un-Break My Heart\.mp3$/);
      }
    });
  });

  it("still answers in the three ways it did", async () => {
    // The rules this module was built on, pinned here beside the new one: nothing named is the
    // first by name, nothing matching is a report, and a name several files carry is a report too
    // rather than a guess.
    const dir = library("Alpha.mp3", "Beta One.mp3", "Beta Two.mp3", "notes.txt");

    const any = await chooseTrack(dir, "");
    assert.match(any.ok ? any.path : "", /Alpha\.mp3$/, "nothing named plays the first by name");

    const none = await chooseTrack(dir, "nothing here is called this");
    assert.equal(none.ok, false, "no file is a report, not a guess");
    assert.equal(none.ok === false && none.reason, "no-match");

    // A word both names carry, and not a name either of them is: the one thing this may not do is
    // choose between them. "Beta One" asked for exactly is a different question, and is answered.
    const several = await chooseTrack(dir, "beta");
    assert.equal(several.ok, false, "two files carrying the name is a report as well");
    assert.equal(several.ok === false && several.reason, "ambiguous");

    const exact = await chooseTrack(dir, "beta one");
    assert.match(exact.ok ? exact.path : "", /Beta One\.mp3$/, "and the name itself still finds its file");

    const txt = await chooseTrack(dir, "notes");
    assert.equal(txt.ok, false, "and only mp3 files are tracks at all");
    assert.equal(txt.ok === false && txt.reason, "no-match");
  });
});

describe("playing a track through the device's speaker", () => {
  it("hands the whole track over as one bracket, numbered from zero", async () => {
    const { sentences, finishes, speaker } = recordingSpeaker();
    const track = { path: "/srv/music/A Tone.mp3", sampleRate: 44100, samples: tone(44100 * 25) };

    await playTrack(speaker, track, 0);

    assert.deepEqual(sentences.map((sentence) => sentence.index), [0, 1, 2], "in order, from zero");
    assert.equal(finishes(), 1, "and one bracket, closed once");

    // Each chunk is a WAV this bridge's own speaker path takes — the same container the platform's
    // sentences arrive in — and between them they hold **all** of the track. The length is the
    // assertion, because a chunk quietly dropped is a track with a hole in it and nothing says so.
    const parts = sentences.map((sentence) => parseWavAudio(sentence.audio!));
    assert.ok(
      parts.every((part) => part.sampleRate === 44100 && part.channels === 1),
      "at the file's own rate and in mono, exactly as the module decoded it"
    );
    assert.equal(parts.reduce((n, part) => n + part.pcm.length / 2, 0), track.samples.length, "all of it");

    // The screen names what is playing, and names it **once**: the pieces are one thing spoken.
    // Measured on the board, whose firmware keeps a list of what it was told — a name per piece is
    // that name repeated down the screen, one entry per ten seconds of the track, which is what a
    // four-minute track did to it.
    assert.equal(sentences[0]!.text, "A Tone", "the first piece names the track");
    assert.ok(
      sentences.slice(1).every((sentence) => sentence.text === null),
      "and the pieces after it announce nothing at all, rather than announcing an empty name"
    );
  });

  it("plays a track shorter than one chunk as a single one", async () => {
    const { sentences, finishes, speaker } = recordingSpeaker();

    await playTrack(speaker, { path: "/srv/music/Short.mp3", sampleRate: 44100, samples: tone(4410) }, 0);

    assert.deepEqual(sentences.map((sentence) => sentence.index), [0]);
    assert.equal(finishes(), 1);
    // One piece is also the first piece, so the name goes out with it: a short track is named
    // exactly as a long one is, which is once.
    assert.equal(sentences[0]!.text, "Short");
  });

  it("closes the bracket even for a track with nothing in it", async () => {
    // `decodeTrack` refuses a file that decodes to no samples, so this is the case a caller
    // reaches by skipping that check — and the one that must not strand a device in `Speaking`,
    // where it discards whatever the person says next.
    const { sentences, finishes, speaker } = recordingSpeaker();

    await playTrack(speaker, { path: "/srv/music/Empty.mp3", sampleRate: 44100, samples: new Int16Array(0) }, 0);

    assert.deepEqual(sentences, [], "nothing is spoken");
    assert.equal(finishes(), 1, "and the bracket is still closed");
  });

  it("hands the loop back between pieces, rather than encoding a whole track in one step", async () => {
    // The other half of the same defect (design D2): a whole track's encode is 1576 ms measured,
    // taken in a single turn of the loop — while the platform's reply may still be due on the
    // clock, whose delivery runs on timers. A piece is 71 ms.
    //
    // Asserted as an ordering and not as a duration, so it is not a test of this machine: a timer
    // scheduled before the handover has to fire *during* it, which it can only do if the handover
    // yields. The track is three pieces long, so there are two yields to miss.
    const { speaker } = recordingSpeaker();
    let loopWasFree = false;
    const timer = setTimeout(() => {
      loopWasFree = true;
    }, 1);

    await playTrack(speaker, { path: "/srv/music/A Tone.mp3", sampleRate: 44100, samples: tone(44100 * 25) }, 0);
    clearTimeout(timer);

    assert.ok(loopWasFree, "a timer due during the handover fired before it finished");
  });

  it("plays the track at the level the deployment records", async () => {
    // The level the person hears (design D3). What the figure *should* be is not this test's
    // business — it is one measurement set against another, and it lives in `config.ts` beside the
    // number it produced. What is pinned here is the arithmetic: the frames handed over are the
    // file's own samples, less the recorded figure, and clamped.
    const track = await decodeTrack(FIXTURE);
    assert.ok(track, "the fixture decodes");

    const peakAt = async (gainDb: number): Promise<number> => {
      const { sentences, speaker } = recordingSpeaker();
      await playTrack(speaker, track, gainDb);
      const { pcm } = parseWavAudio(sentences[0]!.audio!);
      let peak = 0;
      for (let at = 0; at < pcm.length; at += 2) {
        const level = Math.abs(pcm.readInt16LE(at));
        if (level > peak) peak = level;
      }
      return peak;
    };

    const asTheFileIs = await peakAt(0);
    for (const gainDb of [MUSIC_GAIN_DB_DEFAULT, -6, 6]) {
      const played = await peakAt(gainDb);
      const expected = Math.round(asTheFileIs * 10 ** (gainDb / 20));
      assert.equal(played, expected, `${gainDb} dB in the file's own terms`);
    }

    // A positive gain cannot wrap what is already at full scale: wrapping is not louder, it is a
    // different waveform, so the samples are held at the end of the range instead.
    const loud = { path: "/srv/music/Loud.mp3", sampleRate: 44100, samples: new Int16Array(4410).fill(32000) };
    const { sentences, speaker } = recordingSpeaker();
    await playTrack(speaker, loud, 6);
    const { pcm } = parseWavAudio(sentences[0]!.audio!);
    assert.equal(pcm.readInt16LE(0), 32767, "held at the top of the range rather than wrapped round it");
  });
});
