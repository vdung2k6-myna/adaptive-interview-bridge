import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { BridgeConfig } from "../src/config.js";
import { deriveToken } from "../src/credentials.js";
import { createWsServer } from "../src/server/ws.js";

/**
 * The handshake is task 2.1's acceptance on the server side; the refusal above
 * it is 2.2's. The firmware distinguishes the two cleanly — anything that is not
 * a 101 upgrade leaves it reporting "server not connected" — so a refused
 * connection is asserted at the HTTP status, and an accepted one by the hello
 * the device actually waits for.
 *
 * The firmware's acceptance is unforgiving in one specific way: `transport`
 * missing from the reply means the connect fails ten seconds later with nothing
 * logged here, so these tests assert the reply's fields individually rather than
 * its shape.
 */
const BOARD = "b8:1f:3f:4a:9b:01";
const SECOND = "b8:1f:3f:4a:9b:02";
const SECRET = "s".repeat(43);
const PLATFORM = "platform-token-abcdefgh";

const config: BridgeConfig = {
  otaPort: 0,
  wsPort: 0,
  publicHost: "127.0.0.1",
  deviceSecret: SECRET,
  allowedDevices: ["b81f3f4a9b01", "b81f3f4a9b02"],
  // Both allowed devices are bound, one persona each (3.2).
  devicePersonas: new Map([
    ["b81f3f4a9b01", "language-partner"],
    ["b81f3f4a9b02", "debate-partner"],
  ]),
  platformUrl: "http://127.0.0.1:4000",
  apiAuthToken: PLATFORM,
  framing: 3,
  serverRate: 24000,
  frameMs: 60,
  historyTurns: 20,
};

/** The device's own hello, as the board sends it: 16000 Hz up, 60 ms frames. */
const deviceHello = {
  type: "hello",
  version: 3,
  transport: "websocket",
  audio_params: { format: "opus", sample_rate: 16000, channels: 1, frame_duration: 60 },
  features: { mcp: false },
};

async function startedServer() {
  const wss = createWsServer(config);
  if (!wss.address()) await once(wss, "listening");
  return {
    wss,
    port: (wss.address() as AddressInfo).port,
    stop() {
      wss.clients.forEach((client) => client.terminate());
      wss.close();
    },
  };
}

/** Connect and report the outcome the firmware would see: a status code. */
async function attempt(port: number, headers: Record<string, string>) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/xiaozhi/v1/`, { headers });
  const status = await new Promise<number>((resolve, reject) => {
    ws.on("open", () => resolve(101));
    // With a listener here, ws reports a refused upgrade as this rather than as
    // an error, which is what lets the status be read.
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("no upgrade outcome within 5 s")), 5_000).unref();
  });
  return { ws, status };
}

async function connectedDevice() {
  const { port, stop } = await startedServer();
  const { ws, status } = await attempt(port, {
    authorization: `Bearer ${deriveToken(SECRET, BOARD)}`,
    "device-id": BOARD,
    "client-id": "test",
  });
  assert.equal(status, 101, "the provisioned device is accepted");

  return {
    ws,
    /** Resolves with the next text frame the server sends. */
    next: () => new Promise<string>((resolve) => ws.once("message", (d) => resolve(d.toString()))),
    stop() {
      ws.terminate();
      stop();
    },
  };
}

describe("the device credential", () => {
  it("refuses a device that presents no credential", async () => {
    const { port, stop } = await startedServer();
    try {
      const { ws, status } = await attempt(port, { "device-id": BOARD });
      assert.equal(status, 401, "no Authorization header is a refusal, not a default device");
      ws.terminate();
    } finally {
      stop();
    }
  });

  it("refuses a device that declares no identifier", async () => {
    const { port, stop } = await startedServer();
    try {
      const { ws, status } = await attempt(port, { authorization: `Bearer ${deriveToken(SECRET, BOARD)}` });
      assert.equal(status, 401);
      ws.terminate();
    } finally {
      stop();
    }
  });

  it("refuses a device the allowlist does not name", async () => {
    const { port, stop } = await startedServer();
    try {
      const stranger = "aa:bb:cc:dd:ee:ff";
      const { ws, status } = await attempt(port, {
        authorization: `Bearer ${deriveToken(SECRET, stranger)}`,
        "device-id": stranger,
      });
      assert.equal(status, 401);
      ws.terminate();
    } finally {
      stop();
    }
  });

  it("refuses the skeleton's shared token, which this bridge did not issue", async () => {
    // The device in the field holds this in NVS from before the allowlist
    // existed. It must stop working, and stop working visibly.
    const { port, stop } = await startedServer();
    try {
      const { ws, status } = await attempt(port, { authorization: "Bearer spike", "device-id": BOARD });
      assert.equal(status, 401);
      ws.terminate();
    } finally {
      stop();
    }
  });

  it("refuses one allowed device's token presented by another", async () => {
    const { port, stop } = await startedServer();
    try {
      const { ws, status } = await attempt(port, {
        authorization: `Bearer ${deriveToken(SECRET, SECOND)}`,
        "device-id": BOARD,
      });
      assert.equal(status, 401, "a token is a statement about one device, not a shared secret");
      ws.terminate();
    } finally {
      stop();
    }
  });

  it("sends any path, since the firmware appends its own", async () => {
    const { port, stop } = await startedServer();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/xiaozhi/v1/anything`, {
        headers: { authorization: `Bearer ${deriveToken(SECRET, BOARD)}`, "device-id": BOARD },
      });
      assert.equal(await once(ws, "open").then(() => 101), 101);
      ws.terminate();
    } finally {
      stop();
    }
  });
});

describe("the device handshake", () => {
  it("answers a client hello with what the firmware waits for", async () => {
    const { ws, next, stop } = await connectedDevice();
    try {
      const reply = next();
      ws.send(JSON.stringify(deviceHello));
      const hello = JSON.parse(await reply) as {
        type: string;
        transport: string;
        session_id: string;
        audio_params: { format: string; sample_rate: number; channels: number; frame_duration: number };
      };

      assert.equal(hello.type, "hello");
      assert.equal(hello.transport, "websocket", "without this the device fails the connect after ten seconds");
      assert.match(hello.session_id, /^s[0-9a-z]+$/, "the session id the bridge names in later messages");
      assert.equal(hello.audio_params.format, "opus");
      assert.equal(hello.audio_params.channels, 1);
      assert.equal(hello.audio_params.sample_rate, 24000, "the reply describes the server's output");
      assert.equal(hello.audio_params.frame_duration, 60);
    } finally {
      stop();
    }
  });

  it("carries no platform credential in the one reply every device receives", async () => {
    // The hello reply is the single message a connecting device is guaranteed to
    // get, which makes it the place a leaked platform credential would be handed
    // out to every device at once. It must carry neither the platform's token nor
    // the secret the device's own token is derived from.
    const { ws, next, stop } = await connectedDevice();
    try {
      const reply = next();
      ws.send(JSON.stringify(deviceHello));
      const raw = await reply;
      assert.ok(!raw.includes(PLATFORM), "the platform's credential must never reach a device");
      assert.ok(!raw.includes(SECRET));
    } finally {
      stop();
    }
  });

  it("declares the server's own rate rather than echoing the device's", async () => {
    // The two differ on this hardware — 16000 Hz up, 24000 Hz down — and the
    // firmware resamples based on the reply, so an echo here plays back at the
    // wrong speed.
    const { ws, next, stop } = await connectedDevice();
    try {
      const reply = next();
      ws.send(JSON.stringify(deviceHello));
      const hello = JSON.parse(await reply) as { audio_params: { sample_rate: number } };
      assert.notEqual(hello.audio_params.sample_rate, deviceHello.audio_params.sample_rate);
    } finally {
      stop();
    }
  });

  it("does not answer audio, so the handshake stays the first reply", async () => {
    // A bridge that acknowledges audio it cannot turn into a turn looks, in the
    // log, exactly like one whose endpointer never fires (6.1).
    const { ws, next, stop } = await connectedDevice();
    try {
      const reply = next();
      ws.send(Buffer.from([0x00, 0x00, 0x00, 0x03, 0xff, 0xff, 0xff]), { binary: true });
      ws.send(JSON.stringify(deviceHello));
      const hello = JSON.parse(await reply) as { type: string };
      assert.equal(hello.type, "hello", "the first thing back is the handshake, not an answer to the audio");
    } finally {
      stop();
    }
  });

  it("survives listen and abort without ending the session", async () => {
    // Neither is implemented (6.4/6.5), and the failure mode to avoid is a
    // skeleton that closes the socket on a message it has not modelled yet.
    const { ws, next, stop } = await connectedDevice();
    try {
      ws.send(JSON.stringify({ type: "listen", state: "start", mode: "manual" }));
      ws.send(JSON.stringify({ type: "abort", reason: "wake_word_detected" }));
      ws.send(JSON.stringify({ type: "mcp", payload: { id: 1 } }));

      const reply = next();
      ws.send(JSON.stringify(deviceHello));
      const hello = JSON.parse(await reply) as { session_id: string };
      assert.match(hello.session_id, /^s[0-9a-z]+$/);
      assert.equal(ws.readyState, WebSocket.OPEN, "the socket is still usable for the next turn");
    } finally {
      stop();
    }
  });

  it("accepts an unparsable frame without dropping the connection", async () => {
    const { ws, next, stop } = await connectedDevice();
    try {
      ws.send("not json at all");
      const reply = next();
      ws.send(JSON.stringify(deviceHello));
      const hello = JSON.parse(await reply) as { type: string };
      assert.equal(hello.type, "hello");
    } finally {
      stop();
    }
  });
});
