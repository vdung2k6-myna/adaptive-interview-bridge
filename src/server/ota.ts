import http from "node:http";
import type { BridgeConfig } from "../config.js";
import { deriveToken, isAllowedDevice } from "../credentials.js";
import { info, log, warn } from "../log.js";

/**
 * The OTA endpoint — where a device is told to connect, and where it is given
 * the credential it will connect with.
 *
 * This is the only way a device learns the WebSocket address, and it is asked
 * before anything else can work: a bridge that does not answer here is
 * indistinguishable, from the device's side, from one that is not running, and
 * the device reports it as a network failure rather than as our absence.
 *
 * It is also the first gate. A device this bridge was not told about gets no
 * token here, which means it never reaches the socket either — and unlike the
 * socket, an unauthenticated endpoint that silently hands out credentials would
 * make the allowlist worth nothing, so a refusal is a refusal here too.
 *
 * The token is derived rather than stored (`credentials.ts`), so the answer is
 * the same on every boot and a restart does not rotate every device's credential.
 */
export function createOtaServer(config: BridgeConfig): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://bridge");

    if (url.pathname === "/xiaozhi/ota/" || url.pathname === "/xiaozhi/ota") {
      const deviceId = req.headers["device-id"];
      log(
        `OTA ${req.method} ${url.pathname} device=${deviceId ?? "?"} ` +
          `client=${req.headers["client-id"] ?? "?"} activation=${req.headers["activation-version"] ?? "?"}`
      );

      if (typeof deviceId !== "string" || deviceId.trim() === "") {
        // The identifier is now load-bearing: it is what the token is derived
        // from, so a request without one cannot be answered with a credential.
        warn("OTA refused: no Device-Id header, and a token is issued per device");
        refuse(res, "Device-Id header is required");
        return;
      }

      if (!isAllowedDevice(config, deviceId)) {
        warn(
          `OTA refused ${deviceId}: not in BRIDGE_ALLOWED_DEVICES — no token issued, so this device ` +
            `cannot connect either. Add it to the allowlist to provision it.`
        );
        refuse(res, "device not registered with this bridge");
        return;
      }

      const now = new Date();
      const payload = {
        websocket: {
          url: `ws://${config.publicHost}:${config.wsPort}/xiaozhi/v1/`,
          token: deriveToken(config.deviceSecret, deviceId),
          version: config.framing,
        },
        server_time: {
          timestamp: Date.now(),
          timezone_offset: -now.getTimezoneOffset(),
        },
      };
      // The token is not logged. It is recoverable from the secret and the
      // identifier, so a log line is one more place a credential lives for no
      // gain — the identifier is what an operator reads.
      log(`-> 200 websocket ws://${config.publicHost}:${config.wsPort}/xiaozhi/v1/ (token issued to ${deviceId})`);
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
          `downlink ${config.serverRate} Hz / ${config.frameMs} ms\n` +
          `devices  ${config.allowedDevices.length} allowed\n`
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

/**
 * A refusal the device can only read as a failure, which is what it is: the
 * firmware treats anything but 200 as an unreachable server and retries with a
 * backoff, and its operator sees a device that will not come up. The body says
 * what an operator needs and nothing a caller could act on — in particular it
 * never says whether the identifier was close.
 */
function refuse(res: http.ServerResponse, reason: string): void {
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: reason }));
}
