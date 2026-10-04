import type { BridgeConfig } from "./config.js";
import { normalizeDeviceId } from "./credentials.js";
import { platformAuthHeaders } from "./platform.js";

/**
 * The persona catalog: fetched from the platform, validated once, and cached.
 *
 * The platform's catalog is the authority on what a persona is — its prompt, the
 * topics that scope its material, and how its replies are produced — and the
 * bridge holds none of that itself (D5). So the bridge reads the catalog and
 * keeps it, and every later task resolves a device's binding against this cache
 * rather than inventing a persona or shipping one as configuration.
 *
 * Everything here is strict on purpose. The five fields are taken and checked
 * one by one, and a payload that does not match is an error rather than a
 * best-effort read: the alternative is a bridge that serves a turn under half a
 * persona, which is a wrong answer that looks like a right one. The platform's
 * route is one query over one table and always reports the same six fields in
 * the same shape, so a surprise here means the contract moved, and the place to
 * find that out is a log line at start rather than a turn that reads oddly.
 *
 * The one field deliberately not taken is `emoji`. The bridge renders nothing
 * (D8) — it relays text and leaves every drawing decision to the device's
 * firmware — so a field that exists to be drawn has no consumer here, and
 * carrying it would be carrying something the service never reads.
 */

/** How a persona's replies are produced: by the model, or by reading the
 * material its topics scope. The platform folds every other stored value to
 * `"generate"` before it reports it, so these two are the whole vocabulary. */
export type AnswerMode = "generate" | "material";

/** One persona, as the bridge holds it: the platform's fields this service uses. */
export interface Persona {
  id: string;
  label: string;
  /** May be empty. A persona without a prompt is a refusal the bridge must
   * handle rather than a catalog the bridge should reject (4.4). */
  defaultPrompt: string;
  knowledgeTopics: string[];
  answerMode: AnswerMode;
}

/**
 * The three fields a persona contributes to a turn, named as the platform names
 * them on the request (`POST /api/voice-agent/stream`).
 *
 * The renaming happens here and nowhere else: `defaultPrompt` becomes
 * `systemPrompt`, `knowledgeTopics` becomes `enabledTopics`, and `answerMode` is
 * carried under its own name. Which of them come from the persona and which from
 * the device is the whole of 3.5, and the short version is that all three come
 * from the persona — a device contributes its identity, never its character.
 *
 * `enabledTopics` is not "topics this persona may discuss" in some abstract
 * sense. The platform folds each label to the collections that scope the turn's
 * search, so the catalog's `knowledgeTopics` labels are exactly what the turn
 * wants, under the platform's other name for them — and a label that folds to no
 * collection is a search the turn does not make, which is the platform's
 * behaviour and not something to fix by guessing a name here.
 */
export interface TurnPersonaFields {
  systemPrompt: string;
  enabledTopics: string[];
  answerMode: AnswerMode;
}

/**
 * A persona as the fields a turn carries. A copy, never the cached object: the
 * cache is shared by every device, and a turn that mutated the persona it was
 * handed would change what the next device's turn says.
 *
 * An empty `defaultPrompt` is carried through as empty rather than filled with
 * something. The platform refuses such a turn ("systemPrompt is required"), and
 * a persona without a prompt is a refusal the bridge has to relay as one (4.4);
 * inventing a prompt here would answer as a character the platform never
 * configured.
 */
export function turnFieldsFor(persona: Persona): TurnPersonaFields {
  return {
    systemPrompt: persona.defaultPrompt,
    enabledTopics: [...persona.knowledgeTopics],
    answerMode: persona.answerMode,
  };
}

/** The catalog route, relative to the platform base URL. */
const CATALOG_PATH = "/api/personas";

/**
 * A read that never returns is worse than one that fails: a start-up fetch with
 * no deadline leaves a bridge that is up, logged nothing, and holds no personas,
 * with nothing to say which of those is true. Ten seconds is far longer than the
 * route takes and short enough that an operator notices.
 */
const CATALOG_TIMEOUT_MS = 10_000;

function readPersona(raw: unknown, index: number): Persona {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`personas[${index}] must be an object`);
  }
  const entry = raw as Record<string, unknown>;

  const id = entry.id;
  if (typeof id !== "string" || id === "") {
    throw new Error(`personas[${index}].id must be a non-empty string, got ${JSON.stringify(entry.id)}`);
  }

  const label = entry.label;
  if (typeof label !== "string") {
    throw new Error(`persona ${id}: label must be a string, got ${JSON.stringify(label)}`);
  }

  const defaultPrompt = entry.defaultPrompt;
  if (typeof defaultPrompt !== "string") {
    throw new Error(`persona ${id}: defaultPrompt must be a string, got ${JSON.stringify(defaultPrompt)}`);
  }

  const knowledgeTopics = entry.knowledgeTopics;
  if (!Array.isArray(knowledgeTopics) || knowledgeTopics.some((topic) => typeof topic !== "string")) {
    throw new Error(`persona ${id}: knowledgeTopics must be an array of strings`);
  }

  const answerMode = entry.answerMode;
  if (answerMode !== "generate" && answerMode !== "material") {
    throw new Error(
      `persona ${id}: answerMode must be "generate" or "material", got ${JSON.stringify(answerMode)}`
    );
  }

  return { id, label, defaultPrompt, knowledgeTopics: [...knowledgeTopics] as string[], answerMode };
}

/** The whole payload as personas, or an error naming what did not match. */
export function parseCatalog(payload: unknown): Persona[] {
  if (!Array.isArray(payload)) {
    throw new Error(`the persona catalog must be an array, got ${typeof payload}`);
  }
  const personas = payload.map(readPersona);
  // A duplicate identifier would make the cache's key ambiguous — two personas,
  // one binding, and which of them answers depends on read order. The catalog is
  // keyed by identifier in the platform's own database, so this cannot happen
  // without something having gone wrong, and this is where that shows up.
  const seen = new Set<string>();
  for (const persona of personas) {
    if (seen.has(persona.id)) throw new Error(`the persona catalog reports ${persona.id} twice`);
    seen.add(persona.id);
  }
  return personas;
}

/**
 * Read the catalog from the platform.
 *
 * The request goes through `platformAuthHeaders`, which is the one place the
 * platform's credential becomes a request (2.3). The token is in the header and
 * nowhere else — not in the URL, not in a log line, and not in an error: every
 * message this function can throw names the path and the status and nothing the
 * platform sent.
 */
export async function fetchCatalog(config: BridgeConfig): Promise<Persona[]> {
  const response = await fetch(`${config.platformUrl}${CATALOG_PATH}`, {
    headers: platformAuthHeaders(config),
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GET ${CATALOG_PATH} answered ${response.status} ${response.statusText}`);
  }
  return parseCatalog(await response.json());
}

/** The catalog as the service holds it between reads. */
export interface PersonaCatalog {
  /** Re-read the platform's catalog, replacing what is cached, and report it. */
  refresh(): Promise<Persona[]>;
  /** The catalog as it was last read, in the order the platform reports it. */
  all(): readonly Persona[];
}

/**
 * A cache, and for now nothing more: 3.1 reads the catalog once at start and
 * every lookup goes through it, and the re-read on a binding it does not hold is
 * 3.3. The lookup itself lives here too (`boundPersona`), rather than at a call
 * site, because this is what owns the cached copy.
 */
export function createPersonaCatalog(config: BridgeConfig): PersonaCatalog {
  let cached: Persona[] = [];
  return {
    async refresh(): Promise<Persona[]> {
      cached = await fetchCatalog(config);
      return cached;
    },
    all(): readonly Persona[] {
      return cached;
    },
  };
}

/**
 * The persona a device is bound to, as the catalog reports it — or nothing.
 *
 * Nothing is a real answer, not an error, and it is deliberately not a fallback.
 * The requirement is that a gadget bound to an identifier the catalog does not
 * report SHALL NOT be answered as a different persona, so a lookup that picked a
 * default, or the first entry, would be the exact behaviour the requirement
 * forbids; the miss is the whole point of returning `undefined`. The caller
 * decides what a miss means, and 3.3 makes it "re-read the catalog, then decline
 * if it still does not report it".
 *
 * A miss is ordinary, not exceptional: the binding is configuration and the
 * catalog is live, so a persona added on the platform while the bridge is
 * running is a miss until the next read, and one deleted is a binding that will
 * never resolve again.
 */
export function boundPersona(personaId: string, personas: readonly Persona[]): Persona | undefined {
  return personas.find((persona) => persona.id === personaId);
}

/**
 * Every binding the catalog does not currently report, as [device, persona id].
 *
 * Read at start so that a deployment hears about a binding that resolves to
 * nothing where the operator is, rather than at a turn. It is a warning and not a
 * refusal, because the catalog is live and the bridge's read is one moment of it:
 * refusing to start would make a momentarily stale read — or a persona being
 * added right after the bridge — a reason for the service to be down. The
 * devices are normalized identifiers, as the config stores them.
 */
export function unresolvedBindings(
  devicePersonas: ReadonlyMap<string, string>,
  personas: readonly Persona[]
): Array<[string, string]> {
  return [...devicePersonas].filter(([, personaId]) => boundPersona(personaId, personas) === undefined);
}

/**
 * Why a device's turn could not be answered as anyone. Three ways, and the
 * distinction is the point: they are different faults with different causes, and
 * an operator reading one line has to be able to tell which they have.
 */
export type PersonaMissReason =
  /** Configuration names a device with no persona. The loader refuses this at
   * start (see `requireBindings`), so reaching it means a config assembled
   * elsewhere — and it is still a refusal rather than a default. */
  | "no-binding"
  /** The catalog was re-read and still does not report the identifier. */
  | "not-in-catalog"
  /** The catalog could not be read, so the miss is unproven: the identifier may
   * well be there. Reported as its own reason rather than as "not in catalog",
   * because the operator's next move is different — fix the platform, not the
   * binding. */
  | "catalog-unreachable";

export type PersonaResolution =
  | {
      ok: true;
      persona: Persona;
      /** True when the cache did not report it and a fresh read supplied it. */
      reRead: boolean;
    }
  | { ok: false; reason: PersonaMissReason; detail: string };

/**
 * The persona a device's turn is answered as — from the cache, and from a fresh
 * read if the cache does not report it (3.3).
 *
 * The re-read is the requirement, not an optimisation: a persona added or renamed
 * on the platform after the bridge last read would otherwise be a device that
 * cannot speak until someone restarts the service. So a miss costs one catalog
 * read before it is treated as a miss, and only a read that still does not report
 * the identifier declines the turn (3.4).
 *
 * A miss is re-read every time it happens, rather than once and then remembered.
 * A device bound to an identifier that is gone is therefore one platform request
 * per turn it takes — which is the price of the other case, a persona added
 * mid-session, resolving without a restart. Turns are seconds apart and devices
 * are few; a cache of misses would trade that price for a delay nobody can
 * explain later.
 *
 * A failed re-read is reported as itself and never as "not in catalog": the
 * identifier may well be there, and the operator should be sent to the platform
 * rather than to the binding. It also leaves the cache as the last good read —
 * `refresh` replaces only on success — so the personas the bridge did know are
 * still there for every other device.
 */
export async function resolveBoundPersona(
  catalog: PersonaCatalog,
  config: BridgeConfig,
  deviceId: string
): Promise<PersonaResolution> {
  // Normalized here as well as in the loader, for the reason `isAllowedDevice`
  // normalizes both sides: the comparison the binding means is between normalized
  // identifiers, and a caller holding the raw header would otherwise get a miss
  // for a device that is named — which reads as a configuration fault and is not.
  const personaId = config.devicePersonas.get(normalizeDeviceId(deviceId));
  if (personaId === undefined) {
    return {
      ok: false,
      reason: "no-binding",
      detail: `device ${deviceId} is not bound to a persona in BRIDGE_DEVICE_PERSONAS`,
    };
  }

  const cached = boundPersona(personaId, catalog.all());
  if (cached !== undefined) return { ok: true, persona: cached, reRead: false };

  let fresh: readonly Persona[];
  try {
    fresh = await catalog.refresh();
  } catch (error) {
    return {
      ok: false,
      reason: "catalog-unreachable",
      detail: `device ${deviceId} is bound to ${personaId}, the cache does not report it, and the ` +
        `catalog could not be re-read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const found = boundPersona(personaId, fresh);
  if (found !== undefined) return { ok: true, persona: found, reRead: true };

  return {
    ok: false,
    reason: "not-in-catalog",
    detail: `device ${deviceId} is bound to ${personaId}, which the catalog does not report even ` +
      `after a fresh read (${fresh.length} persona(s) read)`,
  };
}

/**
 * The refusal as one line an operator can act on, naming the device and the
 * identifier so it can be found in configuration without reading the code (3.4).
 * The detail already carries both; this is the shape the log uses, kept here so
 * the wording is owned in one place rather than assembled at a call site.
 */
export function describePersonaMiss(deviceId: string, resolution: Extract<PersonaResolution, { ok: false }>): string {
  return `no persona for ${deviceId} (${resolution.reason}): ${resolution.detail}`;
}
