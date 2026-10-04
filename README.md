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
cp .env.example .env      # optional; every value has a working default
npm start                 # tsx src/index.ts
```

`npm start` starts **both** servers and prints the addresses:

```
adaptive-interview-bridge
  ota      http://192.168.1.100:8003/xiaozhi/ota/
  ws       ws://192.168.1.100:8000/xiaozhi/v1/
  token    spike
  framing  v3
  downlink 24000 Hz / 60 ms
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
the token and the framing version out of the answer. A device that cannot reach
this endpoint reports a network failure rather than "no server", so it answers
even while the rest of the service is unfinished. `GET /` returns the same
addresses as text, for a human with a browser.

**WebSocket — `ws://<host>:8000/xiaozhi/v1/`.** Any path is accepted; the
firmware appends a version segment. On connect the device sends a `hello`, and
the reply must carry `transport` — without it the firmware fails the connect ten
seconds later, with nothing logged on this side. Binary frames are counted and
logged, and deliberately not answered.

`BRIDGE_PUBLIC_HOST` is the address written into the OTA answer, and it has to be
one the device can route to. Unset, the bridge picks a LAN address itself and
logs which one it chose; set it when that pick is wrong (a second adapter, a VPN,
a machine whose device is on another subnet).

## Dependencies

Runtime: `ws` — the WebSocket server. Nothing else; the HTTP side is
`node:http`, and the Opus codec arrives with the task that first needs it (5.1).

Development: `tsx` (runs the TypeScript directly), `typescript` (type-checking
only — it never emits), `@types/node`, `@types/ws`.

## Status

What this repository is for is the change
`adaptive-interview-gadget-xiaozhi-bridge` in the `team-plans` OpenSpec store;
its `design.md` and `tasks.md` are the specification this code is written
against, and its task numbers are used below.

| | |
| --- | --- |
| Works | The OTA answer, the connect, the hello exchange, the session id. |
| Does not work yet | Credentials are not verified (2.2). The persona is not injected (3.x). Audio is not turned into a turn (4.x), speech is not synthesized (5.x), and the endpointer does not exist — the device will handshake and then hear nothing (6.x). |

Two consequences worth stating plainly:

- **Any device that can reach port 8000 is accepted**, whatever token it
  presents. That is task 2.2's job, and until it lands the service carries a
  startup warning saying so. Do not expose it beyond the LAN it is being
  developed on.
- **One shared constant token** (`spike`) is handed out by the OTA endpoint to
  every device. The design (D6) is explicit that a finished bridge issues a token
  per device; this is the rig's stand-in, kept so a device already pointed at
  this machine keeps working. It is also why the token is printed at startup.

## Layout

```
src/
  index.ts            starts both servers, prints the banner
  config.ts           everything read from the environment, read once
  log.ts              stamped log lines, matching the rig's format
  net/local-ip.ts     picking a LAN address the device can route to
  protocol/
    framing.ts        the 4-byte (v3) and 16-byte (v2) headers around Opus
    messages.ts       the text messages, and the reply to a hello
  server/
    ota.ts            the OTA endpoint
    ws.ts             the device socket and the session
test/
  framing.test.ts     round trips, and short packets
  ota.test.ts         the answer's fields, and who gets one
  handshake.test.ts   the hello exchange, end to end over a real socket
```
