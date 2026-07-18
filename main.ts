// OAuth relay — transparent HTTP tunnel for OAuth token + userinfo calls.
//
// The relay forwards requests from a region that cannot reach OAuth providers
// directly (e.g. Google, Linux.do) to those providers via a Deno Deploy edge
// function. It is generic and provider-agnostic — the upstream table is a
// plain allow-list and any new provider can be added by appending one entry.
//
// Design notes (security model)
// -----------------------------
// 1. The relay stores NOTHING. Every request body and header is forwarded
//    verbatim. client_id / client_secret live in the calling application and
//    transit through this process only as URL-encoded form fields or a Basic
//    Authorization header.
// 2. The relay only forwards to a fixed allow-list of upstream hosts. Any
//    path / method outside the table returns 404 immediately.
// 3. A shared secret (`RELAY_SHARED_SECRET`) gates the endpoint. Without a
//    matching `X-Relay-Token` header the relay returns 401 and never opens
//    a socket to the upstream.
// 4. CORS preflights are answered only for allow-listed origins. Empty
//    allow-list disables CORS entirely (curl / same-origin only).
//
// Routes
// ------
//   POST  /oauth/github/token       -> https://github.com/login/oauth/access_token
//   GET   /oauth/github/userinfo    -> https://api.github.com/user
//   POST  /oauth/google/token       -> https://oauth2.googleapis.com/token
//   GET   /oauth/google/userinfo    -> https://openidconnect.googleapis.com/v1/userinfo
//   POST  /oauth/linuxdo/token      -> https://connect.linux.do/oauth2/token
//   GET   /oauth/linuxdo/userinfo   -> https://connect.linux.do/api/user
//   GET   /healthz                  -> liveness probe (no upstream call)
//
// Anything else returns 404 — there is no catch-all, no proxy mode.
//
// Adding a new provider
// ---------------------
// Append two entries to UPSTREAM_TABLE below, one for the token endpoint
// (POST) and one for the userinfo endpoint (GET). Set the corresponding
// `<PROVIDER>_TOKEN_UPSTREAM` / `<PROVIDER>_USERINFO_UPSTREAM` env vars
// if you need to override the defaults. No other code change is needed.

const RELAY_TOKEN_HEADER = "x-relay-token";
const LOG_PREFIX = "[oauth-relay]";

// ---------------------------------------------------------------------------
// Upstream table. These are the ONLY hosts this relay will ever connect to.
// Override via env vars if you mirror to staging / shadow endpoints.
// ---------------------------------------------------------------------------

const UPSTREAM_TABLE = {
  "github/token": {
    upstream:
      Deno.env.get("GITHUB_TOKEN_UPSTREAM") ?? "https://github.com/login/oauth/access_token",
    method: "POST",
  },
  "github/userinfo": {
    upstream: Deno.env.get("GITHUB_USERINFO_UPSTREAM") ?? "https://api.github.com/user",
    method: "GET",
  },
  "google/token": {
    upstream:
      Deno.env.get("GOOGLE_TOKEN_UPSTREAM") ?? "https://oauth2.googleapis.com/token",
    method: "POST",
  },
  "google/userinfo": {
    upstream: Deno.env.get("GOOGLE_USERINFO_UPSTREAM") ??
      "https://openidconnect.googleapis.com/v1/userinfo",
    method: "GET",
  },
  "linuxdo/token": {
    upstream:
      Deno.env.get("LINUXDO_TOKEN_UPSTREAM") ?? "https://connect.linux.do/oauth2/token",
    method: "POST",
  },
  "linuxdo/userinfo": {
    upstream: Deno.env.get("LINUXDO_USERINFO_UPSTREAM") ??
      "https://connect.linux.do/api/user",
    method: "GET",
  },
} as const satisfies Record<string, { upstream: string; method: "GET" | "POST" }>;

type RelayKey = keyof typeof UPSTREAM_TABLE;

// ---------------------------------------------------------------------------
// Env parsing (single source of truth, fail fast on missing required values)
// ---------------------------------------------------------------------------

function required(name: string): string {
  const v = Deno.env.get(name);
  if (!v || v.trim().length === 0) {
    console.error(`${LOG_PREFIX} FATAL: env ${name} is required`);
    Deno.exit(1);
  }
  return v;
}

const RELAY_SHARED_SECRET = required("RELAY_SHARED_SECRET");
const UPSTREAM_TIMEOUT_MS = Number(Deno.env.get("UPSTREAM_TIMEOUT_MS") ?? "10000");
const CORS_ALLOWED_ORIGINS = (Deno.env.get("CORS_ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const LOG_LEVEL = (Deno.env.get("LOG_LEVEL") ?? "info").toLowerCase();

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
const currentLevel = LOG_LEVELS[LOG_LEVEL as keyof typeof LOG_LEVELS] ?? 20;

function log(level: keyof typeof LOG_LEVELS, msg: string, fields?: Record<string, unknown>) {
  if (LOG_LEVELS[level] < currentLevel) return;
  const payload = fields ? ` ${JSON.stringify(fields)}` : "";
  console.log(`${LOG_PREFIX} ${level.toUpperCase()} ${msg}${payload}`);
}

// ---------------------------------------------------------------------------
// CORS — only for allow-listed origins. Empty allow-list = no CORS headers.
// ---------------------------------------------------------------------------

function corsHeaders(req: Request): Headers {
  const h = new Headers();
  if (CORS_ALLOWED_ORIGINS.length === 0) return h;
  const origin = req.headers.get("origin");
  if (origin && CORS_ALLOWED_ORIGINS.includes(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
    h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    h.set("Access-Control-Allow-Headers", `${RELAY_TOKEN_HEADER}, Content-Type, Authorization`);
    h.set("Access-Control-Max-Age", "600");
  }
  return h;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notFound(): Response {
  return new Response("not found", { status: 404 });
}

function unauthorized(): Response {
  return new Response("unauthorized", { status: 401 });
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Constant-time string comparison to avoid timing side-channels on the
 * shared-secret check. Both strings are normalized through TextEncoder so
 * the comparison runs over raw UTF-8 bytes of equal length.
 */
function safeEquals(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/**
 * Parse the request path into a relay key. The path must be exactly two
 * segments under `/oauth/` — provider and stage — matching a table key
 * verbatim. Anything else (empty tail, three+ segments, `..`, trailing
 * slash) is rejected so the relay cannot be coerced into a generic proxy.
 *
 *   "/oauth/google/token"      -> "google/token"
 *   "/oauth/linuxdo/userinfo"  -> "linuxdo/userinfo"
 *   "/oauth/google/token/"     -> null   (no trailing slash)
 *   "/oauth/google/token/extra"-> null   (no extra segments)
 *   "/oauth/google"            -> null   (missing stage segment)
 */
function parseRelayKey(pathname: string): RelayKey | null {
  if (!pathname.startsWith("/oauth/")) return null;
  const tail = pathname.slice("/oauth/".length);
  if (tail.length === 0 || tail.includes("..")) return null;
  if (tail.endsWith("/")) return null;
  const segments = tail.split("/");
  // Exactly two segments: "<provider>/<stage>". Anything else is not in the
  // table — the relay is intentionally dumb and must NOT fall through to a
  // generic upstream lookup.
  if (segments.length !== 2) return null;
  const [provider, stage] = segments;
  if (!provider || !stage) return null;
  const key = `${provider}/${stage}`;
  if (key in UPSTREAM_TABLE) return key as RelayKey;
  return null;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Liveness probe — never reaches upstream.
  if (url.pathname === "/healthz") {
    return new Response("ok", {
      status: 200,
      headers: { ...Object.fromEntries(corsHeaders(req)) },
    });
  }

  // CORS preflight — answer before auth so browsers can probe safely.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  // Only the two HTTP methods used by OAuth token + userinfo flows.
  if (req.method !== "GET" && req.method !== "POST") return notFound();

  const key = parseRelayKey(url.pathname);
  if (!key) return notFound();

  const route = UPSTREAM_TABLE[key];

  // Auth — every non-health request must present the shared secret.
  const presented = req.headers.get(RELAY_TOKEN_HEADER);
  if (!presented || !safeEquals(presented, RELAY_SHARED_SECRET)) {
    log("warn", "rejected request: missing or invalid relay token", {
      path: url.pathname,
      remote: req.headers.get("x-forwarded-for") ?? "unknown",
    });
    return unauthorized();
  }

  // Build the outbound request. We deliberately do NOT forward `Host`,
  // `Cookie`, or `Referer` to the upstream — those are caller-side and have
  // no meaning at the provider. Everything else (Authorization, Content-Type,
  // Accept, Accept-Language, etc.) is forwarded verbatim.
  const outboundHeaders = new Headers();
  const FORWARD_HEADER_ALLOW = new Set([
    "authorization",
    "content-type",
    "accept",
    "accept-language",
    "user-agent",
  ]);
  for (const [name, value] of req.headers.entries()) {
    if (FORWARD_HEADER_ALLOW.has(name.toLowerCase())) {
      outboundHeaders.set(name, value);
    }
  }
  // Some providers return JSON only when Accept explicitly says so.
  if (!outboundHeaders.has("accept")) {
    outboundHeaders.set("Accept", "application/json");
  }

  // Pass the request body through byte-for-byte. For POST the upstream is
  // always `application/x-www-form-urlencoded` from the GoWith api side, but
  // we don't enforce it here — the relay is intentionally dumb.
  const body = req.method === "POST" ? await req.arrayBuffer() : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  const t0 = Date.now();
  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(route.upstream, {
      method: route.method,
      headers: outboundHeaders,
      body,
      signal: controller.signal,
      // Don't let Deno follow redirects silently — we want 3xx from the
      // provider to surface as-is so the api can log it.
      redirect: "manual",
    });
  } catch (err) {
    const cause = (err as Error & { cause?: { code?: string } }).cause?.code ??
      (err as Error).name;
    log("error", "upstream call failed", {
      key,
      upstream: route.upstream,
      ms: Date.now() - t0,
      cause,
    });
    clearTimeout(timer);
    return jsonError(502, "upstream_unreachable", `upstream ${cause}`);
  } finally {
    clearTimeout(timer);
  }

  // Forward the upstream response headers verbatim, minus hop-by-hop headers
  // and Set-Cookie (the relay should not be propagating cookies that were
  // not requested for it).
  const responseHeaders = new Headers();
  const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "set-cookie",
  ]);
  for (const [name, value] of upstreamResp.headers.entries()) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) {
      responseHeaders.set(name, value);
    }
  }
  // Layer our CORS headers on top (only effective if origin matched).
  for (const [name, value] of corsHeaders(req)) responseHeaders.set(name, value);

  log("info", "relay ok", {
    key,
    upstream: route.upstream,
    status: upstreamResp.status,
    ms: Date.now() - t0,
  });

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers: responseHeaders,
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const port = Number(Deno.env.get("PORT") ?? "8000");

// Deno Deploy ignores this branch (it calls the handler directly), but we
// keep a local-listener entry point so `deno task dev` works the same way
// as production for debugging.
if (import.meta.main) {
  Deno.serve({ port, onListen: ({ port, hostname }) => {
    log("info", "listening", { port, hostname });
  } }, handle);
}
