import { describe, expect, it } from "vitest";
import { FlagError, parseFlags } from "../src/amp/flags.js";

describe("parseFlags", () => {
  it("accepts values inside the documented bounds", () => {
    const flags = parseFlags(["--root", "/tmp/a", "--settle-hours", "48", "--chunk-days", "30"]);

    expect(flags).toMatchObject({ root: "/tmp/a", settleHours: 48, chunkDays: 30 });
  });

  it("rejects a negative chunk size, which would make the backfill loop forever", () => {
    expect(() => parseFlags(["--chunk-days", "-1"])).toThrow(FlagError);
  });

  it("rejects zero and out-of-range values", () => {
    expect(() => parseFlags(["--chunk-days", "0"])).toThrow(FlagError);
    expect(() => parseFlags(["--chunk-days", "400"])).toThrow(FlagError);
    expect(() => parseFlags(["--settle-hours", "0"])).toThrow(FlagError);
    expect(() => parseFlags(["--settle-hours", "99999"])).toThrow(FlagError);
  });

  it("rejects partially numeric input that parseInt would silently accept", () => {
    // Number.parseInt("30days") returns 30. Strict parsing refuses it.
    expect(() => parseFlags(["--chunk-days", "30days"])).toThrow(FlagError);
    expect(() => parseFlags(["--chunk-days", "1.5"])).toThrow(FlagError);
  });

  it("rejects unknown flags rather than ignoring a typo", () => {
    expect(() => parseFlags(["--chunk-day", "30"])).toThrow(FlagError);
  });

  it("treats sensitive capture as explicit opt-in, defaulting to off", () => {
    expect(parseFlags([]).allowSensitive).toBeUndefined();
    expect(parseFlags(["--allow-sensitive"]).allowSensitive).toBe(true);
  });
});
