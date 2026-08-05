# FL-1 — Operator catalogue

Working reference for the Film Lab effect rack. Eight families, ~80 operators.

Operators are the modules. Recipes are chains of operators. "Super 8" is not an
operator — it's seven operators in a specific order, which is why the rack
architecture matters more than the operator count.

**Cost** is a rough GPU pass budget: `1` = one full-screen pass, `2+` = needs
multiple passes or a temporal buffer. Assume a ceiling around 8–10 passes at
1080p on a Pi-class GPU.

**Source** is where the implementation comes from:
- `own` — write it, it's small
- `ntsc-rs` — port from the Apache-2.0 crates
- `libretro` — adapt from slang/GLSL shaders (GPL, per-file check)
- `LUT` — data, not code
- `avfilter` — FFmpeg LGPL reference implementation to port from

---

## 1 · Tone & colour — the film styles

The whole family reduces to one operator plus data. Build the sampler once,
then every film stock ever made is a file on the card.

| Operator | What it does | Key params | Source | Cost |
|---|---|---|---|---|
| LUT | 3D lookup, `.cube` and HaldCLUT PNG | file, mix, extrapolate past 100% | own | 1 |
| CURVE | Per-channel tone curve | RGB + master, control points | own | 1 |
| SPLIT TONE | Separate hue shift for shadows / highlights | 2× hue, 2× strength, pivot | own | 1 |
| BLEACH | Bleach bypass — desaturate, crush, raise contrast | amount, pivot | own | 1 |
| CROSS | Cross-process — channel curve inversion in shadows | amount, channel bias | own | 1 |
| TEMP | White balance shift | kelvin, tint | own | 1 |
| VIBRANCE | Saturation weighted away from skin tones | amount (to 400%) | own | 1 |
| CHANNEL MIX | Arbitrary 3×3 matrix on RGB | 9 coefficients | own | 1 |
| DUOTONE | Map luminance to a two-colour ramp | 2 colours, pivot | own | 1 |
| FALSE COLOUR | Map luminance bands to discrete colours — IR / thermal | palette, band count | own | 1 |
| INVERT | Negative, per channel | R/G/B toggles | own | 1 |
| POSTERIZE | Hard tone quantisation, per channel | levels | own | 1 |

Ship the FL-1 with a handful of neutral LUTs. Everything else the user loads.
Free packs exist by the hundred (Pat David's collection is CC BY-SA 4.0) — but
don't put trademarked stock names on the panel.

---

## 2 · Film medium

Real film character is six or seven cheap operators stacked. Individually they
look like nothing; together they're unmistakable.

| Operator | What it does | Key params | Source | Cost |
|---|---|---|---|---|
| GRAIN | Luminance-dependent grain — heaviest in midtones, absent in highlights | size, strength, softness, colour/mono | own | 1 |
| HALATION | Highlights bloom red-orange into surroundings | threshold, radius, tint, strength | own | 2 |
| DIFFUSION | Pro-mist / soft-focus glow, highlight-weighted | radius, strength, threshold | own | 2 |
| GATE WEAVE | Whole frame drifts on x/y as the gate wanders | amplitude, rate, smoothness | own | 1 |
| FLICKER | Exposure varies frame to frame | depth, rate, randomness | own | 1 |
| DUST | Specks and hairs, one or two frames each | density, size, dark/light mix | own | 1 |
| SCRATCH | Vertical tramlines that persist and drift | count, width, depth, drift rate | own | 1 |
| LIGHT LEAK | Edge fogging that blooms and fades | edge, colour, rate, strength | own | 1 |
| GATE EDGE | Soft frame border, rounded corners, visible gate | softness, corner radius, inset | own | 1 |
| JUDDER | 24→30 pulldown cadence, or 18fps Super 8 | source rate, cadence pattern | own | 2 |
| REG SHIFT | Per-channel registration error — colour fringing at the edges | per-channel x/y, growth to edge | own | 1 |

**Super 8** is: JUDDER at 18fps → GRAIN heavy → REG SHIFT → GATE WEAVE →
HALATION → warm LUT → GATE EDGE → vignette. Eight passes, and it's the single
most recognisable recipe in the catalogue.

---

## 3 · Video medium — composite, VHS, CRT, broadcast

This is the deepest family and the one with the best existing code. `ntsc-rs`
models the actual NTSC/VHS signal path rather than faking the look, and it's
Apache-2.0. Port its stages as individual operators so they can be used apart
from each other and pushed past their sane ranges.

| Operator | What it does | Key params | Source | Cost |
|---|---|---|---|---|
| COMPOSITE | Encode to composite and back — the parent of most of this family | bandwidth, generation count | ntsc-rs | 2+ |
| CHROMA BW | Chroma bandwidth limiting — colour smears horizontally | bandwidth, passes | ntsc-rs | 1 |
| CHROMA DELAY | Chroma lags luma — colour offset right of edges | delay | ntsc-rs | 1 |
| DOT CRAWL | Luma/chroma crosstalk crawling along edges | strength, phase rate | ntsc-rs | 1 |
| RAINBOW | Cross-colour — fine detail turns into colour banding | strength, detail threshold | ntsc-rs | 1 |
| RINGING | Luma sharpening overshoot — bright edge halos | amount, frequency | ntsc-rs | 1 |
| TAPE NOISE | Luma and chroma noise with tape character | luma, chroma, snow | ntsc-rs | 1 |
| DROPOUT | White horizontal streaks where oxide is missing | rate, length, brightness | ntsc-rs | 1 |
| HEAD SWITCH | Torn, offset band at the bottom of the frame | height, offset, noise | ntsc-rs | 1 |
| TRACKING | Tracking error — bands roll and shear vertically | position, width, severity | own | 1 |
| TBC WOBBLE | Timebase error — lines shift horizontally at random | amplitude, correlation | own | 1 |
| VSYNC ROLL | Frame rolls vertically, tearing at the seam | rate, hold, tear noise | own | 1 |
| GHOST | Multipath ghosting — offset semi-transparent copy | offset, strength, count | own | 1 |
| INTERLACE | Split into fields, offset in time | mode, field order | own | 2 |
| FIELD BLEND | Deinterlace artifacts — combing or blended fields | mode | own | 1 |
| GENERATION | Re-run the whole composite chain N times — tape dubs | count | ntsc-rs | 2+ |
| SCANLINE | Alternating line darkening | depth, thickness, offset | libretro | 1 |
| PHOSPHOR | Aperture grille / shadow mask / slot mask | mask type, pitch, strength | libretro | 1 |
| CRT BLOOM | Highlights blow out and spread, phosphor-style | threshold, radius | libretro | 2 |
| CRT GEOM | Screen curvature, corner falloff, overscan | curvature, corner size, overscan | libretro | 1 |
| DEGAUSS | Colour purity wobble sweeping across the frame | strength, rate | own | 1 |

**VHS (EP mode)** = COMPOSITE → CHROMA BW hard → CHROMA DELAY → TAPE NOISE →
DROPOUT → HEAD SWITCH → GENERATION ×3.
**Broadcast CRT** = COMPOSITE → DOT CRAWL → RINGING → SCANLINE → PHOSPHOR →
CRT GEOM → CRT BLOOM.

---

## 4 · Digital medium

The failure modes of the format the FL-1 actually writes.

| Operator | What it does | Key params | Source | Cost |
|---|---|---|---|---|
| QUANTISE | Reduce tonal levels per channel | levels, per-channel | own | 1 |
| DITHER | Ordered Bayer, blue noise, or Floyd–Steinberg | pattern, matrix size, strength | own | 1 |
| PALETTE | Map to an N-colour palette, loadable from card | palette file, match mode | own | 1 |
| BIT CRUSH | Drop low bits — banding and false colour | bits per channel | own | 1 |
| SUBSAMPLE | Visible 4:2:0 / 4:1:1 chroma blocks | mode, block size | own | 1 |
| DCT | JPEG block artifacts without re-encoding | quality, block size | own | 2 |
| PIXELATE | Nearest-neighbour downsample and back | block size, shape | own | 1 |
| LCD GRID | RGB subpixel stripe or Bayer grid, backlight bleed | pitch, gap, bleed | libretro | 1 |
| HALFTONE | Rotated dot screen per channel | dot size, angle per channel | own | 1 |
| ASCII | Map luminance blocks to glyphs | charset, cell size, colour mode | own | 1 |

---

## 5 · Geometry & optics

Everything that moves pixels rather than recolouring them. Cheap, and where the
extreme ranges pay off most.

| Operator | What it does | Key params | Source | Cost |
|---|---|---|---|---|
| WAVE | Sine displacement on x, y, or both | amplitude, frequency, phase rate, axis | own | 1 |
| RIPPLE | Radial waves from a movable centre | centre, amplitude, wavelength, decay | own | 1 |
| TWIRL | Rotation falling off with radius | centre, angle, radius | own | 1 |
| KALEIDOSCOPE | N-fold radial mirror | segments (2–64), rotation, centre, offset | own | 1 |
| MIRROR | Axis mirroring — H, V, quad | axis, pivot | own | 1 |
| TILE | Repeat the frame in a grid, with optional flipping | count x/y, flip mode, offset | own | 1 |
| POLAR | Rectangular ↔ polar, or log-polar | mode, centre, scale | own | 1 |
| BARREL | Barrel / pincushion distortion | k1, k2, centre | own | 1 |
| FISHEYE | Strong barrel with circular crop | strength, crop, edge softness | own | 1 |
| ANAMORPHIC | Horizontal squeeze plus horizontal streak on highlights | squeeze, streak length, tint | own | 2 |
| ABERRATION | Per-channel radial scaling, strongest at the corners | strength, per-channel bias | own | 1 |
| VIGNETTE | Corner falloff, optionally shaped | strength, radius, roundness, feather | own | 1 |
| TILT SHIFT | Depth-of-field blur outside a movable band | band position, width, angle, blur | own | 2 |
| BOKEH | Shaped highlight blur — hexagonal, circular, cat's-eye | radius, blades, highlight threshold | own | 2 |
| PERSPECTIVE | Free four-corner warp | 4 corner points | own | 1 |
| SLIT SCAN | One column or row per moment — time on a spatial axis | axis, span, direction | own | 2+ |
| ROLLING | Exaggerated rolling shutter skew | rate, direction, severity | own | 2 |
| DISPLACE | Displace by a map — luminance, gradient, or loaded image | map source, x/y scale | own | 1 |

---

## 6 · Corruption

The glitch family from the harness, plus what the sensor tap adds.

| Operator | What it does | Key params | Source | Cost |
|---|---|---|---|---|
| SORT | Pixel sort along rows or columns within a threshold mask | key, lo/hi threshold, run, axis | own | 2 |
| BLOCK | Displace blocks from elsewhere in the frame | size, count, offset range | own | 1 |
| SLICE | Horizontal band shifting — sync loss | bands, height, offset | own | 1 |
| SHIFT | RGB channel displacement | amount, angle, per-channel | own | 1 |
| DRIFT | Pixels smear in the direction of a gradient | strength, direction source | own | 1 |
| MOSH | Hold a frame, apply subsequent motion vectors to it | hold length, vector strength | own | 2+ |
| CORRUPT | Byte corruption of the encoded file, at capture only | flips, quality, validate retry | own | — |
| CFA | Demosaic with the wrong Bayer pattern — raw tap only | pattern, offset | own | 1 |
| BIT ROT | Rotate or shift bits in the raw values — raw tap only | shift, channel mask | own | 1 |

---

## 7 · Temporal

Everything needing more than the current frame. Each one costs a buffer.

| Operator | What it does | Key params | Source | Cost |
|---|---|---|---|---|
| ECHO | Blend previous output into current — trails | feedback, decay, tint per generation | own | 2 |
| FEEDBACK | Previous output as an input, with transform between | zoom, rotate, offset, mix | own | 2 |
| ACCUMULATE | Long-exposure light painting — max or add blending | mode, decay, reset | own | 2 |
| STUTTER | Hold frames — reduce effective frame rate | hold length, jitter | own | 2 |
| MOTION BLUR | Shutter-angle blur from accumulated subframes | angle, subframe count | own | 2+ |
| STROBE | Drop frames to black or hold | rate, duty cycle | own | 1 |
| TIME DISPLACE | Each region samples a different past frame, by a map | map source, depth, buffer length | own | 2+ |
| DIFFERENCE | Show only what changed between frames | threshold, amplify, decay | own | 2 |

---

## 8 · Structure

Not effects — the plumbing that makes the rest layerable.

| Operator | What it does |
|---|---|
| BRANCH | Split the chain into two paths |
| BLEND | Recombine two paths — add, multiply, screen, difference, overlay, min, max |
| MASK | Restrict the slots after it to a region — radial, linear, luminance range, edge detect |
| DEPTH | Per-slot wet/dry mix |
| GAIN | Scale the input to the next slot — how you push past sane ranges |

`MASK` is the quiet one that doubles everything. Pixel sort on the highlights
only, VHS artifacts confined to one corner, kaleidoscope on the centre with a
clean frame around it.

---

## Recipes

Named chains shipped on the card. These are the "filters" a user sees; each one
is a text file they can open and edit.

| Recipe | Chain |
|---|---|
| Super 8 | judder 18 → grain → reg shift → gate weave → halation → warm LUT → gate edge → vignette |
| 16mm | grain fine → halation → gate weave low → scratch → neutral LUT |
| VHS EP | composite → chroma bw → chroma delay → tape noise → dropout → head switch → generation ×3 |
| Camcorder | composite → chroma bw → ringing → tape noise low → interlace → field blend |
| Broadcast | composite → dot crawl → ringing → scanline → phosphor → crt geom → crt bloom |
| Security cam | pixelate → quantise → interlace → tape noise → false colour mono → timestamp overlay |
| Early digital | subsample → dct → quantise → bit crush |
| Game Boy | palette 4-colour → dither → lcd grid → pixelate |
| Xerox | posterize 2 → dither → dust → invert |
| Infrared | channel mix → false colour → halation → grain |
| Anamorphic | anamorphic → bokeh → aberration → vignette → cinematic LUT |
| Underwater | wave → ripple → chroma bw → cool LUT → vignette |
| Kaleidoscope | kaleidoscope 6 → polar → hue rotate → bloom |
| Melt | sort → drift → echo → shift |
| Full decay | slice → block → shift → sort → corrupt → generation ×5 |

---

## Notes on ranges

Every parameter's usable range is roughly the first fifth of its travel. The
rest is the product. Concretely:

- `KALEIDOSCOPE segments` to 64, not 8
- `HALATION strength` to 400%
- `CHROMA DELAY` to a full frame width
- `SORT run` longer than the frame
- `GENERATION count` to 20 — nobody has seen a 20th-generation dub
- `GRAIN size` to the point where a grain is 30 pixels across
- `WAVE amplitude` to half the frame

Anything that can be negative should be allowed to be negative.

---

## Build order

1. `LUT`, `GRAIN`, `VIGNETTE`, `CURVE` — the clean camera's look, needed anyway
2. The structure family — `BRANCH`, `BLEND`, `MASK`, `DEPTH`, `GAIN`
3. Geometry — cheapest per unit of visible result, and `WAVE` / `KALEIDOSCOPE`
   are the demo
4. Port `ntsc-rs` — biggest single jump in perceived quality
5. Film medium — `HALATION`, `GATE WEAVE`, `REG SHIFT` unlock Super 8 and 16mm
6. Corruption — already prototyped
7. Temporal — last, because each one costs a frame buffer and they're the
   easiest to get wrong on a battery budget
