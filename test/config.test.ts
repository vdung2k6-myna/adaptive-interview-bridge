import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

/**
 * The configuration is where the two rules that must not fail open live: an
 * empty allowlist, and a device secret with no default. A bridge that starts
 * without a secret would run with something predictable; a bridge that reads an
 * empty allowlist as "no restriction" would refuse nothing. Both are pinned
 * here, along with the parsing an operator cannot see.
 */
const BOARD = "b8:1f:3f:4a:9b:01";
const SECRET = "s".repeat(43);

/** The minimum a config needs to load: the secret, and nothing else. */
const minimal = { BRIDGE_DEVICE_SECRET: SECRET } as NodeJS.ProcessEnv;

describe("the device secret", () => {
  it("refuses to load without one, rather than falling back to a constant", () => {
    assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), /BRIDGE_DEVICE_SECRET must be set/);
    assert.throws(() => loadConfig({ BRIDGE_DEVICE_SECRET: "" } as NodeJS.ProcessEnv), /BRIDGE_DEVICE_SECRET/);
  });

  it("refuses a secret short enough to guess", () => {
    // The skeleton's "spike" is exactly this mistake, so it must not load.
    assert.throws(() => loadConfig({ BRIDGE_DEVICE_SECRET: "spike" } as NodeJS.ProcessEnv), /at least 32 characters/);
  });

  it("says how to generate one", () => {
    assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), /randomBytes/);
  });
});

describe("the allowlist", () => {
  it("normalizes what an operator pasted", () => {
    const config = loadConfig({
      BRIDGE_DEVICE_SECRET: SECRET,
      BRIDGE_ALLOWED_DEVICES: " B8-1F-3F-4A-9B-01 , b8:1f:3f:4a:9b:02 ",
    } as NodeJS.ProcessEnv);
    assert.deepEqual(config.allowedDevices, ["b81f3f4a9b01", "b81f3f4a9b02"]);
  });

  it("counts one device once, however many spellings it was listed under", () => {
    const config = loadConfig({
      BRIDGE_DEVICE_SECRET: SECRET,
      BRIDGE_ALLOWED_DEVICES: `${BOARD},b81f3f4a9b01,B8:1F:3F:4A:9B:01`,
    } as NodeJS.ProcessEnv);
    assert.equal(config.allowedDevices.length, 1);
  });

  it("is empty when unset, and empty means nobody", () => {
    // Not "no restriction": nothing named, nothing allowed.
    assert.deepEqual(loadConfig(minimal).allowedDevices, []);
    assert.deepEqual(
      loadConfig({ BRIDGE_DEVICE_SECRET: SECRET, BRIDGE_ALLOWED_DEVICES: "  ,  ," } as NodeJS.ProcessEnv).allowedDevices,
      []
    );
  });
});

describe("the rest of the configuration", () => {
  it("keeps the values that were already settled", () => {
    const config = loadConfig(minimal);
    assert.equal(config.otaPort, 8003);
    assert.equal(config.wsPort, 8000);
    assert.equal(config.framing, 3);
    assert.equal(config.serverRate, 24000);
    assert.equal(config.frameMs, 60);
  });

  it("still refuses a malformed value rather than falling back", () => {
    assert.throws(() => loadConfig({ ...minimal, BRIDGE_FRAMING: "4" } as NodeJS.ProcessEnv), /BRIDGE_FRAMING/);
    assert.throws(() => loadConfig({ ...minimal, WS_PORT: "0" } as NodeJS.ProcessEnv), /WS_PORT/);
    assert.throws(() => loadConfig({ ...minimal, OTA_PORT: "abc" } as NodeJS.ProcessEnv), /OTA_PORT/);
  });

  it("never carries a token field, since tokens are derived rather than configured", () => {
    const config = loadConfig(minimal) as unknown as Record<string, unknown>;
    assert.equal("token" in config, false);
    assert.equal("deviceSecret" in config, true);
  });
});
