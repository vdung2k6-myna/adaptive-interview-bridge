import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { BridgeConfig } from "../config.js";
import { basename } from "node:path";
import { describeCommand, matchCommand, type BridgeCommand, type SpokenCommand } from "../commands.js";
import { BRIDGE_TOOL_PREFIX, chooseTrack, decodeTrack, musicCommand, musicTools, playTrack } from "../music.js";
import type { Track } from "../music.js";
import { takeTurn, type Conversations } from "../conversation.js";
import { authorizeDevice, describeDenial } from "../credentials.js";
import { createGadget, type CommandOutcome } from "../gadget.js";
import { createListening } from "../listening.js";
import { err, info, log, section, warn } from "../log.js";
import type { PersonaCatalog } from "../personas.js";
import { advertisesTools } from "../protocol/mcp.js";
import { isAbort, isHello, isListen, isMcp, parseClientMessage, serverHello } from "../protocol/messages.js";
import { createSpeaker } from "../speech.js";
import type { ToolCallOutcome, ToolCallRequest, TurnTool } from "../turn.js";

/**
 * The device's socket.
 *
 * A connection is a session for as long as it lasts, and it belongs to the
 * device the credential names — not to whichever identifier the connection
 * declares, which is why the verdict is made here, at the upgrade, and carried
 * on the request for the rest of the session to read.
 *
 * A refused connection is refused as an HTTP 401 during the upgrade rather than
 * accepted and closed: the firmware reads a non-101 as "server not connected",
 * so the device shows a failure and retries, and both ends agree that nothing
 * happened. Accepting first would let a device believe it was connected, and
 * would leave the audio it then sends looking like a bridge fault.
 *
 * The two halves of a spoken turn meet here and nowhere else. Speech to the device
 * is the `tts` bracket and the frames it qualifies, which belong to one connection's
 * speaking state and therefore live beside it. Speech *from* the device is the
 * listening window — the frames, the endpointer over them, and the turn that closes
 * when the endpointer says so (`listening.ts`) — and what this file does is hold the
 * window against the socket's own state, which is the one thing the endpointer cannot
 * see for itself: whether the device is streaming a person or its own speaker.
 *
 * Nothing here decides anything about the audio. The bridge's three answers to a
 * closed window — take the utterance to the platform, say the transcription back,
 * and leave the device able to take the next turn — are all consequences of the
 * verdict `listening.ts` returns, and the ordering that matters (open the next
 * window before the turn is attempted) is enforced where the verdict is read.
 */
/** 1 === OPEN, checked as a literal rather than through the socket's own constants,
 *  so this file reads the same number `speech.ts` does. */
const OPEN = 1;

/**
 * How long a closing handshake is given before the socket is finished off.
 *
 * `ws.close()` waits out its own `closeTimeout` — thirty seconds by default — when the peer
 * does not answer, and the gadget has been seen to leave the old socket open until it is next
 * woken. That is a window in which the bridge holds two sessions for one device, since the
 * next wake opens a new socket, and the teardown this session owes is put off just as long.
 * A second is long enough for a peer that means to answer, and short enough that neither
 * happens.
 */
const IDLE_CLOSE_GRACE_MS = 1_000;

interface DeviceRequest extends IncomingMessage {
  /** Set by the upgrade check, read by the session. The authenticated identity. */
  bridgeDeviceId?: string;
}

/**
 * The rest of the service a session needs: who answers this device (3.x), and what
 * it has already been told (4.2). Passed in rather than built here, because both
 * outlive a connection — a persona catalog is read once at start, and a conversation
 * is kept per device precisely so that a reconnecting device is not a stranger.
 */
export interface WsServices {
  catalog: PersonaCatalog;
  conversations: Conversations;
}

export function createWsServer(config: BridgeConfig, services: WsServices): WebSocketServer {
  const wss = new WebSocketServer({
    port: config.wsPort,
    verifyClient: (info, done) => {
      const req = info.req as DeviceRequest;
      const verdict = authorizeDevice(config, {
        deviceId: header(req, "device-id"),
        authorization: header(req, "authorization"),
      });

      if (!verdict.ok) {
        // The remote address is logged because this line is the only record of a
        // connection that never becomes a session — without it, an operator
        // debugging a device that will not connect sees nothing at all.
        warn(
          `refused ${req.socket.remoteAddress}: ${describeDenial(verdict.reason)} ` +
            `(device-id=${header(req, "device-id") ?? "absent"})`
        );
        done(false, 401, "Unauthorized");
        return;
      }

      req.bridgeDeviceId = verdict.deviceId;
      done(true);
    },
  });

  wss.on("listening", () =>
    log(`WS   listening on ws://${config.publicHost}:${config.wsPort}/xiaozhi/v1/ (any path accepted)`)
  );
  wss.on("error", (e) => err(`ws server: ${e.message}`));

  wss.on("connection", (ws: WebSocket, req: DeviceRequest) => {
    const deviceId = req.bridgeDeviceId ?? "unknown";
    const session = {
      id: `s${Date.now().toString(36)}`,
      frames: 0,
      bytes: 0,
      /** Whether the bridge has a listening window open for this device. The device
       *  never closes one itself (D9), so this is the bridge's own state and not a
       *  mirror of the firmware's. */
      listening: false,
      /** Frames dropped because the device was still playing the bridge's own audio. */
      drained: 0,
      /** Words the platform heard, which the device's display is told (6.2). */
      heard: 0,
    };
    // One clock for the session, injected rather than reached for (D13). Both
    // `speech.ts` and `listening.ts` measure against it — the drain guard against the
    // endpointer — so a replay that supplies its own clock sees one session's
    // timing rather than two that agree only on hardware.
    const clock = (): number => Date.now();
    // The device's voice, for the life of the socket: the speaking state the
    // bracket controls belongs to this connection and to no other.
    const speaker = createSpeaker(ws, config, clock);
    // The person's voice, for the life of the socket: the decoder belongs to the
    // window rather than to the process, so this is the only place it is held.
    const listening = createListening(config, clock);
    // The gadget itself, for the life of the socket: the tool channel the bridge opens
    // to it, and the condition it reports about itself. The catalog that channel reads
    // is a property of the firmware this session is talking to, so it belongs to this
    // connection and not to the process — and nothing here is awaited by a turn (D3,
    // D4).
    const gadget = createGadget(ws, config, session.id);
    // One turn at a time per device. A `listen start` arriving while a reply is
    // still playing is either a person talking over it or the echo of a wake word
    // (6.5); neither is a second turn, and starting one would talk over a reply
    // that is still being heard.
    let turning = false;
    // The turn in flight, so the device's `abort` can cancel it at the source (6.5).
    // `runTurn` and `takeTurn` have always taken a signal and nothing has ever passed
    // one: the abort reaches `fetch`, rejects the body read, unwinds `consumeStream`,
    // and stops `onSentence` — one mechanism covering the turn being produced, the
    // bracket mid-reply, and the window where no bracket was ever opened.
    let turn: AbortController | null = null;
    // Whether the previous frame was dropped as the device's own echo, so the
    // endpointer's clock can be restarted when that window ends (6.6).
    let draining = false;
    // Whether this bridge is playing a track of its own — which is not the same question as whether
    // its bracket is open, and is asked in two places the bracket cannot answer: whether a stop has
    // anything to stop, and whether a play should first stop what is already going. It is cleared
    // when the device says it is listening again, which is when its speaker has finished.
    let playing = false;
    // When something last happened that a person was behind, and the timer that ends the
    // session when nothing has for `sessionIdleMs`. Not a clock on the bytes: a window is
    // held open while the device is Listening, and the device streams Opus whether or not
    // anyone is speaking, so a byte-clock would mean a room with a fan in it never let a
    // session end. What resets it is a closed turn, the turn that followed ending, and the
    // wake word — each of them evidence of a person, and none of them produced by an empty
    // room. A `giveup` is deliberately not among them: the endpointer produces one every
    // `vadNoSpeechMs` in a room nobody is in, so counting it would stop the window firing
    // at all (design.md).
    let lastPersonAt = clock();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    // Armed only while a close is in flight — see `fireIdleWindow`.
    let closeGraceTimer: ReturnType<typeof setTimeout> | null = null;

    /** Arm the window for `remainingMs`, replacing whatever was armed. */
    function armIdleWindow(remainingMs: number): void {
      if (config.sessionIdleMs === 0) return;
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(fireIdleWindow, Math.max(remainingMs, 1));
      // A session's window is not a reason for the process to stay up: the servers are.
      // Without this a bridge asked to shut down waits out the longest window it armed.
      idleTimer.unref();
    }

    /** A person did something. Start the window again, whole. */
    function sawPerson(): void {
      lastPersonAt = clock();
      armIdleWindow(config.sessionIdleMs);
    }

    /**
     * The window ran out: nothing has happened that a person was behind for the whole of
     * it. End the session, which is what leaves the device in Idle — its microphone closed,
     * its wake word armed again, and the one state the firmware's own power management can
     * run from (`CanEnterSleepMode`, and `src/config.ts` on `sessionIdleMs`).
     *
     * Nothing is sent to the device to do it. Its websocket path has no handler for the
     * vendor's `goodbye`, so a message would be logged and dropped; on this transport
     * closing the socket is the lever (design.md).
     */
    function fireIdleWindow(): void {
      // A reply being spoken outlasts the window by design — `maxTurnMs` is longer than
      // `sessionIdleMs` — and a turn is a person. Re-arm for the whole window rather than
      // for the remainder, which is already spent.
      if (turning) {
        armIdleWindow(config.sessionIdleMs);
        return;
      }
      // The bridge's own audio is the person's, and it outlasts them: a track was asked for and is being
      // listened to, so the last frame the bridge has to play is a thing a person was behind, and the
      // window is measured from whichever came later — what a person did, or what the bridge is still
      // saying. Without this the session ends in the middle of the music: measured on the board
      // 2026-10-11, a 152-second track started at 76s and the session was closed at 137s, so a track
      // longer than the window could never be heard past it — which is the whole of what a track is for
      // (`voice-gadget`: the window is open again once the track has ended).
      //
      // `drainingUntil` is a deadline and not a flag: it is always the end of the last audio handed to
      // the device, and `stop()` moves it back to what was actually delivered. A window held by a
      // deadline cannot be held forever by anything a device does. The `idleMs` below goes negative
      // while a track plays, which the re-arm reads as "longer than the whole window" — that is, the
      // rest of the track *and* a window after it — and it converges on the end of the audio.
      const since = Math.max(lastPersonAt, speaker.drainingUntil() ?? 0);
      const idleMs = clock() - since;
      if (idleMs < config.sessionIdleMs) {
        armIdleWindow(config.sessionIdleMs - idleMs);
        return;
      }
      log(
        `no person in ${(config.sessionIdleMs / 1000).toFixed(0)}s — closing the session ` +
          `(${session.frames} frame(s), ${session.bytes} B, ${session.heard} turn(s) heard); ` +
          `the device is left Idle and needs its wake word again`
      );
      ws.close();
      // The closing handshake is a courtesy on this transport — nothing on the device reads
      // the code — and a peer that does not answer it must not be able to keep the session,
      // or the decoder it holds, alive for `ws`'s own thirty seconds.
      closeGraceTimer = setTimeout(() => ws.terminate(), IDLE_CLOSE_GRACE_MS);
      closeGraceTimer.unref();
    }

    armIdleWindow(config.sessionIdleMs);

    section("device connected");
    log(`session ${session.id} device ${deviceId} path ${req.url}`);
    // The device's own identification travels on the connect headers. Logged in
    // full because they are cheap and their absence is the kind of thing that is
    // only noticed a week later — the credential itself is not, since it is
    // derived from the secret and the identifier logged above.
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === "authorization") continue;
      info(`  ${k}: ${v}`);
    }

    /**
     * Take the person's utterance to the platform, and speak the reply back (6.1).
     *
     * The frames are already decoded — the endpointer decoded each one to judge it
     * — so what arrives here is a WAV built from samples the bridge has held since
     * they arrived, and no part of the window is decoded twice (6.1, 6.7).
     */
    /**
     * Carry out a command the bridge answers itself, which is music and nothing else yet.
     *
     * Answers in the same shape `gadget.apply` does, because the reporting that follows it is one
     * place and one line: a command that did not take leaves the room as it was, which is where the
     * person already was, and the line is what an operator has to act on.
     */
    async function carryOutMusic(command: BridgeCommand): Promise<CommandOutcome> {
      if (command.task === "stop-music") {
        // A person asking a silent gadget to stop has been answered. Nothing playing is not a
        // failure, and there is no bracket to close — `stop()` says so itself.
        if (!playing) return { ok: true, detail: "nothing was playing" };
        playing = false;
        speaker.stop();
        return { ok: true, detail: "the music stopped" };
      }

      const chosen = await chooseMusic(command.query);
      if (!chosen.ok) return { ok: false, detail: chosen.detail };

      // Whatever was playing goes first: two tracks at once are two streams into one speaker, and
      // the person asked for this one rather than for both. Safe here, and only here, because this
      // turn spoke nothing — a command's turn is dropped before the platform answers it (4.1) — so
      // whatever bracket is open belongs to the track rather than to a reply.
      if (playing) speaker.stop();
      startTrack(chosen.track);
      return { ok: true, detail: `the track ${basename(chosen.track.path)}` };
    }

    /** The file a request names, decoded, or the reason there is none. */
    async function chooseMusic(query: string): Promise<{ ok: true; track: Track } | { ok: false; detail: string }> {
      const choice = await chooseTrack(config.musicDir, query);
      if (!choice.ok) return { ok: false, detail: choice.detail };
      const track = await decodeTrack(choice.path);
      if (track === null) {
        return { ok: false, detail: `${choice.path} is not a track this bridge can play` };
      }
      return { ok: true, track };
    }

    /**
     * Hand a track to the device's speaker.
     *
     * What is recorded here is that the bridge has music of its own playing — which is what the
     * wake word stops and what the device's next `listen start` clears. The bracket, the pacing and
     * the title on the display are the speaker's (`playTrack`), and they are the same for a track
     * as for a reply.
     */
    function startTrack(track: Track): void {
      playing = true;
      log(
        `playing ${basename(track.path)} — ${(track.samples.length / track.sampleRate).toFixed(1)}s ` +
          `at ${track.sampleRate}Hz, in one bracket (4.5)`
      );
      playTrack(speaker, track);
    }

    async function serveTurn(upload: { wav: Buffer | null; seconds: number; failed: number }): Promise<void> {
      if (!upload.wav) {
        // Every frame in the utterance failed to decode, so there is no audio to send
        // and nothing to transcribe. A turn is not sent, and the device is still able
        // to take the next one — it is in the same state it would have been in had the
        // person never spoken (6.3).
        err(
          `the utterance held nothing decodable (${upload.failed} frame(s)) — sending no turn ` +
            `rather than an empty one`
        );
        return;
      }

      turning = true;
      // A turn begins here, and this is the only place that says so: `spokeThisTurn` is an answer
      // about a turn, and a turn that opens no bracket — a command, dropped before the platform
      // answers it — would otherwise be told the turn before it spoke (4.1, requirement 4).
      speaker.beginTurn();
      const controller = new AbortController();
      turn = controller;
      /**
       * The command this turn turned out to be, or `null` for a turn that was a turn.
       *
       * It is set from inside `onUser`, because the transcript is the first moment a
       * command is knowable at all — the platform decodes the utterance and the bridge
       * has no recogniser of its own (D12) — and read after the turn has unwound, by
       * which point there is nothing left to say and a setting to change (4.1).
       */
      // What the person's utterance turned out to be, if it was a command at all. A holder rather
      // than a `let`: it is written from inside the turn's own callbacks and read once the turn
      // has unwound, and TypeScript follows a `let` no further than its initialiser — every later
      // read of one is `null`, and the branch that uses it is `never`.
      const taken: { command: SpokenCommand | null } = { command: null };
      /**
       * The track the model asked for in this turn, held until the turn has unwound.
       *
       * A call arrives while the platform is still streaming the reply, and the speaker is holding
       * one bracket for the turn: a track handed over inside the call would be minutes of audio
       * scheduled under sentences that have not been sent yet. Deciding here and playing afterwards
       * is what leaves the turn's own bracket to the turn — and the track starts as the reply's last
       * sentence does, since a track is handed to the same speaker that is already saying it.
       */
      const wanted: { track: Track | null } = { track: null };

      log(
        `turn from speech: ${upload.seconds.toFixed(2)}s of the person's own voice` +
          `${upload.failed ? `, ${upload.failed} frame(s) undecodable` : ""}`
      );

      // What the turn is asked with, so that "the conversation is the one it would
      // have been" is a thing an operator reads rather than infers (4.3). A command
      // is left out of the conversation before it is ever recorded, and a command
      // that had been recorded would appear here — as one more of the person's own
      // lines, since the turn it came from was dropped before the platform answered
      // anything and has no reply of its own to carry. Only the person's side is
      // printed: the replies are the model's prose, already counted by `turn ended`,
      // and a digest carrying them would be a paragraph in the middle of the log.
      // Read here as well as in `takeTurn` — this is where a turn is narrated, and
      // nothing between the two reads can change what the conversation holds.
      const history = services.conversations.history(deviceId);
      const asked = history
        .filter((message) => message.role === "user")
        .map((message) => `user ${JSON.stringify(message.content).slice(0, 80)}`);
      log(
        `turn asked with ${history.length} earlier message(s)` +
          `${asked.length === 0 ? "" : `: ${asked.join(" / ")}`}`
      );

      try {
        // What the gadget last reported about itself, read once per turn and not
        // held: a turn is asked with the condition as it stands, and a gadget that
        // reported nothing is asked for exactly the turn it would have been asked for
        // had none of this existed (2.2).
        const condition = gadget.condition();
        // The gadget's own catalogue, read per turn like the condition above and for the same
        // reason: it belongs to this session and is remembered nowhere, and a gadget that
        // reported none is asked for exactly the turn it would have been asked for otherwise.
        // The bridge's own tools sit beside it — its own, not the gadget's, and named so that the
        // model and the bridge's sink can both tell which of the two a name belongs to.
        const tools: TurnTool[] = [...gadget.tools(), ...musicTools(config.musicDir)];

    /**
     * Answer a call naming a tool the bridge owns, rather than forwarding it to the gadget.
     *
     * The answer is a `ToolCallOutcome` and not a `CommandOutcome`, because it is not going into
     * the log: it goes back to the platform as the result of the call, and the model speaks from it.
     * So a failure here is not a silent line for an operator — it is what lets the model say that
     * the track was not there instead of confidently announcing one that never plays.
     */
    async function answerMusicCall(call: ToolCallRequest): Promise<ToolCallOutcome> {
      const command = musicCommand(call.name, call.arguments);
      // A name under the bridge's own prefix that the bridge does not have. Reported rather than
      // passed down: the gadget never reported it, so asking the gadget would be asking it for
      // something it never said it had — and its refusal would be an answer to a different question.
      if (command === null) return { ok: false, message: `this bridge has no tool named ${call.name}` };

      if (command.task === "stop-music") {
        // Deliberately not `carryOutMusic`'s stop, which is `speaker.stop()`: that abandons the
        // frames of the *current* turn, and mid-call the current turn is this reply, still being
        // spoken. Nothing reaches here with a track actually playing — a track holds the listening
        // window shut, so the only utterance that opens a turn under one is the wake word, and that
        // has stopped it already (6.5) — and the flag is cleared rather than acted on.
        const stopped = playing;
        playing = false;
        return { ok: true, text: stopped ? "the music is stopped" : "nothing was playing" };
      }

      // Decided now, played once the turn has unwound. The answer the model is given has to be the
      // truth about the file, and handing the track over now would open a bracket that outlives the
      // reply — a track is minutes, and the sentences the platform has still to send have to be
      // spoken *into* the bracket the turn already owns rather than into a second one underneath it.
      const chosen = await chooseMusic(command.query);
      if (!chosen.ok) return { ok: false, message: chosen.detail };
      wanted.track = chosen.track;
      return {
        ok: true,
        text: `playing the track ${basename(chosen.track.path)} through the device's speaker`,
      };
    }

    const result = await takeTurn(
          config,
          services.catalog,
          services.conversations,
          deviceId,
          {
            language: config.language,
            audio: { filename: "turn.wav", contentType: "audio/wav", data: upload.wav },
            ...(condition !== null ? { gadgetCondition: condition } : {}),
            ...(tools.length > 0 ? { tools } : {}),
          },
          {
            onUser: (said) => {
              session.heard += 1;
              info(`platform transcribed the turn as ${JSON.stringify(said)}`);
              // What the device's display shows before the reply is heard (6.2). Taken
              // from the stream's own transcription rather than from a second one here,
              // because the platform is the thing that decodes the utterance (D12) and a
              // bridge that transcribed as well would be answering from different words
              // than it is about to speak to. A command reaches the display through this
              // same line and no other, which is what leaves the gadget naming what was
              // asked of it (requirement 4).
              if (said !== "") sendJson({ type: "stt", text: said });

              // The person may have been giving the gadget an instruction rather than
              // taking their turn. The turn stops here — the abort reaches the platform's
              // stream before it produces a reply, so nothing of its answer is spoken,
              // and the speaker's `finish()` will find a bracket that was never opened
              // (4.1, D8). The change itself is made once the turn has unwound, below.
              const command = matchCommand(config.language, said, { music: config.musicDir !== "" });
              if (command === null) return;
              taken.command = command;
              log(
                `the person's words are a command — asked for ${describeCommand(command)}; ` +
                  `answering it here and dropping the turn`
              );
              controller.abort();
            },
            onSentence: (sentence) => speaker.speak(sentence),
            // The platform's model asked for a gadget tool (4.5). The call is made here, over the
            // channel the handshake opened, and the answer is what the platform is holding its
            // stream open for. Nothing about it is fatal: a name the gadget never reported and a
            // gadget that does not answer are both a report the model can speak about, which is
            // what leaves the turn ending in speech rather than in silence.
            onToolCall: async (call) => {
              // The bridge's own tools first, and by the namespace rather than by a list of names:
              // a call the model makes to `bridge.*` is one no gadget reported and no gadget may be
              // asked for, including a name this bridge does not have — which is answered as the
              // failure it is, so the model can say so rather than being told the gadget refused it.
              if (call.name.startsWith(BRIDGE_TOOL_PREFIX)) {
                info(`platform asked for ${call.name}(${JSON.stringify(call.arguments)}) — the bridge's own`);
                const outcome = await answerMusicCall(call);
                if (outcome.ok) info(`${call.name}: ${outcome.text}`);
                else warn(`${call.name} was not answered: ${outcome.message}`);
                return outcome;
              }
              info(
                `platform asked for ${call.name}(${JSON.stringify(call.arguments)}) — calling the gadget`
              );
              const outcome = await gadget.call(call.name, call.arguments);
              if (outcome.ok) info(`gadget did ${call.name}: ${outcome.text}`);
              else warn(`gadget did not do ${call.name}: ${outcome.message}`);
              return outcome;
            },
            // The platform's remark about a turn it did not act on. Surfaced, and said
            // to the device rather than left in the log: an operator reading a log is
            // not who asked the question (4.4). The turn still ends in `finally`, which
            // is what leaves the device able to take the next one (6.3).
            onNotice: (notice) => {
              warn(
                `platform notice${notice.code ? ` ${notice.code}` : ""}: ${notice.message} ` +
                  `— ${session.heard ? "heard " + session.heard + " turn(s) already" : "nothing was heard in it"}`
              );
              sendJson({ type: "alert", status: "Notice", message: notice.message, emotion: "neutral" });
            },
            onError: (message) => {
              err(`platform refused the turn: ${message}`);
              sendJson({ type: "alert", status: "Error", message, emotion: "sad" });
            },
          },
          controller.signal
        );

        // A track the model asked for is handed over here, once the turn's own sentences have been
        // spoken into the bracket the turn owns. Nothing is reported after it: whether the music was
        // found was the answer to a call, and it has already been given (4.2).
        if (wanted.track !== null) startTrack(wanted.track);

        if (taken.command !== null) {
          // Requirement 2, and the only place in the session where a command is carried
          // out. Reported either way: a command that did not take leaves the gadget as it
          // was, which is where the person already was, and the line is what an operator
          // has to act on (D7). The turn ends with it rather than beside it, so the log
          // reads as one exchange and not as a turn followed by an unrelated change.
          const outcome =
            taken.command.decider === "gadget"
              ? await gadget.apply(taken.command.command)
              : await carryOutMusic(taken.command.command);
          if (outcome.ok) log(`command carried out: ${outcome.detail}`);
          else warn(`command not carried out: ${outcome.detail}`);
        } else if (!result.served) {
          // No persona answered, which is 3.4's miss rather than a failure of the turn.
          // The device has already been left in a state to take the next one.
          err(`turn not served: ${result.message}`);
        } else {
          log(
            `turn ended ${result.outcome.settled ? "settled" : "unsettled"}, ` +
              `${result.outcome.replyText.length} char(s) of reply, ` +
              `${(speaker.sessionMs() / 1000).toFixed(2)}s of audio sent this session`
          );
        }
      } catch (error) {
        err(`turn failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        // Always, whether the turn spoke or not: the bracket belongs to the turn, and
        // one left open parks the device in `speaking`, where it discards whatever the
        // person says next. This is also what arms the drain guard for the turn just
        // finished (6.6), and it is the only writer of `turning` — an `abort` that also
        // cleared it would be a second one, which is the shape D10 and D13 keep
        // recording.
        speaker.finish();
        if (turn === controller) turn = null;
        turning = false;
        // The reply has just stopped being heard, which is the likeliest moment for the
        // person to speak again. The window starts again from here rather than from when
        // the utterance closed, which may have been a long reply ago.
        sawPerson();
        // A turn the bridge said nothing for leaves the device exactly where it was: no
        // bracket was opened, so it never left `Listening`, and being already in the
        // state it would come back to, it never sends the `listen start` that opens the
        // next window. Without this, every frame the person speaks from here on is
        // counted and not judged — silence on their side of a session that looks
        // healthy — until something wakes the gadget and opens a window by another
        // route. The window is the bridge's own state (D9), so the bridge is the one to
        // reopen it: requirement 4 asks that a command leave the gadget able to take the
        // next turn rather than waiting for one. Read after `finish()`, which is where
        // the answer is fixed, and gated on the window being shut: a turn that *did*
        // speak is followed by the device's own `listen start`, and opening a second
        // window under that one would judge its opening audio against decisions already
        // taken in it (6.7).
        if (!session.listening && !speaker.spokeThisTurn()) {
          session.listening = true;
          listening.open();
          log(
            `no bracket was opened for that turn — the window is open again, since the ` +
              `device never left Listening and will not send a listen start (requirement 4)`
          );
        }
      }
    }

    /** A text message to the device, from a path that has no socket of its own. */
    function sendJson(message: Record<string, unknown>): boolean {
      if (ws.readyState !== OPEN) return false;
      ws.send(JSON.stringify({ session_id: session.id, ...message }));
      return true;
    }

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const wire = Buffer.from(data as ArrayBuffer);
        session.frames += 1;
        session.bytes += wire.length;

        // 6.6 — the tail of the bridge's own voice. The device reopens its microphone
        // before its speaker stops and reports that it is listening while it does, so
        // between the end of a reply and the bridge's own estimate of when its audio
        // has finished playing, what comes back is the speaker. An energy test cannot
        // separate the two (5–8k RMS of echo against 19–24k of speech), so this is a
        // deadline rather than a threshold, and it is the turn's own deadline. The
        // whole of what the input path does with it is this comparison (D10).
        const drainingUntil = speaker.drainingUntil();
        if (drainingUntil !== null && clock() < drainingUntil) {
          session.drained += 1;
          if (session.drained === 1) {
            info(
              `dropping input until ${((drainingUntil - clock()) / 1000).toFixed(2)}s from now — ` +
                `the device is still playing this bridge's own audio (6.6)`
            );
          }
          draining = true;
          return;
        }
        if (draining) {
          // The drain window has ended, so the endpointer's clock restarts here (6.6).
          // Without this the no-speech giveup would count the drained seconds as part
          // of a window the person was never given a chance to speak into, and a quiet
          // person would be given up on before they opened their mouth.
          draining = false;
          info(`drain window over after ${session.drained} frame(s) — restarting the endpointer's clock`);
          listening.open();
        }

        if (!session.listening) {
          // A frame outside a window is not judged and not kept: there is no turn it
          // could close, and the endpointer's floor estimate would be built from a
          // room the person is not in. Counted all the same, because "the device is
          // sending audio we are not judging" and "the device is sending nothing" are
          // different problems and the log has to tell them apart.
          if (session.frames === 1 || session.frames % 25 === 0) {
            info(
              `binary x${session.frames} (${wire.length} B, total ${session.bytes} B) — ` +
                `no listening window is open (D9); counted, not judged`
            );
          }
          return;
        }

        const verdict = listening.frame(wire);
        if (verdict === "turn") {
          // The unambiguous evidence of a person: the endpointer heard an utterance and
          // closed it. A `giveup` is not the same thing and is deliberately not counted —
          // an empty room produces one every `vadNoSpeechMs` (see the idle window above).
          sawPerson();
          // Snapshot, then clear, then act — in that order and all of it synchronously.
          // `open()` is what stops the decision re-firing: a state left reading `turn`
          // re-fires on every frame that follows, once per 60 ms for as long as the
          // microphone stays open, which the rig measured in run 4. Nothing async may
          // happen between the verdict and the clear, or a frame that arrives in
          // between would decide the same turn a second time (6.4).
          const upload = listening.upload();
          listening.open();
          session.listening = false;
          void serveTurn(upload);
        } else if (verdict === "giveup") {
          // Nobody spoke into this window. No turn, and a fresh window so the person
          // who has not spoken yet still can (6.3, 6.4).
          listening.open();
        } else if (session.frames % 25 === 0) {
          info(`binary x${session.frames} (${wire.length} B, total ${session.bytes} B) — listening`);
        }
        return;
      }

      const msg = parseClientMessage(data.toString());
      if (!msg) {
        warn(`unparsable text frame: ${data.toString().slice(0, 200)}`);
        return;
      }
      info(`<- ${JSON.stringify(msg).slice(0, 240)}`);

      if (isHello(msg)) {
        const ap = msg.audio_params ?? {};
        log(
          `client hello: version=${msg.version} transport=${msg.transport} ` +
            `format=${ap.format} rate=${ap.sample_rate} ch=${ap.channels} frame=${ap.frame_duration}ms ` +
            `features=${JSON.stringify(msg.features ?? {})}`
        );
        ws.send(JSON.stringify(serverHello(session.id, config)));
        log(`server hello sent (opus ${config.serverRate} Hz / ${config.frameMs} ms, framing v${config.framing})`);
        // The gadget advertised its own controls, so the bridge asks what they are (1.1)
        // and what condition it is in (2.1). Asked here, once, and awaited by nothing: a
        // gadget that never answers leaves this session running exactly as it would have
        // (D4).
        if (advertisesTools(msg.features)) {
          log(`device advertises MCP — asking what it can be asked to do (1.1)`);
          void gadget.start();
        }
        return;
      }

      if (isListen(msg)) {
        if (msg.state === "start") {
          // The device says it is listening again, which in `mode: auto` is the moment after its
          // speaker stopped — so a track that was playing has finished, or was stopped. This is the
          // only signal that says so, and it arrives because the bracket closed rather than because
          // anyone decided anything.
          if (playing) {
            playing = false;
            log("the device is listening again — the track has finished");
          }
          session.listening = true;
          // A window opens from nothing: the frames, the verdicts and the endpointer
          // together, or the previous window's decisions are judged against this one's
          // opening audio (6.7). A `listen start` that arrives while a reply is still
          // playing opens a window too — the frames it brings are dropped by the drain
          // guard above until the bridge's audio is over.
          listening.open();
          log(
            `listen start (mode=${msg.mode ?? "?"}) — a window is open; ` +
              `the bridge decides when the turn ends (6.4)`
          );
        } else {
          session.listening = false;
          // The device does not normally send this (D9), so it is not a signal to act
          // on — closing the window here would cut off a person who is still speaking.
          // It is logged because the one firmware that does send it is a change worth
          // knowing about.
          log(`listen stop — the device does not normally send this (D9); the window stays open`);
        }
        return;
      }

      if (isAbort(msg)) {
        // The wake word cancelled the turn (6.5). What is cancelled is the **source**:
        // the signal reaches the platform request, so a turn still being produced stops,
        // and a reply mid-speech stops being transcribed into frames. What is deliberately
        // *not* done is anything to the device — the firmware sends this from
        // `HandleWakeWordDetectedEvent` and leaves `Speaking` itself, gating incoming
        // audio on that state, so it has already silenced its own speaker. There is no
        // `tts stop` to send into a state the device has left, and `turning` is cleared by
        // the turn's own `finally` rather than by a second writer here.
        log(`abort (reason=${msg.reason ?? "none"}) — cancelling the turn${turn ? "" : " (nothing in flight)"}`);
        turn?.abort();
        // What is playing may be a track rather than a turn, and it is stopped the same way: the
        // frames already on the clock are abandoned and the device is told to stop (`speech.ts`).
        // A no-op for a reply, whose own turn is what was just cancelled.
        if (playing) {
          playing = false;
          speaker.stop();
          log("the wake word stopped the music");
        }
        // The wake word is a person saying something, and it is the one act that reaches
        // here without a turn to carry it.
        sawPerson();
        // The wake word's own Opus is streamed *before* the abort (the firmware's
        // `docs/websocket.md` says so), and a short voiced burst closing into silence is
        // exactly what the endpointer closes a turn on — so the window the wake word was
        // heard in is discarded rather than left to become a turn from the name the
        // device was just called by.
        listening.open();
        session.listening = false;
        return;
      }

      if (isMcp(msg)) {
        // A reply to something the bridge asked the gadget. Anything else on this
        // channel is the gadget speaking first, which it has no path to do (D1) — so a
        // payload nothing is waiting for is logged rather than dispatched, since
        // acting on a message nobody asked for is the one thing this direction of the
        // protocol never means.
        if (!gadget.receive(msg.payload)) info(`mcp payload with no request waiting for it: ${JSON.stringify(msg.payload).slice(0, 160)}`);
        return;
      }

      info(`${msg.type} message ignored — not modelled in the skeleton (D8)`);
    });

    ws.on("close", (code) => {
      section("device disconnected");
      log(
        `session ${session.id} device ${deviceId} code ${code}; ${session.frames} frame(s), ` +
          `${session.bytes} B, ${session.drained} dropped as our own audio`
      );
      // The window goes with the socket, WASM memory and all (6.7).
      listening.close();
      if (idleTimer !== null) clearTimeout(idleTimer);
      if (closeGraceTimer !== null) clearTimeout(closeGraceTimer);
    });
    ws.on("error", (e) => err(`socket: ${e.message}`));
  });

  return wss;
}

/** A header, as a single string. Node lower-cases header names and repeats a
 * repeated header as an array; neither is useful to a credential check. */
function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : value?.[0];
}
