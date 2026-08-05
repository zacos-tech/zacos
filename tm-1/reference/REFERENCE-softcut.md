# Reference — softcut, read for the TL-1

A study of monome's **softcut** (github.com/monome/softcut-lib, GPLv3, by Ezra Buchla) — the C++ engine underneath norns' tape layer, and therefore underneath *reels* and the whole norns looper tradition. 2,334 lines of core. This is the most battle-tested open-source implementation of approximately our `Deck`, running on thousands of devices since 2018.

Why it matters to us: everything *reels* does in 800 lines of Lua is possible because softcut solved the hard per-sample problems one layer down. Reading it is reading five years of shipped answers to questions we've been answering from first principles. Where we converged independently, that's validation; where we diverged, one of us is wrong or the requirements differ — both worth knowing.

Local copy: `softcut-core.tar.gz` alongside this file. License is GPLv3 — same as our firmware plan, so even direct reuse would be compatible, though everything below is study-not-copy.

---

## The architecture, mapped to ours

```
softcut                                  TL-1
─────────────────────────────────────    ─────────────────────────────────
Softcut<N>      N voices, shared bufs    Machine        2 decks, reels
 └─ Voice       rate, loop, rec/pre,     └─ Deck        rate, splice, decay,
    │           SVF filter, slews            │          filter, transport
    └─ ReadWriteHead                         └─ (read head + record head)
        ├─ SubHead[2]  ← crossfading pair        single head + guards
        │   ├─ Resampler (write path!)           write @ position-walk + AA filter
        │   └─ peek4() = Hermite read            16-tap windowed sinc read
        └─ FadeCurves  precomputed tables        trapezoid-cosine env, splice xfade
```

Same decomposition, discovered twice. The differences are the interesting part.

---

## Discovery 1 — the dual-subhead crossfade is their universal answer to clicks

A softcut voice is **two** complete play/record heads, and only the crossfade between them ever reaches the output:

```cpp
// ReadWriteHead::processSample — the entire per-sample voice
*out = mixFade(head[0].peek(), head[1].peek(), head[0].fade(), head[1].fade());
head[0].poke(in, pre, rec);
head[1].poke(in, pre, rec);
takeAction(head[0].updatePhase(start, end, loopFlag));
takeAction(head[1].updatePhase(start, end, loopFlag));
head[0].updateFade(fadeInc);
head[1].updateFade(fadeInc);
dequeueCrossfade();
```

Loop wrap, position jump (`cutToPos`), stop, start — every discontinuity is the *same mechanism*: one subhead fades out where it was, the other fades in where it's going. There is no special-case click handling anywhere because there are no special cases.

**Our position:** we solved each seam separately — splice wrap (planned §9 crossfade), stranded grains (latched fade), window swaps (reel coordinates + guards). Softcut's lesson is that these are one problem. For the C++ `Deck`, a two-subhead read stage is worth serious consideration: it would give us splice-angle (§9), clickless mark-jump/spooling arrival, *and* punch edges (§1) from one mechanism. Cost: 2× read computation — at our 16 taps that's real, though the second head only needs to run during fades.

## Discovery 2 — softcut already has our head gap, and it's called recOffset

```cpp
void setRecOffsetSamples(int d);   // ReadWriteHead.h
```

The write head's position is offset from the read head by a settable number of samples (norns exposes it as `softcut.rec_offset()`, default ≈ −8 samples to compensate head ordering). This is **§2 head-gap echo's core mechanism, shipped and stable for five years** — just never pushed to musical gap lengths. Direct validation that the write-behind-read topology works per-sample at varying rates. Our spec extends it to hundreds of milliseconds and speed-dependent delay; the primitive is proven.

## Discovery 3 — the write path is a resampler, and that's the honest architecture

Our record head walks positions and applies an anti-alias filter tracking speed. Softcut instead pushes each input sample through a per-voice `Resampler` that emits *0, 1, or several* write frames depending on rate — writing more densely at high rate, sparsely at low:

```cpp
// SubHead::poke — write path
int nframes = resamp_.processFrame(in);          // rate-dependent frame count
preFade_ = pre + (1.f - pre) * fadeCurves->getPreFadeValue(fade_);
recFade_ = rec * fadeCurves->getRecFadeValue(fade_);
for (int i = 0; i < nframes; ++i) {
    y = clip_.processSample(src[i]);             // soft clip on the way in
    buf_[wrIdx_] *= preFade_;                    // ← pre  = our erase coefficient
    buf_[wrIdx_] += y * recFade_;                // ← rec  = record level
    wrIdx_ = wrapBufIndex(wrIdx_ + inc_dir_);
}
```

Three things to take:
- `pre` **is our erase coefficient**, name-for-name, semantics identical — independent convergence on the sound-on-sound math, down to `buf = buf·pre + in·rec`.
- **The fades shape pre and rec during head transitions**: while a head fades, `pre` slides toward 1 (preserve) and `rec` toward 0 (write nothing). Every punch edge is automatically a crossfaded punch. This is §1's "5 ms crossfade" requirement implemented as a *property of the head* rather than a feature — cleaner than our plan.
- The **soft clipper on the write value** is their answer to overdub accumulation; ours is honest int16 clamp. Theirs is kinder, ours more truthful. A/B someday.

Their resampler is deliberately humble (4-frame input ring, Hermite, "ultra-simple" in the comments) — for the write path that's defensible, since content is about to be re-read through interpolation anyway.

## Discovery 4 — softcut reads at Hermite quality, full stop

```cpp
float SubHead::peek() { return peek4(); }   // 4-point Hermite, x-form
```

The interpolator is the *same inlined Hermite polynomial we use for grains* — literally the identical x-form coefficients. There is no sinc anywhere in softcut. The entire norns tape ecosystem — every wow-drenched ambient set played through it — runs on 4-point reads.

Two honest readings, both true: our 16-tap main head is a real, measurable quality step over the state of the art in this niche; and Hermite has proven musically sufficient for a decade of beloved instruments, which calibrates how much the last 12 taps matter (the answer: at extreme slowdown, where we live — that's exactly where truncation error concentrates, and exactly softcut's known weakness per its own docs).

## Smaller notes

- **FadeCurves** are precomputed shaped tables (with settable shape) read by both the output mix and the rec/pre shaping — our trapezoid-cosine env and their curves are cousins. Theirs being *settable* is a nice touch we get for free via RAMP.
- **Per-voice SVF filter with slewed params** — same decision as our per-deck FILTER, same topology family.
- **Everything is slewed** (rate, level, pan) with per-parameter slew times — the *reels* 0.5s glide is just `rate_slew_time`. Confirms transport inertia as a first-class parameter, not a constant (relevant to §11 brake and the §12c A/B).
- **Fixed RAM buffers, no streaming.** Softcut voices address a shared in-memory buffer (norns gives it ~5.8 minutes mono). No card, no windows, no reel abstraction — the entire `REEL.md` layer is territory softcut never entered. That's our largest genuine novelty confirmed by absence.
- `phase_quant` events drive UI from the engine — engine-authoritative telemetry, same direction of dependency we chose (and *reels*' flutter hack violated).

## What we deliberately don't take

- **N-voices-over-shared-buffers** as the top abstraction: right for a patchable music computer, wrong for a two-deck tape machine with a lid. Our `Machine` owns two decks and a reel each; the constraint is the instrument.
- **OSC/command plumbing** (their client layer) — panel.json and the params schema are our answer.
- Their **buffer-index write walk** in place of an AA-filtered record path — we keep the filter; their resampler is the fallback if the filter proves wrong on hardware.

## The one-line verdict

Softcut is the proof that our `Deck` decomposition is right, the source of one mechanism worth adopting (dual-subhead crossfade), one direct validation (recOffset = head gap), one calibration (Hermite sufficiency), and one confirmation of novelty (no streaming layer exists in this world). Read `ReadWriteHead.cpp` and `SubHead.cpp` before writing `deck.cpp` — it's an afternoon, and it's the closest thing our M0 has to prior art.
