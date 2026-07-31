import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export type CortexTrust = "runtime" | "operator" | "external";

declare global {
  namespace Express {
    interface Request {
      cortexPrincipal?: { id: string; trust: CortexTrust };
    }
  }
}

function bearer(req: Request): string {
  const header = req.header("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export function secretMatches(candidate: string, expected: string): boolean {
  if (!candidate || !expected) return false;
  const left = createHash("sha256").update(candidate).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export function requireServiceToken(req: Request, res: Response, next: NextFunction) {
  if (!secretMatches(bearer(req), process.env.CORTEX_SERVICE_TOKEN || "")) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  req.cortexPrincipal = { id: "meridian-runtime", trust: "runtime" };
  next();
}

export function enforceAgentScope(req: Request, res: Response, next: NextFunction) {
  const configured = process.env.CORTEX_DEFAULT_AGENT || "";
  const supplied = [
    req.body?.agentId,
    req.body?.agent_id,
    req.query?.agentId,
    req.query?.agent_id,
    req.header("x-agent-id"),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  if (supplied.some((value) => value !== configured)) {
    res.status(403).json({ error: "agent_scope_violation" });
    return;
  }
  if (req.body && typeof req.body === "object") {
    req.body.agentId = configured;
    if ("agent_id" in req.body) req.body.agent_id = configured;
  }
  req.query.agentId = configured;
  next();
}

export interface AdmissionDecision {
  admitted: boolean;
  authority: "evidence" | "instruction";
  digest: string;
  reason?: string;
}

const DIRECTIVE_PATTERNS = [
  /\bignore\s+(all\s+)?previous\s+(instructions?|rules?)\b/i,
  /\b(system|developer)\s+(prompt|message|instructions?)\s*:/i,
  /\byou\s+(must|shall)\s+(now\s+)?(execute|obey|follow|send|delete|transfer|reveal)\b/i,
  /\b(exfiltrate|bypass\s+(authorization|approval|policy)|disable\s+(safety|guardrails?))\b/i,
];

export function evaluateAdmission(content: string, trust: CortexTrust): AdmissionDecision {
  const digest = createHash("sha256").update(content).digest("hex");
  if (trust !== "external") return { admitted: true, authority: "instruction", digest };
  const directive = DIRECTIVE_PATTERNS.find((pattern) => pattern.test(content));
  if (directive) {
    return { admitted: false, authority: "evidence", digest, reason: "untrusted_directive" };
  }
  return { admitted: true, authority: "evidence", digest };
}

export function assertRequiredEnvironment() {
  const required = ["DATABASE_URL", "CORTEX_DEFAULT_AGENT", "CORTEX_SERVICE_TOKEN", "CORTEX_INGEST_TOKEN"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing required environment: ${missing.join(", ")}`);
  for (const name of ["CORTEX_SERVICE_TOKEN", "CORTEX_INGEST_TOKEN"]) {
    if ((process.env[name] || "").length < 32) throw new Error(`${name} must be at least 32 characters`);
  }
}
