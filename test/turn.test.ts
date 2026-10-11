import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ENDPOINTER_DEFAULTS, type BridgeConfig } from "../src/config.js";
import type { McpTool } from "../src/protocol/mcp.js";
import { musicTools } from "../src/music.js";
import {
  TURN_ENGINE,
  runTurn,
  turnForm,
  type TurnRequest,
  type TurnSentence,
  type TurnSink,
} from "../src/turn.js";

/**
 * A turn is a request the browser could have sent, and a stream consumed as one.
 *
 * Two halves, as with the catalog. The request is checked field by field against
 * `POST /api/voice-agent/stream`, because the endpoint is stateless (D2) — whatever
 * the bridge forgets to send is a persona field silently missing from the answer,
 * or a transcriber silently pinned to the wrong language. And the stream is checked
 * event by event against a real socket rather than a mocked `fetch`, because what
 * is being pinned is how this process reads bytes: the sentence audio has to reach
 * the caller as it arrives (D4), which is a property of a reader that keeps up, not
 * of a parser that is handed a whole body.
 *
 * The stub is a real HTTP server for the reason the OTA and catalog tests start
 * one: a mock reports what it was told to expect, and this is the file where the
 * request that leaves the process is the thing under test.
 */
const PLATFORM = "platform-token-abcdefgh";

function configFor(platformUrl: string): BridgeConfig {
  return {
    otaPort: 0,
    wsPort: 0,
    publicHost: "127.0.0.1",
    deviceSecret: "s".repeat(43),
    allowedDevices: ["b81f3f4a9b01"],
    devicePersonas: new Map([["b81f3f4a9b01", "interview-coach"]]),
    platformUrl,
    apiAuthToken: PLATFORM,
    framing: 3,
    serverRate: 24000,
    frameMs: 60,
    ...ENDPOINTER_DEFAULTS,
    sessionIdleMs: 60000,
    musicDir: "",
    historyTurns: 20,
    commandStep: 10,
    language: "english",
  };
}

interface StubRequest {
  path: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

interface StubPlatform {
  url: string;
  requests: StubRequest[];
  stop(): void;
}

/** A platform that answers however the test says, and records what it was asked. */
async function stubPlatform(
  respond: (res: ServerResponse) => void | Promise<void>
): Promise<StubPlatform> {
  const requests: StubRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        path: req.url ?? "",
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"),
      });
      void respond(res);
    });
  });
  server.listen(0, "127.0.0.1");
  // 127.0.0.1 rather than "localhost", for the reason the catalog tests give: the
  // name resolves to ::1 first here, and a stub on IPv4 then looks like a bug.
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

/** One server-sent event, in the endpoint's own framing. */
function sse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Answer the request with a stream of SSE, and end it. */
function streamSse(events: Array<[string, unknown]>, onEnd?: () => void) {
  return (res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const [name, payload] of events) res.write(sse(name, payload));
    onEnd?.();
    res.end();
  };
}

/** A sink that records everything it was handed, in order. */
function recordingSink(): { sink: TurnSink; log: string[]; sentences: TurnSentence[] } {
  const log: string[] = [];
  const sentences: TurnSentence[] = [];
  return {
    log,
    sentences,
    sink: {
      onUser: (text) => void log.push(`user:${text}`),
      onText: (text) => void log.push(`text:${text}`),
      onSentence: (sentence) => {
        sentences.push(sentence);
        log.push(`sentence:${sentence.index}`);
      },
      onNotice: (notice) => void log.push(`notice:${notice.code ?? ""}:${notice.message}`),
      onError: (message) => void log.push(`error:${message}`),
    },
  };
}

const REQUEST: TurnRequest = {
  systemPrompt: "You are a patient language partner.",
  enabledTopics: ["Truyện cười"],
  answerMode: "generate",
  language: "vietnamese",
  history: [{ role: "user", content: "xin chào" }],
  text: "hôm nay thế nào",
};

describe("what a turn tells the platform the gadget can do", () => {
  // The catalogue the model decides from is the gadget's own report, and it travels as the
  // gadget gave it: the raw `inputSchema`, not this bridge's reading of it. `args` is what
  // the bridge clamps a relative command against and the platform has no use for it, so it
  // is projected away rather than sent as a second copy of what the schema already says.
  const TOOL: McpTool = {
    name: "self.audio_speaker.set_volume",
    description: "Set the volume of the audio speaker.",
    args: [{ name: "volume", type: "integer", min: 0, max: 100 }],
    inputSchema: {
      type: "object",
      properties: { volume: { type: "integer", minimum: 0, maximum: 100 } },
    },
  };

  it("carries the gadget's own report, and nothing at all when there is none", () => {
    assert.deepEqual(JSON.parse(turnForm({ ...REQUEST, tools: [TOOL] }).get("tools") as string), [
      {
        name: "self.audio_speaker.set_volume",
        description: "Set the volume of the audio speaker.",
        inputSchema: {
          type: "object",
          properties: { volume: { type: "integer", minimum: 0, maximum: 100 } },
        },
      },
    ]);

    // Absent, not empty. A gadget that reported nothing is a turn the model answers with no
    // tools, which is what every turn was before this existed — and an empty array is a
    // different claim from that silence.
    assert.equal(turnForm(REQUEST).get("tools"), null);
    assert.equal(turnForm({ ...REQUEST, tools: [] }).get("tools"), null);
  });

  it("carries the bridge's own tools in the same field, and does not say which is which", () => {
    // One field, two catalogues, and the platform is told nothing about the difference — it
    // passes a `tools` array it already passed and emits a `tool_call` it already emitted
    // (proposal, Non-goals). What tells them apart is the name, and only the two ends that have
    // to route on it read it that way.
    const ours = musicTools("/srv/music");
    const sent = JSON.parse(turnForm({ ...REQUEST, tools: [...ours] }).get("tools") as string) as {
      name: string;
    }[];

    assert.deepEqual(sent.map((tool) => tool.name), ["bridge.play_music", "bridge.stop_music"]);
    assert.ok(sent.every((tool) => !/^self\./.test(tool.name)), "and none of them as something the gadget has");

    // A gadget that reported nothing is a turn asked with the bridge's own tools *alone* — the
    // field is present for them where it used to be absent for everything.
    assert.deepEqual(
      JSON.parse(turnForm({ ...REQUEST, tools: [...ours, TOOL] }).get("tools") as string).length,
      3
    );
  });
});

describe("which engine a turn asks for", () => {
  it("asks for this deployment's engine, the same one for every language", () => {
    // `validateEngine` folds an omitted field to `"kokoro"` before the language is
    // consulted, so the bridge must name the engine it wants. It names this
    // deployment's, and that no longer varies with the language — the voice still
    // does, and stays the platform's to resolve.
    assert.equal(TURN_ENGINE, "supertonic");
    assert.equal(turnForm(REQUEST).get("engine"), "supertonic");
  });
});

describe("the turn request", () => {
  it("carries the persona's three fields, the language and the engine", async () => {
    const form = turnForm(REQUEST);
    assert.equal(form.get("language"), "vietnamese");
    assert.equal(form.get("engine"), "supertonic");
    assert.equal(form.get("systemPrompt"), REQUEST.systemPrompt);
    assert.equal(form.get("answerMode"), "generate");
    assert.deepEqual(JSON.parse(form.get("enabledTopics") as string), ["Truyện cười"]);
    assert.deepEqual(JSON.parse(form.get("history") as string), [
      { role: "user", content: "xin chào" },
    ]);
    assert.equal(form.get("text"), "hôm nay thế nào");
  });

  it("always asks for a spoken turn", () => {
    // Every turn this bridge sends is one a device is waiting to hear. A turn sent
    // unspoken would come back with `audioData: null` on every sentence (D4), and
    // the gadget would sit silent with nothing in the log to say why.
    assert.equal(turnForm(REQUEST).get("speak"), "1");
  });

  it("omits the topics field rather than sending an empty list", () => {
    const form = turnForm({ ...REQUEST, enabledTopics: [] });
    assert.equal(form.get("enabledTopics"), null, "no topics is a turn that searches nothing");
  });

  it("sends the audio file when the turn has one, and no text", () => {
    const form = turnForm({
      ...REQUEST,
      text: undefined,
      audio: { filename: "utterance.wav", contentType: "audio/wav", data: Buffer.from("RIFF....") },
    });
    const audio = form.get("audio");
    assert.ok(audio instanceof File, "the audio arrives as a file part, not a field");
    assert.equal(audio.name, "utterance.wav");
    assert.equal(form.get("text"), null, "the endpoint reads one or the other");
  });

  it("is posted as multipart with the platform's credential and nothing else", async () => {
    const platform = await stubPlatform(streamSse([["done", { fullText: "ok" }]]));
    try {
      await runTurn(configFor(platform.url), REQUEST, {});
      const [seen] = platform.requests;
      assert.equal(seen.path, "/api/voice-agent/stream");
      assert.equal(seen.authorization, `Bearer ${PLATFORM}`);
      // `fetch` writes this one, boundary and all. A hand-set `content-type` without
      // a boundary is a body the platform cannot parse into fields.
      assert.match(seen.contentType ?? "", /^multipart\/form-data; boundary=/);
      assert.match(seen.body, /name="language"\r\n\r\nvietnamese/);
    } finally {
      platform.stop();
    }
  });
});

describe("reading the reply's stream", () => {
  it("hands every event to the sink in arrival order, and reports the reply", async () => {
    // The platform's `text` event carries one *segment* of the reply — the
    // chunk it is about to speak — alongside its index, so the accumulated
    // fallback has to be joined rather than concatenated: segments are trimmed.
    const platform = await stubPlatform(
      streamSse([
        ["user", { text: "hôm nay thế nào", messageId: "m1" }],
        ["sentence", { index: 0, text: "Chào bạn.", audioData: Buffer.from("A").toString("base64") }],
        ["text", { index: 0, text: "Chào bạn." }],
        ["sentence", { index: 1, text: "Tôi khỏe.", audioData: null }],
        ["text", { index: 1, text: "Tôi khỏe." }],
        ["done", { messageId: "m2", fullText: "Chào bạn. Tôi khỏe." }],
      ])
    );
    try {
      const { sink, log, sentences } = recordingSink();
      const outcome = await runTurn(configFor(platform.url), REQUEST, sink);

      assert.deepEqual(log, [
        "user:hôm nay thế nào",
        "sentence:0",
        "text:Chào bạn.",
        "sentence:1",
        "text:Tôi khỏe.",
      ]);
      assert.equal(outcome.replyText, "Chào bạn. Tôi khỏe.");
      assert.equal(outcome.settled, true);
      assert.deepEqual(sentences[0].audio, Buffer.from("A"));
      assert.equal(sentences[1].audio, null, "a sentence with no audio is a value, not a failure (5.5)");
    } finally {
      platform.stop();
    }
  });

  it("reads an event split across two chunks", async () => {
    // Chunk boundaries fall wherever the network puts them, and a reader that
    // parsed each chunk as if it were whole would drop whichever sentence was cut.
    const platform = await stubPlatform(async (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: user\ndata: {\"text\":\"xin ");
      // A tick between the writes so the two really do leave as separate chunks,
      // rather than being coalesced into one write the split never exercises.
      await new Promise((resolve) => setImmediate(resolve));
      res.write("chào\"}\n\nevent: done\ndata: {\"fullText\":\"Chào bạn.\"}\n\n");
      res.end();
    });
    try {
      const { sink, log } = recordingSink();
      const outcome = await runTurn(configFor(platform.url), REQUEST, sink);
      assert.deepEqual(log, ["user:xin chào"]);
      assert.equal(outcome.replyText, "Chào bạn.");
    } finally {
      platform.stop();
    }
  });

  it("ignores the heartbeat, and any event it does not model", async () => {
    const platform = await stubPlatform(async (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": heartbeat\n\n");
      res.write(sse("something-newer", { anything: true }));
      res.write(sse("done", { fullText: "ok" }));
      res.end();
    });
    try {
      const { sink, log } = recordingSink();
      const outcome = await runTurn(configFor(platform.url), REQUEST, sink);
      assert.deepEqual(log, [], "neither a comment nor an unmodelled event is the sink's business");
      assert.equal(outcome.replyText, "ok");
    } finally {
      platform.stop();
    }
  });

  it("waits for the sink before reading the next event", async () => {
    // Speech to a device is paced by a socket, so the sink has to be able to slow
    // the reader down. Without this the only way to pace is to buffer the whole
    // reply first, which is the opposite of streaming per sentence (D4).
    const platform = await stubPlatform(
      streamSse([
        ["sentence", { index: 0, text: "one", audioData: null }],
        ["sentence", { index: 1, text: "two", audioData: null }],
      ])
    );
    try {
      const order: string[] = [];
      await runTurn(configFor(platform.url), REQUEST, {
        onSentence: async (sentence) => {
          order.push(`begin:${sentence.index}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push(`end:${sentence.index}`);
        },
      });
      assert.deepEqual(order, ["begin:0", "end:0", "begin:1", "end:1"]);
    } finally {
      platform.stop();
    }
  });

  it("reports a stream that ended without the platform saying it had", async () => {
    const platform = await stubPlatform(async (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("text", { text: "half an answer" }));
      res.end();
    });
    try {
      const { sink } = recordingSink();
      const outcome = await runTurn(configFor(platform.url), REQUEST, sink);
      assert.equal(outcome.replyText, "half an answer");
      assert.equal(outcome.settled, false, "a cut-off turn and a finished one are not the same thing");
    } finally {
      platform.stop();
    }
  });

  it("joins a chunk-split reply that never got a done event", async () => {
    // The platform announces one segment at a time, and a segment is trimmed, so
    // these three events are three pieces of one sentence. Without the separating
    // space the fallback would read "một haibavà ba" — which is what the device
    // would then put in the conversation's history.
    const platform = await stubPlatform(async (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("text", { index: 0, text: "một hai" }));
      res.write(sse("text", { index: 1, text: "ba và" }));
      res.write(sse("text", { index: 2, text: "bốn" }));
      res.end();
    });
    try {
      const { sink } = recordingSink();
      const outcome = await runTurn(configFor(platform.url), REQUEST, sink);
      assert.equal(outcome.replyText, "một hai ba và bốn");
      assert.equal(outcome.settled, false, "there was still no done event");
    } finally {
      platform.stop();
    }
  });
});

describe("when the platform refuses the turn", () => {
  it("surfaces an in-band error to the sink and still settles", async () => {
    // The refusal arrives over an HTTP 200, long after the turn began (4.4). It is
    // the sink's to report — the caller has a device to answer either way.
    const platform = await stubPlatform(
      streamSse([["error", { message: "systemPrompt is required" }]])
    );
    try {
      const { sink, log } = recordingSink();
      const outcome = await runTurn(configFor(platform.url), REQUEST, sink);
      assert.deepEqual(log, ["error:systemPrompt is required"]);
      assert.equal(outcome.settled, true);
      assert.equal(outcome.replyText, "");
    } finally {
      platform.stop();
    }
  });

  it("surfaces a notice, which is the platform saying there is nothing to act on", async () => {
    const platform = await stubPlatform(
      streamSse([["notice", { code: "no_speech", message: "No speech detected. Please try again." }]])
    );
    try {
      const { sink, log } = recordingSink();
      const outcome = await runTurn(configFor(platform.url), REQUEST, sink);
      assert.deepEqual(log, ["notice:no_speech:No speech detected. Please try again."]);
      assert.equal(outcome.settled, true);
    } finally {
      platform.stop();
    }
  });

  it("throws when the request never became a stream, naming the status and not the token", async () => {
    const platform = await stubPlatform((res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    });
    try {
      await assert.rejects(
        () => runTurn(configFor(platform.url), REQUEST, {}),
        (error: Error) => {
          assert.match(error.message, /401/);
          assert.ok(
            !error.message.includes(PLATFORM),
            "the credential asked with the request; it must not be in what is reported back"
          );
          return true;
        }
      );
    } finally {
      platform.stop();
    }
  });
});

describe("aborting a turn", () => {
  it("stops reading when the caller aborts, and calls it ended rather than failed", async () => {
    // The wake word firing mid-turn is an abort (6.5): the turn is over, and the
    // reader has to let go of a stream the platform is still writing to. What it
    // must not do is raise — an abort raised as an error reaches the dispatcher as
    // a failure, and the conversation loses the person's question with the reply
    // that was cut off (D15). So the outcome is the one `settled: false` already
    // names: a turn that was cut off rather than one that ended.
    const platform = await stubPlatform(async (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("sentence", { index: 0, text: "one", audioData: null }));
      await new Promise((resolve) => setTimeout(resolve, 500));
      res.write(sse("done", { fullText: "never read" }));
      res.end();
    });
    try {
      const controller = new AbortController();
      const seen: number[] = [];
      const outcome = await runTurn(
        configFor(platform.url),
        REQUEST,
        {
          onSentence: (sentence) => {
            seen.push(sentence.index);
            controller.abort();
          },
        },
        controller.signal
      );
      assert.deepEqual(seen, [0], "the first sentence was delivered before the abort");
      // The platform writes `done` half a second later, so an outcome that says the
      // reply settled is an outcome from a reader that kept reading.
      assert.equal(outcome.settled, false, "a cancelled turn did not settle");
      assert.equal(outcome.replyText, "", "and nothing the platform said afterwards was read");
    } finally {
      platform.stop();
    }
  });
});
