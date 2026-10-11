import type { BridgeConfig } from "./config.js";
import { platformAuthHeaders } from "./platform.js";
import type { AnswerMode } from "./personas.js";
import { warn } from "./log.js";

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
 * The engine to ask for: this deployment's, stated once, for every language.
 *
 * It is sent rather than left out. `validateEngine` folds anything it does not
 * recognize — `undefined` included — to `"kokoro"` *before* the language is
 * consulted, so an omitted field is not "no preference"; it is a request for
 * Kokoro. Naming the engine is the only way to ask for another one, and the
 * platform's own per-language fallback stays unreachable until that fold is
 * removed (the design's non-goal).
 *
 * This value used to mirror that fallback — Piper for English, Kokoro for
 * Vietnamese — because a mirror is right while the fallback is what the
 * deployment wants. It no longer is: the API's own `DEFAULT_TTS_ENGINE` is
 * Supertonic, with a cloned Vietnamese style installed beside its built-ins,
 * and the gadget was the last caller still asking for the engine the deployment
 * had left. So the mirror is gone and the language no longer selects anything:
 * one engine is what this deployment speaks through. The *voice* still varies
 * with the language, and is still the platform's to resolve from this engine and
 * the turn's language — the bridge names no voice, only the engine.
 */
export const TURN_ENGINE: TurnEngine = "supertonic";

/**
 * The endpoint's own error is not worth inventing here: the platform takes
 * `"generate" | "material"` and folds anything else to `"generate"`, so this is
 * the same vocabulary `parseCatalog` validates, carried through unchanged.
 */
export type { AnswerMode };

/**
 * A tool a turn carries, which is what the model is given and nothing more.
 *
 * A gadget's catalogue has more in it than this (`McpTool`): `args` is this bridge's reading of
 * the schema, which it clamps a relative command against and the platform has no use for. So
 * this is the shape a turn carries rather than the shape a gadget reports — and it is the shape
 * the bridge's *own* tools are written in, which are not a gadget's and are not asked of one.
 */
export interface TurnTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

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
  /**
   * What this turn may be asked to do, exactly as it was reported: the gadget's own catalogue,
   * and beside it whatever tools the bridge answers for itself. The platform's model decides
   * from this and from nothing else, so the gadget's half is the gadget's own words rather than
   * a list this project keeps (D3) — and the bridge's half is named so that a reader can tell
   * which of the two answers a name.
   *
   * Absent for a turn with neither, and then the field is left off the request rather than sent
   * empty: a turn with no tools is one the model answers without them, which is what every turn
   * was before this existed.
   */
  tools?: readonly TurnTool[];
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

/** A gadget tool the platform's model asked for, as the platform named it — the turn it
 *  belongs to, which call of that turn it is, and what to call it with. */
export interface ToolCallRequest {
  turnId: string;
  index: number;
  name: string;
  arguments: Record<string, unknown>;
}

/** What happened when the bridge made that call. A failure is an outcome and not an
 *  exception: the turn goes on to say what could not be done rather than ending. */
export type ToolCallOutcome = { ok: true; text: string } | { ok: false; message: string };

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
  /**
   * The platform's model has asked for a gadget tool to be called (4.5).
   *
   * The bridge makes the call, because the gadget's tool channel is inside the gadget's own
   * socket and nothing else can reach it, and answers with what happened — which the bridge
   * then reports back so the turn can carry on and say what was done. A sink that leaves this
   * out is a session with no gadget to call, and the turn is told so rather than left waiting.
   */
  onToolCall?(call: ToolCallRequest): ToolCallOutcome | Promise<ToolCallOutcome>;
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
  // Stated once rather than derived: see `TURN_ENGINE`, which is where the
  // choice and its reason live. The platform resolves the voice from this and the
  // language; the bridge does not name a voice.
  form.append("engine", TURN_ENGINE);
  form.append("systemPrompt", request.systemPrompt);
  form.append(
    "history",
    JSON.stringify(request.history.map((message) => ({ role: message.role, content: message.content })))
  );
  // The gadget's own record, projected rather than sent whole: `args` is this bridge's
  // reading of `inputSchema`, and the platform has no use for a second copy of what the
  // schema already says. Omitted rather than sent empty, for the reason the topics are.
  if (request.tools !== undefined && request.tools.length > 0) {
    form.append(
      "tools",
      JSON.stringify(
        request.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
      )
    );
  }
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
 *
 * An abort is the third way a turn ends, and the only one the caller does itself
 * (D15). It returns the outcome as it stood rather than throwing, because a turn
 * the bridge cancelled is a turn that ended and not one that failed: raised as an
 * exception it would reach the dispatcher as an error, and the conversation would
 * lose the person's own question along with the reply that was cut off — spending
 * the one half that certainly happened.
 */
export async function runTurn(
  config: BridgeConfig,
  request: TurnRequest,
  sink: TurnSink,
  signal?: AbortSignal
): Promise<TurnOutcome> {
  let response: Response;
  try {
    response = await fetch(`${config.platformUrl}${TURN_PATH}`, {
      method: "POST",
      // No `Content-Type`: `fetch` writes the multipart boundary itself, and a
      // hand-set header without it is a body the platform cannot parse.
      headers: platformAuthHeaders(config),
      body: turnForm(request),
      signal: signal ?? null,
    });
  } catch (error) {
    // Aborted before the stream began: a turn with nothing in it, which is what an
    // empty unsettled outcome says — and not a failure, which is what the abort of a
    // barge-in would otherwise be reported as every single time.
    if (signal?.aborted) return { replyText: "", settled: false };
    throw error;
  }

  if (!response.ok || !response.body) {
    // The stream never started, so there is no turn to report an event against.
    // The body is read and discarded rather than quoted: it is the platform's, and
    // the one thing this message may not carry is the credential that asked —
    // which is why the status and the route are the whole of what is reported.
    await response.text().catch(() => "");
    throw new Error(`POST ${TURN_PATH} answered ${response.status} ${response.statusText}`);
  }

  return consumeStream(config, response.body, sink, signal);
}

const TURN_PATH = "/api/voice-agent/stream";
/** Where a tool call's result goes back, to the turn that is holding its stream open for it. */
const TOOL_RESULT_PATH = "/api/voice-agent/tool-result";
/** How long the bridge waits on the platform accepting a result. The turn it belongs to has a
 *  bound of its own and will give up without this; a bridge that hung here would hold the
 *  session's reader on a request nobody needs the answer to. */
const TOOL_RESULT_TIMEOUT_MS = 5_000;

/** Read the reply's events, in arrival order, and report how it ended. */
async function consumeStream(
  config: BridgeConfig,
  body: ReadableStream<Uint8Array>,
  sink: TurnSink,
  signal?: AbortSignal
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
        // Checked per block rather than only per read, because a cancel can arrive from
        // *inside* the sink — 4.1 aborts the turn from the `user` event it is handed —
        // and the rest of what came in that same read is already parsed and in hand. A
        // sentence in it would otherwise be spoken into a turn that has been cancelled,
        // which is the one thing a cancelled turn may not do (D15, requirement 4).
        if (signal?.aborted) break;
        const event = parseSseBlock(block);
        if (!event) continue;
        if (event.name === "done" || event.name === "error" || event.name === "notice") settled = true;
        const reported = await dispatch(config, event, sink);
        if (event.name === "done") replyText = reported ?? replyText;
        else if (event.name === "text" && reported !== null) {
          // Joined with a space, because a `text` event carries one *segment* of
          // the reply — the splitter's chunk — and those are trimmed, so
          // concatenating them would fuse the last word of one to the first of
          // the next. The accumulation only ever stands on its own when the
          // platform sends no `done`; normally `done.fullText` replaces it.
          replyText += (replyText ? " " : "") + reported;
        }
      }
    }
  } catch (error) {
    // The caller aborted: the reader lets go of a stream the platform is still
    // writing to, and what was read stands. `settled` stays as it was — false
    // unless the reply had already said it was finished (D15).
    if (!signal?.aborted) throw error;
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
async function dispatch(
  config: BridgeConfig,
  event: SseEvent,
  sink: TurnSink
): Promise<string | null> {
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
  if (name === "tool_call") {
    const call = readToolCall(payload);
    if (call === null) {
      warn("the platform asked for a tool call this bridge could not read — it names no tool");
      return null;
    }
    // The model asked for this mid-turn and the platform is holding its stream open for the
    // answer, so both halves matter: the call is made here, where the gadget is, and what came
    // of it goes back so the turn can be resumed and say what was done (4.5).
    const outcome: ToolCallOutcome = (await sink.onToolCall?.(call)) ?? {
      ok: false,
      message: "this session has no gadget whose tools could be called",
    };
    await reportToolResult(config, call, outcome);
    return null;
  }
  // An event this service does not model is not an error. A newer endpoint may add
  // one, and a bridge that treated it as a failure would stop answering turns the
  // platform had already served.
  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The platform's request that a gadget tool be called, or `null` for a payload that is not
 *  one. A call with no turn to be matched to is not a call this bridge can answer. */
function readToolCall(payload: Record<string, unknown>): ToolCallRequest | null {
  const name = asString(payload.name);
  const turnId = asString(payload.turnId);
  if (name === "" || turnId === "") return null;
  const args = payload.arguments;
  return {
    turnId,
    index: typeof payload.index === "number" ? payload.index : 0,
    name,
    arguments: typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
  };
}

/**
 * Tell the turn what its call came to.
 *
 * Best-effort, and deliberately not fatal. The platform holds the turn open for exactly this
 * and gives up on its own bound, so a report that does not arrive costs the reply and not the
 * session — which is why the failure is a line in the log rather than an error up the turn.
 * What was actually done to the gadget has already happened either way.
 */
async function reportToolResult(
  config: BridgeConfig,
  call: ToolCallRequest,
  outcome: ToolCallOutcome
): Promise<void> {
  try {
    const response = await fetch(`${config.platformUrl}${TOOL_RESULT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...platformAuthHeaders(config) },
      body: JSON.stringify({
        turnId: call.turnId,
        index: call.index,
        ...(outcome.ok ? { ok: true, text: outcome.text } : { ok: false, message: outcome.message }),
      }),
      signal: AbortSignal.timeout(TOOL_RESULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      warn(
        `the platform did not take the result of ${call.name} (${response.status}) — ` +
          `the turn will give up on its own bound and the person will hear about the change secondhand`
      );
    }
  } catch (error) {
    warn(
      `could not report the result of ${call.name}: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
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
