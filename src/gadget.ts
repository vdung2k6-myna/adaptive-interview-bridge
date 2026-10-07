import type { GadgetCommand } from "./commands.js";
import type { BridgeConfig } from "./config.js";
import { info, log, warn } from "./log.js";
import { createMcpClient, type McpOptions, type McpSocket } from "./protocol/mcp.js";

/**
 * What the gadget is, and what the bridge may do to it.
 *
 * Two things live here, and one decision keeps them together: the gadget's own
 * account of its condition, and the three settings the bridge will change on it.
 * Both are the same conversation — the tool channel the bridge opened at the
 * handshake — and both are best-effort, because the interview is the product and
 * these are a convenience on top of it (D4).
 *
 * **The condition.** The gadget can be asked for its own state — `self.get_device_status`
 * — and answers with what it knows: how loud its speaker is, how bright its screen is
 * and which theme it is on, whether its battery is nearly flat, what its network is
 * like. None of that reaches the platform otherwise, so a reply can say "you sound
 * tired" to a gadget running out of charge without any way of knowing it (requirement
 * 5). It is read once at the handshake and **held** rather than asked for again on
 * every turn: it is a fact about a device that changes when a person presses a button,
 * not a fact about the turn, and a round trip per turn is a round trip the person waits
 * behind.
 *
 * **The settings.** Three, and no more (D9): the speaker's volume, the screen's
 * brightness, the screen's theme. A board that registers a camera, an LED strip or a
 * chassis registers something this bridge will never call, and the catalog decides
 * only *whether* one of the three exists here — never what the bridge is willing to
 * do. A relative command ("giảm âm lượng", "sáng hơn") is resolved against a **freshly
 * read** status and clamped to the range the tool declares, because the gadget's own
 * buttons can have moved the setting and nothing on the wire reports that (D6).
 *
 * Three things bound what may be made of the condition.
 *
 * **Nothing is filled in.** A board with no battery reports no battery, a screen too
 * short for a theme reports no theme, and a field the gadget did not report is left
 * out of what the platform is told rather than shown as unknown. The platform is
 * given the gadget's own report, not the bridge's guess at it (D6), and a default here
 * would be exactly the "inferred" condition requirement 5 refuses.
 *
 * **A report that cannot be read is no report.** A call that fails, an answer that is
 * not JSON, a report with nothing in it: each leaves the session with no condition at
 * all, and turns are asked for exactly as they were before this existed. There is no
 * partly-read status, because a status with invented halves is worse than none.
 *
 * **It is the device's condition, not the person's.** What is appended to the turn is
 * the gadget's own state, so that a reply *may* account for it. The appended words are
 * written in English whatever the gadget speaks, because they are addressed to the
 * model that reads the persona prompt rather than to the person who hears the reply —
 * the spoken language of a turn is a field of its own (`TurnRequest.language`).
 */

/** The tool the gadget answers its own condition with, by the name it registers. */
const STATUS_TOOL = "self.get_device_status";

/**
 * The two settings measured on the gadget's 0–100 scale, and the tool and argument
 * each is changed through. The names are the firmware's own (`mcp_server.cc`), and
 * a name that does not match what the board registered is a call the catalog refuses
 * before it is attempted (D3).
 */
const NUMERIC_SETTINGS = {
  volume: { tool: "self.audio_speaker.set_volume", arg: "volume" },
  brightness: { tool: "self.screen.set_brightness", arg: "brightness" },
} as const;

/** The screen's theme, which is not a value on any scale: a word, and the gadget's
 *  own answer to whether it has that word. */
const THEME = { tool: "self.screen.set_theme", arg: "theme" } as const;

/** What the gadget reported about itself, field by field. `null` in a field is one the
 *  gadget did not report — an absent battery, a screen with no backlight. */
export interface GadgetStatus {
  /** The speaker's volume, on the 0–100 scale the firmware's own volume tool takes. */
  volume: number | null;
  /** The screen's brightness, on the same 0–100 scale. */
  brightness: number | null;
  /** The screen's theme, as the display names it: `light`, `dark`. */
  theme: string | null;
  battery: { level: number; charging: boolean } | null;
  network: { type: string; ssid: string; signal: string } | null;
}

/**
 * What one command came to, for the log and for whoever reads it.
 *
 * `ok: false` never means the bridge is broken: every way a command can fail leaves
 * the gadget as it was, which is where the person was before they spoke (D7). What
 * it means is that the person said something the bridge understood as a command and
 * did not carry out, which is a line the operator should be able to read.
 */
export interface CommandOutcome {
  ok: boolean;
  detail: string;
}

export interface Gadget {
  /** Speak the tool handshake and read the gadget's condition, once per session.
   *  Best-effort throughout, and awaited by nothing (D4). */
  start(): Promise<void>;
  /** Hand the gadget's tool channel one inbound `payload`. Returns whether it was a
   *  reply the bridge was waiting for. */
  receive(payload: unknown): boolean;
  /** What to append to the turn's system prompt, or `null` when the gadget has
   *  reported nothing — in which case the turn is asked for exactly as it is today. */
  condition(): string | null;
  /** Carry out one command, reading the gadget for whatever the command left
   *  unsaid. Never throws, and never leaves the gadget half-changed: a call that
   *  fails is a line in the log and the setting where it was. */
  apply(command: GadgetCommand): Promise<CommandOutcome>;
}

/**
 * The gadget on the other end of this session's socket.
 *
 * `options` carries the one thing worth reaching in with — how long a request waits
 * for its answer — for the reason the speaker's clock is injected (D13): "a gadget
 * that never answers costs this session nothing" is a claim about a deadline, and
 * checking it wants a deadline that arrives now.
 */
export function createGadget(
  socket: McpSocket,
  config: BridgeConfig,
  sessionId: string,
  options: McpOptions = {}
): Gadget {
  const mcp = createMcpClient(socket, sessionId, options);
  let condition: string | null = null;

  /** The status as the gadget reports it *now*, which is the only value a relative
   *  change may be computed from (D6, requirement 3). Asked for by name, so a gadget
   *  that did not report the tool is refused here rather than called. */
  async function readNow(): Promise<GadgetStatus | null> {
    const outcome = await mcp.call(STATUS_TOOL, {});
    if (!outcome.ok) {
      warn(`the gadget's own condition could not be read: ${outcome.message}`);
      return null;
    }
    const status = readStatus(outcome.text);
    if (status === null) {
      warn(`the gadget's condition was unreadable: ${JSON.stringify(outcome.text).slice(0, 160)}`);
    }
    return status;
  }

  /** The range a tool declares for its argument. A bound the gadget did not declare
   *  is `null` and is not clamped to: inventing one would be inventing a limit the
   *  gadget does not have. */
  function declaredRange(tool: string, arg: string): { min: number | null; max: number | null } {
    const declared = mcp.tool(tool)?.args.find((candidate) => candidate.name === arg);
    return { min: declared?.min ?? null, max: declared?.max ?? null };
  }

  return {
    async start(): Promise<void> {
      await mcp.start();
      // Nothing callable is nothing to read: a gadget whose tool channel did not come
      // up has already been reported once by the handshake, and a second line here
      // would only restate it (D4).
      if (mcp.tools().length === 0) return;

      const status = await readNow();
      if (status === null) return;
      condition = describeStatus(status);
      log(`gadget condition (2.1): ${condition ?? "reported, with nothing in it"}`);
    },

    receive(payload: unknown): boolean {
      return mcp.receive(payload);
    },

    condition(): string | null {
      return condition;
    },

    async apply(command: GadgetCommand): Promise<CommandOutcome> {
      if (command.setting === "theme") {
        const outcome = await mcp.call(THEME.tool, { [THEME.arg]: command.theme });
        if (!outcome.ok) {
          return { ok: false, detail: `the ${command.theme} theme was not set: ${outcome.message}` };
        }
        // The gadget's own refusal, under a call it answered successfully: the theme
        // tool returns `false` for a theme this display does not have (`mcp.ts`), so
        // a bridge that read only the error channel would report a screen that did
        // not change as one that did.
        if (outcome.text !== "true") {
          return { ok: false, detail: `the screen would not take the ${command.theme} theme (it answered ${outcome.text})` };
        }
        return { ok: true, detail: `${command.theme} theme` };
      }

      const setting = NUMERIC_SETTINGS[command.setting];
      if (mcp.tool(setting.tool) === null) {
        // Requirement 2's own scenario: a command for a setting this gadget has no
        // tool for is abandoned and reported, and the gadget is left alone. The
        // catalog is the whole of what may be called (D3).
        return { ok: false, detail: `the gadget reports no ${setting.tool}, so the ${command.setting} was left alone` };
      }
      const range = declaredRange(setting.tool, setting.arg);

      /**
       * The value to ask for, given where the gadget is **now**.
       *
       * A stated value ignores where the gadget is: the person named a number and it
       * is theirs, clamped only so that it lands inside what the tool accepts rather
       * than being refused by the firmware's own validation (requirement 3). A
       * relative one has nowhere else to come from — the gadget's buttons move the
       * setting without telling anyone — which is the read the caller above exists to
       * make.
       */
      const wanted = async (): Promise<number | null> => {
        if (command.change.kind === "set") return clamp(command.change.value, range);
        const status = await readNow();
        if (status === null) return null;
        const now = command.setting === "volume" ? status.volume : status.brightness;
        if (now === null) return null;
        return clamp(now + (command.change.kind === "raise" ? config.commandStep : -config.commandStep), range);
      };

      let target = await wanted();
      if (target === null) {
        // Without a current value there is no "louder", and guessing one would be
        // setting a value the person never asked for (requirement 3).
        return { ok: false, detail: `the gadget did not report its current ${command.setting}, so there was nothing to change from` };
      }

      // At most twice. The second attempt exists because the value asked for may not
      // be where the gadget ends up: a person holding the button moves the setting
      // while the call is in flight, and the gadget reports the result rather than the
      // request. A third attempt would only chase a person who is still holding it.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const called = await mcp.call(setting.tool, { [setting.arg]: target });
        if (!called.ok) {
          return { ok: false, detail: `${setting.arg} was not set: ${called.message}` };
        }

        const after = await readNow();
        if (after === null) {
          // The change was made and cannot be confirmed. Reported as made, because it
          // was: a second call on the strength of a failed read is a second change.
          return { ok: true, detail: `${setting.arg} set to ${target}, unconfirmed — the gadget's status could not be read back` };
        }
        const reported = command.setting === "volume" ? after.volume : after.brightness;
        if (reported === target || reported === null) {
          return { ok: true, detail: `${setting.arg} ${target} of ${describe(range)}` };
        }

        if (attempt === 2) {
          return {
            ok: false,
            detail: `${setting.arg} was set to ${target} and the gadget reports ${reported} — moved while the command was in flight`,
          };
        }
        info(`the gadget moved to ${reported} while being set to ${target}; asking again from what it reports now`);
        target = await wanted();
        if (target === null) {
          return { ok: false, detail: `the gadget stopped reporting its ${command.setting} mid-command` };
        }
      }

      return { ok: false, detail: `${setting.arg} could not be settled` };
    },
  };
}

/** The value, held inside what the tool says it accepts. */
function clamp(value: number, range: { min: number | null; max: number | null }): number {
  if (range.min !== null && value < range.min) return range.min;
  if (range.max !== null && value > range.max) return range.max;
  return value;
}

/** A range, for the log line: what the gadget declared, or that it declared nothing. */
function describe(range: { min: number | null; max: number | null }): string {
  if (range.min === null && range.max === null) return "an undeclared range";
  return `${range.min ?? "?"}–${range.max ?? "?"}`;
}

/**
 * The gadget's condition, read out of the text its status tool returns.
 *
 * The firmware renders a tool's return value into one `content` item of type text,
 * and this tool's value is an object — so what arrives is that object's JSON, as a
 * string, and reading it is json.parse and nothing more. What is *not* here is as
 * load-bearing as what is: every shape is optional, because the report's shape is the
 * board's. `battery` is absent on a board with no battery gauge, `screen.theme` on a
 * screen 64 pixels tall or shorter, `audio_speaker.volume` on a board with no codec.
 */
export function readStatus(text: string): GadgetStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const root = parsed as Record<string, unknown>;

  const status: GadgetStatus = {
    volume: numberOf(field(root, "audio_speaker"), "volume"),
    brightness: numberOf(field(root, "screen"), "brightness"),
    theme: stringOf(field(root, "screen"), "theme"),
    battery: readBattery(field(root, "battery")),
    network: readNetwork(field(root, "network")),
  };

  // A report that carries nothing is not a condition. Returning it as one would put
  // an empty claim on every turn from here on.
  const empty =
    status.volume === null &&
    status.brightness === null &&
    status.theme === null &&
    status.battery === null &&
    status.network === null;
  return empty ? null : status;
}

/**
 * The line a turn carries, or `null` when there is nothing to say.
 *
 * Plain facts in the order the gadget reports them, with no reading of them: the
 * bridge does not know that 12% is nearly flat, and a sentence saying so would be the
 * bridge's judgement wearing the gadget's authority. What the model makes of a number
 * is the model's business — which is the whole point of giving it the number.
 */
export function describeStatus(status: GadgetStatus): string | null {
  const parts: string[] = [];
  if (status.volume !== null) parts.push(`speaker volume ${status.volume} of 100`);
  if (status.brightness !== null || status.theme !== null) {
    const screen = [
      status.brightness !== null ? `brightness ${status.brightness} of 100` : "",
      status.theme !== null ? `theme ${status.theme}` : "",
    ].filter((part) => part !== "");
    parts.push(`screen ${screen.join(", ")}`);
  }
  if (status.battery) {
    parts.push(`battery ${status.battery.level}%, ${status.battery.charging ? "charging" : "not charging"}`);
  }
  if (status.network) {
    const ssid = status.network.ssid === "" ? "" : ` "${status.network.ssid}"`;
    parts.push(`network ${status.network.type}${ssid}, signal ${status.network.signal}`);
  }
  if (parts.length === 0) return null;
  return `The device this reply is spoken through reports its own state as: ${parts.join("; ")}.`;
}

function field(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  return (source as Record<string, unknown>)[key];
}

function numberOf(source: unknown, key: string): number | null {
  const value = field(source, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOf(source: unknown, key: string): string | null {
  const value = field(source, key);
  return typeof value === "string" && value !== "" ? value : null;
}

function readBattery(source: unknown): GadgetStatus["battery"] {
  const level = numberOf(source, "level");
  if (level === null) return null;
  // `charging` is reported beside the level rather than instead of it, and a battery
  // that reports a level and says nothing about charging is one that is not.
  return { level, charging: field(source, "charging") === true };
}

function readNetwork(source: unknown): GadgetStatus["network"] {
  const type = stringOf(source, "type");
  if (type === null) return null;
  return {
    type,
    // An unconnected gadget reports an empty ssid rather than none, which is a fact
    // about the network and not an absence to be read as unknown.
    ssid: stringOf(source, "ssid") ?? "",
    signal: stringOf(source, "signal") ?? "unknown",
  };
}
