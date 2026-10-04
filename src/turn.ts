import type { BridgeConfig } from "./config.js";
import { platformAuthHeaders } from "./platform.js";
import type { AnswerMode } from "./personas.js";

/**
 * One turn, sent to the platform's voice-agent endpoint, and the stream it
 * answers with.
 *
 * A device turn is the same request the browser makes (D2): multipart form data
 * carrying the persona's three fields, the device's language, the conversation so
 * far, and the person's input as either an audio file or text. The endpoint looks
 * no persona up — it is stateless and self-describing — so everything it needs to
 * answer as this gadget's persona is in this request, and everything the bridge
 * knows about that persona comes from the catalog it read (3.1).
 *
 * The reply is a stream of server-sent events, and it is consumed as one. The
 * endpoint emits each sentence's audio as that sentence is finished, which is the
 * whole of D4 — speech begins before the reply is complete — so a client that
 * waited for the response body would have thrown away the property the gadget
 * depends on. Events reach the sink in arrival order and are awaited there, so a
 * caller that needs to slow down while it speaks has somewhere to do it.
 *
 * Both directions are the browser's, field for field, including the odd ones: the
 * language is a full word rather than a code (the platform maps it to the code the
 * transcriber wants, D12), `enabledTopics` and `history` are JSON *strings* because
 * every multipart field is a string, and `speak` is `"1"` for a spoken turn.
 */

/** The two languages the endpoint accepts; anything else it reads as English. */
export type TurnLanguage = "english" | "vietnamese";

/** The endpoint's synthesis engines, whose voices are language-specific. */
export type TurnEngine = "kokoro" | "piper" | "supertonic";

/**
 * The engine to ask for, since the bridge has no voice preference of its own —
 * a persona carries no voice field (D3) and the browser never picks a default
 * either. This is the platform's own answer for a caller that expressed none:
 * its resolver falls back to Piper for English "since kokoro only has
 * Vietnamese voices", and to Kokoro for Vietnamese.
 *
 * The fallback cannot be reached by leaving the field out. `validateEngine` folds
 * anything unrecognized — `undefined` included — to `"kokoro"` *before* the
 * language is consulted, so an omitted field is not "no preference"; it is a
 * request for Kokoro, and on an English turn that is a request for a Vietnamese
 * voice to read English. The browser always sends a value, which is why the
 * unreachable branch has never been noticed. Sending this value is therefore how
 * the bridge asks for the answer the endpoint already means to give, and 4.5
 * records what that comes out as.
 */
export function engineForLanguage(language: TurnLanguage): TurnEngine {
  return language === "english" ? "piper" : "kokoro";
}

/**
 * The endpoint's own error is not worth inventing here: the platform takes
 * `"generate" | "material"` and folds anything else to `"generate"`, so this is
 * the same vocabulary `parseCatalog` validates, carried through unchanged.
 */
export type { AnswerMode };

/** One earlier turn, as the platform's `history` field carries it. */
export interface TurnMessage {
  role: "user" | "agent";
  content: string;
}

export interface TurnAudio {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface TurnRequest {
  /** The persona's `defaultPrompt`, renamed by `turnFieldsFor` (3.2). */
  systemPrompt: string;
  /** The persona's `knowledgeTopics` — the labels that scope the turn's search. */
  enabledTopics: readonly string[];
  answerMode: AnswerMode;
  /**
   * The device's language, **required on every turn**. `validateLanguage` reads an
   * absent or unknown value as `english`, so a turn that drops this field does not
   * fall back to detection — it pins the transcriber to English, which for a
   * Vietnamese gadget is worse than the bug D12 fixed, and it fails silently.
   */
  language: TurnLanguage;
  history: readonly TurnMessage[];
  /** The person's input: an audio file, text, or neither on an opening turn. */
  audio?: TurnAudio;
  text?: string;
}

export interface TurnSentence {
  index: number;
  text: string;
  /** Decoded audio for this sentence, or null where synthesis failed. */
  audio: Buffer | null;
}

export interface TurnNotice {
  code?: string;
  message: string;
}

/**
 * What the caller does with the stream as it arrives. Every method may return a
 * promise, and it is awaited before the next event is read: speech to a device is
 * paced by a socket, and a sink that cannot slow the reader down would have to
 * buffer the whole reply to avoid it.
 */
export interface TurnSink {
  /** What the platform transcribed the person as saying (4.2, 6.2). */
  onUser?(text: string): void | Promise<void>;
  /** A piece of the reply's text, before its sentence is spoken. */
  onText?(text: string): void | Promise<void>;
  /** One sentence, with its audio if synthesis produced any (5.3). */
  onSentence?(sentence: TurnSentence): void | Promise<void>;
  /** The platform's remark — a turn that produced nothing to act on, say. */
  onNotice?(notice: TurnNotice): void | Promise<void>;
  /** The platform's refusal or failure (4.4). */
  onError?(message: string): void | Promise<void>;
}

export interface TurnOutcome {
  /** The reply as the platform concluded it, or what had streamed when it ended
   * without saying. Empty when the turn produced no reply at all. */
  replyText: string;
  /**
   * True when the platform ended the turn in-band. `done`, `notice` and `error`
   * all set it; a stream that merely stops does not, and the two look identical
   * from here — which one it was is the difference between a turn that ended and
   * one that was cut off.
   */
  settled: boolean;
}

/** The form the endpoint accepts, exactly as the browser builds it. */
export function turnForm(request: TurnRequest): FormData {
  const form = new FormData();
  form.append("language", request.language);
  // Derived rather than configured: see `engineForLanguage`, which is where the
  // choice and its reason live. The platform resolves the voice from this and the
  // language; the bridge does not name a voice.
  form.append("engine", engineForLanguage(request.language));
  form.append("systemPrompt", request.systemPrompt);
  form.append(
    "history",
    JSON.stringify(request.history.map((message) => ({ role: message.role, content: message.content })))
  );
  // Omitted rather than sent empty, as the browser omits it: a request with no
  // topics is a turn that searches nothing, and an empty JSON array says the same
  // thing in a way the fold then has to be trusted to read.
  if (request.enabledTopics.length > 0) {
    form.append("enabledTopics", JSON.stringify([...request.enabledTopics]));
  }
  form.append("answerMode", request.answerMode);
  // Always spoken. Every turn this bridge sends is one a device is waiting to hear.
  form.append("speak", "1");
  if (request.audio) {
    form.append(
      "audio",
      new Blob([request.audio.data], { type: request.audio.contentType }),
      request.audio.filename
    );
  } else if (request.text !== undefined) {
    form.append("text", request.text);
  }
  return form;
}

/**
 * Send the turn and drive the sink from its stream.
 *
 * Returns when the stream ends, whether or not the platform said it had finished —
 * `settled` is how the caller tells those apart. Throws only when the request
 * never became a stream: a refusal or a failure *inside* a turn arrives as an
 * `error` event over an HTTP 200, and is delivered to the sink rather than thrown,
 * because by then the turn exists and the caller has a device to answer.
 */
export async function runTurn(
  config: BridgeConfig,
  request: TurnRequest,
  sink: TurnSink,
  signal?: AbortSignal
): Promise<TurnOutcome> {
  const response = await fetch(`${config.platformUrl}${TURN_PATH}`, {
    method: "POST",
    // No `Content-Type`: `fetch` writes the multipart boundary itself, and a
    // hand-set header without it is a body the platform cannot parse.
    headers: platformAuthHeaders(config),
    body: turnForm(request),
    signal: signal ?? null,
  });

  if (!response.ok || !response.body) {
    // The stream never started, so there is no turn to report an event against.
    // The body is read and discarded rather than quoted: it is the platform's, and
    // the one thing this message may not carry is the credential that asked —
    // which is why the status and the route are the whole of what is reported.
    await response.text().catch(() => "");
    throw new Error(`POST ${TURN_PATH} answered ${response.status} ${response.statusText}`);
  }

  return consumeStream(response.body, sink);
}

const TURN_PATH = "/api/voice-agent/stream";

/** Read the reply's events, in arrival order, and report how it ended. */
async function consumeStream(
  body: ReadableStream<Uint8Array>,
  sink: TurnSink
): Promise<TurnOutcome> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let replyText = "";
  let settled = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line. The trailing fragment stays in the
      // buffer: a chunk boundary can fall mid-event, and parsing one as if it were
      // whole would lose whichever field was cut.
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        const event = parseSseBlock(block);
        if (!event) continue;
        if (event.name === "done" || event.name === "error" || event.name === "notice") settled = true;
        const reported = await dispatch(event, sink);
        if (event.name === "done") replyText = reported ?? replyText;
        else if (event.name === "text" && reported !== null) replyText += reported;
      }
    }
  } finally {
    // Releases the socket when the caller aborted, and is a no-op otherwise.
    await reader.cancel().catch(() => undefined);
  }

  return { replyText, settled };
}

interface SseEvent {
  name: string;
  payload: Record<string, unknown>;
}

/**
 * One event block, or null when there is nothing to act on. A heartbeat arrives as
 * a comment line and is dropped here rather than surfacing as an event with no
 * name — the endpoint sends one every three seconds precisely so a proxy does not
 * drop an idle stream, and it means nothing to this service.
 */
function parseSseBlock(block: string): SseEvent | null {
  const lines = block.split("\n");
  const nameLine = lines.find((line) => line.startsWith("event:"));
  const dataLines = lines.filter((line) => line.startsWith("data:"));
  if (!nameLine || dataLines.length === 0) return null;

  const name = nameLine.slice("event:".length).trim();
  if (name === "") return null;
  // The spec joins multiple `data:` lines with newlines; the endpoint sends one.
  const raw = dataLines.map((line) => line.slice("data:".length).trim()).join("\n");

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return { name, payload: parsed as Record<string, unknown> };
  } catch {
    // An event whose payload this service cannot read is logged and skipped, not
    // fatal: the turn is still running and the next event may well be the `done`.
    return null;
  }
}

/** Hand one event to the sink. Returns the reply text when the event carried it. */
async function dispatch(event: SseEvent, sink: TurnSink): Promise<string | null> {
  const { name, payload } = event;

  if (name === "user") {
    await sink.onUser?.(asString(payload.text));
    return null;
  }
  if (name === "text") {
    const text = asString(payload.text);
    await sink.onText?.(text);
    return text;
  }
  if (name === "sentence") {
    await sink.onSentence?.({
      index: typeof payload.index === "number" ? payload.index : -1,
      text: asString(payload.text),
      audio: decodeAudio(payload.audioData),
    });
    return null;
  }
  if (name === "notice") {
    await sink.onNotice?.({
      code: typeof payload.code === "string" ? payload.code : undefined,
      message: asString(payload.message),
    });
    return null;
  }
  if (name === "error") {
    await sink.onError?.(asString(payload.message));
    return null;
  }
  if (name === "done") {
    return asString(payload.fullText);
  }
  // An event this service does not model is not an error. A newer endpoint may add
  // one, and a bridge that treated it as a failure would stop answering turns the
  // platform had already served.
  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The sentence's audio, base64, or null — which is the endpoint's own way of
 * saying synthesis produced nothing for this sentence, not a failure of ours. */
function decodeAudio(value: unknown): Buffer | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    return Buffer.from(value, "base64");
  } catch {
    return null;
  }
}
