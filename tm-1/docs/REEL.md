# TL-1 — The Reel

Design for the storage and playback abstraction. One concept, arbitrary length, arbitrary source, and varispeed that always does the right thing.

Read `PROJECT.md` for doctrine, `ENGINE.md` for the DSP. This document defines the layer beneath both.

---

## The model

> **A reel is an arbitrarily long piece of tape. A deck holds one reel and a splice on it. How much of the reel is in RAM is the machine's business, not the user's.**

That is the whole design. Everything below is consequence.

```
   REEL                 the tape. Arbitrary length. Lives in storage.
    │
    │  ┌──────────────────────────────────────────────────────┐
    │  │  track 1  │ track 2 │  track 3  │ ... │  track N     │
    │  └──────────────────────────────────────────────────────┘
    │                    ╎                ╎
    │                    ╎   SPLICE       ╎     the loop. Any region.
    │                    ╎                ╎     Defaults to the whole reel.
    │              ┌─────┴────────────────┴─────┐
    │              │        WINDOW              │  what is resident.
    │              └────────────────────────────┘  Machine's business.
    │                         ▲
    └─────────────────────  PLAYHEAD ─── varispeed, either direction
```

There are no modes. A three-second loop and a six-hour playlist are the same object with different numbers in it.

---

## Three backing stores

A reel is defined by where its samples come from. All three present the same interface.

| Store | Source | Length | Writable | Notes |
|---|---|---|---|---|
| **Card** | SD file, or N files spliced end to end | Arbitrary | Append / bounce only | The default. A playlist is one reel with N marks |
| **RAM** | Recorded, or a short file loaded whole | ≤ per-deck budget | **In place** | This is where overdub lives |
| **Live** | The input ring | Rolling few seconds | Continuously | Only the recent past is addressable |

The interface is deliberately tiny:

```cpp
struct Reel {
  uint64_t length;                    // samples
  bool     writable;                  // can the record head write in place?
  size_t   read(uint64_t start, int16_t* dst, size_t n);
  void     write(uint64_t start, const int16_t* src, size_t n);  // if writable
  const Mark* marks; size_t markCount; // track boundaries
};
```

`read()` is called **only from the main loop**, never the audio callback. That is the same rule as everything else in `FIRMWARE.md`: the audio path never touches storage.

---

## The window policy

This is the part that makes varispeed always behave. Four rules, evaluated in order.

### Rule 1 — If the reel fits, keep all of it

`reel.length <= WINDOW` → the window *is* the reel. No I/O ever happens again. Everything works: splice anywhere, phasing, reverse, scrub, grains.

**This is not a special case in the code.** It is what the general algorithm does when the numbers are small. Residency is an emergent property, not a mode.

### Rule 2 — If the splice fits, pin the window to the splice

`splice.length <= WINDOW` → centre the window on the splice and **never move it again** while the splice is unchanged.

This is the rule that matters most musically, because it means: once you have set a loop, the machine does zero I/O regardless of where that loop sits on a six-hour reel. Varispeed, reverse, ppm phasing, grains — all operate at full fidelity on a loop at the four-hour mark, exactly as they would on a three-minute tape.

Set a twenty-second splice and the reel's length becomes irrelevant.

### Rule 3 — Otherwise the window follows the playhead, biased by direction

When the splice is longer than the window (including the default case, where the splice is the whole reel), the window tracks the playhead — but **asymmetrically, in the direction of travel**:

```
forward   [ 25% behind │ playhead │ 75% ahead ]
reverse   [ 75% behind │ playhead │ 25% ahead ]
```

Prefetch happens in the direction you are actually going. Reversing direction triggers one re-centre, then it is stable again.

### Rule 4 — Margin scales with rate

Refill when the playhead comes within `margin` of the leading edge, where:

```
margin = max(MIN_MARGIN, |rate| × MIN_MARGIN)
```

At 1× you need a couple of seconds of runway. At 8× scrub you need sixteen. Using a fixed margin means scrubbing outruns the loader, which is exactly the failure that makes streaming instruments feel fragile.

**Use the maximum rate seen in the last ~200 ms**, not the instantaneous rate. Rate is slewed by the transport's 35 ms inertia, so the instantaneous value lags a fast move and the margin would arrive too late.

### Concrete numbers

| | Hardware | Harness |
|---|---|---|
| Window | 87 s (8 MB int16) | 60 s |
| Min margin | 2 s | 2 s |
| Margin at 4× scrub | 8 s | 8 s |
| Refill chunk | 64 KB pieces | one blob slice |

The 64 KB chunking on hardware is not optional — one large DMA burst into SDRAM stalls the audio path's reads on the shared bus. See `FIRMWARE.md`.

---

## Two details that keep the seams silent

**Interpolation guards.** A streamed window carries extra samples beyond both
addressable ends (1024 each side), so the 16-tap sinc reads real neighbouring
audio at an edge instead of wrapping to the other end of the window. This is
standard sampler-streaming practice ("margins in the ring buffer for
interpolation"), and it is the difference between a late refill degrading
gracefully and it clicking. Resident reels need no guard — their edges are the
splice, and a splice is *supposed* to wrap.

**A dying grain stays dead.** A window swap can strand a grain outside memory;
it then fades out over ~3ms from its own last sample. Under window thrash the
grain can find itself back inside memory mid-fade — and resuming the read would
jump from the faded value to full amplitude, exactly the click the fade
prevents. So the fade is a latch, not a condition.

**Known inefficiency, accepted:** re-centring re-reads roughly 30% of the
window each refill, where a true ring buffer reads only new data. Rule 2 makes
refills rare enough that the simpler code wins. Revisit only if card bandwidth
ever becomes the constraint.

## Spooling is the honest failure mode

Two things can ask for audio that is not resident: moving the splice a long way, and scrubbing past the margin.

**Do not hide it. Make it a spool.** Show travel on screen, play what is resident while the loader catches up, and let it take the time it takes. This is the one place where the machine's strongest opinion — that there is no random access — stops being a limitation and becomes the interface.

A hard jump to an arbitrary timestamp would need a stall you would have to disguise. Spooling needs no disguise, because it is what tape does.

---

## Recording

Where the record head can write depends on the store, and this is the one distinction the user genuinely needs to know about.

| Store | Behaviour |
|---|---|
| **RAM** | Writes in place. Overdub, erase coefficient, sound-on-sound — the full Frippertronics loop |
| **Card** | Cannot write in place while streaming. Recording **captures to a new reel** |
| **Live** | The ring is always recording; arming a deck is what makes it permanent |

So arming REC on a streamed reel is a **bounce**, not an overdub. That is honest, it is what a second tape machine would do, and it is already in the spec as bounce-to-card.

**Recording with no reel loaded creates one.** It grows as you record, lives in RAM until it exceeds the deck budget, and spills to the card after that. Same object either way — the user never chooses.

---

## What the Octatrack gets right, and what to reject

The OT solved this problem and split it into **Static** and **Flex** machines: static streams from the card and can be arbitrarily long; flex lives in RAM, is shorter, and can be recorded into.

**Take:** the distinction is real and it is about *writability*, not about playback. There is a genuine reason you cannot overdub onto a six-hour streamed file, and pretending otherwise would produce a machine that fails in confusing ways.

**Reject:** exposing it as a machine type you assign up front. That is a modal decision made before you know what you want, and it is one of the things people find hard about the OT. On the TL-1 the reel simply reports whether it is writable, the REC button behaves accordingly (overdub or bounce), and nothing needs choosing in advance.

**Also take:** the OT's slice grid. Our track marks are the same idea arriving from a different direction — a reel loaded with N files has N-1 splice points already in it. "Next track" is just moving the splice to the next mark. Worth building, because it makes a hundred-track reel navigable without a file browser.

**Also reject:** the OT's sample-locking and machine-per-track complexity. This machine has two decks and no sequencer; that whole layer of the OT solves a problem the TL-1 does not have.

---

## Consequences for the current build

The harness currently violates the model in three places.

**1. Splice is disabled on streamed reels.** Wrong — Rule 2 says a splice smaller than the window should be the *best* case, not a forbidden one. This is the biggest gap and the one that would make a long reel playable as an instrument rather than merely a player.

**2. The window is centred symmetrically and the margin is fixed.** Rules 3 and 4 are unimplemented. Works at 1×, gets fragile at high scrub rates.

**3. "Blank tape" and "loaded reel" are different objects.** Under the model, recording just creates a reel like any other, and the same code should handle it.

None of these are large. All of them make the machine more consistent rather than adding features.

---

## Implementation order

1. **Rule 2 — pin the window to the splice.** Biggest musical payoff, and it makes splice work everywhere. One conditional in the refill logic.
2. **Rule 4 — rate-scaled margin.** Two lines, and it is what makes scrubbing survive.
3. **Rule 3 — directional bias.** Cheap, and it halves effective I/O.
4. **Recording creates a reel.** Unifies the last object.
5. **Mark navigation.** "Next track" moves the splice to the next mark.

Steps 1–3 are the ones that make varispeed always do the right thing. They belong in the harness now, because the same logic ports directly to the firmware's main loop.
