import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { BridgeConfig } from "../src/config.js";
import { deriveToken } from "../src/credentials.js";
import { createOtaServer } from "../src/server/ota.js";

/**
 * The OTA endpoint is the first thing a device asks, the only place it learns
 * where to connect, and the only place it can be given a credential. What is
 * pinned here is the shape of the answer for a device that is allowed, and that
 * a device which is not gets no address and no token — an endpoint that answers
 * everyone would make the allowlist worth nothing.
 */
const BOARD = "b8:1f:3f:4a:9b:01";
const SECRET = "s".repeat(43);
const PLATFORM = "platform-token-abcdefgh";

function configFor(otaPort: number): BridgeConfig {
  return {
    otaPort,
    wsPort: 8000,
    publicHost: "127.0.0.1",
    deviceSecret: SECRET,
    allowedDevices: ["b81f3f4a9b01"],
    devicePersonas: new Map([["b81f3f4a9b01", "language-partner"]]),
    platformUrl: "http://127.0.0.1:4000",
    apiAuthToken: PLATFORM,
    framing: 3,
    serverRate: 24000,
    frameMs: 60,
  };
}

async function startedServer(config: BridgeConfig = configFor(0)) {
  const server = createOtaServer(config);
  if (!server.address()) await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    stop() {
      server.closeAllConnections();
      server.close();
    },
  };
}

describe("the OTA endpoint", () => {
  it("answers the flashed path with the address and the device's own token", async () => {
    const { port, stop } = await startedServer();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/xiaozhi/ota/`, {
        headers: { "device-id": BOARD, "client-id": "test", "activation-version": "1" },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);

      const body = (await res.json()) as {
        websocket: { url: string; token: string; version: number };
        server_time: { timestamp: number; timezone_offset: number };
      };
      assert.equal(body.websocket.url, "ws://127.0.0.1:8000/xiaozhi/v1/");
      assert.equal(body.websocket.token, deriveToken(SECRET, BOARD), "the token issued is the one the socket will accept");
      assert.equal(body.websocket.version, 3, "the framing version the device must use comes from here");
      assert.ok(
        Math.abs(Date.now() - body.server_time.timestamp) < 60_000,
        "the device sets its clock from this, so it has to be the current time"
      );
      assert.ok(Number.isInteger(body.server_time.timezone_offset), "minutes east of UTC, as an integer");
    } finally {
      stop();
    }
  });

  it("issues the same token twice, so a reboot does not invalidate the device", async () => {
    const { port, stop } = await startedServer();
    try {
      const ask = async () => {
        const res = await fetch(`http://127.0.0.1:${port}/xiaozhi/ota/`, { headers: { "device-id": BOARD } });
        return ((await res.json()) as { websocket: { token: string } }).websocket.token;
      };
      assert.equal(await ask(), await ask());
    } finally {
      stop();
    }
  });

  it("hands the device its own token and nothing of the platform's", async () => {
    // 2.3's boundary, asserted where a device is actually answered. The reply
    // carries a token derived from the device secret, so neither the platform's
    // credential nor the secret behind the device's may appear anywhere in it.
    const { port, stop } = await startedServer();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/xiaozhi/ota/`, {
        headers: { "device-id": BOARD, "client-id": "test" },
      });
      const text = await res.text();
      assert.equal(res.status, 200);
      assert.ok(!text.includes(PLATFORM), "the platform's credential must never be in what a device receives");
      assert.ok(!text.includes(SECRET), "nor the secret every device token is derived from");
    } finally {
      stop();
    }
  });

  it("answers without the trailing slash too", async () => {
    const { port, stop } = await startedServer();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/xiaozhi/ota`, { headers: { "device-id": BOARD } });
      assert.equal(res.status, 200);
    } finally {
      stop();
    }
  });

  it("refuses a device the allowlist does not name, and hands it no address", async () => {
    const { port, stop } = await startedServer();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/xiaozhi/ota/`, {
        headers: { "device-id": "aa:bb:cc:dd:ee:ff" },
      });
      assert.equal(res.status, 403);
      const body = (await res.text()).toLowerCase();
      assert.ok(!body.includes("ws://"), "a refused device must not be told where to connect");
      assert.ok(!body.includes("token"), "and must certainly not be handed one");
    } finally {
      stop();
    }
  });

  it("refuses a device that does not identify itself", async () => {
    // The identifier is what the token is derived from, so this is no longer a
    // warning: there is nothing to issue a credential against.
    const { port, stop } = await startedServer();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/xiaozhi/ota/`);
      assert.equal(res.status, 403);
      assert.ok(!(await res.text()).includes("ws://"));
    } finally {
      stop();
    }
  });

  it("refuses everyone when the allowlist is empty", async () => {
    const { port, stop } = await startedServer({ ...configFor(0), allowedDevices: [] });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/xiaozhi/ota/`, { headers: { "device-id": BOARD } });
      assert.equal(res.status, 403, "an empty allowlist is nobody, not everybody");
    } finally {
      stop();
    }
  });

  it("answers a human at / with the addresses, and 404s anything else", async () => {
    const { port, stop } = await startedServer();
    try {
      const root = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(root.status, 200);
      const text = await root.text();
      assert.match(text, /xiaozhi\/ota/);
      assert.ok(!text.includes(SECRET), "the human page must not leak the device secret");
      assert.ok(!text.includes(PLATFORM), "nor the platform's credential");

      const missing = await fetch(`http://127.0.0.1:${port}/xiaozhi/ota/firmware`);
      assert.equal(missing.status, 404, "a path we do not serve is logged, not answered with the address");
    } finally {
      stop();
    }
  });
});
