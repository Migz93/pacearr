/**
 * Builds URLs for administrator-configured integrations. Credentials must only ever be
 * sent to an explicit HTTP(S) origin, rather than accepting URL schemes or embedded
 * credentials that make a misconfiguration difficult to diagnose.
 */
export function buildIntegrationUrl(baseUrl: string, pathname: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error("Integration URL must be a valid HTTP(S) URL.");
  }
  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password || base.search || base.hash) {
    throw new Error("Integration URL must be an HTTP(S) URL without credentials, query parameters, or fragments.");
  }
  return new URL(pathname.replace(/^\/+/, ""), base.href.endsWith("/") ? base : `${base}/`);
}

/**
 * API keys are attached to these requests. Refusing redirects prevents a configured
 * integration from forwarding that credential to a different origin.
 */
export function fetchIntegration(url: URL, options: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...options, redirect: "error" });
}
