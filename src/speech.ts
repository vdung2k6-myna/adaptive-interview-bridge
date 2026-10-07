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
 *
 * And the frames are **paced** rather than written as fast as the platform produces
 * them (D16). The device decodes from a bounded queue — 20 frames, 1.2 s — and drops
 * a frame it has no room for **without logging it**, so a bridge that streams a turn
 * in one `for` loop loses everything past the first 1.2 s and looks exactly like one
 * that is merely quiet. Frame *k* of a turn therefore leaves no earlier than its slot
 * on the turn's own clock. The first frame still leaves the instant the bracket opens,
 * which is what keeps 5.3's ordering — the device is told to speak before the reply's
 * last text event, not after it. It also means the bracket stays open as long as the
 * audio it qualifies: `finish()` puts `tts stop` in the last frame's slot rather than
 * at the end of the stream, because a device told to stop would discard the frames
 * still on their way.
 */

/** 1 === OPEN, checked as a literal rather than through `ws`'s own constants. */
const OPEN = 1;

/**
 * Hands one frame to the turn's clock. Injected for the same reason the clock is
 * (D13): the pacing is real time, and a check that only asserts what order things
 * left in wants a scheduler that runs now.
 */
export type SpeakerSchedule = (run: () => void, delayMs: number) => void;

const realSchedule: SpeakerSchedule = (run, delayMs) => {
  setTimeout(run, delayMs);
};

/**
 * How far a turn's frames may run ahead of realtime, in frames (D16).
 *
 * The device's decode queue holds `MAX_DECODE_PACKETS_IN_QUEUE` — 20 frames, 1.2 s —
 * and it drops a frame it has no room for in silence. So the pacing has a ceiling
 * rather than a target: what it must never do is run 20 frames ahead. Sending at
 * exactly realtime is the other edge and the one that bites, because a frame that
 * arrives after the device wanted it is a gap in the playback. Four frames is the
 * margin chosen against that, and it is **unmeasured**; the ceiling it must stay
 * under is where the constraint actually lives.
 */
const PACE_LEAD_FRAMES = 4;

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
  /**
   * Whether the turn `finish()` was last called for opened a bracket — that is, whether
   * the device was ever put into `Speaking` for it at all (D4). `finish()` is where the
   * answer is fixed, because it is the one call every turn makes, and the caller reads
   * it straight after that call.
   *
   * A turn that said nothing never opened a bracket, so the device never left
   * `Listening` for it and will not send the `listen start` that would open the next
   * window — which leaves the caller to reopen it (requirement 4).
   */
  spokeThisTurn(): boolean;
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
  clock: () => number = Date.now,
  schedule: SpeakerSchedule = realSchedule
): Speaker {
  const framing = { sampleRate: config.serverRate, frameMs: config.frameMs };
  // Positive: a frame is due this far *before* the turn reaches it, so the device's
  // pipeline has something in it. See `PACE_LEAD_FRAMES`.
  const paceLead = PACE_LEAD_FRAMES * config.frameMs;
  let speaking = false;
  // The same fact as `speaking`, held past the point `speaking` is cleared: the turn's
  // own answer, for a caller that has to know whether the device was ever taken out of
  // `Listening` for it. See `spokeThisTurn`.
  let spoke = false;
  let sent = 0;
  // The per-turn trio (6.6, D16): when this turn's bracket opened, how many frames
  // it carries, and when the last of them is due. All three are the turn's own and
  // are zeroed at the open rather than at the close, so `finish()` — which runs while
  // the tail of the turn is still on the clock — measures the whole turn and not the
  // frames that have happened to leave so far.
  let turnStart = 0;
  let turnFrames = 0;
  let lastDue = 0;
  // Set the first time a delivery finds the socket closed. A device that has gone is
  // not coming back to this speaker — a reconnect is a new session with a new one —
  // so every later frame stops being handed to the clock instead of each one
  // discovering the same close and warning about it.
  let gone = false;
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

      // Nothing said from here can be heard, so nothing is said: the display is not
      // moved for a sentence nobody will play, and no further slot is reserved on a
      // clock nobody is reading.
      if (gone) return;

      // Before the first frame, never after: the device discards frames that
      // arrive outside `speaking`, and the discard is invisible.
      if (!speaking) {
        if (!sendJson({ type: "tts", state: "start" })) return;
        speaking = true;
        // The turn's clock starts here, not at the first frame below and not at
        // `finish()`: the deadline 6.6 computes is anchored on the moment the device
        // was told to start playing, which is the earliest this turn's audio can be
        // audible. Zeroed rather than accumulated, so a previous turn's audio is not
        // counted into this one — and zeroed here rather than at the close, because
        // the frames of this turn are what the clock is measured in (D16).
        turnStart = clock();
        turnFrames = 0;
        lastDue = turnStart;
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

      // The turn's slots are reserved before any of them is filled (D16). `finish()`
      // arms the deadline 6.6 reads while the tail of this turn is still on the clock,
      // so the turn's total has to be its whole audio rather than the frames that
      // happened to have left by then — and the frames cannot all leave at once, since
      // the device drops what its 20-frame queue has no room for.
      sent += frames.length * config.frameMs;
      turnMs += frames.length * config.frameMs;

      let sentHere = 0;
      for (const packet of frames) {
        const due = turnStart + turnFrames * config.frameMs - paceLead;
        turnFrames += 1;
        lastDue = due;
        const deliver = (): void => {
          if (gone) return;
          if (socket.readyState !== OPEN) {
            gone = true;
            warn(`socket closed after ${sentHere} frame(s) of sentence ${sentence.index}; stopping this reply`);
            return;
          }
          socket.send(frame(packet, config.framing), { binary: true });
          sentHere += 1;
        };
        // A slot already reached is filled at once, which is always true of the first
        // frames of a turn: the lead is what makes frame 0 leave with the bracket,
        // rather than a frame duration after it, so 5.3's ordering survives the pacing.
        const wait = due - clock();
        if (wait > 0) schedule(deliver, wait);
        else deliver();
      }
      info(
        `sentence ${sentence.index}: ${frames.length} frame(s) @ ${config.serverRate}Hz/${config.frameMs}ms ` +
          `(${(frames.length * config.frameMs) / 1000}s, ${(sent / 1000).toFixed(2)}s this session)`
      );
    },

    finish(): void {
      // Read before the early return rather than after it: a turn that said nothing is
      // the one the caller has to be told about, and it is the one that gets there.
      // Assigned rather than left standing, so a silent turn does not report the turn
      // before it (requirement 4).
      spoke = speaking;
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
      const until = turnStart + turnMs + config.drainGuardMs;
      drainUntil = until;
      // The close goes into the last frame's own slot rather than out here (D16).
      // At this moment seconds of the turn may still be on the clock, and a device
      // that has left `speaking` discards the frames that follow — so closing here
      // would truncate the reply to however much had been sent by the time the
      // platform finished producing it, which is the defect the pacing fixes.
      const closesAt = lastDue + config.frameMs;
      const close = (): void => {
        // A device that has already gone took the bracket with it: the state lives
        // in its socket, and the close is logged where it happened. Warning here
        // would report the same drop twice, once as a failure to say "stop" to
        // something that no longer exists.
        if (socket.readyState !== OPEN) return;
        socket.send(JSON.stringify({ type: "tts", state: "stop" }));
        info(
          `tts stop — ${(turnMs / 1000).toFixed(2)}s of audio this turn, ` +
            `microphone distrusted for another ${((until - clock()) / 1000).toFixed(2)}s`
        );
      };
      const wait = closesAt - clock();
      if (wait > 0) schedule(close, wait);
      else close();
    },

    spokeThisTurn(): boolean {
      return spoke;
    },

    sessionMs(): number {
      return sent;
    },

    drainingUntil(): number | null {
      return drainUntil;
    },
  };
}
