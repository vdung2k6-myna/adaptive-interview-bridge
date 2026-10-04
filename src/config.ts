import { normalizeDeviceId } from "./credentials.js";
import { localIp } from "./net/local-ip.js";
import type { FramingVersion } from "./protocol/framing.js";

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

function readFraming(env: NodeJS.ProcessEnv): FramingVersion {
  const raw = env.BRIDGE_FRAMING;
  if (raw === undefined || raw === "") return 3;
  if (raw !== "1" && raw !== "2" && raw !== "3") {
    throw new Error(`BRIDGE_FRAMING must be 3, 2 or 1, got ${JSON.stringify(raw)}`);
  }
  return Number(raw) as FramingVersion;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return {
    otaPort: readInt(env, "OTA_PORT", 8003, PORT_MAX),
    wsPort: readInt(env, "WS_PORT", 8000, PORT_MAX),
    publicHost: localIp(env.BRIDGE_PUBLIC_HOST),
    deviceSecret: readDeviceSecret(env),
    allowedDevices: readAllowedDevices(env),
    platformUrl: readPlatformUrl(env),
    apiAuthToken: readApiAuthToken(env),
    framing: readFraming(env),
    // 24000 Hz is the platform's measured TTS output rate and a legal Opus rate;
    // it is also the firmware's own default, so neither side resamples.
    serverRate: readInt(env, "BRIDGE_SERVER_RATE", 24000),
    frameMs: readInt(env, "BRIDGE_FRAME_MS", 60),
  };
}
