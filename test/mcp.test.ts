import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { advertisesTools, createMcpClient, type McpSocket } from "../src/protocol/mcp.js";

/**
 * The gadget's tool channel is a conversation the bridge has to open, and the shape
 * of the opening is not a preference: the firmware reads the method first, returns in
 * silence from anything whose method begins with `notifications`, then refuses
 * whatever is left without a numeric `id` — so a handshake that is polite in the way
 * the MCP document describes is a handshake the board drops without saying so (D2).
 * The first half of this file is what leaves the bridge, and it is asserted as
 * exactly that: the envelope, the id, and the absence of the notification.
 *
 * The second half is the catalog. What the bridge may call is what the gadget
 * reported and nothing else (D3), which is why a name that was not reported is
 * checked here rather than trusted at the call site, and why a gadget that answers
 * nothing at all is checked to cost this session nothing but its silence (D4).
 */

/** One JSON-RPC request, as the bridge builds it. */
interface Request {
  jsonrpc: string;
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** One frame off the wire: the gadget's envelope, and the request inside it. */
interface Frame {
  session_id: string;
  type: string;
  payload: Request;
}

/**
 * A gadget on the other end of the channel.
 *
 * It answers by method, the way the firmware does, and answers on the microtask queue
 * — a real board's latency is not what these tests are about, and the one case where
 * an answer never comes is checked by a device that answers nothing. Every frame it
 * receives is kept, because half of what this file asserts is what the bridge said.
 */
function gadget(device: (request: Request) => unknown) {
  const sent: Frame[] = [];
  let client: ReturnType<typeof createMcpClient> | null = null;

  const socket: McpSocket & { sent: Frame[] } = {
    sent,
    readyState: 1,
    send(data: string) {
      const frame = JSON.parse(data) as Frame;
      sent.push(frame);
      const answer = device(frame.payload);
      if (answer !== undefined) queueMicrotask(() => client?.receive(answer));
    },
  };

  client = createMcpClient(socket, "s1", { replyTimeoutMs: 50 });
  return {
    socket,
    sent,
    client,
    /** The methods the bridge spoke, in order. */
    methods: () => sent.map((frame) => frame.payload.method),
  };
}

/** The firmware's own reply shape: the id it was asked with, and either a result or
 *  an error. The id matters — a reply is matched to its request by it, and a device
 *  that answered with an id of its own would be answering nobody. */
const reply = (request: Request, result: unknown) => ({ jsonrpc: "2.0", id: request.id, result });
const failed = (request: Request, code: number, message: string) => ({
  jsonrpc: "2.0",
  id: request.id,
  error: { code, message },
});

/** A `tools/list` result, cursor and all. */
const page = (tools: unknown[], nextCursor = "") => ({ tools, nextCursor });

/** The tools this board registers, as `mcp_server.cc` renders them. */
const VOLUME = {
  name: "self.audio_speaker.set_volume",
  description: "Set the volume of the audio speaker. If the current volume is unknown, you must call `self.get_device_status` tool first and then call this tool.",
  inputSchema: { type: "object", properties: { volume: { type: "integer", minimum: 0, maximum: 100 } }, required: ["volume"] },
};
const THEME = {
  name: "self.screen.set_theme",
  description: "Set the theme of the screen. The theme can be `light` or `dark`.",
  inputSchema: { type: "object", properties: { theme: { type: "string" } }, required: ["theme"] },
};
const STATUS = {
  name: "self.get_device_status",
  description: "Provides the real-time information of the device.",
  inputSchema: { type: "object", properties: {} },
};

const HANDSHAKE = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "xiaozhi-s3", version: "1.0.0" } };

/** A gadget that answers the handshake and reports one page of tools. */
function reachable(tools: unknown[] = [STATUS, VOLUME, THEME]) {
  return gadget((request) => {
    if (request.method === "initialize") return reply(request, HANDSHAKE);
    if (request.method === "tools/list") return reply(request, page(tools));
    throw new Error(`the bridge called ${request.method}, which no test here expects`);
  });
}

describe("the gadget's tool handshake", () => {
  it("speaks the gadget's own envelope, with a numeric id", async () => {
    const g = reachable();
    await g.client.start();

    assert.equal(g.sent.length >= 2, true, "initialize and tools/list");
    const [first] = g.sent;
    assert.equal(first.session_id, "s1", "the envelope names the session the device was told");
    assert.equal(first.type, "mcp", "the firmware routes on this and only this");
    assert.equal(first.payload.jsonrpc, "2.0", "without this the firmware logs 'Invalid JSONRPC version' and drops it");
    assert.equal(first.payload.method, "initialize");
    assert.equal(typeof first.payload.id, "number", "a method with no numeric id is refused before dispatch (D2)");
  });

  it("sends no notification, which the gadget would drop in silence", async () => {
    // `notifications/initialized` is in the MCP document's own sequence diagram. The
    // firmware returns from any method beginning with `notifications` before it looks
    // for an id — silently, without even a log line — so sending one is a frame that
    // costs the LAN and buys nothing (D2).
    const g = reachable();
    await g.client.start();
    assert.deepEqual(g.methods(), ["initialize", "tools/list"]);
  });

  it("reads the catalog the gadget reports, a page at a time", async () => {
    // The firmware's cursor is the name of the first tool that did not fit its 8000
    // byte page, so a report is complete only when a page names no further one.
    const g = gadget((request) => {
      if (request.method === "initialize") return reply(request, HANDSHAKE);
      if (request.method === "tools/list") {
        if (request.params?.cursor === undefined) return reply(request, page([STATUS, VOLUME], "self.screen.set_theme"));
        if (request.params.cursor === "self.screen.set_theme") return reply(request, page([THEME]));
      }
      throw new Error(`unexpected ${request.method} ${JSON.stringify(request.params)}`);
    });
    await g.client.start();

    assert.deepEqual(
      g.client.tools().map((tool) => tool.name),
      ["self.get_device_status", "self.audio_speaker.set_volume", "self.screen.set_theme"],
      "every page is read before the report is treated as complete"
    );
    assert.equal(g.sent[2].payload.params?.cursor, "self.screen.set_theme", "the cursor the gadget named");
  });

  it("keeps each tool's own name, description and declared range", async () => {
    const g = reachable();
    await g.client.start();

    const volume = g.client.tool("self.audio_speaker.set_volume");
    assert.equal(volume?.args.length, 1);
    assert.equal(volume?.args[0].name, "volume", "the argument name the gadget declared is where the call puts the value");
    assert.equal(volume?.args[0].min, 0);
    assert.equal(volume?.args[0].max, 100);
    assert.match(volume?.description ?? "", /you must call `self.get_device_status` tool first/);

    const theme = g.client.tool("self.screen.set_theme");
    assert.equal(theme?.args[0].type, "string");
    assert.equal(theme?.args[0].min, null, "a string argument declares no range, and null is that answer rather than 0");
  });
});

describe("what the bridge may call", () => {
  it("refuses a tool the gadget did not report", async () => {
    // A board without a backlight registers no `set_brightness`, and the firmware
    // answers a call to it with `Unknown tool:` — a gadget the bridge believed it
    // understood. The report is the whole of what is callable (D3).
    const g = reachable();
    await g.client.start();

    const outcome = await g.client.call("self.screen.set_brightness", { brightness: 50 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok === false ? outcome.message : "", /did not report a tool named self\.screen\.set_brightness/);
    assert.deepEqual(g.methods(), ["initialize", "tools/list"], "nothing was attempted on the hope that it exists");
  });

  it("calls a reported tool with what it was given, and reads its answer", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const g = gadget((request) => {
      if (request.method === "initialize") return reply(request, HANDSHAKE);
      if (request.method === "tools/list") return reply(request, page([VOLUME]));
      if (request.method === "tools/call") {
        calls.push(request.params as Record<string, unknown>);
        return reply(request, { content: [{ type: "text", text: "true" }], isError: false });
      }
      throw new Error(request.method);
    });
    await g.client.start();

    const outcome = await g.client.call("self.audio_speaker.set_volume", { volume: 30 });
    assert.deepEqual(outcome, { ok: true, text: "true" });
    assert.deepEqual(calls, [{ name: "self.audio_speaker.set_volume", arguments: { volume: 30 } }]);
  });

  it("reads a tool's own refusal as an answer rather than a failure", async () => {
    // `self.screen.set_theme` returns `false` for a theme it does not have, and the
    // firmware renders that as the text "false" under a successful call. A bridge that
    // read only the error channel would report a screen that did not change as one
    // that did.
    const g = gadget((request) => {
      if (request.method === "initialize") return reply(request, HANDSHAKE);
      if (request.method === "tools/list") return reply(request, page([THEME]));
      return reply(request, { content: [{ type: "text", text: "false" }], isError: false });
    });
    await g.client.start();

    const outcome = await g.client.call("self.screen.set_theme", { theme: "sepia" });
    assert.deepEqual(outcome, { ok: true, text: "false" });
  });

  it("reports a call the gadget answered with an error", async () => {
    const g = gadget((request) => {
      if (request.method === "initialize") return reply(request, HANDSHAKE);
      if (request.method === "tools/list") return reply(request, page([VOLUME]));
      return failed(request, -32602, "Property 'volume': value 150 exceeds maximum 100");
    });
    await g.client.start();

    const outcome = await g.client.call("self.audio_speaker.set_volume", { volume: 150 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok === false ? outcome.message : "", /exceeds maximum 100/);
  });
});

describe("a gadget whose tool channel is not there", () => {
  it("leaves the session with nothing callable, and says so once", async () => {
    // D4: a gadget that advertises tools and never answers costs this session one
    // log line. Nothing waits on it, so the deadline is the only thing that ends it.
    const g = gadget(() => undefined);
    await g.client.start();

    assert.deepEqual(g.client.tools(), []);
    assert.equal(g.client.tool("self.audio_speaker.set_volume"), null);
    const outcome = await g.client.call("self.audio_speaker.set_volume", { volume: 30 });
    assert.equal(outcome.ok, false, "an unreported tool is refused, however loudly a firmware list would name it");
  });

  it("treats a report it cannot read as no report", async () => {
    // Half a page is not a catalog. Nothing is callable rather than whatever happened
    // to parse, because a catalog the bridge assembled from guesses is one it would
    // then trust.
    const g = gadget((request) => {
      if (request.method === "initialize") return reply(request, HANDSHAKE);
      return reply(request, { tools: "not a list" });
    });
    await g.client.start();
    assert.deepEqual(g.client.tools(), []);
  });

  it("accepts a report that carries no tools", async () => {
    const g = gadget((request) => {
      if (request.method === "initialize") return reply(request, HANDSHAKE);
      return reply(request, page([]));
    });
    await g.client.start();
    assert.deepEqual(g.client.tools(), []);
  });

  it("does not throw when the socket has already gone", async () => {
    const g = reachable();
    g.socket.readyState = 3;
    await g.client.start();
    assert.deepEqual(g.sent, [], "nothing is written to a socket nobody is reading");
    assert.deepEqual(g.client.tools(), []);
  });
});

describe("the frames the gadget sends back", () => {
  it("claims only the reply it was waiting for", async () => {
    const g = reachable();
    await g.client.start();

    // The gadget never speaks first — it has no path that emits one unprompted (D1) —
    // so a payload nothing is waiting for is a thing to log rather than to dispatch.
    assert.equal(g.client.receive({ jsonrpc: "2.0", id: 99, result: {} }), false, "an id this client did not choose");
    assert.equal(g.client.receive({ method: "notifications/something" }), false, "a notification, which carries no id");
    assert.equal(g.client.receive("not json"), false);
  });

  it("hands a reply to the request that was waiting, and to it only", async () => {
    let answered = false;
    const g = gadget((request) => {
      if (request.method === "initialize") return reply(request, HANDSHAKE);
      if (request.method === "tools/list") return reply(request, page([STATUS]));
      return undefined;
    });
    await g.client.start();

    const called = g.client.call("self.get_device_status", {});
    void called.then(() => {
      answered = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(answered, false, "no answer yet");

    // The bridge asks with an id of its own; the reply is matched to it and to nothing
    // else. The status arrives as the firmware renders it — one text item whose content
    // is the device's own JSON, as a string.
    const asked = g.sent[2].payload.id;
    const status = { audio_speaker: { volume: 42 }, screen: { brightness: 68, theme: "dark" } };
    assert.equal(g.client.receive({ jsonrpc: "2.0", id: asked, result: { content: [{ type: "text", text: JSON.stringify(status) }], isError: false } }), true);
    assert.deepEqual(await called, { ok: true, text: JSON.stringify(status) });
  });
});

describe("what counts as advertising tools", () => {
  it("is the firmware's own boolean, and nothing else", () => {
    assert.equal(advertisesTools({ mcp: true, glyph_push: true }), true);
    assert.equal(advertisesTools({ mcp: false }), false);
    assert.equal(advertisesTools({}), false);
    assert.equal(advertisesTools(undefined), false);
    assert.equal(advertisesTools({ mcp: "true" }), false, "a device that did not say so is asked nothing (D4)");
  });
});
