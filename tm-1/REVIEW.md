# TL-1 — Architecture & Code Review

An honest review of the harness as it stands (~2,200 lines, one file), written by the person who wrote it, followed by a staged refactoring plan toward a **tape lab platform** — the browser TL-1 as a real product that other machines (SM-1, future ZACOS devices) build on.

Companion to `PROJECT.md`, `ENGINE.md`, `REEL.md`, `FIRMWARE.md`.

---

## Part 1 — What is right and must survive the refactor

Worth stating first, because a refactor that loses these has failed.

**The single-source engine.** All DSP lives in `engineFactory()`; the worklet and the main-thread fallback provably run identical code. There is no second implementation to drift. The *mechanism* (stringification) must die, but the *property* is the foundation of everything.

**The reel model.** Position in reel coordinates, splice as the only loop, residency as an emergent property rather than a mode, the four window rules. This is the best-designed subsystem, it is tested, and it ports to firmware as-is.

**The no-allocation audio path.** Nothing in `render()` allocates. This discipline is what makes the C++ port a translation rather than a redesign.

**The doctrine comments.** The code explains *why* at every non-obvious point. Refactors move these with the code, never drop them.

**The test harnesses.** `reel-policy-test.js` and the regression sweeps have caught seven real bugs. They become the golden-file suite's seed.

---

## Part 2 — Findings

Ordered by severity. ✅ = already fixed during this review.

### F1. ✅ Silent worklet death (was: no audio, no error)
An incomplete constructor default killed `process()` with no visible symptom. Fixed three ways: complete defaults, a params-completeness check (greps every `p.X` the engine reads against the default object), and a try/catch in both hosts that surfaces engine exceptions on the status line. **Carry to firmware:** the equivalent is a hard fault handler that writes a reason code somewhere the screen can show it.

### F2. ✅ Window policy lived in the draw loop
`requestAnimationFrame` throttles to ~1/minute in background tabs — so a streamed reel would starve the moment you switched tabs, which is exactly how a drone machine gets used. Policy now also runs from a 500 ms interval. **Lesson for the split:** storage logic must never be coupled to rendering.

### F3. The build pipeline is the biggest liability
The workflow — Python string-replacement surgery on a 2,200-line file — has caused **three real bugs**: a silent failed edit that broke live granular, a duplicated `onFile`, and a stray brace. String surgery has no syntax awareness and no undo. This is not a code smell, it is an active bug generator, and it is the single strongest argument for the repo migration happening *now* rather than after the next feature.

### F4. The engine violates its own deck doctrine
`PROJECT.md` mandates that a deck must not know the other deck exists — all coupling in one place. The actual `render()` is one ~400-line loop with topology (`link`, `stereo`, `srcB`) branching *inside* the per-deck code. Forgivable in a harness; fatal to keep, because this is the code the C++ port will be transliterated from, and the port is where the `Deck` class boundary must exist. Restructure before porting, not during.

### F5. Coordinate spaces are handled by scattered arithmetic
Reel, window, splice, and buffer coordinates are converted inline at ~9 call sites (`rp`, `gp2 - wLo`, `ss - ws`, guard offsets). Each conversion is correct; the *pattern* is fragile — two of the seven bugs found this session were coordinate-space mistakes. Wants a single `ReelView` owning the mapping, with the engine reading through it.

### F6. The policy test duplicates the policy
`reel-policy-test.js` re-implements the window rules rather than importing them, so the test can pass while the app drifts. Symptom of the file being un-importable. Dies automatically with modules.

### F7. UI state and engine state can diverge
`play`, `freeze`, `rec` live in React state *and* in the engine, reconciled by telemetry hacks (the one-shot-stop sync). Works, but it is two sources of truth. The platform wants engine state as the single truth, UI as a projection of telemetry — which is also exactly the firmware's screen model.

### F8. Params are an untyped grab-bag
`setParams` merges arbitrary objects; nothing validates shape or range. The completeness check (F1) guards existence, not type or bounds. `panel.json` — already planned as the single source of truth — should generate the params schema, the UI controls, *and* the C++ struct.

### F9. Minor, listed for honesty
- Magic numbers inline (pan 0.86/0.34, head-loss 11 kHz, wow 0.63/1.17 Hz) → one constants block, which becomes `config.h`.
- `var` throughout the engine (worklet-portability choice) caused two scoping bugs; dies with the C++ port.
- Peak extraction reads up to 10 minutes of blob on the main thread at load — jank on slow disks; move to the policy interval or a worker.
- Waveform view shows only the first 10 minutes of a long reel; the REEL screen view is the real answer.
- The knob is mouse/touch-draggable but keyboard support is nominal.

---

## Part 3 — The platform refactor

"Platform" means: the browser TL-1 stops being an artifact and becomes the reference implementation — the thing zacos.tech serves, the codebase other machines share, and the source the firmware is ported from. Four phases, each shippable.

### Phase 0 — The repo (do this before touching any code)

```
tapelab/
├── packages/
│   ├── engine/          the DSP, as ES modules (still JS)
│   │   ├── src/
│   │   │   ├── resampler.js  filter.js  tape.js  grains.js
│   │   │   ├── deck.js       machine.js  reel-view.js
│   │   │   ├── delay.js      reverb.js   modulation.js
│   │   │   └── params.js     defaults + validation, generated
│   │   └── test/
│   │       ├── golden/       reference WAVs + runner
│   │       ├── reel-policy.test.js
│   │       └── regression.test.js
│   ├── reel/            storage: blob reels, window policy, marks
│   ├── ui/              React app; renders panel.json
│   └── panel/           panel.json + schema + codegen
├── apps/
│   └── tl1/             the TL-1: panel.json + entry, builds the site
└── tools/
    └── render-cli.js    WAV in → engine → WAV out (golden files)
```

- **Two esbuild entries** — `app` and `worklet` — both importing `packages/engine`. This kills the `toString()` hack while keeping the single-source property: same modules, two bundles.
- Git from commit one. Licences (GPLv3 code, CC BY-SA docs) in commit one.
- Every Python-surgery habit dies here. Edits become normal module edits with syntax checking, diffs, and revert.
- CI is one command: `node tools/test-all.js` — regression + policy + params-completeness + a headless mount check. All four already exist; they just need a home.

*Exit criterion: the built HTML is byte-for-byte behaviourally identical to today's. No feature work in this phase.*

### Phase 1 — Structure to match the doctrine (still JS)

1. **`Deck` becomes a class** with the signature from `PROJECT.md` — handed a buffer view, a rate, an input sample; returns audio; never sees topology.
2. **`Machine` owns the coupling**: the ten lines that decide what each deck is handed (LINK/STEREO/SPLIT), plus master FX. This is F4 fixed, and it is done *here* so the C++ port transliterates a correct structure.
3. **`ReelView`** owns every coordinate conversion (F5): `toBuffer(reelPos)`, `spliceWrap(pos)`, `inWindow(pos)`. The engine stops doing offset arithmetic.
4. **`packages/reel`** exports the window policy as the one implementation the app *and* the tests import (F6), driven by a timer, never rAF (F2's lesson made structural).
5. **Golden files generated and committed.** `render-cli.js` renders the fixed test set (varispeed sweeps, grains, overdub, freeze, streamed reel) to WAVs. These are the contract for everything after — including the C++ port, whose M0 exit test is bit-identical output against these exact files.

*Exit criterion: all tests green against the committed golden files; the deck code contains zero topology branches.*

### Phase 2 — Platform features (what makes it a product, not a demo)

In value order:

1. **Bounce / export** — render the master to a WAV download. The machine can finally *produce* something. Also the last golden-file gap: bounce is the render path users will hear.
2. **Sessions** — reel reference + all settings as a saveable/loadable JSON (`.tl1`). Blob reels persist via OPFS so a session survives reload. This is the card, honestly simulated.
3. **Preset URLs** — settings (not audio) encoded in the fragment. A drone patch becomes a shareable link; this is the growth mechanism for a free instrument.
4. **`panel.json` codegen** — schema → params defaults + validation (F8), → UI control layout, → (later) the C++ params struct. One file, three artifacts, no drift.
5. **The REEL screen view** — the six-hour navigator with marks; retires the 10-minute waveform limit.
6. **Machine variants as data** — SM-1 or a stripped "player" build is a different `panel.json` + feature flags over the same packages. The platform claim becomes true here.

### Phase 3 — The C++ core (M0–M6, unchanged but re-grounded)

The existing milestone ladder in `PROJECT.md` stands, with one amendment from this review: **M0 ports the *Phase 1* structure** — `Deck`, `Machine`, `ReelView` — not today's monolith loop. The golden files from Phase 1 are the acceptance test, and `reel-policy-test.js` gets a C++ twin driving the same `ReelManager` the firmware's main loop will use.

### Sequencing note

Phases 0 and 1 are a week of evenings each, roughly. Phase 2 items are independent and can interleave with hardware work once the boards arrive. The only hard rule: **no new engine features until Phase 0 is done** — every feature added through string surgery is a feature added to the pile that must be re-verified after the migration, and the surgery itself keeps generating bugs at a measured rate of about one per session.

---

## Part 4 — Bug ledger (this build, for the record)

Seven engine/host bugs found and fixed across the harness's life, kept here because each is a class, not an instance:

| Bug | Class | Guard now in place |
|---|---|---|
| Duplicate React from absolute-path import | build resolution | relative imports; dies with repo |
| Deck component declared in render body | React identity | comment + plain-function call |
| `mSpeed` used before `var` declaration | JS hoisting | modulation resolved before consumers; dies in C++ |
| `rvMix` accumulated per sample | loop-invariant mutation | locals for modulated values |
| `var live` shadowed source flag | function scoping | renamed; dies in C++ |
| Live grains spawned in wrong coordinate space | silent failed edit | assertions on every scripted edit; dies with repo |
| Missing modulation defaults killed worklet silently | partial init | completeness check + process() try/catch |
| Stray pointerleave "released" scrubs that never began, restoring an uninitialised 0 rate | UI event modeling | releases require an in-flight press (`e.buttons`) + momentary actions carry an active flag |
| PLAY presses raced their own stale telemetry echo (F7 realised) — took 2–3 presses to stick | dual state truth | engine emits stop *events*; UI never diffs engine state |
| Per-hop FFT in the frozen path: 19ms inside a 2.67ms block, ~2 dropouts/sec, heard as "choppy" | unbounded work in the audio callback | build chunked and resumable; **measure the callback before changing the maths** |

The pattern worth noticing: **three of seven were caused by the tooling, not the domain.** That is the review's core argument in one line.
