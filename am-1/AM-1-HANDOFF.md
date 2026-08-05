# AM-1 "Arpeggio Machine" — project handoff

Briefing for an agent picking up the AM-1 with Daniel (director of engineering,
~20 yrs software, Rome GA; hands-on; calibrates by ear). The AM-1 is a machine
in his open-source ZACOS hardware line: ZAC · SM-1 Sleep Machine · TM-1 Tape
Machine · PM-1 Picture Machine · AM-1 Arpeggio Machine. All Machines, no Labs
(roster deliberately unified). Durable project memory lives at
/areas/synth-recorder-build.md.

## What it is

A three-part interlocking arpeggio instrument — "the Berlin school in one box."
Origin sentence (the whole thesis): *"why isn't there just a machine where I
can noodle with Berlin school music and arps layered."* Design center: latch a
chord or press a degree, three parts cycle against one clock at different
divisions, and the machine cannot play a wrong note — unless the scale is free.
It exists today as a complete browser instrument (`am-1-machine.html`,
single file, Web Audio, no dependencies) and is the line's designated **first
public software release** (funnel: AM-1 recruits → TM-1 keeps → PM-1 halo) and
the leading candidate for **first digital hardware build** (ahead of the TM-1:
smallest firmware surface, no screen/SD, pathfinder for the Daisy tier).

## Naming (settled)

"AM-1 · Arpeggio Machine." "ARP Machine" was rejected — ARP is an active
Korg-licensed synth trademark (even Behringer's 2600 clone avoided the
letters). "Arpeggio Machine" is generic words matching the house grammar
(every roster name is plain English + Machine); colloquial "arp machine"
arrives free and is never printed by us. Adjacent product: Tangible
Instruments "Arpeggio" (see Market). Run clearance at naming day.

## The instrument, as shipped in am-1-machine.html

- **3 PARTS** (PART I/II/III), each with:
  - ROLE: bass / arp / lead — a curated bundle (`ROLES`): register base
    36/48/60 + sub-oscillator on bass. Any ensemble legal (3 basses, etc.).
  - VOICE (five, closed): saw (twin detuned) / square / glass (sine stack
    f + 2.004f + 3f — the wine-glass rim) / bell (2-op FM, ratio 3.01, with
    a strike envelope — index f·3.2 decaying to f·0.45 over the note's
    front) / pluck (Karplus-Strong string: noise burst in a tuned damped
    loop; SHAPE = damping/ring, GLIDE retunes the string mid-ring).
    Curated characters, never editable engines.
  - PATTERN: up / down / updown / random / **seq** (the recorded sequence).
  - DIVISION: /1 /2 /3 /4 → 16/8/6/4 steps per bar. The interlock IS the
    product; /3 is the polyrhythm.
  - OCTAVES 1–4 (dice roll only 1–3), SHAPE (extreme by demand: 2ms→1.4s attack + 40ms→4.8s tail;
    knob splits at center — bottom half crisp→pluck, top half swell→cloud;
    gain auto-compensates as tails stack), LEVEL, on/off + activity LED.
- **Harmony**: 7 degree buttons (lowercase roman numerals; home row
  `asdfghj`) build triads from the scale — progressions are PERFORMED, never
  programmed (no chord sequencer, by design; the degree row is the
  instrument). Scales: minor, dorian, phrygian, major, harm minor, **free**
  (chromatic; snapping becomes identity; degree buttons go cluster — rails
  off everywhere is intended). KEY select; the **drone** follows the key
  tonic only (pedal point; glides 0.3s; never follows degrees — deliberate).
- **SEQ**: SEQ REC arms the keyboard; ≤16 steps incl. RESTs, scale-snapped
  at entry; loops on any part set to seq. **FOLLOW** = diatonic transpose of
  the sequence with degree presses (the Berlin sequencer-transpose; OFF by
  default to preserve the pedal-melody hybrid).
- **MASTER**: TEMPO **5–180** (below ~40 = "keeps time the way a lighthouse
  does"); SWING (odd 16ths toward triplet, one grid for all layers);
  **PITCH** — global bipolar ±12 st, continuous, software detent snaps
  |v|<0.45 to 0.0 (0 = key/scale as-is; all voices + drone follow; drone
  bends live; a played surface — integer=modulation, fractional=dark-ambient
  unease, ridden=the dive); **GLIDE** 0–350ms per-part portamento incl.
  across chord changes (kills the jump-cut); DRONE; DRIVE (gain-staged:
  input 1+(d^1.5)·7 into tanh, output 1/(1+1.3d) — taper tuned by Daniel's
  ear, "above 15" was hot); FEEDBACK — master loop, post-drive tapped back
    into the filter input via a 24ms delay, so the loop runs through
    cutoff/reso/drive and the scream is *played* (cutoff = howl pitch,
    tanh self-limits; unity ≈92 on the knob; ANOMALY rolls it ≤30; Lyra-8
    lineage); CUTOFF 16Hz–19.5kHz via one shared cutHz curve (knob, S&H
    tick, and audio-rate FM scaler all use it — true choke at 0, true open
    at 100); RESO; OUTPUT.
- **EFFECTS** (own panel section): tempo-synced **ping-pong delay** (1/8,
  dotted 1/8, 1/4; 13s delay lines so sync holds at 5 BPM; damped feedback
  loop; the delay FEEDS the reverb so echoes wash); **reverb TYPE** hall /
  plate / spring / dark — all procedurally synthesized IRs (plate =
  HP-differenced bright; spring = chirp-amplitude-modulated; dark = closing
  one-pole LP), SIZE 0.3–5.3s regenerates the IR, MIX.
- **MOD**: one LFO — tri/saw/sqr via a REAL OscillatorNode wired into the
  AudioParams (scalers → filt.frequency, driveIn.gain, verbWet.gain), rate
  **0.003Hz–180Hz** ("five-minute tides to filter FM, short of
  self-oscillation"); rnd = S&H on the 15ms control tick (≤~30Hz steps);
  target cutoff/shape/drive/verb (shape stays tick/note-rate). Construction
  order matters: mod nodes are built LAST in initAudio (a real bug taught
  this; the test suite now audits init order).
- **Tone pass** (the red-team's center of gravity, addressed): stereo part
  placement (`PART_PAN` = −0.06/−0.33/+0.33; bass pulled to ×0.2), per-osc
  drift (±4 cents, wandering over the note), humanized levels (±8%),
  per-role coloration (`ROLE_COLOR` LP: bass 1300 / arp 4500 / lead 9000).
- **PATCHES**: factory bank of 8 baked in (undeletable, deep-copied on
  load): the cathedral, the engine room, the bell garden, the catacombs,
  the head-nod, the process piece, the cluster field, "a familiar door,
  ajar" (the deniable Stranger Things wink — the default boot state must
  NEVER be that patch; sound legal, label isn't, a default is a label).
  Named save/load in localStorage `am1.patches` (f:/s: prefixes in the
  dropdown), delete (factory protected), export/import one-file-per-patch
  `AM1_name.json` (v:1 interchange format, 23 fields), copy/paste text kept
  for forum trading. serializePatch()/applyPatch(j) are the single
  serialization path — extend BOTH plus the load-refresh UI block for any
  new field, or ANOMALY/factory loads silently reset it (the glide bug).
- **Tools**: WAV bounce (ScriptProcessor tap on master → 16-bit stereo PCM,
  named after current patch); spacebar = run/stop (guarded against typing in
  inputs); T / tap button = tap tempo; **ANOMALY** (red ring — the family's
  one chaos control) rolls a complete legal patch within rails.
- **ANOMALY's tuned distributions** (all calibrated by Daniel's ear; these
  numbers ARE the eventual firmware): part 1 always bass; free scale, FM mod
  zone, and sub-10 tempo NEVER rolled (exits are chosen, not dealt); vol,
  pitch, seq, follow preserved; drive ri(0,16); drone present only 25%;
  glide rolls (50% zero); **deep rolls 18%** — tempo 10–35 coupled with
  shapes 65–100, big dark-leaning verb, high feedback, generous glide, slow
  mod (slowness only arrives dressed for it); **ensemble varies** —
  pick[3,3,3,2,2,1] parts on (trio/duet/solo), OFF parts still fully rolled
  (the "hidden member" feature).
- Boot: A minor, degree i latched, 112 BPM — RUN makes music in one press.

## Doctrines (enforce these in any port or feature)

1. **Appliance law**: no pages, no banks, no menus, no modes. Every
   capability lands on the one panel. Features enter as curated named
   characters (a seg row / a detent), never as parameter spaces.
2. **Rails by default, exits marked**: no-wrong-notes is the default, not a
   cage. The marked exits (free scale, FM mod rates, sub-musical tempo) are
   hand-only — ANOMALY never rolls them.
3. **Performance is the interface**: progressions performed on degrees;
   panel state = truth; hardware has NO patch memory — the panel is the
   patch (photograph to save; printed settings cards; the web app is the
   librarian/interchange tier). Endless-encoder recall was evaluated and
   refused for v1 (cost ≈ +$250–350 retail, pot-feel loss, the switch
   problem); door open only on demonstrated performer demand.
4. **Machines cooperate by listening, not protocol**: the TM-1 stays
   free-running (sync jack explicitly rejected by Daniel — "against the
   principles"); the AM-1 is the line's clock-bearer and may EMIT.
5. **Extremes are the SOMA law**: tempo 5–180, mod 0.003–180Hz, shape
   click-to-cloud. When a knob feels polite, widen it.
6. **Semantic red only**: red = ANOMALY ring + the FREE detent tick.
   Everything else monochrome + LED.

## Hardware plan (drafted, not started)

- **Form**: "Tonverk's body, Lyra's face, ZACOS's clothes" — a Tonverk-class
  slab ~360×200mm, ~46 physical controls, ZERO screens/pages. Seg rows →
  detented rotary switches; three identical part-strip PCBs (one layout ×3).
  Layout in `am-1-panel-sketch.svg`: reach-order bands — degrees + RUN at
  the near edge, MASTER/EFFECTS mid, part strips far; MOD/SEQ/KEY+SCALE +
  one-octave entry keyboard in the third band; chamfered data plate.
- **Construction/colorways** (`am-1-colorways.svg`, updated to Daniel's
  clarification): ONE continuous black chamfered steel body — the silhouette
  never changes; color = rubber panels INSET into the side faces behind
  visible steel margins, captive screws, slab a hair proud (bumper); full-
  color removable lid with the operation procedure printed inside and a
  molded pocket for settings cards. Six colorways (black/cream/olive/orange/
  red/blue), through-colored elastomer ~Shore 95A, aliphatic UV-stabilized;
  same sets dress the whole trio (one wardrobe, three machines). Chamfer =
  the brand shape (see `zacos-chamfer-sheet.svg`); it's honest to machining.
- **Ports**: PHONES · OUT L/R (¼") · MIDI IN + OUT (recessed TRS) · USB-C
  (power + firmware only) · internal speaker. NO sync, NO CV, no USB-audio.
  MIDI OUT ships DUMB and hardcoded: parts on ch 1/2/3, drone ch 4, clock +
  start/stop with RUN — no routing, no config, ever (the Tangible
  Arpeggio's scope-death began at "and also a MIDI hub"). OUT makes it an
  **arp controller** second life (vs Torso T-1/Oxi One: "cheaper than the
  brainless brains, and it sings"; OUTPUT knob = de-facto local-off).
  Identity guard: instrument first; controller is discovered, not marketed.
- **Electronics**: Daisy Seed. 50 controls via 3× CD74HC4067 muxes (3 ADC +
  4 shared select pins), rotary switches as resistor ladders on the same
  muxes, buttons on chained 74HC165 (3 pins), LEDs on 74HC595 (3 pins),
  MIDI UART ×2 — ~15 pins total. Scan loop outside the audio callback,
  one-pole smoothing per pot, hysteresis on ladder reads. Bench first step:
  one 4067 breakout + Alpha 9mm pots into the Daisy Pod (he owns the Pod).
- **Port realities**: music core is pure math — ports from the JS nearly
  line-for-line (bring the node tests as the verification suite);
  convolution reverb → algorithmic (Dattorro/FDN), four rooms re-voiced by
  ear; voice cap + stealing at cloud settings; 13s stereo delay fits Seed
  SDRAM; the ONE scope decision: the planned analog master filter/drive
  stage (lean: include — it's the buy-hardware reason and the first-analog
  lesson) vs all-digital v0 on the Pod first (also valid).
- **Lap law** (hard requirement, Daniel's words): the AM-1 must be
  playable on a lap. Consequences: weight ceiling <3kg governs steel
  gauge; inset rubber belly panel (grip, warmth, feet in one); generous
  front-bottom chamfer where wrists rest; speaker fires up/front, never
  down; every cable exits the rear; flat, never wedged. Mockup
  referendums happen on the couch, not the bench.
- **Case CAD**: `zacos-slab-case.scad` (parametric; `hollow` switch for a
  printable open-bottom shell) + `.stl` + preview PNG, at his given
  11.2 × 7.1 × 2.5 in (284.5 × 180.3 × 63.5mm — Tonverk-true, tighter
  than the 360×200 panel sketch; the density referendum is pending, and
  lap-span favors the smaller body). The inset construction makes wooden
  panels trivial (flat slabs, four holes): PANEL SET — WALNUT as the
  premium/heritage set ("rubber for the world, walnut for the den");
  publish the panel DXF so the community cuts its own materials.
- **Pricing**: $549 assembled / $399 kit (most kit-friendly machine in the
  line — all through-hole). Ladder: AM-1 549 → TM-1 850 → PM-1 995/1295.
  BOM ~$200–250 incl. ~$70–90 of pots/switches.

## Mythology (resolved this week)

The AM-1 entered product-first; its canon role is now the **beacon
machine** — the one that answers. Anchor: shortwave interval signals and
numbers stations (repeating melodic loops as station identity — the
Lincolnshire Poacher school). The TM-1 listens; the AM-1 calls. The rails
are beacon doctrine in-fiction (a signal that must be recognized cannot
err); the drone is the carrier; SEQ is the station's identification
phrase; the trio = shelter / listening / calling. The **number cipher** is
latent in the design, not bolted on: degrees are digits (REST = 0,
base-8, ≤16-digit strings), transposition-invariant (FOLLOW is cover),
decoded on the TM-1 by slowing tape and counting degrees — ties directly
into the existing ultrasonic-ARG canon. "a familiar door, ajar" = 1-3-5-7.
Offered, unbuilt: SEQ display as digits (a one-line change). Manual line:
*every pattern is a number.* The AM designation doubling as the radio band
is the kind of accident the canon keeps.

## Market map (researched; Daniel verifies claims — cite or check)

- Tangible Instruments **Arpeggio**: the one shipped arp-first synth —
  $379, Jan 2025 after ~a decade, monophonic VA, workstation-leaning (512
  banks, overlays). Validates demand; leaves the 3-layer lane open; its
  decade = the scope-creep cautionary tale.
- Moog **Subharmonicon** (the rhythm cousin: division interlock, but one
  voice/one filter, no chord interface) and **Labyrinth** (generative —
  the machine composes; AM-1 inverts: the player conducts). Moog can't
  build this: 3 voices + scale logic is cheap in code, brutal in analog.
- **Oxi One / Torso T-1**: superior pure sequencers, no sound, manual-heavy.
- **Digitone**: deeper per dollar, famous cliff — the AM-1 competes for its
  owner's tired hours and everyone the cliff filtered out.
- Moat (held through three adversarial passes): the interface philosophy.
  90 seconds to music; 10pm decompression is ~70% of real usage.

## Known issues / launch blockers (open)

1. **Background-tab throttling**: browser timers throttle when the tab
   hides → the scheduler stutters. Fix before the public link (longer
   lookahead when `document.hidden`, or AudioWorklet clock).
2. **Touch pass**: keyboard/segs not thumb-sized; the public link will be
   opened on phones.
3. **The verdict test** (pending, Daniel's): bounce a real 10-minute piece,
   A/B against a Subharmonicon recording with producer ears. Result = the
   Daisy port's tone agenda.
4. WebMIDI in/out for the harness: approved direction, not yet built.
5. Factory bank batch 2 should come from Daniel's own saved patches, not
   generated ones.

## Code map (am-1-machine.html, single file)

Sections in order: CSS → HTML (header w/ tap+anomaly+run · plate ·
kb/degrees/seq row · #layers grid · MASTER · EFFECTS · MOD · PATCHES ·
tools) → script: music constants (KEYS/SCALES/NUMERALS/ROLES/state) →
theory (scaleNotes, snapToScale, degreeChord, diatonicShift, buildPattern)
→ audio (initAudio — note construction order; makeIR(type); applyMaster;
applyDrone; mtof; ROLE_COLOR/PART_PAN/playNote) → mod (modHz, modTick,
applyModRouting) → clock (schedule/start/stop; swing offset in schedule) →
chord input (setChordFromDegree, toggleKbNote, seq handlers, keydown incl.
space/T guard) → layer UI (drawLayers/seg/slider) → master wiring →
tools (encodeWav, bounce, serializePatch, applyPatch, FACTORY, bank
functions, anomaly, tapTempo) → boot.
Testing convention: node smoke tests slice the script head at the
`/* audio */` marker, `new Function` it, and assert theory behavior
(degrees in-scale, snap identity in free, pattern shapes, 16/8/6/4,
seq transposition, factory patch validity, init construction order).
Keep this pattern; extend it for every engine change.

## Working with Daniel

Features survive by earning his hands, not the argument — a momentary
RATCHET fill gesture was tried and removed at his call (ratchets stay
out). He debugs and calibrates by ear and is usually right — treat reports like
"above about 15" as measurements. He overrules protectiveness in favor of
freedom (free scale, no sync) — execute gracefully, state trade-offs once.
He catches unverified claims — check market/product assertions before
stating them. Implement immediately, test in node, present the file, keep
the deadpan house voice (plate copy: "it cannot play a wrong note — unless
the scale is free"). No banks. No pages. No wrong notes.

## Files in this handoff

- `am-1-machine.html` — the instrument, current build (parses clean; boot
  = A minor i at 112). Single file, zero dependencies; open locally.
- `AM-1-HANDOFF.md` — this briefing.
- `am-1-panel-sketch.svg` — hardware panel layout in reach-order bands.
  Predates the FEEDBACK/PITCH/GLIDE knobs and the 284mm case decision —
  treat as layout grammar, not final art.
- `am-1-colorways.svg` — six inset panel sets on the constant black slab.
- `am-1-mockup.png` — 3/4 massing render, cream set, 284×180×63.5.
- `zacos-slab-case.scad` / `zacos-slab-case.stl` / `zacos-slab-preview.png`
  — parametric case CAD at his stated dimensions.
- `zacos-chamfer-sheet.svg` — the brand shape reference.
- `PM-1-HANDOFF.md` — the sibling machine's master briefing; line-level
  context and the full ZACOS artifact table.

Presets that exist only as pasteable JSON in conversation transcripts:
"root access", "first light", "black ice" — factory-batch-2 candidates
alongside whatever Daniel's own library produces.
