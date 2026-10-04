import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

/**
 * The configuration is where the rules that must not fail open live: an empty
 * allowlist, a device secret with no default, the platform's credential — from
 * 2.3, which has none either — and, from 3.1, the platform's address, which has
 * none for a different reason: the only obvious default is localhost, and
 * localhost is right on one machine and silently wrong on every other. A bridge
 * that starts without a device secret would run with something predictable; one
 * that reads an empty allowlist as "no restriction" would refuse nothing; and one
 * that starts without the platform's credential or address only fails later, at
 * its first platform call, where the cause is far from the symptom. All four are
 * pinned here, along with the parsing an operator cannot see.
 */
const BOARD = "b8:1f:3f:4a:9b:01";
const SECRET = "s".repeat(43);
const PLATFORM = "platform-token-abcdefgh";
const PLATFORM_URL = "http://127.0.0.1:4000";

/**
 * The minimum a config needs to load: the platform's address and the two
 * credentials — the three values with no default — and nothing else.
 */
const minimal = {
  BRIDGE_DEVICE_SECRET: SECRET,
  API_AUTH_TOKEN: PLATFORM,
  BRIDGE_PLATFORM_URL: PLATFORM_URL,
} as NodeJS.ProcessEnv;

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
    // The address is supplied, so what is missing here is the token and only the
    // token: each rule is pinned by a test that isolates it.
    const withoutToken = { BRIDGE_DEVICE_SECRET: SECRET, BRIDGE_PLATFORM_URL: PLATFORM_URL };
    assert.throws(() => loadConfig(withoutToken as NodeJS.ProcessEnv), /API_AUTH_TOKEN must be set/);
    assert.throws(
      () => loadConfig({ ...withoutToken, API_AUTH_TOKEN: "" } as NodeJS.ProcessEnv),
      /API_AUTH_TOKEN/
    );
  });

  it("treats a value that is only whitespace as absent", () => {
    // A blank line in .env is a missing token, not a token made of spaces.
    assert.throws(
      () =>
        loadConfig({
          BRIDGE_DEVICE_SECRET: SECRET,
          BRIDGE_PLATFORM_URL: PLATFORM_URL,
          API_AUTH_TOKEN: "   ",
        } as NodeJS.ProcessEnv),
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

describe("the platform's address", () => {
  it("refuses to load without one, because the obvious default is localhost", () => {
    // Every other address in this file is one this machine serves on. This one
    // belongs to a deployment, and a bridge that guessed would come up looking
    // healthy and reach nothing.
    assert.throws(
      () => loadConfig({ BRIDGE_DEVICE_SECRET: SECRET, API_AUTH_TOKEN: PLATFORM } as NodeJS.ProcessEnv),
      /BRIDGE_PLATFORM_URL must be set/
    );
    assert.throws(() => loadConfig({ ...minimal, BRIDGE_PLATFORM_URL: "" } as NodeJS.ProcessEnv), /BRIDGE_PLATFORM_URL/);
  });

  it("drops trailing slashes, so joining a path is a plain concatenation", () => {
    assert.equal(loadConfig({ ...minimal, BRIDGE_PLATFORM_URL: `${PLATFORM_URL}/` }).platformUrl, PLATFORM_URL);
    assert.equal(loadConfig({ ...minimal, BRIDGE_PLATFORM_URL: `${PLATFORM_URL}//` }).platformUrl, PLATFORM_URL);
  });

  it("keeps a base path, since a deployment may front the platform with one", () => {
    assert.equal(loadConfig({ ...minimal, BRIDGE_PLATFORM_URL: "https://host/gw/" }).platformUrl, "https://host/gw");
  });

  it("tolerates surrounding whitespace, unlike the credential", () => {
    // This is a URL this service parses, not a byte string the platform compares,
    // so a stray space from a paste is trimmed rather than carried.
    assert.equal(loadConfig({ ...minimal, BRIDGE_PLATFORM_URL: ` ${PLATFORM_URL} ` }).platformUrl, PLATFORM_URL);
  });

  it("refuses anything that is not an http(s) base URL", () => {
    const at = (value: string) => () => loadConfig({ ...minimal, BRIDGE_PLATFORM_URL: value });
    assert.throws(at("127.0.0.1:4000"), /absolute URL/);
    assert.throws(at("ftp://host"), /http or https/);
    assert.throws(at(`${PLATFORM_URL}/?a=1`), /query or fragment/);
    assert.throws(at(`${PLATFORM_URL}/#x`), /query or fragment/);
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
