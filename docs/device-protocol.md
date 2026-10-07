# Where the gadget departs from its own protocol document

The reference is `docs/websocket.md` in the firmware tree
(`<esp-root>\v6.1\esp-idf\examples\xiaozhi-esp32-main`, where `<esp-root>` is wherever
that tree is checked out). It is the document the device
was written against, and this service matches the device rather than the document.
So this file carries **only the deltas** — the places where the code we hold does
something the document does not say, or says something the code does not do.
Everything not listed here is as the document describes it.

**Status.** The deltas below were read out of the firmware source. On 2026-10-06
the board was attached and sessions captured, and each delta now says which of the
two it rests on. **Confirmed on the wire** are delta 1, delta 5 and the second half
of delta 2. **Still source-read only** are deltas 3, 4, 6 and 7, and the first half of
delta 2: none of them was exercised — that half needs the wake word fired mid-reply,
which has not happened here, and delta 7 describes a direction the bridge only gained
after both sessions were captured. Delta 5's spike figures are not from this board and
are marked as such; the figures added to it are.

1.5 also asks that four things be confirmed against the running device, and they
were. **The connect message**, verbatim:

```
{"type":"hello","version":3,"features":{"mcp":true,"glyph_push":true},
 "text_font":{"bundle":"noto-v1","charset":"common","size":16,"bpp":4},
 "transport":"websocket",
 "audio_params":{"format":"opus","sample_rate":16000,"channels":1,"frame_duration":60}}
```

— sent with `Protocol-Version: 3`, `Device-Id: b8:1f:3f:4a:9b:01` and a `Client-Id`,
and no `aec` in `features` (this board declares none, §3's rule; D7, 7.3). **The
`listen` messages** are `start` with `"mode":"auto"` and `detect` with the wake
word's `"text":"Alexa"`; no `stop` (delta 1). **The rates** are the device's own
16000 Hz up and the server's 24000 Hz down, each declared in its own hello, §8.3.
**The framing version** is 3, and it is not the device's choice: the bridge's OTA
reply sets `websocket.version`, `Ota::CheckVersion` stores it into the `websocket`
namespace as it parses that reply — not `Ota::SetupHttp`, which only builds the
request (`ota.cc`) — and `WebsocketProtocol::OpenAudioChannel` reads it back and
echoes it into both the header and the hello (`protocols/websocket_protocol.cc`).
The frames then carry the 4-byte `BinaryProtocol3` header of §3.3. So v3 arrives
with provisioning, and a bridge that changes its `framing` changes it on the device.

**No delta emerged from the session.** The document held up on everything it states
about the four items above.

File paths below are relative to the firmware's `main/` directory.

## 1. In `mode: auto` the device never sends `listen stop`

The document lists `"stop"` as a value of `listen.state` without saying who sends
it. Exactly one call site sends it — `Application::HandleStopListeningEvent`
(`application.cc`), which runs on `MAIN_EVENT_STOP_LISTENING`. That event is raised
by the button path, which also sets `kListeningModeManualStop`. In `mode: auto`
nothing raises it.

So in the mode `kListeningModeAutoStop` puts the device in, the uplink runs from
`listen start` until the server speaks, and the server has no `stop` to wait for
and no message that ends it. `listen` is a device-to-server type, so there is no
way to ask: the device accepts `notify`, `tts`, `stt`, `llm`, `mcp`, `system` and
`alert` from the server, and none of them stops the microphone. (`docs/websocket.md`
also lists `custom`; this build does not take it — the branch is behind
`CONFIG_RECEIVE_CUSTOM_MESSAGE`, `default n` and unset here, so a `custom` message
falls through to `Unknown message type`.) `tts start` is the only lever, which is the
same one speech already uses.

**The bridge:** runs its own endpointer and closes the turn itself (D9), and
treats the `stop` message as something a device may send — it is not an error —
without depending on it arriving.

**Confirmed on the wire, 2026-10-06.** Across a session on one `session_id`, the
device sent `listen start` four times — on the wake, and again after each of the
three replies that followed — and `listen stop` **zero** times, in `mode: auto`
throughout. The turns that completed were ended by the bridge moving the device to
`speaking`; no device message closed any of them.

## 2. The wake word ends the turn with `abort`, and the device does not go to Idle

`Application::HandleWakeWordDetectedEvent` (`application.cc`) runs on
`MAIN_EVENT_WAKE_WORD_DETECTED`. From `Speaking` **or** `Listening` it calls
`AbortSpeaking(kAbortReasonWakeWordDetected)`, which is the `abort` message
(`Protocol::SendAbortSpeaking`, `protocols/protocol.cc`), and then empties the
send queue so no residue of the interrupted utterance follows it.

What it does next is the part the document gets wrong. §6.2 of the document draws
the transition as "Listening / Speaking → Idle (abort)". The code does not go to
Idle. From `Speaking` it sets `play_popup_on_listening_ = true` and
`SetListeningMode(GetDefaultListeningMode())`; from `Listening` it calls
`SendStartListening(...)` outright. Both land the device back in `Listening`, and
`SendStartListening` is where the `listen start` that follows the `abort` comes
from. The device is not waiting to be re-woken; it is already listening again.

**The bridge:** treats `abort` as a cancel and lets the `listen start` that follows
it open the next window (D15). It does not send anything in response, and it does
not assume the device has gone away.

**Partly observed, 2026-10-06.** Two sessions that day. The first never fired the
wake word mid-reply: it sent `listen detect` once from Idle and no `abort` at all. The
second did send one — `{"type":"abort","reason":"wake_word_detected"}` — followed
**0.01 s later** by `{"type":"listen","state":"start","mode":"auto"}`. That is the
second half of this delta on the wire: the device does not go to Idle, it starts
listening again, and the `listen start` after an `abort` is its own. But that wake word
arrived while the device was **Listening**, not `Speaking`: the turn had ended a minute
earlier and the bridge had nothing in flight, so nothing was interrupted and no
`tts sentence_start` was left narrating. The case 6.5 exists for — the wake word landing
mid-reply, where the failure is a display naming a sentence nobody hears — still has no
observation, and 6.5 remains unverified on the device.

## 3. `tts stop` does nothing once the device has left `Speaking`

The `tts`/`stop` handler (`application.cc`) is guarded by
`if (GetDeviceState() == kDeviceStateSpeaking)`. After a wake-word abort the device
has already left that state, so a `tts stop` sent to silence an aborted turn is a
no-op delivered into exactly the state it is meant to fix.

**The bridge:** does not send one. The aborted turn's own `finally` closes the
bracket it opened, which is the only `tts stop` that turn gets (D15).

## 4. `tts sentence_start` is not state-gated — binary frames are

§4.2.9 of the document says binary frames arriving while the device is not
`speaking` are dropped, and the code agrees:
`Protocol::OnIncomingAudio`'s callback in `application.cc` pushes a packet to the
decode queue only under `GetDeviceState() == kDeviceStateSpeaking`.

The `sentence_start` handler has no such guard. It schedules
`display->SetChatMessage("assistant", message)` unconditionally. An author reading
the document would reasonably infer that the two are gated alike; they are not.

**The bridge:** this is why the display is the thing to watch when the audio stops.
A bridge that ignores `abort` keeps announcing sentences — a screen naming a reply
nobody is hearing, with a clean log — while the audio it sends is silently dropped
at the device. 6.5 asserts what the bridge stopped saying, not what the device
stopped playing.

## 5. The device's own listening transition is not the server's playback clock

Three separate reasons, all in `application.cc`:

- **The popup tone.** The wake-word path plays one — `PlaySound(OGG_POPUP)` when the
  device was already listening, `play_popup_on_listening_` when it was speaking.
  The server did not send it and cannot account for it.
- **The deferral is mode-dependent.** Entering `kDeviceStateListening`, the device
  defers enabling voice processing until its playback queue has drained — but only
  under `listening_mode_ == kListeningModeAutoStop`, and only if
  `!audio_service_.IsPlaybackIdle()`, via `pending_listening_start_` and
  `MAIN_EVENT_PLAYBACK_DRAINED`. In the other modes it calls `StartListeningAudio()`
  there and then — though all of it sits behind an outer gate,
  `play_popup_on_listening_ || !audio_service_.IsAudioProcessorRunning()`, and when
  that is false the branch calls `ConfigureWakeWordForListening()` instead and starts
  no listening audio at all.
- **A drained queue is not a silent speaker.** The measurement is the spike's
  (D10, `design.md`): on the board it ran against, the microphone went live
  **1.7–2.3 s** before the speaker stopped, while the device reported itself
  listening, and the echo it sent back measured **5–8k RMS against 19–24k** for
  speech. That is not a gap an energy test closes.

**The bridge:** owns the clock rather than reading the device's state. After a turn
it drops input frames until its own estimate of when that turn's audio finished
playing, plus a guard margin, and restarts the endpointer when the window ends
(D10, 6.6).

**Confirmed on the wire, 2026-10-06.** The gap on this board is far wider than the
spike's 1.7–2.3 s. The bridge closed a turn with 17.46 s of audio sent that session;
**2.0 s** later the device sent `listen start` again, while the bridge's own estimate
still had **9.19 s** of that turn unplayed. The microphone was live with the speaker
still to run — the spike's finding restated, on a second board and by a margin no
energy test could close.

**Corrected the same day, and the correction is the interesting part.** That margin
was mostly the bridge's, not the device's. The bridge was writing each turn out as
fast as the platform produced it — 17.46 s of audio in about six seconds — and the
device's receive path discards what its 20-frame queue has no room for (5.6, D16), so
most of those 9.19 s were frames the device never received. Once the downlink was
paced, the same measurement on the same board inverted: a 12.60 s turn closed at
346.30, the bracket's close went out at 358.66 with the bridge's estimate of the end
of playback at 359.30, and the device sent `listen start` at **359.41** — **0.11 s**
from the estimate. Three further paced turns agreed the same way: 18.78 s, 34.98 s and
22.80 s of audio landing **0.38 s**, **0.44 s** and **0.01 s** from their own
estimates, worst 0.44 s. A device that had dropped frames drains seconds early,
which is exactly how the earlier run behaved. So the deferral this delta rests on is
real and it is why the bridge still owns the clock (D10), but on this board it is a
fraction of a second rather than the nine the first session showed, and the difference
was the bridge's to fix rather than the device's to work around.

**And that fraction is conditional, with the condition on the bridge's side.**
The 0.11–0.44 s agreement is what a turn looks like when its tail leaves in its own
slots, because the deadline is anchored on the bracket opening plus the turn's
reserved audio — which is a realtime clock only while the frames keep to their slots.
On 2026-10-07 a turn of **22.14 s** came from a platform that took **22.16 s** to
produce sentences 3 through 7 alone (**13.68 s** of audio, about 0.6× realtime): the
bridge armed its deadline **3.47 s in the past** — the log printed *microphone
distrusted for another* **−3.47 s**, a spent guard and a microphone never actually
distrusted — and the device sent `listen start` **4.81 s** after the estimate. The
device's deferral is still the smaller half of this story; the bridge's own arithmetic
is the half that moves, and its lead is a floor on how early a frame may go rather
than a bound on how late.

## 6. The channel is considered closed after 120 s of server silence

`Protocol::IsTimeout()` (`protocols/protocol.cc`) returns true 120 s after the last
inbound message, and `IsAudioChannelOpened()` — which nearly every entry point in
`application.cc` is guarded by — folds that in. From `Idle`, a start-listening with
the channel in that state does not simply listen: it sets `kDeviceStateConnecting`
and runs the whole connect again (`ContinueOpenAudioChannel`). And
`CanEnterSleepMode()` needs three things, not one: the device Idle, **and** the audio
channel closed, **and** the audio service idle (`application.cc`). Idle on its own is
not enough, which is what makes a quiet deployment's sleep behaviour follow from the
timeout rather than from the state alone.

**The bridge:** has nothing to change — a turn or its bracket goes out within
seconds of any speech — but a deployment left quiet for two minutes is not in the
state it was, and that is worth knowing before attributing a reconnect to something
else.

## 7. The gadget is the MCP server, and an `mcp` message reaches it in any state

**The direction is the one the document does not describe.** The gadget runs an MCP
*server* (`McpServer::GetInstance()`, `mcp_server.cc`); the bridge is its client
(D1). Nothing in the firmware sends an `mcp` message the server did not ask for:
there is no event stream, no gadget-initiated request, and no way for the gadget to
say anything under this type first. The only trace of MCP in a session log before
the bridge's first call is the hello's `features: {"mcp": true}`
(`protocols/websocket_protocol.cc`), which is a declaration of what the device can
answer rather than a message from it.

The envelope carries both directions. `Protocol::SendMcpMessage`
(`protocols/protocol.cc`) wraps a JSON-RPC body as
`{"session_id":…,"type":"mcp","payload":…}` and sends it device-to-server;
`McpServer::SendResponse` (`mcp_server.cc`) falls back to it whenever no response
sender was installed, which is the case on the inbound path — `Application` calls
`ParseMessage(payload)` with the default `nullptr` (`application.cc`). So a reply is
the same type going the other way, and the `id` is the whole of what pairs a result
with the call it answers.

**What a message must look like to be dispatched at all** (`McpServer::ParseMessage`,
`mcp_server.cc`), in the order the checks run:

- `jsonrpc` must be the string `"2.0"`; anything else, absent included, is logged
  *Invalid JSONRPC version* and dropped.
- `method` must be a string, or *Missing method*.
- **Then, before the `id` is ever looked for**, a method whose name begins with
  `notifications` returns in silence. This is the one path that is dropped without a
  word.
- `params`, if present, must be an object, or *Invalid params for method: …*.
- `id` must be present **and a number**, or *Invalid id for method: …* and nothing is
  dispatched.

So a notification is a no-op and an id-less request is a logged error; neither
reaches a tool. **The bridge:** sends no notification, and could not make use of one
if it did — the gadget has no handler that acts on anything but a call. Every message
the bridge sends carries a numeric `id`, because every message it sends is a call it
is waiting on. `initialize` comes back as `protocolVersion 2024-11-05`,
`capabilities: {"tools":{}}`, and a `serverInfo` carrying the board's name and its
own firmware version string.

**And the inbound branch is not state-gated.** The `mcp` branch of
`Application::OnIncomingJson` is one `cJSON_IsObject(payload)` check and a call to
`ParseMessage`; there is no `GetDeviceState()` guard on it. Its neighbours have one:
`tts`/`stop` (delta 3) and the binary frames `Protocol::OnIncomingAudio` pushes to the
decode queue (delta 4) are both conditional on the device being in `Speaking`, and
both are a no-op or a drop when it is not. A call is neither. It reaches the gadget
from Idle, from Listening and from Speaking alike.

**The bridge:** this is what makes a command answerable mid-turn. The command path
aborts at the transcript, before anything of the reply has been spoken — the bracket
is never opened, so the device is never put into `Speaking` for that turn — and calls
the tool straight after. A `tts stop` sent in that moment would be delta 3's no-op:
it is guarded on a state this turn never reaches. The `set_volume` sent in the same
breath is carried out instead, and it is carried out *because* this branch has no
state to match rather than because the state happened to be right (4.1).

What the person reads on the screen is not this call either. `set_volume` touches the
codec and nothing else; `set_brightness` drives the backlight rather than the display
— which is why it is registered conditionally, on a board that has one; `set_theme`
does change how the screen looks, but none of the three puts words on it. The words
come from the `stt` message the bridge sends ahead of any of this, carrying the
person's own utterance. So the screen names the command because the bridge said so and
not because the gadget did, and requirement 4's two halves are earned separately: the
silence is this branch having no guard to fail, and the words are the bridge's own
message rather than a side effect of the change it made.

**Still source-read only.** The sessions of 2026-10-06 and 2026-10-07 both predate the
MCP client — no `mcp` message was sent in either direction — so everything above rests
on the source and none of it was exercised on the wire.
