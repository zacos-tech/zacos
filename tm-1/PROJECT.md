# TL-1 — Project Overview

**A modern tape recorder with two decks.**

A sealed, battery-powered tape machine with a stereo microphone in the body. It records where you are, then lets you slow that down, filter it, granulate it, layer onto it, and let two loops drift against each other. Everything is on knobs. The screen tells you what the tape is doing.

This repo contains the firmware, the browser development harness, and the hardware design. All of it is open.

---

## Read this first (if you are an agent)

This document exists so that changes to the code don't quietly undo decisions that took a long time to arrive at. Before implementing anything:

1. **Read `DOCTRINE` below.** Those are hard constraints, not preferences. A change that violates one is wrong even if it works.
2. **Read `ENGINE.md`** for how the DSP actually works and why each part is the way it is.
2b. **Read `FIRMWARE.md`** before touching anything that runs on hardware — real-time rules, memory placement, project structure, and the symptom-to-cause table.
3. **Prefer subtraction.** This machine got good by cutting things. When a feature seems to need a new control, first check whether an existing control can mean it.
4. **Everything must be expressible in tape vocabulary.** If a feature can't be described as something a tape machine does, it probably doesn't belong. This isn't aesthetics — it's the constraint that has kept the interface coherent while the feature count quadrupled.

---

## Current state

| Layer | State |
|---|---|
| DSP engine | Working, in JavaScript, in the browser harness |
| Browser harness | Working — two decks, grains, overdub, live input, modulation |
| Portable C++ core | **Not started.** This is milestone M0 |
| Daisy firmware | Not started. Hardware ordered (Daisy Pod + Seed3) |
| Panel design | Drawn, not final. Control count still being decided |
| Enclosure | Not started |
| PCB | Not started |

The single most important next task is **M0: extract the engine from JavaScript into portable C++ and prove the CLI host produces bit-identical output to the browser.** That becomes the regression baseline for everything after.

---

## DOCTRINE

Hard rules. Violating one of these is a bug even if the code runs.

### Interface

- **Position encodes ownership.** Left column is deck A and nothing else. Right column is deck B and nothing else. Anything in the middle belongs to both. You should never have to read a label to know what a control affects.
- **No modality.** No control changes meaning based on hidden state. Each deck has its own transport for exactly this reason — a shared transport with a deck selector means pressing PLAY and starting the wrong deck.
- **Nothing more than one level deep.** A settings page reached from the control it belongs to is fine. A menu tree is not.
- **The screen shows state, not menus.** Its home view is what the tape is doing. Configuration is the exception, not the purpose.
- **The lid test.** The complete operating procedure must fit on the inside of the lid in readable type. If it doesn't, the machine is too complex. This is the arbiter for feature disputes.
- **Defaults must be complete.** Someone should be able to use the machine for a year without opening a settings page. The opinion lives in the defaults, not in the flexibility.

### Sound

- **The machine lets you go wild.** The extremes are the instrument, not the edge of it. Where a control could be capped for taste, it isn't: the filter self-oscillates, feedback can build past unity, sound-on-sound can run away, resonance can scream. This is the SOMA position — the interesting territory is where you are negotiating with the machine rather than operating it, and a device that stops politely short of it is a tool instead of an instrument.

  The one limit is **protect the hardware, never the character**: a DC blocker and a limiter on the speaker and headphone outputs, so a runaway cannot cook a driver or someone's hearing. Nothing anywhere in the signal path exists to keep the sound tasteful. If a limit is proposed, it must be justified by physical damage, not by how it sounds.

  Corollaries an agent will need: extreme settings must be *stable, not safe* — no NaN, no unbounded DC, no state that survives a return to sane settings. Every runaway path (resonance under sound-on-sound, feedback above unity, head-gap regeneration) gets a bounded-output test in the suite, and the test asserts that it stays finite, not that it stays quiet.

- **Head loss is always on and is not under AGE.** The playback-head lowpass tracks transport speed. This is what makes the machine sound like *tape* rather than like a pitched-down sampler. AGE controls how *old* the tape is; it must never reach zero-tape.
- **Nothing cheap in the signal path.** Cut a control, never an op-amp.
- **The read path is protected by the sinc window. The write path is protected by nothing but the record-path anti-alias filter.** Do not remove it.

### Physical

- Steel is the instrument, rubber is everything that touches the world.
- Dark finish over stainless, so wear reveals bright metal rather than exposing rust.
- Marks are laser-etched, never printed. Print wears off outdoors.
- No branding on the panel. The designation only.
- All colour on the machine is emitted light. The body is monochrome. Etched labels stay unlit so the machine is readable with a dead battery.
- Never animate the LEDs. Never cycle them. That is the one change that would make this look like a gaming peripheral.

### Project

- Everything is open source. Firmware, hardware, docs. Trademark stays.
- GPLv3 on firmware implies no locked bootloader, ever.
- The fiction is discoverable, never front-loaded. Controls say SPEED and LEVEL. The story lives on the lid and the SD card.

---

## The machine

### Decks

Two independent tape decks. Each has its own transport and its own signal path.

| Control | Range | Notes |
|---|---|---|
| SPEED | −2× … +2× | Continuous through zero into reverse. ~35 ms transport inertia |
| LEVEL | 0 … 1.4 | |
| FILTER | −1 … +1 | Bipolar. LP closing down / open at centre / HP opening up |
| OFFSET | ±5000 ppm | Fine speed trim. The phasing control |
| GRAIN | 0 … 12 heads | Density. 0 = single playhead |
| LFO DEPTH | 0 … 1 | |
| REC / PLAY / SCRUB | | Scrub is spring-loaded, ±4× while held |

Per-deck settings that live on screen: splice in, splice length, decay (erase coefficient), polarity invert, grain size, grain spray, grain ramp, grain source (tape/live), LFO rate, LFO shape, LFO destination, LFO sync.

### HEADS — deck topology

One switch, three positions, and it is the whole instrument:

- **LINK** — two playheads on one tape. Set OFFSET and they drift apart. Reich phasing.
- **STEREO** — two decks locked as left and right. Deck B's transport follows deck A. LEVEL becomes balance, FILTER becomes per-ear EQ, OFFSET becomes interaural time shift. Invert one deck and sum to get mid/side cancellation.
- **SPLIT** — two independent tapes, independent lengths and speeds. Eno-style different-length loops, collage, layering.

### Master

AGE · DELAY · REVERB · OUTPUT · MOD

**AGE** is a macro scaling the whole degradation complex: wow depth, flutter depth, tape hiss, electronics hiss, dropout rate, saturation. It does **not** touch head loss.

**MOD** is global modulation depth. Sources: internal LFO, head drift, playhead A, playhead B. The last three are modulation only a transport can produce — head drift in particular evolves over minutes and never repeats.

### Sources

- Stereo microphone array — two Primo EM272J omnis at the widest points of the body, ~200 mm apart, shadowed by the enclosure. This is a baffled stereo array, not binaural: it captures level and time difference but no pinna filtering. Spatial content is horizontal-plane only.
- IN A and IN B, 1/4" line/instrument. **IN A feeds deck A, IN B feeds deck B, always.**
- SD card, FAT32, WAV.

### Storage model

**The card is the reel. RAM is the length of tape across the heads.**

- LONG mode: 48 kHz, ~11.3 min total, ~5.6 min per deck
- FINE mode: 96 kHz, ~5.6 min total, ~2.8 min per deck — cleaner extreme slowdown
- Files longer than RAM stream through a sliding ~8 MB window (~87 s resident)
- A playlist is one spliced reel — a table maps reel position to file plus offset, and the engine only ever knows a position
- **Residency is not a mode.** See `REEL.md` — a three-second loop and a six-hour playlist are the same object. If the splice fits in the window, the machine does zero I/O regardless of where on the reel that splice sits
- **There is no random access.** You spool, and spooling takes real time. The reload happens during the travel. This is a feature: the limitation and the metaphor are the same thing.

---

## Hardware

**Electrosmith Daisy Seed3** — STM32H750 Cortex-M7 at 480 MHz, 65 MB SDRAM, 8 MB QSPI flash, TAC5242 codec at up to 192 kHz/32-bit, 31 GPIO, 14× 16-bit ADC, USB-C.

A **second TAC5242** on a TDM slot gives four simultaneous input channels, so mic and line are not exclusive. Same part twice, so the two input pairs are sonically matched — which matters in STEREO mode.

Other decisions:
- Sealed enclosure, 316 stainless, ~2.4 kg. Rear I/O bay under a drip lip, separate small door for the card, front edge carries the expression jack and power.
- User-replaceable battery **trays** on spring contacts — 2×18650 (~20 h recording) or 4×AA (~9–16 h depending on chemistry). A tray ID resistor enables charging only for the Li-ion tray. Buck-boost accepts 4.0–8.4 V and 5 V USB from one converter.
- Colour screen, backlight sleeping after 30 s.
- CV inputs and expression are all 1/4", DC-coupled, so any input accepts audio or CV. Audio-rate modulation of tape speed works for free.

### Budget notes

- CPU: two decks of 16-tap sinc is ~5–8 % of the M7 at 48 kHz. Grains at full density take it to ~30–40 %. Not the constraint.
- **Memory system is the constraint.** Put the 32 KB sinc table in internal SRAM (ideally DTCM), never SDRAM. Chunk SD refills into ~64 KB pieces so they don't stall audio reads on the shared bus. Invalidate the D-cache after DMA.
- ADC: ~13 pots against 14 usable channels before peripheral conflicts. Design in a CD4051 mux from the start. **Mux the pots, never the CV** — muxing divides the sample rate by 8, which is fine for a knob and fatal for audio-rate CV.

---

## Documents

| | |
|---|---|
| `PROJECT.md` | This file. What the machine is, the doctrine, architecture, milestones |
| `ENGINE.md` | The DSP in detail — every non-obvious choice and why |
| `REEL.md` | Storage and playback: the reel, the window policy, recording semantics |
| `REVIEW.md` | Architecture review of the harness + the platform refactor plan |
| `FEATURES.md` | Tape feature backlog — punch, head-gap echo, monitoring, ping-pong, physics — with designs and tests |
| `REFERENCE-softcut.md` | Study of monome's softcut engine (+ `softcut-core.tar.gz`) — prior art for the Deck, read before writing `deck.cpp` |
| `FIRMWARE.md` | Embedded practice: real-time rules, memory, structure, testing, debugging |
| `CAPABILITIES.md` | Full feature inventory with build status |

---

## Architecture

Build the firmware in a browser with the hardware faked underneath, then swap the bottom layer.

```
/core                  portable C++17, zero dependencies
  /dsp                 tape engine, resampler, filters, reverb, delay
  /app                 transport, deck state, modes, file handling, routing
  /ui                  screen drawing — fills a framebuffer, nothing else
  /hal                 abstract interface, header only
/hosts
  /daisy               libDaisy implementation
  /wasm                emscripten implementation
  /cli                 offline WAV in/out, for regression tests
/panel
  panel.json           control map + screen spec — single source of truth
/web                   React app: renders panel.json, hosts the WASM
```

### Three principles

1. **One core, thin hosts.** Nothing above the HAL line ever gets ported.
2. **The harness must lie in the right direction.** Quantise pots to 16 bits with a couple of LSBs of noise. Stall SD writes 50–300 ms. Cap RAM at 65 MB. Meter CPU against the M7's real budget and shout when it's blown. A simulator that's honest about being a computer lets you write code that only works on a computer.
3. **The panel is data, not code.** `panel.json` describes every control, its type, position, and hardware binding. The browser renders the UI from it; the firmware builds its control map from it.

### The HAL

Keep it under fifteen calls. Audio is not in it — the host calls `core::process()`.

```cpp
struct Hal {
  float    pot(int id);            // 0..1, already smoothed
  bool     button(int id);
  int      switch3(int id);
  int      encoderDelta(int id);

  void     setLed(int id, uint8_t r, uint8_t g, uint8_t b);
  void     blit(const uint8_t* fb);

  int      open(const char* path, Mode m);
  int      read(int fd, void* dst, size_t n);
  int      write(int fd, const void* src, size_t n);
  void     close(int fd);
  int      list(const char* dir, char** out, int max);

  uint32_t micros();
  size_t   ramBudget();
};
```

### The deck must not know the other deck exists

This is the most important structural rule in the codebase. A deck gets handed a buffer, a base, a length, a rate, and an input sample. It returns audio.

```cpp
float Deck::process(const int16_t* buf, uint32_t base,
                    uint32_t len, float rate, float in);
```

All three HEADS topologies then become the *global* layer choosing what to hand it:

- LINK passes both decks the same buffer
- STEREO passes deck B deck A's rate
- SPLIT passes each its own

The deck code is identical in all three cases and never branches on mode. All coupling lives in about ten lines you can read at a glance.

---

## Milestones

Each proves something specific. Don't move on until it does.

| | | |
|---|---|---|
| **M0** | Core extraction | Engine moved from the harness into `/core/dsp`. CLI host built. WAV-in/WAV-out bit-identical to the browser version. **This is the regression baseline for everything else.** |
| **M1** | WASM host | Same core, AudioWorklet, two hard-coded knobs. Proves the toolchain end to end |
| **M2** | HAL + panel.json | Controls arrive through the HAL, UI renders from data. The panel becomes tweakable — settle the screen question here |
| **M3** | Screen | Real graphics library compiled in, framebuffer to canvas. Design all views at real resolution, in real pixels |
| **M4** | Storage | OPFS as the card. Reels, playlist-as-spliced-tape, sliding window, spooling. Test with a fake 45-minute file and simulated stalls |
| **M5** | Full app | Transport, all three HEADS modes, overdub, bounce, CV routing, LED state. **A complete TL-1 running in a browser** |
| **M6** | Daisy host | Implement the HAL against libDaisy. Everything above it already debugged with breakpoints |

M0–M5 need no hardware. Build one deck completely before building the global layer.

---

## What the browser cannot tell you

Don't let a working simulator convince you the machine is finished.

- **Feel** — detents, knob resolution under a thumb, finding STOP without looking
- **The real codec** — noise floor, and whether the mic front end is quiet enough
- **CPU truth** — the meter is an estimate until it runs on the M7
- **Memory behaviour** — cache misses and SDRAM contention have no browser analogue
- **Everything physical** — sealing, heat, weight, whether the layout works with hands on it

---

## Still missing

Ordered by what it would undermine.

### Would make the machine sound wrong
- **Hysteresis.** Saturation is currently a memoryless `tanh`. Real tape's magnetisation has memory. Reference: Jatin Chowdhury's CHOW Tape Model (GPLv3) and its DAFx paper. There's an existing embedded port for the Multiverse pedal, so viability is proven. **Measure the RK4 Jiles-Atherton cost on the Seed3 before designing around it.**

### Would undermine "field recorder"
- **Pre-record buffer.** A rolling 5–10 s ring so hitting REC captures the seconds *before* you pressed it. The RAM and ring buffer already exist. This is the highest value/effort item on the list.
- **Record-path low cut.** Wind rumble ruins more takes than anything else. The per-deck filter is post-record and too late.
- **Input limiter or dual-gain record.**
- **Battery indicator, panel lock, remaining card time, clipping indication, safe eject.**

### Would undermine "tape machine"
- **Modulation noise** — hiss that rides the signal rather than sitting under it
- **Head bump** — LF lift from head-to-tape geometry, speed-dependent
- **Print-through, azimuth error** — pure character, cheap

### Specified, not built
- TDM for the second codec (below libDaisy's abstractions — days of firmware, not dollars)
- Bounce to card, markers while recording, level-triggered and scheduled record
- Spectrogram and reel screen views
- Stacking interface between machines

### Undecided
- Screen size and resolution
- Final control count. The harness currently has ~31 knobs; the panel supports ~13. The test is: **do you move this while playing, or set it once?** Performed → knob. Set → screen.

---

## Glossary

| Term | Meaning |
|---|---|
| **Deck** | One tape transport. Not "track" — track implies sync, and these are deliberately unsynchronised |
| **Splice in / length** | Loop points, as a fraction of the tape. Physically, where you cut the reel and join the ends |
| **Drift** | The gap between the two playheads, in seconds and samples. The phasing readout |
| **AGE** | Master macro scaling the degradation complex. Not head loss |
| **Head loss** | Playback-head lowpass whose corner tracks transport speed. Always on |
| **Erase coefficient / decay** | `buf = buf * erase + in`. 1.0 is infinite hold (Frippertronics), lower fades old layers |
| **Spray** | Randomisation of grain start position, bounded by the splice region |
| **ppm** | Parts per million of speed offset. 200 ppm on a 6 s loop is a cycle of about 8 hours |
