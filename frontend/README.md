# AfterHours frontend

Working React + TypeScript / Vite review workspace with a four-stage React Flow overview: **Normalize → Match → Investigate → Recalculate**. Select a stage to explore its original flowchart: steps, connecting arrows, decision labels, parallel checks and retry paths. Only that stage is shown; **All stages** returns to the overview. The underlying workflow retains all 25 states. The default UI is synthetic demo mode. Set `VITE_REVIEW_ID` to connect the workspace to a persisted backend review; the browser still never receives database or provider credentials.

## Run locally

From the repository root, when the frontend Compose service is present:

```sh
docker compose up --build -d frontend
```

Open **http://localhost:5173**. The image builds with Node 22 and serves the production bundle through nginx on container port 5173. A standalone equivalent is:

```sh
docker build -t afterhours-frontend ./frontend
docker run --rm -p 127.0.0.1:5173:5173 afterhours-frontend
```

For development:

```sh
cd frontend
npm ci
npm run dev
```

To connect the workspace to an existing API review while developing, set
`VITE_REVIEW_ID=<review id>` before `npm run dev`. Vite proxies `/api` to
`http://localhost:8000`; override that with `VITE_API_PROXY_TARGET` when the API
uses another address. In the production Compose image, nginx proxies `/api` to
the `api` service. Connected mode reflects backend status and live snapshots;
approval, revision, and export remain unavailable until their server workflows
are implemented.

The UI remains usable without the Python API while its routes return 501. Its optional Google Fonts stylesheet falls back to the system sans-serif stack if unavailable.

## Demo walkthrough

1. Select **Signed amendment**, then **Start review**. Parallel checks wait for all four source results. The run investigates the invoice rate discrepancy, validates authority, and reaches review in approximately 10 seconds.
2. Original posted accrual JE-0098 is $7,000. Seventy hours on September 15–30 qualify for the signed September 14 amendment effective September 15 at $110/hour. The target is $7,700; only **+$700** is proposed.
3. Inspect any state, including dormant alternatives. Evidence links show source references, readable excerpts and email metadata. The received invoice is explicitly unposted; the $130 email request is explicitly excluded. Original file bytes are unavailable and the viewer says so.
4. **Ask why** simulates an email question. Approval stays locked during the answer. The cited answer returns to pending review.
5. **Reject** requires a reason. **Simulate revised evidence** invalidates any previous approval, retains the rejection in history, reruns checks and creates V2 requiring fresh approval.
6. **Approve** simulates an acknowledged approval email from Taylor Morgan, the demo reviewer. It unlocks a balanced $700 debit/credit CSV for that exact proposal. **Copy table** uses TSV and offers a manual-copy field if clipboard access fails. Downloaded means **exported — not posted**.

Other deterministic scenarios: no change, missing amendment, bounded provider failure (two retries), rejection/revision, invalid source, conflicting authority and closed accounting period. No-change and blocked/waiting scenarios cannot export. Pause/Replay/Reset affect fixture playback only. Reset cancels previous timers and pending answers. Replay starts a new run identity.

Graph interactions include pan/zoom, fit, zoom percentage, full workspace expansion and optional follow-active-step. **All stages** returns from a stage's details to the overview. Opening a stage starts execution-follow mode, which tracks the active step and advances through subsequent stages. Panning, zooming, selecting a step, returning to the overview or using the top/bottom stage navigation strips stops following. The Follow active step checkbox can resume it. Enter/Space opens keyboard-focused stages or steps; Escape dismisses evidence and expanded mode. Evidence remains available from Activity and the proposed correction. The sidebar scrolls within the workflow card and can be collapsed from the graph toolbar; Activity has its own collapse control. The workflow card ends 5px below the color legend. Narrow screens start with the sidebar collapsed. Reduced motion disables follow transitions.

## Source organization

- `src/App.tsx`: shell, overview, workspace composition and view state.
- `src/components/ExecutionGraph.tsx`: four-stage overview, stage flowcharts, controls and state styling.
- `src/data/stages.ts`: stage membership and aggregate status from workflow steps.
- `src/components/ReviewPanel.tsx`: proposal, simulated email decisions, journal/export UI.
- `src/components/EvidenceViewer.tsx`: text-only evidence modal; no HTML injection.
- `src/data/topology.ts`: states, edges, joins and return loops.
- `src/data/fixtures.ts`: coherent Cedar Labs / Acme Services fixture and evidence.
- `src/data/reviewAdapter.ts`: typed adapter contract, exact money formatting, version/export checks and CSV/TSV escaping.
- `src/data/mockReviewAdapter.ts`: deterministic authoritative demo snapshots, bounded timers and versioned review actions.
- `src/services/reviewApi.ts`: transport for the Python review routes, including live SSE snapshots.
- `src/data/apiReviewAdapter.ts`: connected read-only adapter used when `VITE_REVIEW_ID` is set.

Money is stored as integer-cent strings. The frontend displays fixed validated fixture results; it does not invent production accounting calculations. CSV uses the approved version, escapes quotes/newlines and prefixes spreadsheet formula-like input. The mock's export method independently checks balance, current input revision and approved proposal version; backend enforcement is still necessary for real data.

## Backend integration boundary

The browser must use **only the Python API**, never SpacetimeDB directly. Create/list/get now use the database, including polling live snapshots; export still returns explicit HTTP 501. Demo mode remains the default, while `VITE_REVIEW_ID` enables the connected read-only adapter. `ReviewApi` implements:

- `POST /create-review`: multipart files; identifiers are generated by the server.
- `GET /list-review`: cursor pagination, limit 1–10.
- `GET /get-review`: authoritative JSON snapshot and same-route SSE with `live=true` and `after_sequence`.
- `GET /export-review`: server-generated approved CSV; only `review_id` is submitted.

There are no invented approve/reject/question endpoints. Those decisions belong to the authoritative backend email workflow. The visible buttons are demo simulations only and must not be wired to local state in a real adapter.

The inactive transport hydrates a snapshot on reconnect, resumes SSE from its cursor, suppresses duplicate cursors and older input revisions/timestamps, exposes connection/error states and closes its stream/retry timer on unsubscribe. It reports 501 as an error; no animation implies server completion. The API's `sequence` is an opaque string, so it is not parsed as a numeric ordering guarantee. Equal-timestamp, distinct opaque cursors require the server's ordered-stream contract; a monotonic revision would enable stronger arbitrary out-of-order rejection.

Before enabling a connected UI, implement the four routes and supply/clarify these authoritative details:

1. Run ID, per-node states (including simultaneous work), traversed transitions and stable activity event IDs. The current success response does not contain this graph information.
2. Exact proposal version/hash and input revision binding, current approval identity and approval validity, validated export eligibility and rejected/question-pending state. Existing status/amount fields alone must not imply approval of a new proposal.
3. Email decisions and question answers in the event stream, including immutable proposal identity and evidence references.
4. Document metadata/preview bytes or references. The current contract contains excerpts but no document-download route; do not invent one.
5. Safe browser access to the Python origin (same-origin proxy or explicit CORS), and stable case/vendor display metadata. No service credentials belong in the bundle.

No connected-mode switch is exposed until those mappings exist. This prevents a cosmetic live run or a browser-only approval from being presented as real.

## Verification

```sh
npm run typecheck
npm run build
npm test
```

Tests cover the parallel join, fixture gates, questions and pending approval lock, rejection/new version, stale approval invalidation, exact money values, CSV formula protection, TSV fallback, timer/reset cancellation, subscription cleanup, opaque-cursor reconnect/deduplication, 501 handling, keyboard evidence inspection, Escape, follow-off selection preservation, expansion and overview navigation. Stage tests also check aggregate status, the four-card overview, original stage positions and routed connections, step selection without an inspector and keyboard focus restoration.

Workspace interaction tests use jsdom with layout/SVG measurement shims. The stage overview was also checked in local headless Chrome at desktop and 390px mobile widths, covering stage navigation, original stage positions and routed connections, keyboard activation, focus restoration and mobile fit. This browser check uses synthetic demo data; it does not exercise live agents or QuickBooks posting.
