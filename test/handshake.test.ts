import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { BridgeConfig } from "../src/config.js";
import { createWsServer } from "../src/server/ws.js";

/**
 * The handshake is the whole of task 2.1's acceptance on the server side: a
 * device connects, says hello, and gets an answer it accepts. The firmware's
 * acceptance is unforgiving in one specific way — `transport` missing from the
 * reply means the connect fails ten seconds later with nothing logged here — so
 * these tests assert the reply's fields individually rather than its shape.
 */
const config: BridgeConfig = {
  otaPort: 0,
  wsPort: 0,
  publicHost: "127.0.0.1",
  token: "test-token",
  framing: 3,
  serverRate: 24000,
  frameMs: 60,
};

/** The device's own hello, as the board sends it: 16000 Hz up, 60 ms frames. */
const deviceHello = {
  type: "hello",
  version: 3,
  transport: "websocket",
  audio_params: { format: "opus", sample_rate: 16000, channels: 1, frame_duration: 60 },
  features: { mcp: false },
};

async function connectedDevice() {
  const wss = createWsServer(config);
  if (!wss.address()) await once(wss, "listening");
  const port = (wss.address() as AddressInfo).port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/xiaozhi/v1/`, {
    headers: { authorization: `Bearer ${config.token}`, "device-id": "aa:bb:cc:dd:ee:ff" },
  });
  await once(ws, "open");

  return {
    ws,
    /** Resolves with the next text frame the server sends. */
    next: () => new Promise<string>((resolve) => ws.once("message", (d) => resolve(d.toString()))),
    stop() {
      ws.terminate();
      wss.close();
    },
  };
}

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
