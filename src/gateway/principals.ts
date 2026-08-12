/**
 * Service-identity authentication for the gateway. Real deployments back
 * this with the enterprise IdP / service-principal registry; tests and
 * local dev use a static registry. The gateway never accepts a caller-
 * supplied tenant or principal — both are resolved server-side from the key.
 */
export interface Principal {
  readonly principalId: string;
  readonly tenant: string;
  readonly team: string | undefined;
  readonly actorType: "human" | "service" | "agent" | "unknown";
}

export interface PrincipalRegistry {
  resolve(apiKey: string): Promise<Principal | undefined>;
}

export class StaticPrincipalRegistry implements PrincipalRegistry {
  constructor(private readonly byKey: ReadonlyMap<string, Principal>) {}

  async resolve(apiKey: string): Promise<Principal | undefined> {
    return this.byKey.get(apiKey);
  }
}

export class UnauthorizedError extends Error {
  constructor(message = "invalid or missing gateway API key") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export async function authenticate(
  registry: PrincipalRegistry,
  authorizationHeader: string | undefined,
): Promise<Principal> {
  const apiKey = extractBearerToken(authorizationHeader);
  if (!apiKey) throw new UnauthorizedError();
  const principal = await registry.resolve(apiKey);
  if (!principal) throw new UnauthorizedError();
  return principal;
}

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}
