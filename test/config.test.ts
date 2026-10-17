import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  boundEngine,
  boundLanguage,
  loadConfig,
  pairedGadgets,
  partnerOf,
  ENDPOINTER_DEFAULTS,
  MUSIC_GAIN_DB_DEFAULT,
} from "../src/config.js";

/**
 * The configuration is where the rules that must not fail open live: an empty
 * allowlist, a device secret with no default, the platform's credential — from
 * 2.3, which has none either — and, from 3.1, the platform's address, which has
 * none for a different reason: the only obvious default is localhost, and
 * localhost is right on one machine and silently wrong on every other. A bridge
 * that starts without a device secret would run with something predictable; one
 * that reads an empty allowlist as "no restriction" would refuse nothing; and one
 * that starts without the platform's credential or address only fails later, at
 * its first platform call, where the cause is far from the symptom. All four are
 * pinned here, along with the parsing an operator cannot see — and, from 3.2, the
 * rule that the allowlist and the persona bindings must name the same devices. The
 * engine a gadget speaks through belongs with these rather than with the rest of
 * the configuration: it is refused rather than folded to another one, for the
 * reason the language is.
 */
const BOARD = "b8:1f:3f:4a:9b:01";
const SECRET = "s".repeat(43);
const PLATFORM = "platform-token-abcdefgh";
const PLATFORM_URL = "http://127.0.0.1:4000";

/**
 * The minimum a config needs to load: the platform's address and the two
 * credentials — the three values with no default — and nothing else.
 */
const minimal = {
  BRIDGE_DEVICE_SECRET: SECRET,
  API_AUTH_TOKEN: PLATFORM,
  BRIDGE_PLATFORM_URL: PLATFORM_URL,
} as NodeJS.ProcessEnv;

/**
 * The other two lists every allowlisted device needs.
 *
 * The language and the engine are bound per gadget, so the cross-check that held the
 * allowlist and the persona bindings together now holds three lists — and a config
 * that names a device and binds only its persona is no longer one this bridge starts
 * from. A test about the allowlist, or about one of the lists, says so with this.
 */
const speech = (devices: string): Record<string, string> => {
  const named = devices
    .split(",")
    .map((device) => device.trim())
    .filter((device) => device !== "");
  return {
    BRIDGE_DEVICE_LANGUAGES: named.map((device) => `${device}=english`).join(","),
    BRIDGE_DEVICE_ENGINES: named.map((device) => `${device}=supertonic`).join(","),
  };
};

describe("the device secret", () => {
  it("refuses to load without one, rather than falling back to a constant", () => {
    assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), /BRIDGE_DEVICE_SECRET must be set/);
    assert.throws(() => loadConfig({ BRIDGE_DEVICE_SECRET: "" } as NodeJS.ProcessEnv), /BRIDGE_DEVICE_SECRET/);
  });

  it("refuses a secret short enough to guess", () => {
    // The skeleton's "spike" is exactly this mistake, so it must not load.
    assert.throws(() => loadConfig({ BRIDGE_DEVICE_SECRET: "spike" } as NodeJS.ProcessEnv), /at least 32 characters/);
  });

  it("says how to generate one", () => {
    assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), /randomBytes/);
  });
});

describe("the platform credential", () => {
  it("refuses to load without one, so a bridge never starts unable to authenticate", () => {
    // The address is supplied, so what is missing here is the token and only the
    // token: each rule is pinned by a test that isolates it.
    const withoutToken = { BRIDGE_DEVICE_SECRET: SECRET, BRIDGE_PLATFORM_URL: PLATFORM_URL };
    assert.throws(() => loadConfig(withoutToken as NodeJS.ProcessEnv), /API_AUTH_TOKEN must be set/);
    assert.throws(
      () => loadConfig({ ...withoutToken, API_AUTH_TOKEN: "" } as NodeJS.ProcessEnv),
      /API_AUTH_TOKEN/
    );
  });

  it("treats a value that is only whitespace as absent", () => {
    // A blank line in .env is a missing token, not a token made of spaces.
    assert.throws(
      () =>
        loadConfig({
          BRIDGE_DEVICE_SECRET: SECRET,
          BRIDGE_PLATFORM_URL: PLATFORM_URL,
          API_AUTH_TOKEN: "   ",
        } as NodeJS.ProcessEnv),
      /API_AUTH_TOKEN must be set/
    );
  });

  it("carries the token byte for byte, since the platform compares it exactly", () => {
    // Rounding a token up with a helpful trim would be a credential that no
    // longer authenticates.
    const unpadded = `${PLATFORM}`;
    assert.equal(loadConfig({ ...minimal, API_AUTH_TOKEN: unpadded } as NodeJS.ProcessEnv).apiAuthToken, unpadded);
    assert.equal(
      loadConfig({ ...minimal, API_AUTH_TOKEN: ` ${PLATFORM} ` } as NodeJS.ProcessEnv).apiAuthToken,
      ` ${PLATFORM} `
    );
  });

  it("imposes no length rule, because the platform issues it rather than this service", () => {
    // The device secret is generated here, so it can be held to entropy. This
    // one is carried as the platform made it.
    assert.equal(loadConfig({ ...minimal, API_AUTH_TOKEN: "short" } as NodeJS.ProcessEnv).apiAuthToken, "short");
  });
});

describe("the platform's address", () => {
  it("refuses to load without one, because the obvious default is localhost", () => {
    // Every other address in this file is one this machine serves on. This one
    // belongs to a deployment, and a bridge that guessed would come up looking
    // healthy and reach nothing.
    assert.throws(
      () => loadConfig({ BRIDGE_DEVICE_SECRET: SECRET, API_AUTH_TOKEN: PLATFORM } as NodeJS.ProcessEnv),
      /BRIDGE_PLATFORM_URL must be set/
    );
    assert.throws(() => loadConfig({ ...minimal, BRIDGE_PLATFORM_URL: "" } as NodeJS.ProcessEnv), /BRIDGE_PLATFORM_URL/);
  });

  it("drops trailing slashes, so joining a path is a plain concatenation", () => {
    assert.equal(loadConfig({ ...minimal, BRIDGE_PLATFORM_URL: `${PLATFORM_URL}/` }).platformUrl, PLATFORM_URL);
    assert.equal(loadConfig({ ...minimal, BRIDGE_PLATFORM_URL: `${PLATFORM_URL}//` }).platformUrl, PLATFORM_URL);
  });

  it("keeps a base path, since a deployment may front the platform with one", () => {
    assert.equal(loadConfig({ ...minimal, BRIDGE_PLATFORM_URL: "https://host/gw/" }).platformUrl, "https://host/gw");
  });

  it("tolerates surrounding whitespace, unlike the credential", () => {
    // This is a URL this service parses, not a byte string the platform compares,
    // so a stray space from a paste is trimmed rather than carried.
    assert.equal(loadConfig({ ...minimal, BRIDGE_PLATFORM_URL: ` ${PLATFORM_URL} ` }).platformUrl, PLATFORM_URL);
  });

  it("refuses anything that is not an http(s) base URL", () => {
    const at = (value: string) => () => loadConfig({ ...minimal, BRIDGE_PLATFORM_URL: value });
    assert.throws(at("127.0.0.1:4000"), /absolute URL/);
    assert.throws(at("ftp://host"), /http or https/);
    assert.throws(at(`${PLATFORM_URL}/?a=1`), /query or fragment/);
    assert.throws(at(`${PLATFORM_URL}/#x`), /query or fragment/);
  });
});

describe("the allowlist", () => {
  it("normalizes what an operator pasted", () => {
    const config = loadConfig({
      ...minimal,
      BRIDGE_ALLOWED_DEVICES: " B8-1F-3F-4A-9B-01 , b8:1f:3f:4a:9b:02 ",
      BRIDGE_DEVICE_PERSONAS: "B8-1F-3F-4A-9B-01=friendly-tutor,b8:1f:3f:4a:9b:02=debate-partner",
      ...speech("B8-1F-3F-4A-9B-01,b8:1f:3f:4a:9b:02"),
    } as NodeJS.ProcessEnv);
    assert.deepEqual(config.allowedDevices, ["b81f3f4a9b01", "b81f3f4a9b02"]);
  });

  it("counts one device once, however many spellings it was listed under", () => {
    const config = loadConfig({
      ...minimal,
      BRIDGE_ALLOWED_DEVICES: `${BOARD},b81f3f4a9b01,B8:1F:3F:4A:9B:01`,
      BRIDGE_DEVICE_PERSONAS: "b81f3f4a9b01=interview-coach",
      ...speech(BOARD),
    } as NodeJS.ProcessEnv);
    assert.equal(config.allowedDevices.length, 1);
  });

  it("is empty when unset, and empty means nobody", () => {
    // Not "no restriction": nothing named, nothing allowed.
    assert.deepEqual(loadConfig(minimal).allowedDevices, []);
    assert.deepEqual(
      loadConfig({ ...minimal, BRIDGE_ALLOWED_DEVICES: "  ,  ," } as NodeJS.ProcessEnv).allowedDevices,
      []
    );
  });
});

/**
 * The bindings, and the cross-check between them and the allowlist. Every list has to
 * describe the same devices: a device that may connect and has no persona could never
 * be answered, one with no language or engine could never be heard or spoken to, and a
 * binding for a device the allowlist does not name is configuration for something that
 * can never connect. All of them are refused at start, where the operator is — and the
 * error names the kind, because three lists are three things to get wrong.
 */
describe("the bindings each device has", () => {
  const board = (personas: string) =>
    ({
      ...minimal,
      BRIDGE_ALLOWED_DEVICES: BOARD,
      BRIDGE_DEVICE_PERSONAS: personas,
      ...speech(BOARD),
    }) as NodeJS.ProcessEnv;

  it("reads DEVICE=PERSONA, normalizing the device as the allowlist does", () => {
    // Normalized the same way means the two lists can be pasted from the same
    // place and still agree — which is the only reason the cross-check can be
    // exact rather than fuzzy.
    const config = loadConfig(board("B8-1F-3F-4A-9B-01=interview-coach"));
    assert.deepEqual([...config.devicePersonas], [["b81f3f4a9b01", "interview-coach"]]);
  });

  it("splits on the first =, because a Device-Id is full of colons", () => {
    // The device here is written with its separators, so a separator-based parse
    // would still work; the `=` is what a persona id may not contain and a
    // Device-Id may.
    const config = loadConfig(board("b8:1f:3f:4a:9b:01=custom-2"));
    assert.equal(config.devicePersonas.get("b81f3f4a9b01"), "custom-2");
  });

  it("carries the persona identifier exactly, since the catalog's are exact", () => {
    // No case folding and no normalization: an identifier the platform does not
    // report is meant to be a miss (3.3), not a near-miss this service guesses at.
    assert.equal(loadConfig(board("b81f3f4a9b01=Custom-2")).devicePersonas.get("b81f3f4a9b01"), "Custom-2");
  });

  it("accepts the same separators between bindings that the allowlist accepts", () => {
    const config = loadConfig({
      ...minimal,
      BRIDGE_ALLOWED_DEVICES: `${BOARD},b81f3f4a9b02`,
      BRIDGE_DEVICE_PERSONAS: `${BOARD}=interview-coach;b81f3f4a9b02=debate-partner`,
      ...speech(`${BOARD},b81f3f4a9b02`),
    } as NodeJS.ProcessEnv);
    assert.equal(config.devicePersonas.size, 2);
  });

  it("refuses an allowed device with no binding, since it could never be answered", () => {
    assert.throws(() => loadConfig({ ...minimal, BRIDGE_ALLOWED_DEVICES: BOARD } as NodeJS.ProcessEnv), /no binding/);
    // And says which device, so the operator does not have to diff two lists.
    assert.throws(() => loadConfig({ ...minimal, BRIDGE_ALLOWED_DEVICES: BOARD } as NodeJS.ProcessEnv), /b81f3f4a9b01/);
  });

  it("names the kind of binding a device is missing, since there are three to get wrong", () => {
    // Each list left out in turn. The error is the one an operator will actually meet
    // — a list forgotten while adding a gadget — so it says which list, not only which
    // device.
    const personaOnly = { ...minimal, BRIDGE_ALLOWED_DEVICES: BOARD, BRIDGE_DEVICE_PERSONAS: `${BOARD}=interview-coach` };
    assert.throws(
      () => loadConfig(personaOnly as NodeJS.ProcessEnv),
      /b81f3f4a9b01 has no binding for language, engine/
    );

    const noEngine = { ...board(`${BOARD}=interview-coach`), BRIDGE_DEVICE_ENGINES: "" };
    assert.throws(() => loadConfig(noEngine as NodeJS.ProcessEnv), /b81f3f4a9b01 has no binding for engine/);

    const noLanguage = { ...board(`${BOARD}=interview-coach`), BRIDGE_DEVICE_LANGUAGES: "" };
    assert.throws(() => loadConfig(noLanguage as NodeJS.ProcessEnv), /b81f3f4a9b01 has no binding for language/);
  });

  it("refuses a stranger in any of the three lists", () => {
    // The same refusal the persona list already had, applied to the two that joined it:
    // a gadget bound in a list the allowlist does not name is a typo, not a deployment.
    const stranger = {
      ...board(`${BOARD}=interview-coach`),
      BRIDGE_DEVICE_ENGINES: `${BOARD}=supertonic,b81f3f4a9b02=piper`,
    };
    assert.throws(() => loadConfig(stranger as NodeJS.ProcessEnv), /b81f3f4a9b02/);
  });

  it("refuses a binding for a device the allowlist does not name", () => {
    // Nearly always a typo in one of the two identifiers, and one that would
    // otherwise sit in configuration forever serving nobody.
    assert.throws(() => loadConfig(board(`${BOARD}=interview-coach,b81f3f4a9b02=debate-partner`)), /b81f3f4a9b02/);
  });

  it("refuses a device bound twice, because a device speaks as one persona", () => {
    assert.throws(
      () => loadConfig(board(`${BOARD}=interview-coach,B8-1F-3F-4A-9B-01=debate-partner`)),
      /binds b81f3f4a9b01 twice/
    );
  });

  it("refuses an entry that is not DEVICE=PERSONA, or has a side missing", () => {
    const at = (personas: string) => () => loadConfig(board(personas));
    assert.throws(at(BOARD), /DEVICE=PERSONA/);
    assert.throws(at(`${BOARD}=`), /names no persona/);
    assert.throws(at(`=interview-coach`), /DEVICE=PERSONA|names no device/);
  });

  it("is empty when unset, which is only consistent with an empty allowlist", () => {
    assert.equal(loadConfig(minimal).devicePersonas.size, 0);
  });
});

describe("the rest of the configuration", () => {
  it("keeps the values that were already settled", () => {
    const config = loadConfig(minimal);
    assert.equal(config.otaPort, 8003);
    assert.equal(config.wsPort, 8000);
    assert.equal(config.framing, 3);
    assert.equal(config.serverRate, 24000);
    assert.equal(config.frameMs, 60);
  });

  it("reads the endpointer's own defaults, which are not the downlink's rate", () => {
    const config = loadConfig(minimal);
    // 16000 upward, 24000 downward. A deployment that reused the hello's rate for
    // the decoder would build it at a rate the device's packets do not decode at
    // (6.1), so the two are asserted apart rather than together.
    assert.equal(config.deviceRate, 16000);
    assert.notEqual(config.deviceRate, config.serverRate);
    assert.equal(config.vadMinRms, 7500);
    assert.equal(config.vadFloorRatio, 2.5);
    assert.equal(config.vadSilenceMs, 900);
    assert.equal(config.vadMinSpeechMs, 500);
    assert.equal(config.vadSpeechWindowMs, 3000);
    assert.equal(config.maxTurnMs, 20000);
    assert.equal(config.vadNoSpeechMs, 15000);
    assert.equal(config.drainGuardMs, 400);
    assert.equal(config.onsetLeadMs, 300);
  });

  it("reads the session window, where nought is a value and not a mistake", () => {
    // The window is the one count in this file that may be nought, and nought is how
    // it is turned off: a bridge with the window off holds a session open for as long
    // as the device keeps it open, which is what this bridge did before the window
    // existed. Every other count goes through `readInt`, which refuses nought because
    // for those a nought is a mistake rather than a value.
    assert.equal(loadConfig(minimal).sessionIdleMs, 60000);
    assert.equal(
      loadConfig({ ...minimal, BRIDGE_SESSION_IDLE_MS: "0" } as NodeJS.ProcessEnv).sessionIdleMs,
      0
    );
    assert.equal(
      loadConfig({ ...minimal, BRIDGE_SESSION_IDLE_MS: "90000" } as NodeJS.ProcessEnv).sessionIdleMs,
      90000
    );
    assert.throws(
      () => loadConfig({ ...minimal, BRIDGE_SESSION_IDLE_MS: "-1" } as NodeJS.ProcessEnv),
      /BRIDGE_SESSION_IDLE_MS must be a non-negative integer/
    );
    assert.throws(
      () => loadConfig({ ...minimal, BRIDGE_SESSION_IDLE_MS: "1.5" } as NodeJS.ProcessEnv),
      /BRIDGE_SESSION_IDLE_MS must be a non-negative integer/
    );
  });

  it("leaves the bridge with no music unless a deployment says where it is", () => {
    // Empty is the absent case and not a degraded one: with no directory the two music commands
    // go unrecognised and fall through, and no tool of the bridge's own is offered to a model —
    // which is this bridge before the change. A shipped default would instead point every bridge
    // at a directory that exists on none of them.
    assert.equal(loadConfig(minimal).musicDir, "");
    assert.equal(
      loadConfig({ ...minimal, BRIDGE_MUSIC_DIR: "   " } as NodeJS.ProcessEnv).musicDir,
      "",
      "whitespace is not a directory either"
    );
    assert.equal(
      loadConfig({ ...minimal, BRIDGE_MUSIC_DIR: "/srv/music" } as NodeJS.ProcessEnv).musicDir,
      "/srv/music"
    );
  });

  it("plays a track at the measured level unless a deployment says otherwise", () => {
    // The one knob here that may be negative or nought, because it is a *difference* between two
    // levels rather than a level. The default is the measurement: a track of this deployment's own
    // library sat 10.4 dB above the voice it speaks with, and playing music at that much less is
    // what leaves the person an opening to be heard over it (design D3).
    assert.equal(loadConfig(minimal).musicGainDb, MUSIC_GAIN_DB_DEFAULT);
    assert.ok(MUSIC_GAIN_DB_DEFAULT < 0, "and quieter, which is the whole of what it is for");

    // Nought is a deployment saying it will leave that unmet, which is a decision an operator may
    // make and not a typo to refuse — and a positive gain is a quiet recording they mean to bring
    // up. Only a value that is not a number at all is refused, because that one would play the
    // music at the wrong level in a way nobody hears as a configuration mistake.
    const at = (raw: string) => loadConfig({ ...minimal, BRIDGE_MUSIC_GAIN_DB: raw } as NodeJS.ProcessEnv);
    assert.equal(at("0").musicGainDb, 0);
    assert.equal(at("-6").musicGainDb, -6);
    assert.equal(at("3.5").musicGainDb, 3.5, "a fraction of a decibel is still a decibel");
    assert.equal(at("").musicGainDb, MUSIC_GAIN_DB_DEFAULT, "an empty value is an unnamed one");
    assert.throws(() => at("quiet"), /BRIDGE_MUSIC_GAIN_DB must be a number/);
    assert.throws(() => at("NaN"), /BRIDGE_MUSIC_GAIN_DB/);
  });

  it("reads them from the environment, floor ratio included", () => {
    const config = loadConfig({
      ...minimal,
      BRIDGE_DEVICE_RATE: "48000",
      BRIDGE_VAD_FLOOR_RATIO: "1.75",
      BRIDGE_VAD_SPEECH_WINDOW_MS: "4000",
    } as NodeJS.ProcessEnv);
    assert.equal(config.deviceRate, 48000);
    assert.equal(config.vadFloorRatio, 1.75);
    assert.equal(config.vadSpeechWindowMs, 4000);
  });

  it("refuses an endpointer that could never close a turn", () => {
    // 6.4. Speech is counted over a sliding window, so a window no longer than the
    // silence threshold plus the speech minimum means the frames that satisfied the
    // minimum have aged out before the threshold is reached — and the gadget simply
    // never answers. The rig warned about this and the rig's own comment names its
    // failure as silent; here it is a startup failure, where the operator is.
    //
    // The boundary is the sum of two knobs this change moved, so it is computed from
    // the shipped defaults rather than written down: a hard-coded 1141 was the old
    // 900 + 240, and it would have gone on passing had the constant been raised and
    // this line not read.
    const boundary = ENDPOINTER_DEFAULTS.vadSilenceMs + ENDPOINTER_DEFAULTS.vadMinSpeechMs;
    assert.throws(
      () => loadConfig({ ...minimal, BRIDGE_VAD_SPEECH_WINDOW_MS: `${boundary}` } as NodeJS.ProcessEnv),
      /BRIDGE_VAD_SPEECH_WINDOW_MS must exceed/
    );
    assert.throws(
      () => loadConfig({ ...minimal, BRIDGE_VAD_SILENCE_MS: "2800" } as NodeJS.ProcessEnv),
      /BRIDGE_VAD_SPEECH_WINDOW_MS must exceed/
    );
    // One millisecond more than the sum is enough, which is the boundary the error
    // is about rather than an arbitrary margin.
    assert.equal(
      loadConfig({ ...minimal, BRIDGE_VAD_SPEECH_WINDOW_MS: `${boundary + 1}` } as NodeJS.ProcessEnv)
        .vadSpeechWindowMs,
      boundary + 1
    );
  });

  it("refuses a floor ratio that is not a positive number", () => {
    assert.throws(
      () => loadConfig({ ...minimal, BRIDGE_VAD_FLOOR_RATIO: "0" } as NodeJS.ProcessEnv),
      /BRIDGE_VAD_FLOOR_RATIO/
    );
    assert.throws(
      () => loadConfig({ ...minimal, BRIDGE_VAD_FLOOR_RATIO: "twice" } as NodeJS.ProcessEnv),
      /BRIDGE_VAD_FLOOR_RATIO/
    );
  });

  it("still refuses a malformed value rather than falling back", () => {
    assert.throws(() => loadConfig({ ...minimal, BRIDGE_FRAMING: "4" } as NodeJS.ProcessEnv), /BRIDGE_FRAMING/);
    assert.throws(() => loadConfig({ ...minimal, WS_PORT: "0" } as NodeJS.ProcessEnv), /WS_PORT/);
    assert.throws(() => loadConfig({ ...minimal, OTA_PORT: "abc" } as NodeJS.ProcessEnv), /OTA_PORT/);
  });

  it("derives the device token but carries the platform's", () => {
    const config = loadConfig(minimal) as unknown as Record<string, unknown>;
    // No "token" field, and that absence is the design: a device token is
    // derived from the secret and the identifier rather than configured. The
    // platform's is the opposite — issued elsewhere, carried here unchanged.
    assert.equal("token" in config, false);
    assert.equal("deviceSecret" in config, true);
    assert.equal(config.apiAuthToken, PLATFORM);
  });
});

/**
 * The language and the engine, which decide together how a gadget sounds: the voice is
 * resolved from the pair and named by nobody here. Both are bound **per gadget** rather
 * than recorded once for the deployment, so both are read the way the persona is — one
 * `DEVICE=VALUE` per gadget — and a value that is not one the endpoint names is refused
 * rather than folded, for the reason the old deployment-wide readers refused to fold.
 */
describe("the language and engine bindings", () => {
  /** A deployment with one gadget, bound however the test wants it bound. */
  const bound = (language: string, engine: string) =>
    ({
      ...minimal,
      BRIDGE_ALLOWED_DEVICES: BOARD,
      BRIDGE_DEVICE_PERSONAS: `${BOARD}=interview-coach`,
      BRIDGE_DEVICE_LANGUAGES: `${BOARD}=${language}`,
      BRIDGE_DEVICE_ENGINES: `${BOARD}=${engine}`,
    }) as NodeJS.ProcessEnv;

  it("binds one language and one engine to each gadget", () => {
    const config = loadConfig(bound("vietnamese", "piper"));
    assert.equal(boundLanguage(config, BOARD), "vietnamese");
    assert.equal(boundEngine(config, BOARD), "piper");
  });

  it("reads the device half the way the allowlist reads its own", () => {
    // Separators and case are presentation, so a binding pasted beside the allowlist is
    // the same binding — which is what makes the cross-check exact rather than fuzzy.
    const config = loadConfig(bound("vietnamese", "piper"));
    assert.equal(boundLanguage(config, "b8:1f:3f:4a:9b:01"), "vietnamese");
    assert.equal(boundEngine(config, "B81F3F4A9B01"), "piper");
  });

  it("answers nothing for a gadget the deployment does not bind", () => {
    // Which a started bridge cannot have — the check below refuses to start without it
    // — and which is answered rather than defaulted, because a default here would be a
    // turn taken in a language nobody chose.
    const config = loadConfig(bound("vietnamese", "piper"));
    assert.equal(boundLanguage(config, "aa11bb22cc33"), undefined);
    assert.equal(boundEngine(config, "aa11bb22cc33"), undefined);
  });

  it("reads each of the engines and languages the endpoint accepts", () => {
    for (const engine of ["kokoro", "piper", "supertonic"] as const) {
      assert.equal(boundEngine(loadConfig(bound("english", engine)), BOARD), engine);
    }
    for (const language of ["english", "vietnamese"] as const) {
      assert.equal(boundLanguage(loadConfig(bound(language, "piper")), BOARD), language);
    }
  });

  it("refuses a language the endpoint does not name, naming the gadget it was bound to", () => {
    // The endpoint reads an absent or unknown language as English, so folding here too
    // would turn an operator's `vi` into a bridge that transcribes Vietnamese as English
    // and says nothing about it — the failure D12 describes.
    assert.throws(() => loadConfig(bound("vi", "piper")), /BRIDGE_DEVICE_LANGUAGES binds b81f3f4a9b01 to "vi"/);
    assert.throws(() => loadConfig(bound("Vietnamese", "piper")), /BRIDGE_DEVICE_LANGUAGES/);
  });

  it("refuses an engine the endpoint does not name, rather than folding to another", () => {
    // The endpoint folds an unrecognized engine to `"kokoro"`, which is why the field has
    // to be stated at all; folding here too would make a typo a different voice.
    assert.throws(() => loadConfig(bound("english", "xtts")), /BRIDGE_DEVICE_ENGINES binds b81f3f4a9b01 to "xtts"/);
    assert.throws(() => loadConfig(bound("english", "Supertonic")), /BRIDGE_DEVICE_ENGINES/);
  });

  it("refuses an entry with a side missing, as the persona list does", () => {
    const at = (name: string, value: string) => () =>
      loadConfig({ ...bound("english", "piper"), [name]: value } as NodeJS.ProcessEnv);
    assert.throws(at("BRIDGE_DEVICE_LANGUAGES", BOARD), /DEVICE=LANGUAGE/);
    assert.throws(at("BRIDGE_DEVICE_LANGUAGES", `${BOARD}=`), /names no language/);
    assert.throws(at("BRIDGE_DEVICE_ENGINES", `${BOARD}=`), /names no engine/);
    assert.throws(at("BRIDGE_DEVICE_ENGINES", `${BOARD}=piper,${BOARD}=kokoro`), /binds b81f3f4a9b01 twice/);
  });
});

/**
 * The pair, and the hand-over. A pair is the one thing in this file that is *not* a binding
 * every gadget needs: an unpaired deployment is every deployment but one, so what is checked
 * is that the two devices exist and that a deployment records one conversation rather than
 * two it has no shape for.
 */
describe("the pair two gadgets converse as", () => {
  const paired = (partners: string) =>
    ({
      ...minimal,
      BRIDGE_ALLOWED_DEVICES: `${BOARD},b81f3f4a9b02`,
      BRIDGE_DEVICE_PERSONAS: `${BOARD}=interview-coach,b81f3f4a9b02=custom-5`,
      ...speech(`${BOARD},b81f3f4a9b02`),
      BRIDGE_DEVICE_PARTNERS: partners,
    }) as NodeJS.ProcessEnv;

  it("pairs nothing when the deployment records none, which is every deployment but one", () => {
    const config = loadConfig(paired(""));
    assert.deepEqual(pairedGadgets(config), []);
    assert.equal(partnerOf(config, BOARD), undefined);
  });

  it("reads DEVICE=DEVICE, normalizing both halves as the allowlist does", () => {
    // Both halves are device ids, so both are normalized — and the relation is held both
    // ways round, because a reader asks who *this* gadget's partner is.
    const config = loadConfig(paired(`${BOARD}=B8-1F-3F-4A-9B-02`));
    assert.equal(partnerOf(config, BOARD), "b81f3f4a9b02");
    assert.equal(partnerOf(config, "b8:1f:3f:4a:9b:02"), "b81f3f4a9b01");
    assert.deepEqual(pairedGadgets(config), ["b81f3f4a9b01", "b81f3f4a9b02"]);
  });

  it("refuses a second pair, because a conversation is between two", () => {
    assert.throws(
      () => loadConfig(paired(`${BOARD}=b81f3f4a9b02,b81f3f4a9b02=${BOARD}`)),
      /records one pair/
    );
  });

  it("refuses a gadget paired with itself, which is one gadget and not two", () => {
    assert.throws(() => loadConfig(paired(`${BOARD}=${BOARD}`)), /with itself/);
  });

  it("refuses a partner the allowlist does not name", () => {
    // A gadget that may not connect cannot take part in a conversation, so a pair naming
    // one is configuration for something that could never happen.
    assert.throws(() => loadConfig(paired(`${BOARD}=aa11bb22cc33`)), /aa11bb22cc33 is not in/);
  });

  it("refuses an entry that is not DEVICE=DEVICE", () => {
    assert.throws(() => loadConfig(paired(BOARD)), /DEVICE=PARTNER/);
    assert.throws(() => loadConfig(paired(`${BOARD}=,b81f3f4a9b02`)), /names no partner/);
  });

  it("records the hand-over, and defaults it to four tenths of a second", () => {
    assert.equal(loadConfig(minimal).handoverMs, 400);
    assert.equal(loadConfig({ ...minimal, BRIDGE_HANDOVER_MS: "1200" }).handoverMs, 1200);
    assert.throws(() => loadConfig({ ...minimal, BRIDGE_HANDOVER_MS: "0" }), /BRIDGE_HANDOVER_MS/);
    assert.throws(() => loadConfig({ ...minimal, BRIDGE_HANDOVER_MS: "soon" }), /BRIDGE_HANDOVER_MS/);
  });
});

/**
 * The two settings this change retired. A setting that is no longer read is the one
 * configuration mistake that is invisible — the bridge starts, reports itself healthy,
 * and answers a Vietnamese gadget in English — so a leftover `.env` line is an error
 * rather than a harmless one, and the error names what replaced it.
 */
describe("the settings this change retired", () => {
  it("refuses a bridge that still records the deployment-wide language", () => {
    const stale = { ...minimal, BRIDGE_LANGUAGE: "vietnamese" } as NodeJS.ProcessEnv;
    assert.throws(() => loadConfig(stale), /BRIDGE_LANGUAGE is no longer read/);
    assert.throws(() => loadConfig(stale), /BRIDGE_DEVICE_LANGUAGES/);
  });

  it("refuses a bridge that still records the deployment-wide engine", () => {
    const stale = { ...minimal, BRIDGE_TURN_ENGINE: "piper" } as NodeJS.ProcessEnv;
    assert.throws(() => loadConfig(stale), /BRIDGE_TURN_ENGINE is no longer read/);
    assert.throws(() => loadConfig(stale), /BRIDGE_DEVICE_ENGINES/);
  });

  it("refuses an empty one too, because the line is what says the operator meant it", () => {
    assert.throws(() => loadConfig({ ...minimal, BRIDGE_LANGUAGE: "" } as NodeJS.ProcessEnv), /BRIDGE_LANGUAGE/);
  });

  it("starts without either, which is every deployment after the rebinding", () => {
    // An empty allowlist needs no bindings at all, so this is the smallest deployment
    // that loads: the three values with no default and nothing else.
    assert.doesNotThrow(() => loadConfig(minimal));
  });
});
