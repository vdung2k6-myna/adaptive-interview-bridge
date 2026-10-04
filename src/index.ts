import { loadConfig } from "./config.js";
import { allowedDeviceCount } from "./credentials.js";
import { err, log, warn } from "./log.js";
import { boundPersona, createPersonaCatalog, turnFieldsFor, unresolvedBindings } from "./personas.js";
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
// shell flag. Absent, every value has a default except the three that refuse to
// have one on purpose — the two credentials and the platform's address — and each
// of those reports its own absence better than this could.
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
    `  devices  ${allowedDeviceCount(config)} allowed, ${config.devicePersonas.size} bound\n` +
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
// The catalog, read once at start and cached (3.1). Printed after the banner
// rather than before it, so a slow platform delays a log line and never the
// statement that the service is listening.
//
// A failure here is logged and not fatal. The platform being briefly unavailable
// when the bridge boots is an ordering problem, and one the deployment plan
// already names — platform reachable, then the bridge — rather than a reason to
// make a bridge restart the only recovery. Nothing is served either way: an
// empty cache resolves no binding, and 3.3 re-reads before a device is declined.
// What must not happen is silence, so the failure is said out loud and names
// where the read was aimed.
const catalog = createPersonaCatalog(config);
try {
  await catalog.refresh();
  log(`NOTE persona catalog: ${catalog.all().length} personas read from ${config.platformUrl}`);
} catch (error) {
  err(
    `persona catalog could not be read at start from ${config.platformUrl}: ` +
      `${error instanceof Error ? error.message : String(error)}`
  );
  warn(
    `NOTE no personas are cached, so no device can be bound to one. The catalog is re-read on a ` +
      `binding the cache does not hold (3.3); until then the platform being unreachable is why.`
  );
}

// The bindings, resolved against the catalog just read (3.2). One line per
// device, because this is the whole of what a gadget's character is: which
// persona it speaks as, and therefore which three turn fields it will carry. The
// count of topics is printed rather than the topics themselves — the interesting
// fact at start is whether the persona resolved and whether it scopes any search
// at all, and a persona with no topics is a valid one that never reads material.
//
// A binding the catalog does not report is a warning, not a refusal: the catalog
// is live and this read is one moment of it, so a persona added on the platform
// minutes after the bridge came up would otherwise be a reason not to run. It is
// said out loud all the same, because until 3.3 re-reads and the miss resolves,
// the device it names would be answered as nobody — which is the requirement's
// own behaviour ("SHALL NOT be answered as a different persona") and not
// something to paper over with a default here.
const personas = catalog.all();
for (const [device, personaId] of config.devicePersonas) {
  const persona = boundPersona(personaId, personas);
  if (persona === undefined) continue;
  const fields = turnFieldsFor(persona);
  log(
    `NOTE device ${device} speaks as ${persona.id} (${persona.label}): ${fields.enabledTopics.length} ` +
      `topic(s), answer mode ${fields.answerMode}`
  );
}
for (const [device, personaId] of unresolvedBindings(config.devicePersonas, personas)) {
  warn(
    `NOTE device ${device} is bound to persona ${personaId}, which the catalog does not report. The ` +
      `catalog is re-read before this device is declined (3.3); as this read stands, it would answer as nobody.`
  );
}

log(
  `NOTE a device that connects will handshake and then hear nothing: its persona is bound and resolved ` +
    `(3.2), but the turn (4.x), the speech (5.x) and the endpointer (6.x) are not implemented yet.`
);
