import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chooseTrack } from "../src/music.js";

const MUSIC = fileURLToPath(new URL("./fixtures/music", import.meta.url));

/** One name, alone, so that what is under test is the matching and not the choice among files. */
function only(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "bridge-track-"));
  for (const name of names) writeFileSync(join(dir, name), "");
  return dir;
}

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

  it("finds a name by the words the two share, when the request carries more than the name", async () => {
    // What a person says is longer than a file's name: the singer after the title, a word the
    // transcriber put in. Requiring *every* word of the request to be in the name is what a request
    // that named its track correctly was failing on 8 times in 8 (measured 2026-10-11), and the
    // shape it failed on is the ordinary way a person names a song.
    assert.equal(await choose("diễm xưa trịnh công sơn"), "Trinh Cong Son - Diem Xua.mp3");
    assert.equal(await choose("trinh cong son diem xua"), "Trinh Cong Son - Diem Xua.mp3");
    // And what the name does not carry is not, by itself, a reason to find nothing.
    assert.equal(await choose("diem xua cua trinh cong son"), "Trinh Cong Son - Diem Xua.mp3");
  });

  it("holds a request's number to the file that answers it", async () => {
    // The guard that keeps "the longest run" from meaning "the nearest name". Numbered siblings
    // differ in nothing else, so a request for one of them must not be answered with another — nor
    // with the unnumbered one, whose name is those same words with the number left off.
    assert.equal(await choose("Nhạc không lời 3"), "!no-match");
    assert.equal(await choose("Nhạc không lời 1"), "!no-match");
    // And the number a file does carry is still a way to reach it, whole or as the name it is part of.
    assert.equal(await choose("Nhạc không lời 2"), "Nhac khong loi 2.mp3");
    assert.equal(await choose("khong loi 2"), "Nhac khong loi 2.mp3");
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

describe("a name that comes back put together", () => {
  const HYPHENATED = only("Ao-Lua-Ha-Dong-Ngo-Thuy-Mien.mp3");
  const NAME = "Ao-Lua-Ha-Dong-Ngo-Thuy-Mien.mp3";

  it("finds it however much of the name the transcriber joined", async () => {
    // A hyphen invites the transcriber to put the words back together, and it can put back only
    // some of them. Reported on 2026-10-11 as a hyphen that "cannot be read": `aoluahadong` found
    // nothing, in the build before this change and in the one after it, because a second writing of
    // the *whole* name is no help when the request is a fragment of it.
    assert.equal(await choose("aoluahadong", HYPHENATED), NAME);
    assert.equal(await choose("aoluahadongngo", HYPHENATED), NAME);
    // A run of whole words joined is still those words, wherever it starts in the name.
    assert.equal(await choose("hadongngo", HYPHENATED), NAME);
    assert.equal(await choose("aoluahadong ngo thuy mien", HYPHENATED), NAME);
    assert.equal(await choose("aoluahadongngothuymien", HYPHENATED), NAME);
    // And the writings that always worked still do, by the same path or the one before it.
    assert.equal(await choose("ao lua ha dong", HYPHENATED), NAME);
    assert.equal(await choose("áo lụa hà đông", HYPHENATED), NAME);
  });

  it("does not become a fragment search", async () => {
    // The boundaries are the whole of the difference between this and looking for a substring, and
    // they are why it can be reached for at all: `adong` runs from the second letter of `ha` into
    // the next word, and `olua` from the second letter of `ao` — neither is a word of the name, which
    // is the same refusal `hac` gets from `nhac`.
    assert.equal(await choose("olua", HYPHENATED), "!no-match");
    assert.equal(await choose("adong", HYPHENATED), "!no-match");
    assert.equal(await choose("hac"), "!no-match");
  });
});

describe("a directory that files its tracks in folders", () => {
  const NESTED = fileURLToPath(new URL("./fixtures/music-nested", import.meta.url));
  const FOLDERS_ONLY = fileURLToPath(new URL("./fixtures/music-folders-only", import.meta.url));

  it("offers a track below the configured directory", async () => {
    // A person's music is filed in folders. Reading only the top one means a track that exists is a
    // track the bridge is silent about, which is the one thing a listing must not be.
    assert.equal(await choose("deep track", NESTED), "Deep Track.mp3");
    assert.equal(await choose("top track", NESTED), "Top Track.mp3");
  });

  it("is not a directory holding nothing when everything is one level down", async () => {
    // The boundary of the same rule: nothing sits directly in this one, and a person asking it for
    // what it holds is not asking a directory that has nothing to play.
    assert.equal(await choose("deep track", FOLDERS_ONLY), "Deep Track.mp3");
  });
});
