# groundlinx-sor-import

VA-team upload page for the daily UGL SOR Extract. Drag-drop the `.xlsx`,
the serverless function runs the proven `sync_sor_extract` + `import_work_orders`
pipeline against monday, and an audit row lands on the SOR Sync Audit Log
board.

Replaces the manual `npm run sync-sor` + `npm run import-jobs` terminal flow
in the main field-app repo (PR #27 / #31 / #34).

## Architecture

- **Static HTML** (`index.html`) served from repo root via Netlify
- **Netlify serverless function** at `/api/sync` (route in `netlify.toml`)
  → `netlify/functions/sync.ts` (built in sub-step 2)
- **Monday API token never leaves the server** — read from Netlify env at
  runtime, never bundled into the browser
- **Shared password** layer (env-var) for defence-in-depth on top of the
  hard-to-guess Netlify subdomain
- **Audit log** posted to a dedicated monday board on every upload
- **Rate limit**: 5 uploads / hour / IP, in-process map per Netlify
  function instance (good enough for v1)

The proven import logic from the main field app is **copied verbatim**
into `netlify/functions/lib/`:

- `sync_sor_extract.ts` — read xlsx, diff against monday, batch
  mutations (PR #27)
- `import_work_orders.ts` — group by Asset ID, route to Active /
  Approved board, lifecycle move (PR #31, fixed in PR #33)
- `build_job_name.ts` — canonical `<Item names> - <Asset ID> - <Address>`
  string (PR #30 Step 1.6)

Sub-step 2 will refactor these from CLI scripts to library functions
called from the serverless handler.

## Local dev

```bash
npm install
netlify dev   # http://localhost:8888
```

Set local env vars in `.env` (gitignored). Template in `.env.example`.

## Deployment

This repo is wired up to a Netlify site with the build settings in
`netlify.toml`. Push to the default branch deploys automatically. Env
vars are configured in Netlify UI (Site settings → Environment
variables) — see `.env.example` for the list.

## Sub-steps (build plan)

| Sub-step | Status | Output |
|---|---|---|
| 1 — Repo + scaffold | this commit | This README, package.json, netlify.toml, placeholder index.html, copied lib modules |
| 2 — Backend serverless function | pending | `netlify/functions/sync.ts` — multipart upload, password gate, run sync + import |
| 3 — Frontend HTML | pending | Real UI in `index.html` — drag-drop, progress feed, summary card |
| 4 — Audit board on monday | pending | New board created via API, board id documented |
| 5 — Wire audit posting | pending | `sync.ts` posts an item to the audit board on every run |
| 6 — Local + deploy testing | pending | `netlify dev` smoke test, then live deploy |
| 7 — Final acceptance | pending | Rowan tests with the actual extract |
