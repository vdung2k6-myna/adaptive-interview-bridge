import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { ENDPOINTER_DEFAULTS, type BridgeConfig } from "../src/config.js";
import { createConversations } from "../src/conversation.js";
import { deriveToken } from "../src/credentials.js";
import { createPersonaCatalog } from "../src/personas.js";
import { createWsServer } from "../src/server/ws.js";
import { frame } from "../src/protocol/framing.js";
import { encodeOpusFrames } from "../src/protocol/opus.js";
import { buildWav } from "../src/protocol/wav.js";

/**
 * A spoken turn, from the person's voice to the gadget's answer.
 *
 * Everything else in this suite tests one half of the path against a stub shaped
 * like the other. This is the only file where the halves meet: a real socket, real
 * Opus frames, a real endpointer deciding, a real turn on the wire, and real audio
 * coming back. The pieces it exercises — 6.1's trim, 6.2's transcription, 6.4's
 * close, 6.5's cancel, 6.6's drain window — are each asserted where they can be
 * observed from the device's side, which is the side that can be trusted to say
 * whether any of it happened.
 *
 * The stub platform is a real HTTP server, for the reason the rest of the suite
 * gives: what is being pinned is what leaves this process, and a mock would only
 * report what it was told to expect.
 */

const BOARD = "b8:1f:3f:4a:9b:01";
const DEVICE = "b81f3f4a9b01";
const SECRET = "s".repeat(43);
const PLATFORM = "platform-token-abcdefgh";

const CATALOG = [
  {
    id: "language-partner",
    label: "Language Partner",
    emoji: "\u{1f5e3}",
    defaultPrompt: "You are a patient language partner.",
    knowledgeTopics: ["Truyện cười"],
    answerMode: "generate",
  },
];

const RATE = ENDPOINTER_DEFAULTS.deviceRate;
const FRAME_MS = 60;
const SAMPLES_PER_FRAME = (RATE * FRAME_MS) / 1000;
/** One frame, as the device sends it: Opus payload, then the framing header. */
function wire(amplitude: number): Buffer {
  const pcm = Buffer.alloc(SAMPLES_PER_FRAME * 2);
  for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
    pcm.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE)), i * 2);
  }
  const [packet] = encodeOpusFrames(pcm, 1, { sampleRate: RATE, frameMs: FRAME_MS });
  return frame(packet!, 3);
}
const SPEECH = wire(12000);
const ROOM = wire(400);

/** How long a reply's audio runs, which is also how long the device plays it. */
const REPLY_SECONDS = 0.3;

/** The platform's own speech, as the `sentence` event carries it: base64 WAV. */
function sentenceAudio(seconds: number): string {
  const samples = new Int16Array(Math.round(24000 * seconds));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(6000 * Math.sin((2 * Math.PI * 300 * i) / 24000));
  }
  return buildWav(samples, 24000).toString("base64");
}

function sse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

interface PlatformRequest {
  path: string;
  body: Buffer;
}

/** A platform that answers the catalog and, per call, a scripted reply stream. */
async function stubPlatform(
  reply: (res: ServerResponse, call: number) => void | Promise<void>
): Promise<{ url: string; requests: PlatformRequest[]; stop(): void }> {
  const requests: PlatformRequest[] = [];
  let calls = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if ((req.url ?? "").startsWith("/api/personas")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(CATALOG));
        return;
      }
      requests.push({ path: req.url ?? "", body });
      void reply(res, calls++);
    });
  });
  server.listen(0, "127.0.0.1");
  if (!server.address()) await once(server, "listening");
  return {
    requests,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop() {
      server.closeAllConnections();
      server.close();
    },
  };
}

function configFor(platformUrl: string): BridgeConfig {
  return {
    otaPort: 0,
    wsPort: 0,
    publicHost: "127.0.0.1",
    deviceSecret: SECRET,
    allowedDevices: [DEVICE],
    devicePersonas: new Map([[DEVICE, "language-partner"]]),
    platformUrl,
    apiAuthToken: PLATFORM,
    framing: 3,
    serverRate: 24000,
    frameMs: FRAME_MS,
    ...ENDPOINTER_DEFAULTS,
    historyTurns: 20,
    language: "english",
  };
}

interface Session {
  send(message: Record<string, unknown>): void;
  speak(): void;
  /** Wait out a reply of this length actually being played (6.6, below). */
  played(seconds: number): Promise<void>;
  messages: string[];
  binaries: Buffer[];
  until(predicate: () => boolean, what: string, ms?: number): Promise<void>;
  stop(): void;
}

async function spokenDevice(config: BridgeConfig): Promise<Session> {
  const wss = createWsServer(config, {
    catalog: createPersonaCatalog(config),
    conversations: createConversations(config),
  });
  if (!wss.address()) await once(wss, "listening");
  const port = (wss.address() as AddressInfo).port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/xiaozhi/v1/`, {
    headers: { authorization: `Bearer ${deriveToken(SECRET, BOARD)}`, "device-id": BOARD },
  });
  await once(ws, "open");

  const messages: string[] = [];
  const binaries: Buffer[] = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) binaries.push(Buffer.from(data as ArrayBuffer));
    else messages.push(data.toString());
    for (const wake of waiters.splice(0)) wake();
  });

  const typed = (): Array<Record<string, unknown>> => messages.map((m) => JSON.parse(m) as Record<string, unknown>);
  const countOf = (type: string, state?: string): number =>
    typed().filter((m) => m.type === type && (state === undefined || m.state === state)).length;

  return {
    messages,
    binaries,
    send: (message) => ws.send(JSON.stringify(message)),
    /** One utterance: room tone, a person speaking, then the silence that closes it. */
    speak() {
      for (let i = 0; i < 40; i++) ws.send(ROOM, { binary: true });
      for (let i = 0; i < 6; i++) ws.send(SPEECH, { binary: true });
      for (let i = 0; i < Math.round(ENDPOINTER_DEFAULTS.vadSilenceMs / FRAME_MS); i++) {
        ws.send(ROOM, { binary: true });
      }
    },
    async until(predicate, what, ms = 5_000) {
      const deadline = Date.now() + ms;
      while (!predicate()) {
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new Error(`timed out waiting for ${what}; the server sent ${JSON.stringify(messages)}`);
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, left).unref();
        });
      }
      void countOf;
    },
    /**
     * The device plays a reply over the wall clock, not over the socket: the frames
     * go out in about a millisecond, but the person hears them over the next however
     * many seconds. The bridge's drain estimate is anchored the same way (D10), so a
     * test that sends a reply and immediately speaks again is asking about a device
     * that plays a two-second reply in zero seconds — and the drain guard (6.6) drops
     * everything the person says in answer to it.
     */
    played(seconds) {
      return new Promise((resolve) =>
        setTimeout(resolve, seconds * 1000 + ENDPOINTER_DEFAULTS.drainGuardMs + 150).unref()
      );
    },
    stop() {
      ws.terminate();
      wss.clients.forEach((client) => client.terminate());
      wss.close();
    },
  };
}

/** The turn's own WAV, read back out of the multipart body the platform received. */
function uploadedSeconds(request: PlatformRequest): number {
  const at = request.body.indexOf("RIFF", 0, "latin1");
  assert.ok(at > 0, "the turn carried an audio file");
  const declared = request.body.readUInt32LE(at + 40);
  return declared / 2 / RATE;
}

describe("a person speaks to the gadget", () => {
  it("turns the utterance into a reply, and says what it heard", async () => {
    const platform = await stubPlatform((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("user", { text: "toi muon hoc tieng anh" }));
      res.write(sse("sentence", { index: 0, text: "Chao ban.", audioData: sentenceAudio(REPLY_SECONDS) }));
      res.write(sse("done", { fullText: "Chao ban." }));
      res.end();
    });
    const device = await spokenDevice(configFor(platform.url));
    try {
      device.send({ type: "hello", version: 3, transport: "websocket" });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");

      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();

      await device.until(
        () => device.messages.some((m) => JSON.parse(m).type === "tts" && JSON.parse(m).state === "stop"),
        "the reply's bracket to close"
      );

      const typed = device.messages.map((m) => JSON.parse(m) as Record<string, unknown>);

      // 6.2 — what the platform heard, back to the device, from the stream's own
      // `user` event rather than from a transcription the bridge made itself.
      const stt = typed.find((m) => m.type === "stt");
      assert.ok(stt, "the device is told what was heard");
      assert.equal(stt.text, "toi muon hoc tieng anh");

      // 5.2/5.4 — the bracket, and the sentence named inside it.
      assert.equal(typed.filter((m) => m.state === "start").length, 1, "one bracket per reply");
      assert.equal(typed.filter((m) => m.state === "sentence_start").length, 1);
      assert.ok(device.binaries.length > 0, "and the reply's audio, inside it");

      // 6.1 — the utterance, not the window it was spoken into. The window ran 61
      // frames (3.66 s); the upload is that utterance trimmed back from the last
      // voiced frame plus the silence that closed it, which is well under two seconds.
      assert.equal(platform.requests.length, 1);
      const seconds = uploadedSeconds(platform.requests[0]!);
      assert.ok(seconds > 0.4, `${seconds}s is too short to hold the utterance`);
      assert.ok(seconds < 3.0, `${seconds}s was uploaded out of a 3.66s window`);
      assert.match(platform.requests[0]!.body.toString("latin1"), /filename="turn\.wav"/);
    } finally {
      device.stop();
      platform.stop();
    }
  });

  it("keeps the second turn its own, not a prefix grown by the first", async () => {
    // 6.1's own warning, and the rig's run 10: a window that was never cleared makes
    // every turn after the first upload everything since `listen start`, which the
    // transcriber answers with invented text (D11). Both turns here are the same
    // utterance, so the second upload must measure the same as the first rather than
    // carrying the first one's window along with it.
    const platform = await stubPlatform((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("user", { text: "mot" }));
      res.write(sse("sentence", { index: 0, text: "vang", audioData: sentenceAudio(REPLY_SECONDS) }));
      res.write(sse("done", { fullText: "vang" }));
      res.end();
    });
    const device = await spokenDevice(configFor(platform.url));
    try {
      device.send({ type: "hello", version: 3, transport: "websocket" });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");

      for (let turn = 1; turn <= 2; turn++) {
        device.send({ type: "listen", state: "start", mode: "manual" });
        device.speak();
        await device.until(() => platform.requests.length === turn, `turn ${turn} to reach the platform`);
        await device.until(
          () =>
            device.messages.filter((m) => JSON.parse(m).state === "stop").length === turn,
          `turn ${turn}'s bracket to close`
        );
        await device.played(REPLY_SECONDS);
      }

      const first = uploadedSeconds(platform.requests[0]!);
      const second = uploadedSeconds(platform.requests[1]!);
      // A window that was never cleared would put everything since the first
      // `listen start` into the second upload — the first utterance, the reply that
      // followed it, and the room tone around both.
      assert.ok(
        Math.abs(second - first) < 0.2,
        `${second}s on the second turn against ${first}s on the first`
      );
    } finally {
      device.stop();
      platform.stop();
    }
  });
  it("tells the device when the platform refused the turn, and the device carries on", async () => {
    // 4.4. A refusal arrives over an HTTP 200, long after the turn began, so the
    // status line cannot carry it and the log is not who asked the question. The
    // device is told, and — the half that is easy to lose — it is still able to take
    // the next turn: the answer is delivered from the turn's `finally`, so a refusal
    // spends that turn and not the conversation.
    const platform = await stubPlatform((res, call) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (call === 0) {
        res.write(sse("notice", { code: "no_speech", message: "No speech detected." }));
      } else if (call === 1) {
        res.write(sse("error", { message: "systemPrompt is required" }));
      } else {
        res.write(sse("user", { text: "the third time" }));
        res.write(sse("done", { fullText: "ok" }));
      }
      res.end();
    });
    const device = await spokenDevice(configFor(platform.url));
    try {
      device.send({ type: "hello", version: 3, transport: "websocket" });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");

      for (let turn = 1; turn <= 3; turn++) {
        device.send({ type: "listen", state: "start", mode: "manual" });
        device.speak();
        await device.until(() => platform.requests.length === turn, `turn ${turn} to reach the platform`);
      }

      const alerts = device.messages
        .map((m) => JSON.parse(m) as Record<string, unknown>)
        .filter((m) => m.type === "alert");
      assert.deepEqual(
        alerts.map((a) => [a.status, a.message]),
        [
          ["Notice", "No speech detected."],
          ["Error", "systemPrompt is required"],
        ],
        "each refusal reaches the device, named as the platform named it"
      );
      // The replies carried no sentences, so nothing was ever spoken and there is no
      // drain window to wait out: the third turn follows the second immediately and
      // is served, which is the device having recovered rather than merely answered.
      assert.ok(
        device.messages.some((m) => m.includes("the third time")),
        "and the turn after the refusals was taken and transcribed"
      );
    } finally {
      device.stop();
      platform.stop();
    }
  });
});

describe("the wake word during a reply", () => {
  it("cancels the turn at its source, and records the question it interrupted", async () => {
    // 6.5. Three claims, each observed on the device's side.
    //
    // The cancel is on the source, not the sink: the abort reaches the platform
    // request, so a reply still being produced stops, and the sentences after it are
    // never spoken. What that looks like from the device is the second sentence of a
    // reply that was still generating — the one thing a bridge with no handler keeps
    // announcing, sentence by sentence, to a screen nobody is listening to (D15).
    //
    // The turn ends rather than fails: no `alert` is sent, because an abort raised as
    // an error would reach the dispatcher as a failure on every barge-in.
    //
    // And the person's own question survives it: `takeTurn` records the exchange, so
    // the next turn's `history` carries what they asked before they interrupted —
    // the half that certainly happened, and the half an abort-as-exception erases.
    const INTERRUPTED = "ke cho toi mot cau chuyen";
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived = (): void => undefined;
    const firstSentence = new Promise<void>((resolve) => {
      arrived = resolve;
    });

    const platform = await stubPlatform(async (res, call) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (call > 0) {
        res.write(sse("user", { text: "va bay gio" }));
        res.write(sse("done", { fullText: "ok" }));
        res.end();
        return;
      }
      res.write(sse("user", { text: INTERRUPTED }));
      res.write(sse("sentence", { index: 0, text: "Ngay xua...", audioData: sentenceAudio(REPLY_SECONDS) }));
      arrived();
      // The platform holds the reply open, as it would while still generating it.
      await gate;
      res.write(sse("sentence", { index: 1, text: "va roi...", audioData: sentenceAudio(REPLY_SECONDS) }));
      res.write(sse("done", { fullText: "Ngay xua... va roi..." }));
      res.end();
    });

    const device = await spokenDevice(configFor(platform.url));
    try {
      device.send({ type: "hello", version: 3, transport: "websocket" });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");

      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();
      await firstSentence;
      await device.until(() => device.binaries.length > 0, "the first sentence's audio to reach the device");

      device.send({ type: "listen", state: "detect", text: "Hi XiaoZhi" });
      device.send({ type: "abort", reason: "wake_word_detected" });
      release();

      await device.until(
        () => device.messages.some((m) => JSON.parse(m).type === "tts" && JSON.parse(m).state === "stop"),
        "the cancelled turn's bracket to close"
      );
      // The turn unwinds asynchronously, so let the released stream have been read to
      // its end before counting what was spoken. If the abort did not reach the
      // request, the second sentence arrives in this window.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const typed = (): Array<Record<string, unknown>> => device.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
      assert.deepEqual(
        typed().filter((m) => m.state === "sentence_start").map((m) => m.text),
        ["Ngay xua..."],
        "the interrupted sentence was the last one spoken from that reply"
      );
      assert.deepEqual(
        typed().filter((m) => m.type === "alert"),
        [],
        "the turn ended; it did not fail"
      );

      // The wake word's own `listen start` opens the next window, and the turn from
      // it comes once the device has finished playing what it had already queued.
      await device.played(REPLY_SECONDS);
      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();
      await device.until(() => platform.requests.length === 2, "the next turn to be served");

      const history = platform.requests[1]!.body.toString("latin1");
      assert.match(
        history,
        new RegExp(`"role":"user","content":"${INTERRUPTED}"`),
        "the question the person was cut off asking is still in the conversation"
      );
    } finally {
      device.stop();
      platform.stop();
    }
  });
});
