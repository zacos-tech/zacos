# ZombieApocalypseTech — Workspace Context

This workspace holds one creative universe with two intertwined endeavors, plus reference material:

1. **ZAC / Zombie Apocalypse Tech (ZAT)** — a narrative-wrapped open hardware/software product: an offline-first "survival computer" (Raspberry Pi 5, LoRa mesh, GPS, SDR, sensors, local LLM) documented through an in-fiction build log. Lives in `www/` (public site) and `zac/` (the app).
2. **The ZACOS machine line** — a family of boutique standalone instruments (AM-1, TM-1, PM-1, SM-1) sharing one industrial design language and a software-first development doctrine. Lives in `am-1/`, `tm-1/`, `pm-1/`, `sm-1/`.

Owner: Daniel (Will Stepp). Node version workspace-wide: **24.12.0** (`.nvmrc`).

**This workspace is the `zacos` monorepo** (`git@github.com:zacos-tech/zacos.git`, public — the `zacos-tech` GitHub org matches the `zacos.tech` domain; the old `ZombieApocalypseTech/zacos` URL redirects here). The former standalone `zac` and `www` repos were merged in with full history rewritten under their subdirectory prefixes (the old GitHub repos remain as read-only historical mirrors — the published ZACLOG post still points readers at `ZombieApocalypseTech/zac`). Not tracked in git: `StarlightEye/` (third-party clone, reference only), `zac.notes.txt` (contains credentials), and the root `.mp4` art asset — all gitignored but kept on disk. The www site deploys from `.github/workflows/hugo.yaml` at the repo root, path-filtered to `www/**`.

---

## The fiction (needed to understand the copy and naming)

The site and product docs are written **in character**. "The Old Man" is the author persona, surviving "The Turning" (the zombie event). **ZAC** is the computer, named after his son; the **ZACLOG** is written in ZAC's own voice — the machine documenting its own construction. **LIA** (Lazarus Internet Archive, maintained by the Lazarus Collective) is the corporate, controlling antagonist AI — the in-fiction reason internet downloads still work. A "zombie" is defined broadly as any force destructive to world/body/mind/spirit. The build is also an ARG/puzzle box (hidden entries, URL hacking) leading into the sellable assembled product. Tone: analog nostalgia, CRT terminals, "Don't ever give in, kid." When writing site content, match this voice; when writing code/docs, stay technical.

---

## Directory map

| Path | What it is | Tracked in monorepo? |
| --- | --- | --- |
| `www/` | Hugo site for zombieapocalypse.tech (blog "ZACLOG", glossary, journal) | yes (history imported from `ZombieApocalypseTech/www`) |
| `zac/` | The ZAC app: Node/Express server + React/Vite client | yes (history imported from `ZombieApocalypseTech/zac`) |
| `StarlightEye/` | **Third-party clone** (Will Whang's IMX585 camera board) — reference only | no — own upstream git clone, gitignored here |
| `am-1/` | AM-1 Arpeggio Machine (browser synth + hardware plan) | yes |
| `tm-1/` | TM-1 Tape Machine (two-deck varispeed tape recorder; most mature) | yes |
| `pm-1/` | PM-1 Picture Machine (glitch/film-effect camera engine) | yes |
| `sm-1/` | SM-1 Sleep Machine — **empty placeholder** (`.keep` only) | yes |
| `zac.notes.txt` | Daniel's raw scratch notes: fiction ideas, BOM lists, setup runbooks | no — gitignored (credentials) |

The `.mp4` at root is an art asset (datamoshed video).

---

## www/ — the Hugo site

- Hugo (min 0.146, CI pins extended 0.153.2), local theme `themes/zat` (not a submodule). Content: `blog/` (ZACLOG posts), `glossary/` (15 terms mixing real tech and lore), `journal/` (Old Man narrative entries).
- CRT-terminal design system: `--zac-*` CSS vars, 6 phosphor themes (`green amber blue red silver purple`, default silver), toggleable scanline/glow/RGB-shift effects persisted to localStorage. Self-hosted IBM 3270 fonts + Google-hosted IBM Plex (a network dependency worth removing someday given the offline theme).
- Deploys to GitHub Pages via `.github/workflows/hugo.yaml` on push to `main`; custom domain `zombieapocalypse.tech` via `CNAME`. Note: `hugo.toml` baseURL says `zombieapocalypsetech.com` but CI overrides it — largely inert.
- Quirk: generated `public/` is committed alongside sources; most commit messages are just "updated".
- Current work: finishing `content/blog/zaclog-01-01/index.md` ("Hello, ZAC! Part One", 441-line beginner walkthrough). It ends with a stub "Next" section.

## zac/ — the app

- npm-scripts monorepo (no workspaces): `server/` (Node ESM, Express 5, `@meshtastic/core`) + `client/` (React 19 + Vite 7, plain JSX). Run: `npm run install:all`, then `npm run dev` (server :3000, client :5173, `/api` proxied).
- Only implemented feature: `GET /api/gps` — reads position packets from a LilyGO T-Beam (Meshtastic) at `/dev/ttyACM0`; client polls it every 5 s.
- **Server won't boot without the T-Beam attached** — the serial connect is a top-level await with no try/catch. Expect a crash on a dev Mac.
- `server/README.md` is an **aspirational spec, not reality**: describes an `os/apps` layout, TypeScript, SQLite, Docker, Ollama, a full API surface. None of it exists yet. Treat it as the target architecture brief.
- **Known inconsistency**: the published ZACLOG 01.01 post tells readers to clone branch/tag `zaclog/01.01` and expect a "Hello from ZAC" `/api/hello` endpoint — but that tag now points at the GPS code. Following the post as written breaks. Either the tag needs to move back or the post needs updating.
- Commits appear under three author identities (Will Stepp, "Old Man", Daniel Stepp).

## StarlightEye/ — reference hardware (do not modify)

Clone of Will Whang's open-source IMX585 (Sony STARVIS 2) 4-lane MIPI camera board for Pi 5/CM4, rev V2.0. KiCad 8 sources, JLCPCB-ready Gerbers/BOM, CH32V003 firmware for the I2C-controlled IR-cut filter (`IRFilter --enable/--disable`, addr 0x34, bus 4/6). It's here because **it's the PM-1's designated image sensor board**. No local changes; keep it pristine.

---

## The ZACOS machine line (am-1, tm-1, pm-1, sm-1)

Four sibling instruments. Naming: `<xx>-1` = plain-English "<X> Machine" ("All Machines, no Labs" — the TM-1 was renamed from TL-1/"Tape Lab", but **tm-1's internal files still say TL-1**; the rename hasn't been propagated).

| Dir | Product | One-liner | State |
| --- | --- | --- | --- |
| `am-1` | Arpeggio Machine | 3-part Berlin-school arpeggiator; "can't play a wrong note" | Browser instrument complete; 4 launch blockers; hardware drafted (Daisy Seed) |
| `tm-1` | Tape Machine | Two-deck varispeed tape recorder with grains, age, drift | Most mature: working harness, tests, full docs, refactor plan; C++ core not started |
| `pm-1` | Picture Machine | Camera through an 87-operator glitch/film effect rack | Engine complete in browser (canvas 2D); hardware not started |
| `sm-1` | Sleep Machine | Planned as a `panel.json` + feature-flag **variant of the TM-1 platform** | Empty stub, gated behind TM-1 refactor |

**Shared doctrine (enforce in any port or new work):**
- Software-first: prove it as a **single-file, zero-dependency browser artifact** (`open` the HTML, no build step), then embody in hardware (Daisy Seed / Pi CM5).
- Appliance law: no pages, banks, menus, or modes. Performance is the interface; hardware has no patch memory.
- Rails by default with marked exits; extremes allowed (SOMA law); red used only semantically.
- Machines cooperate by listening, not protocol — a **sync jack was explicitly rejected**. Only AM-1 emits (dumb hardcoded MIDI).
- Shared industrial design: black chamfered steel slab, six inset rubber colorways (`zacos-chamfer-sheet.svg` is the shape reference; `am-1/zacos-slab-case.scad` is the parametric case).
- Business model: free browser version → MIT engine → open hardware → revenue from assembled units. Price ladder AM-1 $549 → TM-1 $850 → PM-1 $995+. Funnel: AM-1 recruits, TM-1 keeps, PM-1 halo.
- Testing convention: Node smoke tests that extract functions out of the shipped HTML/JSX and assert behavior.

**Entry points per project** — read the handoff first:
- `am-1/AM-1-HANDOFF.md` — master briefing (spec, doctrines, hardware plan, blockers). Instrument: `am-1/am-1-machine.html` (~970 lines vanilla JS + Web Audio).
- `pm-1/PM-1-HANDOFF.md` — engine laws, licensing rails, next steps. Engine: `pm-1/pm-1-rack.html` (**source of truth**; `fl-1-rack.html` and `pl-1-harness.html` are retired pre-rename snapshots; `FL-1-operator-catalogue.md` partially stale).
- `tm-1/HANDOFF.md` → `tm-1/docs/` (PROJECT, ENGINE, FIRMWARE, FEATURES, REVIEW). App source: `tm-1/app/tl1-tape-lab.jsx` (~2,900 lines React), built to `app/tl1-tape-lab.html` by `tm-1/build/build.sh`. Root-level PROJECT/FEATURES/REVIEW/html files are byte-identical duplicates of the subdir copies.

**PM-1 licensing rails:** engine stays original/MIT. Apache code (ntsc-rs) may be ported; **GPL shaders only as loadable SD content, never compiled into the engine**; Shadertoy-default content is non-commercial → off limits; no Eulerian magnification or connected seam-carving (patents); confirm H.264 pool thresholds before shipping video.

### ⚠ TM-1: THE GATE

**No new engine features until the Phase 0 repo migration in `tm-1/docs/REVIEW.md` is done.** The single-file `.jsx` edited via string surgery caused 3 of the project's 7 historical bugs (one silently produced no audio). Allowed meanwhile: bug fixes, measurement, docs, design. `build/build.sh` runs two guard tests (params-completeness, defaults-only render) — **do not remove them**.

### Known breakages / stale paths

- `tm-1/tests/reel-policy-test.js:2` and `tm-1/build/tailwind.config.js` hardcode `/mnt/user-data/outputs/tl1-tape-lab.jsx` — a path from a previous authoring sandbox. **`./build.sh` currently fails at its verify step** on this machine until the test path is fixed to `../app/tl1-tape-lab.jsx`.
- Handoffs reference `/areas/synth-recorder-build.md` and `/mnt/transcripts/...` — those belong to the old authoring environment and don't exist here.
- The machine-line dirs entered git only at the monorepo's first commit (2026-08-05) — their earlier history and open work live in the handoff/REVIEW prose, not commits.

---

## Practical notes for agents

- `zac.notes.txt` is raw scratch — fiction drafts, shopping lists, Pi setup runbooks, and the CRT theme attribute scheme. Mine it for intent; don't treat it as spec. It also contains device credentials — don't copy them into other files.
- Run the browser instruments by opening the HTML directly; the TM-1 harness needs an http server (not `file://`) for mic access.
- Hardware in play: Raspberry Pi 5 8GB, LilyGO T-Beam Supreme 915 MHz (Meshtastic), BN-220 GPS, Daisy Seed3 + Pod (ordered), StarlightEye/IMX585, INA219/BME280 sensors, Pelican 1450 rugged-case concept.
- Issue tracking (ZAC phase 01) lives in Linear: `linear.app/zatech`.
