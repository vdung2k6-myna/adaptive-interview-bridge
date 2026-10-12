import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { MPEGDecoderWebWorker } from "mpg123-decoder";
import { fold } from "./commands.js";
import { warn } from "./log.js";
import { buildWav } from "./protocol/wav.js";
import type { TurnSentence, TurnTool } from "./turn.js";

/**
 * Music of the bridge's own, read off its own disk.
 *
 * The bridge has always *relayed* audio — the platform synthesizes a sentence and the bridge
 * re-encodes it for the device's speaker. This is the same act with the bridge as the source:
 * a file becomes samples, the samples become the WAV the speaker path already takes, and the
 * device cannot tell a track from a long reply.
 *
 * The decode is left at the file's own rate and in mono. The device's rate is 24000 and the
 * platform's speech arrives at 44100, so *every* reply already passes through the resampler in
 * `protocol/opus.ts`; a second one here would be a second answer to a question that path has
 * already answered, and the two would drift apart the first time either changed.
 */

export interface Track {
  /** Where it was read from, as it will be named in a log line. */
  path: string;
  /** The file's own rate. Resampled downstream, with every reply. */
  sampleRate: number;
  /** Mono, as the device takes it. */
  samples: Int16Array;
}

/**
 * One file, decoded — or `null` for a file that is not audio this bridge can play.
 *
 * `null` rather than a throw, because every caller's answer to it is the same: nothing plays,
 * and what was asked for is reported. A file that cannot be read and a file that decodes to no
 * samples are the same answer for the same reason, and the difference is in the log.
 *
 * A file that decodes to *no* samples is the test that matters, and not the decoder's error
 * list: measured against `test/fixtures/not-audio.mp3`, junk comes back with zero samples and
 * **zero errors**, so a caller reading the errors would happily play a second of silence.
 */
export async function decodeTrack(path: string): Promise<Track | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    warn(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  // The worker-backed decoder, and it is the whole of this change: the plain `MPEGDecoder` decodes
  // on **this** thread, and a track is minutes — 843 ms measured for a four-and-a-half-minute one,
  // in a single step the event loop cannot be interrupted inside. A caller reaches here while the
  // platform's reply is still streaming *and* still being spoken, and the frames of that reply are
  // delivered by timers: a blocked loop delivers them late, the device's twenty-frame decode queue
  // empties, and the person hears the reply stutter while the bridge works ahead of it.
  //
  // The decode stays *here* rather than being deferred to after the turn, which is the other way to
  // unpick it, because the answer a caller gives has to be the truth about the file: only a decode
  // establishes that it plays, and deferring would have the bridge announce a track it has not yet
  // found out it can play. The worker keeps both — the loop is free, and the answer is still earned.
  const decoder = new MPEGDecoderWebWorker();
  try {
    await decoder.ready;
    const { channelData, samplesDecoded, sampleRate } = await decoder.decode(new Uint8Array(bytes));
    if (samplesDecoded === 0 || channelData.length === 0 || sampleRate <= 0) {
      warn(`${path} decoded to no samples — it is not an mp3 this bridge can play`);
      return null;
    }
    return { path, sampleRate, samples: toMono(channelData, samplesDecoded) };
  } catch (error) {
    warn(`${path} could not be decoded: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    // The decoder holds a WASM heap *and a thread* per instance, and a track is decoded once and
    // then handed on as plain samples. Nothing here needs either afterwards.
    await decoder.free();
  }
}

/**
 * The channels of a decoded file as one.
 *
 * Averaged rather than taking the first channel: a track panned to one side would otherwise
 * arrive at half its intended level, and silence in the other channel — which a mono file
 * written as stereo has — would halve it too.
 */
function toMono(channelData: Float32Array[], samplesDecoded: number): Int16Array {
  const channels = channelData.length;
  const mono = new Int16Array(samplesDecoded);
  for (let i = 0; i < samplesDecoded; i++) {
    let sum = 0;
    for (const channel of channelData) sum += channel[i] ?? 0;
    // Float samples are -1..1; 32768 would round the peak to one past what an Int16 holds.
    const value = Math.round((sum / channels) * 32767);
    mono[i] = Math.max(-32768, Math.min(32767, value));
  }
  return mono;
}

/** What a request for music came to: a file, or a reason there is none. */
export type TrackChoice =
  | { ok: true; path: string }
  | { ok: false; reason: "no-music" | "no-match" | "ambiguous"; detail: string };

/**
 * The namespace the bridge's own tools are offered under.
 *
 * One string does the routing: a call naming a tool under this prefix is answered by the bridge's
 * own sink and never forwarded to the gadget, which did not report it and must not be asked for
 * it. Exported because the catalogue and the router are two halves of one contract, and a name
 * that drifts between them is a call the model can make and nobody answers.
 */
export const BRIDGE_TOOL_PREFIX = "bridge.";

/** The three, in one place: what the catalogue offers is what the router reads. */
const PLAY_TOOL = `${BRIDGE_TOOL_PREFIX}play_music`;
const STOP_TOOL = `${BRIDGE_TOOL_PREFIX}stop_music`;
const LIST_TOOL = `${BRIDGE_TOOL_PREFIX}list_music`;

/**
 * What this bridge can be asked to do with music, in the shape a turn carries.
 *
 * The gadget's tools are named `self.` because they are about the gadget; these are named
 * `bridge.` because they are about the machine the bridge runs on, which no gadget reports and no
 * gadget should be asked about. The model is handed both in one field and has to be able to tell
 * which of the two it is reaching for, and the bridge that receives the call has to route it — the
 * one name is what does both.
 *
 * Empty for a deployment with no directory, for the reason the grammar is behind the same gate: a
 * tool that can only ever fail is worse than a tool not offered, because the model reaches for it
 * and the person hears the model's account of a failure the bridge knew about in advance.
 *
 * `query` is the person's own words, unfiltered, exactly as the grammar's `named` forms carry it —
 * whether a name matches a file is the directory's answer (`chooseTrack`) and not the catalogue's.
 *
 * `list_music` is what makes the other two answerable when the words do not match. What reaches
 * the model is a transcript, and a title said inside another language comes back as something no
 * file is called: measured on the deployment 2026-10-11, "Back in Black" came back as "Buckingham"
 * on three draws of eight. No matcher can repair that — but a model shown the shelf can, which is
 * why it is handed the names rather than left to compose a string that has to be exactly right.
 */
export function musicTools(directory: string): readonly TurnTool[] {
  if (directory === "") return [];
  return [
    {
      name: PLAY_TOOL,
      description:
        "Play a track from the music library on the machine this bridge runs on, through the " +
        "device's own speaker. Use it when the person asks to hear music rather than asking a " +
        "question. Name the track with `query` in the words they used if they named one, and " +
        "leave it out to play any track.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The track the person asked for, in their own words. Omit for any track.",
          },
        },
      },
    },
    {
      name: STOP_TOOL,
      description: "Stop the music this bridge is playing through the device's speaker.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: LIST_TOOL,
      description:
        "List the tracks in the music library on the machine this bridge runs on. Use it when the " +
        "person asked for a track and what they said may not be what its file is called — a title " +
        "spoken in another language, or a name that came back wrong — and then call " +
        `${PLAY_TOOL} with one of the names it answers with.`,
      inputSchema: { type: "object", properties: {} },
    },
  ];
}

/**
 * What a call to one of the bridge's own tools asks for, or `null` for a name that is not one.
 *
 * Wider than `BridgeCommand` by one member, and the difference is worth the second type: that one
 * is what a *person's utterance* turned out to be, and `list-music` is never an utterance — nothing
 * a person says asks the bridge to enumerate its files. It is a call the platform's model makes,
 * and the answer goes back to it.
 */
export type MusicCall =
  | { task: "play-music"; query: string }
  | { task: "stop-music" }
  | { task: "list-music" };

/**
 * The other half of `musicTools`, and next to it so that the two cannot drift: the catalogue is
 * what the model is offered, this is what the sink does with what comes back, and the names are
 * built from the same three constants.
 *
 * A missing `query` is the bare request rather than a fault — "play some music" with nothing named
 * is what the tool's own description tells the model to send, and `chooseTrack` is where an unnamed
 * request is settled.
 */
export function musicCommand(name: string, args: Record<string, unknown>): MusicCall | null {
  if (name === STOP_TOOL) return { task: "stop-music" };
  if (name === LIST_TOOL) return { task: "list-music" };
  if (name !== PLAY_TOOL) return null;
  const query = args["query"];
  return { task: "play-music", query: typeof query === "string" ? query : "" };
}

/**
 * The names a person would ask this directory's tracks for by, in the order the directory gives
 * them — each file's own name, without its extension, and without the folder it was filed in,
 * which is a thing a person does not say.
 *
 * Read at the call and held nowhere, so that a track added to the library is offered on the next
 * turn rather than at the next restart. A directory that cannot be read is the answer "nothing to
 * play" and not a fault, for the reason `chooseTrack` gives the same one.
 */
export async function listTrackNames(
  directory: string
): Promise<{ ok: true; names: readonly string[] } | { ok: false; detail: string }> {
  if (directory === "") return { ok: false, detail: "this bridge has no music directory" };

  let tracks: string[];
  try {
    // `chooseTrack`'s own listing, and the same `no-music` reading of one that cannot be made: the
    // two must agree about what the library is, or the model is offered names nothing can play.
    tracks = (await listFiles(directory)).filter((name) => name.toLowerCase().endsWith(".mp3"));
  } catch (error) {
    return {
      ok: false,
      detail: `${directory} could not be listed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const names = tracks.map((name) => basename(name).replace(/\.[^.]+$/, ""));
  return { ok: true, names: names.sort() };
}

/**
 * Every file under `directory`, as a path relative to it — the directory's own, and then the files
 * of every directory below it.
 *
 * Walking below the configured directory is the whole of it: a person's music is filed in folders,
 * and reading only the top one means a track that exists is a track the bridge is silent about,
 * which is the one thing a directory listing must not be. The relative paths are what `join` is
 * given afterwards, so a track below the root is opened exactly as one beside it.
 *
 * A directory that cannot be read throws, as the root one does, rather than being skipped: the
 * caller turns that into the same "nothing to play, and here is why" it gives for a root that is
 * not there, which leaves an operator told rather than quietly short of half a library.
 *
 * A symbolic link is not followed — `Dirent.isDirectory()` is false for one — so a music folder
 * that links back onto itself is a folder the walk does not enter.
 */
async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(prefix === "" ? directory : join(directory, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(directory, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/**
 * The file a request names, or a reason it names none.
 *
 * Three answers, and the middle one is the point: a request that several files answer to *equally
 * well* is *reported* rather than settled by picking one. Playing the wrong track is worse than
 * playing none — the person hears something they did not ask for — and the two mistakes do not
 * cost the same.
 *
 * A file is a candidate on the words it **shares** with the request, and not on all of them: the
 * longest unbroken run of the request's words the file's name carries, in order. The request is
 * what a person said, and a person says more than a track's name — a singer after the title, a
 * word the transcriber added — and requiring every word to be in the name is what a request that
 * named its track correctly 8 times in 8 was failing on (measured 2026-10-11). What a file's name
 * does *not* carry is not, by itself, a reason to find nothing.
 *
 * The winner is the strictly longest run; a tie is reported. The alternative — a similarity
 * threshold, or edit distance — cannot be set from anything measured here, and it plays what a
 * request *resembles*, which is the outcome this function exists to refuse.
 *
 * Two guards keep "longest" from meaning "nearest".
 *
 * A run is measured in **words**, so `nhac` is a word of a name and `hac` is not.
 *
 * And a **number in the request is carried by the file that answers it**, or that file is not a
 * candidate at all. `nhạc không lời 3` must not be answered with `Nhac khong loi 2.mp3`, which
 * shares every word of it but the one that tells the two apart.
 *
 * Names are compared folded (`commands.ts`), so a request typed with the tone marks a file name
 * does not carry — which is the ordinary case for Vietnamese — still finds it.
 */
export async function chooseTrack(directory: string, query: string): Promise<TrackChoice> {
  if (directory === "") {
    return { ok: false, reason: "no-music", detail: "this bridge has no music directory" };
  }

  let names: string[];
  try {
    names = await listFiles(directory);
  } catch (error) {
    // A directory that is not there is an answer and not a failure: it is the same thing to a
    // person as a directory that is empty, which is that there is nothing to play.
    return {
      ok: false,
      reason: "no-music",
      detail: `${directory} could not be listed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const tracks = names.filter((name) => name.toLowerCase().endsWith(".mp3"));
  if (tracks.length === 0) {
    return { ok: false, reason: "no-music", detail: `${directory} holds no mp3` };
  }

  const wanted = fold(query);
  if (wanted === "") {
    // "Play music", naming nothing: any of them, and the first by name so that the same request is
    // answered the same way and a deployment can order its directory by naming its files. A person
    // who wants a particular one names it, which is what the `named` forms are for.
    return { ok: true, path: join(directory, [...tracks].sort()[0]!) };
  }

  // The name itself first, without its extension: "nhạc không lời 2" is what that file is called,
  // and a whole-word search would have found it too — but only because no other name contains
  // those words, which is the coincidence this check does not rely on.
  const named = tracks.filter((name) => writings(name.replace(/\.[^.]+$/, "")).includes(wanted));
  if (named.length === 1) return { ok: true, path: join(directory, named[0]!) };
  if (named.length > 1) {
    return { ok: false, reason: "ambiguous", detail: `${named.length} tracks are called ${query}` };
  }

  // Then the words the two share. A number the request carries is the one thing a candidate has to
  // have exactly: it is what tells numbered siblings apart, and they differ in nothing else.
  const words = wanted.split(" ").filter((word) => word !== "");
  const numbers = words.filter((word) => /^\d+$/.test(word));
  // And a run of one word answers only a request of one word. Two words are what a name is made
  // of; one word shared with a longer request is a coincidence — "không có bài này" and
  // "Nhạc không lời" share "không" and are not each other, and a directory that answered the first
  // with the second's files would be reporting a match for a name it does not hold.
  const floor = Math.min(2, words.length);
  const scored = tracks
    .filter((name) => numbers.every((number) => writings(name).some((writing) => hasWord(writing, number))))
    .map((name) => ({ name, run: Math.max(...writings(name).map((writing) => longestRun(writing, words))) }))
    .filter((candidate) => candidate.run >= floor);

  const best = Math.max(0, ...scored.map((candidate) => candidate.run));
  const winners = scored.filter((candidate) => candidate.run === best).map((candidate) => candidate.name);

  if (winners.length === 1) return { ok: true, path: join(directory, winners[0]!) };
  if (winners.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      detail: `${winners.length} tracks match ${query}: ${winners.slice(0, 4).join(", ")}`,
    };
  }

  // Nothing carried the request word for word. What is left, and the only thing that can see inside
  // a token, is the request as it was *heard* rather than as it was spaced. A hyphen invites the
  // transcriber to put the words back together, and it can put back only some of them: measured
  // 2026-10-11, a request for `ao-lua-ha-dong-ngo-thuy-mien.mp3` came back as `aoluahadong`, which is
  // a word of no writing of that name and which no whole-word search finds (D6).
  const heard = tracks.filter((name) => containsWords(flatten(fold(name)), wanted.replace(/ /g, "")));
  if (heard.length === 1) return { ok: true, path: join(directory, heard[0]!) };
  if (heard.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      detail: `${heard.length} tracks match ${query}: ${heard.slice(0, 4).join(", ")}`,
    };
  }

  return { ok: false, reason: "no-match", detail: `nothing in ${directory} matches ${query}` };
}

/**
 * A file's name as the words it is made of — in **both** writings a hyphen allows.
 *
 * `un break` and `unbreak` are the same two words to a person and to the file that carries them,
 * and which one arrives is not the directory's to decide: measured on this deployment 2026-10-11,
 * "Un-Break My Heart" was asked for and the platform returned "unbreak my heart", which a
 * whole-word search then found nothing in — a file that exists, reported as one that does not,
 * because of a hyphen. So both writings are tried rather than either one being declared correct.
 *
 * One writing when the two are the same, which is every name without a hyphen in it.
 *
 * A name that comes back put together **in part** is not this and is not meant to be: this writes
 * the whole name again, so it answers a request that is the whole name and nothing shorter.
 * `containsWords` is what is reached for when even this finds nothing (D6).
 */
function writings(name: string): string[] {
  const spaced = fold(name);
  const joined = fold(name.replace(/-/g, ""));
  return spaced === joined ? [spaced] : [spaced, joined];
}

/** The slice of a speaker this module needs, so a test can be a speaker too — the same narrowing
 *  `SpeakerSocket` is for `speech.ts`. */
export interface TrackPlayer {
  speak(sentence: TurnSentence): void;
  finish(): void;
}

/**
 * How much of a track is handed over at a time, in seconds.
 *
 * It bounds one WAV buffer and nothing else: the speaker paces every frame against the device's
 * own clock (`speech.ts`, `PACE_LEAD_FRAMES`), so a track handed over in one burst is played at
 * realtime regardless. Ten seconds keeps a chunk small enough to be built without thinking about
 * memory and long enough that the count of them is not itself a thing.
 */
const CHUNK_SECONDS = 10;

/** One track as the WAV chunks a speaker takes, in order. */
export function trackChunks(track: Track, seconds: number = CHUNK_SECONDS): Buffer[] {  const perChunk = Math.max(1, Math.round(seconds * track.sampleRate));
  const chunks: Buffer[] = [];
  for (let at = 0; at < track.samples.length; at += perChunk) {
    chunks.push(buildWav(track.samples.subarray(at, at + perChunk), track.sampleRate, 1));
  }
  return chunks;
}

/**
 * A track's samples at the level the deployment plays them, as a gain in dB from the file.
 *
 * A multiplication and not a normalisation: what the person asked for is that recording, and
 * bringing it to a level of the bridge's own choosing would change it — a quietly mastered track
 * would come *up*, and what they hear would be the recording with the bridge's own hand on it.
 *
 * Rounded and **clamped**, which is what a positive gain needs: a file that already peaks at full
 * scale cannot be made louder without wrapping, and wrapping is not louder, it is a different
 * waveform. The clamp is the same one `toMono` applies for its own reason.
 *
 * Nought returns the samples themselves rather than a copy of them, because the default is the one
 * case where a deployment has asked for the file as it is — and a track is millions of samples.
 */
function atLevel(samples: Int16Array, gainDb: number): Int16Array {
  if (gainDb === 0) return samples;
  const factor = 10 ** (gainDb / 20);
  const gained = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    gained[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]! * factor)));
  }
  return gained;
}

/**
 * Play a decoded track through the device's speaker, in one bracket.
 *
 * Nothing here paces or times: the speaker schedules each frame against the device's own playback
 * and holds the bracket open until the last of them is due, so a track is the same act as a long
 * reply — handed over, and then heard. What this does do is hand the **event loop** back between
 * pieces, which is a different thing and is the whole reason it is asynchronous.
 *
 * `speak` builds and encodes the piece it is given synchronously — 71 ms measured for ten seconds
 * of audio — and a whole track handed over in one step is 1576 ms, taken in a single turn of the
 * loop that nothing can interrupt. A caller reaches here with the platform's reply still due on the
 * clock: the speaker's `deliver` runs on a timer (`speech.ts`), the device's decode queue is twenty
 * frames, and a loop held for a second and a half empties it. So the pieces go out one at a time,
 * with one turn of the loop between them.
 *
 * **The track is named once**, on its first piece, and the pieces after it say nothing: they are
 * one thing spoken, handed over in ten-second pieces only because a WAV is built a piece at a
 * time. An announcement per piece is not a display naming a track, it is the same name written
 * down the screen — measured on the board 2026-10-11, whose firmware keeps a **list** of what it
 * was told, so a track of the four to six minutes this deployment holds fills that list twenty
 * times over with one repeated entry and pushes the conversation off it.
 *
 * The pieces after the first carry `null` and **not** an empty text, and the difference is the
 * device's: it reads a text that is a string, and an empty one hides the bar on a board whose
 * display is a single bar — a screen blanked mid-track, which is the opposite of the concern that
 * put the title on every piece to begin with. A message carrying no `text` at all is read as
 * nothing and leaves the display as it is (5.4, `speech.ts`).
 *
 * `finish()` is called even for a track with no samples, which plays nothing. A caller that
 * skipped the decode's refusal would otherwise hand a device a bracket that never closes, and a
 * device left in `Speaking` discards whatever the person says next.
 */
export async function playTrack(player: TrackPlayer, track: Track, gainDb: number): Promise<void> {
  const title = basename(track.path).replace(/\.[^.]+$/, "");
  // The level is applied here, where the track's samples first become audio, and nowhere else: a
  // reply never passes through this function, so a track's level cannot reach one — which is what
  // makes "the bridge plays nothing louder than the voice it speaks with" a property of one line
  // rather than of a promise about every caller.
  const chunks = trackChunks({ ...track, samples: atLevel(track.samples, gainDb) });
  for (let index = 0; index < chunks.length; index++) {
    player.speak({ index, text: index === 0 ? title : null, audio: chunks[index]! });
    // One turn of the loop, so the timers that deliver the audio *already* due — a reply's tail,
    // most of all — run before this piece's encode takes it again. A `setTimeout` of nought is
    // enough and is the point: the timers phase is drained before this callback, so anything
    // overdue goes out first, however many of them there are.
    if (index + 1 < chunks.length) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  player.finish();
}

/**
 * A folded name with its separators taken out, and where its words begin in what is left. The end
 * of the text is one of those places too, so that a request may end a name rather than only begin
 * one.
 */
interface Spoken {
  text: string;
  /** Every index a word begins at, and the end of the text. */
  readonly bounds: readonly number[];
}

function flatten(folded: string): Spoken {
  let text = "";
  const bounds: number[] = [];
  for (const word of folded.split(" ")) {
    if (word === "") continue;
    bounds.push(text.length);
    text += word;
  }
  return { text, bounds: [...bounds, text.length] };
}

/**
 * Whether `needle` — a request with its separators out, as it was heard — appears in `haystack`,
 * beginning and ending where a word of it begins or ends.
 *
 * The boundaries are the whole of the difference between this and a substring search, and they are
 * why it can be reached for at all: `hac` occurs in `nhac` and is not a word of it, and neither is
 * any other fragment (`commands.ts`, D7).
 */
function containsWords(haystack: Spoken, needle: string): boolean {
  if (needle === "") return false;
  for (let at = haystack.text.indexOf(needle); at >= 0; at = haystack.text.indexOf(needle, at + 1)) {
    if (haystack.bounds.includes(at) && haystack.bounds.includes(at + needle.length)) return true;
  }
  return false;
}

/**
 * The longest unbroken run of `words` that appears in `haystack`, as words, in order — 0 for none.
 * Both already folded.
 *
 * A run, and not a subsequence: "diem xua" is in "trinh cong son diem xua" as four consecutive
 * tokens, which is what a name being asked for looks like. Scoring the *longest* run rather than
 * asking whether the whole query is one is what lets a request carry words a name does not — the
 * singer, a word the transcriber added — without losing the file (D2).
 */
function longestRun(haystack: string, words: readonly string[]): number {
  const tokens = haystack.split(" ").filter((token) => token !== "");
  let best = 0;
  for (let at = 0; at < tokens.length; at++) {
    for (let from = 0; from < words.length; from++) {
      let run = 0;
      while (at + run < tokens.length && from + run < words.length && tokens[at + run] === words[from + run]) {
        run++;
      }
      if (run > best) best = run;
    }
  }
  return best;
}

/** Whether `token` is one of `haystack`'s words, both already folded. */
function hasWord(haystack: string, token: string): boolean {
  return haystack.split(" ").some((word) => word === token);
}
