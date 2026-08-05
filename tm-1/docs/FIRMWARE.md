# TL-1 — Firmware Guide

Written for someone who has shipped a lot of software but never written embedded code. It covers what is genuinely different about a microcontroller, how to lay the project out so it stays maintainable, and the failure modes that will otherwise cost you weeks.

Read `PROJECT.md` for the doctrine and `ENGINE.md` for the DSP. This document is about **how to build and structure the firmware**.

---

## Part 1 — What is actually different

Almost everything you know still applies. C++ is C++. But four things change, and they are the four things that cause every beginner's mystery bug.

### 1. There is no operating system

No scheduler, no virtual memory, no process isolation, no `malloc` you can trust, no crash handler that prints a stack trace. Your program is the only thing running. If it writes past the end of an array it corrupts whatever happens to be there and keeps going, and the symptom appears somewhere unrelated ten minutes later.

The practical consequence: **you cannot debug by inference the way you do on a server.** You debug by making state observable — a scope on a GPIO pin, a value on the screen, a log line drained from a ring buffer.

### 2. Your program has two halves that run at different urgencies

```
        AUDIO CALLBACK                    MAIN LOOP
        ~48,000 times/sec                 as fast as it can
        interrupt context                 normal context
        HARD deadline                     no deadline
        must never block                  may block freely

        reads params                      reads knobs
        writes audio                      draws screen
                                          reads/writes SD
                                          updates LEDs
```

The audio callback runs from a DMA interrupt. At 48 kHz with a 48-sample block you get a new block every **1 millisecond**, and you must be finished before the next one arrives. Miss it once and you get a click. Miss it regularly and it is unusable.

Everything that is slow, unbounded, or blocking goes in the main loop. Everything that must happen per sample goes in the callback. Getting this split wrong is the number one cause of "it worked on my laptop."

### 3. Memory is not uniform

On the STM32H750 there are several kinds of RAM with wildly different speeds:

| Region | Size | Speed | Use for |
|---|---|---|---|
| DTCM | 128 KB | Fastest, zero wait states, no cache needed | Sinc table, filter state, hot data |
| Internal SRAM | ~512 KB | Fast | Audio buffers, general working memory |
| SDRAM (Daisy) | 64 MB | Slow, cached, shared bus | Tape buffers only |
| QSPI flash | 8 MB | Slow, read-mostly | Saved settings, wavetables |

**Putting the wrong thing in the wrong region is the difference between 8 % CPU and 40 % CPU.** The sinc table is 32 KB and read 96,000 times a second; in SDRAM it becomes the bottleneck of the entire machine. In DTCM it is free.

libDaisy gives you macros for placement:

```cpp
// 64MB SDRAM — big, slow, cached
int16_t DSY_SDRAM_BSS tapeA[TAPE_SAMPLES];
int16_t DSY_SDRAM_BSS tapeB[TAPE_SAMPLES];

// default (internal SRAM) — everything else
static float sincTable[512 * 16];
```

### 4. Floating point is fast, but not everywhere

The M7 has a hardware FPU for **single-precision** float. It is genuinely fast — a fused multiply-add in one cycle. Double precision also exists on the H7 but is slower.

Two traps:

- **`double` sneaks in.** `float x = 0.5 * y;` promotes to double because `0.5` is a double literal. Write `0.5f`. Enable `-Wdouble-promotion` and treat it as an error.
- **Denormals.** Very small numbers (reverb tails decaying toward zero) can drop into denormal representation, which on some hardware is dramatically slower. Add a tiny DC offset or flush-to-zero in filter feedback paths.

---

## Part 2 — Rules for code in the audio callback

These are absolute. Violating one produces glitches that are extremely hard to trace back to their cause.

### Never allocate

No `new`, no `malloc`, no `std::vector` growth, no `std::string`, no `std::function`, no lambdas that capture by value into a heap allocation. Everything preallocated at startup.

```cpp
// NO
std::vector<float> temp(size);

// YES
static float temp[MAX_SIZE];   // sized at compile time
```

### Never block

No SD card reads or writes. No `printf`. No waiting on anything. No mutexes.

### Never take an unbounded loop

Every loop in the callback must have a compile-time-known upper bound. `while (pos != target)` in the record head needs a guard counter — and does have one, for exactly this reason.

### Never call anything you have not read

Library functions may allocate or block invisibly. `sprintf` allocates on some toolchains. File system calls obviously block. If you did not write it and did not read it, do not call it from the callback.

### Communicating between the two halves

The main loop and the callback share state. This is the classic source of subtle corruption.

**Pattern 1 — parameters flowing down (main → callback).** Use a double-buffered POD struct with an index flip. The callback reads one buffer; the main loop writes the other and then flips an index. Because the index write is a single aligned word, it is atomic on this architecture.

```cpp
struct Params { float speed[2]; float filter[2]; /* ... POD only ... */ };

static Params  params[2];
static volatile uint8_t liveIdx = 0;

// main loop
Params& next = params[liveIdx ^ 1];
next = buildFromControls();
liveIdx ^= 1;               // publish

// callback
const Params& p = params[liveIdx];
```

**Pattern 2 — data flowing up (callback → main).** Use a single-producer single-consumer ring buffer with `volatile` head and tail. This is how audio gets from the callback to the SD writer, and how log messages get out.

**Never share a mutex.** Never `std::atomic` with anything but relaxed ordering on simple types. Keep it boring.

---

## Part 3 — Project structure

The structure exists to make one thing possible: **develop and test everything on your laptop, and only use the hardware for what genuinely needs hardware.**

```
tl1/
├── core/                     portable C++17, ZERO dependencies
│   ├── dsp/
│   │   ├── resampler.h/.cpp     sinc table, read(), readFast()
│   │   ├── deck.h/.cpp          one tape transport, knows nothing of the other
│   │   ├── grains.h/.cpp        grain pool + scheduler
│   │   ├── tape.h/.cpp          head loss, wow/flutter, hiss, dropout, saturation
│   │   ├── filter.h/.cpp        TPT SVF
│   │   ├── delay.h/.cpp
│   │   ├── reverb.h/.cpp
│   │   └── modulation.h/.cpp    LFOs and the global mod matrix
│   ├── app/
│   │   ├── machine.h/.cpp       owns 2 decks + master. ALL coupling lives here
│   │   ├── transport.h/.cpp     play/rec/scrub state machine
│   │   ├── reel.h/.cpp          playlist as one spliced tape, sliding window
│   │   └── params.h             the POD parameter struct
│   ├── ui/
│   │   ├── framebuffer.h        the screen is a byte array. Nothing else
│   │   └── views/               status, waveform, reel, spectrogram, levels
│   └── hal/
│       └── hal.h                abstract interface. Header only
├── hosts/
│   ├── daisy/                   libDaisy implementation + main.cpp
│   ├── wasm/                    emscripten implementation
│   └── cli/                     WAV in, WAV out — for tests
├── panel/
│   └── panel.json               control map + screen spec
├── web/                         React app, renders panel.json
├── tests/
│   ├── golden/                  reference WAV files
│   └── *.cpp
└── CMakeLists.txt
```

### The rules that keep this maintainable

**`core/` has no includes outside itself and the C++ standard library.** No libDaisy, no emscripten, no platform headers. If a file in `core/` needs to know what platform it is on, the design is wrong.

**`core/dsp/` classes are plain objects with `process()` methods.** No singletons, no globals, no static state. Each one is independently testable.

**All coupling lives in `machine.cpp`.** This is the single most important structural rule. The HEADS topologies — LINK, STEREO, SPLIT — are decisions about what to hand each deck:

```cpp
void Machine::process(float* outL, float* outR, size_t n) {
  for (size_t i = 0; i < n; ++i) {
    // The global layer decides. The decks never branch on mode.
    const int16_t* bufA = tapeA;
    const int16_t* bufB = (heads_ == Heads::Link) ? tapeA : tapeB;
    float rateB = (heads_ == Heads::Stereo) ? rateA : params_.speed[1];

    float a = deckA_.process(bufA, baseA, lenA, rateA, inL[i]);
    float b = deckB_.process(bufB, baseB, lenB, rateB, inR[i]);
    // ... pan, delay, reverb, output
  }
}
```

If you ever find yourself passing a `Heads` enum into `Deck`, stop. That is the design eroding.

**One `Machine` instance, created in `main()`.** Not a singleton, not a global you reach for — constructed once and passed by reference.

**Configuration is compile-time.** A single `config.h` with buffer sizes, grain counts, tape lengths. No runtime configuration of things that cannot change at runtime.

---

## Part 4 — Build system

Use CMake with three targets sharing one core library.

```cmake
add_library(tl1core STATIC
    core/dsp/resampler.cpp core/dsp/deck.cpp core/dsp/grains.cpp
    core/dsp/tape.cpp core/dsp/filter.cpp core/dsp/delay.cpp
    core/dsp/reverb.cpp core/dsp/modulation.cpp
    core/app/machine.cpp core/app/transport.cpp core/app/reel.cpp)
target_include_directories(tl1core PUBLIC core)
target_compile_features(tl1core PUBLIC cxx_std_17)

# host builds — plain native compiler
add_executable(tl1cli   hosts/cli/main.cpp)      # regression tests
add_executable(tl1tests tests/test_all.cpp)
target_link_libraries(tl1cli tl1core)
target_link_libraries(tl1tests tl1core)
```

The Daisy target uses their existing Makefile scaffolding (from the Daisy examples) rather than fighting CMake into cross-compilation on day one. It compiles the same `core/` sources.

### Compiler flags that matter

```
-O2                     -O3 is not reliably faster and inflates code size
-ffast-math             questionable — it changes float semantics. Prefer
                        -ffinite-math-only -fno-signed-zeros if you need speed
-Wall -Wextra
-Wdouble-promotion      catches the 0.5-vs-0.5f trap. Treat as error
-Wconversion            noisy but catches real narrowing bugs
-fno-exceptions
-fno-rtti               neither belongs in a real-time audio path
```

---

## Part 5 — Testing

This is the part that determines whether the project is still moving in month seven.

### Golden-file regression tests

The single most valuable test you can have. The CLI host reads a WAV, runs it through the core with a fixed parameter set, and writes a WAV. Compare against a stored reference.

```
tests/golden/
  sine_440_quarter_speed_sinc.wav
  chord_age100_grains8.wav
  overdub_decay085.wav
```

When you change the engine, you find out immediately whether you changed the *sound*. Without this, every refactor is a leap of faith and you will eventually break something subtle and not notice for weeks.

**Build this at M0, before anything else.** The first golden files should be generated from the current browser harness output, so you can prove the C++ port is correct rather than merely plausible.

### Unit tests on the DSP

Plain assertions, no framework needed:

- Sinc table rows sum to 1.0 ± 1e-6
- Resampler at rate 1.0 returns the input exactly
- Filter at amt 0 is transparent
- Grain level normalisation holds RMS within 1 dB across the parameter range
- Position accumulator does not drift over 10 million samples

### The properties worth asserting on every build

- Nothing in the output is NaN or Inf, for **every** combination of topology × interpolator × extreme rate. The harness already runs this sweep and it has caught real bugs twice.
- Peak output stays below a sane ceiling under stress settings.

### CPU budget testing

Measure on hardware, do not estimate. The M7 has a cycle counter (DWT) you can read directly:

```cpp
// enable once at startup
CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;

// around the callback body
uint32_t t0 = DWT->CYCCNT;
machine.process(outL, outR, n);
uint32_t used = DWT->CYCCNT - t0;
// budget = 480e6 / (48000 / n) cycles per block
```

Display the percentage on screen permanently during development. When you add grains and it jumps from 12 % to 38 %, you want to see that the moment it happens, not three features later.

### The CPU meter belongs in the harness too

The browser version should estimate the same number against the M7's real budget and shout when it is exceeded. A simulator that lets you write code the target cannot run is worse than no simulator.

---

## Part 6 — Debugging

### Get the debugger working on day one

Do not skip this. USB DFU flashing gives you no breakpoints, and you are about to write fixed-point position arithmetic where one misplaced shift produces audio that is *subtly* wrong in a way `printf` will never reveal.

- **ST-Link V3 MINIE**, ~$12, connects to the Daisy's SWD pads
- **VS Code + `cortex-debug` extension**, with OpenOCD
- You get real breakpoints, memory inspection, and register views

Note: breaking in the audio callback stops the world. Audio will glitch on resume. That is fine and expected — you are inspecting state, not listening.

### Logging without breaking real-time

Never `printf` from the callback. Instead, push to a ring buffer and drain it in the main loop:

```cpp
// callback (safe — just a pointer write)
logf("pos=%f", pos);       // enqueues a small POD record

// main loop
logDrain();                // formats and writes to serial
```

### A GPIO pin and a scope beat everything

Set a pin high at the start of the callback and low at the end. On a scope you see your exact CPU load, live, including the jitter. This is the fastest way to find intermittent overruns, and it costs two lines of code.

### Symptom → cause table

Learn this table. It will save you weeks.

| Symptom | Likely cause |
|---|---|
| Regular clicking at a fixed rate | Callback overrunning its deadline |
| Random clicks, worse when the card is busy | SD access blocking the audio thread, or SDRAM bus contention |
| Clicks only after a DMA transfer | D-cache not invalidated — CPU reading stale data |
| Audio fine, then degrades over minutes | Float32 position accumulator, or a leak in a ring buffer index |
| Works with debugger attached, fails without | Timing-dependent bug, or uninitialised memory (the debugger zeroes RAM) |
| Hard fault on startup | Buffer in the wrong memory region, or SDRAM not initialised before use |
| One channel silent | Codec channel config, or a `for` loop bound using the wrong count |
| Distortion that scales with knob position | Missing clamp, or double promotion changing rounding |
| Intermittent garbage from the SD card | Wiring too long for SDMMC, or a card with bad worst-case latency |
| Screen blank but audio works | SPI pin conflict, or drawing from the callback (never do this) |

### The D-cache trap, specifically

This one is worth its own paragraph because it will happen to you. The M7 has a data cache. DMA writes to memory **behind the cache's back**. If the CPU has a cached copy of that region, it reads stale data.

After any DMA transfer into a buffer you are about to read:

```cpp
SCB_InvalidateDCache_by_Addr((uint32_t*)buf, size);
```

And before any DMA transfer *out* of a buffer you just wrote:

```cpp
SCB_CleanDCache_by_Addr((uint32_t*)buf, size);
```

Symptom of forgetting: clicks that make no sense, appear randomly, and vanish when you add a `printf` (because the printf changes timing).

---

## Part 7 — The first program

Do not start with the TL-1. Start with this, on the Daisy Pod, and make sure each step works before the next.

**Step 1 — pass-through.** Codec in, codec out, nothing else. Proves the toolchain, the flashing, and the audio path. About 15 lines.

**Step 2 — read a knob.** Print it over serial. Proves the ADC and your smoothing filter. Note how noisy the raw value is; that noise is why the smoothing exists.

**Step 3 — a delay line in SDRAM.** Allocate a buffer with `DSY_SDRAM_BSS`, write and read it. Proves SDRAM is initialised and you understand memory placement.

**Step 4 — fixed-point playback at rate 1.0.** Your 32.32 accumulator, linear interpolation, playing a buffer. Proves the position arithmetic.

**Step 5 — the knob controls the rate.** This is varispeed. This is the moment you hear your own engine coming out of hardware you programmed.

**Step 6 — swap in the sinc table.** A/B it against linear by holding a button. Now you know whether the port is faithful.

Only after step 6 does the rest of the machine start.

---

## Part 8 — Habits that keep it maintainable

**Commit the golden files.** They are the contract. A PR that changes them must say why.

**One concept per file.** `grains.cpp` should not know about the filter. If two files need each other, that is a sign the boundary is in the wrong place.

**No `#ifdef` in `core/`.** Platform differences belong in `hosts/`. The moment you write `#ifdef DAISY` in a DSP file, portability is gone and the browser harness starts to diverge.

**Keep `params.h` a POD struct.** No constructors, no virtuals, no pointers. It must be safe to copy with a memcpy and to double-buffer.

**Write the test before the optimisation.** Every performance change should be provable against a golden file. "It sounds the same to me" is not a test.

**Update `PROJECT.md` when you change doctrine.** The doctrine section exists so that future-you, and any agent working in the repo, does not undo a decision that took a long time to reach. If a rule genuinely needs to change, change it there deliberately rather than eroding it in code.
