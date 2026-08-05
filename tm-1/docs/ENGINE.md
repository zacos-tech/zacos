# TL-1 — Engine Reference

Detailed explanation of the DSP in `tl1-tape-lab.jsx`, why each part is the way it is, and what changes when it becomes C++ on the Daisy.

Read `PROJECT.md` first for the doctrine and architecture. This document is about the code.

---

## 0. Structure

All the DSP lives inside one function:

```js
function engineFactory() { ... return TapeEngine; }
const TapeEngine = engineFactory();
```

The main thread calls it directly. The AudioWorklet gets the identical code via `engineFactory.toString()` embedded in a string. **One source of truth, two hosts.** This is deliberately the same split the firmware will use — swap in a C++ core and a libDaisy `AudioCallback` and the structure is unchanged.

`TapeEngine.render(L, R, n, inL, inR)` is the entire audio path. It allocates nothing.

---

## 1. The resampler

This is the heart of the machine and the part most worth understanding.

### The problem

Digital audio is a list of sample values at fixed spacing. Playing at half speed means producing twice as many output samples, so you constantly need the value *between* two stored samples. That value has to be reconstructed.

Slowing down cannot alias — every artefact you hear is reconstruction error. Speeding up *can* alias, because the source has detail too fine for the coarser output grid.

### Windowed-sinc polyphase table

`buildSinc()` precomputes 512 sub-sample phases × 16 taps, Blackman-windowed, normalised per phase. 8192 floats, 32 KB, built once at construction.

```js
for each phase p:
    frac = p / 512
    for each tap k in 0..15:
        x  = k - 8 + 1 - frac           // distance from the read point
        s  = sinc(x)                     // sin(pi x)/(pi x), 1 at x=0
        wp = (k + 1 - frac) / 16         // window position — slides with frac
        w  = 0.42 - 0.5cos(2pi wp) + 0.08cos(4pi wp)
        t[p][k] = s * w
    t[p] /= sum(t[p])                    // unity DC gain, per phase
```

Three details decide whether this sounds transparent or shimmery, and most references skip them:

**The window slides with the fractional position.** Note that `wp` depends on `frac`. The obvious implementation windows the fixed tap indices instead, which makes the kernel asymmetric as `frac` moves — audible as the frequency response wobbling in sync with the varispeed.

**Every phase is normalised to unity DC gain.** Without that division you get amplitude modulation at the rate the fractional part sweeps. It's usually misdiagnosed as aliasing. It's a level shimmer.

**512 phases is enough to skip inter-phase interpolation.** With 16 taps, phase quantisation error is below the noise floor, so a truncating lookup is fine. Below ~256 phases you'd need to blend adjacent rows.

### What a lookup actually is

At read position 1000.2988: integer part 1000, fraction 0.2988, so row `(0.2988 × 512) | 0` = 153. That row holds 16 weights, applied to `buf[993..1008]`. Multiply, sum, done. 16 multiplies, 15 adds.

The two nearest taps carry most of the weight (~0.85 and ~0.36 at that phase, in proportion to how close the read point is to each). About half the weights are negative — that's the ripple in the sinc shape subtracting overshoot. The outermost weights are near zero because the Blackman window fades the truncation edge, which is what stops the truncated kernel from ringing.

### The fast path

The 16-tap window only straddles the loop splice for 16 samples out of the whole loop. So `read()` tests once whether `i-7` and `i+8` are both inside the region:

```js
var lo = i - HALF + 1, hi = i + HALF;
if (lo >= 0 && hi < len) {
  var bp = base + lo;
  for (k = 0; k < TAPS; k++) acc += SINC[o + k] * buf[bp + k];
  return acc;
}
```

That branch is taken 99.99 % of the time and removes 16 modulo operations per sample per head.

### The other two interpolators

`interp` selects between them, and the A/B is the whole point of the harness:

- **0 — linear.** Its frequency response varies with fractional position. Audible as smeared, fluttery treble.
- **1 — 4-point cubic Hermite.** ~−40 dB error. What most hardware ships.
- **2 — windowed sinc.** Effectively transparent below 1×.

### Known limitation

**The kernel is not scaled for rates above 1×.** A correct resampler widens the kernel by 1/rate when decimating. This one doesn't, so speeding up aliases. Acceptable given the machine's priority is the slow direction, but it should be fixed before release — the fix is to scale the sinc argument and re-normalise, which means either a second table or computing on the fly.

---

## 2. Position accumulation

```js
this.pos = [0, 0];   // plain JS numbers, i.e. float64
```

**This is not incidental.** In float32, a 24-bit mantissa means that ~20 seconds into a buffer your position resolution has degraded to about 1/16 of a sample, and it gets worse the longer the loop. You hear it as jitter that increases over time — which is fatal on a machine whose signature feature is two heads drifting apart over ten minutes.

The browser gets the right answer by accident. **The firmware must not rely on that.**

### Firmware version: 32.32 fixed point

```c
int64_t inc = (int64_t)(rate * 4294967296.0);
pos += inc;
if (pos >= len_fx) pos -= len_fx;        // len_fx = (int64_t)len << 32
else if (pos < 0)  pos += len_fx;

uint32_t idx  = pos >> 32;
float    frac = (pos & 0xFFFFFFFF) * (1.0f / 4294967296.0f);
uint32_t ph   = (pos >> 23) & 511;       // sinc phase, 512 entries
```

Exact wrapping, no accumulated error ever, and speed resolution around 2×10⁻¹⁰ — parts per billion, which is what makes ppm-scale phasing meaningful. The integer half addresses 4.29 billion samples, about 25 hours at 48 kHz, so precision is never the binding constraint; RAM is.

---

## 3. Tape character

### Head loss — the most important one

```js
var fc = 11000 * Math.max(0.04, Math.min(3, rr));
var kc = 1 - Math.exp(-TWO_PI * fc / sr);
this.hl[d] += kc * (x - this.hl[d]);
```

A one-pole lowpass whose corner **scales with transport speed**. Real playback-head response is proportional to tape speed, so slow tape genuinely loses treble beyond the pitch shift.

This coupling is most of the illusion. Turn it off at 0.25× and the effect collapses into "pitched-down audio". **It is deliberately not under AGE** — AGE controls how old the tape is, and at AGE 0 the machine must still sound like a tape machine rather than a clean sampler.

### Wow and flutter

Two LFOs for wow (0.63 Hz and 1.17 Hz, summed 0.7/0.3) and one for flutter (8.4 Hz, itself amplitude-modulated by the second wow oscillator so it isn't clinical). They multiply the read rate.

```js
var spd = Math.min(3, 1 / Math.max(0.15, r0));
var wowD  = (0.0012 + age * 0.0070) * spd;
var flutD = (0.0003 + age * 0.0018) * spd;
```

**Depth scales up as speed drops.** A real capstan holds pitch worse at low speed, and that instability is a large part of why slow tape reads as tape.

### Hiss, in two components

```js
x += this.rnd() * hissTape * (0.3 + 0.7 * min(1, |rate|));
x += this.rnd() * hissElec;
```

Tape hiss is physically on the medium, so it varies with transport speed. Electronics hiss doesn't. Two sources, one scaled and one not. Almost nobody does this and it's audible.

### Dropout

A slow random amplitude sag, gated so it only becomes meaningful at high AGE. Recovers with a one-pole so it breathes back rather than switching.

### Saturation

`Math.tanh(x * sat) / Math.tanh(sat)`, where `sat` rises with AGE. Normalised by `tanh(sat)` so turning AGE up doesn't also turn the volume up.

**This is the weakest part of the model.** It is memoryless — a given input level always maps to the same output. Real tape's magnetisation depends on where it's been. See "Still missing" in `PROJECT.md`.

### AGE as a macro

One knob scaling wow depth, flutter depth, both hiss components, dropout rate, and saturation together. At 0 it's fresh tape; at 100 % it's a cassette that lived in a car. The reason it works as a single control is that these are all consequences of the same physical fact, so moving them together is more honest than exposing five knobs.

---

## 4. Filter

A TPT (topology-preserving transform) state-variable filter — zero-delay feedback, stable under modulation, cheap.

```js
var v3 = x - ic2;
var v1 = a1 * ic1 + a2 * v3;
var v2 = ic2 + a2 * ic1 + a3 * v3;
ic1 = 2 * v1 - ic1;
ic2 = 2 * v2 - ic2;
return amt < 0 ? v2 : (x - k * v1 - v2);   // lowpass : highpass
```

**Bipolar on one knob.** Negative sweeps a lowpass from 18 kHz down to 80 Hz; positive sweeps a highpass from 20 Hz up to 6 kHz; a dead zone at centre returns the input untouched so "open" is exactly open.

The dead zone matters more than it looks — it means the knob has a findable off position, which is the same reasoning as centre-detented attenuverters.

---

## 5. Grains

### Framing

**A grain is a very short splice, and density is more playheads on it.** Both are vocabulary the transport already uses — LINK is literally two heads on one tape. This is the existing architecture pushed further, not a granular engine bolted on.

Grains inherit everything: transport rate, wobble, head loss, AGE. So what gets scattered is *degraded tape*, not clean samples. That's what should make this sound different from a Clouds descendant.

### Parameters

| | |
|---|---|
| **SIZE** | 5 ms to 500 ms, logarithmic (`0.005 * 100^size`) |
| **DENS** | 0–12 overlapping grains. 0 means a single playhead — the machine without grains |
| **SPRAY** | Position randomisation, **bounded by the splice region** |
| **RAMP** | Envelope shape, near-rectangular to fully rounded |

Spray being bounded by the splice is the detail that keeps this honest. The machine's strongest opinion is that there's no random access — you spool, and spooling takes real time. Grains jump around dozens of times a second, which contradicts that. Bounding them inside a region you had to spool to and cut means **random access is bounded by a physical splice.**

### Scheduling

A slot allocator over a fixed 12-grain pool. `gNext` counts down by one per sample; when it hits zero a free slot is found, given a start position, a duration, and an age of zero. Interval is `gDur / dens`, so density and size interact the way they do on real granulators.

### Envelope

```js
genv(ph, r) {
  var rr = 0.015 + r * 0.485;
  if (ph < rr)     return 0.5 - 0.5 * cos(pi * ph / rr);
  if (ph > 1 - rr) return 0.5 - 0.5 * cos(pi * (1 - ph) / rr);
  return 1;
}
```

A trapezoid with cosine ramps. At RAMP 0 the fades are 1.5 % of the grain — hard-edged and percussive. At RAMP 1 they're 50 % each side, which is Hann. **Some fade is always present.** Zero would click on every grain, and that is the one thing that makes a granulator sound broken rather than characterful.

### Interpolation choice

Grains use `readFast()` — 4-point Hermite, not the 16-tap sinc. Each grain is short and windowed, so the envelope masks most of the interpolation error. That's a 4× cost reduction exactly where it matters least, and it's what keeps the CPU estimate reasonable at 12 grains × 2 decks.

### Level normalisation

```js
x *= 1.5 / sqrt(dens * (0.35 + 0.65 * (1 - ramp * 0.6)));
```

Overlapping grains sum, and the amount they sum by depends on both density and how much of each grain sits at full amplitude. Normalising by both means SIZE, DENS and RAMP change *texture* rather than *level*. Measured RMS holds within about a dB across the full range.

### Live source

`gLive[d]` switches a deck's grains to read from a 4-second rolling input ring instead of the tape.

```js
var back  = gDur * max(1, |rate|) * 1.05;
var extra = |rnd()| * spray * (INLEN - back - 8);
sp = inW - back - extra;
```

Grains spawn far enough behind the write head that one running at `rate` finishes before it catches up to the present. In live mode SPRAY reads as a delay in seconds rather than a percentage, because that's what it is.

**Varispeed still applies**, which is the interesting part: at 0.5× you get a real-time octave down of the room, and at negative rates the grains run backwards while you play forwards.

With DENS at 0 and LIVE on, the input passes straight through the deck strip — filter, level and invert still apply — so one deck can be a live channel with tape colour while the other plays a loop.

---

## 6. The record head

```js
buf[n] = buf[n] * erase + in
```

`erase` at 1.0 is infinite hold — layers accumulate forever, which is Frippertronics. Lower values fade old material over a number of passes. Applied **only while recording**, so a loop doesn't quietly decay while you sit and listen.

### The resampling problem

This is the subtle part and the one place the machine could sound broken.

Input arrives at one sample per output sample. The tape only advances by `rate`. Below 1×, several input samples land on one tape position, so everything above the tape's *effective* Nyquist folds back as aliasing. The read path is protected by the sinc window; **the write path is protected by nothing unless you build it.**

```js
var kIn = 1 - Math.exp(-TWO_PI * 0.42 * Math.min(1, rmag));
this.recLp1[d] += kIn * (in * recGain - this.recLp1[d]);
this.recLp2[d] += kIn * (this.recLp1[d] - this.recLp2[d]);
```

Two cascaded one-poles, corner tracking transport speed. Two poles is the minimum that's respectable; a proper polyphase decimator would be better and is a legitimate upgrade.

### Position walking

Above 1× the playhead skips tape positions, so writing only at the current integer position would leave gaps.

```js
var ti = floor(pos[d]);
if (ti !== last) {
  var dir = rate >= 0 ? 1 : -1;
  while (last !== ti && guard < 96) {
    last += dir;
    wrap(last);
    buf[base + last] = buf[base + last] * er + wsig;
  }
}
```

Below 1× the target index stays the same for several samples, so nothing is written — correct, because the filtered value is the one sample that position should receive. The `guard` cap prevents a pathological loop at extreme rates.

### Recording at varispeed

Record at 0.5× and play at 1× and you get an octave up with the transients sharpened. That's the OP-1 trick and it falls out of the architecture for free.

---

## 7. Modulation

### Per-deck LFO

Four shapes (sine, triangle, ramp, sample-and-hold), one destination per deck: speed, filter, level, grain size, density, spray.

**Loop-synced by default**, and this is the design idea worth preserving:

```js
if (lfoSync) {
  lph = (pos[d] / len[d]) * lfoRate[d];
  lph = lph - floor(lph);
}
```

The phase comes from the playhead, so the rate control means *cycles per loop* rather than Hz. Modulation is locked to the material by construction — change splice length and the LFO rate follows, with no tempo setting and no sync logic. Free-running Hz is available as the alternative.

### Global modulation

Four sources, three of which only a transport can produce:

| Source | What it is |
|---|---|
| **LFO** | Ordinary free-running oscillator |
| **Head drift** | The gap between the two playheads, normalised. Evolves over minutes, never repeats |
| **Playhead A** | Deck A's position as a rising ramp. Period *is* the loop length |
| **Playhead B** | Same for deck B |

Destinations: delay, reverb, age, output, both speeds, both filters.

Head drift → age is the combination worth trying: the machine gets progressively more degraded as the heads separate and cleans up as they come back around, on a cycle measured in minutes.

### Two bugs worth knowing about (both fixed)

**`var` hoisting.** `mSpeed` was used on the line computing the target rate but declared later in the loop body. Deck A got `undefined` → NaN; deck B silently reused the previous iteration's value because `var` is function-scoped. The fix was to restructure so all modulation is computed before it's consumed. **In C++ this class of bug disappears**, which is one small argument for M0 sooner rather than later.

**Loop-invariant reassignment.** `rvMix = rvMix + gm` was inside the per-sample loop, so the modulation offset accumulated every sample and ran away. Fixed by computing into a local. Watch for this pattern anywhere modulation is applied to a variable hoisted out of the loop.

---

## 8. Master section

### Delay

Stereo, cross-fed (left feeds right's return and vice versa), with a one-pole lowpass in the feedback path so repeats darken. One knob scales mix and feedback together, as the panel implies; time is a screen setting.

### Reverb

Four comb filters plus two allpasses per channel, Schroeder/Freeverb topology, with the delay lengths offset by 23 samples between channels for width. Damping in the comb feedback.

This is roughly what DaisySP's `ReverbSc` will give you, so what you hear in the harness is honest about the hardware.

### Output stage

Saturation and output gain, both modulation destinations. `tanh` normalised by `tanh(sat)`.

---

## 9. Deck topologies

```js
var link = heads === 0, stereo = heads === 1;
var srcB = link ? 0 : 1;      // deck B borrows deck A's tape in LINK
```

- **LINK** — `srcB = 0`, so both decks read buffer 0. Independent positions and offsets, one tape.
- **STEREO** — deck B's target rate is forced to `p.rate[0]` and its offset is not applied. Anything else tears the stereo image.
- **SPLIT** — fully independent.

Panning: hard-panned in STEREO so the image is true; otherwise 0.86/0.34 crossed, so the drift is audible as movement rather than as two separate mono streams.

**In the C++ port this logic moves out of the deck entirely** — see the `Deck::process` signature in `PROJECT.md`. The deck should never branch on mode.

---

## 10. Host layer

### Three ways to get audio running

```
blob: URL worklet  →  data: URL worklet  →  ScriptProcessor
```

Chrome refuses to load a worklet module from a `blob:` URL inside an opaque-origin iframe — which is what artifact sandboxes and some embeds are. CSP can block `data:` URLs. ScriptProcessor is deprecated and runs on the main thread, but it runs the **identical engine**, so sound quality is fully testable on it. Only latency differs (~85 ms vs ~3 ms).

The header reports which path is active. Served from a normal origin (including `localhost`), you get the worklet.

### Two performance traps hit while building this

**Component declared inside the render body.** `Deck` was defined inside the main component, so React saw a new component *type* on every render and unmounted/remounted both deck strips — while the fallback engine ran on the same thread. Any component used in JSX must be declared outside, or called as a plain function.

**Unthrottled canvas + telemetry.** The screen now redraws at ~24 fps and the telemetry state updates at 250 ms. On the fallback path both compete directly with audio.

### Bundling note

The standalone HTML is built with esbuild and inlined Tailwind CSS, no CDN. **The bundler entry must import the app by a relative path from a directory that has `node_modules` above it.** Importing by absolute path from elsewhere resolved `react` to a second copy, and hooks then called into a null dispatcher — the error reads `Cannot read properties of null (reading 'useRef')` and looks like a React version problem. It isn't.

---

## 11. Porting notes

What changes when this becomes C++ on the Seed3:

| | |
|---|---|
| Position | float64 → **int64 32.32 fixed point** |
| Tape buffer | Float32Array → **int16_t in SDRAM**, converted on read. Doubles tape length |
| Sinc table | Anywhere → **internal SRAM, ideally DTCM.** 32 KB, hit 96 000×/s. In SDRAM it becomes the bottleneck |
| `Math.sin` in LFOs | → phase accumulator into a small sine table |
| `Math.tanh` | → polynomial approximation or lookup |
| Grain buffer reads | Cache-hostile — 12 scattered reads per sample per deck. **Measure, don't estimate** |
| SD refills | Chunk into ~64 KB pieces. A single large DMA burst stalls audio reads on the shared SDRAM bus |
| DMA | **Invalidate the D-cache after transfers.** Symptom of forgetting: intermittent clicks that make no sense |
| Deck coupling | Moves out of the deck and into the global layer |

### What to keep exactly

- The sinc table construction, including the sliding window and per-phase normalisation
- Head loss tracking speed, always on, outside AGE
- Wow/flutter depth scaling with inverse speed
- Two hiss components, one speed-scaled and one not
- The grain envelope always having some fade
- The record-path anti-alias filter
- Loop-synced LFO phase derived from the playhead


---

## FREEZE is spectral (revised twice — read the whole arc)

FRZ began as a granular hold and went through three rounds of refinement
(randomised clocks, length spread, per-grain detune, a Clouds-style
4-allpass diffuser). All of it helped; none removed the artefact, because a
granular freeze **replays the moment's own motion** — grains re-walk the
same 100-200ms trajectory and the ear hears the recurrence as fast looping
no matter how the scheduling is scrambled. That is the ceiling of the
time-domain approach, reached empirically. Don't climb it again.

The second attempt was spectral but **per-hop**: rebuild a frame every 1024
samples from held magnitudes with fresh phases. The drone was right and it
still sounded choppy — because a 4096-point IFFT inside one 128-sample
block measured **19ms against a 2.67ms deadline**, roughly twice a second.
The algorithm was fine; the *scheduling* was the artefact. Dropouts sound
exactly like choppiness, and no amount of DSP tuning would have fixed it.
This is the single most useful lesson in this file: **when something sounds
broken, measure the callback before you change the maths.**

### What ships

**One build at the freeze edge produces a buffer that is exactly periodic**,
so playback wraps with no seam at any read rate, forever, for the cost of
one interpolated read per sample.

1. Window `SPA` samples around the head (Hann), forward FFT.
2. Keep the magnitudes, **discard the phases entirely** — this is where time
   leaves the signal — and re-phase every bin at random.
3. Inverse FFT. Because each bin holds a whole number of cycles per `SPL`
   samples, the result loops seamlessly by construction. No crossfade.
4. Normalise to the captured window's RMS (measured level match: 0.0dB).

**The analysis window is the same length as the loop.** This is not tunable
and the reason matters: re-phasing makes neighbouring bins beat, and the
beating spans from the bin spacing up to the *width of a spectral peak*. A
short window zero-padded into a long transform makes peaks broad — measured
roughness -15dB, audible as quivering. With no zero-padding a Hann peak is
exactly 4 bins wide, so every beat note lands under 4·sr/SPL ≈ 6Hz: a slow
breath instead of a tremolo. **Measured -37.7dB, a 22dB improvement.**

Size is 32768 (0.68s). 65536 halves the residual breath but doubles the
per-deck buffer to 256KB, at which point the streaming read leaves cache —
p99 went 0.1ms → 4.2ms on a laptop, and the Daisy reads this from SDRAM
where the penalty is worse.

**The build is chunked across blocks.** Every stage — the windowing copy,
the magnitude pass, the re-phasing, both transforms, the normalise — is
resumable and bounded, so no callback ever runs long. The drone blooms in
~99ms, inside the transport's own 107ms tape-stop. Measured: steady frozen
**0/3000 blocks over budget, max 0.42ms**, cleaner than the unfrozen path.

### Behaviour preserved across the domain change
- **SPEED transposes the drone** by read rate; the wrap stays seamless
  because the buffer is periodic. Guarded away from zero.
- **Head loss runs after resynthesis** and tracks the knob, so pitch and
  brightness stay coupled — the machine's defining behaviour.
- The diffuser stays in the frozen path; `frzMix` crossfades in/out (~60ms)
  so engaging is still a tape stop and releasing resumes without a click.
- Grains are no longer conjured by freeze; in-flight grains retire. Normal
  granular is untouched.
- Unfreezing mid-build abandons the job cleanly.

### The honest trade
Transients inside the frozen instant are gone — spectral hold is fog by
construction, and holding 0.68s means "the moment" is a moment, not an
instant. That is the uncertainty principle, not a bug: a shorter instant is
inherently rougher. The deterministic "hold this exact moment" gesture
remains what it always was — narrow the splice.
