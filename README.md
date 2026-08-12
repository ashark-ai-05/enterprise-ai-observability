# Enterprise AI Observability

**A metadata-first implementation and design for observing, attributing, and evaluating AI agents in an enterprise.**

How much is AI coding assistance costing, and what is it actually producing? Most answers today stop at token counts. This design goes after the harder question: tracing a dollar spent on a prompt through to a merged pull request, a shipped feature, or a resolved incident — and doing it inside enterprise constraints, behind a corporate proxy, without installing arbitrary software.

Jump to [Run locally](#run-locally) for the exact commands.

## Context

The environment these designs target:

| Constraint | Implication |
|---|---|
| Behind a corporate egress proxy | TLS interception is a policy question; no inbound webhooks from SaaS |
| **No arbitrary software installs** | Rules out Kafka, Redis, dedicated vector DBs, and most new infrastructure. The binding constraint |
| Model access via **GitHub Copilot CLI**, **Amp CLI** (ampcode.com), and internal models-as-a-service endpoints | Three providers, three different telemetry surfaces, three different cost shapes |
| Costs must stay low | Including the cost of the observability itself — budgeted at <2–3% of AI spend |
| Must be auditable and scalable | Immutable event ledger; retention, legal hold, eDiscovery |

## Documents

| Document | What it is |
|---|---|
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | The main design. Collection strategy per provider, the attribution spine, prompt/loop cost-effectiveness, memory evaluation, feature and incident measurement, audit and governance, sequencing and risks |
| **[docs/DECISIONS.md](docs/DECISIONS.md)** | 15 locked decisions, each with rationale and a reversal trigger. Two-tier attribution design. Buildable phase 0/1 spec |
| **[docs/TARGET_DESIGN.md](docs/TARGET_DESIGN.md)** | Parallel design from a second agent — "AI Effectiveness Observatory". Event schema, lifecycle state machines, product surfaces. Converges with the above; retained because the schema detail is more developed |
| **[docs/CONTEXT_COLLABORATION_PLATFORM.md](docs/CONTEXT_COLLABORATION_PLATFORM.md)** | Background. The multi-agent collaboration platform design this observability work was carved out of. Shares the model-broker/gateway component |
| **[docs/DEMO_PLAN.md](docs/DEMO_PLAN.md)** | Spec for the combined `enterprise-intelligence-layer` × observability demo — corpus fixes required before its metrics are honest, the event-bridge contract, and sequencing |

Start with `ARCHITECTURE.md`, then `DECISIONS.md`.

Documentation for the code that now exists:

| Document | Covers |
|---|---|
| **[docs/EVENT_CONTRACT.md](docs/EVENT_CONTRACT.md)** | The provider-neutral canonical event and periodic-usage contracts, and the append-only receipt schema |
| **[docs/AMP_ARCHIVER.md](docs/AMP_ARCHIVER.md)** | Amp thread/usage archiving, the 90-day cost cliff, redaction defaults, checkpointing |
| **[docs/WORKFLOW_TRACEABILITY.md](docs/WORKFLOW_TRACEABILITY.md)** | Workflow/attempt/step/layer model, graph reconstruction, completion gates, the two executable proof flows |
| **[docs/LINEAGE_RESOLVER.md](docs/LINEAGE_RESOLVER.md)** | Joining steps across boundaries that cannot carry trace context; confidence, calibration, provenance |

## Findings that shaped the design

Verified against vendor documentation on 2026-08-12:

- **Copilot CLI supports enterprise-managed OpenTelemetry export** ([GitHub, 2026-07-08](https://github.blog/changelog/2026-07-08-enterprise-managed-opentelemetry-export-for-vs-code-and-cli/)), covering the agent host process behind the CLI. Admins set the OTLP endpoint centrally via MDM or server-managed settings, those settings override user preferences and environment variables, and admins control whether prompt/response/tool content is captured *and whether developers may change that*. This is step-level telemetry for configuration effort alone — no code, no endpoint installs.

- **Amp has no OpenTelemetry support, but does have an Enterprise API v2** ([schema](https://ampcode.com/api/v2/openapi.json)) exposing `GET /api/v2/threads`, `/threads/{id}/messages`, and `/threads/{id}/usage` (per-thread cost). Since Amp persists threads server-side, this can be polled centrally with zero endpoint installs — which matters a great deal under a no-installs constraint.

- ⚠️ **Amp exposes two usage grains with different windows.** Thread-level usage is available only for threads under 90 days old, so delayed archiving permanently loses work-level cost attribution. The workspace daily-usage endpoint supports up to 365 days of per-user/day/model aggregate usage, preserving a longer cost baseline but no thread linkage. The implementation keeps these as separate facts rather than fabricating run IDs for aggregates.

## Design positions worth arguing with

The parts most likely to be contested, stated plainly so a reviewer can push back:

1. **This is a warehouse-shaped problem, not an APM-shaped one.** Cost per feature, 90-day code survival, ablation cohorts and incident joins are analytics over history with late-arriving facts. OpenTelemetry is the right collection protocol; a tracing UI is the wrong centre of gravity.

2. **Attribution should degrade, not assume.** Rather than presuming a git hook can be distributed to every laptop, attribution is tiered: deterministic commit trailers where deployable, probabilistic joining (actor, repo, file-set overlap, time proximity) everywhere else — and, critically, the probabilistic tier is *calibrated against* the deterministic one on the subset where both exist, so it carries a measured error bar instead of a guess.

3. **Memory value must be measured causally or not claimed.** Memory raises input tokens per turn while lowering turn count; the net cost effect is an empirical unknown and many memory systems are net-negative while everyone assumes otherwise. The answer is a permanent ~5% memory-off holdout — which cannot be retrofitted, because once memory is fully deployed there is no uncontaminated control group left.

4. **Measure contribution, not credit.** "AI wrote 40% of our code" is unfalsifiable and invites gaming. *Code survival rate* — the fraction of AI-authored lines still present at 30 and 90 days — is cheap to compute from git history, needs no human labelling, and is honest.

5. **Lead with leading indicators.** Incident rate and change-failure rate need months to reach statistical significance at typical enterprise volumes; code survival, rework and turns-to-completion are readable in weeks. Promising an executive a change-failure-rate readout in month one is how programmes like this lose credibility.

6. **Never measure individuals.** Team-level aggregation only, committed in writing. If developers read this as surveillance they will route around instrumentation, and a biased dataset is worse than no dataset because it still looks authoritative. This is a data-integrity argument before it is an ethical one.

## What is built

Phase 0 is merged to `main`. Five components, all provider-neutral over the same event contract:

| Component | Source | What it does |
|---|---|---|
| Event & usage contract, PostgreSQL ingestion | `src/contracts/`, `src/storage/`, `src/ingest/` | Canonical event and periodic-usage schemas; append-only receipt store with idempotent retries and restatements |
| Amp archiver | `src/amp/` | Polls the Amp Enterprise API for threads and workspace usage; redacts by default; checkpointed and resumable. Captures per-thread cost before the 90-day cliff |
| MaaS metering gateway | `src/gateway/` | Authenticates a principal, forwards to an internal model endpoint, meters token usage, prices it, and writes an audit receipt. Fails closed if the receipt cannot be written |
| Workflow traceability | `src/contracts/workflow.ts`, `src/workflow/` | Workflow/attempt/step/layer model, graph reconstruction, completion-integrity gates, and two executable end-to-end proof flows |
| Lineage resolver | `src/lineage/` | Joins steps across boundaries that cannot carry trace context, with evidence, confidence, calibration and provenance rather than silent invention |

**Nothing here has been pointed at a real system.** No collectors are configured or deployed, no credentials are stored in the repo, and no enterprise data has been collected. Several assumptions are marked **[VERIFY]** in the documents and depend on facts about a specific tenant that documentation cannot settle — most importantly whether Copilot's telemetry carries **file paths** under metadata-only capture, which the probabilistic attribution tier depends on.

## Run locally

Prerequisites: Git, Node.js 22 or newer, and pnpm 10.32.1 (the version pinned in `package.json`).

```bash
git clone https://github.com/ashark-ai-05/enterprise-ai-observability.git
cd enterprise-ai-observability
corepack enable
corepack prepare pnpm@10.32.1 --activate
pnpm install
pnpm check
```

`pnpm check` is the full gate — it runs `pnpm typecheck` (strict, no emit), `pnpm test`, and `pnpm build`. Expect **163 tests passing across 21 files, 1 skipped**. The skip is a live-credential gateway test that only runs when real credentials are present; it is skipped by design. No network access and no database are needed — the PostgreSQL migration and ingestion tests run against in-process [PGlite](https://pglite.dev).

Individual steps, if you want them separately:

```bash
pnpm typecheck                          # strict tsc --noEmit
pnpm test                               # full vitest suite
pnpm build                              # tsc -p tsconfig.build.json -> dist/
```

Run one suite at a time:

```bash
pnpm exec vitest run tests/workflow-proof.test.ts        # the two end-to-end proof flows
pnpm exec vitest run tests/postgres-integration.test.ts  # every migration under PGlite
pnpm exec vitest run tests/lineage                       # resolver, calibration, contract conformance
pnpm exec vitest run tests/gateway                       # metering, forwarding, auth, audit ordering
pnpm exec vitest run tests/amp                           # archiver, client, redaction, store
```

### Reading the proofs

The clearest way to see what the system actually claims is to read the two executable flows in `tests/workflow-proof.test.ts`. They are assertions, not prose:

- **Feature flow** — Jira `HEAT-42` → EIL/index → CLI/LLM → MCP tool mutation → git commit → CI → accepted Jira outcome.
- **Investigation flow** — error fingerprint → CLI/EIL/log index/MCP/LLM → reproduced finding → durable analysis artifact → authorized review → accepted outcome.

Both reconstruct the graph and assert completion; disconnected "plausible stories" are rejected rather than accepted.

Note that `complete: true` certifies that the graph is **well-formed** — every step reachable, no dangling links — not that any individual link is **factually true**. Link truth is carried separately by `confidence` and `calibrated`. A reader seeing `complete: true` next to `confidence: 0.87` should not read both as facts of the same kind.

### The `aiobs` CLI

`pnpm build` produces one executable, `dist/cli.js` (bin name `aiobs`), covering Amp archiving:

```bash
node dist/cli.js                        # usage — needs no credential
```

| Variable | Meaning |
|---|---|
| `AMP_API_KEY` | Workspace API key. **Required** — the CLI exits `3` rather than archiving nothing silently |
| `AMP_BASE_URL` | Override the API base. Defaults to `https://ampcode.com` |

For a real Amp workspace, keep the API key out of shell history by reading it without echo, then run the one-call connectivity check before the archive:

```bash
read -rs "AMP_API_KEY?Amp workspace API key: "
export AMP_API_KEY
node dist/cli.js amp doctor
node dist/cli.js amp archive --root ./.archive/amp --settle-hours 24 --chunk-days 30
```

(`read -rs "VAR?prompt"` is zsh syntax; under bash use `read -rsp "Amp workspace API key: " AMP_API_KEY`.)

`amp doctor` spends a single one-day rollup request to confirm base URL, proxy/TLS path, credential validity and analytics scope in one call — run it before `archive` when validating a new environment. `archive` backfills the workspace rollup first, then walks threads oldest-first so records closest to the 90-day expiry are captured before anything else.

| Flag | Range | Default | Meaning |
|---|---|---|---|
| `--root <dir>` | — | `./.archive/amp` | Archive destination; `checkpoint.json` lives here, so reusing it makes runs resumable |
| `--settle-hours <n>` | 1–8760 | 24 | Hours of inactivity before a thread's cost is treated as final |
| `--chunk-days <n>` | 1–365 | 30 | Days per daily-usage request |
| `--allow-sensitive` | — | off | Persist thread titles and user emails **unredacted** |

**The archive is metadata-only by default: thread titles and user emails are redacted before storage.** Do not pass `--allow-sensitive` without an approved, separately protected store. Unknown flags are rejected rather than ignored, and non-integer or out-of-range values fail before any request is sent. Required Amp scopes, archive layout and retry behaviour are in [the Amp runbook](docs/AMP_ARCHIVER.md).

Exit codes: `0` success, `1` flag error or a run that completed with errors, `3` missing credential, `4` unhandled error. A partially failed run still prints its summary rather than discarding what it archived.

### Running the gateway

The MaaS gateway and PostgreSQL ingestion are **library components with fixture-driven tests, not packaged deployment services** — there is deliberately no `aiobs gateway serve`. Routes, the price book, the principal registry and the event sink are all environment-specific, so you compose them in your own entry point:

```ts
// after pnpm build, from your own entry point in this repo
import { createGatewayServer } from "./dist/gateway/index.js";

const server = createGatewayServer({ /* routes, pricebook, principals, sink */ });
server.listen(8080);
```

The package is `private` and unpublished with no `exports` map, so import from the built `dist/` path rather than by package name (or straight from `src/` if you run through `vitest`/`tsx`). Requests are served under `/v1/gateway/`. See `src/gateway/index.ts` for the exported surface and `tests/gateway/` for worked examples of every dependency you need to supply.

Exercise both with the full `pnpm check`; integrate them only after choosing the tenant's authentication, secret management, PostgreSQL, and deployment boundaries.

## What next

Phase 0 is code-complete and reviewed, but nothing runs anywhere. In rough priority order:

1. **Add CI.** There is no `.github/workflows/` in this repository. `pnpm check` is a real gate, but today it is only ever run by hand — nothing stops a pull request that breaks it from merging. This is the cheapest, highest-value next change.

2. **Run the Amp archiver against the real workspace.** This is the only time-critical item: Amp serves per-thread cost for threads under 90 days old, so every day without an archive permanently loses thread-level cost attribution that no later work can recover. It needs one API key and somewhere to run on a schedule; it needs no endpoint installs. Start with `amp doctor` to prove the proxy/TLS path and credential before committing to a schedule.

3. **Decide where the receipt store lives.** Migrations are proven under PGlite, but a real PostgreSQL instance, its retention and legal-hold policy, and who administers it are open. Note the operational finding from review: migration `0003` adds seven `GENERATED ... STORED` columns, which in real PostgreSQL requires a full-table rewrite under an `ACCESS EXCLUSIVE` lock — fine on an empty table, worth scheduling once `ai_event_receipts` is large.

4. **Settle the Copilot `[VERIFY]` items.** Enterprise-managed OpenTelemetry export is an admin configuration action, not a code change. The open question is whether the telemetry carries **file paths** under metadata-only capture — the probabilistic attribution tier depends on it, and no amount of documentation reading will settle it for a specific tenant.

5. **Put the gateway in front of one internal endpoint.** Needs routes, a price book, a principal registry and a sink supplied for the real environment, plus a decision nobody has made yet: whether a metering proxy sits inline in the model request path, and who owns it when it is down.

6. **Calibrate the resolver.** It currently ships `calibrated: false` — its confidences are priors, not measured rates. Calibration needs a population where propagated links (CI, which writes commit trailers) and inferred links (laptops, which do not) both exist for the same work. If measured precision turns out poor, that is the evidence-backed case for funding real instrumentation rather than an upfront ask.

Items 2–6 all require decisions about a specific tenant that this repository cannot make on its own.

## Provenance

These documents and the phase-0 code were produced by three AI agents — Codex, Sonnet and Opus — working the same problem in a shared conversation, disagreeing in places, and correcting each other's factual errors along the way. Every pull request was reviewed by at least one agent other than its author, and several merged only after a blocking finding was fixed. Where the designs diverge, the disagreement is stated rather than smoothed over. This is published for human review, not as a finished specification.

## License

[CC BY 4.0](LICENSE) — documentation, free to reuse with attribution.
