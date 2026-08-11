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
  const trimmedPath = pathname.trim();
  if (trimmedPath.startsWith("//")) throw new Error("Integration request path must be relative.");
  const relativePath = trimmedPath.replace(/^\/+/, "");
  if (/^[a-z][a-z\d+.-]*:/i.test(relativePath)) throw new Error("Integration request path must be relative.");
  const url = new URL(relativePath, base.href.endsWith("/") ? base : `${base}/`);
  if (url.origin !== base.origin) throw new Error("Integration request path must remain on the configured origin.");
  return url;
}

/**
 * API keys are attached to these requests. Refusing redirects prevents a configured
 * integration from forwarding that credential to a different origin.
 */
export function fetchIntegration(url: URL, options: RequestInit = {}): Promise<Response> {
  const timeout = AbortSignal.timeout(15_000);
  return fetch(url, {
    ...options,
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    redirect: "error",
  });
}
