# adaptive-interview-bridge

Speaks the XiaoZhi gadget protocol in front of the interview platform.

A XiaoZhi device only knows one way to reach a server: ask an OTA endpoint where
to connect, then open a WebSocket and say hello. The platform
(`adaptive-interview-api`) speaks HTTP and nothing else, so this service sits
between them — it answers the device's OTA request, holds the device's socket,
and will translate every spoken turn into the platform's turn API.

This repository is being built task by task, and **today it speaks but does not
listen**: the handshake works, each device is bound to a persona, and a turn's
reply reaches the device's own speaker in Opus — but nothing the *person* says yet
becomes a turn. See [Status](#status).

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

Those three are the whole of what the bridge takes from a persona, and the split
is worth stating plainly, because "which fields come from where" is the question
a new binding raises:

| A turn's field | Comes from | Named in |
| --- | --- | --- |
| `systemPrompt`, `enabledTopics`, `answerMode` | the persona | the platform's catalog, selected by `BRIDGE_DEVICE_PERSONAS` |
| the device's identity (`Device-Id`) | the device | `BRIDGE_ALLOWED_DEVICES`, and the binding above |
| `audio`, and the `language` the turn declares | the device, per turn | the device itself — the language at 4.1, the audio at 6.1 |
| `history` | the conversation so far | the bridge, per device — 4.2 |

A device contributes its identity and never its character: it selects which
persona answers, and nothing about what that persona says. The bridge holds no
prompt, topic list or mode of its own. `label` and `emoji` are deliberately not
carried — the bridge renders nothing (D8), and a label exists to be drawn on a
screen this service does not paint.

### The turn

A turn goes to `POST /api/voice-agent/stream` on the platform, as multipart form
data — the same request the browser makes, field for field (D2). The endpoint looks
no persona up, so everything it needs to answer as this gadget's persona is in the
request: the persona's three fields above, the conversation so far, and the
person's input as an audio file or as text. It is sent with `speak=1`; a turn sent
unspoken comes back with no audio on any sentence, and the gadget then sits silent
with nothing in a log to say why.

**`language` is required on every turn, and it is the full word, not a code.** The
endpoint reads an absent or unrecognized value as `english` — not as "detect", as
`english` — so a turn that drops the field does not lose a hint, it pins the
transcriber, and it fails silently. A code (`vi`) is unrecognized in the same way.
This is a correctness requirement rather than a preference: left to detect, the
transcriber decodes short Vietnamese as Chinese, and the persona then answers
someone who never spoke it (D12). Measured on one utterance taken from the device
by the rig, the same bytes came back as `"ao"` with `language=vietnamese`, as
`"Oh."` with `language=english`, and as `"哦。"` with the language left to detection.

`engine` is derived from that language rather than configured — Piper for English,
Kokoro for Vietnamese — which is the platform's own answer for a caller with no
voice preference of its own. A persona carries no voice field (D3), and the bridge
does not name one; leaving the field out would *not* express "no preference",
because the endpoint folds an absent engine to Kokoro before it consults the
language. The bridge sends the value that branch would have produced, and names no
voice beyond it — which voice that turns out to be is the platform's to resolve,
and 4.5 is where the deployment's answer is recorded.

The reply is a stream of server-sent events — `user`, `sentence`, `text`, `notice`,
`error`, `done` — and it is read as one. The endpoint emits each sentence's audio as
that sentence is finished, so speech begins before the reply is complete (D4); a
client that waited for the body would have thrown the property away, which is why
the bridge hands each event to its caller as it arrives.

### The conversation

The endpoint keeps no conversation (D2), so the bridge keeps one, per device, and
sends it back with every turn. A gadget that was not sent its own history would be a
gadget with no memory: the person repeats themselves, and the persona meets them as
a stranger on every turn while the log shows nothing wrong.

It is kept **per device**, not per socket. A device that drops its connection and
reconnects is the same gadget, and starting it over is a thing the person
experiences as the device forgetting. Nothing is written to disk, so restarting the
bridge is a fresh conversation — which is the honest reading of a service that
holds no database, and is worth knowing before you deploy it.

Both sides of a turn are recorded, and neither is guessed. The person's side is the
stream's own `user` event, which is the platform's transcription of what they said
and the only place it exists — on an audio turn, nothing the bridge sent contains
it. The gadget's side is the reply text, which the bridge already has because it is
about to speak it.

A turn's history is **bounded** to its most recent `BRIDGE_HISTORY_TURNS` turns
(default 20), dropping the **oldest** first. Unbounded, it grows for as long as the
conversation runs and the request is eventually refused — a failure that lands on
some turn in the middle, with nothing in it to say the history was the cause. The
default matches the platform's own `VOICE_AGENT_MAX_HISTORY`, so what the bridge
sends is what the platform would have kept anyway; raising one without the other
only grows a body that is about to be cut.

Turns are dropped **whole**, so the history never opens on the gadget answering a
question that is no longer in it. The current turn is not part of what is sent: the
platform appends it to the history itself, so sending it as well would put the same
question to the model twice.

### Adding a device

Two lines in `.env`, and no code:

1. **`BRIDGE_ALLOWED_DEVICES`** — add the device's Device-Id, which is the board's
   MAC in any spelling (`b8:1f:3f:4a:9b:01`, `B8-1F-3F-4A-9B-01` and
   `b81f3f4a9b01` are one entry).
2. **`BRIDGE_DEVICE_PERSONAS`** — add `DEVICE=PERSONA`, the same identifier and a
   persona id the catalog reports. Read the ids from `GET /api/personas`, or the
   list the bridge prints at start.

The bridge refuses to start if the two lists do not name the same devices, so a
half-finished pair is reported at start where you are, rather than at the device's
first turn. Then restart it: the device is provisioned the next time it asks the
OTA endpoint, needs no reflash, and can be revoked by removing either line.

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

Runtime: `ws` — the WebSocket server — and `opusscript` — the Opus codec,
which both directions of the audio need (5.1, 6.1). Nothing else; the HTTP side is
`node:http` and credentials are `node:crypto`.

Development: `tsx` (runs the TypeScript directly), `typescript` (type-checking
only — it never emits), `@types/node`, `@types/ws`.

## Status

What this repository is for is the change
`adaptive-interview-gadget-xiaozhi-bridge` in the `team-plans` OpenSpec store;
its `design.md` and `tasks.md` are the specification this code is written
against, and its task numbers are used below.

| | |
| --- | --- |
| Works | The OTA answer, the per-device credential, the connect and its refusal, the hello exchange, the session id, the platform credential held on this side of the boundary and written up for an operator, and — the things that use it — the persona catalog read from the platform at start and cached, the binding that maps each device onto one persona's prompt, topics and answer mode, and the resolution of that binding for a turn: from the cache, from a fresh read when the cache misses, and a refusal that names the device and the identifier when it still misses (3.3, 3.4). The turn itself (4.1): the browser's own request, carrying that persona's fields and the device's language, with the reply's events consumed as they arrive. The conversation around it (4.2, 4.3): each device's turns held on this side, sent back as the turn's history and bounded to the most recent. And the speech back to the device (5.1, 5.2, 5.4, 5.5): each sentence's audio unwrapped from its WAV, re-encoded as Opus at the rate the hello declared, framed, and bracketed with `tts start` and `tts stop` — without which the firmware discards every frame in silence — with each sentence announced as `tts sentence_start` ahead of its own frames so the device's display names what is being heard, and a sentence carrying no audio, or a reply with nothing speakable in it at all, completing the turn in silence rather than failing it. |
| Speech from the device (6.1–6.7) | The device streams Opus; the bridge decodes it at the device's own 16000 Hz, decides for itself when the person has stopped speaking, and uploads the utterance rather than the window it was spoken into. The endpointer counts speech over a sliding window, closes a turn on silence after speech, holds it open across a pause inside a sentence, gives up on a window nobody spoke into, and refuses at start a configuration in which a turn could never close. The frames it judged are the frames it uploads — one structure, one verdict per frame, no second decode — trimmed back from the last voiced frame so 38.4 s of window carrying 1.32 s of speech does not go to the transcriber as 38.4 s (D11). The transcription comes back to the device as `stt` before the reply does. A wake word mid-reply cancels the turn at its source, so the display stops naming sentences nobody is hearing, and the turn ends rather than failing — recorded, so the question the person was cut off asking survives into the next turn's history. And after a turn the microphone is distrusted for as long as this reply's own audio is still playing, plus a guard. |
| Does not work yet | The platform's `notice` and `error` events are surfaced to the device and to the log but the recovery around them has not been exercised against a live platform (4.4). What a newly bound gadget will *sound* like is not written down anywhere yet, since a persona carries no voice field (4.5). The device protocol deltas are written down (`docs/device-protocol.md`), but from the firmware source rather than from a running device: the reading is done and the confirmation is not (1.5). Every claim about a real board — the build, the PSRAM, the vendor baseline, the device pointed at this server, time to first audio, and barge-in on AEC hardware — is unverified: no board has been attached. Section 6's behaviour is asserted against a real socket, real Opus and a stub platform, but never against a gadget whose microphone is live. |

## Layout

```
docs/
  device-protocol.md  where the gadget departs from its own protocol document: the deltas only
src/
  index.ts            starts both servers, prints the banner
  config.ts           everything read from the environment, read once
  credentials.ts      who may connect, and with what token
  platform.ts         the platform's credential, turned into a request in one place
  personas.ts         the persona catalog: fetched, validated, cached, resolved per device, and mapped onto a turn's three fields
  turn.ts             the turn: the platform's voice-agent request, and the reply's stream
  conversation.ts     a device's conversation: per device, sent as history, bounded
  listening.ts        the device's microphone: the endpointer that closes a turn, and the utterance it uploads
  speech.ts           the device's voice: each sentence announced for the display, then as Opus frames, inside the tts bracket
  log.ts              stamped log lines, matching the rig's format
  net/local-ip.ts     picking a LAN address the device can route to
  protocol/
    framing.ts        the 4-byte (v3) and 16-byte (v2) headers around Opus
    messages.ts       the text messages, and the reply to a hello
    opus.ts           the codec, both ways: a sentence re-encoded into the device's frames, and the device's frames decoded and joined into one WAV
    wav.ts            the WAV container, both ways: the platform's sentence audio unwrapped, and the utterance wrapped for upload
  server/
    ota.ts            the OTA endpoint — issues the token, or refuses
    ws.ts             the device socket: the refusal, the session, the speech to it, and the listening that ends a turn
test/
  config.test.ts      the fail-closed rules: empty allowlist, two credentials with no default, unbound devices
  credentials.test.ts tokens, the allowlist, and every way a connection is refused
  platform.test.ts    the platform header's shape, and that the two credentials never cross
  personas.test.ts    the strict read, the cached copy, the credentialed request, the mapping onto a turn, and the resolution that re-reads on a miss
  turn.test.ts        the request the browser would have sent, and a reply's events consumed as they arrive
  conversation.test.ts a device's conversation: what a turn carries in, and what it leaves behind
  speech.test.ts      the bracket around a reply, what it carries, and what the display is told
  listening.test.ts   the endpointer over frames, which part of the window to upload, and the utterance that closes a turn
  spoken-turn.test.ts the whole path, both halves at once: a real socket, real Opus, a real endpointer and a stub platform
  framing.test.ts     round trips, and short packets
  opus.test.ts        a sentence's frames, checked against a real decoder
  wav.test.ts         the container: what the format chunk says, and where the samples start
  ota.test.ts         the answer's fields, and who gets one
  handshake.test.ts   the refusal and the hello exchange, over a real socket
```
