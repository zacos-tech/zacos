# PM-1 "Picture Machine" — session handoff

Handoff for the next agent picking up Daniel's PM-1 project. Durable project
state also lives in memory at `/areas/synth-recorder-build.md` (near its size
cap — condense before large appends). Full session detail:
`/mnt/transcripts/2026-08-02-19-48-41-pm1-picture-machine.txt`.

## What this is

The PM-1 is a camera in Daniel's open-source ZACOS hardware line
(ZAC · SM-1 Sleep Machine · TL-1 Tape Lab · PM-1 Picture Machine). It shoots
stills (v1) and later video through an 87-operator glitch/film/video effect
rack, with effects live in the viewfinder — "what you frame is what you
commit." Business model matches the TL-1: free open-source browser version,
MIT engine shared with Crux Garden, open hardware, revenue from assembled
units. Boutique scale (~500 units = success).

## Artifacts (this folder)

| File | Status | Role |
|---|---|---|
| `pm-1-rack.html` | **CURRENT — the main artifact** | Browser prototype of the whole engine + UI. rev 0.5, 87 operators, 35 recipes. This is the source of truth for engine semantics. |
| `PM-1-HANDOFF.md` | current | This file. |
| `pm-1-cube-sketch.svg` | current | Cube face-map sketch, black cassette-futurism styling. |
| `pm-1-colorways.svg` | current | Six-panel colorway lineup (black/cream/olive/orange/red/blue on the black core). |
| `am-1-machine.html` | current — new machine | AM-1 Arpeggio Machine browser instrument: 3 assignable parts (bass/arp/lead roles), 5 curated voices (incl. Karplus-Strong pluck), master FEEDBACK loop, patterns incl. recorded seq + FOLLOW transpose, /1 /2 /3 /4 divisions, scale/degree system with free exit, swing, click-to-cloud SHAPE, drone, gain-staged drive, EFFECTS (synced delay + 4 procedural verb types), MOD LFO (0.003–12Hz), factory bank of 8 patches, named patch save/load + one-file .json export/import, WAV bounce, spacebar/tap-tempo, ANOMALY. Music core node-tested. |
| `am-1-panel-sketch.svg` | current | AM-1 hardware panel layout — Tonverk-class slab, 46 controls, reach-order bands, red only at the FREE detent. |
| `am-1-colorways.svg` | current | AM-1 colorway lineup — six cheek-and-lid sets on the black chamfered slab. |
| `FL-1-operator-catalogue.md` | reference, partially stale | Operator planning doc from the FL-1 era. Predates the 16-operator expansion, the PM-1 rename, and the three engine laws. Useful for the GPU pass-budget notes and source/licence mapping per operator; the HTML file supersedes it on behavior. |
| `fl-1-rack.html` | retired | Pre-rename snapshot of the rack. Superseded by pm-1-rack.html. |
| `pl-1-harness.html` | retired | First-generation harness. Has a known knob-rendering bug. Delete candidate. |

## The engine (inside pm-1-rack.html)

Single `<script>`; CPU canvas ops. Key structures: `OPS` (operator registry via
`op(key,label,family,params,fn)`), `RECIPES` (chains, optional third element =
modulators), `state.chain` of slots `{op,p,depth,on,mod}`, `runChain(d,w,h,t,live)`.

Engine laws — all extracted from Daniel's bug reports, enforce them in any port:

1. **Adaptive thresholds.** Luminance gates are percentiles of the actual
   image (`pctl(d,pct)`), never absolute values. Applied to SORT, HALATION,
   DIFFUSION, CCD SMEAR, SOLARIZE, luma MASK. "Knobs must react on any image
   regardless of exposure."
2. **Resolution independence.** 26 spatial params normalized to a 1000px
   reference via the `DIM` table (`px` scale / `pxr` scale+round / `freq`
   inverse). Deliberately pixel-native (exempt): DITHER, PALETTE, DCT, CFA,
   REACTION. "The viewfinder must predict the negative."
3. **Fixed display resolution.** The window always renders at
   `PREVIEW_RES=640`; the size dropdown is export-only ("developing…" flow
   renders fresh at full res through the same chain). Display and develop are
   separate pipelines.
4. **Layout stability.** Status readout has a reserved fixed-height row; busy
   text ("processing…") appears in a left-hand flag and never replaces the
   readout; the rack list animates (collapse/expand incl. border-width) so
   transitions never jump the layout.

Live mode (webcam): chain runs on the feed at 360px with per-frame seed
advance; GLIDE (param slew incl. DECAY), PERSIST (feedback buffer), focus aid
(peaking + peak-hold sharpness meter reads the clean frame).

Morph system: `startMorph()` builds an op-matched union — matched slots lerp
params, dying slots ramp depth→0 then are removed, entering slots ramp from 0;
smoothstep 1.2s; retarget-safe; recipes/ANOMALY/clear/load all morph; a
"settle" animator eases individual slider/DECAY changes; morph on/off toggle
in the Motion card. Slot list displays newest-at-top while chain processing
order is unchanged (numbers show true order; arrows follow visual direction).

Also in the file: 7-shape per-parameter modulators, loop renderer + scrub,
animated GIF export (custom LZW, validated pixel-exact against omggif),
CORRUPT (post-encode JPEG bit flips with decode-validation retry), .cube LUT
loader, image B for MOSH/PFRAME/BLEND/DISPLACE.

Testing convention: node smoke tests that extract functions from the HTML by
brace-matching (`grab(name)`), stub `document`, and assert behavior — see
transcript for the pattern. GIF encoder must stay validated against omggif.

## Hardware state (decided)

- **Body:** a CUBE, ~100–110mm steel + rubber slabs — "a magic cube showing
  you strange visions." Face map (decided): FRONT = lens; TOP = screen
  (waist-level gaze, rubber lid folds into hood); BACK = projector aperture +
  capped HDMI out (the "output face" — light in the front, visions out the
  back; projector duty-cycled, steel back as heat spreader); RIGHT face =
  shutter + power collar, DECAY (detent at 0), bank dial; LEFT face =
  ANOMALY, HOLD, assignable encoder; BOTTOM = battery + card doors + tripod
  boss. Back-mounted beam gives the live-mirror gesture (lens on the crowd,
  processed cast on the wall behind) and trades away co-axial
  camera-projector feedback; validate with a ~$99 DLP2000 LightCrafter
  before committing internals. Cold shoe currently homeless — front above
  lens is the candidate. Aesthetic (decided): black cassette futurism, very
  plain — same steel + rubber palette, blacked out; pale engraved/silkscreen
  text only, red accents on DECAY/ANOMALY, no branding. Screen off, it reads
  as a plain black cube.
- **Screen:** square 720×720 MIPI-DSI; 5" (~90mm active, ~110mm cube, ~1kg)
  is the handheld ceiling, 4" the compact option. Visibility stack:
  high-brightness bin + optical bonding + lid-hood + firmware sunlight mode.
  Square panel sourcing is the long-pole hardware task. Square 2160×2160
  sensor crop becomes the native format.
- **Sensor:** IMX585 on Will Whang's StarlightEye (MIT, KiCad on GitHub,
  buy at shop.willwhang.dev, needs his libcamera fork, `dtoverlay=imx585`,
  V2 board). IMX492/294 four-thirds (his FourThirdsEye, MFT) = designated
  Mk II sensor. Compute: Pi 5 bench → CM5 production; RK3588 is the 4K-video
  Mk II path.
- **Lenses:** C-mount native = "universal receiver" (17.5mm flange accepts
  all longer manual mounts via rings). Kowa LM12HC 12.5mm f/1.4 1" =
  reference (~42mm equiv; avoid -V and -SW variants). Fujinon HF9A-2 9mm =
  character wide (vignettes on the 585 — feature). Tamron M112FM06 6mm
  (native 1/1.2" coverage) recommended as the wide that serves both HQ dev
  cam (~33mm equiv) and PM-1 (20mm equiv). Product idea approved:
  ZACOS-machined M-to-C / M42-to-C adapter rings, open CAD — "takes a
  hundred years of lenses."
- **Focus:** mechanical manual only, by identity. Helpers: peaking + meter
  (implemented), punch-in, half-press = "peek at reality" (helpers read the
  clean pre-chain frame), audio focus tone, zone-focus page (aperture is
  unsensed — user dials it in).
- **Video:** required. v1-adjacent plan: record-what-you-see as software
  MJPEG at 1080p (patent-free; every frame a JPEG; CORRUPT works natively),
  develop-time transcode to H.264 via x264 for sharing. Consequences pulled
  forward: GLES port, chain-fusion compiler, temporal persistence params on
  random operators. The cube therefore needs a stereo mic (Primo EM272, like
  the TL-1) — must be in the enclosure design now. Video wishlist (stated):
  a TIME operator family — VARISPEED (audio pitches with speed, tape-style;
  frame-blend and frame-sample modes; MJPEG makes retiming trivial), VDELAY
  (frame ring buffer: time/feedback/mix), VERB (multi-tap decaying smear with
  per-tap softening). CLARIFIED: delay and reverb are COUPLED audiovisual
  effects — the same controls process the audio track (audio delay time =
  frames/fps so echoes sync; reverb tail matches the visual wash; varispeed
  already pitches audio tape-style). The TL-1 harness's audio DSP is the
  implementation to share. Needs the frame-history infrastructure; PERSIST is
  the primordial version. Frame-time params are time-native (exempt from the
  1000px DIM scaling like pixel-native ops).
- **Dev gear:** Raspberry Pi HQ Camera ordered/ordering from Adafruit (Pi 5
  cable now included; C–CS adapter ring in box — needed for the C lenses).
  Rejected Adafruit 6mm (3MP, too soft). 3D printer: recommended Prusa Core
  One kit ($949) — enclosure for ASA, aligns with his open-hardware business
  model; for enclosure iteration, dummy-board fit checks from KiCad STEP
  exports, jigs, TPU rubber-palette prototyping. Steel still ships.

## Licensing rails

Everything in the rack is original code — shippable MIT. ntsc-rs (Apache) may
be ported into the core; GPL (libretro shaders) only as loadable SD-card
content, never in the MIT engine shared with Crux Garden. Shadertoy default
licence is non-commercial — off limits. No trademarked film-stock names on
shipped presets. Deliberately avoided patents: no Eulerian magnification
(MOTION EXTRACT is generic frame differencing), no connected-seam carving
(CRUSH removes straight columns). H.264 patent pools have low-volume
thresholds — confirm before shipping video.

## Next steps (in rough order)

1. **Extract the engine** to `pm1-engine.js` — MIT module consumed by the
   rack UI, Crux Garden, and the camera shell. Offered, not yet started.
2. **Capture bridge:** picamera2 → WebSocket → Chromium kiosk on Pi 5
   ("the harness is the firmware" v0).
3. **Camera shell:** viewfinder-first second HTML entry point sharing the
   engine (shoot view vs the rack's edit view).
4. GLES port + fusion compiler (required for 1080p live/record), Buildroot
   boot image (power-to-viewfinder in seconds), cube mockups on the printer.
5. Open loops: CXP-01 builder's reply (asked about open-sourcing/idea
   sharing; his DMA→GPU path, shutter-lag work, and MCU power architecture
   are the questions); square-panel sourcing; optional consistency pass for
   pixel-native ops in morphs (offered, declined for now).

## Voice notes for the next agent

Daniel is a director of engineering, hands-on, ~20 years in. He debugs by
observation and is usually right — treat his bug reports as diagnoses.
Decisions stick when they're identity-based ("that's how I shoot") rather
than spec-based. The line's register is deadpan-utilitarian (names, panels,
copy); fiction lives in text blocks, never control names. He values honest
trade-off framing over cheerleading, and the project advances software-first:
prove it in the browser, then embody it.
