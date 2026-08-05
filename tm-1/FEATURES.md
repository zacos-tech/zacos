# TL-1 — Tape Feature Backlog

A plan for the tape-native features not yet built, written for agents working in this repo. Each entry says what the feature is in tape-machine terms, why it earns a place, where it lives in the target architecture, how to build it, and how to prove it works.

Read `PROJECT.md` (doctrine, milestones) and `REVIEW.md` (refactor phases) first. `ENGINE.md` explains the DSP these features extend; `REEL.md` explains the storage model some of them touch.

---

## Ground rules for implementing anything here

1. **The Phase 0 gate is absolute.** No feature in this document gets built until the repo migration in `REVIEW.md` Phase 0 is complete. The current single-file build has generated roughly one bug per working session from its tooling alone. Features land in the restructured `Deck` / `Machine` / `ReelView` code (Phase 1), not in the monolith.
2. **Every feature must be expressible in tape vocabulary.** If the description needs sampler or DAW language, the design is wrong — rework it or reject it. Each entry below includes its tape framing; keep it when writing UI copy and comments.
3. **Doctrine checks apply** (see `PROJECT.md`): no modality, position encodes ownership, defaults complete, the lid test. A feature that needs a new panel control must argue for it explicitly; the default answer is a screen setting on the deck page.
4. **Every feature ships with tests**: a regression case (no NaN, level sane, no discontinuities) and, where it changes the sound, a new golden file rendered by `render-cli.js`.
5. **Grain/window interactions must be checked** against `reel-policy-test.js`. Anything touching the transport or the splice can break streaming invisibly.

---

## Priority order

Rank is build priority; § points at the spec below.

| Rank | Feature | Value | Effort | Depends on |
|---|---|---|---|---|
| 1 | Punch (replace-record) §1 | High — completes the recorder | Small | Phase 1 Deck |
| 2 | Play wear + positional damage §8 | High — the Disintegration Loops mechanism (prior art noted in §8) | Medium | Phase 1 Deck |
| 3 | Head-gap echo §2 | High — the most tape-native effect missing | Medium | Phase 1 Deck |
| 4 | Source/tape monitoring §3 | Medium — required for punch to be usable | Small | §1 |
| 5 | Feedback routing §13 | High — what "lets you go wild" actually means in the signal path | Small | none |
| 5= | VOX arm + take-defines-the-splice §12 | Medium — the field-recorder workflow, proven in Bedtime's prototype | Small | none |
| 6 | Ping-pong loop §4 | Medium — cheap, characterful | Small | Phase 1 |
| 7 | Splice angle §9 | Medium — the honest fix for the loop seam | Small | none |
| 8 | Multiple play heads §10 | Medium — Space Echo territory | Small | §2 |
| 9 | Brake §11 | Medium — the signature gesture, made performable | Small | none |
| 10 | Splice pop §5 | Low — pure character | Trivial | none |
| 11 | Hysteresis §6 | High sound value, high cost | Large | measure on Seed3 first |
| 12 | Head bump, modulation noise, print-through, azimuth §7 | Low each, real in sum | Small each | none |

Explicitly out of scope, by decision: chromatic/keyboard playing, quantized pitch, sequencing of any kind. The TL-1 is operated, not played in notes — features that would pull it toward the synth aisle are rejected even when cheap.

Items already specified elsewhere and **not** duplicated here: pre-record buffer, bounce-to-card, mark navigation, recording-creates-a-reel (`CAPABILITIES.md`, `REEL.md`); freeze momentary-vs-latch decision (panel question, resolve in harness).

---

## 1. Punch — replace-record

**What it is.** The multitrack fix-it move. Tape rolls, performer plays along with the old take, and at the mistake the engineer drops into record mid-flight — *replacing* audio from that point — then punches out, and the old material continues. Auto-punch (machine drops in/out at preset points) and rehearse (monitor switches as if recording, nothing writes) are the standard companions.

**Why the TL-1 can't do it today.** Punch is *replace*: erase coefficient 0. The decay control deliberately bottoms out at 0.9, so the machine can only layer. This is a one-line range decision, not an architecture problem.

**Design.**
- REC gains a per-deck mode: **LAYER** (current behaviour, decay knob active) / **REPLACE** (erase = 0 while recording). Screen setting on the deck page, not a panel control — the lid test does not need another word.
- **Rehearse**: a third state where the monitor switches to input on "record" but the write head is disabled. Falls out of the monitoring switch (feature 3) — implement together.
- **Auto-punch**: arm REPLACE between two marks; the transport engages/disengages the write head at the mark positions. Marks already exist in the reel model. Do this *after* mark navigation lands.

**Where it lives.** `Deck` owns the write-head state machine (off / layer / replace / rehearse). `Machine` owns nothing new. UI: REC button behaviour keyed off the deck-page mode.

**Implementation notes.**
- REPLACE on a *streamed* reel is still a bounce (`REEL.md` — card reels are not writable in place). The mode applies to RAM reels; on a streamed reel the REC button behaves as today. Surface this in the status line, not a modal.
- Punch-in/out edges need a short crossfade (~5 ms) between old and new material or every punch clicks. The grain-envelope lesson applies: some fade is always present.

**Tests.** Golden file: tone A recorded, punch-replace a middle region with tone B, verify the three segments and two clean crossfades. Regression: punch during varispeed; punch at a splice edge; REPLACE then decay knob moved (must not retroactively affect).

---

## 2. Head-gap echo

**What it is.** On a three-head machine the record and play heads are physically separated, so while recording you hear the tape a moment late — and that gap *is* tape echo. It is the entire mechanism of the Space Echo and of Frippertronics: feedback around a physical distance. Crucially the delay time is `gap / tape speed` — slow the transport and the echo stretches, which no digital delay tied to milliseconds does.

**Why it matters here.** It is the most tape-native feature the machine lacks; it makes sound-on-sound self-echoing (record with decay < hold and the head gap becomes a feedback delay whose character *is* the tape path — hiss, wow, head loss all inside the loop); and it is a stronger answer than the master delay for the "modern Moogerfooger" claim.

**Design.**
- Per-deck **HEAD GAP** parameter, 0–500 ms *at 1×*, expressed on screen as a distance would be honest (`≈ 9.5 cm` at 7.5 ips flavour text optional). Default 0 (current behaviour — the machine must sound identical until asked).
- Effective delay in samples = `gapSamples / |rate|`, recomputed as the transport moves. At 0.25× a 100 ms gap is a 400 ms echo. Reverse: the play head *leads* the record head; the honest behaviour is that the gap still applies in tape order — document, don't special-case.
- With decay (erase coefficient) below hold, the gap + sound-on-sound *is* the echo feedback path. No separate feedback control: decay is the feedback amount. This is the design's elegance — two existing controls plus one new one produce the whole Space Echo topology.

**Where it lives.** Entirely in `Deck`: the write position becomes `readPos − gap` in reel coordinates (write head physically *before* the play head in tape order). `ReelView` supplies the conversion; the window policy must count the gap when deciding whether the splice "fits" (Rule 2's pinned region grows by the gap).

**Implementation notes.**
- The record head currently writes at the read position with position-walking. The change is an offset, not a rewrite — but the offset is in *reel* coordinates and must respect splice wrap.
- Gap + REPLACE (feature 1) = a clean slapback re-recorder. Gap + LAYER = Frippertronics proper. Both fall out; test both.
- Streamed reels: gap echo requires writability → RAM reels only, same rule as overdub.

**Tests.** Golden: impulse recorded with 100 ms gap and decay 0.7 → measurable echo train, spacing verified at 1× and 0.5× (spacing must double). Policy suite: pinned splice with gap at the splice edge.

---

## 3. Source / tape monitoring

**What it is.** The three-head monitor switch: listen to the **input** (source) or to the **playback head** (tape). On real decks this is how you verify a recording while making it.

**Design.** Per-deck screen setting with three states: **AUTO** (default: tape normally, source while armed — what the machine implicitly does today), **SOURCE**, **TAPE**. Rehearse mode (feature 1) is AUTO with the write head disabled. The spec'd hardware behaviour "monitor mutes when a deck is armed with speakers active" belongs to this switch's logic.

**Where it lives.** `Deck` output-stage select. Trivial DSP; the value is in making punch and rehearse coherent.

**Tests.** Regression only: each state routes the expected signal; no clicks on switch (2 ms crossfade).

---

## 4. Ping-pong loop

**What it is.** Auto-reverse decks played a region boustrophedon — forward to the end, flip, backward to the start, flip. As a *loop mode* it removes the splice seam entirely (the playhead never crosses the splice; it reflects off it) and produces the characteristic back-and-forth of auto-reverse cassettes.

**Design.** LOOP becomes a three-state: **LOOP / ONE-SHOT / PING-PONG**. In ping-pong the transport negates its rate at the splice ends. The SPEED knob's sign still means "current direction"; the reflection flips an internal direction flag, not the knob. Head loss, wow, grains all follow automatically because they follow the transport.

**Where it lives.** The transport wrap logic in `Deck` (currently the splice-wrap block). One new case.

**Implementation notes.** Reflection must preserve the fractional position (`pos = 2·edge − pos`), not clamp, or a click lands at every turn. Grain spawn direction follows the flag. Window policy: unchanged — Rule 2 pins the same region; Rule 3's direction bias reads the *current* direction.

**Tests.** Golden: sawtooth region in ping-pong → verify reflected waveform symmetry and zero discontinuity at both edges across 20 reflections, at 1× and −1.7× (asymmetric rates must still reflect cleanly).

---

## 5. Splice pop

**What it is.** A real splice — cut tape, adhesive, rejoin — passes the head with a small transient: a brief level dip and a soft thump. Optional character, default **off**.

**Design.** Screen toggle per deck. On splice crossing (loop wrap only — not ping-pong, which never crosses), inject a ~2 ms half-cosine level dip plus a lowpassed click at −30 dB, scaled up slightly with AGE. Numbers to taste by ear; keep them in the constants block.

**Tests.** Regression: enabled vs disabled RMS delta bounded; no NaN at extreme rates; pop must not fire on window swaps (reel coordinates make this automatic, but assert it).

---

## 6. Hysteresis (tracked in `PROJECT.md`, expanded here)

**What it is.** Real tape magnetisation depends on where it has been — the memoryless `tanh` is the engine's weakest approximation. Reference: Jatin Chowdhury's CHOW Tape Model (GPLv3; DAFx paper; an embedded port exists for the Multiverse pedal, so viability is proven).

**Plan, in order.**
1. Read the DAFx paper before writing anything.
2. **Measure the RK4 Jiles–Atherton cost on the Seed3 first** — this is the one feature whose budget is unknown by an order of magnitude. DWT cycle counter, one deck, 48 k.
3. If it fits: implement in `packages/engine` behind the same interface as the current saturator, A/B by flag, golden files for both paths.
4. If it does not fit: Chowdhury's own simplified models (paper §6) are the fallback; a 4× cheaper approximation that keeps the asymmetry is worth more than a perfect one that forces 48 k-only operation.
5. Licence note: linking this code makes the firmware GPLv3 — already the plan, but the decision becomes irreversible here.

---

## 7. Small physics, batched

Each is a few lines in `tape.js` / the future `tape.cpp`, defaults tuned by ear, all inside the AGE complex except head bump:

- **Head bump** — low-frequency lift (~60–100 Hz at 1×) from head geometry, corner tracking speed like head loss. *Not* under AGE; it is machine character, not wear.
- **Modulation noise** — hiss that rides signal level rather than sitting under it: `noise · (floor + k·|signal|)`. Under AGE.
- **Print-through** — pre/post-echo of loud material at ~−45 dB, offset by one "wind" (a fixed few hundred ms). Under AGE, only audible at high settings. Cheap version: one delayed, heavily lowpassed send.
- **Azimuth error** — slight interchannel time/HF skew on the STEREO topology. Under AGE. Tiny fixed delay (0–20 samples) plus gentle HF shelf on one channel.

**Tests.** One combined golden file at AGE 0 (must be bit-identical to pre-feature output — these must all be silent at zero) and one at AGE 0.8.

---

## 8. Play wear + positional damage — tape that remembers

**What it is.** Every pass of tape across a head sheds oxide. Basinski's *Disintegration Loops* is the canonical piece: the loop degrades *because it is played*, unevenly, until it is mostly gaps — the composition is the decay. Separately, real damage is *geographic*: a crease lives at one spot and warbles identically every pass, becoming part of the piece the way a scratch becomes part of a record. These are one system — a persistent map of the tape's condition, indexed by reel position — and they give the machine a property nothing else in the engine has: **history**.

**Why it earns a place.** Generation loss (bounce) and decay (record) exist; nothing degrades on *playback*. This is the single most famous thing tape ever did in ambient music.

**Prior art, so nobody claims otherwise in copy:** Music Thing Modular's *Degenerator* (2026, a program card for the Workshop System Computer) is a self-overwriting looper explicitly inspired by Basinski — six irreversible degradation algorithms including "oxide shedding," applied to a short buffer in a deliberate DEGRADE mode. It is the nearest hardware relative and it is good. The TL-1's claim is narrower and stronger: wear that is **geographic** (a condition map over the reel, so damage has an address), **consequential** (accrued by the playhead as a side effect of playing, not applied as an effect), **healable** (recording lays new oxide), and **persistent** (saved with the session) — on a machine with a real transport and arbitrarily long reels. Marketing language should say "the first tape machine whose tape wears out from playing," not "the first disintegration device." Set a 20-second loop, press play, come back in two hours to a different piece.

**Design.**
- Per-deck **WEAR** rate, screen setting, default **0** — the machine is immortal until asked. At the top of the range a loop should audibly age over tens of minutes, not seconds.
- The condition map is coarse: one cell per ~100 ms of reel. Per cell: HF-loss accumulation and dropout probability. Each play-head crossing increments the cells it touched, scaled by WEAR. Grain reads count as crossings at reduced weight (a frozen drone slowly wears the region it is drawn from — the Basinski drone decays, which is exactly right).
- **Damage** is authored into the same map: a small set of seeded point defects per reel (crease = localized wow + HF notch; oxide pit = deterministic dropout). Same cells, same application path — damage is just wear that arrived all at once.
- Applied at read time: cell values drive the existing head-loss corner, dropout gate, and a small wow offset. No new DSP — the map modulates machinery that already exists.

**Where it lives.** The map is reel metadata owned by `ReelView` (it is position-indexed, and only `ReelView` speaks reel coordinates). `Deck` reads through it. At ~10 cells/second a six-hour reel's map is ~400 KB — RAM-resident even for streamed reels, so wear works on a hundred-track playlist.

**Implementation notes.**
- **Determinism is mandatory for the golden files**: defect placement and dropout draws come from an LCG seeded per reel. Same reel, same WEAR, same duration → identical output.
- Persistence question, decided the honest way: wear saves with the session (`.tl1`), so a loop you have played for a year *is* worn. A "new pass" (reload the reel) starts fresh. Erasing/recording over a region heals it — new oxide.
- Freeze interaction (see map): wear accrues under the grains, slowly.

**Tests.** Golden: fixed loop, WEAR high, rendered for N passes → committed output; re-render must be bit-identical (proves determinism). Regression: WEAR 0 output bit-identical to pre-feature engine; wear map survives a window swap (reel coordinates make this automatic — assert it).

---

## 9. Splice angle

**What it is.** Real splices were cut at 45° on a splicing block precisely so the joint would *crossfade* instead of thunk — the angled cut means the two tapes share the head for a moment. Our loop point is a hard butt-joint.

**Design.** Per-deck **CUT** setting, screen: straight (hard cut, current behaviour, default) through long diagonal (~100 ms crossfade across the splice). Implementation is a short equal-power crossfade between splice-end and splice-start material at the wrap. Named in razor-blade vocabulary because that is literally what it is.

**Where it lives.** The splice-wrap read in `Deck`, using `ReelView` for the pre-splice-start samples. Note the crossfade needs material from *before* the splice start — bounded by the window guard; clamp the maximum angle to the guard length on streamed reels.

**Interactions.** Ping-pong never crosses the joint — angle inert. Splice pop and angle compose: angle chooses smooth, pop chooses honest; both on = a soft thump inside a crossfade, which is what a real angled splice with a proud adhesive edge sounds like.

**Tests.** Golden: sine loop with mismatched splice endpoints at straight vs full angle — hard discontinuity in the first, none in the second. Regression: angle at splice near reel start (guard clamp path).

---

## 10. Multiple play heads

**What it is.** The head-gap echo (§2) is an Echoplex — one gap. The Space Echo's identity is *three* play heads at different distances, selectable in combinations, giving rhythmic multi-tap patterns that all stretch together when the transport slows — the multi-head sound.

**Design.** Extends §2, does not exist without it. **HEADS 1·2·3** on the deck page: head 1 is §2's gap; heads 2 and 3 sit at fixed musical multiples (×1.5, ×2.33 of the gap — deliberately non-integer, per the RE-201). Combination select (1 / 2 / 3 / 1+2 / 1+3 / 2+3 / 1+2+3). Each head is one more `ReelView` read plus a gain — nearly free once §2's offset machinery exists. All taps share the write head, so decay remains the single feedback control for the whole pattern.

**Naming collision, resolved before it bites:** the panel's HEADS switch (LINK/STEREO/SPLIT) already owns that word. The multi-tap select is **TAPS** in code and on screen. Do not ship two controls called HEADS.

**Tests.** Golden: impulse at 1+2+3, verify three echo trains at the expected spacings, then at 0.5× verify all spacings double together — the property that makes it tape rather than a delay pedal.

---

## 11. Brake

**What it is.** The tape-stop gesture as a *performable control*: a momentary that ramps the transport to zero with exaggerated inertia, and releases back up the same way. The machine's most characteristic move currently exists only as a knob drag.

**Design.** Momentary **BRAKE** per deck. One setting: firmness — ~150 ms (hard stop) to ~2.5 s (power-cut spin-down), default ~400 ms. Implementation is a temporary override of the transport slew constant toward a zero target; release restores the knob's rate through the same curve. Pitch falls with speed because it must; head loss darkens on the way down because it already tracks speed. Zero new DSP — brake is *only* a slew gesture.

**Interactions.** Brake into FREEZE is the machine's signature combo: spin down, then hold the bottom as a drone — the transport dies and the heads keep spinning. Brake while braking re-triggers cleanly (idempotent target). Under freeze, brake is inert (nothing to stop).

**Panel note.** This is the one entry in this document with a legitimate claim to a *physical* momentary control eventually — a gesture wants a button under a finger, and spring-loaded scrub already establishes the momentary vocabulary on the transport row. Harness proves it on screen first; the panel argument happens with hands on the layout, per doctrine.

**Tests.** Golden: tone at 1×, brake engaged for 1 s at default firmness — committed spin-down curve. Regression: brake + reverse; brake during scrub; release-before-stopped resumes without discontinuity.

---

## 12. VOX arm + take-defines-the-splice — stolen from *reels*

**Provenance.** *reels* (2019) is @its_your_bedtime's norns tape script — Bedtime Company, the people who became the tape! Kickstarter. It is the closest competitor's public DNA, and two of its workflow decisions are better than ours. Source: llllllll.co/t/reels. Captured excerpts below are from that script (for study; our implementations are original).

### 12a. VOX — threshold-armed recording

Arm the deck, and recording *starts itself* when the input crosses a level. Dictaphone VOX, period-correct, and exactly right for a field recorder you set on a stump and walk away from.

Their whole implementation:

```lua
reels.threshold = function(val)
  if (in_l >= val / 1.5 or in_r >= val / 1.5) then
    return true
  ...
end
-- polled per frame while armed:
if ((reels.threshold(reel.rec.threshold) and reel.rec.arm) and playing) then
  reel.rec.arm = false
  reels.rec(tr, true)
end
```

**TL-1 design.** A THRESHOLD setting on the deck screen page (off … level). When armed with a threshold set, REC blinks "waiting" and drops in on the first crossing. Composes with §1: threshold + REPLACE = signal-activated punch-in. Composes with the pre-record ring (`CAPABILITIES.md`): the take should include the ~1 s *before* the crossing — the attack that tripped it — which their version cannot do and ours gets free from the input ring.

**Tests.** Regression: armed deck + silence → nothing writes; tone burst → take begins within one block and includes pre-roll; threshold 0 = current immediate-REC behaviour, bit-identical.

### 12b. The take defines the splice

On record-stop, their loop points snap to what was just recorded — the phrase *is* the loop, no slider fiddling:

```lua
reel.loop.s[tr] = reel.rec.start - offset
reel.loop.e[tr] = reel.rec.time - offset
if reel.playback.reverse then          -- recorded backwards: swap ends
  reel.loop.s[tr] = reel.rec.time - offset
  reel.loop.e[tr] = reel.rec.start - offset
end
reels.set_loop(tr, reel.loop.s[tr], reel.loop.e[tr])
```

Note the reversed-transport case — they thought about recording backwards. So must we.

**TL-1 design.** When a take ends on a deck whose splice was the whole reel (i.e. the user had not chosen a loop), the splice snaps to `[take start, take end]` and the deck keeps rolling inside it. If the user *had* set a splice, respect it — their intent wins. Under the reel model this is one rule: **a take on virgin tape becomes the splice; a take inside a splice stays inside it.** Pairs with recording-creates-a-reel (`REEL.md`): record onto nothing, and reel, splice, and loop all come into existence together, already right.

**Tests.** Golden: record 2 s onto blank, stop → splice equals take bounds, loop plays the phrase. Regression: reversed-transport take → bounds swapped; take inside an existing splice → splice untouched.

### 12c. Two numbers worth arguing with (harness decisions, not features)

Captured because they encode feel, and ours differ:

```lua
local n = math.pow(2, reel.playback.speed)   -- exponential SPEED taper
softcut.rate_slew_time(i, 0.5)               -- half-second transport glide
```

- **Taper**: their speed control is exponential — equal knob travel is equal *pitch interval*. Ours is linear in rate. Now that FREEZE makes SPEED a drone-pitch control, this is a real decision: linear rate is honest to tape; exponential is honest to ears. Decide in the harness, with hands.
- **Slew**: their transport takes 0.5 s to reach a new speed; ours takes 35 ms. Theirs is dreamier, ours more mechanical. Transport inertia is a *character* parameter — A/B both, and consider whether BRAKE firmness (§11) and this constant are the same knob.

### 12d. One anti-pattern, recorded so nobody re-invents it forwards

```lua
softcut.rate(i, n[i] + ui.reel.left[i].position / 10)  -- UI reel angle → audio rate
```

Their flutter modulates audio rate from the *drawn reel's animation angle* — you hear what you see because they are the same variable. Charming, and wrong: it ties audio to a 60 Hz screen metro. Our direction of dependency (LFO phase derived from the playhead; screen draws what the engine reports) gets the same coherence without the coupling. Keep it that way.

---

## 13. Feedback routing — the wildness lever

**Why it exists.** `PROJECT.md` doctrine says the machine lets you go wild. Right now the signal path is strictly forward — decks → mix → effects → out — and forward-only paths cannot run away. Every genuinely unruly instrument (Lyra-8, Pulsar-23, a Space Echo pushed past unity, two tape machines patched to each other) is unruly because it has loops in it. This is the cheapest large increase in what the machine can do, and it is entirely tape-honest: patching a machine's output back to its own input is what people did the moment they owned two of them.

**Design.** A routing page, three switchable paths, all default **off**:

- **OUT → REC.** Master output back into the armed deck's record head. With the erase coefficient this is a self-building runaway steered by the decay knob — the classic two-machine trick, in one box.
- **A → B / B → A.** One deck's output into the other's input, so a deck can record the other while both play at different speeds. Both directions at once is a legal, deliberately dangerous setting.
- **Head-gap regeneration above unity** (needs §2). Repeats that build instead of decay.

**Doctrine compliance.** No new panel controls (routing page on screen), everything off by default so the machine is unchanged until asked, and every path describes something a tape machine physically does.

**Implementation notes.**
- Feedback lives in `Machine`, never in `Deck` — a deck must not know the other deck exists. `Machine` owns the routing matrix and hands each deck its input.
- One block of delay in every loop is unavoidable and correct; do not try to make it zero.
- DC is the real enemy in a runaway, not level: put a DC blocker in every feedback path. A drifting offset is what turns a scream into a dead output.
- The output limiter is on the speaker and headphone outs only. The line out and the bounce path stay unlimited — a recording of a runaway should be an honest recording of a runaway.

**Tests.** Bounded-output suite, and note what it asserts: with every path enabled, resonance at maximum, decay at hold, gap regeneration above unity, run 60 seconds — assert **finite, no NaN, no DC drift, and full recovery when the paths are switched off**. It must not assert that the output stays quiet. Loud is the feature; unbounded is the bug.

---

## Interaction map

Features that touch each other, so agents don't build them in isolation:

- Punch ⇄ Monitoring: rehearse is a monitoring state; build together.
- Punch ⇄ Head gap: gap + REPLACE = slapback re-recorder; test the pair.
- Head gap ⇄ Window policy: pinned-splice size must include the gap.
- Ping-pong ⇄ Splice pop: pop never fires in ping-pong (no crossing).
- Everything ⇄ Freeze: freeze holds the transport; punch/gap/pop/brake are transport behaviours and must be inert while frozen — with one deliberate exception: **wear accrues under a frozen drone** (the grains are passes), which is the Basinski behaviour and is wanted. Add one regression case: engage each feature, freeze, verify the feature is inert and the drone healthy.
- Wear ⇄ Record: recording over a region heals its wear cells — new oxide. Punch-REPLACE therefore repairs tape; LAYER does not.
- Wear ⇄ Streaming: the condition map is RAM metadata keyed by reel position, so wear works on streamed reels and survives window swaps.
- Splice angle ⇄ Window guard: maximum angle clamps to the guard length on streamed reels.
- Multi-head ⇄ Head gap: §10 does not exist without §2; build in that order. Decay stays the only feedback control for the whole tap pattern.
- Feedback ⇄ everything: §13 multiplies the runaway potential of resonance, decay, and head-gap regeneration. Each of those gets its own bounded test, and one combined test with all of them at once.
- Brake ⇄ Freeze: brake-then-freeze is the signature combo (spin down, hold the bottom as a drone); build the transition clickless.
- VOX ⇄ Punch: threshold + REPLACE = signal-activated punch-in; threshold + pre-roll ring means the take keeps the attack that tripped it.
- Take-defines-splice ⇄ Recording-creates-a-reel: one gesture — record onto nothing and reel, splice, and loop appear together, already right.

## Doctrine checks before merging any of these

- Zero new panel controls (everything here is a screen setting on the deck page, one level deep).
- Defaults leave the machine sounding exactly as it does today — every feature silent until asked.
- AGE 0 golden file unchanged except where a feature explicitly claims otherwise (head bump).
- The sentence still holds: *a modern tape recorder with two decks.* Every feature above is something a tape machine did. Keep it that way.
