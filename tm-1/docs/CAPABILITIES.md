# TL-1 — Capability List

*Everything discussed so far, with what each thing needs to work.*
Status column: **✓** decided · **~** implied but unresolved · **✗** not yet designed

---

## 1. Sources — how sound gets in

| Capability | Requires | Status |
|---|---|---|
| Record from built-in stereo mic array | Nothing external. Two Primo EM272J omnis at the widest points of the body, ~200mm apart, shadowed by the enclosure | ✓ |
| Record from line level | 1/4" IN A / IN B (rear bay) | ✓ |
| Record two mono sources at once, at independent speeds | Both inputs. IN A feeds deck A, IN B feeds deck B | ✓ |
| Record a stereo pair from line | Both inputs plus HEADS set to STEREO | ✓ |
| Record from an instrument pickup | High-impedance setting on the line input | ~ |
| Record from external mics (incl. in-ear binaural) | Plug-in power switchable per jack, from a dedicated clean 5V bias rail | ✓ |
| Record internal mics and external sources **at the same time** | Second TAC5242 codec on a TDM slot — four simultaneous input channels | ✓ |
| Any input pair to any deck | Routing matrix on screen. Defaults need no configuration | ✓ |
| Play from SD card | Card in the media slot, FAT32, 16/24-bit WAV | ✓ |
| **Pre-record buffer** | Rolling 5–10s ring in RAM, always filling. Hit REC and you get the seconds *before* you pressed it | ✗ |
| Markers while recording | One button drops a cue point into the WAV. Makes a four-hour overnight file navigable | ✗ |
| Level-triggered record | Threshold + hold time, set on screen. Makes the leave-it-in-a-treeline use real | ✗ |
| Scheduled record | RTC is already fitted for dated filenames — start/stop windows come nearly free | ✗ |

**Input routing rule:** the jacks are labelled by deck, not by number. **IN A always feeds deck A, IN B always feeds deck B.** No configuration for the common case — plug one cable in and it goes to deck A; plug two and you have both. The SOURCE switch still picks the family (MIC / LINE / CARD), and the screen handles any override.

**Analog front end.** The Seed3's TAC5242 already provides low-noise programmable mic bias (5mA, enough for several capsules), accepts line *or* mic level single-ended or differential, and has 119dB of ADC dynamic range — so there is no gain knob and no discrete preamp. Set a conservative fixed gain and let headroom do the work.

| Detail | Requires | Status |
|---|---|---|
| Four simultaneous input channels | Second TAC5242, same part, TDM slot. Identical silicon means the two input pairs are sonically matched — which matters in STEREO mode | ✓ |
| Capsule bias | Codec VREF is 2.75V; EM272J specs 3–10V. Works, but a separate clean 5V rail buys back max-SPL headroom | ~ |
| Internal capsules run differential | Noise immunity against the switching regulator, LED driver and backlight inside a metal box | ✓ |
| Hi-Z instrument input | Switchable input impedance on IN A / IN B | ~ |
| **Record-path low cut** | Switchable ~80Hz HPF *before* the recorder. The per-deck FILTER is post-record, which is too late for wind rumble — the most common ruined take | ✗ |
| **Input limiter or dual-gain record** | Field peaks are unpredictable. 119dB of range only helps if nothing clips on the way in | ✗ |
| Wind treatment | Recessed acoustic cavity plus a fitted fur accessory | ~ |
| Capsule mounting | Rubber grommet isolation, or the metal body becomes a drum | ✓ |
| Acoustic port | Hydrophobic membrane for IP, recessed cavity, wind treatment accessory | ~ |
| No feedback howl | Monitor speakers mute when a deck is armed from mic. Headphones only while recording | ✓ |

## 2. Destinations — how sound gets out

| Capability | Requires | Status |
|---|---|---|
| Stereo line out | 1/4" OUT L / OUT R (rear bay) | ✓ |
| Two independent mono outs | Same jacks — deck A to OUT L, deck B to OUT R in SPLIT | ✓ |
| Headphones | 1/4" PHONES (rear bay) | ✓ |
| Built-in stereo monitoring | Two speakers flanking the screen, deck A left / deck B right | ✓ |
| Record to card | SD card, 24-bit WAV, header flushed every ~10s against power loss | ✓ |
| **Bounce the master to card** | Same operation, different tap point. Screen setting: `REC SOURCE: INPUT / MASTER` | ✓ |
| Bounce captures post-effects, pre-OUTPUT | So monitoring level never bleeds into the file | ✓ |
| Bounced takes land as numbered files, immediately loadable as reels | Closes the loop — bounce, reload, layer again | ✓ |

## 3. Tape engine — per deck

Each deck has its own complete strip: SPEED · LEVEL · FILTER · OFFSET, plus REC · PLAY · SCRUB.

| Capability | Requires | Status |
|---|---|---|
| Varispeed, −2× to +2× continuous | SPEED knob, or CV, or expression pedal | ✓ |
| Reverse playback | Negative rate — same knob past zero | ✓ |
| Tape stop / start inertia | ~35ms rate smoothing in the engine | ✓ |
| Scrub at 4× | Spring-loaded three-position toggle, returns to centre | ✓ |
| Loop with adjustable splice points | Splice in / splice length | ✓ |
| Fine speed offset in ppm | OFFSET knob per deck | ✓ |
| Bipolar filter (LP ← open → HP) | FILTER knob, centre-detented | ✓ |
| Deck level | LEVEL knob | ✓ |
| **Polarity invert** | One bit per deck, on screen. Without it the mid/side cancellation trick below cannot actually be performed | ✗ |
| Overdub / sound-on-sound | REC on the deck. `buf = buf * erase + in * rec` | ✓ |
| Decay control — from infinite hold to full replace | Set on screen per deck. 1.0 exactly reachable for true infinite sustain | ✓ |
| Ride the decay live | CV or expression pedal, decay as a destination | ✓ |
| Punch in / latch record | Hold REC to punch while held, double-tap to latch | ✓ |
| Record at varispeed — half speed in, normal out = octave up | Input resampled on the way in, plus **an anti-alias filter on the record path** | ✓ |

## 4. Deck topology — the HEADS switch

| Mode | What it does | Requires |
|---|---|---|
| **LINK** | Two playheads on one tape. Reich-style phasing; set OFFSET and they drift | One recording loaded |
| **STEREO** | Two decks locked as L and R. LEVEL becomes balance, FILTER becomes per-ear EQ, OFFSET becomes interaural time shift | Stereo source |
| **SPLIT** | Two independent tapes at independent lengths and speeds. Eno-style different-length loops, collage, layering | Two recordings |

**Mid/side decode** falls out of STEREO for free: invert one deck and sum, and everything centred cancels — leaving only what was off to the sides.

## 5. Master

| Capability | Requires | Status |
|---|---|---|
| **AGE** — one knob scaling the whole degradation complex: wow depth, flutter depth, hiss, dropout, saturation | AGE knob. Also a CV destination | ✓ |
| Delay (shared across decks) | DELAY knob | ✓ |
| Reverb (shared) | REVERB knob | ✓ |
| Output level | OUTPUT knob | ✓ |

## 6. Tape character

All of this is engine-side and needs no controls beyond what's listed.

| Capability | Requires | Status |
|---|---|---|
| Wow and flutter, deepening as speed drops | AGE knob sets depth; speed scaling stays automatic | ✓ |
| Tape hiss — one component pitch-shifting with the tape, one not | AGE knob | ✓ |
| Head-loss lowpass tracking transport speed | Automatic and **deliberately not under AGE** — this is what makes it sound like tape rather than damaged, so it's always on | ✓ |
| Saturation | Automatic — currently a memoryless `tanh` waveshaper | ~ |
| **Hysteresis** | Level- and frequency-dependent magnetisation *with memory*. This is the gap between the current engine and CHOW Tape — most of what people mean by "sounds like tape" | ✗ |
| **Modulation noise** | Noise that rides the signal rather than sitting under it. Present hiss is static; real tape's moves | ✗ |
| **Head bump** | Low-frequency lift from head-to-tape geometry, speed-dependent | ✗ |
| Print-through | Faint pre/post echo of loud passages. Pure character, cheap to fake | ✗ |
| Azimuth error | Head misalignment as a tiny frequency-dependent L/R phase shift. Would be genuinely interesting under STEREO | ✗ |
| Windowed-sinc interpolation, 512 phases × 16 taps | Automatic. 32.32 fixed-point position accumulator | ✓ |

## 7. Storage and tape length

| Capability | Requires | Status |
|---|---|---|
| LONG mode — 48k, ~11.3 min total / ~5.6 min per deck | Mode setting | ✓ |
| FINE mode — 96k, ~5.6 min total / ~2.8 min per deck. Cleaner extreme slowdown | Mode setting | ✓ |
| Play files longer than RAM | Sliding 8MB window streamed from card, ~87s resident | ✓ |
| Playlist as one spliced reel | Numbered files on card. Reverse, loop and speed all work across track boundaries | ✓ |
| Spooling to a position | Hold FF/REW — travel takes real time, and the travel covers the card reload | ✓ |
| Bouncing to build layers | Record decks A+B to card, reload as deck A, add a third part on B | ✓ |
| Generation loss across bounces | Automatic. Each pass accumulates AGE, wow and hiss the way real generations did | ✓ |
| Settings persistence | `settings.txt` on the card, or onboard QSPI flash | ~ |

## 8. Screen — views, not menus

One VIEW button cycles; the machine forces the right view where it can.

| View | Shows | Requires |
|---|---|---|
| Status | Both deck rows, filename, speed, position, drift readout | — |
| Waveform | Loop with both head markers. Set splice points by eye | Loaded tape |
| Reel | Whole file as a bar, loaded window lit inside it, playhead | Streaming playback |
| Spectrogram | FFT over time. **What makes the puzzle card solvable on the device rather than a laptop** | — |
| Levels | Peak meters with hold. Forced automatically when a deck is armed | — |
| CV setup | Amount and destination per CV input | — |

## 9. Modulation

| Capability | Requires | Status |
|---|---|---|
| Two assignable CV inputs | 1/4" CV 1 / CV 2 (rear), DC-coupled | ✓ |
| Destinations: speed A/B, filter A/B, delay, reverb | Set on screen | ✓ |
| Audio-rate modulation — FM of tape speed | Same jacks. Works because inputs are DC-coupled and don't care what you feed them | ✓ |
| Expression pedal on tape speed | 1/4" TRS EXP on the front edge, hardwired | ✓ |
| Any input accepts audio or CV | Same jack, no distinction | ✓ |

## 10. Lighting

| Capability | Requires | Status |
|---|---|---|
| All colour on the machine is LED-based; body is monochrome | RGB LEDs behind potted light-guide apertures and the button membrane | ✓ |
| User-configurable palette (red default; amber, green, blue, violet) | Setting | ✓ |
| Colour carries state — idle, playing, armed | Firmware | ✓ |
| Global brightness and auto-dim | 12-bit PWM driver with gamma correction. **Not WS2812** — they dim badly at the bottom | ✓ |
| Etched labels stay unlit | Physical. The machine stays readable with a dead battery | ✓ |

## 11. Power

| Capability | Requires | Status |
|---|---|---|
| User-replaceable battery tray | Sled on spring contacts, rear compartment | ✓ |
| 2 × 18650 — ~20 hrs recording / ~12 hrs active | Li-ion tray | ✓ |
| 4 × AA — NiMH ~9 hrs, lithium primary ~16 hrs recording | AA tray | ✓ |
| Wall / USB-C operation | Buck-boost accepts 4.0–8.4V and 5V USB from one converter | ✓ |
| Charging only when safe | Tray ID resistor — charger enabled for the Li-ion tray only | ✓ |
| Seamless source changeover | Ideal-diode ORing | ✓ |
| Survive a tray swap mid-recording | Supercap holds the rail long enough to close the WAV file | ✓ |
| Charge with the machine sealed | Port lives in the rear bay | ✓ |

## 12. Physical

| Capability | Requires | Status |
|---|---|---|
| IP-rated sealed enclosure | Gasketed rear bay under a drip lip, O-ringed pot shafts, membrane over buttons, Gore pressure vent | ✓ |
| Stainless, dark finish, laser-etched through to bright metal | Marks can't wear off; wear reveals rather than damages | ✓ |
| Detachable rubberised lid | Silicone or EPDM — never polyurethane soft-touch | ✓ |
| Operating procedure debossed into the lid | Moulded in. Also an audit: if the procedure doesn't fit, the machine is too complex | ✓ |
| Lid stows on the base while working | Doubles as a non-slip foot | ✓ |
| Machines stack on each other | Lid catch and the mating feature are the same interface | ~ |
| Weight ~2.4–2.5 kg | 316 stainless, 1.5mm shell / 3mm panel | ✓ |

## 13. Operational essentials

Unglamorous, and their absence is what makes a device feel unfinished in the field.

| Capability | Requires | Status |
|---|---|---|
| **Battery indicator** | Fuel gauge IC or ADC on the pack, shown persistently on screen | ✗ |
| **Panel lock** | One switch or a held combination. A knob-per-function machine in a bag arrives with SPEED at 1.7× | ✗ |
| Remaining card time | Free space ÷ current bit rate, shown while armed | ✗ |
| Clipping indication | Persistent, not just on the Levels view. Clipped input is unrecoverable | ✗ |
| Safe eject / write state | The card must never be pulled mid-write without warning | ✗ |

## 14. Story layer

| Capability | Requires | Status |
|---|---|---|
| Ships with an SD card of puzzles and clues | Card, and the analysis features above | ✓ |
| Each puzzle solvable only with a specific control | Design discipline — the card is the manual | ✓ |
| Solvable alone and offline | No wiki, no server, no community requirement | ✓ |
| Fiction lives on the lid and data plate, never on the controls | Panel doctrine | ✓ |

---

## Still open

### One design question

1. **The screen.** Moving from monochrome OLED to full colour changes the panel layout, the framebuffer budget and the power plan. Panel size and resolution are undecided, and the top-band proportions depend on it.

### Gaps that would undermine the two claims

*A device that calls itself a field recorder and a tape machine has to do these.*

**Field recorder side**
- **Pre-record buffer.** The machine is built for exactly the moment you can't ask to happen again. Without it you catch the second half of events. Nearly free — the RAM and the ring buffer already exist.
- **Record-path low cut.** Wind rumble ruins more takes than anything else, and the per-deck filter runs too late to help.
- **Input limiter or dual-gain record.**
- **Battery indicator, panel lock, remaining card time.**

**Tape machine side**
- **Hysteresis** in place of the memoryless waveshaper.
- **Modulation noise** — hiss that moves with the signal.
- **Head bump.**

**Already promised, not yet buildable**
- **Polarity invert.** The mid/side cancellation trick — invert one deck, sum, and everything centred disappears — was described as the deepest analysis feature on the machine. There is currently no invert control anywhere in the design.
- **Anti-alias filter on the record path.** Overdubbing below 1× folds everything above the new Nyquist into the recording. The read path is protected by the sinc window; the write path isn't protected by anything.

### Specified, still to build

- **TDM for the second codec.** Below libDaisy's abstractions — days of firmware work, not dollars.
- **Stacking interface.** Sketched, not designed.

### Component selection, not design

- Capsule bias — 2.75V from the codec works; a dedicated 5V rail buys back max-SPL headroom.
- Hi-Z switching on IN A / IN B for instrument pickups.
- Acoustic port geometry and wind treatment.

### Build order if you only do two

**Pre-record** and **polarity invert**. Both are small, both are things the machine already implicitly promised, and each closes one of the two claims.

## The rule that keeps this from becoming a menu

Four sources and two decks is a routing matrix, and a routing matrix is how a knob instrument quietly turns into a menu instrument. The defaults are physical and absolute:

**IN A → deck A · IN B → deck B · mic L → deck A · mic R → deck B**

The matrix exists on screen for people who want it. Nobody ever has to open it.
