import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

/**
 * The configuration is where the rules that must not fail open live: an empty
 * allowlist, a device secret with no default, and — from 2.3 — the platform's
 * credential, which has none either. A bridge that starts without a device secret
 * would run with something predictable; one that reads an empty allowlist as "no
 * restriction" would refuse nothing; and one that starts without the platform's
 * credential only fails later, at its first turn, where the cause is far from the
 * symptom. All three are pinned here, along with the parsing an operator cannot
 * see.
 */
const BOARD = "b8:1f:3f:4a:9b:01";
const SECRET = "s".repeat(43);
const PLATFORM = "platform-token-abcdefgh";

/** The minimum a config needs to load: the two credentials, and nothing else. */
const minimal = { BRIDGE_DEVICE_SECRET: SECRET, API_AUTH_TOKEN: PLATFORM } as NodeJS.ProcessEnv;

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

describe("the platform credential", () => {
  it("refuses to load without one, so a bridge never starts unable to authenticate", () => {
    assert.throws(
      () => loadConfig({ BRIDGE_DEVICE_SECRET: SECRET } as NodeJS.ProcessEnv),
      /API_AUTH_TOKEN must be set/
    );
    assert.throws(
      () => loadConfig({ BRIDGE_DEVICE_SECRET: SECRET, API_AUTH_TOKEN: "" } as NodeJS.ProcessEnv),
      /API_AUTH_TOKEN/
    );
  });

  it("treats a value that is only whitespace as absent", () => {
    // A blank line in .env is a missing token, not a token made of spaces.
    assert.throws(
      () => loadConfig({ BRIDGE_DEVICE_SECRET: SECRET, API_AUTH_TOKEN: "   " } as NodeJS.ProcessEnv),
      /API_AUTH_TOKEN must be set/
    );
  });

  it("carries the token byte for byte, since the platform compares it exactly", () => {
    // Rounding a token up with a helpful trim would be a credential that no
    // longer authenticates.
    const unpadded = `${PLATFORM}`;
    assert.equal(loadConfig({ ...minimal, API_AUTH_TOKEN: unpadded } as NodeJS.ProcessEnv).apiAuthToken, unpadded);
    assert.equal(
      loadConfig({ ...minimal, API_AUTH_TOKEN: ` ${PLATFORM} ` } as NodeJS.ProcessEnv).apiAuthToken,
      ` ${PLATFORM} `
    );
  });

  it("imposes no length rule, because the platform issues it rather than this service", () => {
    // The device secret is generated here, so it can be held to entropy. This
    // one is carried as the platform made it.
    assert.equal(loadConfig({ ...minimal, API_AUTH_TOKEN: "short" } as NodeJS.ProcessEnv).apiAuthToken, "short");
  });
});

describe("the allowlist", () => {
  it("normalizes what an operator pasted", () => {
    const config = loadConfig({
      ...minimal,
      BRIDGE_ALLOWED_DEVICES: " B8-1F-3F-4A-9B-01 , b8:1f:3f:4a:9b:02 ",
    } as NodeJS.ProcessEnv);
    assert.deepEqual(config.allowedDevices, ["b81f3f4a9b01", "b81f3f4a9b02"]);
  });

  it("counts one device once, however many spellings it was listed under", () => {
    const config = loadConfig({
      ...minimal,
      BRIDGE_ALLOWED_DEVICES: `${BOARD},b81f3f4a9b01,B8:1F:3F:4A:9B:01`,
    } as NodeJS.ProcessEnv);
    assert.equal(config.allowedDevices.length, 1);
  });

  it("is empty when unset, and empty means nobody", () => {
    // Not "no restriction": nothing named, nothing allowed.
    assert.deepEqual(loadConfig(minimal).allowedDevices, []);
    assert.deepEqual(
      loadConfig({ ...minimal, BRIDGE_ALLOWED_DEVICES: "  ,  ," } as NodeJS.ProcessEnv).allowedDevices,
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

  it("derives the device token but carries the platform's", () => {
    const config = loadConfig(minimal) as unknown as Record<string, unknown>;
    // No "token" field, and that absence is the design: a device token is
    // derived from the secret and the identifier rather than configured. The
    // platform's is the opposite — issued elsewhere, carried here unchanged.
    assert.equal("token" in config, false);
    assert.equal("deviceSecret" in config, true);
    assert.equal(config.apiAuthToken, PLATFORM);
  });
});
