import type { TurnLanguage } from "./turn.js";

/**
 * A spoken command, recognised from the platform's transcript of what the person
 * said.
 *
 * This module is the whole of what the bridge understands, and it understands
 * **whole utterances only**. That is a safety rule rather than tidiness (D7): a
 * command recognised by mistake does not merely miss, it silently eats a turn the
 * person meant as an answer — their question goes unanswered, the volume moves
 * instead, and nothing says why. So what is matched here is an utterance that is
 * *nothing but* a command, framed by at most a polite word or two, and the word
 * alone is never enough. "tôi hay để điện thoại ở chế độ tối" contains the dark
 * theme's own words and is an answer to a question; it is answered as one.
 *
 * The grammar is a fixed set of forms in one language — the language the gadget is
 * configured for — and not a parser. What it does not cover is a command that does
 * nothing, which leaves the person exactly where they were.
 *
 * Nothing here touches the gadget or the network: this file decides *whether* an
 * utterance is a command and *what* it asks for. Doing it — reading the gadget's
 * current value, clamping, calling the tool — is `gadget.ts`'s, and the two are
 * separate because this half is a pure function over a string and can be tested as
 * a table, which is how 3.2 tests it.
 */

/** The three settings the bridge will change, by the name its own code uses for
 *  them. The tool each one is changed through is in `gadget.ts` (D9). */
export type GadgetSetting = "volume" | "brightness" | "theme";

/**
 * A change to a setting measured on the gadget's 0–100 scale.
 *
 * `raise` and `lower` name no value at all: how far to move is the bridge's step
 * (D6) and where to move from is whatever the gadget reports when the command is
 * acted on. Only `set` carries a number, and it carries the person's own.
 */
export type NumericChange = { kind: "raise" } | { kind: "lower" } | { kind: "set"; value: number };

export type GadgetCommand =
  | { setting: "volume" | "brightness"; change: NumericChange }
  | { setting: "theme"; theme: "light" | "dark" };

/** One form of a command, matched against the whole utterance. */
interface Rule {
  /** Anchored at both ends by the matcher, so a rule can never match a part of
   *  something longer. */
  readonly test: RegExp;
  readonly command: GadgetCommand;
}

/** One language's grammar: the frames a person may wrap a command in, and the
 *  commands themselves. */
interface Grammar {
  /** Words that may open a command: "cho tôi", "làm ơn", "please". Full phrases
   *  only — see `stripFrames`. */
  readonly prefixes: readonly string[];
  /** Words that may close one: "với", "nhé", "đi". */
  readonly suffixes: readonly string[];
  readonly rules: readonly Rule[];
  /** The forms that state a value, which are the only ones that capture. */
  readonly stated: readonly {
    readonly test: RegExp;
    readonly setting: "volume" | "brightness";
  }[];
}

/**
 * A command, or `null` for an utterance that is not one.
 *
 * `language` is the deployment's (the gadget's own), so an English gadget is not
 * listening for Vietnamese and the reverse — a command in the other language is an
 * utterance this bridge does not understand, which is the same as any other phrase
 * it does not cover.
 */
export function matchCommand(language: TurnLanguage, utterance: string): GadgetCommand | null {
  const grammar = GRAMMARS[language];
  if (grammar === undefined) return null;

  const rest = stripFrames(grammar, fold(utterance));
  if (rest === "") return null;

  // Stated values first, and only then the fixed forms: the two are disjoint by
  // construction — one ends in digits and the other in a word — but reading the
  // capture before the table is what keeps that from being an assumption.
  for (const stated of grammar.stated) {
    const match = stated.test.exec(rest);
    if (match) {
      const value = Number(match.groups?.value);
      if (Number.isFinite(value)) return { setting: stated.setting, change: { kind: "set", value } };
    }
  }

  for (const rule of grammar.rules) {
    if (rule.test.test(rest)) return rule.command;
  }
  return null;
}

/**
 * A command, named the way a log line needs it: "a higher volume", "the volume to 50",
 * "the dark theme".
 *
 * The counterpart of what `gadget.apply` reports: what the bridge heard, beside what
 * it then came to. Both are lines in the same log, and an operator reading a command
 * that did not take has to be able to see which one was asked for.
 */
export function describeCommand(command: GadgetCommand): string {
  if (command.setting === "theme") return `the ${command.theme} theme`;
  if (command.change.kind === "set") return `the ${command.setting} to ${command.change.value}`;
  return `a ${command.change.kind === "raise" ? "higher" : "lower"} ${command.setting}`;
}

/**
 * An utterance reduced to what a grammar can be matched against.
 *
 * Lowercased, stripped of punctuation, and — for Vietnamese — **stripped of its
 * tone marks**. That last one is a decision worth arguing, because it is what makes
 * `tối` (dark, dim) and `tôi` (I, me) the same four letters. It is taken because the
 * alternative is worse: whether the platform's transcriber returns diacritics is
 * not something this bridge controls, and a Vietnamese grammar that only matched
 * them would turn every command into silence on the first transcriber that dropped
 * them, silently, in a language where the person cannot tell a bridge that did not
 * hear them from one that did not understand.
 *
 * What keeps the folding safe is the rule this module is built on: the *whole*
 * utterance has to be one of the forms below. `toi hon` folds onto the dimmer
 * command, and a complete Vietnamese utterance that folds onto `toi hon` while
 * meaning something else is not a thing a person says.
 */
function fold(utterance: string): string {
  return utterance
    .toLowerCase()
    .normalize("NFD")
    // The combining marks, which is where Vietnamese tone and vowel quality live.
    // `đ` survives this — it is a letter of its own, not a base plus a mark — so it
    // is folded by hand below.
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The utterance with the polite words a person wraps a command in taken off.
 *
 * Only **full phrases** are stripped, and that is the whole of the care needed
 * here: a bare "tôi" would be a frame, and it is also the first two words of
 * `toi hon` — the dimmer command — so stripping it would turn a command into a
 * polite nothing. Every frame below is a phrase that cannot be part of a command's
 * own words.
 *
 * Stripped repeatedly rather than once, because a person who says "cho tôi giảm âm
 * lượng nhé đi" is giving one command through three frames. Each strip shortens the
 * utterance, so this ends; and an over-strip is harmless, because what is left is
 * then matched against anchored rules and simply does not match.
 */
function stripFrames(grammar: Grammar, folded: string): string {
  let rest = folded;
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const prefix of grammar.prefixes) {
      if (rest.startsWith(`${prefix} `)) {
        rest = rest.slice(prefix.length + 1).trim();
        stripped = true;
        break;
      }
    }
    for (const suffix of grammar.suffixes) {
      if (rest.endsWith(` ${suffix}`)) {
        rest = rest.slice(0, -(suffix.length + 1)).trim();
        stripped = true;
        break;
      }
    }
  }
  return rest;
}

/**
 * `n` as a digit run, whatever the transcriber put after it.
 *
 * Named rather than positional, because the forms below already carry a group each for
 * the verb they may open with: `match[1]` is "đặt " on one utterance and the digits on
 * the next, and reading the number off the wrong group is a command that silently does
 * nothing.
 */
const COUNT = String.raw`(?<value>\d+)( phan tram| percent)?`;

/**
 * Vietnamese, folded to ASCII as above.
 *
 * Two forms of each numeric setting are understood: the noun with a comparative
 * ("tối hơn", "giảm độ sáng") and the noun with a verb ("giảm âm lượng", "tăng độ
 * sáng"). The neighbours that decide whether the whole-utterance rule earns its
 * keep are here: `toi hon` is a **dimmer screen** and `nen toi` is a **dark one** —
 * the same adjective, one about the backlight and one about the theme — and a
 * matcher that worked on substrings would confuse them exactly where the person is
 * watching the screen change and can see that it went the wrong way (D7).
 */
const VIETNAMESE: Grammar = {
  prefixes: ["cho toi", "giup toi", "lam on", "vui long", "xin", "hay", "voi toi"],
  suffixes: ["voi", "nhe", "di", "a"],
  rules: [
    { test: /^(tang|them) am luong$/, command: { setting: "volume", change: { kind: "raise" } } },
    { test: /^(to|lon) (hon|len)$/, command: { setting: "volume", change: { kind: "raise" } } },
    { test: /^(giam|bot) am luong$/, command: { setting: "volume", change: { kind: "lower" } } },
    { test: /^(nho|be) (hon|lai)$/, command: { setting: "volume", change: { kind: "lower" } } },

    // "sáng hơn" is the screen; "to hơn" would be the speaker, and is above. The
    // two settings share an adjective in this language, which is why neither rule
    // is written to match the adjective alone.
    { test: /^(sang hon|tang do sang)$/, command: { setting: "brightness", change: { kind: "raise" } } },
    { test: /^(toi|mo) (hon|lai)$/, command: { setting: "brightness", change: { kind: "lower" } } },
    { test: /^giam do sang$/, command: { setting: "brightness", change: { kind: "lower" } } },

    { test: /^(nen toi|che do toi|giao dien toi)$/, command: { setting: "theme", theme: "dark" } },
    { test: /^(nen sang|che do sang|giao dien sang)$/, command: { setting: "theme", theme: "light" } },
  ],
  stated: [
    { test: new RegExp(`^(dat |de |chinh |doi |cho )?am luong (thanh )?${COUNT}$`), setting: "volume" },
    { test: new RegExp(`^(dat |de |chinh |doi )?do sang (thanh )?${COUNT}$`), setting: "brightness" },
  ],
};

/**
 * English.
 *
 * Deliberately a little wider at the verb than the Vietnamese grammar is at its
 * adjectives, because English states a bare comparative as a whole utterance far
 * more easily: "dimmer" is a one-word answer to "how would you like the room?", and
 * an answer is the one thing this module may not eat. So every form here carries a
 * verb ("turn", "make", "dim", "brighten") or the setting's own noun ("volume",
 * "brightness", "mode", "theme"), and a bare "dimmer" is left alone.
 */
const ENGLISH: Grammar = {
  prefixes: ["please", "could you", "can you", "would you"],
  suffixes: ["please", "for me"],
  rules: [
    { test: /^(turn it up|turn (the )?volume up|turn up (the )?volume|volume up|increase the volume|raise the volume|make it louder)$/, command: { setting: "volume", change: { kind: "raise" } } },
    { test: /^(turn it down|turn (the )?volume down|turn down (the )?volume|volume down|decrease the volume|lower the volume|make it quieter)$/, command: { setting: "volume", change: { kind: "lower" } } },

    { test: /^(brighten (the )?screen|brighten it|make it brighter|make the screen brighter|increase the brightness|turn (the )?brightness up|turn up (the )?brightness)$/, command: { setting: "brightness", change: { kind: "raise" } } },
    { test: /^(dim (the )?screen|dim it|make it dimmer|make the screen dimmer|decrease the brightness|turn (the )?brightness down|turn down (the )?brightness)$/, command: { setting: "brightness", change: { kind: "lower" } } },

    { test: /^(dark mode|dark theme|use dark mode|switch to dark mode|set the theme to dark)$/, command: { setting: "theme", theme: "dark" } },
    { test: /^(light mode|light theme|use light mode|switch to light mode|set the theme to light)$/, command: { setting: "theme", theme: "light" } },
  ],
  stated: [
    { test: new RegExp(`^(set |change |put )?(the )?volume (to |at )?${COUNT}$`), setting: "volume" },
    { test: new RegExp(`^(set |change )?(the )?brightness (to |at )?${COUNT}$`), setting: "brightness" },
  ],
};

const GRAMMARS: Partial<Record<TurnLanguage, Grammar>> = {
  english: ENGLISH,
  vietnamese: VIETNAMESE,
};
