import { createHmac, timingSafeEqual } from "node:crypto";
import type { BridgeConfig } from "./config.js";

/**
 * The device credential — who is allowed to connect, and with what.
 *
 * The device never holds anything the platform accepts (the spec's "A gadget
 * holds no credential the platform accepts"): it holds one opaque string, issued
 * per device, that only this bridge can check. The platform's own token stays
 * here, and task 2.3 keeps it here.
 *
 * There is no token store. The token is derived from a secret this bridge holds
 * and from the device's own identifier, so the allowlist in configuration is the
 * whole of the state: adding a device is adding its identifier, revoking one is
 * removing it, and a restart issues the same tokens it issued before rather than
 * rotating every device's credential.
 *
 * What this model does *not* do is stated in the README: the identifier is a
 * header the client declares, so the allowlist keeps out a device this bridge
 * was not told about, and does not keep out someone who already knows the
 * identifier of a device it was.
 */
export type Denial =
  | "no-device-id"
  | "device-not-allowed"
  | "no-token"
  | "token-mismatch";

export type Authorization =
  | { ok: true; deviceId: string }
  | { ok: false; reason: Denial };

/**
 * One spelling per device. Separators and case are presentation, and a device
 * identifier that differs from another only in them is the same device — so
 * `b8:1f:3f:4a:9b:01`, `B8-1F-3F-4A-9B-01` and `b81f3f4a9b01` are one entry in
 * the allowlist, and an operator can paste whichever form they have.
 */
export function normalizeDeviceId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The token issued to one device, and the only token it can connect with. */
export function deriveToken(secret: string, deviceId: string): string {
  // The identifier is inside the HMAC input, not merely beside it, so a token is
  // a statement about one device rather than a shared secret with a label.
  return createHmac("sha256", secret).update(`device:${normalizeDeviceId(deviceId)}`).digest("base64url");
}

export function isAllowedDevice(config: BridgeConfig, deviceId: string): boolean {
  const wanted = normalizeDeviceId(deviceId);
  if (wanted === "") return false;
  // Both sides are normalized here, not only in the loader. The loader does
  // normalize, but this is the comparison the allowlist means, and a config
  // assembled anywhere else — a test, or the persona binding in 3.2 — would
  // otherwise refuse a device that is named in it, which is the worst way for
  // this to be wrong: it looks like the device is at fault.
  return config.allowedDevices.some((entry) => normalizeDeviceId(entry) === wanted);
}

/** An empty allowlist allows nobody. A bridge with no devices configured is a
 * bridge no device should be able to reach, and reading it as "no restriction"
 * is how an allowlist turns into a hole. */
export function allowedDeviceCount(config: BridgeConfig): number {
  return config.allowedDevices.length;
}

/**
 * The connect-time verdict. A device is authorized only by the combination of
 * its declared identifier and the token issued for that identifier — neither
 * alone, and no reason to treat a missing header as "the one device we have".
 */
export function authorizeDevice(
  config: BridgeConfig,
  presented: { deviceId?: string | undefined; authorization?: string | undefined }
): Authorization {
  const deviceId = presented.deviceId?.trim();
  if (!deviceId) return { ok: false, reason: "no-device-id" };
  if (!isAllowedDevice(config, deviceId)) return { ok: false, reason: "device-not-allowed" };

  const token = bearerToken(presented.authorization);
  if (!token) return { ok: false, reason: "no-token" };

  return matchesToken(config, deviceId, token)
    ? { ok: true, deviceId: normalizeDeviceId(deviceId) }
    : { ok: false, reason: "token-mismatch" };
}

/** `Authorization: Bearer <token>`, or the bare token. The firmware sends the
 * prefixed form, and accepting the bare one costs nothing. */
function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const value = header.trim();
  if (value === "") return null;
  const match = /^bearer\s+(.+)$/i.exec(value);
  return (match ? match[1]! : value).trim() || null;
}

function matchesToken(config: BridgeConfig, deviceId: string, presented: string): boolean {
  const expected = Buffer.from(deriveToken(config.deviceSecret, deviceId), "utf8");
  const actual = Buffer.from(presented, "utf8");
  // Length first: timingSafeEqual throws on a length difference, and the
  // throw would be an exception where a refusal is meant.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** One line an operator can act on, for the log and for a refusal. */
export function describeDenial(reason: Denial): string {
  switch (reason) {
    case "no-device-id":
      return "no Device-Id header";
    case "device-not-allowed":
      return "Device-Id is not in BRIDGE_ALLOWED_DEVICES";
    case "no-token":
      return "no Authorization header";
    case "token-mismatch":
      return "a token this bridge did not issue for that Device-Id";
  }
}
