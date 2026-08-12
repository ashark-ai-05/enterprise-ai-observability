#!/usr/bin/env node
import { join } from "node:path";
import { AmpArchiver, AmpClient, FileCheckpointStore, FileRawStore } from "./amp/index.js";

const USAGE = `aiobs — enterprise AI observability

Usage:
  aiobs amp archive [--root <dir>] [--settle-hours <n>] [--chunk-days <n>]
  aiobs amp doctor  [--root <dir>]

Environment:
  AMP_API_KEY   workspace API key (required)
  AMP_BASE_URL  override API base, default https://ampcode.com

Notes:
  Thread cost is served only for threads under 90 days old; the workspace rollup reaches
  back 365. 'archive' backfills the rollup first, then walks threads oldest-first so the
  records closest to expiry are captured before anything else.
`;

interface Flags {
  root: string;
  settleHours?: number;
  chunkDays?: number;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { root: join(process.cwd(), ".archive", "amp") };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--root" && next) {
      flags.root = next;
      i++;
    } else if (arg === "--settle-hours" && next) {
      flags.settleHours = Number.parseInt(next, 10);
      i++;
    } else if (arg === "--chunk-days" && next) {
      flags.chunkDays = Number.parseInt(next, 10);
      i++;
    }
  }
  return flags;
}

function buildArchiver(flags: Flags): AmpArchiver {
  const apiKey = process.env.AMP_API_KEY;
  if (!apiKey) {
    console.error(
      "AMP_API_KEY is not set. Refusing to run rather than archiving nothing silently.",
    );
    process.exit(3);
  }
  const clientOptions: ConstructorParameters<typeof AmpClient>[0] = { apiKey };
  if (process.env.AMP_BASE_URL) clientOptions.baseUrl = process.env.AMP_BASE_URL;

  const options: ConstructorParameters<typeof AmpArchiver>[0] = {
    client: new AmpClient(clientOptions),
    store: new FileRawStore(flags.root),
    checkpoints: new FileCheckpointStore(join(flags.root, "checkpoint.json")),
  };
  if (flags.settleHours !== undefined && Number.isFinite(flags.settleHours)) {
    options.policy = { settleAfterHours: flags.settleHours };
  }
  if (flags.chunkDays !== undefined && Number.isFinite(flags.chunkDays)) {
    options.backfillChunkDays = flags.chunkDays;
  }
  return new AmpArchiver(options);
}

async function main(): Promise<void> {
  const [group, command, ...rest] = process.argv.slice(2);
  if (group !== "amp" || (command !== "archive" && command !== "doctor")) {
    console.log(USAGE);
    process.exit(group === undefined ? 0 : 1);
  }

  const flags = parseFlags(rest);

  if (command === "doctor") {
    // Cheapest possible reachability check: one day of the rollup. Confirms base URL,
    // proxy/TLS path, credential validity and the analytics scope in a single call.
    const archiver = buildArchiver(flags);
    void archiver;
    const apiKey = process.env.AMP_API_KEY as string;
    const clientOptions: ConstructorParameters<typeof AmpClient>[0] = { apiKey };
    if (process.env.AMP_BASE_URL) clientOptions.baseUrl = process.env.AMP_BASE_URL;
    const client = new AmpClient(clientOptions);
    try {
      const probe = await client.getDailyUsage({ lookbackDays: 1 });
      console.log(
        JSON.stringify(
          {
            ok: true,
            reachable: true,
            activeUsers: probe.data.metadata.activeUsers,
            totalUsageUsd: probe.data.metadata.totalUsage,
            period: [probe.data.metadata.startDate, probe.data.metadata.endDate],
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(
        JSON.stringify(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          null,
          2,
        ),
      );
      process.exit(2);
    }
    return;
  }

  const summary = await buildArchiver(flags).run();
  console.log(JSON.stringify(summary, null, 2));
  // A run that hit errors still archived whatever it could; signal it without discarding output.
  if (summary.errors.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(4);
});
