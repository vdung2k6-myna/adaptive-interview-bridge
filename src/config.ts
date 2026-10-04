import { normalizeDeviceId } from "./credentials.js";
import { localIp } from "./net/local-ip.js";
import type { FramingVersion } from "./protocol/framing.js";

/**
 * Everything the bridge reads from its environment, read once at start.
 *
 * Deliberately only what the service uses. A skeleton that accepts configuration
 * for features it does not have is a skeleton whose operator believes those
 * features are on; the platform's URL and credential are added by the task that
 * first needs them (4.1), with the code that consumes them.
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return {
    otaPort: readInt(env, "OTA_PORT", 8003, PORT_MAX),
    wsPort: readInt(env, "WS_PORT", 8000, PORT_MAX),
    publicHost: localIp(env.BRIDGE_PUBLIC_HOST),
    deviceSecret: readDeviceSecret(env),
    allowedDevices: readAllowedDevices(env),
    framing: readFraming(env),
    // 24000 Hz is the platform's measured TTS output rate and a legal Opus rate;
    // it is also the firmware's own default, so neither side resamples.
    serverRate: readInt(env, "BRIDGE_SERVER_RATE", 24000),
    frameMs: readInt(env, "BRIDGE_FRAME_MS", 60),
  };
}
