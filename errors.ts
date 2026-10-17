function details(error: any, seen = new Set<any>()): { messages: string[]; codes: string[] } {
  if (error == null || seen.has(error)) return { messages: [], codes: [] };
  seen.add(error);
  if (typeof error === "string") {
    try { return details(JSON.parse(error), seen); } catch {}
    return { messages: [error], codes: [] };
  }
  if (typeof error !== "object") return { messages: [], codes: [] };
  const messages: string[] = [];
  const codes = [error.code, error.statusCode, error.status].filter(value => typeof value === "string" || typeof value === "number").map(String);
  // Do not stringify the whole request/error: it can contain auth or conversation data.
  for (const key of ["message", "error", "data", "cause", "responseBody"]) {
    const nested = details(error[key], seen);
    messages.push(...nested.messages);
    codes.push(...nested.codes);
  }
  return { messages, codes };
}

export function isHeaderTimeout(error: any): boolean {
  return details(error).codes.includes("UND_ERR_HEADERS_TIMEOUT");
}

export function rateLimitError(error: any, retryAt?: number): Error | undefined {
  if (error instanceof Error && error.message.startsWith("OpenCode upstream rate limit")) return error;
  const { messages, codes } = details(error);
  if (!codes.includes("429") && !messages.some(message => /rate[ _-]?limit|too many requests|quota (?:has been )?exceeded|free usage exceeded/i.test(message))) return;
  const seconds = typeof retryAt === "number" && retryAt > Date.now() ? Math.ceil((retryAt - Date.now()) / 1000) : undefined;
  return new Error(`OpenCode upstream rate limit${codes.includes("429") ? " (HTTP 429)" : ""}: Rate limit exceeded. Retry later or switch models. ${seconds ? `OpenCode would retry in about ${seconds} seconds; this is not the quota reset time.` : "The upstream did not provide a reset time."}`);
}

export function formatOpenCodeError(error: any): Error {
  const limited = rateLimitError(error);
  if (limited) return limited;
  const { messages, codes } = details(error);
  if (codes.includes("UND_ERR_HEADERS_TIMEOUT")) return new Error("OpenCode local connection timed out waiting for response headers (UND_ERR_HEADERS_TIMEOUT). This is not a confirmed rate limit. Retry or cancel the long-running request.");
  if (codes.includes("UND_ERR_BODY_TIMEOUT")) return new Error("OpenCode local response stream timed out (UND_ERR_BODY_TIMEOUT). Check the service or network.");
  if (codes.includes("ECONNREFUSED")) return new Error("Cannot connect to the local OpenCode service (ECONNREFUSED): the service is not running or has exited.");
  const text = [...new Set(messages)].join("；") || String(error);
  const safe = text.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]").replace(/\bsk[-_][A-Za-z0-9_-]+/g, "[REDACTED]");
  return new Error(`${safe}${codes.length ? ` (${[...new Set(codes)].join(", ")})` : ""}`.slice(0, 1000));
}
