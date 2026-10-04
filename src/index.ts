import { loadConfig } from "./config.js";
import { allowedDeviceCount } from "./credentials.js";
import { log, warn } from "./log.js";
import { createOtaServer } from "./server/ota.js";
import { createWsServer } from "./server/ws.js";

/**
 * The service: the OTA endpoint and the device socket, and nothing else yet.
 *
 * Started together because they are useless apart — a device that cannot reach
 * OTA never connects, and one that connects without OTA never finds the address —
 * and because the two together are what "the bridge is running" means.
 */

// Node 22 reads the file itself, so `npm start`, `npm run dev` and a bare
// `node --import tsx src/index.ts` all behave the same and none of them needs a
// shell flag. Absent, every value but the device secret has a default, and the
// secret reports its own absence better than this could.
try {
  process.loadEnvFile();
} catch {
  // No .env beside the service. Not an error on its own.
}

const config = loadConfig();

createOtaServer(config);
createWsServer(config);

const wsUrl = `ws://${config.publicHost}:${config.wsPort}/xiaozhi/v1/`;

console.log(
  `\nadaptive-interview-bridge\n` +
    `  ota      http://${config.publicHost}:${config.otaPort}/xiaozhi/ota/\n` +
    `  ws       ${wsUrl}\n` +
    `  framing  v${config.framing}\n` +
    `  downlink ${config.serverRate} Hz / ${config.frameMs} ms\n` +
    `  devices  ${allowedDeviceCount(config)} allowed\n` +
    `  platform token held, never sent to a device\n`
);

// The things an operator must not have to infer, said out loud at every start.
// Neither secret is ever printed. The platform's is named as held and not shown:
// that the bridge has it while a device does not is the whole of 2.3, and it is
// the one fact about this service a reader of the output should take away.
if (allowedDeviceCount(config) === 0) {
  warn(
    `NOTE no devices are allowed: BRIDGE_ALLOWED_DEVICES is empty, and an empty allowlist allows ` +
      `nobody. Every device will be refused at OTA and at the socket until one is named.`
  );
}
warn(
  `NOTE the allowlist trusts the Device-Id a device declares, which is a header the client sets. ` +
    `It keeps out a device this bridge was not told about; it does not keep out someone who ` +
    `knows the identifier of a device it was.`
);
log(
  `NOTE a device that connects will handshake and then hear nothing: the persona (3.x), the turn ` +
    `(4.x), the speech (5.x) and the endpointer (6.x) are not implemented yet.`
);
