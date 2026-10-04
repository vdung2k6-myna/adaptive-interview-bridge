import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import OpusScript from "opusscript";
import { WebSocket } from "ws";
import type { BridgeConfig } from "../src/config.js";
import { createConversations } from "../src/conversation.js";
import { deriveToken } from "../src/credentials.js";
import { createPersonaCatalog } from "../src/personas.js";
import { createWsServer } from "../src/server/ws.js";

/**
 * The whole speech path, with no device in it.
 *
 * `speech.test.ts` asserts what `speak` puts on the wire, and this asserts that
 * anything reaches it — that a `listen start` becomes a turn, that the turn
 * carries the configured text and the deployment's language, that the platform's
 * stream reaches the speaker sentence by sentence, and that what leaves the
 * socket is Opus a decoder can decode at the rate the hello promised.
 *
 * That is worth a stub for one reason: §5 cannot be verified on hardware without
 * a trigger, the trigger cannot be verified without hardware, and between them the
 * first flash would be testing the bridge and the board at once. Everything here
 * is checked offline, so a gadget that stays silent during the flash is a fact
 * about the gadget, the firmware or the network — not about this code.
 *
 * The stub speaks the endpoint's actual wire format, taken from its own call
 * sites: SSE blocks separated by a blank line, `sentence` carrying base64 WAV in
 * `audioData`, and a null there meaning synthesis produced nothing (5.5).
 */

const RATE = 24000;
const FRAME_MS = 60;
const SAMPLES_PER_FRAME = (RATE * FRAME_MS) / 1000;

const BOARD = "b8:1f:3f:4a:9b:01";
const SECRET = "s".repeat(43);
const PLATFORM_TOKEN = "platform-token-abcdefgh";
const VERIFY_TEXT = "Say hello to the room.";

/** One sentence's speech, as the endpoint sends it: a whole WAV, base64'd. */
function sentenceWav(samples: number): string {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * 12000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString("base64");
}

const block = (name: string, payload: unknown) => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;

/** The platform, as far as this bridge can tell: a catalog and a turn stream. */
interface Stub {
  url: string;
  /** Every turn request, as it arrived, so the turn itself can be asserted. */
  turns: { headers: Record<string, string | string[] | undefined>; body: string }[];
  close(): Promise<void>;
}

/** One `sentence` event as the endpoint sends it: base64 WAV, or null for none. */
interface StubSentence {
  index: number;
  text: string;
  audioData: string | null;
}

/**
 * The default reply: one sentence with audio, and one the synthesiser produced
 * nothing for — 5.5's shape arriving in the middle of a reply that is otherwise
 * spoken, which is where it actually occurs.
 */
const DEFAULT_SENTENCES: StubSentence[] = [
  { index: 0, text: "Hello.", audioData: sentenceWav(SAMPLES_PER_FRAME * 2) },
  { index: 1, text: "Second.", audioData: null },
];

async function stubPlatform(sentences: StubSentence[] = DEFAULT_SENTENCES): Promise<Stub> {
  const turns: Stub["turns"] = [];
  const server: Server = createServer((req, res) => {
    if (req.url === "/api/personas") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify([
          {
            id: "language-partner",
            label: "Language Partner",
            defaultPrompt: "You are a patient language partner.",
            knowledgeTopics: [],
            answerMode: "generate",
          },
        ])
      );
      return;
    }

    if (req.url === "/api/voice-agent/stream") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        turns.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200, { "content-type": "text/event-stream" });
        // A person's side, the reply text, the sentences themselves, then the
        // turn's own end. The transcript exists only in these events — the
        // platform keeps no conversation (4.2) — so the stub has to send them.
        const replyText = sentences.map((s) => s.text).join(" ");
        res.write(block("user", { text: "a person said this" }));
        res.write(block("text", { text: replyText }));
        for (const sentence of sentences) res.write(block("sentence", sentence));
        res.write(block("done", { fullText: replyText }));
        res.end();
      });
      return;
    }

    res.writeHead(404).end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    turns,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function configFor(platformUrl: string): BridgeConfig {
  return {
    otaPort: 0,
    wsPort: 0,
    publicHost: "127.0.0.1",
    deviceSecret: SECRET,
    allowedDevices: ["b81f3f4a9b01"],
    devicePersonas: new Map([["b81f3f4a9b01", "language-partner"]]),
    platformUrl,
    apiAuthToken: PLATFORM_TOKEN,
    framing: 3,
    serverRate: RATE,
    frameMs: FRAME_MS,
    historyTurns: 20,
    language: "english",
    verifyText: VERIFY_TEXT,
  };
}

/** Everything the server says after `listen start`, up to the bracket's close. */
interface Reply {
  control: Record<string, unknown>[];
  frames: Buffer[];
}

function untilStop(ws: WebSocket, ms = 5_000): Promise<Reply> {
  const control: Record<string, unknown>[] = [];
  const frames: Buffer[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no tts stop within ${ms} ms; heard ${JSON.stringify(control)}`)),
      ms
    );
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        frames.push(Buffer.from(data as Buffer));
        return;
      }
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      control.push(msg);
      if (msg.type === "tts" && msg.state === "stop") {
        clearTimeout(timer);
        resolve({ control, frames });
      }
    });
  });
}

/**
 * Wait for something the socket cannot report.
 *
 * A turn with nothing speakable in it sends the device nothing at all, so the
 * only evidence that it finished is on the bridge's own side. Waiting on a
 * condition rather than sleeping makes a turn that never starts fail as itself,
 * with a sentence a reader can act on, instead of as a timeout somewhere else.
 */
async function until(what: string, ok: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A connected, handshaken device, and a stub platform behind it. */
async function rig(sentences?: StubSentence[]) {
  const platform = await stubPlatform(sentences);
  const config = configFor(platform.url);
  const catalog = createPersonaCatalog(config);
  await catalog.refresh();
  const conversations = createConversations(config);

  const wss = createWsServer(config, { catalog, conversations });
  if (!wss.address()) await once(wss, "listening");
  const { port } = wss.address() as AddressInfo;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/xiaozhi/v1/`, {
    headers: {
      authorization: `Bearer ${deriveToken(SECRET, BOARD)}`,
      "device-id": BOARD,
      "client-id": "test",
    },
  });
  await once(ws, "open");

  const hello = new Promise<string>((resolve) => ws.once("message", (d) => resolve(d.toString())));
  ws.send(
    JSON.stringify({
      type: "hello",
      version: 3,
      transport: "websocket",
      audio_params: { format: "opus", sample_rate: 16000, channels: 1, frame_duration: 60 },
      features: { mcp: false },
    })
  );
  await hello;

  return {
    platform,
    ws,
    conversations,
    async stop() {
      ws.terminate();
      wss.clients.forEach((c) => c.terminate());
      wss.close();
      await platform.close();
    },
  };
}

describe("a listen start becomes a spoken reply", () => {
  it("takes a turn, speaks it, and closes the bracket", async () => {
    const { ws, platform, stop } = await rig();
    try {
      const reply = untilStop(ws);
      ws.send(JSON.stringify({ type: "listen", state: "start", mode: "auto" }));
      const { control, frames } = await reply;

      assert.deepEqual(
        control.filter((m) => m.type === "tts"),
        [
          { type: "tts", state: "start" },
          // Only the sentence that carried audio is announced (5.4). The second
          // sentence of this reply has none, and its absence here is the point:
          // the display must not name words the device is not about to say.
          { type: "tts", state: "sentence_start", text: "Hello." },
          { type: "tts", state: "stop" },
        ],
        "one bracket for the turn, opened before the audio and closed after it, announcing each spoken sentence"
      );
      assert.ok(frames.length > 0, "the sentence carrying audio was spoken");
      assert.equal(platform.turns.length, 1, "exactly one turn was sent");
    } finally {
      await stop();
    }
  });

  it("sends the turn the endpoint expects, with the deployment's language", async () => {
    const { ws, platform, stop } = await rig();
    try {
      const reply = untilStop(ws);
      ws.send(JSON.stringify({ type: "listen", state: "start", mode: "auto" }));
      await reply;

      const [turn] = platform.turns;
      assert.ok(turn, "the turn reached the platform");
      // The fields are asserted from the body the stub received rather than from
      // the bridge's own form builder, because the browser's shape is what the
      // endpoint parses — and the language is the one field whose absence fails
      // silently (D12).
      assert.match(turn.body, /name="language"\r?\n\r?\nenglish/, "the language is declared on the turn");
      assert.match(turn.body, /name="speak"\r?\n\r?\n1/, "the turn asks for speech");
      assert.match(turn.body, /name="text"\r?\n\r?\nSay hello to the room\./, "the trigger's own text is what was sent");
      assert.match(turn.body, /You are a patient language partner\./, "the persona's prompt is on the turn");
      assert.equal(turn.headers.authorization, `Bearer ${PLATFORM_TOKEN}`, "the platform's credential, not a device's");
    } finally {
      await stop();
    }
  });

  it("sends Opus the device can decode at the rate the hello promised", async () => {
    const { ws, stop } = await rig();
    try {
      const reply = untilStop(ws);
      ws.send(JSON.stringify({ type: "listen", state: "start", mode: "auto" }));
      const { frames } = await reply;

      // Unfold first: a framed packet handed to a decoder returns quiet garbage
      // rather than throwing, which is the failure the rig lost three turns to.
      const payloads = frames.map((wire) => {
        assert.equal(wire.readUInt8(0), 0, "framing v3, type 0: Opus");
        assert.equal(wire.readUInt16BE(2), wire.length - 4, "the header declares what it carries");
        return wire.subarray(4);
      });

      const decoder = new OpusScript(RATE, 1, OpusScript.Application.AUDIO);
      try {
        const pcm = Buffer.concat(payloads.map((p) => decoder.decode(p)));
        assert.equal(pcm.length, frames.length * SAMPLES_PER_FRAME * 2, "each frame decodes to one declared frame");
        let peak = 0;
        for (let i = 0; i < pcm.length / 2; i++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i * 2)));
        assert.ok(peak > 11_000, `the tone survived the round trip (peak ${peak} of 12000)`);
      } finally {
        decoder.delete();
      }
    } finally {
      await stop();
    }
  });

  it("puts the turn into the device's conversation, so the next turn has a history", async () => {
    const { ws, conversations, stop } = await rig();
    try {
      const reply = untilStop(ws);
      ws.send(JSON.stringify({ type: "listen", state: "start", mode: "auto" }));
      await reply;

      assert.deepEqual(
        conversations.history("b81f3f4a9b01"),
        [
          { role: "user", content: "a person said this" },
          { role: "agent", content: "Hello. Second." },
        ],
        "both sides of the exchange, taken from the stream and the reply"
      );
    } finally {
      await stop();
    }
  });

  it("takes no turn at all when no verify text is configured", async () => {
    // The scaffolding's own switch: a deployment leaves it unset, and a listen
    // start must then do nothing rather than take a turn nobody asked for.
    const platform = await stubPlatform();
    const config = configFor(platform.url);
    delete (config as { verifyText?: string }).verifyText;
    const catalog = createPersonaCatalog(config);
    await catalog.refresh();

    const wss = createWsServer(config, { catalog, conversations: createConversations(config) });
    if (!wss.address()) await once(wss, "listening");
    const { port } = wss.address() as AddressInfo;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/xiaozhi/v1/`, {
      headers: { authorization: `Bearer ${deriveToken(SECRET, BOARD)}`, "device-id": BOARD },
    });
    await once(ws, "open");
    const heard: string[] = [];
    ws.on("message", (d, isBinary) => {
      if (!isBinary) heard.push(d.toString());
    });

    try {
      ws.send(JSON.stringify({ type: "listen", state: "start", mode: "auto" }));
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(heard, [], "nothing was said to the device");
      assert.equal(platform.turns.length, 0, "and no turn was sent");
    } finally {
      ws.terminate();
      wss.clients.forEach((c) => c.terminate());
      wss.close();
      await platform.close();
    }
  });

  it("completes a reply with nothing speakable in it and takes a further turn (5.5)", async () => {
    // A reply of only a code block. The platform's `stripMarkdown` keeps a code
    // block's content, so this is not "empty" — but it holds no letter, which is
    // what makes it unspeakable, and the synthesiser then produces nothing. The
    // sentence arrives with `audioData: null` all the same.
    const { ws, platform, conversations, stop } = await rig([
      { index: 0, text: "```\n1234 +-\n```", audioData: null },
    ]);
    try {
      const heard: string[] = [];
      ws.on("message", (d) => heard.push(d.toString()));

      ws.send(JSON.stringify({ type: "listen", state: "start", mode: "auto" }));
      // The socket is told nothing, so the turn's completion has to be read off
      // the bridge: a turn whose reply reached the conversation has been served.
      await until("the silent turn to be served", () => conversations.history("b81f3f4a9b01").length > 0);

      // Nothing was said and nothing was even bracketed: a `tts start` around no
      // audio would leave the device in `speaking`, where the firmware discards
      // whatever the person says next, and a `tts stop` would close a bracket
      // that was never opened.
      assert.deepEqual(heard, [], "a reply with nothing speakable sent the device no tts at all");
      assert.equal(platform.turns.length, 1, "the turn itself still happened and was recorded");

      // The half of 5.5 that a silent turn could quietly break: the turn is over,
      // so the socket is still a session. A `listen start` arriving now must be
      // served rather than dropped as talking over a reply that is not playing —
      // "completing the turn" without this is a device that answers once and
      // then never again.
      ws.send(JSON.stringify({ type: "listen", state: "start", mode: "auto" }));
      await until("a second turn on the same socket", () => platform.turns.length === 2);
      assert.deepEqual(heard, [], "and the second turn had nothing to say either");
    } finally {
      await stop();
    }
  });
});
