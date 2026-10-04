import type { BridgeConfig } from "./config.js";
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
 * A cache, and for now nothing more: 3.1 reads the catalog once at start, and
 * the lookup a device's binding needs is 3.2, with the re-read on a missed
 * identifier in 3.3. Both belong here rather than at a call site, because this
 * is what owns the cached copy.
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
