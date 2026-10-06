import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { BridgeConfig } from "../config.js";
import { takeTurn, type Conversations } from "../conversation.js";
import { authorizeDevice, describeDenial } from "../credentials.js";
import { createListening } from "../listening.js";
import { err, info, log, section, warn } from "../log.js";
import type { PersonaCatalog } from "../personas.js";
import { isAbort, isHello, isListen, parseClientMessage, serverHello } from "../protocol/messages.js";
import { createSpeaker } from "../speech.js";

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
      const controller = new AbortController();
      turn = controller;
      log(
        `turn from speech: ${upload.seconds.toFixed(2)}s of the person's own voice` +
          `${upload.failed ? `, ${upload.failed} frame(s) undecodable` : ""}`
      );

      try {
        const result = await takeTurn(
          config,
          services.catalog,
          services.conversations,
          deviceId,
          {
            language: config.language,
            audio: { filename: "turn.wav", contentType: "audio/wav", data: upload.wav },
          },
          {
            onUser: (said) => {
              session.heard += 1;
              info(`platform transcribed the turn as ${JSON.stringify(said)}`);
              // What the device's display shows before the reply is heard (6.2). Taken
              // from the stream's own transcription rather than from a second one here,
              // because the platform is the thing that decodes the utterance (D12) and a
              // bridge that transcribed as well would be answering from different words
              // than it is about to speak to.
              if (said !== "") sendJson({ type: "stt", text: said });
            },
            onSentence: (sentence) => speaker.speak(sentence),
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

        if (!result.served) {
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
        return;
      }

      if (isListen(msg)) {
        if (msg.state === "start") {
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
        // The wake word's own Opus is streamed *before* the abort (the firmware's
        // `docs/websocket.md` says so), and a short voiced burst closing into silence is
        // exactly what the endpointer closes a turn on — so the window the wake word was
        // heard in is discarded rather than left to become a turn from the name the
        // device was just called by.
        listening.open();
        session.listening = false;
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
