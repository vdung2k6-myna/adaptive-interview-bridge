import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { createOtaServer } from "./server/ota.js";
import { createWsServer } from "./server/ws.js";

/**
 * The service: the OTA endpoint and the device socket, and nothing else yet.
 *
 * Started together because they are useless apart — a device that cannot reach
 * OTA never connects, and one that connects without OTA never finds the address —
 * and because the two together are what "the bridge is running" means.
 */
const config = loadConfig();

createOtaServer(config);
createWsServer(config);

const wsUrl = `ws://${config.publicHost}:${config.wsPort}/xiaozhi/v1/`;

console.log(
  `\nadaptive-interview-bridge\n` +
    `  ota      http://${config.publicHost}:${config.otaPort}/xiaozhi/ota/\n` +
    `  ws       ${wsUrl}\n` +
    `  token    ${config.token}\n` +
    `  framing  v${config.framing}\n` +
    `  downlink ${config.serverRate} Hz / ${config.frameMs} ms\n`
);

// Two things an operator must not have to infer, said out loud at every start.
log(
  `NOTE credentials are NOT verified (task 2.2): any device that can reach this port is accepted. ` +
    `Do not expose it beyond the LAN it is being developed on.`
);
log(
  `NOTE a device that connects will handshake and then hear nothing: the turn (4.x), the speech ` +
    `(5.x) and the endpointer (6.x) are not implemented yet.`
);
