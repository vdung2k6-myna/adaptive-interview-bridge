import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BridgeConfig } from "../src/config.js";
import {
  authorizeDevice,
  deriveToken,
  describeDenial,
  isAllowedDevice,
  normalizeDeviceId,
} from "../src/credentials.js";

/**
 * The credential is the trust boundary, so what is pinned here is not only that
 * a good device is accepted but *why* the others are not: an absent header, an
 * identifier nobody named, a token for a different device, and — the one that is
 * easy to get wrong — a bridge whose allowlist is empty.
 */
const PLATFORM = "platform-token-abcdefgh";

function configFor(allowedDevices: string[], secret = "s".repeat(43)): BridgeConfig {
  return {
    otaPort: 0,
    wsPort: 0,
    publicHost: "127.0.0.1",
    deviceSecret: secret,
    allowedDevices,
    platformUrl: "http://127.0.0.1:4000",
    apiAuthToken: PLATFORM,
    framing: 3,
    serverRate: 24000,
    frameMs: 60,
  };
}

const BOARD = "b8:1f:3f:4a:9b:01";

describe("device identifiers", () => {
  it("treats separators and case as presentation, not identity", () => {
    const forms = [BOARD, BOARD.toUpperCase(), "b8-1f-3f-4a-9b-01", "b81f3f4a9b01", " B8:1F:3F:4A:9B:01 "];
    for (const form of forms) {
      assert.equal(normalizeDeviceId(form), "b81f3f4a9b01", JSON.stringify(form));
    }
  });

  it("does not confuse two devices that differ in a digit", () => {
    assert.notEqual(normalizeDeviceId("b8:1f:3f:4a:9b:01"), normalizeDeviceId("b8:1f:3f:4a:9b:02"));
  });
});

describe("the issued token", () => {
  it("is the same on every call, so a restart does not rotate a device's credential", () => {
    const config = configFor([BOARD]);
    assert.equal(deriveToken(config.deviceSecret, BOARD), deriveToken(config.deviceSecret, BOARD));
  });

  it("does not depend on how the identifier was spelled", () => {
    const config = configFor([BOARD]);
    assert.equal(deriveToken(config.deviceSecret, "B8-1F-3F-4A-9B-01"), deriveToken(config.deviceSecret, BOARD));
  });

  it("differs per device and per secret", () => {
    const config = configFor([BOARD]);
    assert.notEqual(deriveToken(config.deviceSecret, BOARD), deriveToken(config.deviceSecret, "b8:1f:3f:4a:9b:02"));
    assert.notEqual(deriveToken(config.deviceSecret, BOARD), deriveToken("t".repeat(43), BOARD));
  });
});

describe("the allowlist", () => {
  it("matches a device however its identifier is written", () => {
    const config = configFor(["B8-1F-3F-4A-9B-01"]);
    assert.equal(isAllowedDevice(config, BOARD), true);
  });

  it("allows nobody when it is empty", () => {
    // The dangerous reading is "no restriction". A bridge with no devices
    // configured is a bridge no device should be able to reach.
    const config = configFor([]);
    assert.equal(isAllowedDevice(config, BOARD), false);
    assert.deepEqual(authorizeDevice(config, { deviceId: BOARD, authorization: `Bearer ${deriveToken(config.deviceSecret, BOARD)}` }), {
      ok: false,
      reason: "device-not-allowed",
    });
  });
});

describe("authorizing a connection", () => {
  const config = configFor([BOARD]);
  const token = deriveToken(config.deviceSecret, BOARD);

  it("accepts the device the token was issued to, and names it", () => {
    assert.deepEqual(authorizeDevice(config, { deviceId: BOARD, authorization: `Bearer ${token}` }), {
      ok: true,
      deviceId: "b81f3f4a9b01",
    });
  });

  it("accepts the bare token the firmware would send without the prefix", () => {
    assert.equal(authorizeDevice(config, { deviceId: BOARD, authorization: token }).ok, true);
  });

  it("refuses a device that presents no credential", () => {
    assert.deepEqual(authorizeDevice(config, { deviceId: BOARD }), { ok: false, reason: "no-token" });
    assert.deepEqual(authorizeDevice(config, { deviceId: BOARD, authorization: "" }), { ok: false, reason: "no-token" });
  });

  it("refuses a device that declares no identifier", () => {
    assert.deepEqual(authorizeDevice(config, { authorization: `Bearer ${token}` }), {
      ok: false,
      reason: "no-device-id",
    });
  });

  it("refuses a device the allowlist does not name, even with a well-formed token", () => {
    const other = "aa:bb:cc:dd:ee:ff";
    const otherToken = deriveToken(config.deviceSecret, other);
    assert.deepEqual(authorizeDevice(config, { deviceId: other, authorization: `Bearer ${otherToken}` }), {
      ok: false,
      reason: "device-not-allowed",
    });
  });

  it("refuses an allowed device presenting no token at all", () => {
    // The skeleton's shared constant is exactly this case: a device that worked
    // before the allowlist existed and holds nothing this bridge issued.
    assert.deepEqual(authorizeDevice(config, { deviceId: BOARD, authorization: "Bearer spike" }), {
      ok: false,
      reason: "token-mismatch",
    });
  });

  it("refuses one allowed device's token presented by another", () => {
    const second = "b8:1f:3f:4a:9b:02";
    const config2 = configFor([BOARD, second]);
    const tokenForSecond = deriveToken(config2.deviceSecret, second);
    assert.deepEqual(authorizeDevice(config2, { deviceId: BOARD, authorization: `Bearer ${tokenForSecond}` }), {
      ok: false,
      reason: "token-mismatch",
    });
  });

  it("refuses a token of the right shape but the wrong length without throwing", () => {
    // timingSafeEqual throws on a length difference; a refusal is what is meant.
    assert.deepEqual(authorizeDevice(config, { deviceId: BOARD, authorization: "Bearer short" }), {
      ok: false,
      reason: "token-mismatch",
    });
  });

  it("refuses a token derived under a different secret", () => {
    const stolen = deriveToken("u".repeat(43), BOARD);
    assert.deepEqual(authorizeDevice(config, { deviceId: BOARD, authorization: `Bearer ${stolen}` }), {
      ok: false,
      reason: "token-mismatch",
    });
  });

  it("says in words why a connection was refused", () => {
    for (const reason of ["no-device-id", "device-not-allowed", "no-token", "token-mismatch"] as const) {
      assert.ok(describeDenial(reason).length > 0, reason);
    }
  });
});
