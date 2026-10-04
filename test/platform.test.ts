import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BridgeConfig } from "../src/config.js";
import { deriveToken } from "../src/credentials.js";
import { platformAuthHeaders } from "../src/platform.js";

/**
 * The platform's credential crosses the boundary in exactly one shape: a Bearer
 * header on a request this bridge makes to the platform. That shape is pinned
 * here because the platform's validator compares the presented token with `===`
 * — so anything done here for convenience (trimming, re-casing, a prefix of its
 * own) is not a tidier credential but one that stops authenticating.
 *
 * The other half is which credential is in it. The bridge holds two secrets that
 * must never be confused: the device secret, which a device's token is derived
 * from, and the platform's, which a device must never see. A header carrying the
 * wrong one is the leak this whole task exists to prevent.
 */
const BOARD = "b8:1f:3f:4a:9b:01";
const SECRET = "s".repeat(43);
const PLATFORM = "platform-token-abcdefgh";

function configFor(apiAuthToken: string): BridgeConfig {
  return {
    otaPort: 0,
    wsPort: 0,
    publicHost: "127.0.0.1",
    deviceSecret: SECRET,
    allowedDevices: ["b81f3f4a9b01"],
    devicePersonas: new Map([["b81f3f4a9b01", "language-partner"]]),
    platformUrl: "http://127.0.0.1:4000",
    apiAuthToken,
    framing: 3,
    serverRate: 24000,
    frameMs: 60,
    historyTurns: 20,
    language: "english",
  };
}

describe("the platform credential as a request", () => {
  it("is presented as a Bearer header, verbatim", () => {
    assert.deepEqual(platformAuthHeaders(configFor(PLATFORM)), { Authorization: `Bearer ${PLATFORM}` });
  });

  it("does not reshape a token the platform issued", () => {
    // Whitespace on the ends is the platform's business, not this service's:
    // it carries the token it was given.
    const asIssued = ` ${PLATFORM} `;
    assert.equal(platformAuthHeaders(configFor(asIssued)).Authorization, `Bearer ${asIssued}`);
  });

  it("carries the platform's credential and never a device's", () => {
    const config = configFor(PLATFORM);
    const header = platformAuthHeaders(config).Authorization;
    assert.equal(
      header.includes(deriveToken(config.deviceSecret, BOARD)),
      false,
      "a request to the platform must not carry a device token, and vice versa"
    );
    assert.equal(header.includes(config.deviceSecret), false);
  });
});
