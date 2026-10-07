import type { BridgeConfig } from "../config.js";

/**
 * The text messages the device and the bridge exchange, to the depth this service
 * needs them.
 *
 * Only messages the bridge acts on are modelled, and each only to the depth of the
 * acting. `mcp` is routed and nothing more: its payload is the gadget's tool channel,
 * a conversation with its own ids and its own replies, and it lives in `mcp.ts` —
 * what is typed here is the frame that carries it, not what it carries. `iot` and
 * `alert` are not acted on at all and are given no type, which is what keeps the next
 * reader from looking for handling that is not there (D8).
 */

export interface AudioParams {
  format?: string;
  sample_rate?: number;
  channels?: number;
  frame_duration?: number;
}

/** What the device says when it connects. */
export interface ClientHello {
  type: "hello";
  version?: number;
  /**
   * Load-bearing. Without `transport` in the reply the firmware never sets its
   * server-hello event bit and fails the connect after a ten second wait, with
   * nothing on the server side to indicate why.
   */
  transport?: string;
  audio_params?: AudioParams;
  features?: Record<string, unknown>;
}

export interface ListenMessage {
  type: "listen";
  state: "start" | "stop";
  mode?: string;
}

export interface AbortMessage {
  type: "abort";
  reason?: string;
}

/** A frame of the gadget's tool channel. `payload` is left unread here on purpose:
 *  what it must be is a JSON-RPC message, and how one is read is `mcp.ts`'s business. */
export interface McpMessage {
  type: "mcp";
  payload?: unknown;
}

export type ClientMessage =
  | ClientHello
  | ListenMessage
  | AbortMessage
  | McpMessage
  | { type: string; [k: string]: unknown };

/** Parse a text frame. Returns null rather than throwing: a device that sends
 * something unparsable is a thing to log and survive, not to end a connection
 * over, since the same socket carries the next turn. */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const message = parsed as { type?: unknown };
    if (typeof message.type !== "string") return null;
    return parsed as ClientMessage;
  } catch {
    return null;
  }
}

export function isHello(msg: ClientMessage): msg is ClientHello {
  return msg.type === "hello";
}

export function isListen(msg: ClientMessage): msg is ListenMessage {
  return msg.type === "listen" && (msg.state === "start" || msg.state === "stop");
}

export function isAbort(msg: ClientMessage): msg is AbortMessage {
  return msg.type === "abort";
}

export function isMcp(msg: ClientMessage): msg is McpMessage {
  return msg.type === "mcp";
}

/**
 * The reply to a client hello.
 *
 * The audio parameters are a promise about what the server will send, and the
 * firmware reads them to decide whether it must resample, so they describe the
 * bridge's output rather than the device's input — the two differ on this
 * hardware, 24000 Hz down and 16000 Hz up.
 */
export function serverHello(sessionId: string, config: BridgeConfig): Record<string, unknown> {
  return {
    type: "hello",
    transport: "websocket",
    session_id: sessionId,
    audio_params: {
      format: "opus",
      sample_rate: config.serverRate,
      channels: 1,
      frame_duration: config.frameMs,
    },
  };
}
