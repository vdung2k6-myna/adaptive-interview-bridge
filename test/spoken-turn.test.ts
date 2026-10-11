import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
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
/** The directory of tracks the bridge plays from, where a test gives it one. Empty in the
 *  default config, which is a deployment with no music at all. */
const MUSIC = fileURLToPath(new URL("./fixtures/music", import.meta.url));
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
): Promise<{
  url: string;
  requests: PlatformRequest[];
  /** What the bridge reported back about the gadget tools a turn asked for, in order. */
  toolResults: Array<Record<string, unknown>>;
  stop(): void;
}> {
  const requests: PlatformRequest[] = [];
  const toolResults: Array<Record<string, unknown>> = [];
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
      // The turn holding its stream open for a gadget call answers here, and is not one of the
      // turn's own requests: it carries no audio and the scripted `reply` has nothing to say to it.
      if ((req.url ?? "").includes("/tool-result")) {
        toolResults.push(JSON.parse(body.toString("utf8")) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ settled: true }));
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
    toolResults,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop() {
      server.closeAllConnections();
      server.close();
    },
  };
}

function configFor(platformUrl: string, overrides: Partial<BridgeConfig> = {}): BridgeConfig {
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
    sessionIdleMs: 60000,
    musicDir: "",
    historyTurns: 20,
    commandStep: 10,
    language: "english",
    ...overrides,
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
  /** The code the bridge's end of the socket closed with, or null while it is open.
   *  A bridge that ends the session itself closes with 1000; a test tearing the socket
   *  down sees 1006. Without the code the two are the same event, and "the session was
   *  ended" would pass on a test that ended it. */
  closeCode(): number | null;
  /** Resolves with that code once the socket closes, whoever closed it. */
  closed: Promise<number>;
  /** One frame, as the device sends it, for a test that needs the uplink alive over
   *  wall-clock time — which is what the endpointer's own clocks measure against. */
  raw(frame: Buffer): void;
  stop(): void;
}

/** What a bridge holds between sockets: the persona catalog it reads and the
 *  conversations it keeps. Passed in so a test can hand two sessions the same ones —
 *  which is what makes "the conversation outlives the session" a thing that can be
 *  observed rather than assumed. */
type BridgeServices = Parameters<typeof createWsServer>[1];

async function spokenDevice(
  config: BridgeConfig,
  services: BridgeServices = { catalog: createPersonaCatalog(config), conversations: createConversations(config) }
): Promise<Session> {
  const wss = createWsServer(config, services);
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

  let closeCode: number | null = null;
  let onClose: (code: number) => void = () => {};
  const closed = new Promise<number>((resolve) => {
    onClose = resolve;
  });
  ws.on("close", (code) => {
    closeCode = code;
    onClose(code);
  });

  const typed = (): Array<Record<string, unknown>> => messages.map((m) => JSON.parse(m) as Record<string, unknown>);
  const countOf = (type: string, state?: string): number =>
    typed().filter((m) => m.type === type && (state === undefined || m.state === state)).length;

  return {
    messages,
    binaries,
    send: (message) => ws.send(JSON.stringify(message)),
    raw: (frame) => ws.send(frame, { binary: true }),
    /** One utterance: room tone, a person speaking, then the silence that closes it. */
    speak() {
      // The shortest run of speech the endpointer will close a turn on, taken from the
      // knob rather than written down: this file's whole subject is the path a real
      // utterance takes, so it has to clear whatever minimum the bridge actually ships.
      // It was a literal 6 frames, which stopped being an utterance when the minimum
      // rose to 500 ms.
      const speechFrames = Math.ceil(ENDPOINTER_DEFAULTS.vadMinSpeechMs / FRAME_MS);
      for (let i = 0; i < 40; i++) ws.send(ROOM, { binary: true });
      for (let i = 0; i < speechFrames; i++) ws.send(SPEECH, { binary: true });
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
    closeCode: () => closeCode,
    closed,
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

      // 6.1 — the utterance, not the window it was spoken into. The window ran 64
      // frames (3.84 s); the upload is that utterance trimmed back from the last
      // voiced frame plus the silence that closed it, which is well under two seconds.
      assert.equal(platform.requests.length, 1);
      const seconds = uploadedSeconds(platform.requests[0]!);
      assert.ok(seconds > 0.4, `${seconds}s is too short to hold the utterance`);
      assert.ok(seconds < 3.0, `${seconds}s was uploaded out of a 3.84s window`);
      assert.match(platform.requests[0]!.body.toString("latin1"), /filename="turn\.wav"/);
    } finally {
      device.stop();
      platform.stop();
    }
  });

  it("names every sentence of a reply, in order, as it is heard (5.4)", async () => {
    // The other half of what a track taught, and the behaviour that must not have changed: a
    // reply's sentences are each a thing spoken, so each is named, where a track is one thing
    // spoken and is named once. Both reach the device down the same path — the difference is in
    // what the caller hands the speaker, not in the speaker.
    const platform = await stubPlatform((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("user", { text: "ke cho toi mot cau chuyen" }));
      res.write(sse("sentence", { index: 0, text: "Ngay xua...", audioData: sentenceAudio(REPLY_SECONDS) }));
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

      await device.until(
        () => device.messages.some((m) => JSON.parse(m).type === "tts" && JSON.parse(m).state === "stop"),
        "the reply's bracket to close"
      );

      const typed = device.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
      assert.deepEqual(
        typed.filter((m) => m.state === "sentence_start").map((m) => m.text),
        ["Ngay xua...", "va roi..."],
        "a sentence of a reply is named as it is heard; only a track's later pieces say nothing"
      );
      assert.equal(typed.filter((m) => m.state === "start").length, 1, "still one bracket per reply");
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

  it("asks the turn with the gadget's own condition, having read it at the handshake", async () => {
    // 2.1 and 2.2, end to end and through the real socket. The board's hello is the
    // only place its tool channel is mentioned (D1), so everything after it is the
    // bridge asking: the handshake, the catalog, and — new here — the gadget's own
    // status, which is what a turn is asked with so that a reply may account for a
    // gadget that is nearly flat rather than describing one at full battery.
    const status = {
      audio_speaker: { volume: 42 },
      screen: { brightness: 68, theme: "dark" },
      battery: { level: 12, charging: false },
      network: { type: "wifi", ssid: "nha", signal: "weak" },
    };
    const platform = await stubPlatform((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("user", { text: "how are you" }));
      res.write(sse("done", { fullText: "ok" }));
      res.end();
    });
    const device = await spokenDevice(configFor(platform.url));
    try {
      device.send({ type: "hello", version: 3, transport: "websocket", features: { mcp: true, glyph_push: true } });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");

      const { replyTo } = gadgetSide(device);

      await replyTo("initialize", { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "xiaozhi-s3", version: "1.0.0" } });
      await replyTo("tools/list", {
        tools: [{ name: "self.get_device_status", description: "…", inputSchema: { type: "object", properties: {} } }],
        nextCursor: "",
      });
      await replyTo("tools/call", {
        content: [{ type: "text", text: JSON.stringify(status) }],
        isError: false,
      });

      // The condition is held from the reply, which the bridge reads off the socket
      // and into the session on its own turn of the loop: the frames above are
      // written and answered, and the session still has to look at them.
      await new Promise((resolve) => setTimeout(resolve, 50));

      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();
      await device.until(() => platform.requests.length === 1, "the turn to reach the platform");

      // The platform's own view of the turn: the persona's words, and the gadget's
      // report after them. Nothing between the two is the bridge's.
      const body = platform.requests[0]!.body.toString("utf8").replace(/\r\n/g, "\n");
      const at = body.indexOf('name="systemPrompt"');
      assert.ok(at > 0, "the turn carried a systemPrompt");
      const prompt = body.slice(body.indexOf("\n\n", at) + 2, body.indexOf("\n--", at));
      assert.ok(
        prompt.startsWith("You are a patient language partner."),
        `the persona's own words still open the prompt: ${prompt}`
      );
      assert.match(prompt, /speaker volume 42 of 100/);
      assert.match(prompt, /brightness 68 of 100, theme dark/);
      assert.match(prompt, /battery 12%, not charging/);
      assert.match(prompt, /network wifi "nha", signal weak/);
      assert.ok(!/nearly flat|low battery/i.test(prompt), `the bridge added no reading of its own: ${prompt}`);
    } finally {
      device.stop();
      platform.stop();
    }
  });

  it("asks the turn with the gadget's own catalogue, schema and all", async () => {
    // The half of D3 that only a session can show: the catalogue the model will decide from
    // is the one this gadget reported on this socket, carried as the gadget gave it. `args`
    // is what the bridge clamps a relative command against; the platform has no use for it,
    // and sending it would be a second copy of what `inputSchema` already says.
    const tool = {
      name: "self.audio_speaker.set_volume",
      description: "Set the volume of the audio speaker.",
      inputSchema: { type: "object", properties: { volume: { type: "integer", minimum: 0, maximum: 100 } } },
    };
    const platform = await stubPlatform((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("user", { text: "toi noi gi" }));
      res.write(sse("done", { fullText: "ok" }));
      res.end();
    });
    const device = await spokenDevice(configFor(platform.url, { musicDir: MUSIC }));
    try {
      device.send({ type: "hello", version: 3, transport: "websocket", features: { mcp: true, glyph_push: true } });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");

      const { replyTo } = gadgetSide(device);
      await replyTo("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: { name: "xiaozhi-s3", version: "1.0.0" },
      });
      await replyTo("tools/list", { tools: [tool], nextCursor: "" });
      await new Promise((resolve) => setTimeout(resolve, 50));

      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();
      await device.until(() => platform.requests.length === 1, "the turn to be served");

      const body = platform.requests[0]!.body.toString("latin1");
      assert.match(body, /name="tools"/, "the turn carries the gadget's catalogue");
      assert.match(body, /self\.audio_speaker\.set_volume/, "and the entry is the gadget's own");
      assert.match(body, /"inputSchema"/, "with the schema the gadget sent rather than one rebuilt here");
      assert.ok(!/"args"/.test(body), "and without this bridge's reading of that schema");

      // And the bridge's own tools travel in the same field, under names that say so. The platform
      // is told nothing about the difference: it passes an array it already passed, and a call
      // naming `bridge.` comes back to a sink that answers it here instead of forwarding it (4.2).
      assert.match(body, /bridge\.play_music/, "the bridge's own tool sits beside the gadget's");
      assert.match(body, /bridge\.stop_music/);
    } finally {
      device.stop();
      platform.stop();
    }
  });

  it("asks a turn with the bridge's own tools alone when the gadget has none", async () => {
    // The scenario the requirement names: a gadget that advertised nothing is asked with the
    // bridge's tools *rather than* with a catalogue the gadget never gave. Those tools are the
    // bridge's own and belong to no gadget — a call naming one is answered by the bridge's sink
    // and the gadget is neither asked nor told (4.2).
    const platform = await stubPlatform((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("user", { text: "toi noi gi" }));
      res.write(sse("done", { fullText: "ok" }));
      res.end();
    });
    const device = await spokenDevice(configFor(platform.url, { musicDir: MUSIC }));
    try {
      device.send({ type: "hello", version: 3, transport: "websocket" });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");

      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();
      await device.until(() => platform.requests.length === 1, "the turn to be served");

      const body = platform.requests[0]!.body.toString("latin1");
      assert.match(body, /name="tools"/, "the field is there for the bridge's own");
      assert.match(body, /bridge\.play_music/);
      assert.match(body, /bridge\.stop_music/);
      assert.ok(!/self\./.test(body), "and nothing is offered as something this gadget has");
    } finally {
      device.stop();
      platform.stop();
    }
  });

  it("asks a turn with no tools at all when neither the gadget nor the bridge has any", async () => {
    // Absent, not empty. A gadget that advertises no tool channel — which is every device this
    // bridge served before this existed — on a bridge with no music directory: asked for exactly
    // the turn it would have been asked for otherwise, and an empty list would be a different
    // claim from silence.
    const platform = await stubPlatform((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("user", { text: "toi noi gi" }));
      res.write(sse("done", { fullText: "ok" }));
      res.end();
    });
    const device = await spokenDevice(configFor(platform.url));
    try {
      device.send({ type: "hello", version: 3, transport: "websocket" });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");

      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();
      await device.until(() => platform.requests.length === 1, "the turn to be served");

      const body = platform.requests[0]!.body.toString("latin1");
      assert.ok(!body.includes('name="tools"'), "a turn with no tools is asked with no tools field");
    } finally {
      device.stop();
      platform.stop();
    }
  });

  /** The one tool the tests below report, so a name that is *not* in it can be tried. */
  const VOLUME_TOOL = {
    name: "self.audio_speaker.set_volume",
    description: "Set the volume of the audio speaker.",
    inputSchema: { type: "object", properties: { volume: { type: "integer", minimum: 0, maximum: 100 } } },
  };
  const STATUS = { audio_speaker: { volume: 42 }, screen: { brightness: 68, theme: "dark" } };
  /** What these tests' gadget reports: the condition the bridge reads for itself at the
   *  handshake, and the setting the model is asked to change. Nothing else — which is what
   *  makes a name outside it (the lamp, below) a name this gadget never said it had. */
  const REPORTED_TOOLS = [
    { name: "self.get_device_status", description: "…", inputSchema: { type: "object", properties: {} } },
    VOLUME_TOOL,
  ];

  /** Answer the handshake the way the firmware does, and hand back the gadget's side of the
   *  channel for whatever the turn asks it afterwards. */
  async function handshakeAs(device: Session, tools: unknown[]): Promise<ReturnType<typeof gadgetSide>> {
    const side = gadgetSide(device);
    await side.replyTo("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      serverInfo: { name: "xiaozhi-s3", version: "1.0.0" },
    });
    await side.replyTo("tools/list", { tools, nextCursor: "" });
    await side.replyTo("tools/call", {
      content: [{ type: "text", text: JSON.stringify(STATUS) }],
      isError: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return side;
  }

  it("makes the call the platform asked for, and reports back what the gadget did", async () => {
    const platform = await stubPlatform((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("user", { text: "ha xuong 60 di" }));
      // The model, and not the words, decided this — which is the whole of what the platform's
      // half of 4.5 adds, and the reason the bridge's grammar no longer has to cover it.
      res.write(
        sse("tool_call", {
          turnId: "turn-1",
          index: 0,
          name: "self.audio_speaker.set_volume",
          arguments: { volume: 60 },
        })
      );
      res.write(sse("done", { fullText: "" }));
      res.end();
    });
    const device = await spokenDevice(configFor(platform.url));
    try {
      device.send({ type: "hello", version: 3, transport: "websocket", features: { mcp: true, glyph_push: true } });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");
      const gadget = await handshakeAs(device, REPORTED_TOOLS);

      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();
      await device.until(() => platform.requests.length === 1, "the turn to be served");

      // The bridge asks the gadget, and the gadget answers the way the firmware does.
      await gadget.replyTo("tools/call", { content: [{ type: "text", text: "true" }], isError: false });
      await device.until(() => platform.toolResults.length === 1, "the bridge to report what the gadget did");

      // The arguments are the platform's, unaltered: the bridge is the hands here, and not a
      // second opinion about what was asked for.
      const calls = device.messages
        .map(
          (raw) =>
            JSON.parse(raw) as {
              type?: string;
              payload?: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
            }
        )
        .filter((msg) => msg.type === "mcp" && msg.payload?.method === "tools/call")
        .map((msg) => msg.payload!.params!);
      assert.ok(
        calls.some((params) => params.name === "self.audio_speaker.set_volume" && params.arguments?.volume === 60),
        `the gadget was asked for what the model asked for: ${JSON.stringify(calls)}`
      );

      // And the result went back under the turn the platform named, so the turn it is holding
      // open can be resumed rather than timing out.
      assert.deepEqual(platform.toolResults[0], { turnId: "turn-1", index: 0, ok: true, text: "true" });
    } finally {
      device.stop();
      platform.stop();
    }
  });

  it("reports a call the gadget's own report does not carry, without asking the gadget", async () => {
    const platform = await stubPlatform((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("user", { text: "bat den len" }));
      res.write(
        sse("tool_call", {
          turnId: "turn-2",
          index: 0,
          name: "self.lamp.turn_on",
          arguments: {},
        })
      );
      res.write(sse("done", { fullText: "" }));
      res.end();
    });
    const device = await spokenDevice(configFor(platform.url));
    try {
      device.send({ type: "hello", version: 3, transport: "websocket", features: { mcp: true, glyph_push: true } });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");
      // A report carrying the condition and the volume, and nothing else: the lamp is a name
      // this gadget never said it had.
      await handshakeAs(device, REPORTED_TOOLS);

      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();
      await device.until(() => platform.requests.length === 1, "the turn to be served");
      await device.until(() => platform.toolResults.length === 1, "the bridge to report the refusal");

      assert.equal(platform.toolResults[0]!.ok, false, "a call that cannot be made is reported as one");
      assert.match(
        String(platform.toolResults[0]!.message),
        /did not report a tool named self\.lamp\.turn_on/,
        "and the reason is the report, in the gadget's own terms"
      );

      // The gadget was never asked. The report is the whole of what is callable (D3), and the
      // refusal belongs where the report is rather than as an `Unknown tool:` from the board.
      assert.ok(
        !device.messages.some((raw) => raw.includes("self.lamp.turn_on")),
        "a name the report did not carry never reaches the gadget"
      );

      // And the turn ended in speech — the session is still here, and takes another turn.
      assert.equal(device.closeCode(), null, "nothing about it ended the session");
    } finally {
      device.stop();
      platform.stop();
    }
  });

  it("plays what the model asked the bridge for, and never asks the gadget", async () => {
    // 4.2: the catalogue offers the bridge's own tools beside the gadget's (4.1), and a call naming
    // one of them is answered here. The gadget never reported `bridge.play_music` and has no such
    // tool, so forwarding it would be asking a device for something it does not have — and the
    // refusal that came back would be an answer to a question nobody asked it.
    const platform = await stubPlatform((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("user", { text: "toi muon nghe bai Tone 440" }));
      res.write(
        sse("tool_call", {
          turnId: "turn-1",
          index: 0,
          name: "bridge.play_music",
          arguments: { query: "Tone 440" },
        })
      );
      res.write(sse("done", { fullText: "" }));
      res.end();
    });
    const device = await spokenDevice(configFor(platform.url, { musicDir: MUSIC }));
    try {
      device.send({ type: "hello", version: 3, transport: "websocket", features: { mcp: true, glyph_push: true } });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");
      await handshakeAs(device, REPORTED_TOOLS);

      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();
      await device.until(() => platform.requests.length === 1, "the turn to be served");
      // Reported back rather than held: the platform is holding the turn open for exactly this, and
      // the model speaks from it. The track is named as the file that will play, which is the answer
      // the directory gave rather than a promise the model made.
      await device.until(() => platform.toolResults.length === 1, "the bridge to answer the call");
      assert.deepEqual(platform.toolResults[0], {
        turnId: "turn-1",
        index: 0,
        ok: true,
        text: "playing the track Tone 440.mp3 through the device's speaker",
      });

      // Nothing about it reached the gadget — not the call, and not a name it could be asked by.
      assert.ok(
        !device.messages.some((raw) => raw.includes("bridge.")),
        "a tool of the bridge's own never reaches the gadget, in either direction"
      );

      // And the track plays, through the bracket every reply already goes out in.
      await device.until(() => device.binaries.length > 0, "the track to play");
      const typed = device.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
      assert.equal(typed.filter((m) => m.type === "tts" && m.state === "start").length, 1, "one bracket");
      assert.ok(
        typed.some((m) => m.state === "sentence_start" && m.text === "Tone 440"),
        "and the screen names the track, as it names a sentence"
      );
    } finally {
      device.stop();
      platform.stop();
    }
  });

  it("reports a bridge tool it cannot answer, and asks the gadget for neither", async () => {
    // Two ways a call to the bridge's own namespace fails, and one answer to both: the model is told
    // what happened, because the model is who is holding the turn and who has to say something to
    // the person. Neither reaches the gadget, which never reported either name.
    const platform = await stubPlatform((res, call) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("user", { text: call === 0 ? "bat den len" : "mo bai khong co bai nay" }));
      res.write(
        sse("tool_call", {
          turnId: `turn-${call + 1}`,
          index: 0,
          // A name under the bridge's own prefix that the bridge does not have, and then a name it
          // does have asking for a track the directory does not hold.
          name: call === 0 ? "bridge.lamp_turn_on" : "bridge.play_music",
          arguments: call === 0 ? {} : { query: "khong co bai nay" },
        })
      );
      res.write(sse("done", { fullText: "" }));
      res.end();
    });
    const device = await spokenDevice(configFor(platform.url, { musicDir: MUSIC }));
    try {
      device.send({ type: "hello", version: 3, transport: "websocket", features: { mcp: true, glyph_push: true } });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");
      await handshakeAs(device, REPORTED_TOOLS);

      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();
      await device.until(() => platform.toolResults.length === 1, "the first refusal");

      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();
      await device.until(() => platform.toolResults.length === 2, "the second refusal");
      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.equal(platform.toolResults[0]!.ok, false, "a name the bridge does not have is a failure");
      assert.match(
        String(platform.toolResults[0]!.message),
        /this bridge has no tool named bridge\.lamp_turn_on/,
        "said as the bridge's own answer, and not as a gadget's refusal of a call nobody made"
      );
      assert.equal(platform.toolResults[1]!.ok, false, "and so is a track the directory does not hold");
      assert.match(String(platform.toolResults[1]!.message), /nothing in .* matches khong co bai nay/);

      // Neither was played, and neither was asked of the gadget.
      assert.equal(device.binaries.length, 0, "no bracket was opened for a track that does not exist");
      assert.ok(!device.messages.some((raw) => raw.includes("bridge.")), "nor reached the gadget");
    } finally {
      device.stop();
      platform.stop();
    }
  });
});

describe("a command spoken to the gadget", () => {
  it("changes the setting, names it on the display, and answers nothing", async () => {
    // 4.1, requirement 2 and requirement 4, through the real socket.
    //
    // The command is knowable only once the platform has transcribed it — the bridge
    // has no recogniser of its own (D12) — so the turn is already under way before the
    // bridge can tell that it is not a turn at all. That is why the abort, and not a
    // check made earlier, is what leaves nothing of the platform's answer spoken; and
    // why the transcript reaching the device's display is allowed to stay, since the
    // requirement asks for exactly that: the display names the command.
    const platform = await stubPlatform((res, call) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (call > 0) {
        res.write(sse("user", { text: "va bay gio" }));
        res.write(sse("done", { fullText: "ok" }));
        res.end();
        return;
      }
      res.write(sse("user", { text: "turn it up" }));
      // A reply the platform had already produced, written into the same read as the
      // transcript — which is what a small reply on a fast link arrives as. A bridge that
      // stopped dispatching only at the next read would speak this sentence into a turn
      // it had just cancelled, and the person would hear the bridge answer a command it
      // was answering itself.
      res.write(sse("sentence", { index: 0, text: "There, it is louder.", audioData: sentenceAudio(REPLY_SECONDS) }));
      res.write(sse("done", { fullText: "There, it is louder." }));
      res.end();
    });

    const device = await spokenDevice(configFor(platform.url));
    try {
      device.send({ type: "hello", version: 3, transport: "websocket", features: { mcp: true } });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");

      // The gadget's side of the exchange, answered the way the firmware answers: by
      // method, echoing the id it was asked with. `asks` is a pure read of what the
      // bridge has sent, and each reply below answers the nth ask of its method, so the
      // cursor is the ask count rather than a mark on a message.
      interface McpFrame {
        type?: string;
        state?: string;
        text?: string;
        payload?: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      }
      const frames = (): McpFrame[] => device.messages.map((m) => JSON.parse(m) as McpFrame);
      const asks = (method: string): number[] =>
        frames()
          .filter((f) => f.type === "mcp" && f.payload?.method === method)
          .map((f) => (f.payload as { id?: number }).id)
          .filter((id): id is number => typeof id === "number");
      const answer = async (method: string, nth: number, result: unknown): Promise<void> => {
        await device.until(() => asks(method).length > nth, `ask ${nth + 1} of ${method}`);
        device.send({ type: "mcp", payload: { jsonrpc: "2.0", id: asks(method)[nth], result } });
      };
      const reported = (volume: number) => ({
        content: [{ type: "text", text: JSON.stringify({ audio_speaker: { volume } }) }],
        isError: false,
      });

      await answer("initialize", 0, {
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: { name: "xiaozhi-s3", version: "1.0.0" },
      });
      await answer("tools/list", 0, {
        tools: [
          { name: "self.get_device_status", description: "…", inputSchema: { type: "object", properties: {} } },
          {
            name: "self.audio_speaker.set_volume",
            description: "…",
            inputSchema: {
              type: "object",
              properties: { volume: { type: "integer", minimum: 0, maximum: 100 } },
              required: ["volume"],
            },
          },
        ],
        nextCursor: "",
      });
      // The handshake's own read (2.1), so that the session has a catalog to call through
      // before the command arrives.
      await answer("tools/call", 0, reported(42));
      await new Promise((resolve) => setTimeout(resolve, 50));

      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();
      await device.until(() => platform.requests.length === 1, "the turn to reach the platform");

      // The bridge answers the command itself, once the turn has unwound: the read the
      // relative change is computed from, the call, and the read that confirms it (3.3).
      await answer("tools/call", 1, reported(42));
      await answer("tools/call", 2, { content: [{ type: "text", text: "true" }], isError: false });
      await answer("tools/call", 3, reported(52));
      await new Promise((resolve) => setTimeout(resolve, 200));

      const sent = frames();

      // Requirement 4 — what the display shows for such a turn is the person's own words.
      assert.deepEqual(
        sent.filter((f) => f.type === "stt").map((f) => f.text),
        ["turn it up"]
      );

      // And nothing is spoken for it: no bracket, no frames, and so no `tts stop` either.
      // `finish()` finds a bracket that was never opened and leaves the session's own
      // record of how long the speaker is busy exactly where a person who had not spoken
      // would have left it (4.1).
      assert.deepEqual(sent.filter((f) => f.type === "tts"), []);
      assert.equal(device.binaries.length, 0, "not one frame of the platform's answer was played");

      // The setting moved — from what the gadget reported at that moment, by the step the
      // deployment configured (D6). 42 is the gadget's own number and 52 is this bridge's
      // arithmetic on it, which is the half of 3.3 that only the wire can show.
      const call = sent.find((f) => f.payload?.params?.name === "self.audio_speaker.set_volume");
      assert.ok(call, "the gadget was asked to change its volume");
      assert.deepEqual(call.payload?.params?.arguments, { volume: 52 });

      // 4.2, from the platform's side — the next interview turn is asked with the
      // conversation the command did not add to. And requirement 4's second scenario
      // with it: the gadget is left able to take that next turn. No `listen start` is
      // sent here, because the device does not send one: a turn the bridge never spoke
      // for never took the device out of `Listening`, so it has no state to come back
      // to and no reason to announce one — the board was watched doing exactly this on
      // 2026-10-07, and the bridge sat with no window open for the ninety seconds that
      // followed. The window is the bridge's own (D9), so a bridge that does not reopen
      // it hears the person's next words as frames counted and not judged.
      device.speak();
      await device.until(() => platform.requests.length === 2, "the next turn to be served");

      const next = platform.requests[1]!.body.toString("latin1");
      const at = next.indexOf('name="history"');
      assert.ok(at > 0, "every turn carries a history field");
      assert.equal(
        next.slice(next.indexOf("\r\n\r\n", at) + 4, next.indexOf("\r\n--", at)),
        "[]",
        "the command is not in the conversation the interview is asked to continue"
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

/** Wait for the bridge to end the session, and fail unless it was the bridge that did it.
 *
 *  The close *code* is the whole of what makes this observable. `ws.close()` sends a close
 *  frame with no status code, which the peer reports as 1005 — and that, or a 1000, is the
 *  bridge ending a session. 1006 is a socket destroyed without a close frame, which is what
 *  `stop()` does; and a session that is still open never resolves at all. Asserting 1000
 *  would fail on the bridge behaving correctly, which is how this test was written first. */
async function endedByBridge(device: Session, ms: number): Promise<void> {
  const code = await Promise.race([
    device.closed,
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), ms).unref();
    }),
  ]);
  if (code === null) throw new Error(`the session was still open after ${ms}ms`);
  if (code === 1006) {
    throw new Error("the socket was torn down without a close frame — that is stop(), not the bridge");
  }
}

/** A device that completes the upgrade by hand and then never answers a close.
 *
 *  The `ws` client cannot be the peer that test is about: it answers a closing handshake as a
 *  matter of course, so a bridge that waited thirty seconds for one would look exactly like a
 *  bridge that did not. The gadget is the peer that does not answer — measured on the board,
 *  where the old socket stayed open until the device was next woken — and this stands in for
 *  it: enough websocket to be admitted, and then silence. */
async function silentDevice(
  config: BridgeConfig,
  services: BridgeServices
): Promise<{ gone: Promise<void>; stop(): void }> {
  const wss = createWsServer(config, services);
  if (!wss.address()) await once(wss, "listening");
  const port = (wss.address() as AddressInfo).port;

  const socket = createConnection(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(
    `GET /xiaozhi/v1/ HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `Sec-WebSocket-Key: ${Buffer.from("0123456789abcdef").toString("base64")}\r\n` +
      `Authorization: Bearer ${deriveToken(SECRET, BOARD)}\r\n` +
      `device-id: ${BOARD}\r\n` +
      `\r\n`
  );
  // Read and discarded, never answered: the close frame the bridge sends is left where it lands,
  // which is the whole of what this peer is.
  socket.resume();

  return {
    gone: new Promise<void>((resolve) => socket.once("close", () => resolve())),
    stop() {
      socket.destroy();
      wss.clients.forEach((client) => client.terminate());
      wss.close();
    },
  };
}

/** The gadget's side of the tool channel, answered the way the firmware answers: by method,
 *  echoing the id it was asked with. A real board's reply arrives through the same socket
 *  these tests are holding, as `{"type":"mcp","payload":…}`. Each method is asked once, so
 *  finding it by name is finding the only one. */
function gadgetSide(device: Session): {
  asked(method: string): number | null;
  replyTo(method: string, result: unknown): Promise<void>;
} {
  // The first request of that method the bridge has not been answered on. A session asks
  // `tools/call` more than once — the status at the handshake, then whatever the platform's
  // model asked for — so "the first one" would keep handing back the same id.
  const answered = new Set<number>();
  const asked = (method: string): number | null => {
    for (const raw of device.messages) {
      const msg = JSON.parse(raw) as { type?: string; payload?: { id?: number; method?: string } };
      if (
        msg.type === "mcp" &&
        msg.payload?.method === method &&
        typeof msg.payload.id === "number" &&
        !answered.has(msg.payload.id)
      ) {
        return msg.payload.id;
      }
    }
    return null;
  };
  return {
    asked,
    async replyTo(method, result) {
      await device.until(() => asked(method) !== null, `the bridge to ask ${method}`);
      const id = asked(method)!;
      answered.add(id);
      device.send({ type: "mcp", payload: { jsonrpc: "2.0", id, result } });
    },
  };
}

describe("a session nobody is speaking into", () => {
  // The idle window is the one thing here measured in wall clock, so these configure it
  // small rather than waiting a minute for the shipped 60000. Everything else is the
  // shipped endpointer: what runs is the real path — a real timer, a real socket — and
  // not a shortened stand-in for it.
  const reply = (res: ServerResponse, text: string): void => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse("user", { text }));
    res.write(sse("sentence", { index: 0, text: "vang", audioData: sentenceAudio(REPLY_SECONDS) }));
    res.write(sse("done", { fullText: "vang" }));
    res.end();
  };

  it("ends it, and sends no turn for it", async () => {
    const platform = await stubPlatform((res) => reply(res, "khong ai noi gi"));
    const device = await spokenDevice(configFor(platform.url, { sessionIdleMs: 150 }));
    try {
      device.send({ type: "hello", version: 3, transport: "websocket" });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");
      device.send({ type: "listen", state: "start", mode: "manual" });

      // Then nothing at all: no speech, no verdict, nothing a person was behind.
      await endedByBridge(device, 4_000);
      assert.equal(platform.requests.length, 0, "and no turn was sent for a session nobody spoke into");
    } finally {
      device.stop();
      platform.stop();
    }
  });

  it("ends it while frames are still arriving, which a giveup must not prevent", async () => {
    // The correction the design had to make. The endpointer gives up on a window
    // `vadNoSpeechMs` after it opens and the bridge opens the next one, so an empty room
    // produces a `giveup` every few frames for as long as the device is listening. Were a
    // giveup evidence of a person, the window below would never fire — so this passing at
    // all is the assertion, and the frames have to keep coming for it to mean anything.
    const platform = await stubPlatform((res) => reply(res, "khong ai noi gi"));
    const device = await spokenDevice(
      configFor(platform.url, { sessionIdleMs: 400, vadNoSpeechMs: 120 })
    );
    const ticking = setInterval(() => device.raw(ROOM), FRAME_MS);
    try {
      device.send({ type: "hello", version: 3, transport: "websocket" });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");
      device.send({ type: "listen", state: "start", mode: "manual" });

      await endedByBridge(device, 4_000);
      assert.equal(platform.requests.length, 0, "and a room nobody spoke in produced no turn");
    } finally {
      clearInterval(ticking);
      device.stop();
      platform.stop();
    }
  });

  it("does not end one a person is taking turns in", async () => {
    // The window resets on a turn and on the reply that follows it, so two turns inside
    // one window leave the session open — which is the difference between a person and a
    // room with a fan in it.
    const platform = await stubPlatform((res, call) =>
      reply(res, call === 0 ? "cau tra loi mot" : "cau tra loi hai")
    );
    const device = await spokenDevice(configFor(platform.url, { sessionIdleMs: 4_000 }));
    try {
      device.send({ type: "hello", version: 3, transport: "websocket" });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");

      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();
      await device.until(() => platform.requests.length === 1, "the first turn");

      await device.played(REPLY_SECONDS);
      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();
      await device.until(() => platform.requests.length === 2, "the second turn");

      assert.equal(device.closeCode(), null, "two turns inside the window left the session open");
    } finally {
      device.stop();
      platform.stop();
    }
  });

  it("does not end one the bridge is playing a track into", async () => {
    // Found on the board 2026-10-11: a 152-second track was cut off after 61 seconds. The window is
    // measured from what a *person* did, and a person sitting and listening does nothing at all — so
    // the longest track this bridge could finish was one shorter than the window, which is the one
    // thing a track is not. A track the person asked for is theirs for as long as it plays, and the
    // end of the bridge's own audio is where the window runs from instead.
    const platform = await stubPlatform((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("user", { text: "phát bài Long Tone" }));
      res.write(sse("done", { fullText: "" }));
      res.end();
    });
    const device = await spokenDevice(
      configFor(platform.url, { sessionIdleMs: 400, musicDir: MUSIC, language: "vietnamese" })
    );
    try {
      device.send({ type: "hello", version: 3, transport: "websocket" });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");
      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();
      await device.until(
        () => device.messages.some((m) => JSON.parse(m).type === "tts" && JSON.parse(m).state === "start"),
        "the track to start"
      );

      // A 400ms window and a twelve-second track: whole windows go by with nobody saying anything,
      // which is the state the window exists for and the one that must not end this.
      await device.played(3);
      assert.equal(device.closeCode(), null, "the music is the person, and the session is still here");

      // Nor is the window merely suspended: once the track has played out it runs from there, so the
      // person gets the whole of their track and a window after it rather than neither.
      await device.played(11);
      await endedByBridge(device, 4_000);
    } finally {
      device.stop();
      platform.stop();
    }
  });

  it("finishes a close the peer never answers, rather than waiting out ws's thirty seconds", async () => {
    // Measured on the board: the gadget leaves the old socket open until it is next woken, so
    // the closing handshake goes unanswered and `ws` would spend its own `closeTimeout` — thirty
    // seconds — on it. For that long the bridge holds a session, and a decoder, for a device it
    // has already finished with, and a wake word inside the window would open a second session
    // beside it. Nothing else in this file can show this: the `ws` client answers a close as a
    // matter of course, so it never reaches the grace. This peer does not answer.
    const platform = await stubPlatform((res) => reply(res, "khong ai noi gi"));
    const config = configFor(platform.url, { sessionIdleMs: 400 });
    const services: BridgeServices = {
      catalog: createPersonaCatalog(config),
      conversations: createConversations(config),
    };

    const at = Date.now();
    const silent = await silentDevice(config, services);
    try {
      await silent.gone;
      const waited = Date.now() - at;
      assert.ok(
        waited < 5_000,
        `${waited}ms — the socket outlived the grace the bridge gives a closing handshake`
      );
    } finally {
      silent.stop();
      platform.stop();
    }
  });

  it("leaves the conversation for the session after it", async () => {
    // The close ends a connection, not a conversation. History is held per device
    // (`conversation.ts`), so what the person said before the gap is in the turn they
    // take after it — which is what makes ending a session a thing a deployment can do
    // at all, rather than a thing that costs the person everything they had said.
    const platform = await stubPlatform((res, call) =>
      reply(res, call === 0 ? "cau hoi thu nhat" : "cau hoi thu hai")
    );
    const config = configFor(platform.url, { sessionIdleMs: 150 });
    const services: BridgeServices = {
      catalog: createPersonaCatalog(config),
      conversations: createConversations(config),
    };

    const first = await spokenDevice(config, services);
    try {
      first.send({ type: "hello", version: 3, transport: "websocket" });
      await first.until(() => first.messages.some((m) => m.includes('"hello"')), "the first hello");
      first.send({ type: "listen", state: "start", mode: "manual" });
      first.speak();
      await first.until(() => platform.requests.length === 1, "the first turn");
      await endedByBridge(first, 4_000);
    } finally {
      first.stop();
    }

    const second = await spokenDevice(config, services);
    try {
      second.send({ type: "hello", version: 3, transport: "websocket" });
      await second.until(() => second.messages.some((m) => m.includes('"hello"')), "the second hello");
      second.send({ type: "listen", state: "start", mode: "manual" });
      second.speak();
      await second.until(() => platform.requests.length === 2, "the second turn");

      assert.match(
        platform.requests[1]!.body.toString("latin1"),
        /"role":"user","content":"cau hoi thu nhat"/,
        "the turn after the gap still carries what was said before it"
      );
    } finally {
      second.stop();
      platform.stop();
    }
  });
});

describe("music the bridge plays itself", () => {
  /** A platform that transcribes whatever the test wants heard, and then has nothing more to say.
   *  A command is knowable only from the transcript (D12), so every one of these starts here. */
  const hears = (said: string) =>
    stubPlatform((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("user", { text: said }));
      res.write(sse("done", { fullText: "" }));
      res.end();
    });

  /** Bring a device up, say one thing to it, and let the turn close.
   *
   *  Vietnamese, because that is the language these forms are for and the one the person in front
   *  of the gadget speaks. The English forms are the same grammar in other words, and the pair is
   *  asserted in `commands.test.ts`; what is being pinned here is the path from an utterance to a
   *  track, and it is not improved by pinning it in a language nobody in the room is using. */
  async function ask(platform: Awaited<ReturnType<typeof stubPlatform>>, said: string, musicDir = MUSIC) {
    const device = await spokenDevice(configFor(platform.url, { musicDir, language: "vietnamese" }));
    device.send({ type: "hello", version: 3, transport: "websocket" });
    await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");
    device.send({ type: "listen", state: "start", mode: "manual" });
    device.speak();
    await device.until(() => platform.requests.length === 1, "the turn to be served");
    return device;
  }

  it("plays the track the person asked for, and asks the platform nothing", async () => {
    const platform = await hears("phát nhạc");
    const device = await ask(platform, "phát nhạc");
    try {
      await device.until(
        () => device.messages.some((m) => JSON.parse(m).type === "tts" && JSON.parse(m).state === "start"),
        "the bracket to open around the track"
      );

      const typed = device.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
      assert.equal(typed.filter((m) => m.type === "tts" && m.state === "start").length, 1, "one bracket");
      assert.ok(device.binaries.length > 0, "and the track's own audio, inside it");

      // The screen names what is playing, which is the one place a person can read it. "phát nhạc"
      // names no track, so the first by name is what plays — `Long Tone.mp3`, the fixtures' names
      // ordering that way for the same reason a deployment would order its own.
      const announced = typed.find((m) => m.state === "sentence_start");
      assert.equal(announced?.text, "Long Tone");

      // One request for the turn, and nothing asked of the model about the command: the decision
      // was the grammar's, and the playing is the bridge's.
      assert.equal(platform.requests.length, 1, "no second turn, and no tool call");
    } finally {
      device.stop();
      platform.stop();
    }
  });

  it("names the track once, however many pieces it is handed over in", async () => {
    // On the wire, which is where the defect was: the track is cut into ten-second pieces so that
    // one WAV is built at a time, and the name used to go out with every piece. Measured on the
    // board 2026-10-11, whose firmware keeps a **list** of what it was told — so a twelve-second
    // fixture named itself twice, and the four-to-six minute tracks this deployment holds named
    // themselves twenty times over, filling that list with one repeated entry.
    //
    // The wait is the point rather than incidental: a second announcement would arrive with the
    // second piece, ten seconds in, so a test that looked at the wire as soon as the bracket
    // opened could not tell the two behaviours apart. Played out to the end, the whole track is
    // there to be counted — 166 frames is the first piece, and anything past it is the second.
    const platform = await hears("phát nhạc");
    const device = await ask(platform, "phát nhạc");
    try {
      await device.until(() => device.binaries.length > 0, "the track to start playing");
      await device.played(12);

      const typed = device.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
      assert.deepEqual(
        typed.filter((m) => m.state === "sentence_start").map((m) => m.text),
        ["Long Tone"],
        "the track is named once, and the pieces after the first say nothing at all"
      );
      assert.equal(
        typed.filter((m) => m.type === "tts" && m.state === "start").length,
        1,
        "one bracket around all of it, as before"
      );
      assert.ok(
        device.binaries.length > 180,
        `the whole track was handed over, in more than one piece: ${device.binaries.length} frames`
      );
    } finally {
      device.stop();
      platform.stop();
    }
  });

  it("judges nothing while a track plays, and takes the next turn once it has ended", async () => {
    // The measurement this change exists for (2026-10-11): judged frames of the bridge's own
    // *speech* land below the gate and are harmless, where a room playing music is not — so a
    // listened-to track would close turn after turn on its own sound and the gadget would answer
    // it. What holds the window shut is the drain deadline, and it covers a whole track because a
    // track is handed over whole: `turnMs` is the audio the turn *reserved*, which for a track is
    // all of it, where for a reply it is the one sentence on the stream so far.
    //
    // The utterance sent over the track is a whole one — speech, and then the silence that closes
    // a turn — because an utterance that never closes into silence would close no turn with the
    // window wide open either, and "no turn closed" would then hold for the wrong reason.
    const platform = await hears("phát nhạc");
    const device = await ask(platform, "phát nhạc");
    try {
      await device.until(() => device.binaries.length > 0, "the track to start playing");

      device.speak();
      // Long enough for the endpointer to have closed a turn on it had it been judging — measured
      // at 3.3s of frames, plus the walk from the verdict to the platform.
      await device.played(3);
      assert.equal(platform.requests.length, 1, "no turn closed on the bridge's own music");

      // Twelve seconds of track and a 400ms guard: once that is behind us the room is the person's
      // again, which is what says the window was shut for the track rather than broken for good.
      await device.played(13);
      // The device is listening again — on the board that is its own `listen start`, sent when its
      // speaker stops, and the only thing that opens the next window. A test that skipped it would be
      // relying on a `listen start` the *bridge* sent itself, and there is only one reason the bridge
      // ever did: a music turn was wrongly reported as one that opened no bracket.
      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();
      await device.until(() => platform.requests.length === 2, "the next turn to be served");
      assert.equal(device.binaries.length > 0, true, "and the track played on through all of it");
    } finally {
      device.stop();
      platform.stop();
    }
  });

  it("leaves a name the directory cannot meet to the platform, and the model hears why", async () => {
    // On the board 2026-10-11 this was silence. The utterance was recognised as a command, so the
    // turn was dropped before the platform could answer it (4.1) — and *then* the directory was asked
    // and could not settle what had been asked for. Nothing played, nothing was said, and the only
    // trace was a `warn` line in a log nobody at the gadget reads. From the person's seat the gadget
    // had ignored them.
    //
    // Now the directory is asked before the turn is dropped, and an answer it cannot give leaves the
    // utterance to the platform as the ordinary thing it is: the model is the one that can speak
    // about it, and it reaches for `bridge.play_music` itself, refused here with the directory's own
    // reason. What the person hears is a reply about what happened.
    const platform = await stubPlatform((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("user", { text: "mở bài không có bài này" }));
      res.write(
        sse("tool_call", {
          turnId: "turn-1",
          index: 0,
          name: "bridge.play_music",
          arguments: { query: "không có bài này" },
        })
      );
      res.write(sse("sentence", { index: 0, text: "Không có bài đó.", audioData: sentenceAudio(REPLY_SECONDS) }));
      res.write(sse("done", { fullText: "Không có bài đó." }));
      res.end();
    });
    const device = await spokenDevice(configFor(platform.url, { musicDir: MUSIC, language: "vietnamese" }));
    try {
      device.send({ type: "hello", version: 3, transport: "websocket" });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");

      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();

      // The turn reached the platform, which is the whole of the difference between a person being
      // answered and a person being ignored.
      await device.until(() => platform.requests.length === 1, "the turn to reach the platform");
      await device.until(() => platform.toolResults.length === 1, "the bridge to answer the call");

      assert.equal(platform.toolResults[0]!.ok, false, "nothing was played, so the call is refused");
      assert.match(
        String(platform.toolResults[0]!.message),
        /nothing in .* matches/,
        "and the model is given the directory's own reason — which is what it speaks from"
      );

      // Nothing was played: playing the wrong track is worse than playing none, because the person
      // hears something they did not ask for and has no way to tell that is what happened — the
      // directory is the whole of what may be played.
      await device.until(() => device.binaries.length > 0, "the model's answer to be heard");
      const brackets = device.messages.filter((m) => JSON.parse(m).type === "tts" && JSON.parse(m).state === "start");
      assert.equal(brackets.length, 1, "the one bracket is the reply's, not a track's");
    } finally {
      device.stop();
      platform.stop();
    }
  });

  it("will not guess between tracks, and says which ones a name covers", async () => {
    // The other half of the same defect, and the likelier one in a real directory: the person names
    // an artist, and several files carry that name. The fixtures' two "tone" files stand in for the
    // three Kenny G tracks that were in this deployment's own directory when it was reported.
    //
    // The refusal to guess is deliberate and stays (playing the wrong track is worse than playing
    // none). What changed is that the refusal is now *said*, and that the person can answer it —
    // "mở bài Long Tone" plays, which a dropped turn could never have reached.
    const platform = await stubPlatform((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("user", { text: "mở bài tone" }));
      res.write(
        sse("tool_call", {
          turnId: "turn-1",
          index: 0,
          name: "bridge.play_music",
          arguments: { query: "tone" },
        })
      );
      res.write(sse("done", { fullText: "" }));
      res.end();
    });
    const device = await spokenDevice(configFor(platform.url, { musicDir: MUSIC, language: "vietnamese" }));
    try {
      device.send({ type: "hello", version: 3, transport: "websocket" });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");

      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();

      await device.until(() => platform.requests.length === 1, "the turn to reach the platform");
      await device.until(() => platform.toolResults.length === 1, "the bridge to answer the call");

      assert.equal(platform.toolResults[0]!.ok, false, "the bridge did not pick one of them");
      assert.match(
        String(platform.toolResults[0]!.message),
        /2 tracks match tone/,
        "and the model is told which ones, rather than that something went wrong"
      );
      assert.equal(device.binaries.length, 0, "no track was started on a name that covers two");
    } finally {
      device.stop();
      platform.stop();
    }
  });

  it("stops on the wake word the way a reply stops", async () => {
    // The second transcript is an ordinary thing to say, so that the turn after the stop is asked
    // as a turn rather than recognised as the command again — which is the half of this that says
    // the stop left the session able to carry on.
    let served = 0;
    const platform = await stubPlatform((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("user", { text: served++ === 0 ? "phát bài Long Tone" : "thế còn bài kia thì sao" }));
      res.write(sse("done", { fullText: "" }));
      res.end();
    });
    const device = await ask(platform, "phát bài Long Tone");
    try {
      await device.until(
        () => device.messages.some((m) => JSON.parse(m).type === "tts" && JSON.parse(m).state === "start"),
        "the track to start"
      );

      // The wake word, which the firmware sends from wherever it detected it — and a track is what
      // was playing, so what stops is the track (`Speaker.stop()`).
      device.send({ type: "abort", reason: "wake_word_detected" });
      await device.until(
        () => device.messages.some((m) => JSON.parse(m).type === "tts" && JSON.parse(m).state === "stop"),
        "the bracket to close"
      );

      const framesAtStop = device.binaries.length;
      await new Promise((resolve) => setTimeout(resolve, 500));
      // A twelve-second track, stopped in its first second: what the schedule was still holding —
      // most of the track — never reaches the device.
      assert.ok(
        device.binaries.length - framesAtStop < 20,
        `${device.binaries.length - framesAtStop} frame(s) arrived after the stop`
      );

      // And the device is listening again, as it is after every wake word: the turn after the one
      // the track was stopped in is taken as any turn is.
      device.send({ type: "listen", state: "start", mode: "manual" });
      await device.played(1.5);
      device.speak();
      await device.until(() => platform.requests.length === 2, "the next turn to be served");
      assert.equal(served, 2);
    } finally {
      device.stop();
      platform.stop();
    }
  });

  it("answers what the grammar knows itself, and asks the model only for the rest", async () => {
    // The two deciders and their one order (D8). Both turns of this session are the same person
    // asking for the same track; what differs is whether the bridge already knows what the words
    // are. The grammar reads the whole utterance and, when it recognises one, answers it and drops
    // the turn before the platform's model has said anything — so the model is not asked to decide,
    // though it was offered the tools to decide with. Only a phrasing the grammar has no form for
    // reaches it, and what comes back is a call the bridge answers itself (4.2).
    const platform = await stubPlatform((res, call) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("user", { text: call === 0 ? "phát nhạc" : "tôi muốn nghe bài Long Tone" }));
      if (call > 0) {
        res.write(
          sse("tool_call", {
            turnId: "turn-2",
            index: 0,
            name: "bridge.play_music",
            arguments: { query: "Long Tone" },
          })
        );
      }
      res.write(sse("done", { fullText: "" }));
      res.end();
    });
    const device = await spokenDevice(configFor(platform.url, { musicDir: MUSIC, language: "vietnamese" }));
    try {
      device.send({ type: "hello", version: 3, transport: "websocket" });
      await device.until(() => device.messages.some((m) => m.includes('"hello"')), "the server hello");

      // The first turn: recognised, and nothing about it goes to the model.
      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();
      await device.until(() => platform.requests.length === 1, "the turn to be served");
      await device.until(
        () => device.messages.some((m) => JSON.parse(m).type === "tts" && JSON.parse(m).state === "start"),
        "the track to play"
      );
      assert.equal(platform.toolResults.length, 0, "the model decided nothing, because it was not asked");
      // And it was not kept in the dark to get that: the catalogue went up with the turn, the
      // bridge's own tool among it. What made the decision was the order, not the tools' absence.
      assert.match(platform.requests[0]!.body.toString("latin1"), /bridge\.play_music/);

      // A twelve-second track, and the window shut for every second of it (2.2): the second turn is
      // taken once the track has played out, as any turn after a track is. Waited out with a margin
      // rather than to the millisecond — the deadline is the track *plus* its guard, and on the board
      // it is the device's own continuous stream that ends the drain; a test that sent its utterance
      // in the last hundred milliseconds of it would be racing the guard rather than checking it.
      await device.played(13);
      const before = device.binaries.length;
      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();
      await device.until(() => platform.requests.length === 2, "the second turn to be served");

      // These words are not one of the grammar's forms, so they are the model's to answer — and the
      // model reaches for the tool the bridge offered it rather than being told what to do.
      await device.until(() => platform.toolResults.length === 1, "the bridge to answer the call");
      assert.equal(platform.toolResults[0]!.ok, true);
      assert.match(String(platform.toolResults[0]!.text), /playing the track Long Tone\.mp3/);

      await device.until(() => device.binaries.length > before, "the second track to play");
      const typed = device.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
      assert.equal(
        typed.filter((m) => m.type === "tts" && m.state === "start").length,
        2,
        "one track asked for through the grammar, one through the model, each in its own bracket"
      );
    } finally {
      device.stop();
      platform.stop();
    }
  });

  it("answers the words it recognises, even when the model's call is in the same read", async () => {
    // The one shape where the order could break: a fast platform, both events in one chunk. The
    // transcript is read first, the bridge recognises it and drops the turn — and the rest of what
    // came in that same read has already been parsed and handed over, so the read is abandoned
    // rather than finished (`turn.ts`). Two deciders carrying out one utterance is a track played
    // twice, and the second one is the track nobody asked for.
    const platform = await stubPlatform((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // One write, and therefore one chunk: the check being pinned is the one that looks at each
      // event, not the one that tears the connection down, which would pass this test for a
      // different reason.
      res.write(
        sse("user", { text: "phát nhạc" }) +
          sse("tool_call", {
            turnId: "turn-1",
            index: 0,
            name: "bridge.play_music",
            arguments: { query: "Tone 440" },
          }) +
          sse("done", { fullText: "" })
      );
      res.end();
    });
    const device = await ask(platform, "phát nhạc");
    try {
      await device.until(() => device.binaries.length > 0, "the track to play");
      await new Promise((resolve) => setTimeout(resolve, 300));

      assert.equal(platform.toolResults.length, 0, "the call that came with the transcript was not answered");

      const typed = device.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
      assert.equal(
        typed.filter((m) => m.type === "tts" && m.state === "start").length,
        1,
        "one bracket, and not a second track from the call beside the transcript"
      );
      // And the one that played is the grammar's answer, not the model's: the bare request names no
      // track, so the first by name plays rather than the one the call asked for.
      assert.ok(
        typed.some((m) => m.state === "sentence_start" && m.text === "Long Tone"),
        "the track that played is the one the bridge chose"
      );
    } finally {
      device.stop();
      platform.stop();
    }
  });

  it("hears the words after a turn that said nothing, with no listen start to help it", async () => {
    // Found on the board 2026-10-11, and it deafened a whole run: a command turn speaks nothing, so no
    // bracket opens, so the device never leaves `Listening` and never sends the `listen start` that
    // would open the next window — the bridge has to reopen it itself (requirement 4). It did not,
    // because the answer it read was the turn before's. Everything said after that was counted and not
    // judged, in silence, until the session ended.
    //
    // Nothing sends a `listen start` between the second turn and the third, because on the board
    // nothing does either. The third turn being served is the whole of the assertion.
    let served = 0;
    const heard = ["phát bài Tone 440", "dừng nhạc", "hôm nay thế nào"];
    const platform = await stubPlatform((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("user", { text: heard[served++] ?? "hôm nay thế nào" }));
      res.write(sse("done", { fullText: "" }));
      res.end();
    });
    const device = await ask(platform, "phát bài Tone 440");
    try {
      await device.until(() => device.binaries.length > 0, "the track to play");
      // Past the track and its drain guard (2.2), and the device listening again — which is what clears
      // the bridge's own idea that a track is playing.
      await device.played(2);

      // The command: heard, recognised, answered, and nothing spoken for it.
      device.send({ type: "listen", state: "start", mode: "manual" });
      device.speak();
      await device.until(() => platform.requests.length === 2, "the command to be answered");

      // And then, with no help from the device at all, an ordinary turn.
      device.speak();
      await device.until(() => platform.requests.length === 3, "the turn after the command");
      assert.equal(served, 3, "three turns, the last of them heard into a window the bridge reopened");
    } finally {
      device.stop();
      platform.stop();
    }
  });
});
