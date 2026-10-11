import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { chooseTrack } from "../src/music.js";

const MUSIC = fileURLToPath(new URL("./fixtures/music", import.meta.url));

/** The file a choice settled on, or the reason it settled on none. */
async function choose(query: string, directory: string = MUSIC): Promise<string> {
  const choice = await chooseTrack(directory, query);
  return choice.ok ? basename(choice.path) : `!${choice.reason}`;
}

describe("choosing a track from the bridge's directory", () => {
  it("finds a name asked for with the tone marks the file does not carry", async () => {
    // The ordinary case for Vietnamese, and the reason the comparison is folded: a request
    // arrives with diacritics and the file on disk has none, or the other way round.
    assert.equal(await choose("diễm xưa"), "Trinh Cong Son - Diem Xua.mp3");
    assert.equal(await choose("Trịnh Công Sơn"), "Trinh Cong Son - Diem Xua.mp3");
  });

  it("finds a name by the whole words in it, and never by a fragment", async () => {
    assert.equal(await choose("diem xua"), "Trinh Cong Son - Diem Xua.mp3");
    // A fragment of a word is not a word of any name: "hac" sits inside "nhac" and matches
    // nothing, where "nhac" itself is a whole word of two names and is an ambiguity instead.
    assert.equal(await choose("hac"), "!no-match");
    assert.equal(await choose("nhac"), "!ambiguous");
  });

  it("takes a name over the words inside it, so a numbered track is not the first one", async () => {
    assert.equal(await choose("Nhạc không lời 2"), "Nhac khong loi 2.mp3");
    // And the name wins over the words it contains: "Nhac khong loi" is one file's whole name and
    // another's first three words, and a name asked for whole is not an ambiguity — it is that
    // file being asked for.
    assert.equal(await choose("Nhạc không lời"), "Nhac khong loi.mp3");
  });

  it("reports an ambiguity rather than settling it by picking one", async () => {
    // The mistake that matters. Playing one of two is playing something the person did not ask
    // for, and nothing in what they hear says so — where playing nothing is a thing they can
    // hear and ask again about.
    assert.equal(await choose("khong loi"), "!ambiguous");
    assert.equal(await choose("loi"), "!ambiguous");
  });

  it("reports nothing to play, and nothing matching, as different answers", async () => {
    assert.equal(await choose("beatles"), "!no-match");
    assert.equal(await choose("anything", fileURLToPath(new URL("./fixtures/no-such-dir", import.meta.url))), "!no-music");
    assert.equal(await choose("anything", ""), "!no-music");
  });

  it("ignores what is not an mp3", async () => {
    // `notes.txt` sits in the fixture directory and is named by no query above.
    assert.equal(await choose("notes"), "!no-match");
  });

  it("plays the first by name when the request names no track", async () => {
    // "Phát nhạc" asks for music and not for a file, so there is nothing to be ambiguous about and
    // nothing to refuse. The first by name is what plays — the same request answered the same way
    // every time, and a directory a deployment can order by the way it names its files.
    assert.equal(await choose(""), basename("Long Tone.mp3"));
    assert.equal(await choose("   "), basename("Long Tone.mp3"), "and folding leaves it naming nothing");
  });
});
