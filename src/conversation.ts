import type { BridgeConfig } from "./config.js";
import { matchCommand } from "./commands.js";
import type { PersonaCatalog, PersonaMissReason } from "./personas.js";
import { describePersonaMiss, resolveBoundPersona, turnFieldsFor } from "./personas.js";
import type { TurnAudio, TurnLanguage, TurnMessage, TurnOutcome, TurnSink } from "./turn.js";
import { runTurn } from "./turn.js";

/**
 * A gadget's conversation, carried across its turns.
 *
 * The platform's voice-agent endpoint keeps no conversation (D2). It is
 * stateless and self-describing: the persona arrives as `systemPrompt`, and
 * everything said earlier arrives as `history`, every turn, because there is
 * nothing on the far side holding it. So this is where a conversation lives, and
 * a gadget that is not sent its own history is a gadget with no memory — the
 * person repeats themselves and the persona meets them as a stranger.
 *
 * The conversation is kept per device rather than per socket, because that is
 * what "this gadget's conversation" means: a device that drops its connection and
 * comes back is the same gadget, and starting it over would be a thing the person
 * experiences as the gadget forgetting. Nothing here is written to disk, so a
 * restart is a fresh conversation — which is the honest reading of a service that
 * holds no database.
 *
 * A turn is recorded from both sides. The person's side comes from the stream's
 * `user` event, which is the platform's transcription of what they said and the
 * only place it exists; the gadget's side is the reply text, which the bridge has
 * anyway because it is about to speak it. Neither is guessed.
 *
 * One turn is not a turn of the conversation: a command the bridge recognised and
 * answered by changing one of the gadget's own settings (D8). It is asked of the
 * platform — the transcript is the only place a command is knowable at all — and
 * then dropped, and what must not survive it is the transcript. `takeTurn` is where
 * it is left out, and the reason is at the check itself.
 */

/** One completed exchange, as the conversation keeps it. */
export interface TurnExchange {
  /** What the person said, as the platform transcribed it. May be empty. */
  user: string;
  /** What the gadget answered. May be empty, if the turn produced no reply. */
  agent: string;
}

export interface Conversations {
  /** The earlier turns, oldest first, ready to send as a turn's `history`. */
  history(deviceId: string): TurnMessage[];
  /** Take down a turn that was served. */
  record(deviceId: string, exchange: TurnExchange): void;
}

/**
 * Hold every device's conversation, bounded to the most recent `historyTurns`
 * turns (4.3).
 *
 * Bounded because the endpoint's own limit is invisible from here: a request
 * carrying an unbounded history grows with the session until it is refused or the
 * model's window is exceeded, and the failure lands on a turn rather than on a
 * startup. The bound drops the **oldest** turns — what the spec asks for — rather
 * than the platform's own trick of keeping the first exchange as well, because a
 * gadget conversation has no opening turn whose loss would be felt the way an
 * interview's introduction is: a greeting answered twenty turns ago is the least
 * useful thing in the history, not the most.
 *
 * A turn is dropped whole. A history beginning with the gadget's answer to a
 * question that is no longer in it is worse than a shorter one, so the pairing is
 * kept by construction: turns are stored as exchanges and flattened to messages
 * only on the way out.
 */
export function createConversations(config: BridgeConfig): Conversations {
  const byDevice = new Map<string, TurnExchange[]>();

  return {
    history(deviceId: string): TurnMessage[] {
      return flatten(byDevice.get(deviceId) ?? []);
    },

    record(deviceId: string, exchange: TurnExchange): void {
      // A turn that produced nothing on either side is not a turn. Recording an
      // empty exchange would spend a slot of the bound on it.
      if (exchange.user === "" && exchange.agent === "") return;

      const kept = byDevice.get(deviceId) ?? [];
      kept.push(exchange);
      // Trimmed here rather than in `history`, so what is held is what is sent:
      // a conversation that only ever grew would be a leak in a service meant to
      // run for months, whatever the request carried.
      while (kept.length > config.historyTurns) kept.shift();
      byDevice.set(deviceId, kept);
    },
  };
}

function flatten(exchanges: readonly TurnExchange[]): TurnMessage[] {
  const messages: TurnMessage[] = [];
  for (const exchange of exchanges) {
    // A side that is empty is left out rather than sent blank. The platform's own
    // parser accepts an empty content, so a blank message would be carried into the
    // prompt as a turn nobody took.
    if (exchange.user !== "") messages.push({ role: "user", content: exchange.user });
    if (exchange.agent !== "") messages.push({ role: "agent", content: exchange.agent });
  }
  return messages;
}

/** What a turn needs from the device: its language, and what the person said. */
export interface DeviceTurnInput {
  language: TurnLanguage;
  audio?: TurnAudio;
  text?: string;
  /**
   * The gadget's own account of itself, when it gave one (2.1). Appended to the
   * persona's prompt for this turn only, never stored: it is a fact about a device
   * that can change between turns, so a copy kept here would be a second, staler
   * answer to a question `gadget.ts` already answers.
   *
   * Absent — not empty — is the whole of how "this gadget has no condition to report"
   * is said, so that a gadget without a tool channel is asked for exactly the turn it
   * would have been asked for had none of this existed (requirement 5).
   */
  gadgetCondition?: string;
}

export type DeviceTurnResult =
  | { served: true; userText: string; outcome: TurnOutcome }
  /**
   * No turn was sent. The gadget is bound to an identifier the catalog does not
   * report, and the requirement is that it is answered as no one rather than as
   * somebody else (D5, 3.4). `message` is the line to hand an operator; `detail`
   * says which of the three misses it was.
   */
  | { served: false; miss: PersonaMissReason; detail: string; message: string };

/**
 * Take one turn for a device: resolve who answers it, carry the conversation in,
 * send it, and put the turn back into the conversation.
 *
 * This is the whole of what "a turn" means for this service, and it is the only
 * place the two halves of §4 meet: the persona's fields from §3 and the person's
 * own voice from §6 arrive as arguments, and what comes back is recorded for the
 * next turn. A caller that used `runTurn` directly would be skipping the
 * conversation, which is a bug that stays invisible for exactly one turn.
 */
export async function takeTurn(
  config: BridgeConfig,
  catalog: PersonaCatalog,
  conversations: Conversations,
  deviceId: string,
  input: DeviceTurnInput,
  sink: TurnSink,
  signal?: AbortSignal
): Promise<DeviceTurnResult> {
  // Resolved before anything is sent, and resolved the same way on every turn:
  // whether a persona is missing can change while the bridge runs (3.3), so this
  // is a per-turn answer and not a decision taken at connect.
  const resolution = await resolveBoundPersona(catalog, config, deviceId);
  if (!resolution.ok) {
    return {
      served: false,
      miss: resolution.reason,
      detail: resolution.detail,
      message: describePersonaMiss(deviceId, resolution),
    };
  }

  // The turn's own transcript, captured from the stream as it passes. It is the
  // only copy: the platform keeps nothing, and by the time the turn ends the
  // event that carried it is gone.
  let userText = "";

  const fields = turnFieldsFor(resolution.persona);
  const outcome = await runTurn(
    config,
    {
      ...fields,
      // After the persona's own words, separated by a blank line, so the prompt the
      // persona author wrote still opens the request and reads as one instruction
      // with a footnote rather than as two. What the gadget reported is the gadget's
      // own words restated, and nothing here paraphrases or interprets them (2.2).
      systemPrompt:
        input.gadgetCondition === undefined
          ? fields.systemPrompt
          : `${fields.systemPrompt}\n\n${input.gadgetCondition}`,
      language: input.language,
      history: conversations.history(deviceId),
      ...(input.audio ? { audio: input.audio } : {}),
      ...(input.text !== undefined ? { text: input.text } : {}),
    },
    {
      ...sink,
      onUser: async (text) => {
        userText = text;
        await sink.onUser?.(text);
      },
    },
    signal
  );

  // A command the bridge answered itself is not a turn of this conversation (D8,
  // requirement 4). The person said nothing to the interview and the platform answered
  // nothing — what happened happened on the gadget — so recording it would put a
  // question nobody put to the model into the history, followed by the silence where
  // its answer should be, and the next interview turn would be asked against a
  // conversation that never took place.
  //
  // The check is here, at the one recording site, rather than at each caller: a caller
  // that forgot it would leave the defect to be found as the model answering a command
  // nobody gave it. Nothing said in reply is the second half of the shape and not a
  // repetition of it — a turn that *was* spoken for was answered, whatever its
  // transcript happens to read as, and belongs in the history as much as any other.
  const answeredByTheBridge = outcome.replyText === "" && matchCommand(config.language, userText) !== null;
  if (!answeredByTheBridge) {
    conversations.record(deviceId, { user: userText, agent: outcome.replyText });
  }
  return { served: true, userText, outcome };
}
