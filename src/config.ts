import { normalizeDeviceId } from "./credentials.js";
import { localIp } from "./net/local-ip.js";
import type { FramingVersion } from "./protocol/framing.js";
import type { TurnEngine, TurnLanguage } from "./turn.js";

/**
 * Everything the bridge reads from its environment, read once at start.
 *
 * Deliberately only what the service uses. A skeleton that accepts configuration
 * for features it does not have is a skeleton whose operator believes those
 * features are on; the platform's address is added by the task that first calls
 * it (3.1, the persona catalog), with the code that consumes it, and every later
 * platform call reuses it. The platform *credential* is held from 2.3 rather than
 * alongside that address, because keeping that secret on the bridge and off the
 * device is what 2.3 is about, not a later task's business.
 *
 * A malformed value throws rather than falling back: a bridge quietly listening
 * on a different port than the device was told is a bridge nobody can find.
 */
export interface BridgeConfig {
  /** Where the device asks for OTA. */
  otaPort: number;
  /** Where the device connects afterwards. */
  wsPort: number;
  /** The address named in the OTA response — one the device can route to. */
  publicHost: string;
  /**
   * The secret every device token is derived from (`credentials.ts`). It is the
   * one secret in this service that must never be on a device, and the whole of
   * what an attacker would need to connect as any device on the allowlist.
   */
  deviceSecret: string;
  /** The devices this bridge will issue a token to, normalized for comparison. */
  allowedDevices: string[];
  /**
   * Which persona each device speaks as, normalized Device-Id → persona id, read
   * from `BRIDGE_DEVICE_PERSONAS`. Every device the allowlist names is in here:
   * a device that may connect and has no persona could never be answered, so the
   * two lists are required to describe the same devices (see `requireBindings`).
   */
  devicePersonas: ReadonlyMap<string, string>;
  /**
   * Where the platform is, as a base URL with no trailing slash — the address
   * every server-to-server call is joined onto. Read from `BRIDGE_PLATFORM_URL`.
   */
  platformUrl: string;
  /**
   * The platform's own credential (`API_AUTH_TOKEN`), held so the bridge can
   * call the platform on a device's behalf. It is the other half of the boundary
   * `deviceSecret` starts: that one must never be on the platform, this one must
   * never be on a device, and nothing this service sends to a device reads it.
   */
  apiAuthToken: string;
  /** The binary framing version both directions use. */
  framing: FramingVersion;
  /** The sample rate the server declares it will send, in Hz. */
  serverRate: number;
  /** The frame length the server declares it will send, in ms. */
  frameMs: number;
  /**
   * How many earlier turns of a device's conversation its next turn carries. The
   * endpoint keeps no conversation of its own (D2), so the bridge holds one per
   * gadget — and holds no more than this (4.3).
   *
   * The platform trims this same history a second time, to its own
   * `VOICE_AGENT_MAX_HISTORY` exchanges, keeping the most recent. The default here
   * matches that one, so what the bridge sends is what the platform would have kept
   * anyway; raising one without the other only grows a request body that is about
   * to be cut. The platform also appends the current turn to what it is sent, so a
   * turn's history is one exchange shorter than this on the wire.
   */
  historyTurns: number;
  /**
   * The language each gadget is heard and answered in, by normalized Device-Id
   * (D12). The platform decodes the utterance in the language the turn names
   * rather than detecting one, and reads an absent value as English, so the
   * language is declared on every turn — and it is the **gadget's** rather than
   * the deployment's, so that two gadgets on one bridge can be heard in different
   * languages: a Vietnamese gadget whose turns omitted its language would
   * transcribe clean Vietnamese into a foreign script while looking, from the
   * bridge's side, exactly like one that was told to.
   *
   * Read from `BRIDGE_DEVICE_LANGUAGES`, one `DEVICE=VALUE` per gadget; a value
   * that is not one of the two words the endpoint accepts throws, because a typo
   * here fails silently in exactly the way above. Every gadget the allowlist names
   * is bound here, and the check is at start (`requireBindings`).
   */
  deviceLanguages: ReadonlyMap<string, TurnLanguage>;
  /**
   * The synthesis engine each gadget is spoken through, by normalized Device-Id —
   * the sibling of `deviceLanguages`, one field over. The *voice* is the platform's,
   * resolved from an engine and a language together, so what this decides is which
   * models a gadget's turns reach; two gadgets naming the same pair still sound
   * identical.
   *
   * Stated rather than left out, because leaving it out is **not** "no preference".
   * The endpoint folds an absent or unrecognized engine to `"kokoro"` *before* it
   * consults its own default, so a turn that dropped the field would ask for an
   * engine this deployment may never have chosen — and the platform's own
   * per-language fallback stays unreachable for as long as that fold is there.
   * Naming the engine is the only way to ask for another one.
   *
   * Read from `BRIDGE_DEVICE_ENGINES`, one `DEVICE=VALUE` per gadget; anything that
   * is not one of the three names the endpoint accepts throws, for the reason the
   * language throws: the endpoint's own fold would turn an operator's typo into a
   * different voice and say nothing about it. Every gadget the allowlist names is
   * bound here, and the check is at start (`requireBindings`).
   *
   * It was one setting for the deployment until one bridge ran two gadgets: the same
   * engine for every turn and every gadget, which is why the two of them sounded
   * alike however differently they were bound.
   *
   * What it does not do is check the engine against the language. The models a
   * deployment has installed are the platform's, and this service cannot know which
   * engine speaks which language without hardcoding another repository's facts
   * (design.md D5) — so that pairing is `.env.example`'s to state rather than this
   * service's to refuse.
   */
  deviceEngines: ReadonlyMap<string, TurnEngine>;
  /**
   * The one pair of gadgets that hold a conversation, each mapping to the other, or
   * empty (D7). Read from `BRIDGE_DEVICE_PARTNERS` as one `DEVICE=DEVICE` entry.
   *
   * A *relation* rather than a binding, which is why it is not read into the lists above
   * and not checked by `requireBindings`: every gadget the allowlist names must be bound
   * to a persona, a language and an engine, and no gadget has to be paired. What is
   * required is that both devices it names are in the allowlist — a gadget that may not
   * connect cannot take part in a conversation — and that a deployment records one pair,
   * because this service has no shape for a second conversation.
   *
   * Held both ways round, because every reader of it asks "who is this gadget's partner"
   * and nobody asks which side the deployment wrote.
   */
  devicePartners: ReadonlyMap<string, string>;
  /**
   * How long after the floor is free a prepared turn is released, in ms, read from
   * `BRIDGE_HANDOVER_MS` (D7).
   *
   * A feel rather than a measurement, like `commandStep` and `musicGainDb`: a tenth of a
   * second reads as a machine cutting in and four tenths is the top of a natural gap
   * between two people, and which of those a deployment wants is settled by listening.
   *
   * It is also the *whole* of the silence a person hears between the two gadgets, because
   * the partner's answer has been prepared while the other was still speaking (D3) — so
   * this one number is what the exchange's pace sounds like.
   */
  handoverMs: number;
  /**
   * How far one relative command moves a setting — "giảm âm lượng", "sáng hơn" —
   * in the units the setting is measured in, 0 to 100 (D6). Read from
   * `BRIDGE_COMMAND_STEP`.
   *
   * A configuration value rather than a constant in the matcher, for the reason
   * the endpointer's thresholds are: it is a feel. Ten points is a nudge a person
   * can hear and a screen a person can see, and whether it is the right nudge is
   * settled by ear rather than by argument — which is only possible if it is not
   * a literal in the code that would have to be rebuilt to try another.
   */
  commandStep: number;
  /**
   * How long a session may hold nobody before the bridge ends it, in ms. Read from
   * `BRIDGE_SESSION_IDLE_MS`; `0` turns the window off, which leaves a session open
   * for as long as the device keeps it open — how this bridge behaved before the
   * window existed, and the way back to that.
   *
   * A session is what the bridge ends and the device is left in: Idle, its
   * microphone closed and its wake word armed again. Held open, the device never
   * reaches that state, and `CanEnterSleepMode()` — which needs Idle, a closed audio
   * channel and an idle audio service together — can never be satisfied, so none of
   * the firmware's own power management can run. See `docs/vendor-server.md` for the
   * window the vendor server closes an idle session on.
   */
  sessionIdleMs: number;
  /**
   * Where this bridge's own music is, as a directory it lists when asked rather than at start.
   * Read from `BRIDGE_MUSIC_DIR`; empty means this deployment has no music at all, which is this
   * bridge before the change.
   *
   * A directory rather than a playlist, and read per request rather than at boot, so that a file
   * dropped in while the bridge runs is playable and a directory that is not there is an answer
   * — "nothing to play" — rather than a failure to start.
   *
   * Empty is not a degraded mode: with no directory the two commands go unrecognised and fall
   * through as ordinary utterances, and no tool of the bridge's own is offered to a model, so a
   * turn is asked for exactly as it was before any of this existed.
   */
  musicDir: string;
  /**
   * The level a track is played at, as a **difference** in dB from the file — negative for quieter,
   * and nought for the file as it is. Read from `BRIDGE_MUSIC_GAIN_DB`.
   *
   * The one knob in this file that may be negative or nought, because it is not a level: it is the
   * subtraction between two of them. The figure the requirement asks for is a measurement — a
   * track's RMS sits **10.4 dB** above the voice this deployment speaks with (three tracks in its
   * own library, six synthesis draws, 2026-10-12) — and playing music at that much less is what
   * leaves the person an opening to be heard over it.
   *
   * A setting rather than a constant, for the reason `commandStep` is one: whether the music is now
   * too quiet, or still too loud for the wake word to be heard over, is settled by ear and by
   * whether the wake word fires — and that is only possible if it is not a literal that would have
   * to be rebuilt to try another figure.
   *
   * **A deployment that sets nothing is not leaving things as they were.** The default is the
   * measured figure, so music plays about 10 dB quieter than it did before this existed; a
   * deployment that wants the previous level sets nought and knowingly leaves the requirement
   * unmet.
   */
  musicGainDb: number;
  /**
   * The rate the **device** encodes its uplink at, in Hz. Read from
   * `BRIDGE_DEVICE_RATE`; the firmware's own declaration is 16000.
   *
   * Not the same number as `serverRate`, and not interchangeable with it. The
   * hello declares `serverRate` for the downlink, and 24000 is a legal rate for
   * both — so a port that reused it here would build a decoder at the wrong rate
   * and fail in the one way that looks like a broken microphone: the sample count
   * is part of what an Opus packet is read as, so the frames would not decode at
   * all rather than decoding sharp (6.1).
   */
  deviceRate: number;
  /**
   * The endpointer, which is how the bridge knows the person has stopped speaking
   * (D9, 6.4). The firmware sends no `listen stop`, so nothing else will say.
   *
   * All five of these are one decision together, and the relation between them is
   * checked at start rather than left to an operator — see `requireEndpointer`.
   */
  /** The gate's absolute floor, in RMS. The quietest a frame may be and still be
   *  counted, until the room's own floor is estimated. */
  vadMinRms: number;
  /** How far above the room's estimated floor a frame must be to count. */
  vadFloorRatio: number;
  /** How much silence after speech closes the turn. */
  vadSilenceMs: number;
  /** How much speech a window must hold before a turn may close at all. */
  vadMinSpeechMs: number;
  /** The sliding window speech is counted over. */
  vadSpeechWindowMs: number;
  /** The longest turn, as a backstop for a person who never stops. */
  maxTurnMs: number;
  /** How long a window may hold no speech at all before it is given up on. */
  vadNoSpeechMs: number;
  /** How long after the bridge's own audio the device's microphone is distrusted,
   *  since the device reopens it before its speaker stops (D10, 6.6). */
  drainGuardMs: number;
  /** How much audio before the first voiced frame to keep, so a soft onset is not
   *  clipped off the utterance (6.1). */
  onsetLeadMs: number;
}

const PORT_MAX = 65535;

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be a positive integer at most ${max}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** A positive number, integral or not — the floor ratio is the one knob that is
 *  not a count of milliseconds, and a floor on it matters more than its width. */
function readNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** A count that may be nought.
 *
 *  `readInt` refuses nought, because for every count it reads nought is a mistake
 *  rather than a value. The session window is the one where nought means something —
 *  it is how the window is turned off — so it reads through this instead, where a
 *  negative is still refused and only nought is newly allowed. */
function readNonNegativeInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function readFraming(env: NodeJS.ProcessEnv): FramingVersion {
  const raw = env.BRIDGE_FRAMING;
  if (raw === undefined || raw === "") return 3;
  if (raw !== "1" && raw !== "2" && raw !== "3") {
    throw new Error(`BRIDGE_FRAMING must be 3, 2 or 1, got ${JSON.stringify(raw)}`);
  }
  return Number(raw) as FramingVersion;
}

/**
 * A gadget's language, as the endpoint's own two-word vocabulary. Not folded to
 * English the way the platform folds an unknown value, because that folding is the
 * failure D12 describes: an operator who typed `vi` would get a bridge that
 * transcribes Vietnamese as English and says nothing about it.
 */
function asLanguage(name: string, device: string, raw: string): TurnLanguage {
  if (raw !== "english" && raw !== "vietnamese") {
    throw new Error(`${name} binds ${device} to ${JSON.stringify(raw)}, which is not a language: english or vietnamese`);
  }
  return raw;
}

/**
 * A gadget's engine, as the endpoint's own three-word vocabulary — the same
 * validator as `asLanguage` above, one field over, and refusing to fold for the
 * same reason: the endpoint reads an unknown engine as `"kokoro"`, so folding here
 * too would turn a typo into a different voice with nothing in the log to say so.
 *
 * Neither reader has a default any more, and that is the change: a gadget that
 * named no engine used to speak through the deployment's, and now a gadget with no
 * binding is one the bridge refuses to start for (`requireBindings`).
 */
function asEngine(name: string, device: string, raw: string): TurnEngine {
  if (raw !== "kokoro" && raw !== "piper" && raw !== "supertonic") {
    throw new Error(`${name} binds ${device} to ${JSON.stringify(raw)}, which is not an engine: kokoro, piper or supertonic`);
  }
  return raw;
}

/**
 * The level a track is played at, as a difference in dB from the file.
 *
 * Signed, and the only reader here that accepts a negative or a nought: every other number in this
 * file is a level, a count or a duration, where a negative is a mistake, and this one is a
 * subtraction between two levels, where it is the ordinary case. What is still refused is a value
 * that is not a number at all, because a typo here would play the music at the wrong level in a way
 * nobody hears as a configuration mistake.
 */
function readMusicGainDb(env: NodeJS.ProcessEnv): number {
  const raw = env.BRIDGE_MUSIC_GAIN_DB;
  if (raw === undefined || raw === "") return MUSIC_GAIN_DB_DEFAULT;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`BRIDGE_MUSIC_GAIN_DB must be a number of dB, negative to play quieter, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * The level a track is played at when a deployment names none, in dB from the file.
 *
 * Exported so a test can assert against it rather than against a second copy of the number — the
 * same reason `ENDPOINTER_DEFAULTS` is: it is a measurement, and a figure written down twice is one
 * that drifts the first time it is re-measured.
 *
 * −10 dB is the measured difference between a track of this deployment's own library and the voice
 * it speaks with: a track's RMS sat 10.4 dB above a reply's (three tracks, six synthesis draws,
 * 2026-10-12). At −10 the music lands within half a decibel of a reply's RMS and 3.5 dB *below* a
 * reply's peak — one figure satisfying both measures, and erring on the quiet side on the one that
 * is about clipping, since two of the three tracks measured peaked at 0.0 dBFS.
 */
export const MUSIC_GAIN_DB_DEFAULT = -10;

/**
 * The secret is the only value with no default. A default here would be a
 * constant every deployment shares, which is exactly what the skeleton shipped
 * and what D6 records a finished bridge must not do — so a bridge without one
 * refuses to start, and says how to make one.
 */
function readDeviceSecret(env: NodeJS.ProcessEnv): string {
  const secret = env.BRIDGE_DEVICE_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    throw new Error(
      `BRIDGE_DEVICE_SECRET must be set, at least 32 characters, and never reused between deployments. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
    );
  }
  return secret;
}

/**
 * The platform's credential is required and has no default, for the reason the
 * device secret has none: a bridge that cannot authenticate to the platform
 * cannot serve a turn, and one that starts anyway only fails later, at the first
 * turn, where the cause is far from the symptom.
 *
 * There is deliberately no length rule. Unlike the device secret — which this
 * service generates, so it can insist on entropy — this token is issued by the
 * platform, and a short one is the platform's business rather than a reason for
 * this service to refuse to carry it. It is also returned exactly as read,
 * because the platform compares it byte for byte and a helpful trim would be a
 * credential that no longer works. Only a value that is nothing but whitespace
 * is treated as absent, since that is a mistake rather than a token.
 */
function readApiAuthToken(env: NodeJS.ProcessEnv): string {
  const token = env.API_AUTH_TOKEN ?? "";
  if (token.trim() === "") {
    throw new Error(
      "API_AUTH_TOKEN must be set: it is the platform's own credential, and the bridge is what calls the platform. " +
        "Copy it from adaptive-interview-api's .env — and never onto a device."
    );
  }
  return token;
}

/**
 * The allowlist. Empty is empty: a device is allowed because it is named, and a
 * bridge with nothing named lets nothing connect. Separators and case do not
 * distinguish devices — see `normalizeDeviceId`.
 */
function readAllowedDevices(env: NodeJS.ProcessEnv): string[] {
  const raw = env.BRIDGE_ALLOWED_DEVICES ?? "";
  const devices = raw
    .split(/[\s,;]+/)
    .map((entry) => normalizeDeviceId(entry))
    .filter((entry) => entry !== "");
  return [...new Set(devices)];
}

/**
 * Where the platform is. Required, and with no default, for a reason the port
 * defaults do not share: the ports are addresses *this* machine serves on, and
 * the flashed device expects them, but the platform's address is a property of
 * one deployment. A default would be localhost, which is right on a developer's
 * machine and silently wrong everywhere else — the bridge would come up, report
 * itself healthy, and reach nothing. A bridge that cannot reach the platform can
 * serve no turn at all, so this fails at start, where the operator is, rather
 * than at the first turn, where the symptom is far from the cause.
 *
 * Unlike the credential, trimming is harmless here: this is a URL this service
 * parses rather than a byte string the platform compares. Any trailing slashes
 * are dropped once, here, so joining a path is a plain concatenation and no call
 * site has to remember which of them is the odd one out.
 */
function readPlatformUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.BRIDGE_PLATFORM_URL ?? "";
  if (raw.trim() === "") {
    throw new Error(
      "BRIDGE_PLATFORM_URL must be set: it is where the bridge reaches adaptive-interview-api, " +
        'for example BRIDGE_PLATFORM_URL=http://127.0.0.1:4000. There is no default, because a ' +
        "default would point a deployment at whatever machine happened to be localhost."
    );
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(
      `BRIDGE_PLATFORM_URL must be an absolute URL like http://host:4000, got ${JSON.stringify(raw)}`
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`BRIDGE_PLATFORM_URL must be http or https, got ${JSON.stringify(raw)}`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(
      `BRIDGE_PLATFORM_URL must be a base URL without a query or fragment, got ${JSON.stringify(raw)}`
    );
  }
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

/**
 * One `DEVICE=VALUE` list, read the way all three are read.
 *
 * One binding per device because nothing a gadget is bound to may depend on a
 * lookup order: a gadget speaks as exactly one persona, hears and is answered in
 * exactly one language, and is spoken through exactly one engine, and a device that
 * could be either of two is a device whose character depends on which list was read
 * first. The separator is `=` rather than `:`, because a Device-Id is full of colons
 * — the value is whatever follows the first `=`. Entries are separated the way the
 * allowlist separates its own, and identifiers are normalized exactly as the
 * allowlist normalizes them, so a list can be pasted beside `BRIDGE_ALLOWED_DEVICES`
 * and still agree.
 *
 * `word` is the noun a value is called in the errors ("persona", "language"), so
 * that an operator reading one of them knows which list they are looking at.
 */
function readBindings(env: NodeJS.ProcessEnv, name: string, word: string): Map<string, string> {
  const raw = env[name] ?? "";
  const bindings = new Map<string, string>();
  for (const entry of raw.split(/[\s,;]+/).filter((part) => part !== "")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new Error(`${name} entries are DEVICE=${word.toUpperCase()}, got ${JSON.stringify(entry)}`);
    }
    const device = normalizeDeviceId(entry.slice(0, separator));
    const value = entry.slice(separator + 1).trim();
    if (device === "") {
      throw new Error(`${name} entry ${JSON.stringify(entry)} names no device`);
    }
    if (value === "") {
      throw new Error(`${name} entry ${JSON.stringify(entry)} names no ${word}`);
    }
    if (bindings.has(device)) {
      throw new Error(`${name} binds ${device} twice, and a device has one ${word}`);
    }
    bindings.set(device, value);
  }
  return bindings;
}

/**
 * The one pair of gadgets that converse (D7).
 *
 * Read through the same `DEVICE=VALUE` reader as every binding list, and then checked as a
 * *relation* rather than a binding: the value half is a device id and is normalized the
 * same way, at most one entry is allowed, both devices must be in the allowlist, and a
 * gadget is not its own partner. Nothing here is required of a gadget the allowlist names
 * — an unpaired deployment is every deployment but one.
 */
function readPartners(env: NodeJS.ProcessEnv, allowedDevices: string[]): Map<string, string> {
  const declared = readBindings(env, "BRIDGE_DEVICE_PARTNERS", "partner");
  if (declared.size === 0) return new Map();
  if (declared.size > 1) {
    throw new Error(
      `BRIDGE_DEVICE_PARTNERS records one pair, and this one records ${declared.size}: a ` +
        `conversation is between two gadgets, and this service has no shape for a second one`
    );
  }
  const [device, written] = [...declared][0]!;
  const partner = normalizeDeviceId(written);
  if (partner === "") {
    throw new Error(`BRIDGE_DEVICE_PARTNERS entry ${JSON.stringify(`${device}=${written}`)} names no partner`);
  }
  if (partner === device) {
    throw new Error(`BRIDGE_DEVICE_PARTNERS pairs ${device} with itself, which is one gadget and not two`);
  }
  for (const named of [device, partner]) {
    if (!allowedDevices.includes(named)) {
      throw new Error(
        `BRIDGE_DEVICE_PARTNERS pairs ${device} with ${partner}, and ${named} is not in ` +
          `BRIDGE_ALLOWED_DEVICES — a gadget that may not connect cannot take part in a conversation`
      );
    }
  }
  return new Map([
    [device, partner],
    [partner, device],
  ]);
}

/**
 * The lists have to describe the same devices, in both directions.
 *
 * A device the allowlist names with no binding could connect and then never be
 * served: it would handshake, and every turn would fail for a reason that is in
 * configuration while looking like a device fault — and there are three bindings it
 * can now be missing, so the error names the kind rather than only the device. A
 * binding for a device the allowlist does not name is configuration for something
 * that can never connect, which is nearly always a typo in one of the identifiers.
 * Both are refused at start, where the operator is, rather than at the first turn.
 */
function requireBindings(allowedDevices: string[], lists: ReadonlyArray<{ what: string; bindings: ReadonlyMap<string, string> }>): void {
  const missing: string[] = [];
  for (const device of allowedDevices) {
    const kinds = lists.filter(({ bindings }) => !bindings.has(device)).map(({ what }) => what);
    if (kinds.length > 0) missing.push(`${device} has no binding for ${kinds.join(", ")}`);
  }
  if (missing.length > 0) {
    throw new Error(
      `every device in BRIDGE_ALLOWED_DEVICES must be bound in every list: ${missing.join("; ")}`
    );
  }
  const strangers = new Set<string>();
  for (const { bindings } of lists) {
    for (const device of bindings.keys()) {
      if (!allowedDevices.includes(device)) strangers.add(device);
    }
  }
  if (strangers.size > 0) {
    throw new Error(
      `${[...strangers].join(", ")} ${strangers.size === 1 ? "is bound" : "are bound"}, which ` +
        `BRIDGE_ALLOWED_DEVICES does not name, so no turn could ever be served for it — check the ` +
        `identifier in every list`
    );
  }
}

/**
 * The endpointer's shipped defaults, and the only copy of them.
 *
 * Exported so a test can build a config that is a deployment's in every respect it
 * does not care about, without spelling out ten numbers that would then drift from
 * these the first time one of them moved. The rig's own defaults, measured on the
 * board this service was built for: 7500 RMS against a room floor of about 3000 is
 * the gate that separated a person from the device's own speaker.
 */
export const ENDPOINTER_DEFAULTS = {
  /** The firmware declares 16000 Hz Opus mono upward; the hello's 24000 is the
   *  downlink and is a different number (6.1). */
  deviceRate: 16000,
  vadMinRms: 7500,
  vadFloorRatio: 2.5,
  vadSilenceMs: 900,
  /** How much speech makes a sound an utterance rather than furniture — a door, a
   *  chair, the case being set down. Measured over the 37 turns on record: every
   *  trigger the platform answered as noise needed 8 frames or fewer, and every one it
   *  answered with a full sentence needed 9 or more. The test is `>=` against speech
   *  accumulated over `vadSpeechWindowMs`, so the band that excludes exactly the 8-frame
   *  group is (480, 540) at 60 ms frames; 500 is the readable value inside it, and 480
   *  is not — `480 >= 480` still closes a turn. */
  vadMinSpeechMs: 500,
  vadSpeechWindowMs: 3000,
  maxTurnMs: 20000,
  vadNoSpeechMs: 15000,
  drainGuardMs: 400,
  onsetLeadMs: 300,
} as const;

/**
 * The one relation between the endpointer's knobs, checked at start (6.4).
 *
 * Speech is counted over a **sliding** window. If the window is no longer than the
 * silence threshold plus the speech minimum, the frames that satisfied the speech
 * minimum have already aged out of the window by the time the silence threshold is
 * reached — so neither condition can ever hold at once and a turn can never close.
 * The rig has the same relation and only warns about it, in a comment that names
 * its own failure as silent: "the rig just waits forever". A bridge cannot be left
 * in that state by a typo, so this throws.
 */
function requireEndpointer(config: {
  vadSilenceMs: number;
  vadMinSpeechMs: number;
  vadSpeechWindowMs: number;
}): void {
  if (config.vadSpeechWindowMs <= config.vadSilenceMs + config.vadMinSpeechMs) {
    throw new Error(
      `BRIDGE_VAD_SPEECH_WINDOW_MS must exceed BRIDGE_VAD_SILENCE_MS + BRIDGE_VAD_MIN_SPEECH_MS ` +
        `(${config.vadSilenceMs} + ${config.vadMinSpeechMs}), got ${config.vadSpeechWindowMs}: ` +
        `speech ages out of the window before the silence threshold is reached, and no turn could ever close`
    );
  }
}

/**
 * The two settings this change retires, refused wherever they are still recorded.
 *
 * A setting that is no longer read is the one class of configuration mistake that is
 * invisible: the bridge starts, reports itself healthy, and answers a Vietnamese
 * gadget in English. So a leftover `.env` line is an error rather than a harmless
 * one — an empty line too, because the line is what says the operator believes it
 * does something.
 *
 * Deliberately narrow: this service does not audit its environment for names it does
 * not know, and will not. What it refuses is exactly the two names that used to be
 * read and are not any more.
 */
function refuseRetired(env: NodeJS.ProcessEnv): void {
  const retired: ReadonlyArray<{ name: string; instead: string }> = [
    { name: "BRIDGE_LANGUAGE", instead: "BRIDGE_DEVICE_LANGUAGES, one DEVICE=english|vietnamese per gadget" },
    { name: "BRIDGE_TURN_ENGINE", instead: "BRIDGE_DEVICE_ENGINES, one DEVICE=kokoro|piper|supertonic per gadget" },
  ];
  for (const { name, instead } of retired) {
    if (env[name] === undefined) continue;
    throw new Error(
      `${name} is no longer read: the language and the engine are bound per gadget now, so bind every ` +
        `gadget in ${instead}, and remove ${name}`
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  // The settings this change retired are refused before anything else is read: a
  // deployment that still records one has to hear about it now rather than after a
  // gadget has been answered in the wrong language (`refuseRetired`).
  refuseRetired(env);

  // The four device lists are read and cross-checked first, so bindings that
  // cannot work are reported even when some later value is wrong too.
  const allowedDevices = readAllowedDevices(env);
  const devicePersonas = readBindings(env, "BRIDGE_DEVICE_PERSONAS", "persona");
  const languages = readBindings(env, "BRIDGE_DEVICE_LANGUAGES", "language");
  const engines = readBindings(env, "BRIDGE_DEVICE_ENGINES", "engine");
  requireBindings(allowedDevices, [
    { what: "persona", bindings: devicePersonas },
    { what: "language", bindings: languages },
    { what: "engine", bindings: engines },
  ]);
  // The vocabulary each binding's value has to be in, checked per entry so the
  // error names the gadget the operator mistyped rather than only the setting.
  const deviceLanguages = new Map(
    [...languages].map(([device, raw]) => [device, asLanguage("BRIDGE_DEVICE_LANGUAGES", device, raw)])
  );
  const deviceEngines = new Map(
    [...engines].map(([device, raw]) => [device, asEngine("BRIDGE_DEVICE_ENGINES", device, raw)])
  );
  // Read after the allowlist and checked against it, because a pair is a relation between
  // two gadgets rather than a binding every gadget needs (D7).
  const devicePartners = readPartners(env, allowedDevices);

  // Read together, because they are one decision, and checked together before the
  // rest of the service is built: an endpointer that can never close a turn is a
  // gadget that never answers, and that is not something to discover from silence.
  const endpointer = {
    deviceRate: readInt(env, "BRIDGE_DEVICE_RATE", ENDPOINTER_DEFAULTS.deviceRate),
    vadMinRms: readInt(env, "BRIDGE_VAD_MIN_RMS", ENDPOINTER_DEFAULTS.vadMinRms),
    vadFloorRatio: readNumber(env, "BRIDGE_VAD_FLOOR_RATIO", ENDPOINTER_DEFAULTS.vadFloorRatio),
    vadSilenceMs: readInt(env, "BRIDGE_VAD_SILENCE_MS", ENDPOINTER_DEFAULTS.vadSilenceMs),
    vadMinSpeechMs: readInt(env, "BRIDGE_VAD_MIN_SPEECH_MS", ENDPOINTER_DEFAULTS.vadMinSpeechMs),
    vadSpeechWindowMs: readInt(env, "BRIDGE_VAD_SPEECH_WINDOW_MS", ENDPOINTER_DEFAULTS.vadSpeechWindowMs),
    maxTurnMs: readInt(env, "BRIDGE_MAX_TURN_MS", ENDPOINTER_DEFAULTS.maxTurnMs),
    vadNoSpeechMs: readInt(env, "BRIDGE_VAD_NO_SPEECH_MS", ENDPOINTER_DEFAULTS.vadNoSpeechMs),
    drainGuardMs: readInt(env, "BRIDGE_DRAIN_GUARD_MS", ENDPOINTER_DEFAULTS.drainGuardMs),
    onsetLeadMs: readInt(env, "BRIDGE_ONSET_LEAD_MS", ENDPOINTER_DEFAULTS.onsetLeadMs),
  };
  requireEndpointer(endpointer);

  return {
    otaPort: readInt(env, "OTA_PORT", 8003, PORT_MAX),
    wsPort: readInt(env, "WS_PORT", 8000, PORT_MAX),
    publicHost: localIp(env.BRIDGE_PUBLIC_HOST),
    deviceSecret: readDeviceSecret(env),
    allowedDevices,
    devicePersonas,
    platformUrl: readPlatformUrl(env),
    apiAuthToken: readApiAuthToken(env),
    framing: readFraming(env),
    // 24000 Hz is the platform's measured TTS output rate and a legal Opus rate;
    // it is also the firmware's own default, so neither side resamples.
    serverRate: readInt(env, "BRIDGE_SERVER_RATE", 24000),
    frameMs: readInt(env, "BRIDGE_FRAME_MS", 60),
    historyTurns: readInt(env, "BRIDGE_HISTORY_TURNS", 20),
    deviceLanguages,
    deviceEngines,
    devicePartners,
    // Four tenths of a second: the top of a natural gap between two people, and quiet
    // enough that a shorter one is a thing to listen for rather than assume (D7).
    handoverMs: readInt(env, "BRIDGE_HANDOVER_MS", 400),
    // Not bounded to 100: the range a setting is clamped to is the range the
    // gadget's own tool declares (D6), and this is only how far one command moves
    // it. A step past the end of that range lands on the end, which is a legal
    // outcome rather than a mistake to refuse.
    commandStep: readInt(env, "BRIDGE_COMMAND_STEP", 10),
    // Sixty seconds is the vendor server's own window, measured on 2026-10-10 at
    // 60 s from the session hello — a figure this deployment had already been
    // living with before its OTA was pointed here, so nothing about a gadget's
    // behaviour changes by adopting it.
    sessionIdleMs: readNonNegativeInt(env, "BRIDGE_SESSION_IDLE_MS", 60000),
    // Empty, and unset is empty: music is something a deployment opts into, and a shipped
    // non-empty default would point every bridge at a directory that is not there on any of them.
    musicDir: (env.BRIDGE_MUSIC_DIR ?? "").trim(),
    musicGainDb: readMusicGainDb(env),
    ...endpointer,
  };
}

/**
 * What a gadget is bound to, by the identifier the allowlist normalizes to.
 *
 * `undefined` is a gadget the deployment does not bind — which a *started* bridge
 * cannot have (`requireBindings`) — and it is returned rather than defaulted,
 * because the alternative is answering a gadget in a language nobody chose. A caller
 * that meets it reports the turn as not served, the way a gadget bound to a persona
 * the catalog does not report is reported (`conversation.ts`).
 */
export function boundLanguage(config: BridgeConfig, deviceId: string): TurnLanguage | undefined {
  return config.deviceLanguages.get(normalizeDeviceId(deviceId));
}

export function boundEngine(config: BridgeConfig, deviceId: string): TurnEngine | undefined {
  return config.deviceEngines.get(normalizeDeviceId(deviceId));
}

/**
 * Who a gadget converses with, or nothing where the deployment pairs none (D8).
 *
 * `undefined` is the case every deployment but a two-gadget one is in, and it is what each
 * path this change adds is gated on — a bridge that pairs nothing reaches none of them.
 */
export function partnerOf(config: BridgeConfig, deviceId: string): string | undefined {
  return config.devicePartners.get(normalizeDeviceId(deviceId));
}

/**
 * The two gadgets a deployment paired, in the order the deployment wrote them, or nothing.
 *
 * The pair's own list rather than its devices, because the one place that prints it wants
 * the two of them named once, and the map holds both directions of the same relation.
 */
export function pairedGadgets(config: BridgeConfig): string[] {
  return [...new Set(config.devicePartners.keys())];
}

/**
 * The pair a gadget is bound to, as one word for a line an operator reads:
 * `vietnamese/piper`.
 *
 * Read through the lookups above, so a line saying it and a turn declaring it can only
 * disagree if the binding changed between them. Where a binding is missing it says that
 * rather than naming a language, which a started bridge cannot reach (`requireBindings`)
 * and which a default would otherwise disguise as a pair nobody chose.
 */
export function describeBinding(config: BridgeConfig, deviceId: string): string {
  const language = boundLanguage(config, deviceId);
  const engine = boundEngine(config, deviceId);
  return language === undefined || engine === undefined
    ? "no language or engine bound"
    : `${language}/${engine}`;
}
