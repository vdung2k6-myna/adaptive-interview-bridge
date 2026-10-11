import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { MPEGDecoder } from "mpg123-decoder";
import { fold, type BridgeCommand } from "./commands.js";
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

  const decoder = new MPEGDecoder();
  try {
    await decoder.ready;
    const { channelData, samplesDecoded, sampleRate } = decoder.decode(new Uint8Array(bytes));
    if (samplesDecoded === 0 || channelData.length === 0 || sampleRate <= 0) {
      warn(`${path} decoded to no samples — it is not an mp3 this bridge can play`);
      return null;
    }
    return { path, sampleRate, samples: toMono(channelData, samplesDecoded) };
  } catch (error) {
    warn(`${path} could not be decoded: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    // The decoder holds a WASM heap per instance, and a track is decoded once and then handed
    // on as plain samples. Nothing here needs it afterwards.
    decoder.free();
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

/** The two, in one place: what the catalogue offers is what the router reads. */
const PLAY_TOOL = `${BRIDGE_TOOL_PREFIX}play_music`;
const STOP_TOOL = `${BRIDGE_TOOL_PREFIX}stop_music`;

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
  ];
}

/**
 * What a call to one of the bridge's own tools asks for, or `null` for a name that is not one.
 *
 * The other half of `musicTools`, and next to it so that the two cannot drift: the catalogue is
 * what the model is offered, this is what the sink does with what comes back, and the names are
 * built from the same two constants.
 *
 * A missing `query` is the bare request rather than a fault — "play some music" with nothing named
 * is what the tool's own description tells the model to send, and `chooseTrack` is where an unnamed
 * request is settled.
 */
export function musicCommand(name: string, args: Record<string, unknown>): BridgeCommand | null {
  if (name === STOP_TOOL) return { task: "stop-music" };
  if (name !== PLAY_TOOL) return null;
  const query = args["query"];
  return { task: "play-music", query: typeof query === "string" ? query : "" };
}

/**
 * The file a request names, or a reason it names none.
 *
 * Three answers, and the middle one is the point: a query that matches two files is *reported*
 * rather than settled by picking one. Playing the wrong track is worse than playing none — the
 * person hears something they did not ask for and has no way to tell that is what happened —
 * and the two mistakes do not cost the same.
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
    const entries = await readdir(directory, { withFileTypes: true });
    names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
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

  // Then those words, whole and in order, anywhere in the name — which is how "diễm xưa" finds
  // "Trinh Cong Son - Diem Xua". Whole words rather than a substring, so that "nhac" does not
  // match every name containing those four letters.
  const words = wanted.split(" ").filter((word) => word !== "");
  const found = tracks.filter((name) => writings(name).some((writing) => holdsWords(writing, words)));
  if (found.length === 1) return { ok: true, path: join(directory, found[0]!) };
  if (found.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      detail: `${found.length} tracks match ${query}: ${found.slice(0, 4).join(", ")}`,
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
export function trackChunks(track: Track, seconds: number = CHUNK_SECONDS): Buffer[] {
  const perChunk = Math.max(1, Math.round(seconds * track.sampleRate));
  const chunks: Buffer[] = [];
  for (let at = 0; at < track.samples.length; at += perChunk) {
    chunks.push(buildWav(track.samples.subarray(at, at + perChunk), track.sampleRate, 1));
  }
  return chunks;
}

/**
 * Play a decoded track through the device's speaker, in one bracket.
 *
 * Nothing here paces, times or waits: the speaker schedules each frame against the device's own
 * playback and holds the bracket open until the last of them is due, so a track is the same act
 * as a long reply — handed over, and then heard.
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
export function playTrack(player: TrackPlayer, track: Track): void {
  const title = basename(track.path).replace(/\.[^.]+$/, "");
  trackChunks(track).forEach((audio, index) => {
    player.speak({ index, text: index === 0 ? title : null, audio });
  });
  player.finish();
}

/** Whether `words` appear consecutively among the words of `haystack`, both already folded. */
function holdsWords(haystack: string, words: readonly string[]): boolean {
  const tokens = haystack.split(" ").filter((token) => token !== "");
  for (let start = 0; start + words.length <= tokens.length; start++) {
    if (words.every((word, offset) => tokens[start + offset] === word)) return true;
  }
  return false;
}
