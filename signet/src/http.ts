export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Env = {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_PASSWORD?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  SENDER_NAME?: string;
  APP_BASE_URL?: string;
};

export function passwordOf(env: Env): string {
  const value = env.ADMIN_PASSWORD ?? "";
  if (value.length < 8) {
    throw new HttpError(503, "Set ADMIN_PASSWORD to at least 8 characters before signing in.");
  }
  return value;
}

export function wantsJson(request: Request): boolean {
  const type = request.headers.get("content-type") ?? "";
  const accept = request.headers.get("accept") ?? "";
  return type.includes("application/json") || accept.includes("application/json");
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const target = new URL(request.url).origin;
  if (origin && origin !== "null" && origin === target) return true;
  // A browser can send Origin: null when the page asks not to leak a referrer.
  // Sec-Fetch-Site is set by the browser and cannot be forged from another page.
  const site = request.headers.get("sec-fetch-site");
  return site === "same-origin" || site === "none";
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function html(body: string, status = 200, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  headers.set("x-frame-options", "DENY");
  headers.set(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  return new Response(body, { status, headers });
}

export function redirect(location: string, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(extraHeaders);
  headers.set("location", location);
  return new Response(null, { status: 303, headers });
}

export function pdfResponse(bytes: Uint8Array, filename: string): Response {
  const safe = filename.replace(/["\r\n]/g, "");
  return new Response(bytes, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${safe}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function matchPath(pathname: string, pattern: string): Record<string, string> | null {
  const actual = pathname.split("/").filter(Boolean);
  const expected = pattern.split("/").filter(Boolean);
  if (actual.length !== expected.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < expected.length; i++) {
    const part = expected[i] ?? "";
    const got = actual[i] ?? "";
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(got);
    else if (part !== got) return null;
  }
  return params;
}

export function appOrigin(request: Request, env: Env): string {
  const configured = env.APP_BASE_URL?.replace(/\/$/, "");
  if (configured) return configured;
  return new URL(request.url).origin;
}

export async function readBody(request: Request, limit: number): Promise<string> {
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, "That upload is too large.");
  return text;
}

export const NOTICES: Record<string, string> = {
  created: "Document added. Place fields, then send the links.",
  saved: "Saved.",
  signer: "Signer added.",
  removed: "Signer removed.",
  fields: "Fields saved.",
  sent: "Signing links are ready.",
  mailed: "Signing links are ready and the emails went out.",
  "mail-failed": "Signing links are ready. Email could not be sent, so copy the links.",
  void: "Document voided. Signing links no longer work.",
  completed: "The signed PDF is ready.",
  "complete-failed": "Everyone has signed, but the final PDF could not be built. Try again.",
};

export function noticeOf(url: URL): string | null {
  const code = url.searchParams.get("notice");
  if (!code) return null;
  return NOTICES[code] ?? null;
}
