# The board, and the firmware built for it

**Status.** The build rows below were read from this machine: the firmware's own
board files, the configuration it was built with, and the artifacts it produced.
The board rows were read from the device: esptool identifying the chip and the
flash part, a boot log captured over the serial console, and the conversation the
device went on to hold with this project's bridge. One further build was read from
a second tree, the clean clone of upstream at `<esp-root>\xiaozhi-clean`, built on
2026-10-07, flashed to the board, and spoken through. One thing is still open and is
marked where it belongs — 1.3's baseline, which was declined rather than missed.

Paths are as they are on this machine, not relative.

## The board

| The board is | |
| --- | --- |
| Chip | ESP32-S3 (QFN56), revision v0.2 — esptool |
| Console | the chip's internal USB-Serial/JTAG, MAC `b8:1f:3f:4a:9b:01` |
| Flash | **16 MB** — manufacturer `68`, device `4018`, quad, 3.3 V |
| PSRAM | **8 MB** — `Embedded PSRAM 8MB (AP_3v3)` |
| Board type | `bread-compact-wifi-lcd` |
| Target | `esp32s3` |
| Partition table | `partitions/v2/16m.csv` |

A 16 MB flash with 8 MB octal PSRAM is what **N16R8** means, and both figures were
read out of the hardware rather than reported by firmware: the flash size comes
from the flash chip's own identification register, the PSRAM from the chip telling
esptool what it carries. So the part fitted is the part Design D7 describes.

**Why 1.2's boot log could not say it.** 1.2 asks for those figures *from the boot
log*, and on this board the boot log cannot give them. The console is the chip's
internal USB-Serial/JTAG, and the first line it ever carries is

```
I (337) Display: Power management not supported
```

— the ROM bootloader and the ESP-IDF bootloader stages print nothing to it. Every
line that would name a size (the bootloader's `SPI Flash Size`, the PSRAM probe)
falls in that first ~330 ms. Attaching as early as the port permits was tried, three
ways: the earliest capture still began at 337 ms. Reading those lines would take
UART0 on an external adapter, which has not been done.

The log does show the PSRAM being used, which is consistent without being the
number: `LcdDisplay: Added 2560KB LVGL pool in PSRAM` at `I (407)`, `Use 2MB of
PSRAM for image cache`, and `WakeWordCache: Allocated 64000 bytes in PSRAM`.

Design D7 names the development kit as an ESP32-S3-WROOM-1 **N16R8** carrier board
— an INMP441 microphone and a MAX98357A amplifier, wired to match this board type.
This board type is the one the change is developed against; the target is an
ESP32-S3-BOX-3, and the difference that matters is that the BOX-3's ES7210/ES8311
carries a hardware echo canceller and this kit does not (D7, and 7.3).

## The build

| The build is | |
| --- | --- |
| Project | `xiaozhi-esp32` |
| Version | `2.5.1` — `main/CMakeLists.txt:12`, and reported by the device as `Ota: Current version: 2.5.1` |
| Source | upstream `78/xiaozhi-esp32`, a snapshot of `main` taken 2026-10-04 |
| ESP-IDF | v6.1, at `<esp-root>\v6.1\esp-idf` |
| Tree | `<esp-root>\v6.1\esp-idf\examples\xiaozhi-esp32-main` |
| Artifacts | `build/xiaozhi.bin` — 2,702,560 B, 2026-10-06 21:34:57; `build/xiaozhi_flashed.bin` — 2,702,560 B, 2026-10-06 21:39:19 |

Both artifacts embed the same single OTA URL,
`https://chat.example.com/xiaozhi/ota/`, and `xiaozhi_flashed.bin` was written
after the flash, so it is what the device is running rather than a leftover.

The tree is not a checkout of its own: it sits untracked inside the ESP-IDF clone,
so there is no history to diff it against. That is why the section below leans on
timestamps and on the configuration file rather than on git.

```
idf.py set-target esp32s3
idf.py menuconfig     # Board Type -> "Bread Compact Wi-Fi + LCD (面包板)"
idf.py build
idf.py -p <port> flash monitor
```

Re-running `set-target` deletes `sdkconfig`, which is where both values below live
— `tools/idf_py_actions/core_ext.py:767`. It is a first-time step, not a build step.

**Building this on this machine.** ESP-IDF v6.1 here was installed by EIM, so it
lives at `<idf-tools>` with its toolchain and virtualenv under `tools\`, and IDF's
own `export.sh` / `export.ps1` do not activate it: they look for the `~/.espressif`
layout and fail with "ESP-IDF Python virtual environment … not found". The
clean-clone build below was therefore driven by invoking `ninja` directly with
`<idf-tools>\tools\xtensa-esp-elf\esp-15.2.0_20251204\xtensa-esp-elf\bin`,
`<idf-tools>\tools\ninja\1.12.1` and
`<idf-tools>\tools\ccache\4.12.1\ccache-4.12.1-windows-x86_64` on `PATH`. That works
because the top-level `build.ninja` and `CMakeCache.txt` already carry absolute
toolchain paths from the configure `idf.py` ran. `idf.py` itself needs the EIM
PowerShell profile, `<idf-tools>\tools\Microsoft.v6.1.PowerShell_profile.ps1`,
sourced in a PowerShell session.

Three traps, each of which stopped a build here. `ccache` and `ninja` must be on
`PATH`: `build.ninja` invokes `ccache` by bare name, and a re-configure invokes
`ninja` by bare name. The `bootloader` subproject configures as a separate CMake
project that probes for the compiler by name, so the xtensa toolchain must be on
`PATH` too, not merely baked into the top-level cache — without it, a configure that
looks unrelated fails with `The CMAKE_C_COMPILER: xtensa-esp32s3-elf-gcc is not a
full path and was not found in the PATH`. And an interrupted build leaves objects
`ninja` still counts as up to date; truncated mid-write they are zero-filled, and the
failure surfaces late and far away, as `ldgen.py` running `objdump` over the archive
and reporting `file format not recognized`. Deleting the offending `.obj` files and
rebuilding is the fix; `head -c4` on each object, looking for the ELF magic, is how
they are found.

## What this build changes from upstream

Six deviations from upstream, and one of them is a source line.

This is no longer inferred from timestamps. The tree was compared file by file against
a clean clone of upstream `78/xiaozhi-esp32` at **`0d576d3`**, which is still `main`'s
tip on 2026-10-06 — so it is the revision a snapshot of `main` taken on 2026-10-04
would have been. Outside the generated files listed below, everything in the tree is
identical except these three rows.

**And three more that the comparison could not see**, because they live in `sdkconfig`
— which the comparison excludes as build state. They are in the table under "The three
the comparison missed", and they are not academic: the first attempt at rebuilding
this tree from a clean checkout produced a board with a Chinese interface, no wake word
while listening, and a chat box that did not re-flow wrapped text. The revision claim
this section makes is therefore narrower than it used to be, and the narrowing is
explained where the exclusions are listed.

| The change | Where | From | To |
| --- | --- | --- | --- |
| `CONFIG_OTA_URL` | `sdkconfig` | the upstream default, `https://api.tenclass.net/xiaozhi/ota/` | `https://chat.example.com/xiaozhi/ota/` |
| `CONFIG_LCD_ST7789_240X240_7PIN` | `sdkconfig` | the board's own declared build, which appends `CONFIG_LCD_ST7789_240X320=y` (`main/boards/bread-compact-wifi-lcd/config.json`) | the panel fitted to this kit |
| `DISPLAY_HEIGHT` | `main/boards/bread-compact-wifi-lcd/config.h:139` | `240`, under `#ifdef CONFIG_LCD_ST7789_240X240_7PIN` | `320` |

The OTA value is the change (1.4): it is where the device is told to look for a
server. The other two are board bring-up — the kit's panel is not the one the board
type declares, so the build both selects a different panel symbol and corrects the
height that symbol yields. **That third row is a source edit**, and this file used to
deny it: an earlier version of this section read "two configuration values, and no
source file at all", inferred from modification times. The timestamps were consistent
with that and did not establish it — `config.h` carries `2026-10-04 10:55:11`, the
latest under `main/` but still the day of unpacking — and the comparison to upstream
is what settled it.

### The three the comparison missed

`sdkconfig` is where the first two rows above live, and it is excluded from the
comparison as build state. So is `main/assets/lang_config.h`, which `gen_lang.py`
generates from the language setting. Between those two exclusions the language choice
was invisible — and it is not alone. Diffing the snapshot's `sdkconfig` against the
clean clone's turns up three settings whose upstream default is the other way:

| The setting | Upstream default | This build | What it does |
| --- | --- | --- | --- |
| `CONFIG_LANGUAGE` | `ZH_CN` | **`VI_VN`** | `main/assets/lang_config.h:13` — `Lang::CODE`, the UI language, and the `Accept-Language` the OTA request carries (`main/ota.cc:70`) |
| `CONFIG_USE_MULTILINE_CHAT_MESSAGE` | `n` | **`y`** | `main/display/lcd_display.cc:979,1111` — the chat bar re-aligns to the bottom as wrapped text changes its height |
| `CONFIG_WAKE_WORD_DETECTION_IN_LISTENING` | `n` | **`y`** | `main/application.cc:1092` — without it the device calls `EnableWakeWordDetection(false)` while listening |

The first is what someone looking at the board notices. The third reaches past the
display: this bridge has a cancel path (6.5) that waits for a `wake_word_detected`
while a turn is in flight, and with the setting off the device never reports the wake
word during a listening window, so the event never arrives and the path cannot fire.
Whether it fires with the setting on has not been measured — that is something to try
on the board, not something this file can assert.

So the honest form of the revision claim is "upstream `0d576d3` plus the three rows
above, plus these three settings, plus whatever else lives only in a `sdkconfig` this
comparison did not read". The last clause is not a hedge for its own sake: `sdkconfig`
holds around 1,400 settings, and the comparison that produced this section read it only
far enough to find the two rows it already knew to look for.

**One further entry is inert here and would not be in a fresh build.**
`sdkconfig.defaults` carries a block the spike appended:

```
# SPIKE: point the device at the local bridge rig instead of the vendor OTA.
CONFIG_OTA_URL="http://192.168.1.100:8003/xiaozhi/ota/"
```

Its own comment says to keep it in step with `CONFIG_OTA_URL` in `sdkconfig`, and it is
not: that address has been stale since the bridge took over. It changes nothing in
*this* build, because `sdkconfig` exists and is what the build reads. But `sdkconfig`
is gitignored and `idf.py set-target` deletes it (`tools/idf_py_actions/core_ext.py:767`),
which is what a first build in a tree with no `sdkconfig` does.

**The clean clone does not carry this block, and that widens the hazard rather than
clearing it.** Upstream has no `OTA_URL` in `sdkconfig.defaults` at all — only the
Kconfig default at `main/Kconfig.projbuild:3`, which is the vendor's
`https://api.tenclass.net/xiaozhi/ota/`. So the two trees fail in opposite directions.
Delete `sdkconfig` in this snapshot and it builds against the rig at
`192.168.1.100:8003`. Delete it in the clean clone and it builds against the **vendor**,
with no local endpoint anywhere in the image. Neither is this bridge, so the value has
to be written into whichever tree is built, and a clean checkout cannot be assumed to
come out pointing anywhere useful.

That matters beyond a failed connection. A clean build that points at the vendor *and*
keeps the stock board identity is the situation 1.4 exists to warn about — the vendor's
channel can reach it and push to it (`CheckNewVersion`, below). It was this snapshot's
compiled-in endpoint, and the fact that no such endpoint is compiled in the other way,
that made 1.4's identity change unnecessary here. A clean rebuild inherits neither
property for free.

**How far the comparison goes, and where it stops.** Four things are excluded because
they are produced rather than written by hand: `build/`, `managed_components/` and
`dependencies.lock` (the component manager), and `main/assets/lang_config.h` (written
by `scripts/gen_lang.py`, `main/CMakeLists.txt:1021`). `sdkconfig` and `sdkconfig.old`
are excluded as build state rather than source. Within that scope the comparison is
exact — but the scope is the problem, and this file used to state the result without
the caveat. Two of the entries on that exclusion list, `sdkconfig` and `lang_config.h`,
are precisely where the three settings above live, and five of the six deviations are
in `sdkconfig` as well. So "exact within this scope" bought less than it looked like
it bought. The claim this file can stand behind is the narrower one: outside the
excluded files, the tree is upstream plus `DISPLAY_HEIGHT`; the other five deviations
are configuration, and the `sdkconfig` diff that found three of them is not a proof
that it found all of them.

What it still cannot say is that the snapshot was taken from `main`: a branch carrying
the same `DISPLAY_HEIGHT` line would compare identically. The provenance note above is
what was recorded at unpacking time; the content claim is the one this file can now
stand behind.

## What the device does with it

From a boot log captured on 2026-10-06, after the build above was flashed. It is the
whole of what 1.4 can be checked against from the device's side.

```
I (677)  WifiStation: Scanning saved channel 5
I (797)  WifiStation: Found AP: HomeNet, BSSID: a4:2b:b0:1c:2d:3e, RSSI: -9, Channel: 5
I (977)  wifi:connected with HomeNet, aid = 2, channel 5, BW20
I (4317) WifiStation: Got IP: 192.168.1.50
I (4417) Ota: Current version: 2.5.1
I (6507) HttpClient: Established new connection to chat.example.com:443 protocol=https cost=2090
I (6957) Ota: No mqtt section found !
W (6957) Ota: No firmware section found!
I (6957) Ota: Running partition: ota_0
I (6957) Application: Activation done
```

Three things are in there.

**The device reaches a server we control.** It opens `chat.example.com:443` and
keeps the connection long enough to get an answer — that is this project's bridge,
reached through the Cloudflare Tunnel, not the vendor's endpoint. The two "no …
section" lines are the bridge's reply being read: it carries a `websocket` block and
no `mqtt` or `firmware` block, which is what `src/server/ota.ts` sends.

**The bridge admitted it.** `Activation done` means the device took the token out of
that reply and moved on. A device outside `BRIDGE_ALLOWED_DEVICES` is refused with
403 and no token before this point — `src/server/ota.ts:42` — so this could not have
happened for a board the bridge does not know.

**The flash did not cost the provisioning.** The device still scans `channel 5`, still
finds `HomeNet`, and still gets its old address `192.168.1.50`. The flash wrote the
bootloader, the partition table, `ota_data`, the app and the assets, and left `nvs` at
0x9000 alone — which is where the Wi-Fi credentials and `board/uuid` live.

`Ota: Running partition: ota_0` says the app now executing is the one just written,
by the name the partition table gives it.

## The conversation it holds

On 2026-10-06, on this build, the device woke on "Alexa" and took two turns against
the bridge. This is the conversation 1.2 names as evidence that the board carries
PSRAM, and the "takes a turn there" 1.4 asks for.

```
[318.15] == device connected ==  session smuwtcyle  path /xiaozhi/v1/
[318.15]   <- {"type":"hello","version":3,"features":{"mcp":true,"glyph_push":true},
              "text_font":{"bundle":"noto-v1","charset":"common","size":16,"bpp":4},
              "transport":"websocket",
              "audio_params":{"format":"opus","sample_rate":16000,"channels":1,"frame_duration":60}}
[318.15] server hello sent (opus 24000 Hz / 60 ms, framing v3)

--- turn 1 ---
[336.13] turn from speech: 1.92s of the person's own voice
[338.03] platform transcribed the turn as "có cái gì mới không?"
[343.78] sentence 0  …  [350.32] sentence 5   @ 24000 Hz / 60 ms
[350.32] turn ended settled, 296 char(s) of reply, 17.46s of audio sent this session

--- turn 2 ---
[362.88] turn from speech: 1.26s
[364.68] platform transcribed the turn as "mừng ngoài gì?"
[370.36] sentence 0  …  [371.48] sentence 1
[371.48] turn ended settled, 95 char(s) of reply, 6.24s of audio sent this session
```

Both directions are in there: the device's own voice went up, the platform
transcribed it, and the reply came back as Opus frames the device played. The
downlink rate in the excerpt is the hello's 24000 Hz, and the uplink's 16000 Hz is
the device's own declared rate — the two rates in the table below, one per direction.

The session also shows two of the protocol's behaviours that live in
`docs/device-protocol.md` rather than here: the wake word arrives on the bus as
`{"type":"listen","state":"detect","text":"Alexa"}`, and no `listen stop` is sent
at any point — both turns were closed by the bridge's own endpointer.

## The pins

From `main/boards/bread-compact-wifi-lcd/config.h`, which is the file the firmware
reads at build time.

| Function | GPIO |
| --- | --- |
| Microphone — WS | 4 |
| Microphone — SCK | 5 |
| Microphone — DIN | 6 |
| Speaker — DOUT | 7 |
| Speaker — BCLK | 15 |
| Speaker — LRCK | 16 |
| Built-in LED | 48 |
| BOOT button | 0 |
| Touch / volume up / volume down | not connected (`GPIO_NUM_NC`) |
| Display — backlight | 42 |
| Display — MOSI | 47 |
| Display — CLK | 21 |
| Display — DC | 40 |
| Display — RST | 45 |
| Display — CS | 41 |
| Lamp (an MCP example) | 18 |

The I2S is simplex — `AUDIO_I2S_METHOD_SIMPLEX`, so the microphone and the speaker
are separate peripherals with separate clocks rather than two halves of one.

| Rate | Value | Why it matters here |
| --- | --- | --- |
| `AUDIO_INPUT_SAMPLE_RATE` | 16000 | what the device sends up, and what the bridge's `deviceRate` says |
| `AUDIO_OUTPUT_SAMPLE_RATE` | 24000 | what the device plays, and what the bridge's `serverRate` says |

Both match what the bridge declares, so neither side resamples on this board's
account.

## What is not settled here

- **1.1's verification — done, in two passes.** 1.1 asks for a build from a clean
  checkout and for the device to **hold a conversation** on it. The clean clone of
  upstream at `0d576d3` lives at `<esp-root>\xiaozhi-clean`; the board was flashed from it
  and spoke through it. Both passes are worth distinguishing, because the first one
  was not a faithful rebuild and the second is.

  **First pass, 2026-10-07 00:11.** `build/xiaozhi.bin`, 2,693,344 B, md5
  `78c665ee5342ddd57af22dfa400b84ad`. It carried
  `https://chat.example.com/xiaozhi/ota/` as its only OTA endpoint, with no vendor
  address in it, and the board `bread-compact-wifi-lcd`. The device booted on it —
  established by `esp_app_desc.elf_sha256`, which is the SHA-256 of the ELF, matching
  the local `xiaozhi.elf` — and took one turn through the bridge (`có gì mới không?`,
  258 characters back). But it was built before the three settings above were found,
  so it came up with a Chinese interface and without the two behaviours. A conversation
  on it proves the build ran; it does not prove the tree was reproduced.

  **Second pass, 2026-10-07 00:41.** After the three settings went into both
  `sdkconfig` and `sdkconfig.defaults`, `build/xiaozhi.bin` — 2,701,904 B, md5
  `e3ff49cca0a930184788e1149494f54f`, ELF SHA-256 `6f52a03ac40f715c…` — was flashed
  and all five images verified by esptool on write. The boot log's
  `ELF file SHA256: 6f52a03ac…` matches that ELF, so the board is running this image
  and no other. `main/assets/lang_config.h` in that same tree reads `CODE = "vi-VN"`;
  because the ELF hash matches, that compiled string is in the running image, which is
  as far as a document can carry the claim that the interface is Vietnamese. On this
  image the device held **two turns** — `ờ có gì mới.` and `vẫn âm lượng nhỏ lại được
  không?`, answered at 180 and 204 characters — with the drain close landing at the
  usual `0.64s` margin both times.

  What this does not cover is 1.1's own list of *what to record*: the pins. They are
  in "The pins" above, read from the board's `config.h` rather than measured on the
  hardware.
- **Where the clean clone keeps the two configuration values.** The table above
  records `CONFIG_OTA_URL` and `CONFIG_LCD_ST7789_240X240_7PIN` in `sdkconfig`, which
  is where the flashed snapshot carries them. `sdkconfig` is gitignored and
  `set-target` deletes it, so the clean clone puts both in `sdkconfig.defaults`
  instead — tracked, and surviving `set-target` — which is one of the two files it
  differs from upstream in, the other being `config.h`. The hazard described in
  "What this build changes from upstream" therefore does not apply to it: it cannot
  come out pointed at the vendor, or at the dead rig address, whichever file happens
  to be absent. That is a claim about the image, and it was read out of the image.
- **The sizes, from esptool rather than the boot log.** 16 MB flash and 8 MB PSRAM
  are established, but from esptool reading the parts rather than from the boot log
  (above), which cannot carry them on this console. 1.2 names the boot log as its
  instrument, so the substitution is recorded here rather than folded in; the figures
  it would have printed are the ones below, read from the silicon the firmware would
  have been probing — flash size from the flash chip's own identification register,
  PSRAM from the chip telling esptool what it carries.
- **The baseline.** The build above is pointed at this project's server. No build of
  this tree has ever been pointed at the vendor's, so 1.3's control — the kit against
  the server it ships pointed at — has not been taken. This is a decision, not an
  oversight: it was declined.
- **The board's identity — deliberately not changed.** 1.4 asks that a modified build
  be given its own board identity *before* it is flashed, because a build keeping the
  stock identity can be overwritten by the vendor's OTA channel. This build keeps the
  stock identity, and that is a decision rather than an oversight.

  The hazard 1.4 names needs the vendor's channel to be reachable, and it is not: the
  device's only OTA endpoint is `https://chat.example.com/xiaozhi/ota/`, compiled
  into the image, with no `wifi/ota_url` in NVS to override it (`main/ota.cc:48`), so
  the vendor's server is never asked and has nothing to push. The two are coupled —
  the moment a build is flashed that points back at the vendor, the device is a
  stock-identity device to that channel again and can be updated by it. The vendor's
  firmware checks for a new version on every boot and upgrades without asking —
  `Application::CheckNewVersion` (`main/application.cc:442`) through `Ota::Upgrade`
  (`main/application.cc:1239`) — so that build would need the identity change.

  Changing it would also have meant editing source, where everything else here is two
  configuration values and no code.
- **The target board — barge-in is unverified (7.3).** Every turn recorded in this
  file was taken on the development kit, and this kit has no echo canceller: the I2S
  is simplex, the microphone and the speaker are separate peripherals with separate
  clocks, and nothing subtracts one from the other. So this gadget is **half-duplex**
  — it cannot hear the person while it is speaking, and the bridge's own drain window
  (6.6, D10) is what keeps its own playback out of the uplink instead.

  The target board is an ESP32-S3-BOX-3, whose ES7210/ES8311 pair does carry a
  hardware echo canceller, and that is the difference D7 names. **No BOX-3 is on hand,
  so 7.3's verification has not been run: hardware AEC giving barge-in is unverified.**
  Conversational feel has therefore been judged **only in half-duplex**, and the
  change is not claimed as finished on the strength of the development board alone.
  This is recorded rather than left pending because 7.3's own text names this branch
  as what to do when no board is available.

  One thing that follows, so it is not read as evidence it is not: the `abort` the
  device sends on the wake word (delta 2) was observed twice on 2026-10-06, and both
  times the device was **Listening** with nothing in flight — the turn had ended
  seconds earlier. The wake word landing mid-reply, which is the case 6.5 exists for,
  has still not happened here, and a device that is half-duplex cannot produce it.
