import type { BridgeConfig } from "./config.js";
import { info, warn } from "./log.js";
import { frame } from "./protocol/framing.js";
import { transcodeSentence } from "./protocol/opus.js";
import type { TurnSentence } from "./turn.js";

/**
 * The bridge's voice, as the device hears it.
 *
 * One of these belongs to a session, because the device's speaking state belongs
 * to the socket: `tts start` puts the firmware into `speaking`, binary frames
 * arriving outside that state are discarded without a word, and `tts stop` leaves
 * it. The bracket is therefore not an optimisation — a bridge that streams frames
 * without it is silent, and its log looks exactly like a bridge whose Opus is
 * broken (D4). So the bracket and the frames are written in the same place, and
 * neither can be sent without the other.
 *
 * The bracket is opened lazily — on the first sentence that actually carries
 * audio — rather than when a turn begins. A turn emits text and sometimes a
 * notice before any speech, and a device told to start speaking before there is
 * anything to say sits in `speaking` through its own silence. It is closed by
 * `finish()`, which a caller must run when the turn ends, whether or not it was
 * ever opened.
 *
 * This is also where the bridge's own sense of its voice lives: how much audio it
 * has sent, which is the only clock that knows when the device has finished
 * playing it (D10). The device reopens its microphone before its speaker stops,
 * so the frames that come back early are its own voice, and nothing but arithmetic
 * on what was sent can tell the difference.
 */

/** 1 === OPEN, checked as a literal rather than through `ws`'s own constants. */
const OPEN = 1;

/** The slice of a socket this module needs, so a test can be a socket too. */
export interface SpeakerSocket {
  send(data: string | Buffer, options?: { binary?: boolean }): void;
  readyState: number;
}

export interface Speaker {
  /** Speak one sentence of the reply (5.2, 5.3). Safe to call for every event. */
  speak(sentence: TurnSentence): void;
  /** Close the bracket if it is open. Idempotent, and safe on a turn with no speech. */
  finish(): void;
  /** How much audio has been sent to this device, in ms (D10, D11). */
  sentMs(): number;
}

export function createSpeaker(socket: SpeakerSocket, config: BridgeConfig): Speaker {
  const framing = { sampleRate: config.serverRate, frameMs: config.frameMs };
  let speaking = false;
  let sent = 0;

  const sendJson = (message: Record<string, unknown>): boolean => {
    if (socket.readyState !== OPEN) {
      // A device that dropped mid-reply is not a failure worth throwing over: the
      // session is already over, and the next line in the log is the close.
      warn(`socket is not open (${socket.readyState}); dropped ${message.type}/${message.state ?? ""}`);
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  };

  return {
    speak(sentence: TurnSentence): void {
      // A sentence the platform could not synthesize arrives with no audio at all
      // (5.5), and one with nothing speakable in it is a sentence to skip rather
      // than a turn to fail.
      if (sentence.audio === null) return;

      let frames: Buffer[];
      try {
        frames = transcodeSentence(sentence.audio, framing);
      } catch (error) {
        // The turn is already running and its text has already been generated, so
        // a sentence that cannot be spoken is reported and skipped — the rest of
        // the reply is still worth saying.
        warn(
          `sentence ${sentence.index} could not be spoken: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
        return;
      }
      if (frames.length === 0) return;

      // Before the first frame, never after: the device discards frames that
      // arrive outside `speaking`, and the discard is invisible.
      if (!speaking) {
        if (!sendJson({ type: "tts", state: "start" })) return;
        speaking = true;
      }

      let sentHere = 0;
      for (const packet of frames) {
        if (socket.readyState !== OPEN) {
          warn(`socket closed after ${sentHere} frame(s) of sentence ${sentence.index}; stopping this reply`);
          break;
        }
        socket.send(frame(packet, config.framing), { binary: true });
        sentHere += 1;
      }
      sent += sentHere * config.frameMs;
      info(
        `sentence ${sentence.index}: ${sentHere} frame(s) @ ${config.serverRate}Hz/${config.frameMs}ms ` +
          `(${(sentHere * config.frameMs) / 1000}s, ${(sent / 1000).toFixed(2)}s this session)`
      );
    },

    finish(): void {
      if (!speaking) return;
      // Flipped before the send, so a socket that throws on the way out cannot
      // leave the bracket believed open — the next turn must start a fresh one.
      speaking = false;
      // A device that has already gone took the bracket with it: the state lives
      // in its socket, and the close is logged where it happened. Warning here
      // would report the same drop twice, once as a failure to say "stop" to
      // something that no longer exists.
      if (socket.readyState !== OPEN) return;
      socket.send(JSON.stringify({ type: "tts", state: "stop" }));
      info(`tts stop — ${(sent / 1000).toFixed(2)}s of audio sent this session`);
    },

    sentMs(): number {
      return sent;
    },
  };
}
