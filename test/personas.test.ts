import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { BridgeConfig } from "../src/config.js";
import { createPersonaCatalog, fetchCatalog, parseCatalog } from "../src/personas.js";

/**
 * The catalog is the platform's, and the bridge is strict about reading it.
 *
 * Two halves. The payload is checked field by field, because the alternative to
 * refusing a surprise is serving a turn under half a persona — a wrong answer
 * that looks like a right one. And the request is checked to go to the catalog
 * route with the platform's credential and nothing else, which is where 3.1
 * first exercises the boundary 2.3 built.
 *
 * The stub platform is a real HTTP server rather than a mocked `fetch`, for the
 * reason the OTA tests start a real one: what is being pinned is the request that
 * leaves this process, and a mock would only report what it was told to expect.
 */
const PLATFORM = "platform-token-abcdefgh";

function configFor(platformUrl: string): BridgeConfig {
  return {
    otaPort: 0,
    wsPort: 0,
    publicHost: "127.0.0.1",
    deviceSecret: "s".repeat(43),
    allowedDevices: ["b81f3f4a9b01"],
    platformUrl,
    apiAuthToken: PLATFORM,
    framing: 3,
    serverRate: 24000,
    frameMs: 60,
  };
}

/** Two entries in the platform's shape — six fields, one of which is dropped. */
const CATALOG = [
  {
    id: "language-partner",
    label: "Language Partner",
    emoji: "\u{1f5e3}",
    defaultPrompt: "You are a patient language partner.",
    knowledgeTopics: ["Truyện cười"],
    answerMode: "generate",
  },
  {
    id: "interview-coach",
    label: "Interview Coach",
    emoji: "\u{1f3af}",
    defaultPrompt: "",
    knowledgeTopics: [],
    answerMode: "material",
  },
];

/** A platform that answers what it is told, and records what it was asked. */
async function stubPlatform(respond: (path: string) => { status: number; body: unknown }) {
  const seen: { path: string; authorization: string | undefined }[] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", authorization: req.headers.authorization });
    const { status, body } = respond(req.url ?? "");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  // 127.0.0.1 rather than "localhost": the name resolves to ::1 first here, and a
  // stub bound to IPv4 would be a connection refused that looks like a bug.
  if (!server.address()) await once(server, "listening");
  return {
    seen,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop() {
      server.closeAllConnections();
      server.close();
    },
  };
}

describe("the catalog payload", () => {
  it("takes the five fields the bridge uses, and no more", () => {
    const [persona] = parseCatalog(CATALOG);
    assert.deepEqual(Object.keys(persona).sort(), [
      "answerMode",
      "defaultPrompt",
      "id",
      "knowledgeTopics",
      "label",
    ]);
    assert.equal("emoji" in persona, false, "the bridge renders nothing, so the field is not carried (D8)");
    assert.equal(persona.id, "language-partner");
    assert.equal(persona.answerMode, "generate");
  });

  it("accepts a persona with no prompt and no topics", () => {
    // Not a malformed entry to reject: 4.4 forces a refusal with a persona that
    // has no prompt, so refusing the shape here would make that case unbuildable.
    const [persona] = parseCatalog([
      { id: "empty", label: "", defaultPrompt: "", knowledgeTopics: [], answerMode: "material" },
    ]);
    assert.equal(persona.defaultPrompt, "");
    assert.deepEqual(persona.knowledgeTopics, []);
    assert.equal(persona.answerMode, "material");
  });

  it("refuses a payload that is not an array", () => {
    assert.throws(() => parseCatalog({ personas: CATALOG }), /must be an array/);
    assert.throws(() => parseCatalog(null), /must be an array/);
  });

  it("refuses an entry that is not an object", () => {
    assert.throws(() => parseCatalog(["language-partner"]), /personas\[0\] must be an object/);
    assert.throws(() => parseCatalog([[]]), /personas\[0\] must be an object/);
  });

  it("names the field of the entry that did not match", () => {
    const entry = (over: Record<string, unknown>) => [
      { id: "p", label: "P", defaultPrompt: "x", knowledgeTopics: [], answerMode: "generate", ...over },
    ];
    assert.throws(() => parseCatalog(entry({ id: "" })), /id must be a non-empty string/);
    assert.throws(() => parseCatalog(entry({ label: 3 })), /persona p: label must be a string/);
    assert.throws(() => parseCatalog(entry({ defaultPrompt: null })), /defaultPrompt must be a string/);
    assert.throws(() => parseCatalog(entry({ knowledgeTopics: "Truyện cười" })), /array of strings/);
    assert.throws(() => parseCatalog(entry({ knowledgeTopics: [1] })), /array of strings/);
    assert.throws(
      () => parseCatalog([{ id: "p", label: "P", defaultPrompt: "x", knowledgeTopics: [] }]),
      /answerMode must be "generate" or "material"/
    );
  });

  it("refuses an answer mode it does not know rather than folding it", () => {
    // The platform already folds every stored value to one of the two before it
    // reports, so an unknown one means the contract moved. Defaulting to
    // "generate" would answer under a mode nothing chose, and silently.
    assert.throws(
      () => parseCatalog([{ id: "p", label: "P", defaultPrompt: "x", knowledgeTopics: [], answerMode: "reading" }]),
      /answerMode must be "generate" or "material"/
    );
  });

  it("refuses a catalog that reports one identifier twice", () => {
    // The cache is keyed by identifier, so a duplicate would make which persona
    // answers depend on read order.
    assert.throws(() => parseCatalog([CATALOG[0], { ...CATALOG[0], label: "Other" }]), /reports language-partner twice/);
  });
});

describe("reading the catalog from the platform", () => {
  it("asks the catalog route with the platform's credential", async () => {
    const stub = await stubPlatform(() => ({ status: 200, body: CATALOG }));
    try {
      const personas = await fetchCatalog(configFor(stub.url));
      assert.deepEqual(
        personas.map((persona) => persona.id),
        ["language-partner", "interview-coach"],
        "the platform's order is the cache's order"
      );
      assert.deepEqual(stub.seen, [{ path: "/api/personas", authorization: `Bearer ${PLATFORM}` }]);
    } finally {
      stub.stop();
    }
  });

  it("joins the route onto a base URL that carries a path", async () => {
    const stub = await stubPlatform(() => ({ status: 200, body: CATALOG }));
    try {
      await fetchCatalog(configFor(`${stub.url}/gw`));
      assert.equal(stub.seen[0]?.path, "/gw/api/personas");
    } finally {
      stub.stop();
    }
  });

  it("reports a refusal without repeating anything the platform sent", async () => {
    const stub = await stubPlatform(() => ({ status: 401, body: { error: "unauthorized" } }));
    try {
      await assert.rejects(fetchCatalog(configFor(stub.url)), (error: Error) => {
        assert.match(error.message, /GET \/api\/personas answered 401/);
        assert.equal(error.message.includes(PLATFORM), false, "an error must not carry the platform's credential");
        return true;
      });
    } finally {
      stub.stop();
    }
  });
});

describe("the cache", () => {
  it("holds nothing until it is read, then holds what it read", async () => {
    const stub = await stubPlatform(() => ({ status: 200, body: CATALOG }));
    try {
      const catalog = createPersonaCatalog(configFor(stub.url));
      assert.deepEqual(catalog.all(), [], "a bridge that has not read the catalog holds none of it");
      await catalog.refresh();
      assert.deepEqual(catalog.all().map((persona) => persona.id), ["language-partner", "interview-coach"]);
    } finally {
      stub.stop();
    }
  });

  it("keeps what it had when a re-read fails", async () => {
    // A failed re-read must not empty the cache: 3.3 re-reads on a missed
    // identifier, and a platform that goes away mid-conversation would otherwise
    // take the personas the bridge already knew down with it.
    let status = 200;
    const stub = await stubPlatform(() => ({ status, body: status === 200 ? CATALOG : { error: "down" } }));
    try {
      const catalog = createPersonaCatalog(configFor(stub.url));
      await catalog.refresh();
      status = 500;
      await assert.rejects(catalog.refresh());
      assert.equal(catalog.all().length, 2);
    } finally {
      stub.stop();
    }
  });
});
