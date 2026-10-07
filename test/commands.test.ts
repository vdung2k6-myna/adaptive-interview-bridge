import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeCommand, matchCommand, type GadgetCommand } from "../src/commands.js";
import type { TurnLanguage } from "../src/turn.js";

/**
 * What the bridge hears a command in, and — more of the work — what it refuses to.
 *
 * The two directions are not equally cheap. A command that is missed leaves the
 * person where they were and costs them one more sentence; a command recognised by
 * mistake **eats a turn**: an answer to a question becomes a volume change, the
 * question goes unanswered, and nothing on the device says why. So the table below is
 * read both ways, and the rows that matter most are the `null` ones — "tôi hay để điện
 * thoại ở chế độ tối", "louder", "turn up the volume to 50" — each of which shares its
 * words with a command and is not one (D7, requirement 4).
 *
 * These are tables rather than a parser because that is what the module is: a fixed
 * set of whole-utterance forms per language, no gadget and no network anywhere near it
 * (3.2).
 */

const VOLUME_UP: GadgetCommand = { setting: "volume", change: { kind: "raise" } };
const VOLUME_DOWN: GadgetCommand = { setting: "volume", change: { kind: "lower" } };
const BRIGHT_UP: GadgetCommand = { setting: "brightness", change: { kind: "raise" } };
const BRIGHT_DOWN: GadgetCommand = { setting: "brightness", change: { kind: "lower" } };
const THEME_DARK: GadgetCommand = { setting: "theme", theme: "dark" };
const THEME_LIGHT: GadgetCommand = { setting: "theme", theme: "light" };
const volumeAt = (value: number): GadgetCommand => ({ setting: "volume", change: { kind: "set", value } });
const brightnessAt = (value: number): GadgetCommand => ({ setting: "brightness", change: { kind: "set", value } });

/** What a matched command is, for the message on a row that failed — the same naming
 *  the log line uses, so a row that fails reads the way the session would have. */
function say(command: GadgetCommand | null): string {
  return command === null ? "nothing" : describeCommand(command);
}

/** A table, read both ways: every row's utterance against what the bridge should make
 *  of it. `null` is "no command here". */
function read(language: TurnLanguage, rows: Array<[string, GadgetCommand | null]>): void {
  for (const [utterance, expected] of rows) {
    const heard = matchCommand(language, utterance);
    assert.deepEqual(
      heard,
      expected,
      `${JSON.stringify(utterance)}: expected ${say(expected)}, heard ${say(heard)}`
    );
  }
}

describe("recognising a command in Vietnamese", () => {
  it("matches each form the grammar claims", () => {
    read("vietnamese", [
      ["tăng âm lượng", VOLUME_UP],
      ["thêm âm lượng", VOLUME_UP],
      ["to hơn", VOLUME_UP],
      ["to lên", VOLUME_UP],
      ["lớn hơn", VOLUME_UP],
      ["lớn lên", VOLUME_UP],

      ["giảm âm lượng", VOLUME_DOWN],
      ["bớt âm lượng", VOLUME_DOWN],
      ["nhỏ hơn", VOLUME_DOWN],
      ["nhỏ lại", VOLUME_DOWN],
      ["bé hơn", VOLUME_DOWN],
      ["bé lại", VOLUME_DOWN],

      ["sáng hơn", BRIGHT_UP],
      ["tăng độ sáng", BRIGHT_UP],

      ["tối hơn", BRIGHT_DOWN],
      ["mờ hơn", BRIGHT_DOWN],
      ["tối lại", BRIGHT_DOWN],
      ["mờ lại", BRIGHT_DOWN],
      ["giảm độ sáng", BRIGHT_DOWN],

      ["nền tối", THEME_DARK],
      ["chế độ tối", THEME_DARK],
      ["giao diện tối", THEME_DARK],

      ["nền sáng", THEME_LIGHT],
      ["chế độ sáng", THEME_LIGHT],
      ["giao diện sáng", THEME_LIGHT],
    ]);
  });

  it("reads a stated value, with or without the words around it", () => {
    read("vietnamese", [
      ["âm lượng 50", volumeAt(50)],
      ["đặt âm lượng thành 50", volumeAt(50)],
      ["đặt âm lượng 50", volumeAt(50)],
      ["để âm lượng 30", volumeAt(30)],
      ["chỉnh âm lượng thành 70", volumeAt(70)],
      ["đổi âm lượng 10", volumeAt(10)],
      ["cho âm lượng thành 5", volumeAt(5)],
      ["âm lượng 50 phần trăm", volumeAt(50)],
      ["độ sáng 80", brightnessAt(80)],
      ["chỉnh độ sáng thành 40", brightnessAt(40)],
      ["để độ sáng 100", brightnessAt(100)],
    ]);
  });

  it("sees through the polite words people wrap a command in", () => {
    // One command through however many frames: a person saying "cho tôi giảm âm lượng
    // nhé đi" is not giving the bridge three commands, and each frame comes off the
    // outside of the last.
    read("vietnamese", [
      ["cho tôi giảm âm lượng", VOLUME_DOWN],
      ["giúp tôi tăng âm lượng", VOLUME_UP],
      ["làm ơn giảm âm lượng", VOLUME_DOWN],
      ["vui lòng tăng âm lượng", VOLUME_UP],
      ["xin tăng âm lượng", VOLUME_UP],
      ["hãy tăng âm lượng", VOLUME_UP],
      ["với tôi to hơn", VOLUME_UP],
      ["xin hãy tăng âm lượng", VOLUME_UP],

      ["giảm âm lượng với", VOLUME_DOWN],
      ["tăng âm lượng nhé", VOLUME_UP],
      ["giảm âm lượng đi", VOLUME_DOWN],
      // The respectful particle folds onto the same letter as the vocative one, which
      // is exactly the kind of collision the whole-utterance rule has to survive.
      ["tăng âm lượng ạ", VOLUME_UP],
      ["cho tôi giảm âm lượng nhé đi", VOLUME_DOWN],
      ["nền tối nhé", THEME_DARK],
    ]);
  });

  it("reads a command however the transcriber punctuated and accented it", () => {
    // Whether the platform returns tone marks is not this bridge's to decide, and a
    // grammar that only matched one of the two would go silent for every command the
    // first transcriber that dropped them produced — silently, in a language where a
    // person cannot tell a bridge that did not hear them from one that did not
    // understand (D7).
    read("vietnamese", [
      ["GIẢM ÂM LƯỢNG!", VOLUME_DOWN],
      ["giam am luong", VOLUME_DOWN],
      ["Giảm âm lượng.", VOLUME_DOWN],
      ["  tăng âm lượng  ", VOLUME_UP],
      ["Đặt âm lượng thành 50", volumeAt(50)],
      ["NỀN TỐI", THEME_DARK],
    ]);
  });

  it("keeps a dimmer screen apart from a dark one", () => {
    // The pair this grammar exists to keep apart (D7). One adjective, two settings: a
    // matcher working on substrings would read "nền tối" as the dimmer command and the
    // person watching the screen change would see the theme swap when they asked for
    // the backlight.
    assert.deepEqual(matchCommand("vietnamese", "tối hơn"), BRIGHT_DOWN);
    assert.deepEqual(matchCommand("vietnamese", "nền tối"), THEME_DARK);
    // And on the speaker's side, the other adjective the two settings share: "to hơn"
    // is the speaker, "sáng hơn" the screen.
    assert.deepEqual(matchCommand("vietnamese", "to hơn"), VOLUME_UP);
    assert.deepEqual(matchCommand("vietnamese", "sáng hơn"), BRIGHT_UP);
  });

  it("leaves an answer that happens to contain a command's own words alone", () => {
    // The row the requirement names. It holds the words of the dark-theme command and
    // is an answer to a question; recognising it would eat the turn, which is the
    // failure this whole module is shaped around.
    assert.equal(matchCommand("vietnamese", "tôi hay để điện thoại ở chế độ tối"), null);
  });

  it("matches nothing but the whole utterance", () => {
    read("vietnamese", [
      ["chế độ tối là gì", null],
      ["nền tối hơn", null],
      ["giảm âm lượng đi mà bạn", null],
      ["tôi muốn giảm âm lượng", null],
      ["tăng âm lượng và giảm độ sáng", null],
      ["âm lượng", null],
      ["50", null],
      ["", null],
      ["   ", null],
      ["...", null],
    ]);
  });
});

describe("recognising a command in English", () => {
  it("matches each form the grammar claims", () => {
    read("english", [
      ["turn it up", VOLUME_UP],
      ["turn the volume up", VOLUME_UP],
      ["turn up the volume", VOLUME_UP],
      ["volume up", VOLUME_UP],
      ["increase the volume", VOLUME_UP],
      ["raise the volume", VOLUME_UP],
      ["make it louder", VOLUME_UP],

      ["turn it down", VOLUME_DOWN],
      ["turn the volume down", VOLUME_DOWN],
      ["turn down the volume", VOLUME_DOWN],
      ["volume down", VOLUME_DOWN],
      ["decrease the volume", VOLUME_DOWN],
      ["lower the volume", VOLUME_DOWN],
      ["make it quieter", VOLUME_DOWN],

      ["brighten the screen", BRIGHT_UP],
      ["brighten it", BRIGHT_UP],
      ["make it brighter", BRIGHT_UP],
      ["make the screen brighter", BRIGHT_UP],
      ["increase the brightness", BRIGHT_UP],
      ["turn the brightness up", BRIGHT_UP],
      ["turn up the brightness", BRIGHT_UP],

      ["dim the screen", BRIGHT_DOWN],
      ["dim it", BRIGHT_DOWN],
      ["make it dimmer", BRIGHT_DOWN],
      ["make the screen dimmer", BRIGHT_DOWN],
      ["decrease the brightness", BRIGHT_DOWN],
      ["turn the brightness down", BRIGHT_DOWN],
      ["turn down the brightness", BRIGHT_DOWN],

      ["dark mode", THEME_DARK],
      ["dark theme", THEME_DARK],
      ["use dark mode", THEME_DARK],
      ["switch to dark mode", THEME_DARK],
      ["set the theme to dark", THEME_DARK],

      ["light mode", THEME_LIGHT],
      ["light theme", THEME_LIGHT],
      ["use light mode", THEME_LIGHT],
      ["switch to light mode", THEME_LIGHT],
      ["set the theme to light", THEME_LIGHT],
    ]);
  });

  it("reads a stated value, with or without the words around it", () => {
    read("english", [
      ["volume 50", volumeAt(50)],
      ["set the volume to 50", volumeAt(50)],
      ["set volume to 50", volumeAt(50)],
      ["change the volume to 50", volumeAt(50)],
      ["put the volume at 50", volumeAt(50)],
      ["volume at 50 percent", volumeAt(50)],
      ["brightness 80", brightnessAt(80)],
      ["set the brightness to 40", brightnessAt(40)],
      ["change brightness at 100", brightnessAt(100)],
    ]);
  });

  it("sees through the polite words people wrap a command in", () => {
    read("english", [
      ["please turn it up", VOLUME_UP],
      ["could you turn it up", VOLUME_UP],
      ["can you dim the screen", BRIGHT_DOWN],
      ["would you brighten it", BRIGHT_UP],
      ["turn it up please", VOLUME_UP],
      ["turn it up for me", VOLUME_UP],
      ["Please, turn it up!", VOLUME_UP],
      ["TURN IT UP", VOLUME_UP],
    ]);
  });

  it("leaves a bare comparative alone", () => {
    // "Dimmer" is a whole utterance a person says in answer to "how would you like the
    // room?", and an answer is the one thing this module may not eat. So no English
    // form is a bare adjective: every one carries a verb or the setting's own noun.
    read("english", [
      ["louder", null],
      ["dimmer", null],
      ["quieter", null],
      ["brighter", null],
    ]);
  });

  it("leaves an answer that happens to contain a command's own words alone", () => {
    read("english", [
      ["i always use dark mode on my phone", null],
      ["it is getting dark in here", null],
      ["the volume is too loud already", null],
      ["how are you", null],
    ]);
  });

  it("matches nothing but the whole utterance", () => {
    read("english", [
      ["turn it up and dim the screen", null],
      ["turn up the volume to 50", null],
      ["can you tell me about volume", null],
      ["", null],
      ["   ", null],
    ]);
  });
});

describe("naming a command for the log", () => {
  // The words an operator reads. The bridge answers a command by changing the gadget,
  // and the only record of which one is this line beside `gadget.apply`'s own.
  it("names what was asked for", () => {
    assert.equal(describeCommand(VOLUME_UP), "a higher volume");
    assert.equal(describeCommand(VOLUME_DOWN), "a lower volume");
    assert.equal(describeCommand(BRIGHT_UP), "a higher brightness");
    assert.equal(describeCommand(volumeAt(50)), "the volume to 50");
    assert.equal(describeCommand(brightnessAt(80)), "the brightness to 80");
    assert.equal(describeCommand(THEME_DARK), "the dark theme");
    assert.equal(describeCommand(THEME_LIGHT), "the light theme");
  });
});

describe("a command in the language the gadget is not set for", () => {
  it("is an utterance the bridge does not understand, like any other", () => {
    // The deployment's language is the gadget's, and one grammar is loaded (D7). The
    // other language's commands are not half-understood — they are not commands, and
    // are answered as what they are: something a person said.
    read("english", [
      ["giảm âm lượng", null],
      ["nền tối", null],
      ["to hơn", null],
      ["đặt âm lượng thành 50", null],
    ]);
    read("vietnamese", [
      ["turn it up", null],
      ["dark mode", null],
      ["set the volume to 50", null],
      ["dim the screen", null],
    ]);
  });
});
