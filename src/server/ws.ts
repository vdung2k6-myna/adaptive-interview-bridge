import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { BridgeConfig } from "../config.js";
import { authorizeDevice, describeDenial } from "../credentials.js";
import { err, info, log, section, warn } from "../log.js";
import { isAbort, isHello, isListen, parseClientMessage, serverHello } from "../protocol/messages.js";

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
 * Everything after the handshake — the persona (3.x), the turn (4.x), speech in
 * both directions (5.x, 6.x) — is deliberately absent rather than half-present,
 * and says so when it happens. A bridge that silently accepts audio it cannot
 * turn into anything looks, from a log, exactly like one whose endpointer is
 * broken.
 */
interface DeviceRequest extends IncomingMessage {
  /** Set by the upgrade check, read by the session. The authenticated identity. */
  bridgeDeviceId?: string;
}

export function createWsServer(config: BridgeConfig): WebSocketServer {
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
        return;
      }

      if (isAbort(msg)) {
        log(`abort (reason=${msg.reason ?? "none"}) — nothing is speaking yet, so nothing to cancel (6.5)`);
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
