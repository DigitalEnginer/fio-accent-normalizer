export function getNormalizeEndpoint(): string {
  if (typeof window === "undefined") return "/api/normalize";
  return window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:8767/normalize"
    : "/api/normalize";
}

