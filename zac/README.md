# ZAC Development Setup

## What is ZAC

ZAC (Zombie Apocalypse Computer aka Zero-Infrastructure Autonomous Computer) is an open-source, offline-first survival computer. The software runs on a Raspberry Pi 5 with mesh radio, SDR, GPS, sensors, and a local LLM.

## Repository Structure

```
zac/
├── os/                         # ZAC OS - the software
│   ├── apps/
│   │   ├── api/                # ZAC API (Node + Express)
│   │   └── shell/              # ZAC Shell (React + Vite)
│   ├── packages/
│   │   └── types/              # Shared TypeScript types
│   └── docker-compose.yml
└── README.md
```

## Architecture

- **os/apps/api** - Node + Express + better-sqlite3 backend (the core)
- **os/apps/shell** - React + Vite frontend (reference implementation)
- **os/packages/types** - Shared TypeScript types

The API is the primary interface to ZAC. The Shell is one possible frontend. Users may build their own UIs, CLI tools, or integrations against the API.

## Requirements

- Docker and docker-compose for development
- Single `docker-compose up` from `os/` directory starts everything
- Hot reload for both api and shell via volume mounts

## Docker Services

| Service | Port | Purpose |
|---------|------|---------|
| api | 8080 | Express backend |
| shell | 3000 | Vite dev server |
| ollama | 11434 | Local LLM inference |

## Tech Choices (non-negotiable)

- Node
- Express
- React + Vite
- SQLite via better-sqlite3
- Plain CSS variables for theming
- TypeScript throughout

## API Design Principles

The API should be:

- **Complete** - Everything the Shell can do, the API exposes
- **Documented** - OpenAPI spec, clear types
- **Stable** - URL structure and response shapes don't change arbitrarily
- **Watchable** - WebSocket endpoint for real-time updates

Someone should be able to:

- Build a CLI that talks to ZAC
- Build a mobile app against the API
- Write a Python script to pull sensor data
- Integrate ZAC into Home Assistant or similar

## API Endpoints

```
GET  /api/status              # System overview (gauges data)
GET  /api/location            # GPS position
GET  /api/sensors             # Environmental readings
GET  /api/power               # Battery/power status
GET  /api/mesh                # Mesh network nodes
GET  /api/mesh/messages       # Message history
POST /api/mesh/messages       # Send a message
GET  /api/radio               # SDR status
POST /api/radio/tune          # Tune to frequency
GET  /api/library/search      # Search knowledge base
POST /api/library/ask         # Search + LLM synthesis
GET  /api/library/sources     # Available sources
WS   /api/events              # Real-time event stream
```

## First Feature: Gauges Screen

The shell displays a gauge/widget dashboard showing system status.

### API Endpoint

`GET /api/status` returns:

```typescript
interface SystemStatus {
  location: {
    lat: number;
    lon: number;
    alt: number;
    speed: number;
    heading: number;
    fix: 'none' | '2d' | '3d';
  };
  sensors: {
    temp_f: number;
    humidity: number;
    pressure_hpa: number;
    trend: 'rising' | 'falling' | 'stable';
  };
  power: {
    percent: number;
    voltage: number;
    current: number;
    time_remaining: number | null;
  };
  mesh: {
    nodes: Array<{
      id: string;
      name: string;
      lastSeen: number;
      snr: number;
    }>;
  };
  time: {
    utc: string;
    local: string;
    timezone: string;
  };
}
```

Return mock data. Structure code so adapters can be swapped in later.

### Shell UI

- Dark background (#272727)
- Muted Green accent (#85A78A) - configurable via CSS variable
- IBM 3270 font for headers
- Inter or system sans for body text
- Grid of gauge widgets showing each status category
- Fetch from API on mount, refresh via WebSocket or polling

## Adapter Pattern

```
os/apps/api/src/
├── adapters/
│   ├── location/
│   │   ├── index.ts
│   │   └── mock.ts
│   ├── sensors/
│   ├── power/
│   └── mesh/
├── routes/
│   └── status.ts
└── index.ts
```

Each adapter implements an interface. Config determines which adapter loads. Start with mock adapters only.

## Do Not

- Do not use Tailwind
- Do not use React Native
- Do not add authentication
- Do not set up CI/CD yet
- Do not over-engineer
