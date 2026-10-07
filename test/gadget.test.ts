import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeStatus, readStatus, createGadget, type GadgetStatus } from "../src/gadget.js";
import { ENDPOINTER_DEFAULTS, type BridgeConfig } from "../src/config.js";
import type { McpSocket } from "../src/protocol/mcp.js";

/**
 * The gadget's own account of itself, and the three settings the bridge will change
 * on it.
 *
 * The whole of this file is one claim in two halves: the bridge may tell the platform
 * what the gadget reported, and change what the gadget reported a tool for — and
 * nothing else. So the report is read as the gadget wrote it, every field optional,
 * because whether a battery gauge exists is the board's business and not this
 * bridge's; and a command is carried out against what the board says it holds, never
 * against what the bridge last heard.
 *
 * The stakes are in the numbers rather than in the words. A bridge that guessed a
 * current volume, or filled in an absent battery, would have a reply describe a gadget
 * nobody is holding — and the platform has no way to tell that from the truth
 * (requirement 5).
 */

/** One JSON-RPC request, as the bridge builds it. */
interface Request {
  jsonrpc: string;
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface Frame {
  session_id: string;
  type: string;
  payload: Request;
}

/** A tool call, as the bridge made it. Readable as the frame's own `params`, which is
 *  what a test casting one to this is saying. */
interface SettingCall extends Record<string, unknown> {
  name: string;
  arguments: Record<string, unknown>;
}

const STATUS_TOOL = {
  name: "self.get_device_status",
  description: "Provides the real-time information of the device.",
  inputSchema: { type: "object", properties: {} },
};
const VOLUME_TOOL = {
  name: "self.audio_speaker.set_volume",
  description: "Set the volume of the audio speaker. If the current volume is unknown, you must call `self.get_device_status` tool first and then call this tool.",
  inputSchema: { type: "object", properties: { volume: { type: "integer", minimum: 0, maximum: 100 } }, required: ["volume"] },
};
const BRIGHTNESS_TOOL = {
  name: "self.screen.set_brightness",
  description: "Set the brightness of the screen.",
  inputSchema: { type: "object", properties: { brightness: { type: "integer", minimum: 0, maximum: 100 } }, required: ["brightness"] },
};
const THEME_TOOL = {
  name: "self.screen.set_theme",
  description: "Set the theme of the screen. The theme can be `light` or `dark`.",
  inputSchema: { type: "object", properties: { theme: { type: "string" } }, required: ["theme"] },
};
const HANDSHAKE = {
  protocolVersion: "2024-11-05",
  capabilities: { tools: {} },
  serverInfo: { name: "xiaozhi-s3", version: "1.0.0" },
};

const reply = (request: Request, result: unknown) => ({ jsonrpc: "2.0", id: request.id, result });
const failed = (request: Request, message: string) => ({
  jsonrpc: "2.0",
  id: request.id,
  error: { code: -32602, message },
});

/** A tool's answer, as the firmware renders one: a boolean as its own word, an object
 *  as its own JSON, both as the first `text` item of the result. */
const answered = (request: Request, value: unknown) =>
  reply(request, {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    isError: false,
  });

/** A config that is a deployment's in every respect this file does not care about. */
function configFor(options: { commandStep?: number } = {}): BridgeConfig {
  return {
    otaPort: 0,
    wsPort: 0,
    publicHost: "127.0.0.1",
    deviceSecret: "s".repeat(43),
    allowedDevices: [],
    devicePersonas: new Map(),
    platformUrl: "http://unused",
    apiAuthToken: "token",
    framing: 3,
    serverRate: 24000,
    frameMs: 60,
    ...ENDPOINTER_DEFAULTS,
    historyTurns: 20,
    commandStep: options.commandStep ?? 10,
    language: "english",
  };
}

/**
 * A gadget that answers the handshake and a catalog, then answers `tools/call` with
 * whatever the callback returns — or, for `undefined`, with nothing at all. Answering
 * on the microtask queue, because a real board's latency is not what this file is
 * about; the one case where an answer never comes is a device that answers nothing,
 * and the deadline is injected short for it.
 */
function gadget(answers: (request: Request) => unknown, tools: unknown[] = [STATUS_TOOL], config = configFor()) {
  const sent: Frame[] = [];
  let client: ReturnType<typeof createGadget> | null = null;

  const socket: McpSocket & { sent: Frame[] } = {
    sent,
    readyState: 1,
    send(data: string) {
      const frame = JSON.parse(data) as Frame;
      sent.push(frame);
      if (frame.payload.method === "initialize") {
        queueMicrotask(() => client?.receive(reply(frame.payload, HANDSHAKE)));
        return;
      }
      if (frame.payload.method === "tools/list") {
        queueMicrotask(() => client?.receive(reply(frame.payload, { tools, nextCursor: "" })));
        return;
      }
      const answer = answers(frame.payload);
      if (answer !== undefined) queueMicrotask(() => client?.receive(answer));
    },
  };

  client = createGadget(socket, config, "s1", { replyTimeoutMs: 50 });
  return { socket, sent, gadget: client, methods: () => sent.map((frame) => frame.payload.method) };
}

/**
 * A board that holds its own settings, so that a call changes what the next status
 * read reports.
 *
 * That is what makes the arithmetic testable at all: a relative command is computed
 * from what the gadget says it holds *now*, so a fake that answered from a script
 * would be testing the script. Here the board is the state, and `set` is where a test
 * can have it do something other than what it was asked — which is how a person
 * holding the button during the call is expressed, their value winning over the
 * bridge's.
 */
function board(
  options: {
    volume?: number;
    brightness?: number;
    /** `null` is a board with no theme tool, which is what a screen 64 px or shorter
     *  registers. */
    theme?: string | null;
    /** `false` is a board with no backlight, so no brightness tool (D3). */
    backlight?: boolean;
    /** How far one relative command moves a setting, from configuration (D6). */
    commandStep?: number;
    set?: (call: SettingCall, held: { volume: number; brightness: number; theme: string | null }) => void;
  } = {}
) {
  const held = {
    volume: options.volume ?? 42,
    brightness: options.brightness ?? 68,
    // A board with no theme tool still reports *a* theme field in `held`; nothing reads
    // it, since the status it renders leaves the theme out (below).
    theme: options.theme ?? "light",
  };
  const registered: unknown[] = [STATUS_TOOL, VOLUME_TOOL];
  if (options.backlight !== false) registered.push(BRIGHTNESS_TOOL);
  if (options.theme !== null) registered.push(THEME_TOOL);

  const calls: SettingCall[] = [];
  const status = () => ({
    audio_speaker: { volume: held.volume },
    screen: { brightness: held.brightness, ...(options.theme === null ? {} : { theme: held.theme }) },
  });

  const b = gadget((request) => {
    if (request.method !== "tools/call") throw new Error(`the bridge called ${request.method}`);
    const call = request.params as SettingCall;
    calls.push(call);
    if (call.name === STATUS_TOOL.name) return answered(request, status());

    if (options.set) options.set(call, held);
    else if (call.name === VOLUME_TOOL.name) held.volume = call.arguments.volume as number;
    else if (call.name === BRIGHTNESS_TOOL.name) held.brightness = call.arguments.brightness as number;
    else if (call.name === THEME_TOOL.name) held.theme = call.arguments.theme as string;
    else throw new Error(`the bridge called ${call.name}, which no board registers`);

    // The firmware renders a tool's return value as text: all three of these return
    // booleans, so `"true"` is the gadget agreeing to what it was asked. Whether it
    // then *reports* having agreed is the separate matter `held` is there for.
    return answered(request, "true");
  }, registered, configFor({ commandStep: options.commandStep }));

  return { ...b, held, calls };
}

/** The board's own report, as `GetDeviceStatusJson` writes it when everything works. */
const FULL = {
  audio_speaker: { volume: 42 },
  screen: { brightness: 68, theme: "dark" },
  battery: { level: 87, charging: true },
  network: { type: "wifi", ssid: "nha", signal: "weak" },
};

const EMPTY: GadgetStatus = { volume: null, brightness: null, theme: null, battery: null, network: null };

describe("what the gadget reported about itself", () => {
  it("reads every field the board reported", () => {
    const status = readStatus(JSON.stringify(FULL));
    assert.deepEqual(status, {
      volume: 42,
      brightness: 68,
      theme: "dark",
      battery: { level: 87, charging: true },
      network: { type: "wifi", ssid: "nha", signal: "weak" },
    });
  });

  it("leaves a field the board did not report absent rather than unknown", () => {
    // A board with no battery gauge reports no battery, and a screen 64 px tall or
    // shorter registers no theme. Both are facts about *this* board, and turning
    // either into a placeholder is the "condition the bridge made up" the requirement
    // refuses.
    const status = readStatus(JSON.stringify({ audio_speaker: { volume: 42 }, screen: { brightness: 68 } }));
    assert.deepEqual(status, { volume: 42, brightness: 68, theme: null, battery: null, network: null });
  });

  it("reads a battery that says nothing about charging as one that is not", () => {
    const status = readStatus(JSON.stringify({ battery: { level: 12 }, audio_speaker: { volume: 5 } }));
    assert.deepEqual(status?.battery, { level: 12, charging: false });
  });

  it("keeps a gadget that is on no network, which is what an empty ssid means", () => {
    // Not an absence: the firmware reports the interface and leaves the ssid empty when
    // it is not joined, and a bridge that dropped it would lose the fact that the
    // gadget has no network rather than an unknown one.
    const status = readStatus(JSON.stringify({ network: { type: "wifi" }, audio_speaker: { volume: 42 } }));
    assert.deepEqual(status?.network, { type: "wifi", ssid: "", signal: "unknown" });
  });

  it("treats anything it cannot read as no report at all", () => {
    // Half a status is worse than none: what a partly-parsed report would put on the
    // turn is half the gadget's truth beside half a guess.
    assert.equal(readStatus("not json"), null);
    assert.equal(readStatus("[]"), null, "a JSON array is not a status");
    assert.equal(readStatus("null"), null);
    assert.equal(readStatus("{}"), null, "a report with nothing in it is nothing to say");
    assert.equal(readStatus(JSON.stringify({ screen: { brightness: "high" } })), null, "a value of the wrong type is no value");
  });
});

describe("what a turn is told about the gadget", () => {
  it("states the reported values and nothing else", () => {
    const line = describeStatus(readStatus(JSON.stringify(FULL))!);
    assert.ok(line !== null);
    assert.match(line, /volume 42 of 100/);
    assert.match(line, /brightness 68 of 100/);
    assert.match(line, /theme dark/);
    assert.match(line, /battery 87%, charging/);
    assert.match(line, /network wifi "nha", signal weak/);
  });

  it("does not judge the numbers it repeats", () => {
    // 12% is nearly flat and 12 is a number. The bridge knows the second fact and not
    // the first, and a sentence saying "nearly flat" would be the bridge's guess
    // wearing the gadget's authority — which is the whole of what the requirement's
    // second scenario is about.
    const line = describeStatus({ ...EMPTY, battery: { level: 12, charging: false } });
    assert.equal(line, "The device this reply is spoken through reports its own state as: battery 12%, not charging.");
  });

  it("omits what was not reported rather than showing it as unknown", () => {
    const line = describeStatus({ ...EMPTY, volume: 42, brightness: 68 });
    assert.equal(
      line,
      "The device this reply is spoken through reports its own state as: speaker volume 42 of 100; screen brightness 68 of 100."
    );
  });

  it("says nothing at all when there is nothing to say", () => {
    assert.equal(describeStatus(EMPTY), null);
  });
});

describe("reading the condition at the handshake", () => {
  it("asks for the status once the catalog is known, and keeps the answer", async () => {
    const g = board();
    await g.gadget.start();

    assert.deepEqual(
      g.methods(),
      ["initialize", "tools/list", "tools/call"],
      "the status is asked for after the catalog, since a name the report did not carry is not called (D3)"
    );
    assert.deepEqual(g.sent[2].payload.params, { name: "self.get_device_status", arguments: {} });
    assert.match(g.gadget.condition() ?? "", /speaker volume 42 of 100/);
  });

  it("asks for no status when the gadget reports no tools", async () => {
    // Nothing callable is nothing to read, and the handshake has already said so once.
    // A second attempt would be a request the bridge knows the answer to (D4).
    const g = gadget(() => undefined, []);
    await g.gadget.start();

    assert.deepEqual(g.methods(), ["initialize", "tools/list"]);
    assert.equal(g.gadget.condition(), null);
  });

  it("holds no condition when the call is refused", async () => {
    const g = gadget((request) => failed(request, "Unknown tool: self.get_device_status"));
    await g.gadget.start();
    assert.equal(g.gadget.condition(), null, "a condition invented after a refusal is the one thing that may not happen");
  });

  it("holds no condition when the status arrives unreadable", async () => {
    const g = gadget((request) => answered(request, "the device is fine"));
    await g.gadget.start();
    assert.equal(g.gadget.condition(), null);
  });

  it("ends with no condition when the gadget never answers", async () => {
    // The deadline is what keeps a gadget with a broken tool channel from parking a
    // session on it: `start()` resolves, the session carries no condition, and the
    // turn is asked for exactly as it would have been (D4, requirement 5).
    const g = gadget(() => undefined);
    await g.gadget.start();

    assert.equal(g.gadget.condition(), null);
    assert.equal(g.socket.sent.length, 3, "the asks were made and given up on");
  });

  it("hands a reply to the channel it belongs to", async () => {
    const g = board();
    await g.gadget.start();
    assert.equal(g.gadget.receive({ jsonrpc: "2.0", id: 99, result: {} }), false, "an id this session did not choose");
  });
});

describe("changing one of the gadget's own settings", () => {
  // Every one of these starts the catalog first, because a tool the report did not
  // carry is one the bridge refuses to call at all (D3) — so the handshake read of the
  // status is the first of the calls each test counts.

  it("states a value the person named, without reading the gadget first", async () => {
    const g = board({ volume: 42 });
    await g.gadget.start();
    const outcome = await g.gadget.apply({ setting: "volume", change: { kind: "set", value: 30 } });

    assert.equal(outcome.ok, true, outcome.detail);
    assert.equal(g.held.volume, 30);
    assert.deepEqual(
      g.calls.map((call) => call.name),
      [STATUS_TOOL.name, VOLUME_TOOL.name, STATUS_TOOL.name],
      "the handshake's read, the call, and the read that checks what the gadget did with it"
    );
    assert.deepEqual(g.calls[1].arguments, { volume: 30 });
  });

  it("raises and lowers from what the gadget reports now, not from what it last said", async () => {
    // The gadget's own buttons move the volume without telling anyone, so anything
    // this bridge holds from the handshake is a value that may be wrong by the time
    // the person speaks (D6).
    const raise = board({ volume: 42 });
    await raise.gadget.start();
    const raised = await raise.gadget.apply({ setting: "volume", change: { kind: "raise" } });
    assert.equal(raised.ok, true, raised.detail);
    assert.equal(raise.held.volume, 52, "42 as the handshake reported it, plus the configured step");

    const lower = board({ volume: 42 });
    await lower.gadget.start();
    const lowered = await lower.gadget.apply({ setting: "volume", change: { kind: "lower" } });
    assert.equal(lowered.ok, true, lowered.detail);
    assert.equal(lower.held.volume, 32);
  });

  it("resolves a relative change against a status read at that moment", async () => {
    // The same command against a gadget that moved between the handshake and the
    // command: 80, not 52. Computing it from the condition held since the handshake
    // would set the volume from a number nobody has held for some time, and the
    // person asked for one step louder than where they *are* (requirement 3, D6).
    const g = board({ volume: 42 });
    await g.gadget.start();
    g.held.volume = 70;

    const outcome = await g.gadget.apply({ setting: "volume", change: { kind: "raise" } });
    assert.equal(outcome.ok, true, outcome.detail);
    assert.equal(g.held.volume, 80);
    assert.deepEqual(g.calls.filter((call) => call.name === VOLUME_TOOL.name)[0].arguments, { volume: 80 });
  });

  it("stops at the end of the range the tool declares rather than crossing it", async () => {
    const high = board({ volume: 95 });
    await high.gadget.start();
    const up = await high.gadget.apply({ setting: "volume", change: { kind: "raise" } });
    assert.equal(up.ok, true, up.detail);
    assert.equal(high.held.volume, 100, "the end of the range, not 105 and not nothing");

    const low = board({ brightness: 4 });
    await low.gadget.start();
    const down = await low.gadget.apply({ setting: "brightness", change: { kind: "lower" } });
    assert.equal(down.ok, true, down.detail);
    assert.equal(low.held.brightness, 0, "zero is inside the range, so it is not floored away");
  });

  it("clamps a stated value too, rather than earning a refusal from the gadget", async () => {
    // The firmware validates a value against the same declared range and answers an
    // error past it (mcp.ts). The person asked for full volume; a call the gadget
    // refuses is not a better answer than the loudest it has.
    const g = board({ volume: 42 });
    await g.gadget.start();
    const outcome = await g.gadget.apply({ setting: "volume", change: { kind: "set", value: 150 } });

    assert.equal(outcome.ok, true, outcome.detail);
    assert.equal(g.held.volume, 100);
  });

  it("asks again from what the gadget reports when it moved while the call was in flight", async () => {
    // A person holding the volume button during the call: the gadget ends up at 45,
    // not the 52 it was asked for, and says so. Leaving it there would give a person
    // who asked for louder a volume they had already pushed past (requirement 3).
    const g = board({
      volume: 42,
      set: (call, held) => {
        held.volume = call.arguments.volume === 52 ? 45 : (call.arguments.volume as number);
      },
    });
    await g.gadget.start();
    const outcome = await g.gadget.apply({ setting: "volume", change: { kind: "raise" } });

    assert.equal(outcome.ok, true, outcome.detail);
    assert.deepEqual(
      g.calls.filter((call) => call.name === VOLUME_TOOL.name).map((call) => call.arguments.volume),
      [52, 55],
      "once from what it held, once more from what it reported after the first"
    );
    assert.equal(g.held.volume, 55);
  });

  it("gives up after that one retry rather than chasing a person still holding the button", async () => {
    const g = board({
      volume: 42,
      set: (_call, held) => {
        held.volume = 20;
      },
    });
    await g.gadget.start();
    const outcome = await g.gadget.apply({ setting: "volume", change: { kind: "raise" } });

    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /reports 20/);
    assert.equal(
      g.calls.filter((call) => call.name === VOLUME_TOOL.name).length,
      2,
      "a third attempt is a third change asked of a person who is still moving the setting"
    );
  });

  it("hands the call the configured step, not a number of its own", async () => {
    // The step is a feel rather than a measurement (D6), so it is read from
    // configuration where a deployment can settle it by ear.
    const g = board({ volume: 42, commandStep: 25 });
    await g.gadget.start();
    const raised = await g.gadget.apply({ setting: "volume", change: { kind: "raise" } });

    assert.equal(raised.ok, true, raised.detail);
    assert.equal(g.held.volume, 67, "42 as the handshake reported it, plus the configured step");
  });

  it("leaves a setting alone when the gadget reported no tool for it", async () => {
    // A board with no backlight registers no brightness tool. Calling anyway is the
    // one mistake that comes back as `Unknown tool:` from a gadget the bridge believed
    // it understood, so the command is abandoned and reported (requirement 2, D3).
    const g = board({ backlight: false });
    await g.gadget.start();
    const outcome = await g.gadget.apply({ setting: "brightness", change: { kind: "raise" } });

    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /self\.screen\.set_brightness/);
    assert.deepEqual(g.calls.map((call) => call.name), [STATUS_TOOL.name], "nothing was attempted on the hope that it exists");
  });

  it("changes the screen's theme", async () => {
    const g = board({ theme: "light" });
    await g.gadget.start();
    const dark = await g.gadget.apply({ setting: "theme", theme: "dark" });

    assert.equal(dark.ok, true, dark.detail);
    assert.equal(g.held.theme, "dark");
    assert.deepEqual(g.calls.filter((call) => call.name === THEME_TOOL.name)[0].arguments, { theme: "dark" });
  });

  it("reads a screen's own refusal under a call it answered", async () => {
    // `set_theme` answers `false` — from a call that succeeded — for a theme the
    // display does not have. A bridge reading only the error channel would report a
    // screen that did not change as one that did (mcp.ts, requirement 2).
    const g = gadget(
      (request) =>
        (request.params as SettingCall).name === THEME_TOOL.name
          ? answered(request, "false")
          : answered(request, JSON.stringify({ audio_speaker: { volume: 42 } })),
      [STATUS_TOOL, THEME_TOOL]
    );
    await g.gadget.start();
    const refused = await g.gadget.apply({ setting: "theme", theme: "dark" });

    assert.equal(refused.ok, false);
    assert.match(refused.detail, /would not take the dark theme/);
  });

  it("abandons a relative change the gadget gave it nothing to compute from", async () => {
    // No current volume means no "louder", and the alternative — carrying on from a
    // number the bridge made up — is setting a value the person never asked for
    // (requirement 3).
    const g = gadget((request) => failed(request, "the gadget is busy"), [STATUS_TOOL, VOLUME_TOOL]);
    await g.gadget.start();
    const outcome = await g.gadget.apply({ setting: "volume", change: { kind: "raise" } });

    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /did not report its current volume/);
    assert.deepEqual(
      g.methods(),
      ["initialize", "tools/list", "tools/call", "tools/call"],
      "nothing callable was set, and only the status was asked for twice"
    );
  });

  it("reports a change it made and could not confirm, rather than making it twice", async () => {
    // The call succeeded and the read that would confirm it did not. What happened is
    // known — the volume was set — and where the gadget is now is not, so the bridge
    // says the first and not the second, and does not call again on the strength of a
    // failed read (requirement 3).
    let reads = 0;
    const g = gadget(
      (request) => {
        const call = request.params as SettingCall;
        if (call.name === VOLUME_TOOL.name) return answered(request, "true");
        reads += 1;
        // The handshake's read and the one the relative change is computed from both
        // answer; the read that would confirm the call does not.
        return reads <= 2
          ? answered(request, JSON.stringify({ audio_speaker: { volume: 42 } }))
          : failed(request, "the gadget is busy");
      },
      [STATUS_TOOL, VOLUME_TOOL]
    );
    await g.gadget.start();
    const outcome = await g.gadget.apply({ setting: "volume", change: { kind: "raise" } });

    assert.equal(outcome.ok, true, "the change was made; reporting a failure that did not happen is its own falsehood");
    assert.match(outcome.detail, /unconfirmed/);
    assert.equal(
      g.sent.filter((frame) => (frame.payload.params as SettingCall | undefined)?.name === VOLUME_TOOL.name).length,
      1
    );
  });
});
