# TL-1 Tape Lab — Handoff

**Read this first. It is the entry point.**

You are picking up a hardware/software instrument project mid-flight. Everything you need is in this package. This document tells you what exists, what state it is in, what you are allowed to do next, and the specific ways this project has already burned people.

---

## What the TL-1 is

A two-deck varispeed tape machine. Real transport, real reels, sealed steel enclosure, built-in microphones, batteries, SD card, no computer required. Part of the ZACOS line (SM-1 Sleep Machine is its sibling).

One sentence, and it is load-bearing: **a modern tape recorder with two decks.** Every feature has to be describable as something a tape machine does. That constraint is not decoration — it has repeatedly produced better engineering than the obvious approach (see "Why the metaphor keeps winning" below).

The **browser harness** in `app/` is the reference implementation: complete, playable, tested. The hardware does not exist yet.

**Who you are working with:** an experienced software engineer and ambient musician, 20 years in, Director of Engineering by day. No DSP background before this project, no embedded experience. He makes the architecture and taste decisions; he does not need concepts dumbed down, and he *does* need you to be honest when something is unproven.

---

## Read in this order

| # | File | Why |
|---|---|---|
| 1 | `docs/PROJECT.md` | Doctrine, controls, hardware, milestones. **The DOCTRINE block is hard constraints, not preferences.** |
| 2 | `docs/REVIEW.md` | Architecture review + the refactor plan. Contains the gate you must respect. |
| 3 | `docs/ENGINE.md` | How the DSP actually works and why each choice was made. |
| 4 | `docs/REEL.md` | The storage model: reels, splices, the window policy. The best-designed subsystem. |
| 5 | `docs/FEATURES.md` | The backlog. 13 specs, each with design, tests, and doctrine checks. |
| 6 | `docs/FIRMWARE.md` | Read before touching anything that will run on hardware. |
| 7 | `reference/REFERENCE-softcut.md` | Prior art. Read before writing `deck.cpp`. |

`docs/CAPABILITIES.md` is an earlier feature snapshot, partly superseded. `docs/TL-1-kickstarter.md` is campaign copy, not engineering.

---

## THE GATE — read this before proposing any work

> **No new engine features until the Phase 0 repo migration in `REVIEW.md` is done.**

The current app is a single ~2,900-line `.jsx` file that has been edited by Python string-replacement surgery. That tooling caused **three of the seven real bugs** in this project's history, including one that silently produced no audio at all. Phase 0 turns it into a proper module tree with two esbuild entries.

If the user asks for a feature from `FEATURES.md` and Phase 0 has not happened, say so and offer to do Phase 0 instead. This is his own rule; he will back you up.

Exceptions: bug fixes, measurement, documentation, and design work are always fine.

---

## Current state

### Works, tested, in the shipped build
Two decks with continuous varispeed through zero (±4×) with real transport inertia · reel model with splice, streaming, marks and track boundaries · 16-tap windowed-sinc resampling (512 phases) · head loss, wow, flutter, dropouts, saturation, two hiss sources under AGE · sound-on-sound recording with erase coefficient · granular playheads from tape or live input · **spectral freeze** · per-deck resonant-capable filter and LFO · global modulation bus · delay, reverb · LINK/STEREO/SPLIT topologies · mic and line input · playlist-as-one-reel · int16 tape storage.

### Specified but NOT built
Master filter · output stage (drive + tone) · filter resonance as a control · reverb type toggle (spring/plate/room) · feedback routing (`FEATURES.md` §13) · envelope follower as a mod source · the reel view (mockup only, in `app/tl1-reel-view.html`) · everything else in `FEATURES.md` §1–§12.

### Missing and important
**Bounce / export.** The machine cannot produce a file. You can play it beautifully and lose everything. This is ranked first in `REVIEW.md` Phase 2 and it is the single most valuable thing to build after Phase 0.

**Sessions.** No save/load; a page refresh loses the state.

### Not started at all
The hardware. The analog front end — preamps, converters, grounding, PCB layout — is completely unproven and is the highest-risk part of the whole project. Nothing in this package de-risks it.

---

## Running and building

**To run:** open `app/tl1-tape-lab.html` in a browser. Serve it over http if you can; `file://` restricts microphone access. It is fully self-contained (React and compiled CSS inlined).

**To rebuild after editing `app/tl1-tape-lab.jsx`:**
```
cd build && ./build.sh
```
That regenerates the HTML and runs the two guard tests. Needs node and npx.

**To test:**
```
node tests/reel-policy-test.js     # 16 cases against a simulated 6-hour reel
```
Everything else was tested with throwaway harnesses that eval the engine factory out of the `.jsx`:
```js
const src = fs.readFileSync('app/tl1-tape-lab.jsx','utf8');
const a = src.indexOf('function engineFactory()');
const b = src.indexOf('const TapeEngine = engineFactory();');
const TE = eval('('+src.slice(a,b)+')')();
```
Phase 1 replaces this with committed golden files. Until then, write a throwaway harness for anything you change — the engine is pure and headless, so this is easy and it is how every bug below was found.

---

## How this project has burned people

Seven engine/host bugs, kept as classes rather than instances. The full table is in `REVIEW.md`. The three lessons worth carrying:

**1. Measure the callback before you change the maths.** The freeze feature went through four rewrites because it "sounded choppy." Three of them were DSP tuning. The actual cause was a 4096-point FFT running inside a 128-sample audio block: **19 ms of work against a 2.67 ms deadline**, dropping audio twice a second. The algorithm was fine. Dropouts sound exactly like bad DSP. Time your render loop first.

**2. Incomplete initialization kills an AudioWorklet silently.** Ten missing modulation defaults meant `process()` threw on its first block — no error, no console output, no audio, ever. There is now a params-completeness check in `build.sh` and a try/catch in both hosts. Do not remove them.

**3. Never diff engine state in the UI.** PLAY took 2–3 presses to stick because the UI compared itself against telemetry that was one round-trip stale, and "corrected" fresh presses away. The engine now emits stop *events*. Same rule applies to every future control.

---

## Why the metaphor keeps winning

Not sentiment — an observed pattern, and the reason the tape-vocabulary rule is enforced:

- *"It should behave like a reel, however long"* produced the window-pinning policy (`REEL.md` Rule 2), which is a genuinely good streaming architecture.
- *"The reel stops but the heads keep spinning"* produced freeze.
- The physical gap between record and play heads **is** a delay line whose time scales with transport speed, and the erase coefficient **is** its feedback amount — so the entire Space Echo topology costs one new parameter (`FEATURES.md` §2).
- Splice-as-the-only-loop collapsed three coordinate systems into one.

When you are stuck, ask what the tape would do. It has outperformed the software-engineering instinct repeatedly.

---

## Open decisions awaiting the user

Do not resolve these on your own; surface them.

- **Panel knob count.** ~31 controls in the harness, ~13 on the panel. The test is "does it change while you play?" Resonance was moved *onto* the panel by that test (he plays cutoff and resonance together); concentric pots are the current proposal.
- **Freeze: momentary or latching**, or press-vs-hold.
- **Speed knob taper** — linear in rate (honest to tape) vs exponential (honest to ears). Now that freeze makes SPEED a drone-pitch control this matters more.
- **Transport slew as a character parameter** — 35 ms currently; Bedtime's *reels* used 500 ms and it is a large part of that machine's feel.
- **Form factor** — settled at roughly Tonverk/Octatrack proportions, ~300 × 176 × 63 mm, wide and shallow.
- **Battery** — dual trays proposed: 2× 18650 (dense, rechargeable) and 4× AA (scavengeable anywhere).

---

## What not to do

- **Do not add chromatic playing, quantized pitch, or a sequencer.** Explicitly rejected. This is a transport you operate, not a synth you play.
- **Do not cap a control for taste.** Doctrine: the machine lets you go wild. The filter self-oscillates, feedback can build past unity, sound-on-sound can run away. The only permitted limits protect *hardware* (DC blocker, limiter on speaker/headphone outs) — never character. Runaway tests assert *finite*, not *quiet*.
- **Do not let a deck know the other deck exists.** All coupling lives in `Machine`. The current engine violates this and `REVIEW.md` F4 says fix it before the C++ port.
- **Do not do unbounded work in the audio path.** Ever. See lesson 1.
- **Do not narrate the tooling.** Write the code, run the tests, report what the measurements say.

---

## Package contents

```
HANDOFF.md               this file
app/
  tl1-tape-lab.html      the instrument — open this
  tl1-tape-lab.jsx       source (single file; Phase 0 splits it)
  tl1-reel-view.html     mockup of the proposed bar-screen home view
  varispeed-visualizer.html   interactive sinc-interpolation explainer
docs/
  PROJECT.md ENGINE.md REEL.md FIRMWARE.md REVIEW.md FEATURES.md
  CAPABILITIES.md TL-1-kickstarter.md varispeed-algorithm.mermaid
tests/
  reel-policy-test.js    16 window-policy cases; the seed of the golden-file suite
build/
  build.sh entry.jsx tw.css tailwind.config.js package.json
design/
  tl1-panel-CURRENT-v7.svg   current panel layout
  tl1-panel-v2..v6.svg       earlier iterations, kept for history
  tl1-lamp-colours.svg tl1-palettes.svg tl1-gunmetal-reds.svg
  listening-machine-panel.svg listening-machine-bom.xlsx
reference/
  REFERENCE-softcut.md   study of monome's softcut — the closest prior art
  softcut-core.tar.gz    its source (GPLv3)
```

---

## The next three things, in order

1. **Phase 0** — the repo migration in `REVIEW.md`. Unglamorous, gates everything else.
2. **Phase 1** — `Deck` / `Machine` / `ReelView`, then generate and commit golden files.
3. **Bounce / export** — the machine learns to finish something.

Then the `FEATURES.md` backlog, and M0 (C++ extraction) when hardware arrives.
