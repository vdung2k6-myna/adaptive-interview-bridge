# Where the gadget departs from its own protocol document

The reference is `docs/websocket.md` in the firmware tree
(`<esp-root>\v6.1\esp-idf\examples\xiaozhi-esp32-main`). It is the document the device
was written against, and this service matches the device rather than the document.
So this file carries **only the deltas** — the places where the code we hold does
something the document does not say, or says something the code does not do.
Everything not listed here is as the document describes it.

**Status.** These were read out of the firmware source, not confirmed against a
running board: 1.5's first half needs a device, and no device has been attached.
Every line below names the file and symbol it came from so it can be re-checked
the moment one is. The one measurement in here (delta 5) is the spike's, carried
across from `design.md`'s D10, and is marked as such.

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
way to ask: the device accepts `notify`, `tts`, `stt`, `llm`, `mcp`, `system`,
`alert` and `custom` from the server, and none of them stops the microphone.
`tts start` is the only lever, which is the same one speech already uses.

**The bridge:** runs its own endpointer and closes the turn itself (D9), and
treats the `stop` message as something a device may send — it is not an error —
without depending on it arriving.

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
  there and then.
- **A drained queue is not a silent speaker.** The measurement is the spike's
  (D10, `design.md`): on the board it ran against, the microphone went live
  **1.7–2.3 s** before the speaker stopped, while the device reported itself
  listening, and the echo it sent back measured **5–8k RMS against 19–24k** for
  speech. That is not a gap an energy test closes.

**The bridge:** owns the clock rather than reading the device's state. After a turn
it drops input frames until its own estimate of when that turn's audio finished
playing, plus a guard margin, and restarts the endpointer when the window ends
(D10, 6.6).

## 6. The channel is considered closed after 120 s of server silence

`Protocol::IsTimeout()` (`protocols/protocol.cc`) returns true 120 s after the last
inbound message, and `IsAudioChannelOpened()` — which nearly every entry point in
`application.cc` is guarded by — folds that in. From `Idle`, a start-listening with
the channel in that state does not simply listen: it sets `kDeviceStateConnecting`
and runs the whole connect again (`ContinueOpenAudioChannel`). And
`CanEnterSleepMode()` becomes true once the device is Idle.

**The bridge:** has nothing to change — a turn or its bracket goes out within
seconds of any speech — but a deployment left quiet for two minutes is not in the
state it was, and that is worth knowing before attributing a reconnect to something
else.
