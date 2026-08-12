# Amp Usage Archiver

Phase-0 component (`docs/DECISIONS.md` D7). Captures Amp cost data before it expires, and stores
it raw so normalization to the shared event contract can be re-run without re-fetching.

**This is the only time-sensitive component in the system.** Per-thread cost is unrecoverable
once it ages out. Everything else can wait; this cannot.

## Why two collectors

Amp exposes cost at two grains with two different retention windows. Conflating them loses data.

| Endpoint | Grain | Retention | What dies |
|---|---|---|---|
| `/api/v2/threads/{id}/usage` | per thread, per provider/model, with `subThreadIDs` | **90 days** | attribution of spend to a piece of work |
| `/api/v2/workspace/analytics/daily-usage` | per user × day × model | **365 days** (`lookbackDays` max) | nothing, within a year |

The archiver runs both. Rollups go first: they are one cheap call per chunk and they are what
survives the cliff, so a run that dies partway through threads has still advanced the archive.

## Design decisions worth knowing

**Oldest-first thread ordering.** Threads are sorted by age descending before usage is fetched, so
the records closest to the 90-day cliff are captured first. If a run is interrupted, rate-limited,
or killed, what survives is the data that was about to become unrecoverable — not the data that had
89 days left. This is the single most important behaviour in the module and it has a dedicated test.

**Sub-threads are never fetched.** A parent thread's `usage` already includes its sub-threads
(they are listed in `subThreadIDs`). Fetching both would double-count spend, which is the worst
possible defect in a cost system. Sub-thread metadata is still archived; only the usage call is skipped.

**A 404 is a fact, not a failure.** Past the cliff the API returns 404. The archiver records the
thread as expired and never asks again, rather than retrying or counting it as an error. Genuine
failures (5xx, exhausted retries) land in `atRiskThreadIds` instead, which is the list to act on.

**The list cursor is the cliff boundary, not a high-water mark.** `after`/`before` filter on
`firstSyncedAt` — *initial sync time*, not last update. Advancing `after` to the newest thread seen
therefore hides every already-known thread on the next run, freezing an active thread's cost at
whatever the first run happened to capture. (Caught in review by Codex; the original test stub
ignored `after`, so no test could have failed.)

`after` is anchored to `now - 90d` instead. That returns exactly the threads whose usage is still
retrievable — bounded work, and known-but-active threads reappear every run. This matters because
**there is no single-thread GET on this API** (`/threads/{id}` supports only `DELETE`), so
re-listing is the only way to refresh a thread's `updatedAt`.

**A periodic unfiltered sweep backs that up.** Bounded listing assumes every thread carries
`firstSyncedAt`, which the schema does not guarantee — only `id` and `creatorUserID` are required —
and how the live API treats such rows under `after` is unverified. The first run sweeps unfiltered
(which is also what inventories the cold-start gap), and `FULL_SWEEP_INTERVAL_DAYS` re-sweeps
weekly, capping how long any thread can stay invisible at seven days.

**Sensitive fields are redacted before anything is written.** The capture policy is metadata-only
(D3), but thread `title` is free text — routinely carrying ticket keys or customer names — and the
daily rollup carries user `email`. Both are stripped at ingest, *before* hashing, and the removal is
recorded in `redactedFields` and the run summary. Holding `threads.contents:view` must not silently
reclassify what the archive stores. `--allow-sensitive` opts out, and is only appropriate for an
approved, separately protected store. Repository names are deliberately kept: they are metadata.

**The digest identifies the stored bytes.** `contentHash` is the SHA-256 of exactly what is written
to the blob, computed after redaction. An earlier version hashed the response text but wrote
pretty-printed JSON, so `rawPayload.digest` could never be verified against the blob it referenced.
Blobs are created exclusively (`wx`), so a concurrent writer cannot half-overwrite an immutable one.

**Raw bodies, otherwise untransformed.** Responses are stored verbatim, content-addressed by SHA-256.
Normalization happens downstream and may be re-run against a changed contract; that is only safe if
nothing was discarded at ingest. Identical bodies dedupe to one blob, but *every* fetch appends to
`observations.jsonl`, so "when did we learn this" stays answerable.

## The one knob that needs a human decision

`ThreadPollPolicy.settleAfterHours` (default **24**, range 1–8760, in `src/amp/archiver.ts`).

A thread's cost is not final while the thread is active. Capture once and you freeze a partial
figure forever; re-poll every run and you spend rate-limit budget that the cliff-facing backlog
needs more. The default treats 24 hours of inactivity as final.

This is a genuine cost/completeness trade-off that depends on how your teams work — whether Amp
threads are short bursts or run across days. Override with `--settle-hours <n>`.

Settlement records the `updatedAt` observed when the thread went quiet, not just the thread ID. A
thread that later *resumes* has a newer `updatedAt`, which voids settlement and re-opens polling.
Storing bare IDs froze resumed threads at their pre-resumption cost permanently.

## Usage

```bash
export AMP_API_KEY=...              # workspace API key
export AMP_BASE_URL=...             # optional, defaults to https://ampcode.com

aiobs amp doctor                    # one-call reachability/credential/scope check
aiobs amp archive --root ./.archive/amp
aiobs amp archive --root ./.archive/amp --settle-hours 48 --chunk-days 30
```

`doctor` costs a single `lookbackDays=1` call and confirms base URL, proxy/TLS path, credential
validity and the analytics scope together. Run it before the first archive.

Exit codes: `0` clean, `1` completed with errors (output still valid), `2` doctor unreachable,
`3` missing `AMP_API_KEY`, `4` unhandled.

## Required scopes

| Scope | Needed for | If missing |
|---|---|---|
| `amp.api:workspace.threads.meta:view` | thread list, thread usage | no per-thread cost at all |
| `amp.api:workspace.analytics:view` | daily-usage rollup | no 365-day history |
| `amp.api:workspace.members:view` | user email on rollups | user IDs only, still usable |
| `amp.api:workspace.threads.contents:view` | thread `title`, `repositories` | **loses vendor repo attribution** |

That last row matters more than it looks: `repositories` is Amp telling you which repos a thread
worked in, which is an attribution signal with no git instrumentation required. Worth requesting
the scope even under a metadata-only capture policy — repository names are metadata, not content.

## Mapping onto the shared contract

`src/amp/adapter.ts` converts archived responses into the contract types from `src/index.ts`.
It reads the raw archive; it never calls the API, so mapping can be re-run against a changed
contract without re-fetching.

| Amp source | Contract shape | Identity |
|---|---|---|
| `/workspace/analytics/daily-usage` | `PeriodicUsageFactInput`, grain `principal_day_model` | `amp:daily:{date}:{userId}:{model}` |
| `/threads/{id}/usage` | `RawTelemetryEvent`, one per provider/model bucket | `amp:thread-usage:{threadId}:{provider}:{model}` |

Three decisions in the mapping are load-bearing:

**One event per model bucket, never a thread total.** A thread's `usage` is the sum of its
buckets, so emitting a total event alongside them would double-count spend.

**Line counts land on exactly one fact per user/day.** Amp reports `linesAdded`/`linesDeleted`/
`linesModified` per *user per day*, but the contract grain is `principal_day_model`. Copying them
onto every model fact would multiply a user's code output by the number of models they used. They
are attached to the highest-cost model instead (ties broken by name, so the choice is stable),
which keeps `SUM(output.linesAdded)` equal to the true daily total. This is a workaround for a
grain the contract does not have; a `principal_day` grain would model it properly.

**Cost always goes through `toDecimalString()`.** Amp returns cost as a JSON number and
`String(1e-7)` produces `"1e-7"`, which the contract's decimal regex rejects. Sub-microdollar
per-thread costs are ordinary. Using the shared helper also means every adapter rounds identically,
so totals reconcile across sources.

Trace mapping follows `docs/EVENT_CONTRACT.md`: `runId` and `traceId` are the thread, `spanId` is
the per-observation `sourceEventId`. `sourceEventId` stays stable across restatements, so a
re-polled active thread produces a new `revisionDigest` and appends rather than colliding.

## Archive layout

```
<root>/blobs/<hh>/<sha256>.json   immutable bodies, content-addressed, sharded by hash prefix
<root>/observations.jsonl         append-only log of every fetch outcome
<root>/checkpoint.json            cursors, settled and expired thread sets
```

Checkpoints are written atomically (write-then-rename); a corrupt checkpoint degrades to a full
re-walk rather than wedging the archiver, and every write is idempotent so restarting is safe.

## Status

Fixture-driven. 51 archiver/adapter/redaction/CLI tests (69 across the repo) cover retry/backoff, `Retry-After`, cliff ordering, sub-thread exclusion,
404-as-expiry, settle/re-poll behaviour, cursor-boundary re-polling, sweep interval, dedupe, and
checkpoint recovery, contract mapping, redaction, resumed-thread re-opening, CLI bound rejection, and per-chunk
checkpointing — including that unchanged re-polls dedupe while changed values append. The two most
important regressions were falsified by reverting the fix and confirming they fail.

End-to-end against a stub server: `--chunk-days -1` is rejected with exit 1 rather than looping;
no `title` or `email` reaches the archive; and every stored blob's SHA-256 matches its filename,
so each `rawPayload.digest` verifies against the bytes it points at. Verified end-to-end against a stub server that honours `after`: run 1 sweeps
unfiltered and records the past-cliff thread without spending a request; run 2 bounds to the live
window, re-polls the active thread and skips the settled one.

**Not yet run against a live Amp workspace** — no credentials in the build environment. First real
run should be `aiobs amp doctor`, then a single `archive` with `--chunk-days 30`, then check
`observations.jsonl` for `outcome: "past-cliff"` entries to measure the real cold-start gap.
