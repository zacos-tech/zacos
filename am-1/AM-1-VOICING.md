# AM-1 — the voicing pass

Goal: dial in "the sound" of the AM-1 on purpose. Every number below
shapes the machine's voice; each is either **RATIFIED** (chosen or
confirmed by Daniel's ear) or **DEFAULT** (my initial value, never
audited). The pass converts defaults into decisions, one short session
at a time, before the Daisy port inherits the numbers.

Method (the CP3 loop): name the feeling in words → find its physics →
adjust the CAL constant → measure where measurable → ratify by ear →
file. Sessions stay short — 30–45 minutes, fresh ears beat marathon
ears (voicing wisdom as old as piano factories). Use the factory bank
as the listening fixtures: same patches every session, so changes are
audible against a known room.

## The north star — RATIFIED before the pass began

**"I will definitely prefer something that sounds vintage."** — Daniel

That sentence pre-answers half the checklist. Working translation, per
subsystem, as priors the sessions start from (each still ratified by ear):
voices → MORE drift and looser humanize (old oscillators wandered; try
driftCents 6–8), slower warmer detune beats; envelopes → slight attack
rounding (analog contours never snapped to zero); filter/colors → err
darker; the room → darker damp, spring and dark IRs favored, echoes that
age like tape repeats; drive → done (the CP3 bias IS this preference,
measured); dynamics → gentler compression, more breathing. The era
anchor: mid-70s to early-80s analog-and-tape — the machine should sound
like it was *recorded in 1977*, not like it's imitating 1977.

The one boundary: **vintage tone, modern discipline.** The blur lives in
the voices, never the clock — old Moog sequencers were rock-tight, and
the interlock depends on it. Warm the sound; never smear the time.

Open vintage question for the pass (a real decision, not a default): a
faint optional noise floor — the "air" of old gear — is the most
authentic vintage move available and also the easiest to overdo. Session
7 material.

## Session 1 — the voices
- [ ] CAL.voice.sawDetune 1.006 — DEFAULT. The twin-saw beat rate.
- [ ] CAL.voice.driftCents 4 — DEFAULT. The analog blur. More = older.
- [ ] CAL.voice.humBase/.humSpan 0.92/0.16 — DEFAULT. Velocity life.
- [ ] glass recipe (f + 2.004f + 3f, mix) — RATIFIED (re-voiced by ear).
- [ ] bell recipe (ratio 3.01, hit 3.2 → tail 0.45) — RATIFIED.
- [ ] pluck damping (base 900 + span 5000, fb 0.88+0.115) — RATIFIED-ish;
      audit the extremes of SHAPE.
- [ ] envelope law (shape → attack/duration mapping) — DEFAULT. The
      machine's touch. Where does "plucky" end and "pad" begin?

## Session 2 — filter + resonance
- [ ] cutHz curve 16Hz–19.5kHz — RATIFIED (his report drove the recal).
- [ ] filter Q law 0.4 + reso·11 — DEFAULT. Where does it sing vs squeal?
- [ ] ROLE_COLOR 1300/4500/9000 — RATIFIED-ish (lifted after his report);
      audit per-voice.

## Session 3 — drive (mostly done)
- [x] taper 1.5 / span 7 / comp 1.3 — RATIFIED ("above about 15").
- [x] CP3 bias 0.24 — RATIFIED ("wow, I love it").
- [ ] dcBlock 12Hz — DEFAULT (should be inaudible; confirm on sub bass).

## Session 4 — feedback
- [ ] fb taper 1.6 / max 1.15 (unity ≈92) — RATIFIED-ish (the scream
      landed); audit the ring zone 60–90 musicality.
- [ ] fb root register (MIDI 36+key) — DEFAULT. Does the howl sit right
      in every key, or want an octave choice?

## Session 5 — drone
- [x] register map (root 32Hz / fifth / high; sine +12) — RATIFIED
      (his ear caught both defects).
- [ ] CAL.drone.lvl 0.5, lp 420, detune 1.004 — DEFAULT. The beat rate
      and the darkness of the pedal.

## Session 6 — the room (delay + verb)
- [ ] IR recipes (hall/plate/spring/dark exponents) — DEFAULT. The
      four rooms' personalities. Biggest unaudited surface on the machine.
- [ ] dly damp 3200 — DEFAULT. How dark echoes age.
- [ ] ping-pong weights / dsum 0.6 — DEFAULT (topology RATIFIED by review).

## Session 7 — motion + bus
- [ ] mod swings (cutSwing 60, driveSwing 0.8, levelSwing 0.8,
      pitchSpan 0.7, shapeSpan 50) — DEFAULT. How far the tides reach.
- [ ] PART_PAN + bass centering — DEFAULT. The stereo stage.
- [ ] comp −14dB/4:1 — DEFAULT. The safety floor's audibility.
- [ ] master vol taper ^1.4 — DEFAULT.

## Rules of the pass
1. One subsystem per session; never voice tired.
2. A/B against the previous value every time — CAL makes flipping free.
3. Adjectives first, numbers second. "Older," "closer," "meaner" are
   valid engineering specifications on this project.
4. Every ratified value gets its date. The CAL table is the machine's
   voice; this file is its provenance.
5. When the pass is complete, the Daisy port's acceptance test is:
   does the steel hit these targets, by the same ears?
