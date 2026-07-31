/**
 * Validates a WinnStorm portal direct-upload token.
 *
 * The WinnStorm team portal mints a single-use token (ws1.<docId>.<nonce>) for
 * a signed-in team member and hands it to the browser, which streams the file
 * straight here. We verify it by calling back to the WinnStorm server — no
 * shared secret lives in cortex or in the portal client. The nonce is stored
 * only on the just-created KnowledgeDocument row and expires after ~1h.
 */
const VALIDATE_URL =
  process.env.WINNSTORM_VALIDATE_URL || "https://winnstorm.com/api/team/cortex-validate";

export interface WinnstormUpload {
  agentId?: string;
  source?: string;
}

export async function verifyWinnstormUpload(
  bearer: string
): Promise<WinnstormUpload | null> {
  if (!bearer.startsWith("ws1.")) return null;
  const token = bearer.slice(4); // <docId>.<nonce>
  if (!/^\d+\.[0-9a-f]{20,}$/.test(token)) return null;
  try {
    const res = await fetch(`${VALIDATE_URL}?token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { valid?: boolean; agentId?: string; source?: string };
    if (j && j.valid === true) return { agentId: j.agentId, source: j.source };
    return null;
  } catch {
    return null;
  }
}
