# Pacific Rising Ops — Command Center

Web console for Pacific Rising Ops. Vite + React + TypeScript, no CSS framework; the design system lives in `src/styles/`.

## Run

```bash
npm install --prefix web        # once
npm run dashboard:serve         # read-only API on 127.0.0.1:3200 (serves web/dist when built)
npm run web:dev                 # dev server on 127.0.0.1:5173, proxies /api to :3200
npm run web:build               # production build to web/dist
npm run web:check               # typecheck + lint + unit tests
```

## How data flows

```
data/*.json(l)  ──►  src/dashboard/readModel.ts  ──►  GET /api/*  ──►  HTTP adapter  ──►  services  ──►  useResource()  ──►  UI
 (existing stores)     sanitized DTOs                 SSE /api/stream ──► live topic invalidation
```

- The API is **read-only**. Every non-GET request returns 405. Approving and sending stay on the voice flow (`approve` → `confirm approval` → exact-draft send) and the approvals CLI.
- DTOs are defined once in `src/dashboard/types.ts` and imported by the web app as types.
- Gmail message, thread and draft IDs and Twilio call SIDs never reach the browser. Phone numbers are masked server-side.
- **Demo data** (`src/data/demoAdapter.ts`) is a separate adapter, switched in Settings and labeled DEMO on every screen.
- Live updates: the server watches `data/` and pushes `change` events over SSE. If the stream drops, the client polls every 30s.

## Pacific Ops presence

`<PacificOpsPresence state="listening" audioLevel={0.62} systemHealth="healthy" />`

- States: `idle | listening | thinking | speaking | awaiting_approval | executing | success | error`. Their look is defined in `src/presence/states.ts` and nowhere else.
- Raw WebGL point cloud (`src/presence/engine.ts`), lazy-loaded. Particle count scales by device tier, and the drawn particle count halves if frames run slow. Rendering pauses off-screen and in hidden tabs.
- `prefers-reduced-motion` renders one still frame. Missing WebGL, a lost context or Save-Data falls back to a static Canvas 2D frame.
- The Command Center derives the state from real voice sessions and action status (`derivePresence` in `readModel.ts`). Settings → Pacific Ops presence previews all states.
