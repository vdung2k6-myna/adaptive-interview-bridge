# adaptive-interview-bridge

Speaks the XiaoZhi gadget protocol in front of the interview platform.

A XiaoZhi device only knows one way to reach a server: ask an OTA endpoint where
to connect, then open a WebSocket and say hello. The platform
(`adaptive-interview-api`) speaks HTTP and nothing else, so this service sits
between them — it answers the device's OTA request, holds the device's socket,
and will translate every spoken turn into the platform's turn API.

This repository is being built task by task, and **today it does not speak yet**:
the handshake works, each device is bound to a persona, and nothing after that
does. See [Status](#status).

## Running it

Node **22 or newer** — the version the platform itself runs, and the one whose
built-in `fetch` the tests use to call the OTA endpoint. Nothing else is
required: no database, no build step, no compiler at run time.

```bash
npm install
cp .env.example .env      # then set BRIDGE_DEVICE_SECRET — see Credentials
npm start                 # tsx src/index.ts
```

`.env` is read by Node itself, so `npm start`, `npm run dev` and a bare
`node --import tsx src/index.ts` all behave the same. Every value has a default
except three, which have none on purpose: the two credentials and the platform's
address — see [Credentials](#credentials) and
[The platform's address](#the-platforms-address).

`npm start` starts **both** servers and prints the addresses:

```
adaptive-interview-bridge
  ota      http://192.168.1.100:8003/xiaozhi/ota/
  ws       ws://192.168.1.100:8000/xiaozhi/v1/
  framing  v3
  downlink 24000 Hz / 60 ms
  devices  1 allowed, 1 bound
  platform token held, never sent to a device
```

| Command | What it does |
| --- | --- |
| `npm start` | Runs the service once. |
| `npm run dev` | Same, restarting on source change. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | The test suite (`tsx --test test/*.test.ts`). |

### The two servers

**OTA — `http://<host>:8003/xiaozhi/ota/`.** The device is flashed with this URL
(`CONFIG_OTA_URL`), asks it before anything else, and reads the WebSocket address,
its own token and the framing version out of the answer. A device that cannot
reach this endpoint reports a network failure rather than "no server", so it
answers even while the rest of the service is unfinished — but only to a device
the allowlist names; see [Credentials](#credentials). `GET /` returns the same
addresses as text, for a human with a browser.

**WebSocket — `ws://<host>:8000/xiaozhi/v1/`.** Any path is accepted; the
firmware appends a version segment. On connect the device sends a `hello`, and
the reply must carry `transport` — without it the firmware fails the connect ten
seconds later, with nothing logged on this side. Binary frames are counted and
logged, and deliberately not answered. A connection whose credential does not
check out is refused with **401 during the upgrade**: the firmware reads anything
but a 101 as "server not connected", so the device reports a failure instead of
believing it was connected.

`BRIDGE_PUBLIC_HOST` is the address written into the OTA answer, and it has to be
one the device can route to. Unset, the bridge picks a LAN address itself and
logs which one it chose; set it when that pick is wrong (a second adapter, a VPN,
a machine whose device is on another subnet).

### The platform's address

`BRIDGE_PLATFORM_URL` is where `adaptive-interview-api` is — for example
`http://127.0.0.1:4000`. It is required and has no default, unlike the ports
above: those are addresses this machine serves on, and the flashed device expects
them. This one is a property of one deployment, and the only obvious default is
localhost, which is right on a developer's machine and silently wrong everywhere
else — the bridge would come up looking healthy and reach nothing.

The bridge reads `GET /api/personas` from it once at start and caches the result
(3.1). The read is strict — every entry's five fields are checked, and a payload
that does not match is an error rather than a best-effort persona — and a read
that fails is logged without stopping the bridge: the deployment order is
platform first, then the bridge, and the catalog is re-read before a device is
declined (3.3). It is the first platform call the bridge makes, and it goes
through the one place the platform's credential becomes a request
(`src/platform.ts`).

### Which persona a device speaks as

`BRIDGE_DEVICE_PERSONAS` binds each device to one persona, as `DEVICE=PERSONA` —
for example `b8:1f:3f:4a:9b:01=interview-coach`. The device half is read exactly
the way `BRIDGE_ALLOWED_DEVICES` reads its own, so the two lists can be pasted
from the same place; the persona half is the catalog's own identifier and is
carried exactly as written, because an identifier the catalog does not report is
meant to be a miss rather than a near-miss this service guesses at.

The two lists must describe the same devices, in both directions, and the bridge
refuses to start otherwise. An allowed device with no persona could connect and
never be answered; a binding for a device the allowlist does not name is
configuration for something that can never connect, and is nearly always a typo
in one of the two identifiers. One persona per device, because a gadget speaks as
exactly one — and a device bound to an identifier the catalog does not report is
never answered as a different persona (the bridge says so at start rather than
quietly picking one).

A persona contributes three fields to a turn. They are the platform's own request
fields, renamed in `src/personas.ts` and nowhere else:

| Turn field (`POST /api/voice-agent/stream`) | Persona field (`GET /api/personas`) |
| --- | --- |
| `systemPrompt` | `defaultPrompt` |
| `enabledTopics` | `knowledgeTopics` |
| `answerMode` | `answerMode` |

Those three are the whole of what the bridge takes from a persona: the rest of a
turn comes from the device and the conversation, and the bridge holds no prompt,
topic list or mode of its own. `label` and `emoji` are deliberately not carried —
the bridge renders nothing (D8), and a label exists to be drawn on a screen this
service does not paint.

## Credentials

Two values, and the boundary between them is the point of the service. (The
platform's address is the third required value, and it is not a secret — see
[The platform's address](#the-platforms-address).)

| Where | What it holds | What it can do with it |
| --- | --- | --- |
| The device | One opaque token, per device, written to its NVS by the OTA answer | Connect to this bridge, as itself |
| The bridge (`.env`) | `BRIDGE_DEVICE_SECRET` — the secret every device token is derived from | Issue a token for any device on the allowlist, and verify any device's |
| The bridge (`.env`) | `API_AUTH_TOKEN` — the platform's own credential | Call the platform, on the device's behalf |
| The platform | Nothing about devices at all | — |

**The device's token** is `HMAC-SHA256(BRIDGE_DEVICE_SECRET, "device:" + its
Device-Id)`, base64url. It is derived rather than stored, so there is no token
database: adding a device is naming it, revoking one is un-naming it, and a
restart issues the same tokens it issued before rather than rotating every
device's credential in the field. It is issued by the OTA endpoint and presented
as `Authorization: Bearer <token>` on connect — both ends of that are the
firmware's own behaviour, not something invented here.

**`BRIDGE_DEVICE_SECRET` is required and has no default.** A bridge without one
refuses to start. Whoever holds it can connect as any device on the allowlist, so
it must never be on a device, in a log, or reused between deployments. Generate
one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

**`API_AUTH_TOKEN` is the platform's credential, and it is required too.** It is
the other half of the same boundary: a gadget authenticates to *this* service, and
this service authenticates to the platform. Copy it from `adaptive-interview-api`'s
`.env` and never onto hardware. It is carried unchanged — the platform compares it
byte for byte, so there is deliberately no length rule here and no trim, since a
tidied token is one that no longer authenticates. It becomes a request in exactly
one place (`src/platform.ts`), and no code path that answers a device reads it; the
OTA answer and the hello reply are both asserted not to carry it. The bridge holds
it from task 2.3 and first *uses* it in 3.1, when it reads the persona catalog.

**`BRIDGE_ALLOWED_DEVICES` names the devices**, by Device-Id (the board's MAC).
Separators and case do not distinguish devices, so `b8:1f:3f:4a:9b:01`,
`B8-1F-3F-4A-9B-01` and `b81f3f4a9b01` are one entry. **Empty means nobody**: a
device is allowed because it is named, and a bridge with nothing named refuses
every device, at the OTA endpoint and at the socket alike. The service says so at
startup when the list is empty. Every device named here must also be bound to a
persona in `BRIDGE_DEVICE_PERSONAS` — see
[Which persona a device speaks as](#which-persona-a-device-speaks-as) — and the
bridge refuses to start if the two lists do not name the same devices.

**For an operator: where each secret lives.** The device holds one opaque token,
per device, written into its NVS by the OTA answer — and it is worthless to the
platform, which has never seen a value like it. The 16 KB NVS image read from the
board we run holds neither the platform's token nor the secret every device token
is derived from, and none of the 59 printable strings in it is accepted by the
platform API. The bridge holds **both** secrets: `BRIDGE_DEVICE_SECRET`, which
mints and verifies every device token, and `API_AUTH_TOKEN`, the platform's own
shared credential, which is turned into a request in one place and read by no code
path that answers a device. The platform holds nothing about devices at all — no
device table, no per-device token, no allowlist — and sees the bridge as a single
API client.

**The bridge is internet-facing, and must not be run without its credential
flow.** A device reaches the OTA endpoint and the socket over whatever network it
is on, so the bridge needs a route from the device and a route to the platform;
treat it as a public service, not a laptop convenience. Its own authentication is
what stands between the internet and a process that holds the platform's shared
credential, which is why both secrets are required with no default — there is
deliberately no "run it without auth" path — and why an empty
`BRIDGE_ALLOWED_DEVICES` answers nobody. What this does not do is fix the
platform's shared-token model: `API_AUTH_TOKEN` is still one secret for every
resource, and the bridge's job is to keep it off hardware, not to make it
per-device.

**What this does not protect against, stated plainly.** The Device-Id is a header
the client sets, so the allowlist keeps out a device this bridge was not told
about — it does not keep out someone who already knows the identifier of a device
it was. Rotating `BRIDGE_DEVICE_SECRET` is the lever for a device believed
compromised: it re-provisions every device at its next boot.

## Dependencies

Runtime: `ws` — the WebSocket server. Nothing else; the HTTP side is
`node:http`, credentials are `node:crypto`, and the Opus codec arrives with the
task that first needs it (5.1).

Development: `tsx` (runs the TypeScript directly), `typescript` (type-checking
only — it never emits), `@types/node`, `@types/ws`.

## Status

What this repository is for is the change
`adaptive-interview-gadget-xiaozhi-bridge` in the `team-plans` OpenSpec store;
its `design.md` and `tasks.md` are the specification this code is written
against, and its task numbers are used below.

| | |
| --- | --- |
| Works | The OTA answer, the per-device credential, the connect and its refusal, the hello exchange, the session id, the platform credential held on this side of the boundary and written up for an operator, and — the two things that use it — the persona catalog read from the platform at start and cached, and the binding that maps each device onto one persona's prompt, topics and answer mode. |
| Does not work yet | Nothing consumes a binding yet: no turn carries the three fields (4.x), speech is not synthesized (5.x), and the endpointer does not exist — an accepted device will handshake and then hear nothing (6.x). |

## Layout

```
src/
  index.ts            starts both servers, prints the banner
  config.ts           everything read from the environment, read once
  credentials.ts      who may connect, and with what token
  platform.ts         the platform's credential, turned into a request in one place
  personas.ts         the persona catalog: fetched, validated, cached, and mapped onto a turn's three fields
  log.ts              stamped log lines, matching the rig's format
  net/local-ip.ts     picking a LAN address the device can route to
  protocol/
    framing.ts        the 4-byte (v3) and 16-byte (v2) headers around Opus
    messages.ts       the text messages, and the reply to a hello
  server/
    ota.ts            the OTA endpoint — issues the token, or refuses
    ws.ts             the device socket, the refusal, and the session
test/
  config.test.ts      the fail-closed rules: empty allowlist, two credentials with no default, unbound devices
  credentials.test.ts tokens, the allowlist, and every way a connection is refused
  platform.test.ts    the platform header's shape, and that the two credentials never cross
  personas.test.ts    the strict read, the cached copy, the credentialed request, and the mapping onto a turn
  framing.test.ts     round trips, and short packets
  ota.test.ts         the answer's fields, and who gets one
  handshake.test.ts   the refusal and the hello exchange, over a real socket
```
