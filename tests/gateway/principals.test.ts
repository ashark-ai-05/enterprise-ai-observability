import { describe, expect, it } from "vitest";
import {
  StaticPrincipalRegistry,
  UnauthorizedError,
  authenticate,
} from "../../src/gateway/principals.js";

const registry = new StaticPrincipalRegistry(
  new Map([
    [
      "key-good",
      {
        principalId: "svc-1",
        tenant: "acme",
        team: "platform",
        actorType: "service" as const,
      },
    ],
  ]),
);

describe("authenticate", () => {
  it("resolves a principal for a valid bearer token", async () => {
    const principal = await authenticate(registry, "Bearer key-good");
    expect(principal).toEqual({
      principalId: "svc-1",
      tenant: "acme",
      team: "platform",
      actorType: "service",
    });
  });

  it("rejects a missing Authorization header", async () => {
    await expect(authenticate(registry, undefined)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("rejects an unknown key", async () => {
    await expect(authenticate(registry, "Bearer nope")).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("rejects a non-Bearer scheme", async () => {
    await expect(
      authenticate(registry, "Basic key-good"),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
