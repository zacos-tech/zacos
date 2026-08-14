# ZACOS

**ZAC** is an offline-first survival computer. The **machine line** is a family of standalone instruments that share one industrial design with the ZAC. The software that runs on all these machines is collectively named ZACOS.

MIT licensed.

## The projects

### www — zacos.tech

The public site. **ZACLOG** is the build log of ZAC. A glossary mixing real hardware with lore. The design system is a CRT terminal with six phosphor themes and toggleable scanline effects.

Run it with `hugo server` from `www/`. Deploys to GitHub Pages on push to `main`.

### zac — the computer

The ZAC application. A Node/Express server and a React/Vite client. The hardware target is a Raspberry Pi 5 with LoRa mesh, GPS, SDR, sensors, and a local LLM. The first working feature is `GET /api/gps`, which reads position from a Meshtastic T-Beam over serial.

Run it with `npm run install:all`, then `npm run dev` from `zac/`. The server expects the T-Beam at `/dev/ttyACM0` and will not boot without it.

### am-1 — Arpeggio Machine

Three arpeggio parts share one clock over a drone. Every note comes from the current chord, and the chord comes from the selected key and scale. It can't play a wrong note. One HTML file, no dependencies, no build step.

Open `am-1/am-1-machine.html` in a browser. The manual is built into the page. Hardware plan: Daisy Seed.

### tm-1 — Tape Machine

Two tape decks with varispeed, grains, age, and drift. The most mature of the line: working harness, tests, and full documentation under `tm-1/docs/`.

Serve `tm-1/tl1-tape-lab.html` over http (not `file://`) for microphone access. Start with `tm-1/HANDOFF.md`.

### pm-1 — Picture Machine

A camera through a rack of 87 glitch and film-effect operators. The engine is complete in the browser. The planned image sensor is the open-source IMX585 board (StarlightEye) on a Pi.

Open `pm-1/pm-1-rack.html` in a browser. Start with `pm-1/PM-1-HANDOFF.md`.

### sm-1 — Sleep Machine

Planned as a variant of the TM-1 platform. Empty for now.

## License

MIT. See [LICENSE](LICENSE).
