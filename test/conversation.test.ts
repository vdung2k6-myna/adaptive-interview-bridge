import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BridgeConfig } from "../src/config.js";
import { createPersonaCatalog, type Persona } from "../src/personas.js";
import { createConversations, takeTurn } from "../src/conversation.js";
import type { TurnSink } from "../src/turn.js";

/**
 * A gadget's conversation, which the platform does not keep.
 *
 * The endpoint is stateless (D2), so this is the only thing standing between the
 * gadget and total amnesia — and it fails quietly when it fails. A conversation
 * that is dropped looks exactly like a conversation that was never sent, and one
 * that is not bounded looks fine until the turn where it is refused. So the two
 * halves under test are the ones a person would notice: what a turn carries in,
 * and what it leaves behind.
 *
 * The stub platform speaks both routes this module needs, and the requests it
 * records are read back as the fields they were posted as — because the thing
 * being pinned is what a turn says on the wire, not what a function returned.
 */
const PLATFORM = "platform-token-abcdefgh";

const CATALOG: Persona[] = [
  {
    id: "interview-coach",
    label: "Interview Coach",
    defaultPrompt: "You are an interview coach.",
    knowledgeTopics: ["STAR Method"],
    answerMode: "generate",
  },
  {
    id: "language-partner",
    label: "Language Partner",
    defaultPrompt: "You are a patient language partner.",
    knowledgeTopics: [],
    answerMode: "generate",
  },
];

function configFor(
  platformUrl: string,
  options: { historyTurns?: number; binding?: string } = {}
): BridgeConfig {
  return {
    otaPort: 0,
    wsPort: 0,
    publicHost: "127.0.0.1",
    deviceSecret: "s".repeat(43),
    allowedDevices: ["b81f3f4a9b01", "aa11bb22cc33"],
    devicePersonas: new Map([
      ["b81f3f4a9b01", options.binding ?? "interview-coach"],
      ["aa11bb22cc33", "language-partner"],
    ]),
    platformUrl,
    apiAuthToken: PLATFORM,
    framing: 3,
    serverRate: 24000,
    frameMs: 60,
    historyTurns: options.historyTurns ?? 20,
  };
}

interface StubRequest {
  path: string;
  body: string;
}

interface Stub {
  url: string;
  requests: StubRequest[];
  /** Replace the stream the turn route answers with. */
  reply(stream: (res: ServerResponse) => void | Promise<void>): void;
  stop(): void;
}

/** The two routes this module uses: the catalog, and a turn's stream. */
async function stubPlatform(): Promise<Stub> {
  const requests: StubRequest[] = [];
  let stream: (res: ServerResponse) => void | Promise<void> = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: done\ndata: {"fullText":"ok"}\n\n');
    res.end();
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ path: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      if ((req.url ?? "").startsWith("/api/personas")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(CATALOG));
        return;
      }
      void stream(res);
    });
  });
  server.listen(0, "127.0.0.1");
  // 127.0.0.1 rather than "localhost", for the reason the other stubs give: the
  // name resolves to ::1 first here, and a stub on IPv4 then looks like a bug.
  if (!server.address()) await once(server, "listening");

  return {
    requests,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    reply(next) {
      stream = next;
    },
    stop() {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** A multipart field's value, as the platform reads it off the wire. */
function fieldOf(body: string, name: string): string | null {
  const at = body.indexOf(`name="${name}"`);
  if (at < 0) return null;
  const start = body.indexOf("\r\n\r\n", at);
  if (start < 0) return null;
  const end = body.indexOf("\r\n--", start);
  return end < 0 ? null : body.slice(start + 4, end);
}

/** The `history` a turn was posted with, as messages. */
function historyOf(body: string): Array<{ role: string; content: string }> {
  const raw = fieldOf(body, "history");
  assert.ok(raw !== null, "every turn carries a history field, empty or not");
  return JSON.parse(raw) as Array<{ role: string; content: string }>;
}

/** Answer each turn with the next reply, transcribing it as `asked <n>`. */
function replyingWith(replies: string[]) {
  let index = 0;
  return (res: ServerResponse) => {
    index += 1;
    const text = replies[Math.min(index - 1, replies.length - 1)];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: user\ndata: ${JSON.stringify({ text: `asked ${index}` })}\n\n`);
    res.write(`event: text\ndata: ${JSON.stringify({ text })}\n\n`);
    res.write(`event: done\ndata: ${JSON.stringify({ fullText: text })}\n\n`);
    res.end();
  };
}

const noSink: TurnSink = {};

/** A catalog read from the stub, which is what every turn resolves against. */
async function readyCatalog(config: BridgeConfig) {
  const catalog = createPersonaCatalog(config);
  await catalog.refresh();
  return catalog;
}

describe("holding a conversation", () => {
  it("keeps each device's conversation to itself", () => {
    const conversations = createConversations(configFor("http://unused"));
    conversations.record("b81f3f4a9b01", { user: "one", agent: "answer one" });
    conversations.record("aa11bb22cc33", { user: "two", agent: "answer two" });

    assert.deepEqual(conversations.history("b81f3f4a9b01"), [
      { role: "user", content: "one" },
      { role: "agent", content: "answer one" },
    ]);
    assert.deepEqual(conversations.history("aa11bb22cc33"), [
      { role: "user", content: "two" },
      { role: "agent", content: "answer two" },
    ]);
  });

  it("gives a device that has never spoken an empty history", () => {
    const conversations = createConversations(configFor("http://unused"));
    assert.deepEqual(conversations.history("aa11bb22cc33"), []);
  });

  it("orders turns oldest first, the person before the gadget", () => {
    const conversations = createConversations(configFor("http://unused"));
    conversations.record("d", { user: "first question", agent: "first answer" });
    conversations.record("d", { user: "second question", agent: "second answer" });

    assert.deepEqual(
      conversations.history("d").map((m) => `${m.role}:${m.content}`),
      ["user:first question", "agent:first answer", "user:second question", "agent:second answer"]
    );
  });

  it("leaves out a side that is empty rather than sending it blank", () => {
    // A refused turn has no reply; a turn with nothing recognised in it has no
    // transcript. Either would otherwise reach the model as a turn nobody took.
    const conversations = createConversations(configFor("http://unused"));
    conversations.record("d", { user: "something said", agent: "" });

    assert.deepEqual(conversations.history("d"), [{ role: "user", content: "something said" }]);
  });

  it("does not spend a turn on an exchange with nothing in it", () => {
    const conversations = createConversations(configFor("http://unused"));
    conversations.record("d", { user: "", agent: "" });
    assert.deepEqual(conversations.history("d"), []);
  });
});

describe("bounding a conversation", () => {
  it("drops the oldest turns and keeps the most recent", () => {
    const conversations = createConversations(configFor("http://unused", { historyTurns: 2 }));
    for (const n of [1, 2, 3, 4]) {
      conversations.record("d", { user: `q${n}`, agent: `a${n}` });
    }

    assert.deepEqual(
      conversations.history("d").map((m) => m.content),
      ["q3", "a3", "q4", "a4"],
      "the bound drops from the front, so the oldest is what goes"
    );
  });

  it("drops a turn whole, so the history never opens on an answer to nothing", () => {
    const conversations = createConversations(configFor("http://unused", { historyTurns: 3 }));
    for (const n of [1, 2, 3, 4, 5]) {
      conversations.record("d", { user: `q${n}`, agent: `a${n}` });
    }

    const roles = conversations.history("d").map((m) => m.role);
    assert.equal(roles[0], "user", `history opened with ${roles[0]}: ${roles.join(",")}`);
    assert.deepEqual(roles, ["user", "agent", "user", "agent", "user", "agent"]);
  });

  it("still holds a turn longer than the whole budget", () => {
    // Worse to send nothing than to send one long turn: the alternative is a gadget
    // that cannot speak until the conversation it is already in gets shorter.
    const conversations = createConversations(configFor("http://unused", { historyTurns: 1 }));
    conversations.record("d", { user: "q1", agent: "a1" });
    conversations.record("d", { user: "q2", agent: "a2" });

    assert.deepEqual(
      conversations.history("d").map((m) => m.content),
      ["q2", "a2"]
    );
  });

  it("holds only what it will send, however long the conversation runs", () => {
    // The bound is on what is kept, not only on what is sent: a service meant to
    // run for months cannot hold every turn a gadget has ever taken.
    const conversations = createConversations(configFor("http://unused", { historyTurns: 3 }));
    for (let n = 0; n < 500; n++) {
      conversations.record("d", { user: `q${n}`, agent: `a${n}` });
    }
    assert.equal(conversations.history("d").length, 6);
  });
});

describe("a device's turn, from the conversation's side", () => {
  it("sends the turns so far, and not the one being taken", async () => {
    const platform = await stubPlatform();
    platform.reply(replyingWith(["first answer", "second answer"]));
    try {
      const config = configFor(platform.url);
      const catalog = await readyCatalog(config);
      const conversations = createConversations(config);

      await takeTurn(
        config, catalog, conversations, "b8:1f:3f:4a:9b:01",
        { language: "english", text: "first question" }, noSink
      );
      await takeTurn(
        config, catalog, conversations, "b8:1f:3f:4a:9b:01",
        { language: "english", text: "second question" }, noSink
      );

      const turns = platform.requests.filter((r) => r.path.includes("stream"));
      assert.deepEqual(historyOf(turns[0].body), [], "nothing was said before the first turn");
      // The platform appends the current turn to the history itself, so sending it
      // here as well would put the same question to the model twice.
      assert.deepEqual(historyOf(turns[1].body), [
        { role: "user", content: "asked 1" },
        { role: "agent", content: "first answer" },
      ]);
      assert.equal(fieldOf(turns[1].body, "text"), "second question");
    } finally {
      platform.stop();
    }
  });

  it("takes the person's side from the stream's own transcription", async () => {
    // Not from what was submitted. The platform's transcription is what the model
    // will be shown next turn, and on an audio turn it is the only copy of what was
    // said that exists anywhere at all.
    const platform = await stubPlatform();
    platform.reply((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: user\ndata: {"text":"hôm nay trời đẹp"}\n\n');
      res.write('event: done\ndata: {"fullText":"Đúng vậy."}\n\n');
      res.end();
    });
    try {
      const config = configFor(platform.url);
      const catalog = await readyCatalog(config);
      const conversations = createConversations(config);

      await takeTurn(
        config, catalog, conversations, "b81f3f4a9b01",
        { language: "vietnamese", text: "something else entirely" }, noSink
      );

      assert.deepEqual(conversations.history("b81f3f4a9b01"), [
        { role: "user", content: "hôm nay trời đẹp" },
        { role: "agent", content: "Đúng vậy." },
      ]);
    } finally {
      platform.stop();
    }
  });

  it("still hands the transcript to the sink, having kept a copy", async () => {
    const platform = await stubPlatform();
    platform.reply(replyingWith(["Chào bạn."]));
    try {
      const config = configFor(platform.url);
      const catalog = await readyCatalog(config);
      const seen: string[] = [];

      await takeTurn(
        config, catalog, createConversations(config), "b81f3f4a9b01",
        { language: "vietnamese", text: "hi" },
        { onUser: (text) => void seen.push(text) }
      );

      // 6.2 reports this same text back to the device as its `stt` message, so
      // capturing it here must not swallow the event on its way past.
      assert.deepEqual(seen, ["asked 1"]);
    } finally {
      platform.stop();
    }
  });

  it("serves no turn at all when the device's persona is not in the catalog", async () => {
    const platform = await stubPlatform();
    try {
      const config = configFor(platform.url, { binding: "gone-from-the-catalog" });
      const catalog = await readyCatalog(config);

      const result = await takeTurn(
        config, catalog, createConversations(config), "b8:1f:3f:4a:9b:01",
        { language: "english", text: "hello" }, noSink
      );

      assert.equal(result.served, false);
      if (result.served) return;
      assert.equal(result.miss, "not-in-catalog");
      // The line an operator reads has to name the device and the identifier, or
      // there is nothing in it to act on (3.4).
      assert.match(result.message, /b8:1f:3f:4a:9b:01/);
      assert.match(result.message, /gone-from-the-catalog/);
      assert.equal(
        platform.requests.filter((r) => r.path.includes("stream")).length,
        0,
        "a gadget the catalog does not report is answered as no one, not as somebody else"
      );
    } finally {
      platform.stop();
    }
  });

  it("keeps the person's line, and invents nothing for the gadget, when a turn is refused", async () => {
    const platform = await stubPlatform();
    platform.reply((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: user\ndata: {"text":"hello"}\n\n');
      res.write('event: error\ndata: {"message":"systemPrompt is required"}\n\n');
      res.end();
    });
    try {
      const config = configFor(platform.url);
      const catalog = await readyCatalog(config);
      const conversations = createConversations(config);

      await takeTurn(
        config, catalog, conversations, "b81f3f4a9b01",
        { language: "english", text: "hello" }, noSink
      );

      assert.deepEqual(conversations.history("b81f3f4a9b01"), [
        { role: "user", content: "hello" },
      ]);
      // And the device can take a further turn: a refused turn is the platform's
      // answer to one turn, not a state the conversation is left in (4.4).
      const after = await takeTurn(
        config, catalog, conversations, "b81f3f4a9b01",
        { language: "english", text: "again" }, noSink
      );
      assert.equal(after.served, true);
    } finally {
      platform.stop();
    }
  });
});
