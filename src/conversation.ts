import type { BridgeConfig } from "./config.js";
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

  const outcome = await runTurn(
    config,
    {
      ...turnFieldsFor(resolution.persona),
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

  conversations.record(deviceId, { user: userText, agent: outcome.replyText });
  return { served: true, userText, outcome };
}
