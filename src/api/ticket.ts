import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived upload tickets for browser-direct ingest.
 *
 * The WinnStorm portal server (which holds the shared secret) mints a ticket
 * for a signed-in team member; the browser then streams a file straight to
 * cortex with `Authorization: Bearer <ticket>`. This keeps the long-lived
 * CORTEX_INGEST_TOKEN server-side only — the browser never sees it — while
 * still allowing unlimited-size direct uploads (no Vercel function in the path).
 *
 * Ticket format: t1.<base64url(payloadJSON)>.<base64url(hmacSHA256)>
 * payload = { exp: epochSeconds, scope: "ingest", agent: "stormy" }
 */
const SECRET = process.env.CORTEX_TICKET_SECRET || "";

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export interface TicketPayload {
  exp: number;
  scope?: string;
  agent?: string;
}

export function verifyTicket(token: string): TicketPayload | null {
  if (!SECRET) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "t1") return null;
  const [, payloadB64, sigB64] = parts;

  const expected = createHmac("sha256", SECRET).update(payloadB64).digest();
  let provided: Buffer;
  try {
    provided = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return null;
  }

  try {
    const payload = JSON.parse(b64urlDecode(payloadB64).toString("utf-8")) as TicketPayload;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (payload.scope && payload.scope !== "ingest") return null;
    return payload;
  } catch {
    return null;
  }
}
