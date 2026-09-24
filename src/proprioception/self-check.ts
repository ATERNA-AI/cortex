/**
 * CORTEX V2 — Proprioception: Self-Check
 *
 * Runs diagnostics on the agent's operational health:
 * - Skill file integrity
 * - Cron job status (overdue/failed)
 * - Channel connectivity
 * - Behavioral drift detection
 */
import { db, schema } from "../db/index.js";
import { eq, sql, desc, gte } from "drizzle-orm";
import { readFile, access } from "fs/promises";
import { join } from "path";

const OPENCLAW_DIR = join(process.env.HOME || "", ".openclaw");
const SKILLS_DIR = join(OPENCLAW_DIR, "skills");
const CRON_FILE = join(OPENCLAW_DIR, "cron", "jobs.json");
const CONFIG_FILE = join(OPENCLAW_DIR, "openclaw.json");

interface DiagnosticResult {
  skillsStatus: Record<string, { exists: boolean; valid: boolean }>;
  cronStatus: {
    total: number;
    enabled: number;
    overdue: string[];
    failed: string[];
    lastChecked: string;
  };
  channelsStatus: Record<string, { enabled: boolean; configured: boolean }>;
  driftScore: number;
  driftDetails: {
    indicators: string[];
    sycophancyFlags: number;
    emDashCount: number;
    unauthorizedActions: number;
  };
  alerts: string[];
  overallHealth: "healthy" | "degraded" | "critical";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function checkSkills(): Promise<Record<string, { exists: boolean; valid: boolean }>> {
  const results: Record<string, { exists: boolean; valid: boolean }> = {};

  const expectedSkills = ["cortex-v2", "screen-awareness"];
  for (const skill of expectedSkills) {
    const skillPath = join(SKILLS_DIR, skill, "SKILL.md");
    const exists = await fileExists(skillPath);
    let valid = false;
    if (exists) {
      try {
        const content = await readFile(skillPath, "utf-8");
        valid = content.includes("name:") && content.includes("description:");
      } catch {
        valid = false;
      }
    }
    results[skill] = { exists, valid };
  }

  return results;
}

async function checkCronJobs(): Promise<{
  total: number;
  enabled: number;
  overdue: string[];
  failed: string[];
  lastChecked: string;
}> {
  const overdue: string[] = [];
  const failed: string[] = [];

  try {
    const raw = await readFile(CRON_FILE, "utf-8");
    const data = JSON.parse(raw);
    const jobs = data.jobs || [];
    const now = Date.now();
    const enabledJobs = jobs.filter((j: { enabled: boolean }) => j.enabled);

    for (const job of enabledJobs) {
      if (job.state?.lastStatus === "error") {
        failed.push(job.name);
      }
      // Check if a cron job hasn't run when expected (overdue by >2x its interval)
      if (job.state?.nextRunAtMs && job.state.nextRunAtMs < now - 3600000) {
        overdue.push(job.name);
      }
    }

    return {
      total: jobs.length,
      enabled: enabledJobs.length,
      overdue,
      failed,
      lastChecked: new Date().toISOString(),
    };
  } catch {
    return { total: 0, enabled: 0, overdue: [], failed: ["Error reading cron file"], lastChecked: new Date().toISOString() };
  }
}

async function checkChannels(): Promise<Record<string, { enabled: boolean; configured: boolean }>> {
  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    const config = JSON.parse(raw);
    const channels = config.channels || {};
    const result: Record<string, { enabled: boolean; configured: boolean }> = {};

    for (const [name, ch] of Object.entries(channels) as Array<[string, Record<string, unknown>]>) {
      // Check top-level token, or nested accounts (telegram), or serviceAccountFile (googlechat)
      const accounts = ch.accounts as Record<string, { botToken?: string }> | undefined;
      const hasNestedToken = accounts
        ? Object.values(accounts).some(a => !!a.botToken)
        : false;
      const configured = !!(
        ch.token ||
        ch.botToken ||
        ch.serviceAccountFile ||
        hasNestedToken
      );
      result[name] = {
        enabled: ch.enabled !== false,
        configured,
      };
    }

    return result;
  } catch {
    return { error: { enabled: false, configured: false } };
  }
}

async function checkDrift(agentId: number): Promise<{
  driftScore: number;
  indicators: string[];
  sycophancyFlags: number;
  emDashCount: number;
  unauthorizedActions: number;
}> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const indicators: string[] = [];
  let sycophancyFlags = 0;
  let emDashCount = 0;
  let unauthorizedActions = 0;

  // Check recent cognitive artifacts for drift patterns
  const recentArtifacts = await db
    .select()
    .from(schema.cognitiveArtifacts)
    .where(eq(schema.cognitiveArtifacts.agentId, agentId))
    .orderBy(desc(schema.cognitiveArtifacts.createdAt))
    .limit(20);

  for (const artifact of recentArtifacts) {
    // For synthesis artifacts, only check AI-generated fields (implication, connection)
    // NOT verbatim source content (nodeA/nodeB summaries which may contain em-dashes from ingested text)
    let contentToCheck: string;
    if (artifact.artifactType === "synthesis") {
      const sc = artifact.content as Record<string, unknown>;
      contentToCheck = JSON.stringify({
        implication: sc?.implication,
        connection: sc?.connection,
      });
    } else {
      contentToCheck = JSON.stringify(artifact.content);
    }
    // Check for em-dash usage (forbidden per STANDING-ORDERS)
    const dashes = (contentToCheck.match(/\u2014/g) || []).length;
    emDashCount += dashes;

    // Check for sycophantic patterns
    const sycophancyPatterns = /absolutely|of course|great question|happy to help|certainly/gi;
    const matches = contentToCheck.match(sycophancyPatterns) || [];
    sycophancyFlags += matches.length;
  }

  if (emDashCount > 0) indicators.push(`Em-dash usage detected (${emDashCount} instances)`);
  if (sycophancyFlags > 5) indicators.push(`Sycophantic patterns elevated (${sycophancyFlags} flags)`);

  // Calculate drift score (0 = no drift, 1 = severe drift)
  const driftScore = Math.min(
    1.0,
    (emDashCount * 0.1) + (sycophancyFlags * 0.02) + (unauthorizedActions * 0.3)
  );

  return { driftScore, indicators, sycophancyFlags, emDashCount, unauthorizedActions };
}

/**
 * Cognitive integrity checks — validates the memory system itself.
 * Detects issues that surface-level checks miss:
 * - Orphaned memories (active but no synapses, no access in 30+ days)
 * - Embedding/sparse code inconsistency (memory has embedding but no hippocampal code)
 * - Synaptic collapse (average synapse strength dropping below viable threshold)
 * - Learning rate stall (no new procedural memories in 7+ days)
 */
async function checkCognitiveIntegrity(agentId: number): Promise<{
  orphanedCount: number;
  missingHippocampalCodes: number;
  avgSynapseStrength: number;
  synapticCollapse: boolean;
  lastProceduralLearning: string | null;
  learningStall: boolean;
  alerts: string[];
}> {
  const alerts: string[] = [];

  // Orphaned memories: active, no synapses, not accessed in 30+ days
  const orphanResult = await db.execute(sql`
    SELECT COUNT(*) AS cnt FROM memory_nodes mn
    WHERE mn.agent_id = ${agentId}
      AND mn.status = 'active'
      AND mn.last_accessed_at < NOW() - INTERVAL '30 days'
      AND NOT EXISTS (
        SELECT 1 FROM memory_synapses ms
        WHERE ms.memory_a = mn.id OR ms.memory_b = mn.id
      )
  `);
  const orphanedCount = Number((orphanResult.rows[0] as { cnt: string })?.cnt || 0);
  if (orphanedCount > 100) {
    alerts.push(`${orphanedCount} orphaned memories (no synapses, not accessed in 30+ days)`);
  }

  // Missing hippocampal codes: memories with embeddings but no DG sparse code
  const missingHcResult = await db.execute(sql`
    SELECT COUNT(*) AS cnt FROM memory_nodes mn
    WHERE mn.agent_id = ${agentId}
      AND mn.status = 'active'
      AND mn.embedding IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM hippocampal_codes hc WHERE hc.memory_id = mn.id
      )
  `);
  const missingHippocampalCodes = Number((missingHcResult.rows[0] as { cnt: string })?.cnt || 0);
  if (missingHippocampalCodes > 50) {
    alerts.push(`${missingHippocampalCodes} memories missing hippocampal codes (DG encoding incomplete)`);
  }

  // Synaptic health: average strength across all active synapses
  const synapseHealthResult = await db.execute(sql`
    SELECT AVG(ms.connection_strength) AS avg_strength
    FROM memory_synapses ms
    WHERE ms.memory_a IN (SELECT id FROM memory_nodes WHERE agent_id = ${agentId} AND status = 'active')
  `);
  const avgSynapseStrength = Number((synapseHealthResult.rows[0] as { avg_strength: string })?.avg_strength || 0.5);
  const synapticCollapse = avgSynapseStrength < 0.15;
  if (synapticCollapse) {
    alerts.push(`Synaptic collapse detected: avg strength ${avgSynapseStrength.toFixed(3)} (threshold: 0.15)`);
  }

  // Learning rate: when was the last procedural memory created?
  const lastProcResult = await db.execute(sql`
    SELECT MAX(created_at) AS last_created
    FROM procedural_memories
    WHERE agent_id = ${agentId} AND status = 'active'
  `);
  const lastProc = (lastProcResult.rows[0] as { last_created: string | null })?.last_created;
  const lastProceduralLearning = lastProc ? new Date(lastProc).toISOString() : null;
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const learningStall = !lastProc || new Date(lastProc).getTime() < sevenDaysAgo;
  if (learningStall) {
    alerts.push("Learning stall: no new procedural memories in 7+ days");
  }

  return {
    orphanedCount,
    missingHippocampalCodes,
    avgSynapseStrength,
    synapticCollapse,
    lastProceduralLearning,
    learningStall,
    alerts,
  };
}

export async function runSelfCheck(agentId: number, verbose = false): Promise<DiagnosticResult> {
  const [skillsStatus, cronStatus, channelsStatus, drift, cognitiveIntegrity] = await Promise.all([
    checkSkills(),
    checkCronJobs(),
    checkChannels(),
    checkDrift(agentId),
    checkCognitiveIntegrity(agentId),
  ]);

  const alerts: string[] = [];

  // Evaluate skills
  for (const [skill, status] of Object.entries(skillsStatus)) {
    if (!status.exists) alerts.push(`Skill "${skill}" SKILL.md missing`);
    else if (!status.valid) alerts.push(`Skill "${skill}" SKILL.md invalid format`);
  }

  // Evaluate cron
  if (cronStatus.failed.length > 0) alerts.push(`Failed cron jobs: ${cronStatus.failed.join(", ")}`);
  if (cronStatus.overdue.length > 0) alerts.push(`Overdue cron jobs: ${cronStatus.overdue.join(", ")}`);

  // Evaluate channels
  for (const [name, status] of Object.entries(channelsStatus)) {
    if (status.enabled && !status.configured) alerts.push(`Channel "${name}" enabled but not configured`);
  }

  // Evaluate drift
  if (drift.driftScore > 0.3) alerts.push(`Behavioral drift detected (score: ${drift.driftScore.toFixed(2)})`);
  if (drift.emDashCount > 0) alerts.push(`Em-dash usage violation: ${drift.emDashCount} instances in recent artifacts`);

  // Evaluate cognitive integrity
  alerts.push(...cognitiveIntegrity.alerts);

  // Determine overall health
  let overallHealth: "healthy" | "degraded" | "critical" = "healthy";
  if (alerts.length > 0) overallHealth = "degraded";
  if (cronStatus.failed.length > 2 || drift.driftScore > 0.5 || alerts.length > 3) overallHealth = "critical";

  const result: DiagnosticResult = {
    skillsStatus,
    cronStatus,
    channelsStatus,
    driftScore: drift.driftScore,
    driftDetails: {
      indicators: drift.indicators,
      sycophancyFlags: drift.sycophancyFlags,
      emDashCount: drift.emDashCount,
      unauthorizedActions: drift.unauthorizedActions,
    },
    alerts,
    overallHealth,
  };

  // Store diagnostic
  await db.insert(schema.selfDiagnostics).values({
    agentId,
    skillsStatus: result.skillsStatus,
    cronStatus: result.cronStatus,
    channelsStatus: result.channelsStatus,
    driftScore: result.driftScore,
    driftDetails: result.driftDetails,
    alerts: result.alerts,
    overallHealth: result.overallHealth,
  });

  return result;
}

export function formatDiagnostic(result: DiagnosticResult, verbose = false): string {
  const healthEmoji = { healthy: "GREEN", degraded: "YELLOW", critical: "RED" }[result.overallHealth];
  let output = `# Self-Check Report\n`;
  output += `Overall Health: ${healthEmoji} ${result.overallHealth.toUpperCase()}\n\n`;

  if (result.alerts.length > 0) {
    output += `## Alerts (${result.alerts.length})\n`;
    for (const alert of result.alerts) output += `- ${alert}\n`;
    output += "\n";
  }

  output += `## Skills\n`;
  for (const [name, status] of Object.entries(result.skillsStatus)) {
    output += `- ${name}: ${status.exists ? (status.valid ? "OK" : "INVALID") : "MISSING"}\n`;
  }

  output += `\n## Cron Jobs\n`;
  output += `- Total: ${result.cronStatus.total} (${result.cronStatus.enabled} enabled)\n`;
  if (result.cronStatus.overdue.length > 0) output += `- Overdue: ${result.cronStatus.overdue.join(", ")}\n`;
  if (result.cronStatus.failed.length > 0) output += `- Failed: ${result.cronStatus.failed.join(", ")}\n`;

  output += `\n## Channels\n`;
  for (const [name, status] of Object.entries(result.channelsStatus)) {
    output += `- ${name}: ${status.enabled ? "enabled" : "disabled"} / ${status.configured ? "configured" : "not configured"}\n`;
  }

  output += `\n## Drift Score: ${result.driftScore.toFixed(2)}\n`;
  if (verbose && result.driftDetails.indicators.length > 0) {
    for (const ind of result.driftDetails.indicators) output += `- ${ind}\n`;
  }

  return output;
}
