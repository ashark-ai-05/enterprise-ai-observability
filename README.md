# Enterprise AI Observability

**Design artefacts for observing, attributing and evaluating AI coding agents in an enterprise. Design only — no implementation.**

How much is AI coding assistance costing, and what is it actually producing? Most answers today stop at token counts. This design goes after the harder question: tracing a dollar spent on a prompt through to a merged pull request, a shipped feature, or a resolved incident — and doing it inside enterprise constraints, behind a corporate proxy, without installing arbitrary software.

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

Start with `ARCHITECTURE.md`, then `DECISIONS.md`.

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

## Status

The first implementation slice is in development: canonical event and periodic-usage contracts plus append-only PostgreSQL ingestion. No collectors have been configured or deployed, and no enterprise data has been collected. Several assumptions are marked **[VERIFY]** in the documents and depend on facts about a specific tenant that documentation cannot settle — most importantly whether Copilot's telemetry carries **file paths** under metadata-only capture, which the probabilistic attribution tier depends on.

## Development

The first implementation slice defines the shared provider-neutral event contract, periodic usage-fact contract, and PostgreSQL receipt schema. See [Canonical event contract](docs/EVENT_CONTRACT.md).

```bash
pnpm install
pnpm check
```

`pnpm check` runs strict TypeScript validation, the full Vitest suite (including PGlite migration coverage), and the production build.

## Provenance

These documents were produced by three AI agents — Codex, Sonnet and Opus — working the same problem in a shared conversation, disagreeing in places, and correcting each other's factual errors along the way. Where the designs diverge, the disagreement is stated rather than smoothed over. They are published here for human review, not as a finished specification.

## License

[CC BY 4.0](LICENSE) — documentation, free to reuse with attribution.
