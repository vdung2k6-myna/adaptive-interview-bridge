# adaptive-interview-bridge

Speaks the XiaoZhi gadget protocol in front of the interview platform.

A XiaoZhi device only knows one way to reach a server: ask an OTA endpoint where
to connect, then open a WebSocket and say hello. The platform
(`adaptive-interview-api`) speaks HTTP and nothing else, so this service sits
between them — it answers the device's OTA request, holds the device's socket,
and will translate every spoken turn into the platform's turn API.

This repository is being built task by task, and **today it is a skeleton**: the
handshake works, and nothing after it does. See [Status](#status).

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
except the device secret, which has none on purpose.

`npm start` starts **both** servers and prints the addresses:

```
adaptive-interview-bridge
  ota      http://192.168.1.100:8003/xiaozhi/ota/
  ws       ws://192.168.1.100:8000/xiaozhi/v1/
  framing  v3
  downlink 24000 Hz / 60 ms
  devices  1 allowed
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

## Credentials

Two values, and the boundary between them is the point of the service.

| Where | What it holds | What it can do with it |
| --- | --- | --- |
| The device | One opaque token, per device, written to its NVS by the OTA answer | Connect to this bridge, as itself |
| The bridge (`.env`) | `BRIDGE_DEVICE_SECRET` — the secret every device token is derived from | Issue a token for any device on the allowlist, and verify any device's |
| The bridge (`.env`) | The platform's `API_AUTH_TOKEN` (task 2.3) | Call the platform, on the device's behalf |
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

**`BRIDGE_ALLOWED_DEVICES` names the devices**, by Device-Id (the board's MAC).
Separators and case do not distinguish devices, so `b8:1f:3f:4a:9b:01`,
`B8-1F-3F-4A-9B-01` and `b81f3f4a9b01` are one entry. **Empty means nobody**: a
device is allowed because it is named, and a bridge with nothing named refuses
every device, at the OTA endpoint and at the socket alike. The service says so at
startup when the list is empty.

**What this does not protect against, stated plainly.** The Device-Id is a header
the client sets, so the allowlist keeps out a device this bridge was not told
about — it does not keep out someone who already knows the identifier of a device
it was. Rotating `BRIDGE_DEVICE_SECRET` re-provisions every device at its next
boot, and is the lever for a device believed compromised; 2.3 and 2.4 continue
this boundary onto the platform side.

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
| Works | The OTA answer, the per-device credential, the connect and its refusal, the hello exchange, the session id. |
| Does not work yet | The platform credential is not held yet (2.3), and the boundary is not fully documented for an operator (2.4). The persona is not injected (3.x). Audio is not turned into a turn (4.x), speech is not synthesized (5.x), and the endpointer does not exist — an accepted device will handshake and then hear nothing (6.x). |

## Layout

```
src/
  index.ts            starts both servers, prints the banner
  config.ts           everything read from the environment, read once
  credentials.ts      who may connect, and with what token
  log.ts              stamped log lines, matching the rig's format
  net/local-ip.ts     picking a LAN address the device can route to
  protocol/
    framing.ts        the 4-byte (v3) and 16-byte (v2) headers around Opus
    messages.ts       the text messages, and the reply to a hello
  server/
    ota.ts            the OTA endpoint — issues the token, or refuses
    ws.ts             the device socket, the refusal, and the session
test/
  config.test.ts      the fail-closed rules: empty allowlist, no default secret
  credentials.test.ts tokens, the allowlist, and every way a connection is refused
  framing.test.ts     round trips, and short packets
  ota.test.ts         the answer's fields, and who gets one
  handshake.test.ts   the refusal and the hello exchange, over a real socket
```
