import http from "node:http";
import type { BridgeConfig } from "../config.js";
import { info, log, warn } from "../log.js";

/**
 * The OTA endpoint — where a device is told to connect.
 *
 * This is the only way a device learns the WebSocket address, and it is asked
 * before anything else can work: a bridge that does not answer here is
 * indistinguishable, from the device's side, from one that is not running, and
 * the device reports it as a network failure rather than as our absence. So the
 * endpoint answers even while the rest of the service is a skeleton.
 *
 * The response also carries the token the device presents on connect. Issuing a
 * token per device is task 2.2; until then this hands out the single configured
 * token, which is exactly what D6 says a finished bridge must not do. It is
 * stated here rather than left to be discovered, and the README repeats it.
 */
export function createOtaServer(config: BridgeConfig): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://bridge");

    if (url.pathname === "/xiaozhi/ota/" || url.pathname === "/xiaozhi/ota") {
      log(
        `OTA ${req.method} ${url.pathname} device=${req.headers["device-id"] ?? "?"} ` +
          `client=${req.headers["client-id"] ?? "?"} activation=${req.headers["activation-version"] ?? "?"}`
      );
      // The device identifies itself on this request; a device that does not is
      // either not the thing this bridge is for, or a firmware variant that needs
      // its own handling. Either way it is worth a line now, not a diagnosis later.
      if (!req.headers["device-id"]) warn("OTA request carried no Device-Id header");

      const now = new Date();
      const payload = {
        websocket: {
          url: `ws://${config.publicHost}:${config.wsPort}/xiaozhi/v1/`,
          token: config.token,
          version: config.framing,
        },
        server_time: {
          timestamp: Date.now(),
          timezone_offset: -now.getTimezoneOffset(),
        },
      };
      info(`-> ${JSON.stringify(payload)}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(
        `adaptive-interview-bridge\n` +
          `ota      http://${config.publicHost}:${config.otaPort}/xiaozhi/ota/\n` +
          `ws       ws://${config.publicHost}:${config.wsPort}/xiaozhi/v1/\n` +
          `framing  v${config.framing}\n` +
          `downlink ${config.serverRate} Hz / ${config.frameMs} ms\n`
      );
      return;
    }

    // A device asking for something this bridge does not serve is the beginning
    // of a firmware difference, and a silent 404 leaves no trace of which path it
    // wanted. The rig that preceded this service learned that the hard way.
    warn(`OTA 404 ${req.method} ${url.pathname}`);
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found\n");
  });

  server.on("error", (e) => warn(`ota server: ${e.message}`));
  server.listen(config.otaPort, "0.0.0.0", () =>
    log(`OTA  listening on http://${config.publicHost}:${config.otaPort}/xiaozhi/ota/`)
  );
  return server;
}
