import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { BridgeConfig } from "../config.js";
import { takeTurn, type Conversations } from "../conversation.js";
import { authorizeDevice, describeDenial } from "../credentials.js";
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
 * Speech to the device lives here rather than in a module of its own because it
 * is not separable from the socket: the `tts` bracket that decides whether the
 * device plays anything at all is a property of one connection's speaking state,
 * and `speech.ts` is where that state is kept, next to the frames it qualifies.
 * Speech *from* the device is still absent, and still says so — its frames are
 * counted and named as 6.1's rather than quietly accepted, because a bridge that
 * takes audio it cannot turn into anything looks, from a log, exactly like one
 * whose endpointer is broken.
 *
 * With `BRIDGE_VERIFY_TEXT` set, a `listen start` makes the bridge take a turn of
 * its own text instead of waiting for speech that nothing can yet turn into a
 * turn. That is scaffolding, documented as such where it is configured, and a
 * deployment leaves it unset.
 */
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
      listening: false,
    };
    // The device's voice, for the life of the socket: the speaking state the
    // bracket controls belongs to this connection and to no other.
    const speaker = createSpeaker(ws, config);
    // One turn at a time per device. A `listen start` arriving while a reply is
    // still playing is either a person talking over it or the echo of a wake word
    // (6.5); neither is a second turn, and starting one would talk over a reply
    // that is still being heard.
    let turning = false;

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
     * The scaffolding turn (§5). Sends the configured text as a turn and speaks
     * whatever comes back through the ordinary path, so 5.1–5.5 are exercised
     * against a real device before any of §6 exists. With no `verifyText` it does
     * nothing at all, and `listen start` is only logged.
     */
    async function verifyTurn(): Promise<void> {
      const text = config.verifyText;
      if (text === undefined || turning) return;
      turning = true;
      log(
        `verify turn: taking a turn from BRIDGE_VERIFY_TEXT, not from a person — scaffolding for §5`
      );
      try {
        const result = await takeTurn(
          config,
          services.catalog,
          services.conversations,
          deviceId,
          { language: config.language, text },
          {
            onUser: (said) => info(`platform transcribed the turn as ${JSON.stringify(said)}`),
            onSentence: (sentence) => speaker.speak(sentence),
            // The platform's own remarks are surfaced but not yet relayed to the
            // device: what to tell it, and how it recovers, is 4.4, and this
            // scaffolding is not the place to decide it.
            onNotice: (notice) =>
              warn(
                `platform notice${notice.code ? ` ${notice.code}` : ""}: ${notice.message} ` +
                  `(relaying it is 4.4)`
              ),
            onError: (message) => err(`platform refused the turn: ${message} (relaying it is 4.4)`),
          }
        );

        if (!result.served) {
          err(`verify turn not served: ${result.message}`);
        } else {
          log(
            `verify turn ended ${result.outcome.settled ? "settled" : "unsettled"}, ` +
              `${result.outcome.replyText.length} char(s) of reply, ` +
              `${(speaker.sentMs() / 1000).toFixed(2)}s of audio sent`
          );
        }
      } catch (error) {
        err(`verify turn failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        // Always, whether the turn spoke or not: the bracket belongs to the turn,
        // and one left open parks the device in `speaking`, where it discards
        // whatever the person says next.
        speaker.finish();
        turning = false;
      }
    }

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // Received, counted, and otherwise unused until the turn exists (6.1).
        // Counted rather than dropped silently: "the device is sending audio and
        // we are doing nothing with it" and "the device is sending nothing" are
        // very different problems, and the log has to tell them apart.
        const b = Buffer.from(data as ArrayBuffer);
        session.frames += 1;
        session.bytes += b.length;
        if (session.frames === 1 || session.frames % 25 === 0) {
          info(
            `binary x${session.frames} (${b.length} B, total ${session.bytes} B) — ` +
              `${session.listening ? "listening" : "NOT listening"}; turns are task 6.1`
          );
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
        session.listening = msg.state === "start";
        log(
          `listen ${msg.state} (mode=${msg.mode ?? "?"}) — ` +
            `${msg.state === "start" ? "the bridge must decide when the turn ends (6.4)" : "the device does not normally send this (D9)"}`
        );
        // The device has opened its microphone. With a verify text configured
        // that is the trigger to take a turn from it rather than from a person;
        // otherwise there is nothing yet that a `listen start` could start.
        if (msg.state === "start") void verifyTurn();
        return;
      }

      if (isAbort(msg)) {
        log(`abort (reason=${msg.reason ?? "none"}) — nothing to cancel yet (6.5)`);
        return;
      }

      info(`${msg.type} message ignored — not modelled in the skeleton (D8)`);
    });

    ws.on("close", (code) => {
      section("device disconnected");
      log(`session ${session.id} device ${deviceId} code ${code}; ${session.frames} frame(s), ${session.bytes} B`);
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
