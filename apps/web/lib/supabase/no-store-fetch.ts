/** Operational rows must never enter Next's persistent fetch cache. */
export function fetchOperationalData(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, cache: "no-store" });
}
