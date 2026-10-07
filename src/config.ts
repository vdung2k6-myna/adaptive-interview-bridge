import { normalizeDeviceId } from "./credentials.js";
import { localIp } from "./net/local-ip.js";
import type { FramingVersion } from "./protocol/framing.js";
import type { TurnLanguage } from "./turn.js";

/**
 * Everything the bridge reads from its environment, read once at start.
 *
 * Deliberately only what the service uses. A skeleton that accepts configuration
 * for features it does not have is a skeleton whose operator believes those
 * features are on; the platform's address is added by the task that first calls
 * it (3.1, the persona catalog), with the code that consumes it, and every later
 * platform call reuses it. The platform *credential* is held from 2.3 rather than
 * alongside that address, because keeping that secret on the bridge and off the
 * device is what 2.3 is about, not a later task's business.
 *
 * A malformed value throws rather than falling back: a bridge quietly listening
 * on a different port than the device was told is a bridge nobody can find.
 */
export interface BridgeConfig {
  /** Where the device asks for OTA. */
  otaPort: number;
  /** Where the device connects afterwards. */
  wsPort: number;
  /** The address named in the OTA response — one the device can route to. */
  publicHost: string;
  /**
   * The secret every device token is derived from (`credentials.ts`). It is the
   * one secret in this service that must never be on a device, and the whole of
   * what an attacker would need to connect as any device on the allowlist.
   */
  deviceSecret: string;
  /** The devices this bridge will issue a token to, normalized for comparison. */
  allowedDevices: string[];
  /**
   * Which persona each device speaks as, normalized Device-Id → persona id, read
   * from `BRIDGE_DEVICE_PERSONAS`. Every device the allowlist names is in here:
   * a device that may connect and has no persona could never be answered, so the
   * two lists are required to describe the same devices (see `requireBindings`).
   */
  devicePersonas: ReadonlyMap<string, string>;
  /**
   * Where the platform is, as a base URL with no trailing slash — the address
   * every server-to-server call is joined onto. Read from `BRIDGE_PLATFORM_URL`.
   */
  platformUrl: string;
  /**
   * The platform's own credential (`API_AUTH_TOKEN`), held so the bridge can
   * call the platform on a device's behalf. It is the other half of the boundary
   * `deviceSecret` starts: that one must never be on the platform, this one must
   * never be on a device, and nothing this service sends to a device reads it.
   */
  apiAuthToken: string;
  /** The binary framing version both directions use. */
  framing: FramingVersion;
  /** The sample rate the server declares it will send, in Hz. */
  serverRate: number;
  /** The frame length the server declares it will send, in ms. */
  frameMs: number;
  /**
   * How many earlier turns of a device's conversation its next turn carries. The
   * endpoint keeps no conversation of its own (D2), so the bridge holds one per
   * gadget — and holds no more than this (4.3).
   *
   * The platform trims this same history a second time, to its own
   * `VOICE_AGENT_MAX_HISTORY` exchanges, keeping the most recent. The default here
   * matches that one, so what the bridge sends is what the platform would have kept
   * anyway; raising one without the other only grows a request body that is about
   * to be cut. The platform also appends the current turn to what it is sent, so a
   * turn's history is one exchange shorter than this on the wire.
   */
  historyTurns: number;
  /**
   * The language this deployment's gadget is set to, declared on every turn it
   * takes (D12). The platform decodes the utterance in the language the turn
   * names rather than detecting one, and reads an absent value as English, so
   * this is a property of the deployment and not of the audio: a Vietnamese
   * gadget whose turns omitted it would transcribe clean Vietnamese into a
   * foreign script while looking, from the bridge's side, exactly like one that
   * was told to.
   *
   * Read from `BRIDGE_LANGUAGE`; anything that is not the two words the endpoint
   * accepts throws, because a typo here fails silently in exactly the way above.
   */
  language: TurnLanguage;
  /**
   * How far one relative command moves a setting — "giảm âm lượng", "sáng hơn" —
   * in the units the setting is measured in, 0 to 100 (D6). Read from
   * `BRIDGE_COMMAND_STEP`.
   *
   * A configuration value rather than a constant in the matcher, for the reason
   * the endpointer's thresholds are: it is a feel. Ten points is a nudge a person
   * can hear and a screen a person can see, and whether it is the right nudge is
   * settled by ear rather than by argument — which is only possible if it is not
   * a literal in the code that would have to be rebuilt to try another.
   */
  commandStep: number;
  /**
   * The rate the **device** encodes its uplink at, in Hz. Read from
   * `BRIDGE_DEVICE_RATE`; the firmware's own declaration is 16000.
   *
   * Not the same number as `serverRate`, and not interchangeable with it. The
   * hello declares `serverRate` for the downlink, and 24000 is a legal rate for
   * both — so a port that reused it here would build a decoder at the wrong rate
   * and fail in the one way that looks like a broken microphone: the sample count
   * is part of what an Opus packet is read as, so the frames would not decode at
   * all rather than decoding sharp (6.1).
   */
  deviceRate: number;
  /**
   * The endpointer, which is how the bridge knows the person has stopped speaking
   * (D9, 6.4). The firmware sends no `listen stop`, so nothing else will say.
   *
   * All five of these are one decision together, and the relation between them is
   * checked at start rather than left to an operator — see `requireEndpointer`.
   */
  /** The gate's absolute floor, in RMS. The quietest a frame may be and still be
   *  counted, until the room's own floor is estimated. */
  vadMinRms: number;
  /** How far above the room's estimated floor a frame must be to count. */
  vadFloorRatio: number;
  /** How much silence after speech closes the turn. */
  vadSilenceMs: number;
  /** How much speech a window must hold before a turn may close at all. */
  vadMinSpeechMs: number;
  /** The sliding window speech is counted over. */
  vadSpeechWindowMs: number;
  /** The longest turn, as a backstop for a person who never stops. */
  maxTurnMs: number;
  /** How long a window may hold no speech at all before it is given up on. */
  vadNoSpeechMs: number;
  /** How long after the bridge's own audio the device's microphone is distrusted,
   *  since the device reopens it before its speaker stops (D10, 6.6). */
  drainGuardMs: number;
  /** How much audio before the first voiced frame to keep, so a soft onset is not
   *  clipped off the utterance (6.1). */
  onsetLeadMs: number;
}

const PORT_MAX = 65535;

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be a positive integer at most ${max}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** A positive number, integral or not — the floor ratio is the one knob that is
 *  not a count of milliseconds, and a floor on it matters more than its width. */
function readNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function readFraming(env: NodeJS.ProcessEnv): FramingVersion {
  const raw = env.BRIDGE_FRAMING;
  if (raw === undefined || raw === "") return 3;
  if (raw !== "1" && raw !== "2" && raw !== "3") {
    throw new Error(`BRIDGE_FRAMING must be 3, 2 or 1, got ${JSON.stringify(raw)}`);
  }
  return Number(raw) as FramingVersion;
}

/**
 * The gadget's language, as the endpoint's own two-word vocabulary. Not folded to
 * English the way the platform folds an unknown value, because that folding is the
 * failure D12 describes: an operator who typed `vi` would get a bridge that
 * transcribes Vietnamese as English and says nothing about it.
 */
function readLanguage(env: NodeJS.ProcessEnv): TurnLanguage {
  const raw = env.BRIDGE_LANGUAGE;
  if (raw === undefined || raw === "") return "english";
  if (raw !== "english" && raw !== "vietnamese") {
    throw new Error(`BRIDGE_LANGUAGE must be english or vietnamese, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * The secret is the only value with no default. A default here would be a
 * constant every deployment shares, which is exactly what the skeleton shipped
 * and what D6 records a finished bridge must not do — so a bridge without one
 * refuses to start, and says how to make one.
 */
function readDeviceSecret(env: NodeJS.ProcessEnv): string {
  const secret = env.BRIDGE_DEVICE_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    throw new Error(
      `BRIDGE_DEVICE_SECRET must be set, at least 32 characters, and never reused between deployments. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
    );
  }
  return secret;
}

/**
 * The platform's credential is required and has no default, for the reason the
 * device secret has none: a bridge that cannot authenticate to the platform
 * cannot serve a turn, and one that starts anyway only fails later, at the first
 * turn, where the cause is far from the symptom.
 *
 * There is deliberately no length rule. Unlike the device secret — which this
 * service generates, so it can insist on entropy — this token is issued by the
 * platform, and a short one is the platform's business rather than a reason for
 * this service to refuse to carry it. It is also returned exactly as read,
 * because the platform compares it byte for byte and a helpful trim would be a
 * credential that no longer works. Only a value that is nothing but whitespace
 * is treated as absent, since that is a mistake rather than a token.
 */
function readApiAuthToken(env: NodeJS.ProcessEnv): string {
  const token = env.API_AUTH_TOKEN ?? "";
  if (token.trim() === "") {
    throw new Error(
      "API_AUTH_TOKEN must be set: it is the platform's own credential, and the bridge is what calls the platform. " +
        "Copy it from adaptive-interview-api's .env — and never onto a device."
    );
  }
  return token;
}

/**
 * The allowlist. Empty is empty: a device is allowed because it is named, and a
 * bridge with nothing named lets nothing connect. Separators and case do not
 * distinguish devices — see `normalizeDeviceId`.
 */
function readAllowedDevices(env: NodeJS.ProcessEnv): string[] {
  const raw = env.BRIDGE_ALLOWED_DEVICES ?? "";
  const devices = raw
    .split(/[\s,;]+/)
    .map((entry) => normalizeDeviceId(entry))
    .filter((entry) => entry !== "");
  return [...new Set(devices)];
}

/**
 * Where the platform is. Required, and with no default, for a reason the port
 * defaults do not share: the ports are addresses *this* machine serves on, and
 * the flashed device expects them, but the platform's address is a property of
 * one deployment. A default would be localhost, which is right on a developer's
 * machine and silently wrong everywhere else — the bridge would come up, report
 * itself healthy, and reach nothing. A bridge that cannot reach the platform can
 * serve no turn at all, so this fails at start, where the operator is, rather
 * than at the first turn, where the symptom is far from the cause.
 *
 * Unlike the credential, trimming is harmless here: this is a URL this service
 * parses rather than a byte string the platform compares. Any trailing slashes
 * are dropped once, here, so joining a path is a plain concatenation and no call
 * site has to remember which of them is the odd one out.
 */
function readPlatformUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.BRIDGE_PLATFORM_URL ?? "";
  if (raw.trim() === "") {
    throw new Error(
      "BRIDGE_PLATFORM_URL must be set: it is where the bridge reaches adaptive-interview-api, " +
        'for example BRIDGE_PLATFORM_URL=http://127.0.0.1:4000. There is no default, because a ' +
        "default would point a deployment at whatever machine happened to be localhost."
    );
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(
      `BRIDGE_PLATFORM_URL must be an absolute URL like http://host:4000, got ${JSON.stringify(raw)}`
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`BRIDGE_PLATFORM_URL must be http or https, got ${JSON.stringify(raw)}`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(
      `BRIDGE_PLATFORM_URL must be a base URL without a query or fragment, got ${JSON.stringify(raw)}`
    );
  }
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

/**
 * Which persona each device speaks as, one binding per device.
 *
 * One per device because a gadget speaks as exactly one persona (D5), and a
 * device that could be either of two is a device whose character depends on a
 * lookup order. The separator is `=` rather than `:`, because a Device-Id is full
 * of colons — the persona is whatever follows the first `=`. Entries are
 * separated the way the allowlist separates its own, and identifiers are
 * normalized exactly as the allowlist normalizes them, so the two lists can be
 * pasted from the same place and still agree.
 */
function readDevicePersonas(env: NodeJS.ProcessEnv): Map<string, string> {
  const raw = env.BRIDGE_DEVICE_PERSONAS ?? "";
  const bindings = new Map<string, string>();
  for (const entry of raw.split(/[\s,;]+/).filter((part) => part !== "")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new Error(`BRIDGE_DEVICE_PERSONAS entries are DEVICE=PERSONA, got ${JSON.stringify(entry)}`);
    }
    const device = normalizeDeviceId(entry.slice(0, separator));
    const persona = entry.slice(separator + 1).trim();
    if (device === "") {
      throw new Error(`BRIDGE_DEVICE_PERSONAS entry ${JSON.stringify(entry)} names no device`);
    }
    if (persona === "") {
      throw new Error(`BRIDGE_DEVICE_PERSONAS entry ${JSON.stringify(entry)} names no persona`);
    }
    if (bindings.has(device)) {
      throw new Error(`BRIDGE_DEVICE_PERSONAS binds ${device} twice, and a device speaks as one persona`);
    }
    bindings.set(device, persona);
  }
  return bindings;
}

/**
 * The two lists have to describe the same devices, in both directions.
 *
 * A device the allowlist names with no persona could connect and then never be
 * answered: it would handshake, and every turn would fail for a reason that is in
 * configuration while looking like a device fault. A binding for a device the
 * allowlist does not name is configuration for something that can never connect,
 * which is nearly always a typo in one of the two identifiers. Both are refused
 * at start, where the operator is, rather than at the first turn.
 */
function requireBindings(allowedDevices: string[], devicePersonas: ReadonlyMap<string, string>): void {
  const unbound = allowedDevices.filter((device) => !devicePersonas.has(device));
  if (unbound.length > 0) {
    throw new Error(
      `every device in BRIDGE_ALLOWED_DEVICES must be bound to a persona in BRIDGE_DEVICE_PERSONAS: ` +
        `${unbound.join(", ")} ${unbound.length === 1 ? "has" : "have"} no binding`
    );
  }
  const strangers = [...devicePersonas.keys()].filter((device) => !allowedDevices.includes(device));
  if (strangers.length > 0) {
    throw new Error(
      `BRIDGE_DEVICE_PERSONAS binds ${strangers.join(", ")}, which BRIDGE_ALLOWED_DEVICES does not ` +
        `name, so no turn could ever be served for it — check the identifier in both lists`
    );
  }
}

/**
 * The endpointer's shipped defaults, and the only copy of them.
 *
 * Exported so a test can build a config that is a deployment's in every respect it
 * does not care about, without spelling out ten numbers that would then drift from
 * these the first time one of them moved. The rig's own defaults, measured on the
 * board this service was built for: 7500 RMS against a room floor of about 3000 is
 * the gate that separated a person from the device's own speaker.
 */
export const ENDPOINTER_DEFAULTS = {
  /** The firmware declares 16000 Hz Opus mono upward; the hello's 24000 is the
   *  downlink and is a different number (6.1). */
  deviceRate: 16000,
  vadMinRms: 7500,
  vadFloorRatio: 2.5,
  vadSilenceMs: 900,
  vadMinSpeechMs: 240,
  vadSpeechWindowMs: 3000,
  maxTurnMs: 20000,
  vadNoSpeechMs: 15000,
  drainGuardMs: 400,
  onsetLeadMs: 300,
} as const;

/**
 * The one relation between the endpointer's knobs, checked at start (6.4).
 *
 * Speech is counted over a **sliding** window. If the window is no longer than the
 * silence threshold plus the speech minimum, the frames that satisfied the speech
 * minimum have already aged out of the window by the time the silence threshold is
 * reached — so neither condition can ever hold at once and a turn can never close.
 * The rig has the same relation and only warns about it, in a comment that names
 * its own failure as silent: "the rig just waits forever". A bridge cannot be left
 * in that state by a typo, so this throws.
 */
function requireEndpointer(config: {
  vadSilenceMs: number;
  vadMinSpeechMs: number;
  vadSpeechWindowMs: number;
}): void {
  if (config.vadSpeechWindowMs <= config.vadSilenceMs + config.vadMinSpeechMs) {
    throw new Error(
      `BRIDGE_VAD_SPEECH_WINDOW_MS must exceed BRIDGE_VAD_SILENCE_MS + BRIDGE_VAD_MIN_SPEECH_MS ` +
        `(${config.vadSilenceMs} + ${config.vadMinSpeechMs}), got ${config.vadSpeechWindowMs}: ` +
        `speech ages out of the window before the silence threshold is reached, and no turn could ever close`
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  // The two device lists are read and cross-checked first, so bindings that
  // cannot work are reported even when some later value is wrong too.
  const allowedDevices = readAllowedDevices(env);
  const devicePersonas = readDevicePersonas(env);
  requireBindings(allowedDevices, devicePersonas);

  // Read together, because they are one decision, and checked together before the
  // rest of the service is built: an endpointer that can never close a turn is a
  // gadget that never answers, and that is not something to discover from silence.
  const endpointer = {
    deviceRate: readInt(env, "BRIDGE_DEVICE_RATE", ENDPOINTER_DEFAULTS.deviceRate),
    vadMinRms: readInt(env, "BRIDGE_VAD_MIN_RMS", ENDPOINTER_DEFAULTS.vadMinRms),
    vadFloorRatio: readNumber(env, "BRIDGE_VAD_FLOOR_RATIO", ENDPOINTER_DEFAULTS.vadFloorRatio),
    vadSilenceMs: readInt(env, "BRIDGE_VAD_SILENCE_MS", ENDPOINTER_DEFAULTS.vadSilenceMs),
    vadMinSpeechMs: readInt(env, "BRIDGE_VAD_MIN_SPEECH_MS", ENDPOINTER_DEFAULTS.vadMinSpeechMs),
    vadSpeechWindowMs: readInt(env, "BRIDGE_VAD_SPEECH_WINDOW_MS", ENDPOINTER_DEFAULTS.vadSpeechWindowMs),
    maxTurnMs: readInt(env, "BRIDGE_MAX_TURN_MS", ENDPOINTER_DEFAULTS.maxTurnMs),
    vadNoSpeechMs: readInt(env, "BRIDGE_VAD_NO_SPEECH_MS", ENDPOINTER_DEFAULTS.vadNoSpeechMs),
    drainGuardMs: readInt(env, "BRIDGE_DRAIN_GUARD_MS", ENDPOINTER_DEFAULTS.drainGuardMs),
    onsetLeadMs: readInt(env, "BRIDGE_ONSET_LEAD_MS", ENDPOINTER_DEFAULTS.onsetLeadMs),
  };
  requireEndpointer(endpointer);

  return {
    otaPort: readInt(env, "OTA_PORT", 8003, PORT_MAX),
    wsPort: readInt(env, "WS_PORT", 8000, PORT_MAX),
    publicHost: localIp(env.BRIDGE_PUBLIC_HOST),
    deviceSecret: readDeviceSecret(env),
    allowedDevices,
    devicePersonas,
    platformUrl: readPlatformUrl(env),
    apiAuthToken: readApiAuthToken(env),
    framing: readFraming(env),
    // 24000 Hz is the platform's measured TTS output rate and a legal Opus rate;
    // it is also the firmware's own default, so neither side resamples.
    serverRate: readInt(env, "BRIDGE_SERVER_RATE", 24000),
    frameMs: readInt(env, "BRIDGE_FRAME_MS", 60),
    historyTurns: readInt(env, "BRIDGE_HISTORY_TURNS", 20),
    language: readLanguage(env),
    // Not bounded to 100: the range a setting is clamped to is the range the
    // gadget's own tool declares (D6), and this is only how far one command moves
    // it. A step past the end of that range lands on the end, which is a legal
    // outcome rather than a mistake to refuse.
    commandStep: readInt(env, "BRIDGE_COMMAND_STEP", 10),
    ...endpointer,
  };
}
