import { useState, useRef, useEffect, useCallback } from "react";

/* ==================================================================== *
 * TL-1 TAPE LAB — browser development harness
 * ====================================================================
 *
 * WHAT THIS IS
 *   A working simulation of the TL-1: a two-deck varispeed tape machine
 *   with granular playback, overdub, live input and modulation. It exists
 *   to develop and audition the DSP before any hardware exists, and to be
 *   given away free as the machine's calling card.
 *
 * HOW IT IS STRUCTURED
 *   All DSP lives inside ONE function, engineFactory(). Nothing else in
 *   this file touches audio maths.
 *
 *     engineFactory()  ->  TapeEngine class
 *          |                    |
 *          |                    +-- main thread uses it directly
 *          +-- .toString() ---> embedded in the AudioWorklet source
 *
 *   One source of truth, two hosts. This mirrors the firmware exactly:
 *   swap in a C++ core and a libDaisy AudioCallback and the shape of the
 *   program is unchanged. See PROJECT.md -> Architecture.
 *
 * THE THREE-TIER AUDIO FALLBACK
 *   blob: URL worklet -> data: URL worklet -> ScriptProcessor
 *   Chrome refuses blob: worklets inside opaque-origin iframes (artifact
 *   sandboxes, some embeds). ScriptProcessor runs the IDENTICAL engine on
 *   the main thread; only latency differs (~85ms vs ~3ms), so sound
 *   quality is fully testable either way. The header reports which is live.
 *
 * READING ORDER
 *   1. engineFactory / buildSinc      the resampler, heart of the machine
 *   2. TapeEngine.render              the whole audio path, one function
 *   3. TL1 component                  host plumbing and UI
 *
 * CONVENTIONS
 *   - render() allocates nothing. Ever. Neither does anything it calls.
 *   - Deck index d is 0 (A) or 1 (B). Arrays are [deckA, deckB].
 *   - Parameters arrive as a plain object via setParams and are read from
 *     this.p inside render. No getters, no events, no allocation.
 * ==================================================================== */

/* --------------------------------------------------------------------
 * engineFactory
 *
 * Wrapped in a factory (rather than declared at module scope) purely so
 * its source can be stringified into the AudioWorklet, which runs in a
 * separate global scope with no access to this module. Everything the
 * engine needs must be declared INSIDE this function — no imports, no
 * closures over outer variables. That constraint is also what makes the
 * code trivially portable to C++ later.
 * ------------------------------------------------------------------ */
function engineFactory() {
  // 16 taps is the sinc kernel width; 512 sub-sample phases is enough that
  // truncating to the nearest phase is inaudible (below ~256 you would have
  // to interpolate between adjacent table rows). HALF is used to centre the
  // kernel on the read point.
  var TAPS = 16, PHASES = 512, HALF = TAPS >> 1;
  var TWO_PI = 6.283185307179586;
  /* Tape is stored as int16, exactly as it will be in the Daisy's SDRAM.
     Halves the memory (so file length stops mattering) and gives the same
     ~96dB tape floor the hardware will have — which is well below the
     converter and inaudible under tape hiss, but you should be able to
     verify that rather than take it on faith. */
  var S16  = 32767;
  var S16R = 1 / 32768;

  /* ------------------------------------------------------------------
   * buildSinc — the windowed-sinc polyphase table
   *
   * THE PROBLEM. Playing tape at any rate other than 1x means constantly
   * needing the signal's value BETWEEN two stored samples. Sampling theory
   * says that if the recording was made properly there is exactly one
   * band-limited curve through those samples, and it is recoverable by
   * convolving with a sinc function. Sinc is infinitely wide, so we
   * truncate to 16 taps and window the ends to stop the truncation ringing.
   *
   * WHY A TABLE. Computing sinc and a Blackman window per sample would mean
   * transcendental functions in the audio loop. Instead we quantise the
   * fractional position into 512 buckets and precompute all 16 weights for
   * each. Runtime cost becomes: pick a row, 16 multiply-accumulates.
   *
   * Result: 512 x 16 floats = 32KB, built once at construction.
   * On the Daisy this table MUST live in internal SRAM (ideally DTCM) —
   * it is read 96,000 times a second and putting it in SDRAM makes it the
   * bottleneck of the whole machine.
   *
   * THREE DETAILS most references omit, each of which is audible:
   *
   *  1. The window SLIDES with the fractional position — note that `wp`
   *     depends on `frac`. The obvious implementation windows the fixed tap
   *     indices, which makes the kernel asymmetric as frac moves. You hear
   *     that as the frequency response wobbling in sync with the varispeed.
   *
   *  2. Every phase is normalised to unity DC gain (the final division).
   *     Without it, output level modulates as the fractional part sweeps.
   *     People usually misdiagnose this as aliasing; it is a level shimmer.
   *
   *  3. Blackman rather than a rectangular cut. The outermost weights end
   *     up near zero, which is what stops the truncated kernel ringing.
   *     A tuned Kaiser window would be marginally better still.
   *
   * KNOWN LIMITATION: the kernel is not widened for rates above 1x. A
   * correct resampler scales the sinc argument by 1/rate when decimating.
   * This one does not, so speeding up aliases. Acceptable for a machine
   * whose priority is the slow direction, but fix before release.
   * ---------------------------------------------------------------- */
  function buildSinc() {
    var t = new Float32Array(PHASES * TAPS);
    for (var p = 0; p < PHASES; p++) {
      var frac = p / PHASES, sum = 0;
      for (var k = 0; k < TAPS; k++) {
        // x = this tap's distance from the exact read point, in samples.
        // The +1 centres the 16-tap window so 7 taps sit behind the read
        // point and 8 ahead (or vice versa depending on frac).
        var x = k - HALF + 1 - frac;
        // sinc(x) = sin(pi x)/(pi x), with the removable singularity at 0
        // handled explicitly. This is the ideal reconstruction kernel.
        var s = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        // Window position slides with frac — see note 1 above.
        var wp = (k + 1 - frac) / TAPS;
        // Blackman window.
        var w = 0.42 - 0.5 * Math.cos(TWO_PI * wp) + 0.08 * Math.cos(2 * TWO_PI * wp);
        var v = s * w;
        t[p * TAPS + k] = v;
        sum += v;
      }
      // Normalise this phase to unity DC gain — see note 2 above.
      if (sum !== 0) for (var q = 0; q < TAPS; q++) t[p * TAPS + q] /= sum;
    }
    return t;
  }
  var SINC = buildSinc();

  /* ------------------------------------------------------------------
   * TapeEngine — one instance is the entire machine.
   *
   * All state is preallocated here. Nothing in the audio path ever
   * allocates, because a GC pause is audible.
   * ---------------------------------------------------------------- */
  function TapeEngine(sr) {
    this.sr = sr;
    // The two tape buffers. In LINK topology deck B reads buf[0] as well,
    // so buf[1] goes unused; the global layer decides, not the deck.
    this.buf = [null, null];

    this.interp = 2;      // 0 linear, 1 hermite, 2 sinc — the A/B that
                          // demonstrates why reconstruction quality matters
    this.headLoss = true; // playback-head lowpass. Doctrine: always on
    this.heads = 0;       // topology: 0 LINK, 1 STEREO, 2 SPLIT
    this.running = false; // master transport enable

    /* Read positions are plain JS numbers — float64. That is why long
       loops hold together here. In float32 you lose sub-sample resolution
       within about 20 seconds of tape, which is exactly why the firmware
       will use a 32.32 fixed-point accumulator instead. */
    this.pos = [0, 0];                // fractional read position per deck
    this.rateSm = [1, 1];             // slewed MANUAL rate — reel inertia
    this.modSm = [0, 0];              // lightly smoothed modulation offset
    this.hl = [0, 0];                 // head-loss one-pole state
    this.ic1 = [0, 0]; this.ic2 = [0, 0];   // SVF integrator state
    this.play = [false, false];       // transport running per deck
    this.rec = [false, false];        // record head engaged per deck

    /* Grain clouds. A grain is a short splice; density is more playheads
       on it. Both are vocabulary the transport already uses — LINK is
       literally two heads on one tape — so this is the existing
       architecture pushed further, not a foreign engine bolted on. */
    /* 24, not 12: a frozen deck at density 8 with randomised grain lengths
       peaks around 13-14 concurrent grains. A full pool DROPS spawns, and
       dropped spawns are irregular holes in the drone — audible as breakage.
       Headroom is cheaper than gaps: grains are 4-tap Hermite reads. */
    this.GMAX = 24;
    this.gPos = [new Float64Array(this.GMAX), new Float64Array(this.GMAX)];
    this.gAge = [new Float32Array(this.GMAX), new Float32Array(this.GMAX)];
    this.gLen = [new Float32Array(this.GMAX), new Float32Array(this.GMAX)];
    this.gOn  = [new Uint8Array(this.GMAX), new Uint8Array(this.GMAX)];
    this.gPan = [new Float32Array(this.GMAX), new Float32Array(this.GMAX)];
    /* Which coordinate space each grain's position lives in. Tape grains are
       stored in REEL coordinates so they survive a window swap; live grains
       index the input ring directly. */
    this.gLiveSrc = [new Uint8Array(this.GMAX), new Uint8Array(this.GMAX)];
    /* Last raw sample and a fast-fade coefficient per grain, so a grain
       stranded by a window swap can decay from where it actually was rather
       than jumping to a different part of the tape. */
    this.gLast = [new Float32Array(this.GMAX), new Float32Array(this.GMAX)];
    this.gFade = [new Float32Array(this.GMAX), new Float32Array(this.GMAX)];
    /* Per-grain rate multiplier. 1.0 in normal granular; under FREEZE each
       grain gets a random ±0.4% detune so grains reading the same material
       drift through each other's phase — a slow chorus — instead of sitting
       in static combs that lurch with every spawn. */
    this.gDet = [new Float32Array(this.GMAX), new Float32Array(this.GMAX)];
    this.gNext = [0, 0];
    this.gCount = [0, 0];

    /* FREEZE — the machine's VHS pause. A helical-scan machine shows a
       still frame because the heads keep spinning while the tape stands
       still; freeze is the same trick in audio. The transport slews to
       zero through its own inertia (so engaging it sounds like a tape
       stop), and grains keep reading at the SPEED knob's rate from the
       stalled position — so SPEED becomes the pitch of the drone, reverse
       included. */
    this.frzOn = [0, 0];
    this.frzInW = [0, 0];
    /* Latched when the ENGINE stops a deck itself (one-shot reaching the
       splice end). The host consumes these to un-light PLAY. The UI never
       diffs against play state — a state echo can be stale and would fight
       fresh user presses; an event cannot. */
    this.stopEvt = [0, 0];

    /* FREEZE DIFFUSER — the Clouds trick, and the real answer to 'the
       frozen drone should be smoother'. Four short all-pass filters in
       series: a reverb with no tail. It smears the phase relationships
       between overlapping grains so the cloud fuses into fog, without
       adding decay or changing the tone. Only audible under freeze, faded
       in over ~60ms, zero cost otherwise. Delay lengths are primes so the
       four stages never align. */
    var apLen = [113, 229, 349, 461];
    this.apBuf = [[], []];
    this.apIdx = [[0, 0, 0, 0], [0, 0, 0, 0]];
    for (var d2 = 0; d2 < 2; d2++)
      for (var a2 = 0; a2 < 4; a2++)
        this.apBuf[d2].push(new Float32Array(Math.max(8, Math.round(apLen[a2] * sr / 48000))));
    this.frzMix = [0, 0];

    /* ---- SPECTRAL FREEZE ------------------------------------------
       FRZ holds the moment's SPECTRUM, not a snippet of its time.

       Why not granular: a granular freeze replays the moment's own motion —
       grains re-walk the same 100-200ms trajectory, and the ear hears the
       recurrence as fast looping no matter how scrambled the scheduling.

       Why not per-hop resynthesis either: rebuilding a frame every 1024
       samples means a 4096-point IFFT landing inside one 128-sample audio
       block. Measured at 19ms against a 2.67ms deadline — the drone was
       clean but the CALLBACK was late, roughly twice a second, and dropouts
       sound exactly like choppiness. Never do unbounded work in the audio
       path; this is that rule collecting its debt.

       What it does instead: ONE build at the freeze edge produces a buffer
       that is EXACTLY PERIODIC — every bin holds an integer number of
       cycles per buffer, so playback wraps with no seam AT ANY READ RATE,
       forever, for the cost of one interpolated read per sample. A static
       spectrum needs to be synthesized exactly once. */
    /* Analysis and synthesis sizes are DECOUPLED, and that is the whole
       trick for smoothness:

         The analysis window is the SAME LENGTH as the loop, and that is
         the whole trick for smoothness. Re-phasing bins makes neighbours
         beat against each other, and the beating spans from the bin
         spacing up to the width of a spectral peak. A short window
         zero-padded into a long transform makes peaks BROAD — measured
         roughness -15dB, which is the quivering you can hear. With no
         zero-padding a Hann peak is exactly 4 bins wide, so every beat
         note falls under 4·sr/SPL ≈ 6Hz: a slow breath instead of a
         tremolo. Measured -37dB in the 6-30Hz roughness band, a 22dB
         improvement, and it is why this is not tunable — narrowing the
         window is the same as reintroducing the artefact.

         The honest cost is the uncertainty principle: holding 0.68s means
         "the moment" is a moment, not an instant. A shorter instant is
         inherently rougher; you cannot have both.

         Why 32768 and not 65536: a longer loop halves the residual breath
         (0.73Hz instead of 1.46Hz), but doubles the per-deck buffer to
         256KB, and the streaming read then falls out of cache — measured
         p99 went from 0.1ms to 4.2ms on a laptop, and the Daisy reads this
         from SDRAM where the penalty is worse. 0.68s is where smoothness
         and the memory system agree. */
    this.SPA = 32768;
    this.SPL = 32768;
    this.spMag = new Float32Array((this.SPA >> 1) + 1);
    this.spLoop = [new Float32Array(this.SPL), new Float32Array(this.SPL)];
    this.spPos = [0, 0];
    this.spHave = [0, 0];
    this.spSeed = [22222, 77777];
    this.fftRe = new Float32Array(this.SPL);
    this.fftIm = new Float32Array(this.SPL);
    /* The build is SPREAD ACROSS BLOCKS. Two 32768-point transforms cost
       ~15ms, and doing that inside one 2.67ms audio block is the exact
       mistake that made the first spectral freeze sound choppy. Instead the
       FFT is resumable: a bounded couple of stages per callback, so the
       drone takes ~40ms to bloom and no block ever runs long. The transport
       is tape-stopping over 107ms anyway, so the bloom lands inside the
       gesture. FIRMWARE: this is the audio-callback/main-loop split that
       Deck must keep — bounded work, always. */
    this.fftN = 0; this.fftInv = 0; this.fftLen2 = 0; this.fftPerm = 0;
    this.spJob = 0;              // 0 idle, 1 analysing, 2 synthesising
    this.spJobDeck = 0;
    this.spJobRms = 0;
    this.spWait = [null, null];  // pending source closures, per deck
    this.spJobSrc = null; this.spIdx = 0; this.spJobE = 0; this.spJobG = 0;

    /* Live grain source: a short rolling buffer of the incoming signal.
       Grains are spawned behind the write head so they never read audio
       that hasn't arrived yet. */
    // modulation
    this.lfoPh = [0, 0];
    this.gPh = 0;
    this.shHold = [0, 0, 0];
    this.shLast = [0, 0, 0];

    this.INLEN = Math.floor(sr * 4);
    this.inBuf = [new Float32Array(this.INLEN), new Float32Array(this.INLEN)];
    this.inW = 0;

    // record path
    this.recLp1 = [0, 0]; this.recLp2 = [0, 0];
    this.recLast = [-1, -1];
    this.pkTimer = 0; this.wantPeaks = 0; this.inPeak = 0;

    // Wow/flutter oscillator phases. ph1 and ph2 are the two slow wow
    // components (0.63Hz and 1.17Hz), ph3 is flutter (8.4Hz), phd is spare.
    this.ph1 = 0; this.ph2 = 0; this.ph3 = 0; this.phd = 0;
    this.drop = [1, 1];               // dropout gain, recovers toward 1
    this.seed = 22222;                // LCG state for all noise sources

    /* Master delay. Two seconds max, stereo, cross-fed in the feedback
       path so repeats bounce between channels, with a one-pole lowpass in
       the loop so they darken with each pass like a tape echo. */
    this.dlMax = Math.floor(sr * 2.0);
    this.dl = [new Float32Array(this.dlMax), new Float32Array(this.dlMax)];
    this.dlW = 0;
    this.dlLp = [0, 0];

    /* Master reverb: Schroeder topology — 4 parallel comb filters into 2
       series allpasses, per channel. The delay lengths are the classic
       Freeverb primes, scaled to the actual sample rate, and offset by 23
       samples on the right channel to decorrelate the two sides.

       This is deliberately close to what DaisySP's ReverbSc will give you
       on hardware, so what you audition here is honest about the target. */
    var cT = [1116, 1188, 1277, 1356], aT = [556, 341];
    var sc = sr / 44100;
    this.cmb = [[], []]; this.cmbI = [[], []]; this.cmbS = [[], []];
    this.aps = [[], []]; this.apsI = [[], []];
    for (var ch = 0; ch < 2; ch++) {
      for (var i = 0; i < 4; i++) {
        var n = Math.floor(cT[i] * sc) + (ch ? 23 : 0);
        this.cmb[ch].push(new Float32Array(n));
        this.cmbI[ch].push(0);
        this.cmbS[ch].push(0);
      }
      for (var j = 0; j < 2; j++) {
        var m = Math.floor(aT[j] * sc) + (ch ? 23 : 0);
        this.aps[ch].push(new Float32Array(m));
        this.apsI[ch].push(0);
      }
    }

    /* ---- REEL STREAMING ------------------------------------------
       When reelLen[d] is 0 the whole tape is resident and everything
       behaves as before. When it is non-zero, buf[d] holds only a WINDOW
       of a much longer reel that lives in storage, and:

         global position = winStart[d] + pos[d]

       The engine stays dumb about refilling — it just exposes gpos and
       wraps at the reel's ends. The host watches gpos and swaps windows
       in, which is exactly the split the firmware will use (audio callback
       never touches the card; the main loop does). */
    this.winStart = [0, 0];
    this.reelLen = [0, 0];
    this.gpos = [0, 0];
    /* Interpolation guard. The 16-tap sinc reads 8 samples either side of
       the read point, so a playhead sitting exactly at a window edge would
       have taps wrap round to the far end of the buffer — unrelated audio,
       and a hard splice rather than a smooth read. Standard practice in
       streaming samplers is to carry margin samples at both ends of the
       buffer for exactly this. We fetch GUARD extra samples on each side and
       keep the playhead inside the usable region between them. */
    this.winGuard = [[0, 0], [0, 0]];   // [lo, hi] per deck, in samples
    /* Underrun gate. If the playhead ever reaches audio that is not resident
       — a reel wrap, or a read that arrived late — there is no correct
       sample to play. Freezing on the last one steps when the window lands;
       wrapping inside the buffer splices to unrelated tape. So gate the deck
       down over ~3ms and back up when the data arrives: a short dip, never a
       click. */
    this.stFade = [1, 1];
    this.lastX = [0, 0];      // last good sample, held while starved
    this.stHold = [0, 0];     // latched until the gate has closed

    this.normA = 0; this.normB = 0; this.driftSamp = 0; this.driftSec = 0;
    this.peak = [0, 0];

    this.p = {
      rate: [1, 1], level: [0.8, 0.8], filter: [0, 0], offset: [0, 0.0015],
      loopStart: [0, 0], loopLen: [1, 1],
      gSize: [0.06, 0.06], gDens: [0, 0], gSpray: [0.2, 0.2], gRamp: [0.5, 0.5],
      /* Modulation defaults. EVERY field render() reads must exist here: the
         worklet renders before the host's first params message arrives, and
         a missing field means process() throws — which kills an AudioWorklet
         processor SILENTLY. No error on the page, no audio, ever. This exact
         omission shipped once; the completeness test in the build now guards
         it. */
      gLive: [0, 0],
      lfoRate: [1, 1], lfoDepth: [0, 0], lfoShape: [0, 0],
      lfoDest: [1, 1], lfoSync: [1, 1],
      gmSrc: 0, gmRate: 0.1, gmDepth: 0, gmDest: 0,
      freeze: [0, 0],
      age: 0.25, delay: 0, delayTime: 0.375, delayFb: 0.42,
      reverb: 0.15, output: 0.8, erase: [1, 1], invert: [0, 0], recGain: 1,
      loop: [1, 1]
    };
  }

  /* Linear congruential PRNG. Not statistically good, but it is fast,
     allocation-free, deterministic (so bugs reproduce), and for hiss and
     grain jitter the spectral flaws are entirely inaudible. Returns
     roughly -1..1. */
  TapeEngine.prototype.rnd = function () {
    this.seed = (this.seed * 1664525 + 1013904223) | 0;
    return (this.seed >> 8) / 8388608;
  };

  // Mount a recording on deck i. Resets that deck's position and filter
  // state so a new tape doesn't inherit the previous one's transients.
  /* Mount a fully resident reel. Note reelLen is set to the buffer length
     rather than 0 — a resident tape is just a reel whose window happens to
     be the whole thing, so there is no second code path. See REEL.md. */
  TapeEngine.prototype.setTape = function (i, data) {
    this.buf[i] = data;
    this.pos[i] = 0; this.hl[i] = 0;
    this.ic1[i] = 0; this.ic2[i] = 0;
    this.winStart[i] = 0; this.reelLen[i] = data.length; this.gpos[i] = 0;
    // A resident reel needs no guard: reads wrap at the splice, which is
    // correct — a tape loop's splice does join end to start.
    this.winGuard[i][0] = 0; this.winGuard[i][1] = 0;
  };

  /* Swap in a new window of a streamed reel. The read position is rebased
     so audio is continuous across the swap: the playhead keeps its position
     in REEL coordinates and only its offset within the buffer changes. */
  /* Swap in a new window. No rebase is needed: this.pos is kept in REEL
     coordinates, so the playhead does not move when the window does. */
  TapeEngine.prototype.setWindow = function (i, data, start, reelLen, gLo, gHi) {
    this.buf[i] = data;
    this.winStart[i] = start;              // reel position of data[0]
    this.winGuard[i][0] = gLo || 0;
    this.winGuard[i][1] = gHi || 0;
    this.reelLen[i] = reelLen;
    if (this.pos[i] > reelLen - 1) this.pos[i] = reelLen - 1;
    if (this.pos[i] < 0) this.pos[i] = 0;
    this.gpos[i] = this.pos[i];
  };
  // Allocate silent tape. This is what makes overdub-from-nothing
  // possible — the Frippertronics workflow needs somewhere to record onto.
  TapeEngine.prototype.blank = function (i, n) {
    this.buf[i] = new Int16Array(n);
    this.pos[i] = 0; this.recLast[i] = -1;
    this.winStart[i] = 0; this.reelLen[i] = n; this.gpos[i] = 0;
    this.winGuard[i][0] = 0; this.winGuard[i][1] = 0;
  };

  /* The tape changes underneath the waveform view while recording, so the
     engine owns the peak data and pushes it out. */
  /* The tape changes underneath the waveform view while recording, so the
     ENGINE owns peak extraction and pushes it to the host rather than the
     UI pulling it. 900 bins of min/max, normalised. Recomputed roughly
     every 400ms while a deck is armed, on demand otherwise. */
  TapeEngine.prototype.peaks = function (i, bins) {
    var buf = this.buf[i];
    if (!buf) return null;
    var out = new Float32Array(bins * 2);
    var step = Math.max(1, Math.floor(buf.length / bins));
    var mx = 0.0001;
    for (var k = 0; k < bins; k++) {
      var lo = 0, hi = 0, a = k * step, b = Math.min(buf.length, a + step);
      for (var j = a; j < b; j++) { var v = buf[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
      out[k * 2] = lo * S16R; out[k * 2 + 1] = hi * S16R;
      if (-lo * S16R > mx) mx = -lo * S16R;
      if (hi * S16R > mx) mx = hi * S16R;
    }
    for (var q = 0; q < out.length; q++) out[q] /= mx;
    return out;
  };

  TapeEngine.prototype.setParams = function (o) {
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) this.p[k] = o[k];
  };
  // Discrete switches. Separate from setParams because these change
  // topology rather than a continuous value.
  TapeEngine.prototype.setConfig = function (o) {
    if (o.interp !== undefined) this.interp = o.interp;
    if (o.headLoss !== undefined) this.headLoss = o.headLoss;
    if (o.heads !== undefined) this.heads = o.heads;
    if (o.running !== undefined) this.running = o.running;
  };
  /* Transport commands. Note that arming record resets recLast to -1,
     which makes the record head re-find its position rather than writing
     a smear from wherever it left off. */
  TapeEngine.prototype.transport = function (o) {
    if (o.play !== undefined) this.play[o.deck] = o.play;
    if (o.rec !== undefined) this.rec[o.deck] = o.rec;
    if (o.rec !== undefined) this.recLast[o.deck] = -1;
    if (o.resync) { this.pos[1] = this.pos[0]; }
    if (o.rewind) { this.pos[0] = 0; this.pos[1] = 0; }
  };

  /* ------------------------------------------------------------------
   * read — one sample from the loop region [base, base+len) at fractional
   * position pos. This is the single most-called function in the program.
   *
   * The region is the SPLICE: base is "splice in", len is "splice length".
   * Wrapping happens inside the region, so the loop point behaves like a
   * physical tape splice rather than a buffer boundary.
   *
   * Three interpolators, selected by this.interp, so the harness can A/B
   * them live. That comparison is the whole reason this app exists:
   * set speed to 0.25x on Sinc, then switch to Linear.
   * ---------------------------------------------------------------- */
  TapeEngine.prototype.read = function (buf, base, len, pos) {
    var i = Math.floor(pos), f = pos - i, k, m;

    // --- 0: LINEAR. Draws a straight line between the two nearest samples.
    // Cheap and wrong: its frequency response varies with fractional
    // position, which you hear as smeared, fluttery treble.
    if (this.interp === 0) {
      var a0 = i % len; if (a0 < 0) a0 += len;
      var b0 = (i + 1) % len; if (b0 < 0) b0 += len;
      return (buf[base + a0] * (1 - f) + buf[base + b0] * f) * S16R;
    }
    // --- 1: 4-POINT CUBIC HERMITE. Fits a smooth curve through four
    // samples. About -40dB error, which is what most hardware ships.
    if (this.interp === 1) {
      var m1 = (i - 1) % len; if (m1 < 0) m1 += len;
      var i0 = i % len;       if (i0 < 0) i0 += len;
      var i1 = (i + 1) % len; if (i1 < 0) i1 += len;
      var i2 = (i + 2) % len; if (i2 < 0) i2 += len;
      var xm1 = buf[base + m1], x0 = buf[base + i0];
      var x1 = buf[base + i1],  x2 = buf[base + i2];
      var c = (x1 - xm1) * 0.5, v = x0 - x1, w = c + v;
      var a = w + v + (x2 - x0) * 0.5, b = w + a;
      return (((a * f - b) * f + c) * f + x0) * S16R;
    }

    // --- 2: WINDOWED SINC. Quantise the fraction into one of 512 phases,
    // fetch that row's 16 weights, and take the weighted sum of 16 samples
    // around the read point. Effectively transparent below 1x.
    var ph = (f * PHASES) | 0; if (ph >= PHASES) ph = PHASES - 1;
    var o = ph * TAPS, acc = 0;

    /* FAST PATH. The 16-tap window only straddles the splice point for 16
       samples out of the entire loop — so instead of doing a modulo on
       every tap, test once whether the whole window is safely inside the
       region. This branch is taken 99.99% of the time and removes 16
       modulo operations per sample per playhead. */
    var lo = i - HALF + 1, hi = i + HALF;
    if (lo >= 0 && hi < len) {
      var bp = base + lo;
      for (k = 0; k < TAPS; k++) acc += SINC[o + k] * buf[bp + k];
      return acc * S16R;
    }
    for (k = 0; k < TAPS; k++) {
      m = (i + k - HALF + 1) % len; if (m < 0) m += len;
      acc += SINC[o + k] * buf[base + m];
    }
    return acc * S16R;
  };

  /* LFO shapes. Shape 3 is sample-and-hold, which needs its own held value
     per slot — 0 and 1 are the decks, 2 is the global source. */
  TapeEngine.prototype.shape = function (ph, sh, slot) {
    if (sh === 0) return Math.sin(ph * TWO_PI);
    if (sh === 1) return 1 - 4 * Math.abs(Math.round(ph) - ph);
    if (sh === 2) return ph * 2 - 1;
    if (ph < this.shLast[slot]) this.shHold[slot] = this.rnd();
    this.shLast[slot] = ph;
    return this.shHold[slot];
  };

  /* Radix-2 FFT over the first n entries of this.fftRe/Im, RESUMABLE:
     fftBegin() sets it up, fftAdvance(k) runs at most k butterfly stages
     and returns 1 when the transform is finished. Bounded work per call is
     the whole point — see the note in the constructor. */
  TapeEngine.prototype.fftBegin = function (n, inv) {
    this.fftN = n; this.fftInv = inv; this.fftLen2 = 2; this.fftPerm = 0;
  };

  TapeEngine.prototype.fftAdvance = function (maxStages) {
    var re = this.fftRe, im = this.fftIm, n = this.fftN;
    var i, j, k, m, half, ang, wr, wi, cr, ci, tr, ti, ur, ui, bit, ncr;
    if (!this.fftPerm) {
      for (i = 1, j = 0; i < n; i++) {
        bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { tr = re[i]; re[i] = re[j]; re[j] = tr;
                     ti = im[i]; im[i] = im[j]; im[j] = ti; }
      }
      this.fftPerm = 1;
    }
    var done = 0;
    while (done < maxStages && this.fftLen2 <= n) {
      var len2 = this.fftLen2;
      half = len2 >> 1;
      ang = (this.fftInv ? TWO_PI : -TWO_PI) / len2;
      wr = Math.cos(ang); wi = Math.sin(ang);
      for (i = 0; i < n; i += len2) {
        cr = 1; ci = 0;
        for (k = 0; k < half; k++) {
          m = i + k;
          ur = re[m]; ui = im[m];
          tr = re[m + half] * cr - im[m + half] * ci;
          ti = re[m + half] * ci + im[m + half] * cr;
          re[m] = ur + tr; im[m] = ui + ti;
          re[m + half] = ur - tr; im[m + half] = ui - ti;
          ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
      this.fftLen2 = len2 << 1;
      done++;
    }
    return this.fftLen2 > n ? 1 : 0;
  };

  /* Build the frozen drone. Runs ONCE, at the freeze edge.

       1. Read `width` samples around the head through a Hann window
          (width is SPRAY: the width of the moment, 85ms .. 340ms) and
          zero-pad to SPL.
       2. Forward FFT, keep the magnitudes, discard the phases entirely —
          this is where "time" leaves the signal.
       3. Re-phase every bin at random and inverse transform. Because each
          bin completes a whole number of cycles per SPL samples, the result
          is exactly periodic: it can be looped forever, at any rate, with
          no seam and no crossfade.
       4. Normalise to the captured window's own RMS, so the drone arrives
          at the level of the material it came from.

     `src` is a sample-fetch closure so tape (int16, splice-wrapped) and the
     live ring (float) share one path.

     FIRMWARE NOTE: two SPL-point FFTs at a button press. On the Daisy this
     belongs in the main loop, with the transport's tape-stop slew covering
     the build latency — never in the audio callback. */
  /* Ask for a drone to be built from `src`. Cheap: it only stores the
     fetch closure. The work happens over the following blocks. */
  TapeEngine.prototype.spRequest = function (d, src) {
    this.spWait[d] = src;
    this.spHave[d] = 0;
  };

  /* Advance the build. Called once per block from render(). Does at most a
     couple of FFT stages, or one of the cheap transition steps. */
  /* Advance the build by ONE bounded step per block. Every stage here is
     chunked — the windowing copy, the re-phasing, the transforms and the
     normalise — because any one of them run whole would overrun a 2.67ms
     audio block, which is precisely the failure this design exists to
     avoid. Total ~30 blocks, so the drone blooms in about 80ms, inside the
     transport's own 107ms tape-stop. */
  TapeEngine.prototype.spAdvance = function () {
    var A = this.SPA, N = this.SPL, aHalf = A >> 1, half = N >> 1;
    var re = this.fftRe, im = this.fftIm, mag = this.spMag;
    var CH = 4096, i, k, end;

    if (this.spJob === 0) {
      var d = this.spWait[0] ? 0 : (this.spWait[1] ? 1 : -1);
      if (d < 0) return;
      this.spJobDeck = d;
      this.spJobSrc = this.spWait[d];
      this.spWait[d] = null;
      this.spJobRms = 0;
      this.spIdx = 0;
      this.spJob = 1;
      return;
    }

    if (this.spJob === 1) {
      /* ANALYSE. The window IS the loop length — no zero-padding, which is
         what keeps spectral peaks 4 bins wide and the beating slow. */
      var src = this.spJobSrc;
      end = Math.min(this.spIdx + CH, A);
      var acc = this.spJobRms;
      for (i = this.spIdx; i < end; i++) {
        var v = src(i - (A >> 1));
        acc += v * v;
        re[i] = v * (0.5 - 0.5 * Math.cos(TWO_PI * i / A));
        im[i] = 0;
      }
      this.spJobRms = acc;
      this.spIdx = end;
      if (end >= A) {
        this.spJobRms = Math.sqrt(this.spJobRms / A);
        this.spJobSrc = null;
        this.spJob = 2;
        this.fftBegin(A, 0);
      }
      return;
    }

    if (this.spJob === 2) {
      if (!this.fftAdvance(2)) return;
      for (k = 0; k <= aHalf; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      for (i = 0; i < N; i++) { re[i] = 0; im[i] = 0; }
      this.spIdx = 1;
      this.spJob = 3;
      return;
    }

    if (this.spJob === 3) {
      /* RE-PHASE. Keep the magnitudes, discard the phases entirely — this
         is where time leaves the signal. Because each bin then holds a
         whole number of cycles per SPL samples, the inverse transform is
         EXACTLY PERIODIC: it loops forever, at any read rate, with no
         seam and no crossfade. */
      var ratio = A / N;
      var seed = this.spSeed[this.spJobDeck];
      end = Math.min(this.spIdx + CH, half);
      for (k = this.spIdx; k < end; k++) {
        var sk = k * ratio;
        if (sk >= aHalf - 1) break;
        var ki = sk | 0, kf = sk - ki;
        var m0 = mag[ki] + (mag[ki + 1] - mag[ki]) * kf;
        if (m0 < 1e-9) continue;
        seed = (seed * 1664525 + 1013904223) | 0;
        var ph = ((seed >>> 9) / 8388608) * TWO_PI;
        var pr = Math.cos(ph) * m0, pi = Math.sin(ph) * m0;
        re[k] = pr; im[k] = pi;
        re[N - k] = pr; im[N - k] = -pi;    // conjugate symmetry -> real out
      }
      this.spSeed[this.spJobDeck] = seed;
      this.spIdx = end;
      if (end >= half) { this.spJob = 4; this.fftBegin(N, 1); }
      return;
    }

    if (this.spJob === 4) {
      if (!this.fftAdvance(2)) return;
      this.spIdx = 0; this.spJobE = 0; this.spJob = 5;
      return;
    }

    /* Normalise to the captured window's own RMS, so the drone arrives at
       the level of the material it came from. */
    var dd = this.spJobDeck, buf = this.spLoop[dd];
    end = Math.min(this.spIdx + CH * 2, N);
    if (this.spJobE >= 0) {
      var e2 = this.spJobE;
      for (i = this.spIdx; i < end; i++) { buf[i] = re[i]; e2 += re[i] * re[i]; }
      this.spJobE = e2;
      this.spIdx = end;
      if (end >= N) {
        var cur = Math.sqrt(this.spJobE / N);
        this.spJobG = cur > 1e-12 ? this.spJobRms / cur : 0;
        this.spJobE = -1; this.spIdx = 0;
      }
      return;
    }
    var g = this.spJobG;
    for (i = this.spIdx; i < end; i++) buf[i] *= g;
    this.spIdx = end;
    if (end >= N) {
      this.spPos[dd] = 0;
      this.spHave[dd] = this.spJobRms > 1e-9 ? 1 : 0;
      this.spJob = 0;
    }
  };

  /* Read the frozen loop. Hermite is plenty here — the buffer is a dense
     sum of sinusoids with no transients for interpolation error to expose,
     and the wrap is seamless because the buffer is exactly periodic. */
  TapeEngine.prototype.spRead = function (d, pos) {
    var N = this.SPL, buf = this.spLoop[d];
    var i = Math.floor(pos), f = pos - i;
    var xm1 = buf[(i - 1 + N) & (N - 1)], x0 = buf[i & (N - 1)];
    var x1 = buf[(i + 1) & (N - 1)], x2 = buf[(i + 2) & (N - 1)];
    var c = (x1 - xm1) * 0.5, v = x0 - x1, w = c + v;
    var a = w + v + (x2 - x0) * 0.5, b = w + a;
    return ((a * f - b) * f + c) * f + x0;
  };

  /* ------------------------------------------------------------------
   * genv — grain envelope, a trapezoid with cosine ramps.
   *
   * RAMP 0   -> fades are 1.5% of the grain: hard-edged, percussive, gated
   * RAMP 1   -> fades are 50% each side: this is a Hann window, fully smeared
   *
   * CRITICAL: some fade is ALWAYS present. A rectangular grain clicks at
   * both boundaries, and that single detail is the difference between a
   * granulator that sounds characterful and one that sounds broken.
   * ---------------------------------------------------------------- */
  TapeEngine.prototype.genv = function (ph, r) {
    var rr = 0.015 + r * 0.485;
    if (ph < rr) return 0.5 - 0.5 * Math.cos(Math.PI * ph / rr);
    if (ph > 1 - rr) return 0.5 - 0.5 * Math.cos(Math.PI * (1 - ph) / rr);
    return 1;
  };

  /* ------------------------------------------------------------------
   * readFast — 4-point cubic Hermite interpolation, used ONLY for grains.
   *
   * Why not the 16-tap sinc? A grain is short and windowed, so its envelope
   * masks nearly all of the interpolation error. Using 4 taps instead of 16
   * is a 4x cost reduction in exactly the place it is least audible, and it
   * is what keeps 12 grains x 2 decks within the M7's budget.
   *
   * The main playhead still gets sinc. This is a deliberate quality split,
   * not a shortcut.
   * ---------------------------------------------------------------- */
  TapeEngine.prototype.readFast = function (buf, base, len, pos) {
    var i = Math.floor(pos), f = pos - i;
    var m1 = (i - 1) % len; if (m1 < 0) m1 += len;
    var i0 = i % len;       if (i0 < 0) i0 += len;
    var i1 = (i + 1) % len; if (i1 < 0) i1 += len;
    var i2 = (i + 2) % len; if (i2 < 0) i2 += len;
    var xm1 = buf[base + m1], x0 = buf[base + i0];
    var x1 = buf[base + i1],  x2 = buf[base + i2];
    var c = (x1 - xm1) * 0.5, v = x0 - x1, w = c + v;
    var a = w + v + (x2 - x0) * 0.5, b = w + a;
    return ((a * f - b) * f + c) * f + x0;
  };

  /* ------------------------------------------------------------------
   * svf — topology-preserving-transform state variable filter.
   *
   * TPT (zero-delay feedback) rather than a naive digital SVF because it
   * stays stable when the cutoff is modulated hard, which matters here:
   * the LFO and CV can both sweep this at audio-adjacent rates.
   *
   * BIPOLAR ON ONE KNOB:
   *   amt < 0  -> lowpass, sweeping 18kHz down to 80Hz
   *   amt ~ 0  -> dead zone, returns the input untouched
   *   amt > 0  -> highpass, sweeping 20Hz up to 6kHz
   *
   * The dead zone matters: it gives the knob a findable "open" position,
   * the same reasoning as centre-detented attenuverters. One control, the
   * entire band-isolation gesture, and off is off.
   * ---------------------------------------------------------------- */
  TapeEngine.prototype.svf = function (d, x, amt) {
    if (amt > -0.02 && amt < 0.02) return x;
    var fc;
    if (amt < 0) fc = 18000 * Math.pow(80 / 18000, -amt);
    else fc = 20 * Math.pow(6000 / 20, amt);
    if (fc > this.sr * 0.45) fc = this.sr * 0.45;
    var g = Math.tan(Math.PI * fc / this.sr), k = 1.1;
    var a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    var v3 = x - this.ic2[d];
    var v1 = a1 * this.ic1[d] + a2 * v3;
    var v2 = this.ic2[d] + a2 * this.ic1[d] + a3 * v3;
    this.ic1[d] = 2 * v1 - this.ic1[d];
    this.ic2[d] = 2 * v2 - this.ic2[d];
    return amt < 0 ? v2 : (x - k * v1 - v2);
  };

  /* Schroeder reverb: 4 parallel combs (each with a damping one-pole in
     its feedback path) summed, then through 2 series allpasses which
     diffuse the comb resonances into something less metallic. */
  TapeEngine.prototype.reverb = function (ch, x) {
    var out = 0, i, buf, idx, y;
    for (i = 0; i < 4; i++) {
      buf = this.cmb[ch][i]; idx = this.cmbI[ch][i];
      y = buf[idx];
      this.cmbS[ch][i] = y * 0.78 + this.cmbS[ch][i] * 0.22;   // damping
      buf[idx] = x + this.cmbS[ch][i] * 0.84;
      this.cmbI[ch][i] = (idx + 1) % buf.length;
      out += y;
    }
    out *= 0.25;
    for (i = 0; i < 2; i++) {
      buf = this.aps[ch][i]; idx = this.apsI[ch][i];
      y = buf[idx];
      buf[idx] = out + y * 0.5;
      this.apsI[ch][i] = (idx + 1) % buf.length;
      out = y - out;
    }
    return out;
  };

  /* ==================================================================
   * render — the entire audio path, in one function.
   *
   * L, R    output buffers to fill
   * n       frames
   * inL/inR live input, or null
   *
   * Order of operations per sample:
   *   1. advance the wow/flutter oscillators   (shared by both decks)
   *   2. capture input into the live ring       (for LIVE grain source)
   *   3. compute global modulation              (LFO / drift / playheads)
   *   4. per deck: LFO -> destinations -> rate -> read -> head loss ->
   *      noise -> dropout -> filter -> level -> record head -> advance
   *   5. pan, master delay, master reverb, saturation, output gain
   *
   * Nothing in here allocates.
   * ================================================================ */
  TapeEngine.prototype.render = function (L, R, n, inL, inR) {
    // Advance any pending frozen-drone build: bounded work, once a block.
    if (this.spJob || this.spWait[0] || this.spWait[1]) this.spAdvance();
    var s, d;
    if (!this.buf[0] || !this.running) {
      for (s = 0; s < n; s++) { L[s] = 0; if (R !== L) R[s] = 0; }
      this.peak[0] = this.peak[1] = 0;
      if (inL) { var ip = 0;
        for (s = 0; s < n; s++) { var av = inL[s] < 0 ? -inL[s] : inL[s]; if (av > ip) ip = av; }
        this.inPeak = ip; }
      return;
    }

    var p = this.p, sr = this.sr;
    /* ---- TOPOLOGY -------------------------------------------------
       LINK   both decks read buf[0] — two playheads on ONE tape. This is
              the Reich configuration and the machine's signature.
       STEREO deck B's transport is slaved to deck A. Anything else tears
              the stereo image apart.
       SPLIT  fully independent tapes, lengths and speeds.

       NOTE FOR THE C++ PORT: this branching must move OUT of the deck and
       into the global layer. A deck should be handed a buffer, a base, a
       length and a rate, and should never know the other deck exists.
       See PROJECT.md -> "The deck must not know the other deck exists". */
    var link = this.heads === 0, stereo = this.heads === 1;
    var srcB = link ? 0 : 1;
    if (!this.buf[srcB]) srcB = 0;

    /* ---- SPLICE, IN REEL COORDINATES ------------------------------
       loopStart/loopLen are fractions of the whole REEL, not of the
       resident window. That is what lets a twenty-second splice sit four
       hours into a six-hour reel and still behave like a short tape.

       fits[] records whether the splice is entirely inside the resident
       window. When it is (REEL.md Rule 2, the case worth optimising for),
       reads wrap at the splice edges and the machine does no I/O at all.
       When it is not, reads wrap at the window edges and the host keeps the
       window moving under the playhead. */
    var base = [0, 0], len = [0, 0], sStart = [0, 0], sLen = [0, 0], fits = [1, 1];
    for (d = 0; d < 2; d++) {
      var bi = d === 0 ? 0 : srcB;
      var bufLen = this.buf[bi].length;
      var reelL = this.reelLen[bi] || bufLen;
      var ws = this.winStart[bi];

      var ss = Math.floor(p.loopStart[d] * reelL);
      var sl = Math.floor(p.loopLen[d] * reelL);
      if (ss + sl > reelL) sl = reelL - ss;
      if (sl < 256) { ss = 0; sl = reelL; }
      sStart[d] = ss; sLen[d] = sl;

      var gLo = this.winGuard[bi][0], gHi = this.winGuard[bi][1];
      var uLo = ws + gLo, uHi = ws + bufLen - gHi;   // usable reel range
      var f = (sl <= bufLen) && (ss >= uLo) && (ss + sl <= uHi);
      fits[d] = f ? 1 : 0;
      base[d] = f ? (ss - ws) : 0;
      len[d]  = f ? sl : bufLen;
    }

    /* ---- AGE: the degradation macro -------------------------------
       One knob scaling wow depth, flutter depth, both hiss components,
       dropout rate and saturation. These are all consequences of the same
       physical fact (old tape), so moving them together is more honest
       than exposing five controls.

       AGE deliberately does NOT touch head loss. See below. */
    var age = p.age;
    var r0 = Math.abs(this.rateSm[0]) || 0.001;

    /* Wow and flutter deepen as the transport slows — a real capstan holds
       pitch worse at low speed, and that instability is a big part of why
       slow tape reads as tape. AGE scales the depth on top of that. */
    var spd = Math.min(3, 1 / Math.max(0.15, r0));
    var wowD = (0.0012 + age * 0.0070) * spd;
    var flutD = (0.0003 + age * 0.0018) * spd;
    var hissTape = age * age * 0.0042;
    var hissElec = 0.00012 + age * 0.0009;
    var dropRate = age * age * 0.55;
    var sat = 1 + age * 2.2;

    // Wow at 0.63Hz and 1.17Hz (summed 0.7/0.3 so it never repeats
    // obviously), flutter at 8.4Hz. Real tape wow lives around 0.5-2Hz and
    // flutter around 6-20Hz, so these sit in the physically right places.
    var w1 = TWO_PI * 0.63 / sr, w2 = TWO_PI * 1.17 / sr;
    var w3 = TWO_PI * 8.4 / sr,  wd = TWO_PI * 3.1 / sr;
    /* Transport inertia. A real reel cannot change speed instantly, and an
       instant jump is the single most digital-sounding thing this machine
       could do. 35ms one-pole slew is what makes tape stop feel right. */
    var slew = 1 - Math.exp(-1 / (0.035 * sr));
    // Modulation smoothing: fast enough to pass audio-rate FM, slow enough
    // to keep a 16-bit control signal from zippering.
    var mslew = 1 - Math.exp(-1 / (0.0015 * sr));
    // ~3ms fade for grains stranded by a window swap
    var gfade = Math.exp(-1 / (0.003 * sr));
    var fmSlew = 1 - Math.exp(-1 / (0.06 * sr));
    // ~3ms gate for a deck that has run past its resident audio
    var stcoef = 1 - Math.exp(-1 / (0.003 * sr));

    // Delay feedback rises with the mix knob, so one control gives you
    // both "a bit of echo" and "runaway" without a second knob.
    var dTime = Math.max(0.02, Math.min(1.9, p.delayTime));
    var dSamp = Math.floor(dTime * sr);
    var dMix = p.delay, dFb = p.delayFb * (0.35 + 0.65 * p.delay);
    var rvMix = p.reverb, outG = p.output;

    var pk0 = 0, pk1 = 0;

    for (s = 0; s < n; s++) {
      this.ph1 += w1; if (this.ph1 > TWO_PI) this.ph1 -= TWO_PI;
      this.ph2 += w2; if (this.ph2 > TWO_PI) this.ph2 -= TWO_PI;
      this.ph3 += w3; if (this.ph3 > TWO_PI) this.ph3 -= TWO_PI;
      this.phd += wd; if (this.phd > TWO_PI) this.phd -= TWO_PI;

      // Flutter is itself amplitude-modulated by the slower wow oscillator,
      // so it breathes rather than sitting there as a clinical sine.
      var wowSig = Math.sin(this.ph1) * 0.7 + Math.sin(this.ph2) * 0.3;
      var flutSig = Math.sin(this.ph3) * (0.75 + 0.25 * Math.sin(this.ph2));
      var wobble = 1 + wowD * wowSig + flutD * flutSig;

      var out = [0, 0];
      var inSamp = [inL ? inL[s] : 0, inR ? inR[s] : (inL ? inL[s] : 0)];
      var ipk = inSamp[0] < 0 ? -inSamp[0] : inSamp[0];
      if (ipk > this.inPeak) this.inPeak = ipk;
      // A frozen deck's ring stops taking new audio, so a live freeze
      // holds the last four seconds of the room rather than slowly
      // morphing into whatever happens next. The rings are per deck, so
      // the other deck's capture is unaffected.
      if (!p.freeze[0]) this.inBuf[0][this.inW] = inSamp[0];
      if (!p.freeze[1]) this.inBuf[1][this.inW] = inSamp[1];
      this.inW = this.inW + 1 >= this.INLEN ? 0 : this.inW + 1;

      /* ---- GLOBAL MODULATION ---------------------------------------
         Four sources, three of which only a machine with transports can
         produce:
           0  LFO         ordinary free-running oscillator
           1  head drift  the gap between the two playheads. Evolves over
                          minutes and never repeats. Route it to AGE and the
                          machine degrades as the heads separate and cleans
                          up as they come back around
           2  playhead A  deck A's position as a rising ramp — the
                          modulation period IS the loop length
           3  playhead B  same for deck B
         Destinations: delay, reverb, age, output, both speeds, both filters. */
      var gm = 0;
      if (p.gmDepth > 0.0005) {
        if (p.gmSrc === 1) {
          gm = this.driftSamp / Math.max(1, len[0] * 0.5);
          if (gm > 1) gm = 1; else if (gm < -1) gm = -1;
        } else if (p.gmSrc === 2) {
          gm = ((this.pos[0] - sStart[0]) / sLen[0]) * 2 - 1;
        } else if (p.gmSrc === 3) {
          gm = ((this.pos[1] - sStart[1]) / sLen[1]) * 2 - 1;
        } else {
          this.gPh += p.gmRate / sr;
          if (this.gPh >= 1) this.gPh -= 1;
          gm = this.shape(this.gPh, 0, 2);
        }
        gm *= p.gmDepth;
      }

      for (d = 0; d < 2; d++) {
        var bi = d === 0 ? 0 : srcB;

        /* this.pos is the REEL position. rp is the same point expressed
           relative to whatever base/len the reads wrap against — the splice
           when it is resident, the window when it is not. */
        var rp = fits[d] ? (this.pos[d] - sStart[d])
                         : (this.pos[d] - this.winStart[bi]);

        /* When the splice is larger than the window, reads wrap at the
           BUFFER edges, which would be wrong. Keep the read point inside the
           guarded region so the interpolator's taps always land on real
           samples. If a refill is late the audio holds at the edge — a
           freeze, not a click — instead of splicing to unrelated tape. */
        var starved = 0;
        if (!fits[d]) {
          var gl = this.winGuard[bi][0], gh = this.winGuard[bi][1];
          var loLim = gl, hiLim = this.buf[bi].length - gh - 2;
          if (rp < loLim) { rp = loLim; starved = 1; }
          else if (rp > hiLim) { rp = hiLim; starved = 1; }
        }
        /* Latch the underrun until the gate has actually closed. Releasing
           as soon as data arrives would swap content back in at whatever
           gain the fade happened to reach — typically about half, which is
           audible. Holding until the gate is near zero means the content
           switch happens under silence. */
        if (starved) this.stHold[d] = 1;
        else if (this.stHold[d] && this.stFade[d] < 0.01) this.stHold[d] = 0;
        var gateTo = (starved || this.stHold[d]) ? 0 : 1;
        this.stFade[d] += stcoef * (gateTo - this.stFade[d]);

        /* ---- PER-DECK LFO --------------------------------------------
           Loop-synced by default, and this is the idea worth preserving:
           the phase is DERIVED from the playhead, so the rate control means
           "cycles per loop" rather than Hz. Modulation is locked to the
           material by construction — change splice length and the LFO rate
           follows, with no tempo setting and no sync logic anywhere.
           Free-running Hz is available as the alternative. */
        var lf = 0;
        if (p.lfoDepth[d] > 0.0005) {
          var lph;
          if (p.lfoSync[d]) {
            // Phase comes from position within the SPLICE, so the LFO period
            // is the loop length regardless of where the loop sits
            lph = ((this.pos[d] - sStart[d]) / sLen[d]) * p.lfoRate[d];
            lph = lph - Math.floor(lph);
          } else {
            this.lfoPh[d] += p.lfoRate[d] / sr;
            if (this.lfoPh[d] >= 1) this.lfoPh[d] -= 1;
            lph = this.lfoPh[d];
          }
          lf = this.shape(lph, p.lfoShape[d], d) * p.lfoDepth[d];
        }

        /* Destinations are resolved into per-parameter offsets here, BEFORE
           anything consumes them. An earlier version computed these after
           the rate line that uses mSpeed; because `var` is function-scoped,
           deck A read `undefined` (-> NaN) while deck B silently reused the
           previous iteration's value. Keep modulation resolution above its
           consumers. */
        var mSpeed = (p.lfoDest[d] === 0 ? lf : 0) + (p.gmDest === 4 ? gm : 0);
        var mFilt  = (p.lfoDest[d] === 1 ? lf : 0) + (p.gmDest === 5 ? gm : 0);
        var mLevel = p.lfoDest[d] === 2 ? lf : 0;
        var mSize  = p.lfoDest[d] === 3 ? lf : 0;
        var mDens  = p.lfoDest[d] === 4 ? lf : 0;
        var mSpray = p.lfoDest[d] === 5 ? lf : 0;

        /* Manual rate goes through the transport's 35ms inertia — a reel
           cannot change speed instantly, and that slew is what makes tape
           stop feel right.

           MODULATION DOES NOT. Routing it through the same one-pole means a
           ~4.5Hz lowpass on the LFO and CV, which crushes vibrato and makes
           audio-rate FM of the transport impossible. Modulation is added
           AFTER the slew with only enough smoothing (~1.5ms) to keep the
           control signal from zippering — the same place wow and flutter
           are applied, and for the same reason. */
        var frozen = p.freeze[d];
        if (frozen && !this.frzOn[d]) {
          this.frzOn[d] = 1; this.frzInW[d] = this.inW;
          /* Capture the moment's spectrum, once, from whichever source the
             deck is on. Tape fetch wraps at the splice like every other
             read; the live fetch reads the ring around the captured write
             head. */
          var self = this, cbi = bi, cbase = base[d], clen = len[d];
          var crp = fits[d] ? (this.pos[d] - sStart[d]) : (this.pos[d] - this.winStart[bi]);
          if (p.gLive[d]) {
            var cw = this.frzInW[d], cin = this.inBuf[d];
            this.spRequest(d, function (off) {
              var ix = (cw + off) % self.INLEN; if (ix < 0) ix += self.INLEN;
              return cin[ix | 0];
            });
          } else {
            var cbuf = this.buf[cbi];
            this.spRequest(d, function (off) {
              var ix = ((((crp + off) % clen) + clen) % clen) | 0;
              return cbuf[cbase + ix] * S16R;
            });
          }
        }
        else if (!frozen) {
          this.frzOn[d] = 0;
          if (this.spWait[d]) this.spWait[d] = null;   // never started; drop it
        }

        /* Frozen: the reel's target is zero, reached through the same 35ms
           inertia as any other speed change — engaging freeze IS a tape
           stop. The knob keeps its value; the grains below read at it. */
        var knobRate = ((stereo && d === 1) ? p.rate[0] : p.rate[d]) + mSpeed * 1.2;
        var tgt = frozen ? 0 : ((stereo && d === 1) ? p.rate[0] : p.rate[d]);
        this.rateSm[d] += slew * (tgt - this.rateSm[d]);
        this.modSm[d] += mslew * (mSpeed * 1.2 - this.modSm[d]);
        var rateNow = frozen ? this.rateSm[d] : (this.rateSm[d] + this.modSm[d]);
        /* The rate the HEADS read at, as opposed to the rate the REEL moves.
           They differ only under freeze — helical scan: tape still, drum
           spinning. Head loss and tape hiss follow this one, so a frozen
           drone keeps the machine's defining coupling: SPEED changes pitch
           AND brightness together. */
        var readRate = frozen
          ? (Math.abs(knobRate) < 0.02 ? 0.02 : Math.abs(knobRate))
          : rateNow;
        if (!this.play[d] && !p.gLive[d]) { out[d] = 0; continue; }

        var dens = Math.round(p.gDens[d] + mDens * 6);
        if (dens < 0) dens = 0;

        var live = p.gLive[d] ? 1 : 0;
        var x;

        if (live && dens < 1) {
          // LIVE with no grains: the input runs straight through the deck
          // strip, so filter, level and invert still apply
          x = inSamp[d];
          this.gCount[d] = 0;
        } else if (dens < 1) {
          // DENSITY at zero is a single playhead — the machine without grains
          x = this.read(this.buf[bi], base[d], len[d], rp);
          this.gCount[d] = 0;
        } else {
          if (dens > this.GMAX) dens = this.GMAX;
          var spray = p.gSpray[d] + mSpray;
          if (spray < 0) spray = 0; else if (spray > 1) spray = 1;
          var ramp = p.gRamp[d];
          var gsz = p.gSize[d] + mSize;
          if (gsz < 0) gsz = 0; else if (gsz > 1) gsz = 1;
          // 5ms to 500ms, logarithmic — the useful range for grains
          var gDur = 0.005 * Math.pow(100, gsz) * sr;
          if (frozen) {
            // A drone needs overlap: floor grain length at 110ms and the
            // envelope at mostly-soft while frozen. SIZE/RAMP can push
            // higher; they cannot make freeze stutter.
            var frMin = 0.11 * this.sr;
            if (gDur < frMin) gDur = frMin;
            if (ramp < 0.75) ramp = 0.75;
          }
          var interval = gDur / dens;

          /* GRAIN SCHEDULER. Countdown of `interval` samples between spawns,
             where interval = duration / density. That coupling is why SIZE
             and DENS interact the way they do on real granulators: longer
             grains at the same density spawn less often. */
          this.gNext[d] -= 1;
          // Frozen decks synthesize spectrally; no new grains are sown.
          // In-flight grains finish their envelopes and retire.
          if (this.gNext[d] <= 0 && !frozen) {
            /* FROZEN: the spawn clock is deliberately irregular. A strict
               interval machine-guns grains at duration/density Hz, and the
               periodic envelope sum is an audible ~50-100Hz tremolo — the
               'quivering, bowed' artifact. Jittering each interval ±40%
               spreads that energy into unpitched shimmer. Same reason
               drummers aren't metronomes: regularity is a sound. */
            this.gNext[d] += frozen
              ? interval * (0.6 + 0.8 * Math.abs(this.rnd()))
              : interval;
            var slot = -1;
            for (var gi = 0; gi < this.GMAX; gi++) if (!this.gOn[d][gi]) { slot = gi; break; }
            if (slot >= 0) {
              var sp;
              this.gLiveSrc[d][slot] = live ? 1 : 0;
              if (live) {
                /* LIVE SOURCE. Sit far enough behind the ring's write head
                   that a grain running at `rate` finishes before it catches
                   up to the present. SPRAY here reads as a delay in seconds
                   rather than a percentage, because that is what it is. */
                var anchor = frozen ? this.frzInW[d] : this.inW;
                var back = gDur * Math.max(1, Math.abs(frozen ? knobRate : rateNow)) * 1.05;
                var extra = Math.abs(this.rnd()) * (frozen
                  ? ((0.02 + spray * 0.38) * this.sr)
                  : (spray * (this.INLEN - back - 8)));
                sp = anchor - back - extra;
                sp = sp % this.INLEN; if (sp < 0) sp += this.INLEN;
              } else {
                /* TAPE SOURCE. Grains scatter around the playhead, bounded
                   by the splice region. That bounding is what keeps the
                   feature honest: the machine's strongest opinion is that
                   there is no random access — you spool, and spooling takes
                   real time. Grains jump around dozens of times a second,
                   which contradicts that. Confining them to a region you had
                   to spool to and cut means random access is bounded by a
                   physical splice. */
                /* TAPE SOURCE, in REEL coordinates. Scatter is bounded by
                   len[d] — the splice when it is resident, the window when
                   it is not — so a grain can only ever ask for samples that
                   are actually in memory.

                   Storing the position against the reel rather than the
                   buffer is what lets a grain survive a window swap: the
                   buffer moves, the grain does not. */
                var lo0 = fits[d] ? sStart[d] : this.winStart[bi];
                var jitter;
                if (frozen) {
                  /* FROZEN: the drone must come from ONE moment. Spray is a
                     small ABSOLUTE window around the stalled head — 20ms to
                     ~400ms — never a fraction of the splice. The original
                     bug: with the splice defaulting to the whole reel,
                     spray scattered grains across minutes of tape, and the
                     'drone' was a shuffle of unrelated micro-fragments. A
                     freeze that samples a six-hour reel and a freeze that
                     samples a three-second loop must sound identical. */
                  var fwin = (0.02 + spray * 0.38) * this.sr;
                  if (fwin > len[d] * 0.5) fwin = len[d] * 0.5;
                  jitter = this.rnd() * fwin;
                } else {
                  jitter = this.rnd() * spray * len[d] * 0.5;
                }
                sp = this.pos[d] + jitter;
                sp = lo0 + (((sp - lo0) % len[d]) + len[d]) % len[d];
              }
              this.gPos[d][slot] = sp;
              this.gLast[d][slot] = 0;
              this.gFade[d][slot] = 1;
              this.gAge[d][slot] = 0;
              /* Frozen grains also vary in LENGTH (±30%) — identical
                 durations make the envelope sum periodic even with jittered
                 starts — and keep their pans close to centre: a new random
                 pan every spawn is a fast stereo flicker on a held chord. */
              this.gLen[d][slot] = frozen
                ? gDur * (0.75 + 0.55 * Math.abs(this.rnd()))
                : gDur;
              this.gDet[d][slot] = frozen ? 1 + this.rnd() * 0.004 : 1;
              this.gPan[d][slot] = frozen
                ? 0.5 + this.rnd() * 0.12
                : 0.5 + this.rnd() * spray * 0.5;
              this.gOn[d][slot] = 1;
            }
          }

          /* Sum every active grain. Each carries its own position, age and
             duration, so they overlap freely.
             NOTE: this counter is deliberately NOT called `live` — `var` is
             function-scoped in JS, and an earlier version shadowed the
             live/tape source flag with it. */
          x = 0;
          var nLive = 0;
          /* Grain read rate. Normally the transport's; when frozen, the
             SPEED knob's — the heads keep spinning while the reel stands
             still. Guarded away from zero so a grain never degenerates to
             reading one sample (which is DC plus envelope thumps). */
          var gr = (frozen ? (Math.abs(knobRate) < 0.02 ? (knobRate < 0 ? -0.02 : 0.02) : knobRate)
                           : rateNow) * wobble;
          var wLen2 = this.buf[bi].length;
          var wLo = this.winStart[bi] + this.winGuard[bi][0];
          var wHi = this.winStart[bi] + wLen2 - this.winGuard[bi][1];
          for (var gj = 0; gj < this.GMAX; gj++) {
            if (!this.gOn[d][gj]) continue;
            var isLive = this.gLiveSrc[d][gj];
            var gp2 = this.gPos[d][gj];
            var rd;
            if (isLive) {
              rd = this.readFast(this.inBuf[d], 0, this.INLEN, gp2);
            } else {
              /* Reel position -> offset into whichever window is resident
                 now. A window swap can strand a grain outside memory. The
                 re-centred window overlaps heavily so it is rare, but there
                 is no correct sample to read when it happens — and both
                 obvious answers are wrong: killing the grain steps from
                 whatever its envelope was down to zero, and clamping to the
                 window edge steps to unrelated audio.

                 So hold the grain's own last sample and fade it out over
                 ~3ms. No discontinuity, because the first faded sample is
                 exactly the previous one. */
              if (gp2 < wLo || gp2 >= wHi - 2 || this.gFade[d][gj] < 1) {
                /* ONCE A GRAIN STARTS DYING, IT STAYS DEAD. Under window
                   thrash a grain can leave the window, begin this fade, and
                   then find itself back inside as the window moves again.
                   Resuming the read would jump from the faded hold value
                   back to full amplitude — the exact click the fade exists
                   to prevent. So the fade is a latch, not a condition. */
                this.gFade[d][gj] *= gfade;
                if (this.gFade[d][gj] < 0.002) { this.gOn[d][gj] = 0; continue; }
                rd = this.gLast[d][gj] * this.gFade[d][gj];
              } else {
                rd = this.readFast(this.buf[bi], 0, wLen2,
                                   gp2 - this.winStart[bi]) * S16R;
                this.gLast[d][gj] = rd;
              }
            }
            nLive++;
            x += rd * this.genv(this.gAge[d][gj] / this.gLen[d][gj], ramp);

            gp2 += gr * this.gDet[d][gj];
            if (isLive) {
              if (gp2 >= this.INLEN) gp2 -= this.INLEN;
              else if (gp2 < 0) gp2 += this.INLEN;
            } else {
              var lo1 = fits[d] ? sStart[d] : wLo;
              var ln1 = fits[d] ? sLen[d] : wLen2;
              if (gp2 >= lo1 + ln1) gp2 -= ln1;
              else if (gp2 < lo1) gp2 += ln1;
            }
            this.gPos[d][gj] = gp2;

            this.gAge[d][gj] += 1;
            if (this.gAge[d][gj] >= this.gLen[d][gj]) this.gOn[d][gj] = 0;
          }
          this.gCount[d] = nLive;
          /* Overlapping grains sum; normalise by density and by how much of
             each grain is at full amplitude, so these knobs change texture
             rather than level. */
          /* Overlapping grains sum, and how much they sum by depends on
             both density and how much of each grain sits at full amplitude
             (which RAMP controls). Normalising by both means SIZE, DENS and
             RAMP change TEXTURE rather than LEVEL — measured RMS holds
             within about a dB across the entire range. */
          x *= 1.5 / Math.sqrt(Math.max(1, dens) * (0.35 + 0.65 * (1 - ramp * 0.6)));
        }

        /* Head gap loss: one-pole whose corner tracks transport speed.
           Deliberately NOT under AGE — this is what makes it sound like
           tape rather than like damage, so it is always on. */
        /* HEAD GAP LOSS — the most important line in the tape model.
           Playback head response is proportional to tape speed, so slow tape
           genuinely loses treble on top of the pitch shift. That coupling is
           most of the illusion: switch this off at 0.25x and the effect
           collapses into "pitched-down audio".

           DOCTRINE: always on, never under AGE. AGE says how OLD the tape
           is; at AGE 0 this must still sound like a tape machine rather
           than a clean sampler. */
        /* Frozen path: spectral resynthesis, crossfaded with freeze state,
           then diffused. The tape path fades out underneath as fm rises. */
        var fm = this.frzMix[d];
        fm += fmSlew * ((frozen ? 1 : 0) - fm);
        this.frzMix[d] = fm;
        if (fm > 0.001 && this.spHave[d]) {
          /* One interpolated read per sample — no transform, no scheduling,
             no spikes. SPEED transposes by changing the read rate, and the
             wrap stays seamless at any rate because the buffer is exactly
             periodic. */
          var spv = this.spRead(d, this.spPos[d]);
          var sr2 = knobRate;
          if (sr2 > -0.02 && sr2 < 0.02) sr2 = sr2 < 0 ? -0.02 : 0.02;
          var np2 = this.spPos[d] + sr2;
          if (np2 >= this.SPL) np2 -= this.SPL;
          else if (np2 < 0) np2 += this.SPL;
          this.spPos[d] = np2;
          x = x + fm * (spv - x);
        }
        if (fm > 0.001) {
          var dx = x, yv, abf, aix, zv;
          for (var ap = 0; ap < 4; ap++) {
            abf = this.apBuf[bi][ap];
            aix = this.apIdx[bi][ap];
            zv = abf[aix];
            yv = zv - 0.6 * dx;
            abf[aix] = dx + 0.6 * yv;
            aix = aix + 1 >= abf.length ? 0 : aix + 1;
            this.apIdx[bi][ap] = aix;
            dx = yv;
          }
          x = x + fm * (dx - x);
        }

        if (this.headLoss) {
          var rr = Math.abs(readRate) || 0.001;
          var fc = 11000 * Math.max(0.04, Math.min(3, rr));
          if (fc > sr * 0.45) fc = sr * 0.45;
          var kc = 1 - Math.exp(-TWO_PI * fc / sr);
          this.hl[d] += kc * (x - this.hl[d]);
          x = this.hl[d];
        }

        /* TWO HISS SOURCES. Tape hiss is physically on the medium, so it
           varies with transport speed. Electronics hiss comes after the head
           and does not. Almost nobody models both; the difference is
           audible as soon as you sweep speed. */
        x += this.rnd() * hissTape * (0.3 + 0.7 * Math.min(1, Math.abs(readRate)));
        x += this.rnd() * hissElec;

        /* DROPOUT. Rare random amplitude sags that recover through a
           one-pole, so level breathes back rather than switching. Gated by
           AGE squared so it stays out of the way until the tape is old. */
        if (dropRate > 0.001) {
          var want = 1;
          if (this.rnd() > 1 - dropRate * 0.00035) want = 0.25 + 0.5 * Math.abs(this.rnd());
          this.drop[d] += 0.0016 * (want - this.drop[d]);
          this.drop[d] += 0.0009 * (1 - this.drop[d]);
          x *= this.drop[d];
        }

        /* Underrun handling. A gate alone is not enough: the moment the
           playhead runs past resident audio, the clamped read jumps to
           different content in ONE sample, and a 3ms gate cannot outrun a
           one-sample step. So while starved, hold the deck's own last good
           sample and fade THAT — the first faded sample is exactly the
           previous one, so there is no discontinuity to hear. */
        if (starved || this.stHold[d]) x = this.lastX[d];
        else this.lastX[d] = x;
        x *= this.stFade[d];

        var fq = p.filter[d] + mFilt;
        if (fq < -1) fq = -1; else if (fq > 1) fq = 1;
        x = this.svf(d, x, fq);
        x *= p.level[d] * (1 + mLevel * 0.9);
        if (p.invert[d]) x = -x;
        out[d] = x;

        // advance
        var rBase = rateNow * wobble;
        var rr2 = (stereo && d === 1) ? rBase : rBase * (1 + p.offset[d]);
        /* Loop or one-shot. In one-shot the deck stops at the splice end
           rather than wrapping — which is what you want when the "tape" is
           a playlist you mean to play through once and stop. */
        /* ADVANCE. The playhead lives in reel coordinates and wraps at the
           SPLICE, which is the only loop the machine has. Whether those
           samples happen to be resident is not this code's problem — that is
           the host's job, and the code is identical whether the reel is
           three seconds or six hours. */
        this.pos[d] += rr2;
        var sEnd = sStart[d] + sLen[d];
        if (this.pos[d] >= sEnd) {
          if (p.loop[d]) this.pos[d] -= sLen[d];
          else { this.pos[d] = sEnd - 1;
                 if (this.play[d]) this.stopEvt[d] = 1;
                 this.play[d] = false; }
        } else if (this.pos[d] < sStart[d]) {
          if (p.loop[d]) this.pos[d] += sLen[d];
          else { this.pos[d] = sStart[d];
                 if (this.play[d]) this.stopEvt[d] = 1;
                 this.play[d] = false; }
        }
        this.gpos[d] = this.pos[d];



        /* ---- RECORD HEAD ---------------------------------------------
           Input arrives at one sample per output sample, but the tape only
           advances by `rate`. Below 1x that means several input samples land
           on one tape position, so everything above the tape's effective
           Nyquist folds back unless it is filtered first. The read path is
           protected by the sinc window; the write path is protected by
           nothing but this. */
        if (this.rec[d]) {
          var rmag = Math.abs(rateNow); if (rmag < 0.002) rmag = 0.002;
          var kIn = 1 - Math.exp(-TWO_PI * 0.42 * Math.min(1, rmag));
          this.recLp1[d] += kIn * (inSamp[d] * p.recGain - this.recLp1[d]);
          this.recLp2[d] += kIn * (this.recLp1[d] - this.recLp2[d]);
          var wsig = this.recLp2[d];

          var er = p.erase[d];
          var buf = this.buf[bi];
          var ti = Math.floor(rp);
          if (ti >= len[d]) ti = len[d] - 1; else if (ti < 0) ti = 0;
          var last = this.recLast[d];
          if (last < 0 || last >= len[d]) { last = ti; this.recLast[d] = ti; }
          if (ti !== last) {
            // write every tape position crossed, so nothing is skipped above 1x
            var dir = rr2 >= 0 ? 1 : -1;
            var guard = 0;
            while (last !== ti && guard < 96) {
              last += dir;
              if (last >= len[d]) last -= len[d]; else if (last < 0) last += len[d];
              var acc2 = buf[base[d] + last] * er + wsig * S16;
              if (acc2 > S16) acc2 = S16; else if (acc2 < -S16) acc2 = -S16;
              buf[base[d] + last] = acc2;
              guard++;
            }
            this.recLast[d] = ti;
          }
        }
      }

      /* Deck A left, deck B right. Hard-panned in STEREO so the image is
         true; otherwise crossed 0.86/0.34 so drift is audible as movement
         across the field rather than as two separate mono streams. */
      var xl, xr;
      if (stereo) { xl = out[0]; xr = out[1]; }
      else { xl = out[0] * 0.86 + out[1] * 0.34; xr = out[0] * 0.34 + out[1] * 0.86; }

      // --- master delay, lightly cross-fed and damped in the loop
      var rIdx = this.dlW - dSamp; if (rIdx < 0) rIdx += this.dlMax;
      var dL = this.dl[0][rIdx], dR = this.dl[1][rIdx];
      this.dlLp[0] += 0.36 * (dL - this.dlLp[0]);
      this.dlLp[1] += 0.36 * (dR - this.dlLp[1]);
      this.dl[0][this.dlW] = xl + this.dlLp[1] * dFb;
      this.dl[1][this.dlW] = xr + this.dlLp[0] * dFb;
      this.dlW = (this.dlW + 1) % this.dlMax;
      /* Modulation offsets are computed into LOCALS, never written back to
         the loop-invariant variables. An earlier version did `rvMix = rvMix
         + gm` inside the sample loop, which accumulated every sample and ran
         away. Watch for this pattern anywhere modulation meets a hoisted
         variable. */
      var dM = dMix + (p.gmDest === 0 ? gm : 0);
      if (dM < 0) dM = 0; else if (dM > 1.4) dM = 1.4;
      xl += dL * dM; xr += dR * dM;

      // --- master reverb
      var rvM = rvMix + (p.gmDest === 1 ? gm : 0);
      if (rvM < 0) rvM = 0; else if (rvM > 1.4) rvM = 1.4;
      if (rvM > 0.001) {
        var mono = (xl + xr) * 0.5;
        xl += this.reverb(0, mono) * rvM;
        xr += this.reverb(1, mono) * rvM;
      }

      var satM = sat * (1 + (p.gmDest === 2 ? gm : 0) * 0.8);
      if (satM < 0.2) satM = 0.2;
      var ogM = outG * (1 + (p.gmDest === 3 ? gm : 0) * 0.9);
      if (ogM < 0) ogM = 0;
      xl = Math.tanh(xl * satM) / Math.tanh(satM) * ogM;
      xr = Math.tanh(xr * satM) / Math.tanh(satM) * ogM;

      L[s] = xl; if (R !== L) R[s] = xr;

      var a0 = xl < 0 ? -xl : xl; if (a0 > pk0) pk0 = a0;
      var a1 = xr < 0 ? -xr : xr; if (a1 > pk1) pk1 = a1;
    }

    this.peak[0] = pk0; this.peak[1] = pk1;
    if (this.rec[0] || this.rec[1]) {
      this.pkTimer += n;
      if (this.pkTimer > sr * 0.4) { this.pkTimer = 0; this.wantPeaks = 1; }
    }
    var dd = this.pos[0] - this.pos[1];
    if (dd > sLen[0] / 2) dd -= sLen[0];
    if (dd < -sLen[0] / 2) dd += sLen[0];
    // Head markers show position within the SPLICE
    this.normA = (this.pos[0] - sStart[0]) / sLen[0];
    this.normB = (this.pos[1] - sStart[1]) / sLen[1];
    // Reel readout and the host's window policy need the rest
    this.reelPos = [this.pos[0] / (this.reelLen[0] || 1), this.pos[1] / (this.reelLen[1] || 1)];
    this.fits = [fits[0], fits[1]];
    this.spliceS = [sStart[0], sStart[1]];
    this.spliceL = [sLen[0], sLen[1]];
    this.driftSamp = dd;
    this.driftSec = dd / sr;
  };

  return TapeEngine;
}

const TapeEngine = engineFactory();

/* --------------------------------------------------------------------
 * The AudioWorklet.
 *
 * Built as a STRING because a worklet runs in its own global scope with no
 * module access. engineFactory.toString() embeds the identical engine
 * source, so the worklet and the main thread are provably running the same
 * DSP — there is no second implementation to drift.
 *
 * The processor is deliberately thin: unwrap buffers, call render(), post
 * telemetry every 4th block (~11ms), push peak data when the engine asks.
 * All the intelligence is below it, in the portable core.
 * ------------------------------------------------------------------ */
const WORKLET_SRC =
  "var __mk = " + engineFactory.toString() + ";\n" +
  "var TapeEngine = __mk();\n" +
  "class TL1Processor extends AudioWorkletProcessor {\n" +
  "  constructor() {\n" +
  "    super();\n" +
  "    this.eng = new TapeEngine(sampleRate);\n" +
  "    this.blk = 0;\n" +
  "    this.port.onmessage = (e) => {\n" +
  "      var d = e.data;\n" +
  "      if (d.type === 'tape') this.eng.setTape(d.deck, d.data);\n" +
  "      else if (d.type === 'window') this.eng.setWindow(d.deck, d.data, d.start, d.reelLen, d.gLo, d.gHi);\n" +
  "      else if (d.type === 'blank') { this.eng.blank(d.deck, d.n); this.post(d.deck); }\n" +
  "      else if (d.type === 'peaks') this.post(d.deck);\n" +
  "      else if (d.type === 'params') this.eng.setParams(d.p);\n" +
  "      else if (d.type === 'config') this.eng.setConfig(d);\n" +
  "      else if (d.type === 'transport') this.eng.transport(d);\n" +
  "    };\n" +
  "  }\n" +
  "  post(d) {\n" +
  "    var pk = this.eng.peaks(d, 900);\n" +
  "    if (pk) this.port.postMessage({ type: 'peaks', deck: d, pk: pk }, [pk.buffer]);\n" +
  "  }\n" +
  "  process(inputs, outputs) {\n" +
  "    var out = outputs[0];\n" +
  "    var L = out[0], R = out.length > 1 ? out[1] : out[0];\n" +
  "    var inp = inputs[0] || [];\n" +
  "    try {\n" +
  "      this.eng.render(L, R, L.length, inp[0] || null, inp[1] || null);\n" +
  "    } catch (err) {\n" +
  "      if (!this.died) { this.died = 1;\n" +
  "        this.port.postMessage({ type: 'engineError',\n" +
  "          message: err && err.stack ? err.stack : String(err) }); }\n" +
  "      for (var z = 0; z < L.length; z++) { L[z] = 0; if (R !== L) R[z] = 0; }\n" +
  "      return true;\n" +
  "    }\n" +
  "    if (this.eng.wantPeaks) { this.eng.wantPeaks = 0; this.post(0); this.post(1); }\n" +
  "    if ((this.blk++ & 3) === 0) {\n" +
  "      this.port.postMessage({ a: this.eng.normA, b: this.eng.normB,\n" +
  "        driftSec: this.eng.driftSec, driftSamp: this.eng.driftSamp,\n" +
  "        inPeak: this.eng.inPeak, rec: [this.eng.rec[0], this.eng.rec[1]],\n" +
  "        play: [this.eng.play[0], this.eng.play[1]],\n" +
  "        stopEvt: [this.eng.stopEvt[0], this.eng.stopEvt[1]],\n" +
  "        gpos: [this.eng.pos[0], this.eng.pos[1]],\n" +
  "        win: [this.eng.winStart[0], this.eng.winStart[1]],\n" +
  "        wlen: [this.eng.buf[0] ? this.eng.buf[0].length : 0,\n" +
  "               this.eng.buf[1] ? this.eng.buf[1].length : 0],\n" +
  "        reelPos: this.eng.reelPos, fits: this.eng.fits,\n" +
  "        guard: [this.eng.winGuard[0][0], this.eng.winGuard[0][1],\n" +
  "                this.eng.winGuard[1][0], this.eng.winGuard[1][1]],\n" +
  "        spliceS: this.eng.spliceS, spliceL: this.eng.spliceL,\n" +
  "        pk: [this.eng.peak[0], this.eng.peak[1]] });\n" +
  "      this.eng.inPeak = 0;\n" +
  "      this.eng.stopEvt[0] = 0; this.eng.stopEvt[1] = 0;\n" +
  "    }\n" +
  "    return true;\n" +
  "  }\n" +
  "}\n" +
  "registerProcessor('tl1', TL1Processor);\n";

/* Test material, generated rather than shipped so the app stays a single
   file. A sustained low chord plus bright inharmonic pings — the pings put
   real energy around 8kHz, which is exactly where interpolation error shows
   itself once you drop the speed. `variant` shifts the chord and the ping
   timing so BOTH decks can be loaded with related-but-different loops,
   which gives SPLIT mode something to say.

   Original comment: sustained chord plus bright inharmonic pings. The pings put
   real energy around 8 kHz, which is where interpolation error shows up
   first once you drop the speed. */
function makeTestLoop(sr, variant) {
  const n = Math.floor(sr * 6);
  const out = new Float32Array(n);   // built in float, converted at the end
  const chord = variant ? [98, 146.83, 196, 293.66] : [110, 164.81, 220, 329.63];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = 0;
    for (let c = 0; c < chord.length; c++) {
      s += Math.sin(2 * Math.PI * chord[c] * t) * 0.055;
      s += Math.sin(2 * Math.PI * chord[c] * 3 * t) * 0.011;
    }
    out[i] = s;
  }
  const partials = [2093, 2637, 3136, 4186, 5274, 6272, 7902];
  for (let p = 0; p < 8; p++) {
    const start = Math.floor((p * 0.75 + (variant ? 0.31 : 0)) * sr);
    const len = Math.floor(sr * 0.7);
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / sr, env = Math.exp(-t * 7);
      let s = 0;
      for (let q = 0; q < partials.length; q++) {
        s += Math.sin(2 * Math.PI * partials[q] * (1 + 0.0007 * q) * t) * (0.13 / (q + 1));
      }
      out[start + i] += s * env * 0.55;
    }
  }
  const xf = Math.floor(sr * 0.02);
  for (let i = 0; i < xf; i++) {
    const g = i / xf;
    out[i] *= g; out[n - 1 - i] *= g;
  }
  return toTape(out, n);
}

/* Float audio -> int16 tape, with clipping. This is the same conversion the
   firmware does when writing to SDRAM. */
function toTape(src, n) {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let v = src[i] * 32767;
    if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
    out[i] = v;
  }
  return out;
}

/* Safari still only implements the CALLBACK form of decodeAudioData, and
   returns undefined rather than a promise. `await undefined` yields
   undefined, and reading .length off that throws — which then gets caught
   and reported as "decode failed", sending you hunting for a codec problem
   that does not exist. This wrapper supports both forms and guarantees the
   promise settles exactly once. */
function decodeAudio(ctx, ab) {
  return new Promise((resolve, reject) => {
    let done = false;
    const ok = (b) => { if (!done) { done = true; resolve(b); } };
    const bad = (e) => { if (!done) { done = true; reject(e || new Error("decoder rejected the file")); } };
    let p;
    try { p = ctx.decodeAudioData(ab, ok, bad); } catch (e) { bad(e); return; }
    if (p && typeof p.then === "function") p.then(ok, bad);
  });
}

/* Tape length is no longer a meaningful limit — buffers are int16, same as
   the hardware, so an hour of mono costs ~173MB rather than ~346MB. The cap
   is only here to give a clear message instead of an allocation failure.

   NOTE: the real machine holds ~5.6 min per deck in SDRAM and streams
   anything longer through a sliding window from the card (see PROJECT.md ->
   Storage model). The harness loads the whole file instead, because
   simulating the window would get in the way of actually using this to make
   things. Windowing is milestone M4 and belongs in the C++ port. */
const MAX_SECONDS = 3600;

/* Palette. Gunmetal body, and the ONLY colour on the machine is emitted
   light: deck A is a blood red, deck B a pale red — one hue in two values,
   which reads as one instrument with a dark end and a light end rather than
   as two colour-coded channels.

   Note these are brighter than the equivalent paint would be. A blood red
   as pigment is around #96201F; as LIGHT it wants ~#C8302A or it reads
   brown. Everything emissive on this machine shifts a stop warmer. */
const C = {
  edge: "#171A1C", chassis: "#1E2225", panel: "#2E3438", hi: "#3B4247",
  well: "#22272A", bone: "#C9CDC9", dim: "#6C7377", brass: "#8E9698",
  a: "#C8302A", b: "#E8A79A", glass: "#0A0C0D"
};

function Panel({ title, accent, children, className = "" }) {
  return (
    <section
      className={"relative rounded p-3 " + className}
      style={{ background: C.hi, boxShadow: "inset 0 1px 0 #474F54, 0 1px 3px rgba(0,0,0,.5)" }}
    >
      {title && (
        <>
          <div className="mb-2 h-px" style={{ background: accent || C.brass, boxShadow: `0 0 8px ${accent || C.brass}` }} />
          <h2 className="mb-3 text-center text-[11px] uppercase tracking-[0.28em]" style={{ color: C.bone }}>
            {title}
          </h2>
        </>
      )}
      {children}
    </section>
  );
}

/* Knob. Drag vertically; hold shift for fine adjustment.

   The value is shown ABOVE the knob rather than on hover, for the same
   reason the real machine puts numbers on its screen: you should be able to
   read the state of the instrument without touching it.

   Rendered as SVG with a real tick ring and a glowing pointer, because the
   harness doubles as a look study for the panel. Carries slider ARIA roles
   so it is at least reachable by assistive tech. */
function Knob({ label, sub, value, min, max, step, onChange, format, accent, size = 62 }) {
  const ref = useRef(null);
  const drag = useRef(null);

  const norm = (value - min) / (max - min);
  const ang = -215 + norm * 250;
  const rad = (ang * Math.PI) / 180;
  const r = size / 2;
  const px = r + (r - 8) * Math.cos(rad);
  const py = r + (r - 8) * Math.sin(rad);

  const onDown = (e) => {
    e.preventDefault();
    drag.current = { y: e.clientY ?? e.touches[0].clientY, v: value };
    const move = (ev) => {
      const y = ev.clientY ?? (ev.touches && ev.touches[0].clientY);
      if (y == null || !drag.current) return;
      const dy = drag.current.y - y;
      const fine = ev.shiftKey ? 0.15 : 1;
      let nv = drag.current.v + (dy / 180) * (max - min) * fine;
      nv = Math.max(min, Math.min(max, Math.round(nv / step) * step));
      onChange(nv);
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const ticks = [];
  for (let i = 0; i <= 10; i++) {
    const a = ((-215 + i * 25) * Math.PI) / 180;
    ticks.push(
      <line key={i}
        x1={r + (r - 2) * Math.cos(a)} y1={r + (r - 2) * Math.sin(a)}
        x2={r + (r + 3) * Math.cos(a)} y2={r + (r + 3) * Math.sin(a)}
        stroke={C.dim} strokeWidth="1.1" opacity="0.5" />
    );
  }

  return (
    <div className="flex flex-col items-center select-none">
      <div className="mb-0.5 text-[10px] tabular-nums" style={{ color: accent }}>
        {format ? format(value) : value.toFixed(2)}
      </div>
      <svg ref={ref} width={size + 10} height={size + 10} onPointerDown={onDown}
        className="cursor-ns-resize touch-none" role="slider"
        aria-label={label} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max}>
        <g transform="translate(5,5)">
          {ticks}
          <circle cx={r} cy={r} r={r - 3} fill={C.well} stroke="#141719" strokeWidth="2" />
          <circle cx={r} cy={r} r={r - 8} fill="none" stroke={accent} strokeWidth="1.2" opacity="0.8" />
          <line x1={r} y1={r} x2={px} y2={py} stroke={accent} strokeWidth="3" strokeLinecap="round" />
        </g>
      </svg>
      <div className="mt-0.5 text-[10px] uppercase tracking-[0.2em]" style={{ color: C.bone }}>{label}</div>
      {sub && <div className="text-[8px] uppercase tracking-wider" style={{ color: C.dim }}>{sub}</div>}
    </div>
  );
}

/* Button. Unlit is bare blasted metal; lit is a GLOWING OUTLINE plus the
   label taking the accent colour — never a filled slab of colour. That is
   the LED doctrine made literal: the panel has no colour on it at all when
   the machine is powered down. */
function Btn({ label, lit, accent, onClick, onDown, onUp, wide }) {
  return (
    <button
      onClick={onClick}
      onPointerDown={onDown}
      onPointerUp={onUp}
      /* Spring-release only if a press is actually in flight. A bare
         onPointerLeave fires on any cursor crossing — wired straight to
         onUp it 'released' scrubs that never began, restoring a rate that
         was never captured. e.buttons tells the truth. */
      onPointerLeave={(e) => { if (e.buttons !== 0 && onUp) onUp(e); }}
      onPointerCancel={onUp}
      className={"rounded-sm py-2 text-[10px] uppercase tracking-[0.18em] touch-none " + (wide ? "flex-[1.4]" : "flex-1")}
      style={{
        background: C.well,
        color: lit ? accent : C.bone,
        border: "1px solid #141719",
        boxShadow: lit ? `inset 0 0 0 1.5px ${accent}, 0 0 12px ${accent}55` : "inset 0 0 0 1px #454C5088"
      }}
    >
      {label}
    </button>
  );
}

function Seg({ options, value, onChange, accent, label }) {
  return (
    <div>
      {label && <div className="mb-1 text-center text-[9px] uppercase tracking-[0.22em]" style={{ color: C.bone }}>{label}</div>}
      <div className="flex gap-1">
        {options.map((o, i) => (
          <button key={o} onClick={() => onChange(i)}
            className="flex-1 rounded-sm py-1.5 text-[9px] uppercase tracking-[0.14em]"
            style={{
              background: C.well,
              color: value === i ? accent : C.dim,
              border: "1px solid #141719",
              boxShadow: value === i ? `inset 0 0 0 1.5px ${accent}, 0 0 10px ${accent}44` : "none"
            }}>
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

const INTERPS = ["Linear", "Hermite", "Sinc"];
const HEADS = ["LINK", "STEREO", "SPLIT"];
const HEAD_NOTE = [
  "Two playheads on one tape. Set OFFSET and they drift — this is the Reich topology.",
  "Two decks locked as L and R. Deck B follows deck A's transport; LEVEL becomes balance.",
  "Two independent tapes, independent lengths and speeds. Collage and Eno-style loops."
];

/* ====================================================================
 * TL1 — the host.
 *
 * Everything below this line is the browser's equivalent of the firmware's
 * HAL: audio context setup, microphone capture, file decoding, control
 * state, and the screen renderer. None of it does DSP.
 *
 * When this becomes the real project, this component splits into
 * /hosts/wasm (audio + storage + input) and /web (UI rendered from
 * panel.json). The engine above moves to /core/dsp untouched.
 * ================================================================== */
export default function TL1() {
  const ctxRef = useRef(null);
  const nodeRef = useRef(null);
  const engRef = useRef(null);
  const spRef = useRef(null);
  const peaksRef = useRef([null, null]);
  const telRef = useRef({ a: 0, b: 0, driftSec: 0, driftSamp: 0, pk: [0, 0] });
  // Engine-initiated stops (one-shot reel end), OR-accumulated so an event
  // can't be lost when telemetry messages outpace the 250ms UI tick
  const stopEvtRef = useRef([0, 0]);
  const canvasRef = useRef(null);
  const rafRef = useRef(0);

  const [engineKind, setEngineKind] = useState("");
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("No tape loaded.");
  const [names, setNames] = useState(["—", "—"]);
  const [secs, setSecs] = useState([0, 0]);
  const [loadTarget, setLoadTarget] = useState(2);   // 0 A, 1 B, 2 BOTH
  const [loop, setLoop] = useState([true, true]);
  const [marks, setMarks] = useState([[], []]);      // track boundaries, 0..1
  const [reelInfo, setReelInfo] = useState(null);    // { tracks, minutes, streaming }
  /* The "card": a Blob of raw int16 samples. Large blobs are backed by disk
     by the browser, so a reel of any length costs no RAM — which is exactly
     the hardware's model, where the card is the reel and only a window is
     resident. */
  const reelRef = useRef([null, null]);              // per deck: { blob, len }
  const winBusy = useRef([false, false]);

  const [rate, setRate] = useState([1, 1]);
  const [level, setLevel] = useState([0.8, 0.8]);
  const [filter, setFilter] = useState([0, 0]);
  const [offset, setOffset] = useState([0, 0.0015]);
  const [gSize, setGSize] = useState([0.28, 0.28]);
  const [gDens, setGDens] = useState([0, 0]);
  const [gSpray, setGSpray] = useState([0.25, 0.25]);
  const [gRamp, setGRamp] = useState([0.5, 0.5]);
  const [gLive, setGLive] = useState([false, false]);
  const [lfoRate, setLfoRate] = useState([1, 1]);
  const [lfoDepth, setLfoDepth] = useState([0, 0]);
  const [lfoShape, setLfoShape] = useState([0, 0]);
  const [lfoDest, setLfoDest] = useState([1, 1]);
  const [lfoSync, setLfoSync] = useState([true, true]);
  const [gmSrc, setGmSrc] = useState(0);
  const [gmRate, setGmRate] = useState(0.1);
  const [gmDepth, setGmDepth] = useState(0);
  const [gmDest, setGmDest] = useState(0);
  const [loopStart, setLoopStart] = useState([0, 0]);
  const [loopLen, setLoopLen] = useState([1, 1]);
  const [play, setPlay] = useState([false, false]);
  const [rec, setRec] = useState([false, false]);
  const [freeze, setFreeze] = useState([false, false]);
  const [erase, setErase] = useState([1, 1]);
  const [invert, setInvert] = useState([false, false]);
  const [recGain, setRecGain] = useState(1);

  const [heads, setHeads] = useState(0);
  const [age, setAge] = useState(0.25);
  const [delay, setDelay] = useState(0);
  const [delayTime, setDelayTime] = useState(0.375);
  const [reverb, setReverb] = useState(0.15);
  const [output, setOutput] = useState(0.8);
  const [interp, setInterp] = useState(2);
  const [headLoss, setHeadLoss] = useState(true);
  const [view, setView] = useState(0);

  const [tel, setTel] = useState({ sec: 0, samp: 0, pk: [0, 0], inPeak: 0 });

  /* Single message path to the engine, whichever host is live. The worklet
     gets postMessage; the main-thread fallback gets a direct call. Nothing
     else in the UI knows which one is running. */
  const send = useCallback((msg) => {
    if (nodeRef.current) nodeRef.current.port.postMessage(msg, msg.transfer || []);
    else if (engRef.current) {
      const e = engRef.current;
      if (msg.type === "tape") e.setTape(msg.deck, msg.data);
      else if (msg.type === "window") e.setWindow(msg.deck, msg.data, msg.start, msg.reelLen, msg.gLo, msg.gHi);
      else if (msg.type === "params") e.setParams(msg.p);
      else if (msg.type === "config") e.setConfig(msg);
      else if (msg.type === "transport") e.transport(msg);
    }
  }, []);

  /* Lazily build the audio graph on first use — browsers require a user
     gesture before an AudioContext will start. Tries the three hosts in
     descending order of quality and reports which one it got. */
  const ensureAudio = useCallback(async () => {
    if (ctxRef.current) return ctxRef.current;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();

    /* Three ways to get the DSP running, best first. Chrome rejects blob
       URLs inside an opaque-origin iframe, and CSP can block data: URLs,
       so we degrade to ScriptProcessor — deprecated and main-thread, but
       it runs the identical engine. */
    let loaded = false, why = "";
    if (ctx.audioWorklet) {
      const blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
      try { await ctx.audioWorklet.addModule(blobUrl); loaded = true; }
      catch (e) {
        why = e && e.message ? e.message : String(e);
        try {
          await ctx.audioWorklet.addModule("data:application/javascript;charset=utf-8," + encodeURIComponent(WORKLET_SRC));
          loaded = true;
        } catch (e2) { /* fall through */ }
      }
      URL.revokeObjectURL(blobUrl);
    }

    if (loaded) {
      const node = new AudioWorkletNode(ctx, "tl1", {
        numberOfInputs: 1, numberOfOutputs: 1,
        outputChannelCount: [2], channelCount: 2,
        channelCountMode: "explicit", channelInterpretation: "discrete"
      });
      node.port.onmessage = (e) => {
        const d = e.data;
        if (d.type === "peaks") {
          const nx = peaksRef.current.slice();
          nx[d.deck] = d.pk;
          peaksRef.current = nx;
        } else if (d.type === "engineError") {
          setStatus("Engine error: " + String(d.message).split("\n")[0]);
        } else {
          if (d.stopEvt) {
            stopEvtRef.current[0] |= d.stopEvt[0];
            stopEvtRef.current[1] |= d.stopEvt[1];
          }
          telRef.current = d;
        }
      };
      node.onprocessorerror = () => setStatus("Engine crashed — reload the page.");
      node.connect(ctx.destination);
      nodeRef.current = node;
      setEngineKind("AudioWorklet");
    } else {
      const eng = new TapeEngine(ctx.sampleRate);
      const sp = ctx.createScriptProcessor(4096, 2, 2);
      sp.onaudioprocess = (ev) => {
        const ob = ev.outputBuffer, ib = ev.inputBuffer;
        const L = ob.getChannelData(0), R = ob.getChannelData(1);
        const iL = ib.numberOfChannels > 0 ? ib.getChannelData(0) : null;
        const iR = ib.numberOfChannels > 1 ? ib.getChannelData(1) : iL;
        try {
          eng.render(L, R, L.length, iL, iR);
        } catch (err) {
          if (!eng.died) { eng.died = 1; setStatus("Engine error: " + String(err && err.message)); }
          L.fill(0); R.fill(0);
          return;
        }
        telRef.current = { a: eng.normA, b: eng.normB, driftSec: eng.driftSec,
          driftSamp: eng.driftSamp, inPeak: eng.inPeak, rec: [eng.rec[0], eng.rec[1]],
          play: [eng.play[0], eng.play[1]], pk: [eng.peak[0], eng.peak[1]],
          stopEvt: [eng.stopEvt[0], eng.stopEvt[1]],
          gpos: [eng.pos[0], eng.pos[1]], win: [eng.winStart[0], eng.winStart[1]],
          wlen: [eng.buf[0] ? eng.buf[0].length : 0, eng.buf[1] ? eng.buf[1].length : 0],
          reelPos: eng.reelPos, fits: eng.fits, spliceS: eng.spliceS, spliceL: eng.spliceL,
          guard: [eng.winGuard[0][0], eng.winGuard[0][1], eng.winGuard[1][0], eng.winGuard[1][1]] };
        eng.inPeak = 0;
        if (telRef.current.stopEvt) {
          stopEvtRef.current[0] |= telRef.current.stopEvt[0];
          stopEvtRef.current[1] |= telRef.current.stopEvt[1];
        }
        eng.stopEvt[0] = 0; eng.stopEvt[1] = 0;
        if (eng.wantPeaks) {
          eng.wantPeaks = 0;
          const nx = peaksRef.current.slice();
          nx[0] = eng.peaks(0, 900); nx[1] = eng.peaks(1, 900);
          peaksRef.current = nx;
        }
      };
      /* ScriptProcessor only fires while something is connected to its
         input. Before the mic exists, a silent constant source keeps it
         running so the transport still works. */
      const silent = ctx.createConstantSource();
      silent.offset.value = 0;
      silent.connect(sp);
      silent.start();
      sp.connect(ctx.destination);
      engRef.current = eng; spRef.current = sp;
      setEngineKind("ScriptProcessor (worklet blocked: " + (why || "unavailable") + ")");
    }
    ctxRef.current = ctx;
    return ctx;
  }, []);

  const micRef = useRef(null);
  const [micOn, setMicOn] = useState(false);

  /* Live input. echoCancellation, noiseSuppression and autoGainControl are
     all explicitly OFF — they are speech-optimised and would destroy exactly
     the material this machine exists to capture.

     FEEDBACK WARNING is not incidental: the monitor path plays back the tape
     being recorded onto. That is the same problem the real machine has with
     a mic and two speakers in one sealed box, which is why the spec calls
     for the monitor to mute when a deck is armed. */
  const enableMic = useCallback(async () => {
    try {
      const ctx = await ensureAudio();
      if (ctx.state === "suspended") await ctx.resume();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      const src = ctx.createMediaStreamSource(stream);
      src.connect(nodeRef.current || spRef.current);
      micRef.current = { stream, src };
      setMicOn(true);
      setStatus("Input live. Use headphones — the monitor path will feed back otherwise.");
    } catch (err) {
      setStatus("Microphone unavailable: " + (err && err.message));
    }
  }, [ensureAudio]);

  const blankTape = useCallback(async (secs) => {
    const ctx = await ensureAudio();
    const n = Math.floor(ctx.sampleRate * secs);
    for (const d of targets()) {
      send({ type: "blank", deck: d, n });
      if (engRef.current) {
        const nx = peaksRef.current.slice();
        nx[d] = engRef.current.peaks(d, 900);
        peaksRef.current = nx;
      }
    }
    setNames((v) => { const c = v.slice(); targets().forEach((d) => (c[d] = "BLANK " + secs + "s")); return c; });
    setSecs((v) => { const c = v.slice(); targets().forEach((d) => (c[d] = secs)); return c; });
    setReady(true);
    setStatus("Blank tape loaded. Arm a deck, press PLAY, and play into it.");
  }, [ensureAudio, send]);

  const buildPeaks = (deck, data) => {
    const bins = 900;
    const step = Math.max(1, Math.floor(data.length / bins));
    const pk = new Float32Array(bins * 2);
    for (let i = 0; i < bins; i++) {
      let lo = 0, hi = 0;
      const s = i * step, e = Math.min(data.length, s + step);
      for (let j = s; j < e; j++) { const v = data[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
      pk[i * 2] = lo / 32768; pk[i * 2 + 1] = hi / 32768;
    }
    let mx = 0.0001;
    for (let i = 0; i < pk.length; i++) mx = Math.max(mx, Math.abs(pk[i]));
    for (let i = 0; i < pk.length; i++) pk[i] /= mx;
    const next = peaksRef.current.slice();
    next[deck] = pk;
    peaksRef.current = next;
  };

  const mountTape = useCallback(async (data, label, seconds, decks) => {
    await ensureAudio();
    for (const d of decks) {
      const copy = decks.length > 1 ? new Int16Array(data) : data;
      buildPeaks(d, copy);
      send({ type: "tape", deck: d, data: copy, transfer: nodeRef.current ? [copy.buffer] : undefined });
    }
    setNames((n) => { const c = n.slice(); decks.forEach((d) => (c[d] = label)); return c; });
    setSecs((n) => { const c = n.slice(); decks.forEach((d) => (c[d] = seconds)); return c; });
    setMarks((v) => { const c = v.slice(); decks.forEach((d) => (c[d] = [])); return c; });
    decks.forEach((d) => { reelRef.current[d] = null; });
    setReelInfo(null);
    setReady(true);
    setStatus("Tape loaded. Press PLAY on a deck.");
  }, [ensureAudio, send]);

  const targets = () => (loadTarget === 2 ? [0, 1] : [loadTarget]);

  /* Window size and refill margin. 60s resident with a 12s margin means
     that even at 8x you have a second and a half of runway before the
     playhead reaches an edge — an eternity next to an async blob read. The
     hardware uses ~87s for the same reason. */
  /* Window size. Five minutes per deck is 28.8MB at 48k int16; two decks is
     57.6MB against the Daisy's 65MB of SDRAM, so this is close to the real
     ceiling rather than a browser-only luxury. Ten minutes per deck would
     need 115MB and does not fit the hardware.

     Bigger is better here because of REEL.md Rule 2: the window is pinned
     whenever the splice fits inside it, so a five-minute window means almost
     any musical loop becomes permanently resident and never touches storage
     again. */
  const WIN_SEC = 300;
  /* Guard samples carried at each end of a streamed window so the 16-tap
     interpolator never reads past the buffer. 1024 samples (~21ms) is far
     more than the 8 it strictly needs, and costs 0.007% of the window. */
  const GUARD = 1024;
  const MIN_MARGIN_SEC = 2;

  /* Rate history per deck, for REEL.md Rule 4. The margin has to be sized
     from the FASTEST recent rate, not the instantaneous one — transport
     inertia means the current value lags a fast move, and a margin that
     arrives late is the failure that makes streaming instruments feel
     fragile. Decays back down so the margin does not stay huge forever. */
  const rateMax = useRef([1, 1]);

  /* Read a window out of the reel. This is the harness's equivalent of an
     SD read, and it is deliberately async and on the main thread — the
     audio path must never touch storage. */
  const fetchWindow = useCallback(async (d, startSample) => {
    const reel = reelRef.current[d];
    if (!reel || winBusy.current[d]) return;
    const ctx = ctxRef.current;
    if (!ctx) return;
    const winLen = Math.min(Math.floor(WIN_SEC * ctx.sampleRate), reel.len);
    const start = Math.max(0, Math.min(reel.len - winLen, Math.round(startSample)));

    /* Read the usable window PLUS guard samples either side. bufStart is the
       reel position of data[0]; gLo/gHi tell the engine how much of each end
       exists only for the interpolator to reach into. At the very ends of
       the reel there is nothing to guard with, so the guard shrinks to zero
       and the engine's clamp takes over. */
    const bufStart = Math.max(0, start - GUARD);
    const bufEnd = Math.min(reel.len, start + winLen + GUARD);
    const gLo = start - bufStart;
    const gHi = bufEnd - (start + winLen);

    winBusy.current[d] = true;
    try {
      const bytes = await reel.blob.slice(bufStart * 2, bufEnd * 2).arrayBuffer();
      const data = new Int16Array(bytes);
      send({ type: "window", deck: d, data, start: bufStart, reelLen: reel.len,
             gLo, gHi,
             transfer: nodeRef.current ? [data.buffer] : undefined });
    } catch (err) {
      setStatus("Reel read failed: " + (err && err.message));
    } finally {
      winBusy.current[d] = false;
    }
  }, [send]);

  const cutTest = useCallback(async () => {
    try {
      const ctx = await ensureAudio();
      const decks = targets();
      if (decks.length > 1) {
        // two related but not identical loops, so SPLIT has something to say
        for (const d of decks) {
          const data = makeTestLoop(ctx.sampleRate, d === 1);
          buildPeaks(d, data);
          send({ type: "tape", deck: d, data, transfer: nodeRef.current ? [data.buffer] : undefined });
        }
        setNames(["TEST_A.WAV", "TEST_B.WAV"]);
        setSecs([6, 6]);
        setReady(true);
        setStatus("Two test loops cut. Press PLAY on a deck.");
      } else {
        const data = makeTestLoop(ctx.sampleRate, decks[0] === 1);
        await mountTape(data, "TEST_" + (decks[0] ? "B" : "A") + ".WAV", 6, decks);
      }
    } catch (err) {
      setStatus("Audio engine failed to start: " + (err && err.message));
    }
  }, [ensureAudio, mountTape, send, loadTarget]);

  /* ---- LOADING ------------------------------------------------------
     Multiple files are concatenated into ONE tape, in name order. This is
     the "playlist as a spliced reel" model from PROJECT.md: the engine only
     ever knows a position, and a boundary between tracks is just a splice.

     The payoff is that everything works across track boundaries for free —
     reverse backs into the previous track, varispeed applies to the whole
     reel, and the loop wraps from the last track to the first. There is no
     track-boundary logic anywhere in the engine, because there are no
     tracks as far as the engine is concerned.

     A single stereo file loaded into BOTH decks is the exception: it splits
     to L on deck A and R on deck B, which is what STEREO mode expects and
     what the hardware's mic array will do. */
  /* ---- LOADING ------------------------------------------------------
     Multiple files are concatenated into ONE reel, in name order. This is
     the "playlist as a spliced reel" model from PROJECT.md: the engine only
     ever knows a position, and a boundary between tracks is just a splice.

     The payoff is that everything works across track boundaries for free —
     reverse backs into the previous track, varispeed applies to the whole
     reel, and the loop wraps from the last track to the first. There is no
     track-boundary logic anywhere in the engine, because there are no
     tracks as far as the engine is concerned.

     TWO PATHS, chosen by total length, mirroring the hardware exactly:

       <= ~5.6 min   RESIDENT. The whole reel sits in the tape buffer.
                     Splice points and phasing work on it.
       >  ~5.6 min   STREAMED. The reel becomes a Blob (which the browser
                     backs with disk), and only a 60s window is resident.
                     Length becomes irrelevant — ten tracks or a hundred.

     A single stereo file loaded into BOTH decks is the exception: it splits
     to L on deck A and R on deck B, which is what STEREO mode expects and
     what the hardware's mic array will do. */
  const onFile = useCallback(async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    files.sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));

    let ctx;
    try {
      ctx = await ensureAudio();
      if (ctx.state === "suspended") await ctx.resume();
    } catch (err) {
      setStatus("Audio engine failed to start: " + (err && err.message));
      return;
    }

    const sr = ctx.sampleRate;
    const decks = targets();
    const RESIDENT_MAX = Math.floor(336 * sr);   // ~5.6 min, the hardware budget

    /* Decode one file at a time and hand each result straight to storage as
       a Blob. Blob-of-Blobs concatenates in browser-managed storage without
       ever materialising in the JS heap, so peak heap usage is ONE decoded
       file regardless of how many there are. Accumulating Int16Arrays and
       building the Blob at the end would mean holding the whole reel — a
       hundred tracks is over a gigabyte, and it would simply fail. */
    const chunks = [[], []];
    const blobs = [[], []];
    let mustStream = false;
    const bounds = [];
    let total = 0;
    let splitStereo = false;

    for (let i = 0; i < files.length; i++) {
      setStatus("Decoding " + (i + 1) + "/" + files.length + " — " + files[i].name
        + (total ? "  (" + (total / sr / 60).toFixed(1) + " min so far)" : ""));
      let buf;
      try {
        const ab = await files[i].arrayBuffer();
        buf = await decodeAudio(ctx, ab.slice(0));
      } catch (err) {
        setStatus("Decode failed on " + files[i].name + " — "
          + (err && err.message ? err.message : "unsupported format") + ". Try a WAV.");
        return;
      }

      const ch = buf.numberOfChannels;
      const n = buf.length;

      // Once past the resident budget, stop keeping arrays and go to storage
      if (!mustStream && total + n > RESIDENT_MAX) {
        mustStream = true;
        for (const d of [0, 1]) {
          for (const c of chunks[d]) blobs[d].push(new Blob([c.buffer]));
          chunks[d].length = 0;
        }
      }

      const stash = (d, seg) => {
        if (mustStream) blobs[d].push(new Blob([seg.buffer]));
        else chunks[d].push(seg);
      };

      if (files.length === 1 && decks.length > 1 && ch > 1) {
        splitStereo = true;
        for (let d = 0; d < 2; d++) {
          stash(d, toTape(buf.getChannelData(Math.min(d, ch - 1)), n));
        }
      } else {
        const acc = new Float32Array(n);
        for (let c = 0; c < ch; c++) {
          const src = buf.getChannelData(c);
          for (let k = 0; k < n; k++) acc[k] += src[k];
        }
        if (ch > 1) for (let k = 0; k < n; k++) acc[k] /= ch;
        const seg = toTape(acc, n);
        for (const d of (splitStereo ? [0, 1] : decks)) stash(d, seg);
      }
      buf = null;

      bounds.push(total);
      total += n;
      // yield so the status line actually paints between files
      await new Promise((r) => setTimeout(r, 0));
    }

    if (!total) { setStatus("Nothing decoded."); return; }

    const targetDecks = splitStereo ? [0, 1] : decks;
    const markList = bounds.map((x) => x / total);
    const mins = total / sr / 60;
    const streaming = mustStream;

    try {
      /* When both decks get the same reel they SHARE one blob — no reason
         to hold two copies of six hours of audio. */
      let shared = null;
      for (const d of targetDecks) {
        if (streaming) {
          let reel;
          if (!splitStereo && shared) {
            reel = shared;
          } else {
            const blob = new Blob(blobs[d], { type: "application/octet-stream" });
            blobs[d].length = 0;
            reel = { blob, len: total };
            if (!splitStereo) shared = reel;
          }
          reelRef.current[d] = reel;
          const blob = reel.blob;

          const winLen = Math.min(Math.floor(WIN_SEC * sr), total);
          const bytes = await blob.slice(0, winLen * 2).arrayBuffer();
          const data = new Int16Array(bytes);
          send({ type: "window", deck: d, data, start: 0, reelLen: total,
                 transfer: nodeRef.current ? [data.buffer] : undefined });

          /* Peaks over the first ten minutes only — drawing a six-hour reel
             would mean reading the whole blob. The REEL view from the spec is
             the right answer here and is not built yet. */
          const peakSrc = new Int16Array(
            await blob.slice(0, Math.min(total, Math.floor(600 * sr)) * 2).arrayBuffer());
          buildPeaks(d, peakSrc);
        } else {
          reelRef.current[d] = null;
          const flat = new Int16Array(total);
          let off = 0;
          for (const c of chunks[d]) { flat.set(c, off); off += c.length; }
          chunks[d].length = 0;
          buildPeaks(d, flat);
          send({ type: "tape", deck: d, data: flat,
                 transfer: nodeRef.current ? [flat.buffer] : undefined });
        }
      }

      const label = files.length === 1
        ? files[0].name
        : files.length + " tracks / " + mins.toFixed(1) + " min";

      setNames((v) => {
        const c = v.slice();
        targetDecks.forEach((d, i) => (c[d] = splitStereo
          ? files[0].name + (i ? " [R]" : " [L]") : label));
        return c;
      });
      setSecs((v) => { const c = v.slice(); targetDecks.forEach((d) => (c[d] = total / sr)); return c; });
      setMarks((v) => { const c = v.slice(); targetDecks.forEach((d) => (c[d] = markList)); return c; });
      setReelInfo({ tracks: files.length, minutes: mins, streaming });
      setReady(true);

      setStatus(streaming
        ? files.length + " tracks, " + (mins > 90 ? (mins / 60).toFixed(1) + " hours" : mins.toFixed(0) + " min")
          + " — reel loaded. Narrow the splice below " + WIN_SEC + "s anywhere on it and it plays like a short tape."
        : (files.length > 1
            ? files.length + " tracks spliced into one reel — " + mins.toFixed(1) + " min, resident."
            : "Tape loaded. Press PLAY on a deck."));
    } catch (err) {
      setStatus("Loaded but could not mount: " + (err && err.message));
    }
  }, [ensureAudio, send, loadTarget]);


  const start = useCallback(async () => {
    const ctx = await ensureAudio();
    if (ctx.state === "suspended") await ctx.resume();
    if (!running) { setRunning(true); send({ type: "config", running: true }); }
  }, [ensureAudio, running, send]);

  const deckPlay = useCallback(async (d, val) => {
    if (!ready) return;
    await start();
    setPlay((p) => { const c = p.slice(); c[d] = val === undefined ? !c[d] : val; return c; });
  }, [ready, start]);

  const bothLaunch = useCallback(async () => {
    if (!ready) return;
    await start();
    const on = !(play[0] && play[1]);
    // one call, so the two decks begin in true unison — two thumbs would
    // cost you minutes of phase at a few hundred ppm
    send({ type: "transport", deck: 0, resync: true });
    setPlay([on, on]);
  }, [ready, start, play, send]);

  /* Scrub is momentary: press overrides the rate, release restores what the
     knob held. Two guards, both learned the hard way: restore ONLY if a
     scrub is actually active (a stray release must never write the
     uninitialised sentinel), and never re-capture while active (a second
     pointerdown would capture the scrub's own 4x as the value to restore). */
  const scrub = useRef([{ on: false, saved: 1 }, { on: false, saved: 1 }]);
  const doScrub = (d, dir) => {
    const sc = scrub.current[d];
    if (dir === 0) {
      if (!sc.on) return;
      sc.on = false;
      setRate((r) => { const c = r.slice(); c[d] = sc.saved; return c; });
    } else {
      if (!sc.on) { sc.on = true; sc.saved = rate[d]; }
      setRate((r) => { const c = r.slice(); c[d] = 4 * dir; return c; });
    }
  };

  useEffect(() => {
    send({ type: "params", p: { rate, level, filter, offset, loopStart, loopLen,
      gSize, gDens, gSpray, gRamp, gLive: [gLive[0] ? 1 : 0, gLive[1] ? 1 : 0],
      lfoRate, lfoDepth, lfoShape, lfoDest, lfoSync: [lfoSync[0] ? 1 : 0, lfoSync[1] ? 1 : 0],
      gmSrc, gmRate, gmDepth, gmDest,
      age, delay, delayTime, delayFb: 0.42, reverb, output,
      erase, invert: [invert[0] ? 1 : 0, invert[1] ? 1 : 0], recGain,
      loop: [loop[0] ? 1 : 0, loop[1] ? 1 : 0],
      freeze: [freeze[0] ? 1 : 0, freeze[1] ? 1 : 0] } });
  }, [rate, level, filter, offset, loopStart, loopLen, gSize, gDens, gSpray, gRamp, gLive,
      lfoRate, lfoDepth, lfoShape, lfoDest, lfoSync, gmSrc, gmRate, gmDepth, gmDest,
      age, delay, delayTime, reverb, output, erase, invert, recGain, loop, freeze, send]);

  useEffect(() => { send({ type: "config", interp, headLoss, heads }); }, [interp, headLoss, heads, send]);
  useEffect(() => {
    send({ type: "transport", deck: 0, play: play[0] });
    send({ type: "transport", deck: 1, play: play[1] });
  }, [play, send]);
  useEffect(() => {
    send({ type: "transport", deck: 0, rec: rec[0] });
    send({ type: "transport", deck: 1, rec: rec[1] });
    if (!rec[0] && !rec[1]) { send({ type: "peaks", deck: 0 }); send({ type: "peaks", deck: 1 }); }
  }, [rec, send]);
  useEffect(() => () => { if (ctxRef.current) ctxRef.current.close(); }, []);

  /* ---- WINDOW POLICY (REEL.md) ---------------------------------------
     Four rules, in order. Runs from BOTH the draw loop and a 500ms
     interval: browsers throttle requestAnimationFrame to about once a
     minute in background tabs, and a streamed reel must keep refilling
     while you're in another tab listening. The interval is the one that
     matters; the rAF call just makes refills snappier when visible. */
  const runWindowPolicy = useCallback(() => {
    const t = telRef.current;
    if (ctxRef.current && t && t.gpos && t.wlen && t.spliceL) {

        const srate = ctxRef.current.sampleRate;
        for (let d = 0; d < 2; d++) {
          const reel = reelRef.current[d];
          const wlen = t.wlen[d];
          if (!reel || !wlen) continue;

          // Rule 1: the whole reel is resident. Nothing to do, ever.
          if (reel.len <= wlen) continue;

          const gLo = t.guard ? t.guard[d * 2] : 0;
          const gHi = t.guard ? t.guard[d * 2 + 1] : 0;
          const g = t.gpos[d];
          const ws = t.win[d] + gLo;              // usable region, guard excluded
          const we = t.win[d] + wlen - gHi;
          const usable = we - ws;
          const ss = t.spliceS[d], sl = t.spliceL[d];

          if (sl <= usable) {
            /* Rule 2: THE SPLICE FITS. Pin the window over it, centred, and
               never move again while the splice is unchanged. This is the
               case worth optimising for — once a loop is set, a six-hour
               reel does zero I/O and behaves exactly like a short tape. */
            if (ss < ws || ss + sl > we) {
              fetchWindow(d, ss - (usable - sl) / 2);
            }
            continue;
          }

          /* Playhead outside the window entirely — a reel wrap, or a splice
             dragged a long way. Fetch immediately. This is the spool case
             from REEL.md, and the brief seam at a reel wrap is honest: a
             six-hour tape loop would have a physical splice there too. */
          if (g < ws || g >= we) {
            const f0 = rate[d] >= 0;
            fetchWindow(d, g - (f0 ? usable * 0.25 : usable * 0.75));
            continue;
          }

          /* Rule 4: margin scales with the fastest recent rate. */
          const r = Math.abs(rate[d]) || 0.001;
          rateMax.current[d] = Math.max(r, rateMax.current[d] * 0.97);
          const margin = Math.max(MIN_MARGIN_SEC, rateMax.current[d] * MIN_MARGIN_SEC) * srate;

          /* Rule 3: the window follows the playhead, biased in the
             direction of travel — prefetch where you are actually going. */
          const fwd = rate[d] >= 0;
          const lead = fwd ? (we - g) : (g - ws);
          if (lead < margin) {
            const behind = fwd ? usable * 0.25 : usable * 0.75;
            fetchWindow(d, g - behind);
          }
        }
      }
  }, [fetchWindow, rate]);

  useEffect(() => {
    const iv = setInterval(runWindowPolicy, 500);
    return () => clearInterval(iv);
  }, [runWindowPolicy]);

  /* ---- THE SCREEN --------------------------------------------------
     This is the firmware's display. It is drawn ONLY from engine telemetry,
     never from UI state that the engine doesn't have — that discipline is
     what lets it port to a real framebuffer later.

     Three views for now: STATUS (home), WAVEFORM (where phasing becomes
     visible), LEVELS (forced automatically when a deck is armed on the real
     machine). REEL and SPECTROGRAM are specified but not built; they want
     the real graphics library compiled in rather than canvas drawing.

     Throttled to ~24fps because on the fallback host this competes directly
     with the audio thread. */
  useEffect(() => {
    let last = 0, lastDraw = 0;
    const draw = (ts) => {
      rafRef.current = requestAnimationFrame(draw);
      // The fallback engine runs on this same thread — 24fps leaves it room.
      if (ts - lastDraw < 41) return;
      lastDraw = ts;
      const cv = canvasRef.current;
      if (!cv) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
      const g = cv.getContext("2d");
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = C.glass;
      g.fillRect(0, 0, w, h);

      const t = telRef.current;
      const accents = [C.a, C.b];
      const mono = "10px ui-monospace, monospace";

      if (view === 0) {
        // STATUS — the home view
        for (let d = 0; d < 2; d++) {
          const y = 22 + d * 34;
          g.font = "12px ui-monospace, monospace";
          g.textAlign = "left";
          g.fillStyle = accents[d];
          g.fillText(d ? "B" : "A", 12, y);
          g.fillStyle = play[d] ? C.bone : C.dim;
          g.fillText(names[d].slice(0, 22), 32, y);
          if ((marks[d] || []).length > 1) {
            const mk = marks[d];
            const pos0 = (d ? t.b : t.a) || 0;
            let tr = 0;
            for (let m = 0; m < mk.length; m++) if (pos0 >= mk[m]) tr = m;
            g.font = "9px ui-monospace, monospace";
            g.fillStyle = C.dim;
            g.fillText("trk " + (tr + 1) + "/" + mk.length, 32, y + 22);
            g.font = "12px ui-monospace, monospace";
          }
          if (freeze[d]) {
            g.font = "9px ui-monospace, monospace"; g.textAlign = "left";
            g.fillStyle = accents[d];
            g.fillText("FROZEN", w - 152, y);
            g.font = "12px ui-monospace, monospace"; g.textAlign = "right";
          }
          if (rec[d]) {
            g.fillStyle = "#FF4A3D";
            g.beginPath(); g.arc(w - 96, y - 4, 4, 0, 6.2832); g.fill();
            g.font = "9px ui-monospace, monospace"; g.textAlign = "left";
            g.fillText("REC", w - 90, y);
            g.font = "12px ui-monospace, monospace"; g.textAlign = "right";
          }
          g.textAlign = "right";
          g.fillStyle = accents[d];
          g.fillText(rate[d].toFixed(3) + "x", w - 12, y);
          if (gDens[d] >= 1) {
            const gc = Math.round(gDens[d]);
            g.fillStyle = accents[d];
            for (let k = 0; k < gc; k++) g.fillRect(w - 64 - k * 4, y - 16, 2, 6);
          }

          const bw = w - 24;
          g.fillStyle = "#20262A";
          g.fillRect(12, y + 7, bw, 5);
          const pos = (d ? t.b : t.a) || 0;
          const px = Math.max(0, Math.min(1, pos)) * bw;
          if (d === 0) { g.fillStyle = accents[0]; g.fillRect(12, y + 7, px, 5); }
          else { g.strokeStyle = accents[1]; g.lineWidth = 1.4; g.strokeRect(12.5, y + 7.5, Math.max(1, px), 4); }
        }
        g.strokeStyle = "#20262A"; g.lineWidth = 1;
        g.beginPath(); g.moveTo(12, 92); g.lineTo(w - 12, 92); g.stroke();
        if (reelInfo) {
          g.font = "9px ui-monospace, monospace";
          g.textAlign = "left"; g.fillStyle = C.brass;
          const rl = reelInfo.minutes > 90
            ? (reelInfo.minutes / 60).toFixed(1) + " h" : reelInfo.minutes.toFixed(1) + " min";
          // "pinned" means the splice is fully resident — zero I/O from here
          const pinned = t.fits && t.fits[0];
          g.fillText("REEL " + rl + (reelInfo.streaming
            ? (pinned ? " · splice pinned" : " · streaming") : " · resident"), 12, 88);
          if (t.reelPos) {
            g.textAlign = "right"; g.fillStyle = C.dim;
            g.fillText((t.reelPos[0] * 100).toFixed(2) + "% of reel", w - 12, 88);
          }
        }
        g.font = mono; g.textAlign = "left"; g.fillStyle = C.dim;
        g.fillText("DRIFT", 12, 112);
        g.font = "22px ui-monospace, monospace";
        g.textAlign = "right"; g.fillStyle = C.a;
        const ds = t.driftSec || 0;
        g.fillText((ds >= 0 ? "+" : "\u2212") + Math.abs(ds).toFixed(3) + " s", w - 12, 116);
        g.font = mono; g.fillStyle = C.dim;
        g.fillText(Math.round(t.driftSamp || 0) + " samples \u00b7 " + HEADS[heads], w - 12, 132);
      } else if (view === 1) {
        // WAVEFORM — where phasing becomes visible
        const half = h / 2;
        for (let d = 0; d < 2; d++) {
          const pk = peaksRef.current[d];
          const top = d * half, mid = top + half / 2;
          if (!pk) continue;
          const bins = pk.length / 2;
          g.fillStyle = "#000"; g.globalAlpha = 0.4;
          g.fillRect(0, top, loopStart[d] * w, half);
          g.fillRect((loopStart[d] + loopLen[d]) * w, top, w, half);
          g.globalAlpha = 1;
          // Track boundaries — where one file was spliced to the next
          const mk = marks[d] || [];
          for (let m = 1; m < mk.length; m++) {
            const mx = mk[m] * w;
            g.strokeStyle = "#8E9698"; g.lineWidth = 1;
            g.setLineDash([2, 3]);
            g.beginPath(); g.moveTo(mx, top + 2); g.lineTo(mx, top + half - 2); g.stroke();
            g.setLineDash([]);
          }
          g.strokeStyle = "#5B6367"; g.lineWidth = 1;
          g.beginPath();
          for (let i = 0; i < bins; i++) {
            const x = (i / bins) * w;
            g.moveTo(x, mid - pk[i * 2 + 1] * (half / 2 - 5));
            g.lineTo(x, mid - pk[i * 2] * (half / 2 - 5));
          }
          g.stroke();
          const pos = (d ? t.b : t.a) || 0;
          const x = (loopStart[d] + pos * loopLen[d]) * w;
          g.save();
          g.shadowColor = accents[d]; g.shadowBlur = 10;
          g.strokeStyle = accents[d]; g.lineWidth = 2;
          g.beginPath(); g.moveTo(x, top); g.lineTo(x, top + half); g.stroke();
          g.shadowBlur = 0;
          g.fillStyle = accents[d]; g.fillRect(x - 8, top + 1, 16, 12);
          g.fillStyle = "#141719"; g.font = "9px ui-monospace, monospace";
          g.textAlign = "center"; g.fillText(d ? "B" : "A", x, top + 10);
          g.restore();
        }
        g.strokeStyle = "#2A3033"; g.lineWidth = 1;
        g.beginPath(); g.moveTo(0, half); g.lineTo(w, half); g.stroke();
      } else {
        // LEVELS — forced automatically when a deck is armed on the real machine
        const labels = ["OUT L", "OUT R"];
        for (let i = 0; i < 2; i++) {
          const y = 34 + i * 46;
          g.font = mono; g.textAlign = "left"; g.fillStyle = C.dim;
          g.fillText(labels[i], 12, y - 6);
          const bw = w - 24;
          g.fillStyle = "#20262A"; g.fillRect(12, y, bw, 18);
          const v = Math.min(1, (t.pk && t.pk[i]) || 0);
          const db = v > 0 ? 20 * Math.log10(v) : -60;
          const nx = Math.max(0, (db + 60) / 60);
          g.fillStyle = v > 0.98 ? "#FF4A3D" : accents[i];
          g.fillRect(12, y, nx * bw, 18);
          g.textAlign = "right"; g.fillStyle = C.bone; g.font = mono;
          g.fillText(db <= -59.5 ? "-inf" : db.toFixed(1) + " dB", w - 12, y + 13);
        }
        g.font = mono; g.textAlign = "left"; g.fillStyle = C.dim;
        g.fillText("AGE " + Math.round(age * 100) + "%   " + INTERPS[interp].toUpperCase() +
          "   " + (headLoss ? "HEAD LOSS ON" : "HEAD LOSS OFF"), 12, h - 12);
      }

      runWindowPolicy();

      if (ts - last > 250) {
        last = ts;
        setTel({ sec: t.driftSec || 0, samp: t.driftSamp || 0, pk: t.pk || [0, 0],
          inPeak: t.inPeak || 0 });
        /* A one-shot deck stops itself at the reel end — un-light PLAY from
           the engine's stop EVENTS, never by diffing its play state. State
           echoes are stale by one round trip, and diffing them here is what
           made fresh presses flip back off (REVIEW.md F7 made real: the
           press raced its own echo, and won only 1 press in 3). */
        if (stopEvtRef.current[0] || stopEvtRef.current[1]) {
          const ev = [stopEvtRef.current[0], stopEvtRef.current[1]];
          stopEvtRef.current[0] = 0; stopEvtRef.current[1] = 0;
          setPlay((pv) => {
            const c = pv.slice();
            if (ev[0]) c[0] = false;
            if (ev[1]) c[1] = false;
            return c;
          });
        }
      }
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [view, play, names, rate, loopStart, loopLen, heads, age, interp, headLoss,
      gDens, rec, marks, fetchWindow, reelInfo, rate, freeze]);

  const set2 = (setter) => (d, v) => setter((s) => { const c = s.slice(); c[d] = v; return c; });
  const setRateD = set2(setRate), setLevelD = set2(setLevel);
  const setFilterD = set2(setFilter), setOffsetD = set2(setOffset);
  const setLsD = set2(setLoopStart), setLlD = set2(setLoopLen);
  const setEraseD = set2(setErase);
  const setLRateD = set2(setLfoRate), setLDepthD = set2(setLfoDepth);
  const setSizeD = set2(setGSize), setDensD = set2(setGDens);
  const setSprayD = set2(setGSpray), setRampD = set2(setGRamp);

  const ppm = (v) => Math.round(v * 1e6) + " ppm";
  const beat = () => {
    const d = Math.abs(offset[1] - offset[0]);
    if (heads !== 0 || d < 1e-7 || !secs[0]) return "—";
    const t = secs[0] / d;
    if (t > 3600) return (t / 3600).toFixed(1) + " h";
    if (t > 90) return (t / 60).toFixed(1) + " min";
    return t.toFixed(1) + " s";
  };

  /* One deck strip. Called as a plain function, NOT used as <Deck d={0} />.

     Declaring a component inside another component's body gives React a new
     component TYPE on every render, which unmounts and rebuilds the whole
     subtree — while, on the fallback host, the audio engine runs on the same
     thread. That was an audible bug. Either declare components at module
     scope or call them as functions like this. */
  const renderDeck = (d) => {
    const acc = d ? C.b : C.a;
    const locked = heads === 1 && d === 1;
    return (
      <Panel title={"Deck " + (d ? "B" : "A")} accent={acc}>
        <div className="flex justify-center">
          <Knob label="Speed" sub={locked ? "locked to A" : "-2 … 2"} value={rate[d]}
            min={-2} max={2} step={0.001} accent={acc} size={84}
            onChange={(v) => setRateD(d, v)} format={(v) => v.toFixed(3) + "x"} />
        </div>
        <div className="mt-1 flex justify-center gap-1">
          {[-1, -0.5, 0.25, 0.5, 1].map((v) => (
            <button key={v} onClick={() => setRateD(d, v)}
              className="rounded-sm px-2 py-0.5 text-[9px] tabular-nums"
              style={{ background: C.well, color: C.dim, border: "1px solid #141719" }}>{v}</button>
          ))}
        </div>
        <div className="mt-2 flex justify-between">
          <Knob label="Level" value={level[d]} min={0} max={1.4} step={0.01} accent={acc}
            onChange={(v) => setLevelD(d, v)} size={52} />
          <Knob label="Filter" sub="LP · HP" value={filter[d]} min={-1} max={1} step={0.01} accent={acc}
            onChange={(v) => setFilterD(d, v)} size={52}
            format={(v) => (Math.abs(v) < 0.02 ? "open" : (v < 0 ? "LP " : "HP ") + Math.abs(v).toFixed(2))} />
          <Knob label="Offset" sub={heads === 1 ? "time shift" : "ppm"} value={offset[d]}
            min={-0.005} max={0.005} step={0.000002} accent={acc}
            onChange={(v) => setOffsetD(d, v)} size={52} format={ppm} />
        </div>

        <div className="mt-3 rounded-sm p-2" style={{ background: "#2A3033", border: "1px solid #454C50" }}>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[9px] uppercase tracking-[0.22em]" style={{ color: gDens[d] >= 1 ? acc : C.dim }}>
              Grain
            </span>
            <span className="text-[8px] uppercase tracking-wider" style={{ color: C.dim }}>
              {gDens[d] < 1 ? (gLive[d] ? "thru" : "single head") : Math.round(gDens[d]) + " heads"}
            </span>
          </div>
          <div className="mb-1.5 flex gap-1">
            {["Tape", "Live"].map((o, i) => (
              <button key={o}
                onClick={() => setGLive((v) => { const c = v.slice(); c[d] = i === 1; return c; })}
                className="flex-1 rounded-sm py-1 text-[8px] uppercase tracking-[0.14em]"
                style={{
                  background: C.well,
                  color: (gLive[d] ? 1 : 0) === i ? acc : C.dim,
                  border: "1px solid #141719",
                  boxShadow: (gLive[d] ? 1 : 0) === i ? `inset 0 0 0 1.2px ${acc}` : "none"
                }}>{o}</button>
            ))}
          </div>
          <div className="flex justify-between">
            <Knob label="Size" value={gSize[d]} min={0} max={1} step={0.01} accent={acc} size={44}
              onChange={(v) => setSizeD(d, v)}
              format={(v) => Math.round(5 * Math.pow(100, v)) + "ms"} />
            <Knob label="Dens" value={gDens[d]} min={0} max={12} step={1} accent={acc} size={44}
              onChange={(v) => setDensD(d, v)} format={(v) => (v < 1 ? "off" : String(Math.round(v)))} />
            <Knob label={gLive[d] ? "Delay" : "Spray"} value={gSpray[d]} min={0} max={1} step={0.01}
              accent={acc} size={44}
              onChange={(v) => setSprayD(d, v)}
              format={(v) => (gLive[d] ? (v * 4).toFixed(2) + "s" : Math.round(v * 100) + "%")} />
            <Knob label="Ramp" value={gRamp[d]} min={0} max={1} step={0.01} accent={acc} size={44}
              onChange={(v) => setRampD(d, v)}
              format={(v) => (v < 0.2 ? "hard" : v > 0.8 ? "soft" : Math.round(v * 100) + "%")} />
          </div>
        </div>
        <div className="mt-3 flex gap-1.5">
          <Btn label="Rec" accent={acc} lit={rec[d]}
            onClick={async () => {
              if (!ready) { setStatus("Load a tape or cut a blank one first."); return; }
              await start();
              setRec((r) => { const c = r.slice(); c[d] = !c[d]; return c; });
              setPlay((pv) => { const c = pv.slice(); if (!rec[d]) c[d] = true; return c; });
            }} />
          <Btn label={play[d] ? "Stop" : "Play"} accent={acc} lit={play[d]} wide onClick={() => deckPlay(d)} />
          <Btn label="Frz" accent={acc} lit={freeze[d]}
            onClick={async () => {
              if (!ready) { setStatus("Load a tape first — freeze holds the moment under the head."); return; }
              await start();
              setFreeze((f) => { const c = f.slice(); c[d] = !c[d]; return c; });
              setPlay((pv) => { const c = pv.slice(); if (!freeze[d]) c[d] = true; return c; });
            }} />
        </div>
        <div className="mt-1.5 flex gap-1.5">
          <Btn label="◀◀" accent={acc} onDown={() => doScrub(d, -1)} onUp={() => doScrub(d, 0)} />
          <div className="flex-1 self-center text-center text-[8px] uppercase tracking-widest" style={{ color: C.dim }}>Scrub</div>
          <Btn label="▶▶" accent={acc} onDown={() => doScrub(d, 1)} onUp={() => doScrub(d, 0)} />
        </div>
        <div className="mt-2 rounded-sm p-2" style={{ background: "#2A3033", border: "1px solid #454C50" }}>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[9px] uppercase tracking-[0.22em]" style={{ color: lfoDepth[d] > 0.005 ? acc : C.dim }}>
              LFO
            </span>
            <button onClick={() => setLfoSync((v) => { const c = v.slice(); c[d] = !c[d]; return c; })}
              className="rounded-sm px-2 py-0.5 text-[8px] uppercase tracking-wider"
              style={{ background: C.well, color: lfoSync[d] ? acc : C.dim, border: "1px solid #141719" }}>
              {lfoSync[d] ? "loop sync" : "free run"}
            </button>
          </div>
          <div className="mb-1.5 flex justify-between">
            <Knob label="Depth" value={lfoDepth[d]} min={0} max={1} step={0.01} accent={acc} size={44}
              onChange={(v) => setLDepthD(d, v)} format={(v) => Math.round(v * 100) + "%"} />
            <Knob label="Rate" value={lfoRate[d]} min={lfoSync[d] ? 0.25 : 0.02} max={lfoSync[d] ? 16 : 20}
              step={lfoSync[d] ? 0.25 : 0.01} accent={acc} size={44}
              onChange={(v) => setLRateD(d, v)}
              format={(v) => (lfoSync[d] ? v.toFixed(2) + "/loop" : v.toFixed(2) + "Hz")} />
            <div className="flex-1 pl-2">
              <div className="mb-1 flex gap-0.5">
                {["∿", "△", "◺", "⊓"].map((o, i) => (
                  <button key={o} onClick={() => setLfoShape((v) => { const c = v.slice(); c[d] = i; return c; })}
                    className="flex-1 rounded-sm py-0.5 text-[10px]"
                    style={{ background: C.well, color: lfoShape[d] === i ? acc : C.dim, border: "1px solid #141719" }}>
                    {o}
                  </button>
                ))}
              </div>
              <select value={lfoDest[d]}
                onChange={(e) => setLfoDest((v) => { const c = v.slice(); c[d] = parseInt(e.target.value, 10); return c; })}
                className="w-full rounded-sm px-1 py-0.5 text-[9px]"
                style={{ background: C.well, color: C.bone, border: "1px solid #141719" }}>
                {["Speed", "Filter", "Level", "Grain size", "Density", "Spray"].map((o, i) => (
                  <option key={o} value={i}>{o}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="mt-3 space-y-1">
          <label className="block">
            <div className="flex justify-between text-[9px] uppercase tracking-widest" style={{ color: C.dim }}>
              <span>Splice in</span><span style={{ color: C.bone }}>{(loopStart[d] * 100).toFixed(1)}%</span>
            </div>
            <input type="range" min={0} max={0.95} step={0.001} value={loopStart[d]} className="w-full"
              style={{ accentColor: acc }}
              onChange={(e) => { const v = parseFloat(e.target.value); setLsD(d, v); if (v + loopLen[d] > 1) setLlD(d, 1 - v); }} />
          </label>
          <label className="block">
            <div className="flex justify-between text-[9px] uppercase tracking-widest" style={{ color: C.dim }}>
              <span>Splice length</span><span style={{ color: C.bone }}>{(loopLen[d] * 100).toFixed(1)}%</span>
            </div>
            <input type="range" min={0.005} max={1} step={0.001} value={loopLen[d]} className="w-full"
              style={{ accentColor: acc }}
              onChange={(e) => setLlD(d, Math.min(parseFloat(e.target.value), 1 - loopStart[d]))} />
          </label>
          <label className="block">
            <div className="flex justify-between text-[9px] uppercase tracking-widest" style={{ color: C.dim }}>
              <span>Decay</span>
              <span style={{ color: C.bone }}>
                {erase[d] >= 0.9995 ? "hold" : "~" + Math.max(1, Math.round(1 / (1 - erase[d]) / 3)) + " passes"}
              </span>
            </div>
            <input type="range" min={0.9} max={1} step={0.0005} value={erase[d]} className="w-full"
              style={{ accentColor: acc }}
              onChange={(e) => setEraseD(d, parseFloat(e.target.value))} />
          </label>
          <div className="flex gap-3 pt-0.5">
            <label className="flex items-center gap-1.5 text-[9px] uppercase tracking-widest" style={{ color: C.dim }}>
              <input type="checkbox" checked={loop[d]}
                onChange={(e) => setLoop((v) => { const c = v.slice(); c[d] = e.target.checked; return c; })}
                style={{ accentColor: acc }} />
              Loop
            </label>
            <label className="flex items-center gap-1.5 text-[9px] uppercase tracking-widest" style={{ color: C.dim }}>
              <input type="checkbox" checked={invert[d]}
                onChange={(e) => setInvert((v) => { const c = v.slice(); c[d] = e.target.checked; return c; })}
                style={{ accentColor: acc }} />
              Invert
            </label>
          </div>
        </div>
      </Panel>
    );
  };

  return (
    <div className="min-h-screen w-full font-mono" style={{ background: C.chassis, color: C.bone }}>
      <div className="mx-auto max-w-6xl px-3 py-5 sm:px-6 sm:py-8">

        <header className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b pb-3" style={{ borderColor: "#3F464A" }}>
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em]" style={{ color: C.brass }}>Two deck / field</div>
            <h1 className="text-3xl font-bold tracking-[0.3em]" style={{ color: C.bone }}>TL-1</h1>
          </div>
          <div className="text-right text-[10px]" style={{ color: C.dim }}>
            <div>{status}</div>
            <div style={{ color: C.dim }}>build 8</div>
            {engineKind && <div style={{ color: C.brass }}>engine: {engineKind}</div>}
          </div>
        </header>

        {/* top band — screen flanked by monitors, as on the panel */}
        <div className="mb-4 flex gap-3">
          <div className="hidden w-24 shrink-0 rounded sm:block" style={{ background: C.well, border: "1px solid #141719" }}>
            <div className="grid h-full grid-cols-5 content-center gap-1.5 p-2">
              {Array.from({ length: 30 }).map((_, i) => (
                <span key={i} className="block h-1.5 w-1.5 rounded-full" style={{ background: "#141719" }} />
              ))}
            </div>
          </div>
          <div className="flex-1">
            <canvas ref={canvasRef} className="block h-[150px] w-full rounded"
              style={{ border: "2px solid #141719" }} />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Seg options={["Status", "Waveform", "Levels"]} value={view} onChange={setView} accent={C.brass} />
              <div className="ml-auto text-[10px]" style={{ color: C.dim }}>
                cycle ≈ <span style={{ color: C.bone }}>{beat()}</span>
              </div>
            </div>
          </div>
          <div className="hidden w-24 shrink-0 rounded sm:block" style={{ background: C.well, border: "1px solid #141719" }}>
            <div className="grid h-full grid-cols-5 content-center gap-1.5 p-2">
              {Array.from({ length: 30 }).map((_, i) => (
                <span key={i} className="block h-1.5 w-1.5 rounded-full" style={{ background: "#141719" }} />
              ))}
            </div>
          </div>
        </div>

        {/* three columns — position tells you ownership */}
        <div className="grid gap-3 lg:grid-cols-[1fr_300px_1fr]">
          {renderDeck(0)}

          <Panel title="Shared">
            <div className="mb-3">
              <Seg label="Load into" options={["A", "B", "Both"]} value={loadTarget} onChange={setLoadTarget} accent={C.brass} />
            </div>
            <div className="mb-3 flex gap-1.5">
              <button onClick={cutTest}
                className="flex-1 rounded-sm py-2 text-[9px] uppercase tracking-[0.16em]"
                style={{ background: C.well, color: C.bone, border: "1px solid #141719" }}>
                Cut test loop
              </button>
              <label className="flex-1 cursor-pointer rounded-sm py-2 text-center text-[9px] uppercase tracking-[0.16em]"
                style={{ background: C.well, color: C.bone, border: "1px solid #141719" }}>
                Load files
                <input type="file" accept="audio/*" multiple className="hidden" onChange={onFile} />
              </label>
            </div>

            <div className="mb-3 rounded-sm p-2" style={{ background: "#2A3033", border: "1px solid #454C50" }}>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[9px] uppercase tracking-[0.22em]" style={{ color: micOn ? C.a : C.dim }}>Input</span>
                <span className="text-[8px] uppercase tracking-wider" style={{ color: C.dim }}>
                  {micOn ? "live" : "off"}
                </span>
              </div>
              {!micOn ? (
                <button onClick={enableMic}
                  className="w-full rounded-sm py-1.5 text-[9px] uppercase tracking-[0.16em]"
                  style={{ background: C.well, color: C.bone, border: "1px solid #141719" }}>
                  Enable microphone
                </button>
              ) : (
                <>
                  <div className="mb-1.5 h-2 w-full overflow-hidden rounded-sm" style={{ background: "#20262A" }}>
                    <div className="h-full transition-[width] duration-75"
                      style={{ width: Math.min(100, (tel.inPeak || 0) * 130) + "%", background: (tel.inPeak || 0) > 0.95 ? "#FF4A3D" : C.a }} />
                  </div>
                  <label className="block">
                    <div className="flex justify-between text-[9px] uppercase tracking-widest" style={{ color: C.dim }}>
                      <span>Rec gain</span><span style={{ color: C.bone }}>{recGain.toFixed(2)}x</span>
                    </div>
                    <input type="range" min={0} max={4} step={0.01} value={recGain} className="w-full"
                      style={{ accentColor: C.a }} onChange={(e) => setRecGain(parseFloat(e.target.value))} />
                  </label>
                </>
              )}
              <div className="mt-1.5 flex gap-1">
                {[10, 30, 60].map((sc) => (
                  <button key={sc} onClick={() => blankTape(sc)}
                    className="flex-1 rounded-sm py-1 text-[8px] uppercase tracking-wider"
                    style={{ background: C.well, color: C.dim, border: "1px solid #141719" }}>
                    Blank {sc}s
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-3">
              <Seg label="Heads" options={HEADS} value={heads} onChange={setHeads} accent={C.a} />
              <p className="mt-1.5 text-[9px] leading-relaxed" style={{ color: C.dim }}>{HEAD_NOTE[heads]}</p>
            </div>

            <button onClick={bothLaunch} disabled={!ready}
              className="mb-1 w-full rounded-sm py-2.5 text-[10px] uppercase tracking-[0.2em] disabled:opacity-40"
              style={{
                background: C.well, color: play[0] && play[1] ? C.a : C.bone,
                border: "1px solid #141719",
                boxShadow: play[0] && play[1] ? `inset 0 0 0 1.5px ${C.a}, 0 0 12px ${C.a}55` : "none"
              }}>
              Both
            </button>
            <p className="mb-3 text-center text-[8px] uppercase tracking-wider" style={{ color: C.dim }}>
              Launches both decks in unison
            </p>

            <div className="space-y-2 border-t pt-3" style={{ borderColor: "#454C50" }}>
              <div className="text-[9px] uppercase tracking-[0.2em]" style={{ color: C.brass }}>Screen settings</div>
              <Seg label="Reconstruction" options={INTERPS} value={interp} onChange={setInterp} accent={C.brass} />
              <label className="flex items-center gap-2 text-[9px] uppercase tracking-widest" style={{ color: C.dim }}>
                <input type="checkbox" checked={headLoss} onChange={(e) => setHeadLoss(e.target.checked)}
                  style={{ accentColor: C.brass }} />
                Head loss tracks speed
              </label>
              <label className="block">
                <div className="flex justify-between text-[9px] uppercase tracking-widest" style={{ color: C.dim }}>
                  <span>Delay time</span><span style={{ color: C.bone }}>{Math.round(delayTime * 1000)} ms</span>
                </div>
                <input type="range" min={0.02} max={1.5} step={0.005} value={delayTime} className="w-full"
                  style={{ accentColor: C.brass }} onChange={(e) => setDelayTime(parseFloat(e.target.value))} />
              </label>
            </div>
          </Panel>

          {renderDeck(1)}
        </div>

        {/* master, full width beneath — the SM-1 grammar */}
        <div className="mt-3">
          <Panel title="Master" accent={C.brass}>
            <div className="flex flex-wrap items-start justify-center gap-6">
              <Knob label="Age" sub="wow · flutter · hiss" value={age} min={0} max={1} step={0.01}
                accent={C.brass} onChange={setAge} format={(v) => Math.round(v * 100) + "%"} size={64} />
              <Knob label="Delay" value={delay} min={0} max={1} step={0.01} accent={C.brass}
                onChange={setDelay} format={(v) => Math.round(v * 100) + "%"} size={64} />
              <Knob label="Reverb" value={reverb} min={0} max={1} step={0.01} accent={C.brass}
                onChange={setReverb} format={(v) => Math.round(v * 100) + "%"} size={64} />
              <Knob label="Output" value={output} min={0} max={1.2} step={0.01} accent={C.brass}
                onChange={setOutput} format={(v) => Math.round(v * 100) + "%"} size={64} />
              <div className="flex items-start gap-4 rounded-sm p-2"
                style={{ background: "#2A3033", border: "1px solid #454C50" }}>
                <Knob label="Mod" sub="global" value={gmDepth} min={0} max={1} step={0.01} accent={C.brass}
                  onChange={setGmDepth} format={(v) => Math.round(v * 100) + "%"} size={64} />
                <div className="w-44 pt-4">
                  <div className="mb-1 text-[9px] uppercase tracking-[0.2em]" style={{ color: C.dim }}>Source</div>
                  <select value={gmSrc} onChange={(e) => setGmSrc(parseInt(e.target.value, 10))}
                    className="mb-1.5 w-full rounded-sm px-1 py-0.5 text-[9px]"
                    style={{ background: C.well, color: C.bone, border: "1px solid #141719" }}>
                    {["LFO", "Head drift", "Playhead A", "Playhead B"].map((o, i) => (
                      <option key={o} value={i}>{o}</option>
                    ))}
                  </select>
                  {gmSrc === 0 && (
                    <label className="mb-1.5 block">
                      <div className="flex justify-between text-[9px] uppercase tracking-widest" style={{ color: C.dim }}>
                        <span>Rate</span><span style={{ color: C.bone }}>{gmRate.toFixed(2)}Hz</span>
                      </div>
                      <input type="range" min={0.01} max={8} step={0.01} value={gmRate}
                        style={{ accentColor: C.brass }}
                        onChange={(e) => setGmRate(parseFloat(e.target.value))} />
                    </label>
                  )}
                  <div className="mb-1 text-[9px] uppercase tracking-[0.2em]" style={{ color: C.dim }}>Destination</div>
                  <select value={gmDest} onChange={(e) => setGmDest(parseInt(e.target.value, 10))}
                    className="w-full rounded-sm px-1 py-0.5 text-[9px]"
                    style={{ background: C.well, color: C.bone, border: "1px solid #141719" }}>
                    {["Delay", "Reverb", "Age", "Output", "Both speeds", "Both filters"].map((o, i) => (
                      <option key={o} value={i}>{o}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </Panel>
        </div>

        <p className="mt-5 text-[10px] leading-relaxed" style={{ color: C.dim }}>
          Cut a test loop into BOTH, press BOTH, then put deck B's offset a few hundred ppm off —
          that's the phasing. Drag any knob vertically; hold shift for fine. AGE at 0 is fresh tape
          and at 100% is a cassette left in a car for a decade; head loss stays on either way, because
          that's what makes it tape rather than damage. Load several files at once and they are
          spliced into one reel — reverse and varispeed run straight through the boundaries,
          because as far as the engine is concerned there are no tracks, only a position. Turn
          LOOP off and a deck plays the reel through once and stops. The grain section is the
          same idea in
          the other direction: SIZE is how long each grain lasts, DENS is how many playheads are
          on the tape at once, SPRAY scatters them inside the splice region, and RAMP goes from
          hard-edged and percussive to fully smeared. DENS at zero is a single head, so the
          machine you had before is still in there untouched. Switch a deck's grain source to
          LIVE and it granulates the input directly, no recording step — at 0.5x that's a real-time
          octave down, and at negative rates the grains run backwards while you play forwards.
        </p>
      </div>
    </div>
  );
}
