import { clientLogger } from "./logger";

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = options.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });
  } catch (caught) {
    clientLogger.error("API request could not be completed", {
      method,
      path,
      error: caught instanceof Error ? caught.message : String(caught),
    });
    throw caught;
  }
  if (!response.ok) {
    clientLogger.warn("API request returned an error", {
      method,
      path,
      status: response.status,
      statusText: response.statusText,
    });
    const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
    throw new Error(body.error || body.message || `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export function apiGet<T>(path: string) {
  // Detail pages reload immediately after mutations. Do not allow a browser's
  // HTTP cache to return the pre-mutation representation for that reload.
  return apiRequest<T>(path, { cache: "no-store" });
}

export function apiPost<T>(path: string, body?: unknown) {
  return apiRequest<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
}

export function apiPatch<T>(path: string, body: unknown) {
  return apiRequest<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

export function apiDelete<T>(path: string) {
  return apiRequest<T>(path, { method: "DELETE" });
}
