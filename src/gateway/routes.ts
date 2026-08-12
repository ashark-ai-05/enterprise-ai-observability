/**
 * A ProviderRoute maps a gateway-facing provider name to the real MaaS
 * endpoint it forwards to. The allowlist is intentional: the gateway must
 * never become an open relay to arbitrary hosts (data-class -> provider
 * routing lives one layer up; this is the mechanical enforcement point).
 */
export interface ProviderRoute {
  readonly provider: string;
  readonly baseUrl: string;
  readonly upstreamAuthHeader: string;
  readonly upstreamApiKey: string;
}

export function resolveRoute(
  routes: readonly ProviderRoute[],
  provider: string,
): ProviderRoute | undefined {
  return routes.find((route) => route.provider === provider);
}
