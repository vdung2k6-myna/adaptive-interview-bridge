import { info, log, warn } from "../log.js";

/**
 * The gadget's own controls, over the one channel on this socket the bridge opens.
 *
 * The gadget is the MCP **server** and this bridge is the client, which is worth
 * stating because the words point the other way round from everything else on this
 * socket: the gadget's tools exist for us only inside the answer to a question we
 * ask, and a session that asks nothing — which is every session this bridge has run
 * so far — carries the string `mcp` exactly once, in the connect message (D1).
 * Nothing here announces itself, and nothing arrives unbidden.
 *
 * Three requests, in order: `initialize`, which also tells us what the gadget calls
 * itself; `tools/list`, whose pages are read until it names no further one; and
 * `tools/call`, once per command the person gives. Each is wrapped in the gadget's
 * own envelope — `{"session_id":…, "type":"mcp", "payload":<json-rpc>}`, which is
 * `Protocol::SendMcpMessage` on the firmware's side — and each carries a **numeric**
 * `id`. That is not decoration: the firmware reads the method first, returns in
 * silence from anything whose method begins with `notifications`, and then refuses
 * whatever is left without a numeric `id` before dispatching it (D2). There is
 * therefore no `notifications/initialized` here, whatever the gadget's own document
 * implies is part of the flow.
 *
 * All of it is best-effort (D4). A gadget that never answers, an answer that cannot
 * be read, a report that names no tools: each leaves the session running as it runs
 * today, with one line in the log and nothing callable. The interview is the product;
 * these controls are a convenience on top of it, and none of them may cost a turn.
 */

/** 1 === OPEN, checked as a literal rather than through `ws`'s own constants. */
const OPEN = 1;

/**
 * How long a request waits for its answer, in ms.
 *
 * A tool call is queued onto the gadget's main thread and answered from there, so a
 * reply is not instantaneous even on a healthy board. Three seconds is an order of
 * magnitude past a working exchange on a LAN, and a deadline rather than a hang is
 * what keeps a gadget with a broken tool channel from parking a session on it (D4).
 */
const REPLY_TIMEOUT_MS = 3000;

/**
 * How many pages of `tools/list` are read before the report is taken as it stands.
 *
 * A cap rather than a bound the gadget is expected to reach: this board registers
 * five tools against a page limit of 8000 bytes, so a report that keeps naming a
 * further page is a gadget repeating a cursor, not a gadget with more tools. What
 * was read is kept — a name that was not read is not called (D3), so a partial
 * catalog is safe where an unbounded loop is not.
 */
const PAGE_LIMIT = 8;

/** The protocol version this client speaks. The firmware answers with its own, which
 *  is the same date; nothing here depends on them matching, and a mismatch is logged
 *  rather than refused. */
const PROTOCOL_VERSION = "2024-11-05";

/** The slice of a socket this module needs, so a test can be a socket too. */
export interface McpSocket {
  send(data: string, options?: { binary?: boolean }): void;
  readyState: number;
}

/**
 * One argument a tool declares, as the gadget's own `inputSchema` described it. The
 * firmware renders an integer property's `minimum` and `maximum` into the schema
 * (`mcp_server.h`), which is where a relative command gets the range it is clamped
 * to.
 */
export interface McpArgument {
  name: string;
  /** The JSON Schema type: `integer`, `string`, `boolean`. */
  type: string;
  /** The declared floor, when the gadget declared one. `null` is "it did not say". */
  min: number | null;
  max: number | null;
}

/** One tool, as the gadget reported it. Names and descriptions are the firmware's
 *  own words: `self.audio_speaker.set_volume`, whose description says to read the
 *  device status first when the current volume is unknown (D3, D6). */
export interface McpTool {
  name: string;
  description: string;
  args: readonly McpArgument[];
}

export type McpCall =
  | {
      /** The gadget answered this call. `text` is its own result text — which may be
       *  `"false"`, the way `self.screen.set_theme` answers a theme it does not have:
       *  a refusal, not a failure, and one the caller has to read. */
      ok: true;
      text: string;
    }
  | { ok: false; message: string };

export interface McpClient {
  /**
   * Speak the handshake and read the catalog, once per session. Resolves when the
   * attempt is over, however it went — awaited by nothing in the session path (D4).
   */
  start(): Promise<void>;
  /**
   * Hand this client one `payload` off an inbound `mcp` frame. Returns whether the
   * frame was a reply this client was waiting for, so the connection can tell a
   * message it acted on from one it merely logged.
   */
  receive(payload: unknown): boolean;
  /** A tool the gadget reported, or `null` — which is "not reported", not "not yet
   *  known". Until the catalog is read, nothing is callable (D3). */
  tool(name: string): McpTool | null;
  /** The whole report, in the order the gadget gave it. */
  tools(): readonly McpTool[];
  /** Ask the gadget to do one thing. Never throws: a call that cannot be made is a
   *  line in the log and a report to the caller. */
  call(name: string, args: Record<string, unknown>): Promise<McpCall>;
}

/**
 * Whether a connect message says the gadget has tools at all.
 *
 * The firmware sends `{"mcp":true}` in its hello; the bridge asks nothing of a device
 * that did not say so, and a value that is merely truthy is not a statement that the
 * tool channel works (D4). It lives here rather than at the call site because this is
 * the module that would be doing the asking.
 */
export function advertisesTools(features: Record<string, unknown> | undefined): boolean {
  return features?.mcp === true;
}

/** A JSON-RPC reply, to the depth this client reads it: which request it answers,
 *  and either what came back or why it did not. */
interface JsonRpcReply {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface McpOptions {
  /**
   * How long a request waits for its answer. Injected rather than reached for, for
   * the reason the speaker's clock is (D13): a check that a gadget which never answers
   * costs the session nothing wants a deadline that arrives now.
   */
  replyTimeoutMs?: number;
}

export function createMcpClient(socket: McpSocket, sessionId: string, options: McpOptions = {}): McpClient {
  const replyTimeoutMs = options.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
  // Session-scoped, like the id it counts: the gadget's own numbering of its requests
  // is per connection, and a reply is matched by the number this client gave it.
  let nextId = 1;
  let started = false;
  const waiting = new Map<number, { settle: (reply: JsonRpcReply | null) => void; timer: NodeJS.Timeout }>();
  const reported = new Map<string, McpTool>();

  const send = (payload: Record<string, unknown>): boolean => {
    if (socket.readyState !== OPEN) {
      // A device that has gone is not waited for. The session is over and the close
      // is already the next line in the log; a warning per request would report the
      // same drop once per request.
      return false;
    }
    socket.send(JSON.stringify({ session_id: sessionId, type: "mcp", payload }));
    return true;
  };

  /**
   * One request, one reply, one deadline. A `null` is "no answer came at all", which
   * is a different fact from an answer carrying an `error` — the first is a gadget
   * whose tool channel is not there, the second is a gadget that understood and said
   * no, and the log should not read the same for both.
   */
  const request = (method: string, params?: Record<string, unknown>): Promise<JsonRpcReply | null> =>
    new Promise((resolve) => {
      const id = nextId;
      nextId += 1;
      // Not unref'd. The deadline is what makes this promise one that always settles,
      // and a timer that the event loop is free to forget would leave `start()` — and
      // anything else awaiting a call — waiting on a reply that is never coming.
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve(null);
      }, replyTimeoutMs);
      waiting.set(id, { settle: resolve, timer });
      if (!send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })) {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(null);
      }
    });

  /** The gadget's report of what it can do, read a page at a time until it names no
   *  further page. Returns how many tools were read, or `null` if a page could not be
   *  read — which is not the same as a report that carried no tools. */
  async function readCatalog(): Promise<number | null> {
    let cursor: string | undefined;
    for (let page = 0; page < PAGE_LIMIT; page += 1) {
      const reply: JsonRpcReply | null = await request("tools/list", cursor ? { cursor } : {});
      if (reply === null || reply.error !== undefined || reply.result === undefined) return null;
      const { tools, nextCursor } = reply.result as { tools?: unknown; nextCursor?: unknown };
      if (!Array.isArray(tools)) return null;
      for (const raw of tools) {
        const tool = readTool(raw);
        // A tool with no name is not a tool: there is nothing to call it by, and
        // inventing one would put an entry in a catalog the bridge then trusts.
        if (tool) reported.set(tool.name, tool);
      }
      if (typeof nextCursor !== "string" || nextCursor === "") return reported.size;
      cursor = nextCursor;
    }
    warn(`the gadget's tool report still named a further page after ${PAGE_LIMIT}; keeping the ${reported.size} read`);
    return reported.size;
  }

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;

      const hello = await request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        // No `vision`: the firmware reads a `vision.url` here and hands it to a camera
        // as where to send a photo for explanation. The bridge has no such endpoint and
        // never calls a camera, so declaring the capability would be a promise about
        // infrastructure that does not exist.
        capabilities: {},
      });
      if (hello === null) {
        warn("the gadget did not answer the tool handshake — this session has nothing callable (D4)");
        return;
      }
      if (hello.error !== undefined) {
        warn(`the gadget refused the tool handshake: ${hello.error.message ?? "no reason given"}`);
        return;
      }

      const { protocolVersion, serverInfo } = (hello.result ?? {}) as {
        protocolVersion?: unknown;
        serverInfo?: { name?: unknown; version?: unknown };
      };
      const name = typeof serverInfo?.name === "string" ? serverInfo.name : "unnamed";
      const version = typeof serverInfo?.version === "string" ? serverInfo.version : "unversioned";
      info(`gadget tool handshake: ${name} ${version}, protocol ${String(protocolVersion)}`);

      const count = await readCatalog();
      if (count === null) {
        warn("the gadget's tool report could not be read — this session has nothing callable (D4)");
        return;
      }
      // The whole of what is callable, said once and in full. An operator checking this
      // against the firmware's own registration list reads this line rather than a
      // running session's traffic (1.3).
      log(
        `gadget reports ${count} tool(s): ` +
          `${[...reported.values()].map((tool) => `${tool.name}(${tool.args.map((a) => a.name).join(",")})`).join(", ")}` +
          `${count === 0 ? " — nothing is callable this session" : ""}`
      );
    },

    receive(payload: unknown): boolean {
      if (typeof payload !== "object" || payload === null) return false;
      const id = (payload as { id?: unknown }).id;
      // Notifications carry no id, and requests are the gadget's business rather than
      // ours: the gadget never sends one (it has no path that speaks first), and a
      // reply is the only thing here that has an `id` this client chose.
      if (typeof id !== "number") return false;
      const pending = waiting.get(id);
      if (!pending) return false;
      waiting.delete(id);
      clearTimeout(pending.timer);
      pending.settle(payload as JsonRpcReply);
      return true;
    },

    tool(name: string): McpTool | null {
      return reported.get(name) ?? null;
    },

    tools(): readonly McpTool[] {
      return [...reported.values()];
    },

    async call(name: string, args: Record<string, unknown>): Promise<McpCall> {
      if (!reported.has(name)) {
        // The report is the whole of what is callable (D3). A call to a name it did not
        // carry is the one mistake that comes back as `Unknown tool:` from a gadget the
        // bridge believed it understood, so it is refused here, where the report is,
        // rather than attempted in the hope that the board registered it.
        warn(`refusing to call ${name}: the gadget's report did not carry that tool`);
        return { ok: false, message: `the gadget did not report a tool named ${name}` };
      }

      info(`-> tools/call ${name}(${JSON.stringify(args)})`);
      const reply = await request("tools/call", { name, arguments: args });
      if (reply === null) {
        return { ok: false, message: `the gadget did not answer the call to ${name}` };
      }
      if (reply.error !== undefined) {
        return { ok: false, message: reply.error.message ?? `the gadget refused the call to ${name}` };
      }
      const text = readResultText(reply.result);
      if (text === null) {
        return { ok: false, message: `the gadget's answer to ${name} carried nothing readable` };
      }
      return { ok: true, text };
    },
  };
}

/** One tool off a `tools/list` page, or `null` for an entry that is not one. */
function readTool(raw: unknown): McpTool | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { name, description, inputSchema } = raw as {
    name?: unknown;
    description?: unknown;
    inputSchema?: unknown;
  };
  if (typeof name !== "string" || name === "") return null;
  return {
    name,
    description: typeof description === "string" ? description : "",
    args: readArgs(inputSchema),
  };
}

/** What a tool declares it takes, in the order the gadget declared it. */
function readArgs(schema: unknown): McpArgument[] {
  if (typeof schema !== "object" || schema === null) return [];
  const { properties } = schema as {
    properties?: Record<string, { type?: unknown; minimum?: unknown; maximum?: unknown }>;
  };
  if (typeof properties !== "object" || properties === null) return [];

  const args: McpArgument[] = [];
  for (const [name, spec] of Object.entries(properties)) {
    args.push({
      name,
      type: typeof spec?.type === "string" ? spec.type : "unknown",
      min: typeof spec?.minimum === "number" ? spec.minimum : null,
      max: typeof spec?.maximum === "number" ? spec.maximum : null,
    });
  }
  return args;
}

/**
 * The text of a tool's result.
 *
 * The firmware renders every return value into one `content` item of type `text`
 * (`mcp_server.h`): a boolean becomes `"true"` or `"false"`, an integer becomes its
 * digits, and `self.get_device_status`'s own object becomes that object's JSON as a
 * **string**, to be parsed by whoever asked.
 */
function readResultText(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const { content } = result as { content?: unknown };
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    const { type, text } = (item ?? {}) as { type?: unknown; text?: unknown };
    if (type === "text" && typeof text === "string") return text;
  }
  return null;
}
