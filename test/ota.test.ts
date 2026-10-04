import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { BridgeConfig } from "../src/config.js";
import { createOtaServer } from "../src/server/ota.js";

/**
 * The OTA endpoint is the first thing a device asks, and the only place it learns
 * where to connect. What is pinned here is the shape of the answer: the three
 * fields under `websocket` that the firmware reads, and the fact that an endpoint
 * answers at all on the path the flashed device actually requests.
 */
function configFor(otaPort: number): BridgeConfig {
  return {
    otaPort,
    wsPort: 8000,
    publicHost: "127.0.0.1",
    token: "test-token",
    framing: 3,
    serverRate: 24000,
    frameMs: 60,
  };
}

async function startedServer() {
  const server = createOtaServer(configFor(0));
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
  it("answers the flashed path with the address the device must connect to", async () => {
    const { port, stop } = await startedServer();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/xiaozhi/ota/`, {
        headers: { "device-id": "aa:bb:cc:dd:ee:ff", "client-id": "test", "activation-version": "1.0.0" },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);

      const body = (await res.json()) as {
        websocket: { url: string; token: string; version: number };
        server_time: { timestamp: number; timezone_offset: number };
      };
      assert.equal(body.websocket.url, "ws://127.0.0.1:8000/xiaozhi/v1/");
      assert.equal(body.websocket.token, "test-token");
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

  it("answers without the trailing slash too", async () => {
    const { port, stop } = await startedServer();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/xiaozhi/ota`, { headers: { "device-id": "aa:bb" } });
      assert.equal(res.status, 200);
    } finally {
      stop();
    }
  });

  it("still hands out the address to a device that does not identify itself", async () => {
    // The header is logged as a warning rather than turned into a refusal: a
    // device that cannot get an address is a device that cannot be debugged.
    const { port, stop } = await startedServer();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/xiaozhi/ota/`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { websocket: { url: string } };
      assert.equal(body.websocket.url, "ws://127.0.0.1:8000/xiaozhi/v1/");
    } finally {
      stop();
    }
  });

  it("answers a human at / with the addresses, and 404s anything else", async () => {
    const { port, stop } = await startedServer();
    try {
      const root = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(root.status, 200);
      assert.match(await root.text(), /xiaozhi\/ota/);

      const missing = await fetch(`http://127.0.0.1:${port}/xiaozhi/ota/firmware`);
      assert.equal(missing.status, 404, "a path we do not serve is logged, not answered with the address");
    } finally {
      stop();
    }
  });
});
