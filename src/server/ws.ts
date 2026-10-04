import { WebSocketServer, type WebSocket } from "ws";
import type { BridgeConfig } from "../config.js";
import { err, info, log, section, warn } from "../log.js";
import { isAbort, isHello, isListen, parseClientMessage, serverHello } from "../protocol/messages.js";

/**
 * The device's socket.
 *
 * A connection is a session for as long as it lasts, and the one thing that has
 * to work today is the handshake: the hello exchange that ends the connect on the
 * device's side. Everything after it — credentials (2.2), the persona (3.x), the
 * turn (4.x), speech in both directions (5.x, 6.x) — is deliberately absent
 * rather than half-present, and says so when it happens. A bridge that silently
 * accepts audio it cannot turn into anything looks, from a log, exactly like one
 * whose endpointer is broken.
 *
 * Credentials are not verified here. Task 2.2 owns that, and until it lands the
 * Authorization header is logged and any mismatch is called out loudly, so a
 * device that should not be connecting is visible in the log even though it is
 * not refused.
 */
export function createWsServer(config: BridgeConfig): WebSocketServer {
  const wss = new WebSocketServer({ port: config.wsPort });

  wss.on("listening", () =>
    log(`WS   listening on ws://${config.publicHost}:${config.wsPort}/xiaozhi/v1/ (any path accepted)`)
  );
  wss.on("error", (e) => err(`ws server: ${e.message}`));

  wss.on("connection", (ws: WebSocket, req) => {
    const session = {
      id: `s${Date.now().toString(36)}`,
      frames: 0,
      bytes: 0,
      listening: false,
    };

    section("device connected");
    log(`session ${session.id} path ${req.url}`);
    // The device's own identification travels on the connect headers, and they
    // are the only place the bridge learns which device this is until 2.2 issues
    // it something. Logged in full because they are cheap and their absence is
    // the kind of thing that is only noticed a week later.
    for (const [k, v] of Object.entries(req.headers)) info(`  ${k}: ${v}`);

    const auth = req.headers["authorization"] ?? "";
    if (auth !== `Bearer ${config.token}`) {
      warn(
        `unexpected Authorization (${JSON.stringify(auth)}), expected "Bearer <BRIDGE_TOKEN>" — ` +
          `accepting anyway, because credentials are task 2.2 and nothing checks them yet`
      );
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
      log(`session ${session.id} code ${code}; ${session.frames} frame(s), ${session.bytes} B`);
    });
    ws.on("error", (e) => err(`socket: ${e.message}`));
  });

  return wss;
}
