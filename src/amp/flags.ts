import { join } from "node:path";
import { DAILY_USAGE_MAX_LOOKBACK_DAYS, MAX_SETTLE_HOURS } from "./archiver.js";

export interface Flags {
  root: string;
  settleHours?: number;
  chunkDays?: number;
  allowSensitive?: boolean;
}

export class FlagError extends Error {}

/**
 * Strict numeric parsing. `Number.parseInt` would accept "12abc" and, worse, negative values —
 * a negative chunk size makes the backfill cursor walk forward so the loop never terminates.
 */
function parseBoundedInteger(raw: string, min: number, max: number, flag: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new FlagError(`${flag} must be a whole number between ${min} and ${max}, received "${raw}"`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    throw new FlagError(`${flag} must be between ${min} and ${max}, received ${value}`);
  }
  return value;
}

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = { root: join(process.cwd(), ".archive", "amp") };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--root" && next) {
      flags.root = next;
      i++;
    } else if (arg === "--settle-hours" && next) {
      flags.settleHours = parseBoundedInteger(next, 1, MAX_SETTLE_HOURS, "--settle-hours");
      i++;
    } else if (arg === "--chunk-days" && next) {
      flags.chunkDays = parseBoundedInteger(next, 1, DAILY_USAGE_MAX_LOOKBACK_DAYS, "--chunk-days");
      i++;
    } else if (arg === "--allow-sensitive") {
      flags.allowSensitive = true;
    } else if (arg?.startsWith("--")) {
      throw new FlagError(`unknown flag ${arg}`);
    }
  }
  return flags;
}
