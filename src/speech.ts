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
 * playing it (D10). The device reopens its microphone before its speaker stops —
 * measured 1.7–2.3 s early in the rig — while reporting that it is listening, and
 * the echo it sends back measures 5–8k RMS against 19–24k for speech, so no energy
 * test separates them. Nothing but arithmetic on what was sent can.
 *
 * There are therefore **two** counters here and they must not be confused (6.6).
 * `sessionMs()` is cumulative for the life of the socket: it is what an operator
 * reads to see how much the bridge has said, and it deliberately never resets.
 * `drainingUntil()` is this turn's own deadline, and only the input path reads it.
 * The rig reached for the first where it needed the second, and a port that did the
 * same would keep the microphone distrusted for every turn a device has ever taken.
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
  /** How much audio has been sent to this device over the life of the socket, in ms
   *  (D10, D11). Session-cumulative by design: it does not reset at a turn boundary. */
  sessionMs(): number;
  /**
   * The moment this turn's audio has finished playing, plus the drain guard, or
   * `null` when no turn has finished speaking on this socket yet (6.6).
   *
   * Read from the session's clock, and anchored at this turn's **first** frame rather
   * than at `finish()`: a turn that streams for four seconds has been playing for
   * four seconds by the time the bracket closes, and a deadline set at the close
   * would distrust the microphone for four seconds too many.
   */
  drainingUntil(): number | null;
}

export function createSpeaker(
  socket: SpeakerSocket,
  config: BridgeConfig,
  clock: () => number = Date.now
): Speaker {
  const framing = { sampleRate: config.serverRate, frameMs: config.frameMs };
  let speaking = false;
  let sent = 0;
  // The per-turn pair (6.6): when this turn's bracket opened, and how much audio it
  // has carried. Zeroed at the open rather than at the close, so both are this turn's.
  let turnStart = 0;
  let turnMs = 0;
  // `null` is "no deadline", and only ever before a turn on this socket has spoken:
  // a sentinel timestamp would be a value the clock could legitimately return, and
  // the one thing this must never do is claim the device is playing when it is not.
  let drainUntil: number | null = null;

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
        // The turn's clock starts here, not at the first frame below and not at
        // `finish()`: the deadline 6.6 computes is anchored on the moment the device
        // was told to start playing, which is the earliest this turn's audio can be
        // audible. Zeroed rather than accumulated, so a previous turn's audio is not
        // counted into this one.
        turnStart = clock();
        turnMs = 0;
      }

      // What the device's display shows while this sentence is heard (5.4). One
      // per sentence and ahead of its frames, so the display names what is being
      // said rather than what has just finished; the firmware turns it into its
      // own `SetChatMessage("assistant", …)`, and text arriving here is the only
      // thing that moves that display.
      //
      // It sits after the null-audio and transcode checks rather than before them
      // because it is a claim about audio: a sentence the device will not speak
      // must not be announced, or the display would show words nobody hears. That
      // makes 5.5's silent sentences mute on the display too, which is the honest
      // reading of a sentence with nothing to play.
      if (!sendJson({ type: "tts", state: "sentence_start", text: sentence.text })) return;

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
      turnMs += sentHere * config.frameMs;
      info(
        `sentence ${sentence.index}: ${sentHere} frame(s) @ ${config.serverRate}Hz/${config.frameMs}ms ` +
          `(${(sentHere * config.frameMs) / 1000}s, ${(sent / 1000).toFixed(2)}s this session)`
      );
    },

    finish(): void {
      // A turn that spoke nothing never opened the bracket and leaves the previous
      // deadline standing — there is no audio of its own to distrust the microphone
      // for. That is the rig's behaviour too, and it is the right one: the device
      // cannot be playing this turn's silence.
      if (!speaking) return;
      // Flipped before the send, so a socket that throws on the way out cannot
      // leave the bracket believed open — the next turn must start a fresh one.
      speaking = false;
      // The deadline is armed before the send for the same reason, and it is armed
      // whether or not the socket is still open: a device that has gone took the
      // bracket with it, but a session that reconnects is a new session with a new
      // speaker, so there is nothing here a stale deadline could outlive.
      drainUntil = turnStart + turnMs + config.drainGuardMs;
      // A device that has already gone took the bracket with it: the state lives
      // in its socket, and the close is logged where it happened. Warning here
      // would report the same drop twice, once as a failure to say "stop" to
      // something that no longer exists.
      if (socket.readyState !== OPEN) return;
      socket.send(JSON.stringify({ type: "tts", state: "stop" }));
      info(
        `tts stop — ${(turnMs / 1000).toFixed(2)}s of audio this turn, ` +
          `microphone distrusted for another ${((drainUntil - clock()) / 1000).toFixed(2)}s`
      );
    },

    sessionMs(): number {
      return sent;
    },

    drainingUntil(): number | null {
      return drainUntil;
    },
  };
}
