/**
 * LoCoMo Retrieval-Only Benchmark for CORTEX
 *
 * Same methodology as our LongMemEval 500/500 run:
 * pure retrieval, no LLM, no tricks.
 *
 * For each question, checks if CORTEX retrieves chunks from
 * the correct evidence session(s). Scores Recall@K and MRR.
 *
 * This isolates CORTEX's contribution (finding the right memory)
 * from the LLM's contribution (generating the answer).
 *
 * Usage: npx tsx benchmarks/locomo/run-retrieval.ts [--topk 10] [--skip-cat5] [--conv N]
 *
 * --conv N runs only the Nth conversation (1-based) and writes a
 * per-conversation results file, so a full run can be resumed piecewise
 * on interruptible infrastructure and merged afterward.
 */
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  initBenchmark,
  clearBenchmarkData,
  ingestSession,
  search,
} from "../lib/cortex-client.js";
import {
  type QuestionResult,
  findRank,
  scoreBenchmark,
  formatScores,
} from "../lib/scorer.js";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface LoCoMoConversation {
  sample_id: string;
  conversation: Record<string, unknown>;
  qa: Array<{
    question: string;
    answer: string;
    evidence: string[];
    category: number;
  }>;
}

function extractSessions(conversation: Record<string, unknown>): Array<{
  sessionId: string;
  sessionNum: number;
  turns: Array<{ speaker: string; text: string; dia_id: string }>;
}> {
  const sessionKeys = Object.keys(conversation)
    .filter(k => k.startsWith("session_") && !k.endsWith("_date_time"))
    .sort((a, b) => parseInt(a.replace("session_", "")) - parseInt(b.replace("session_", "")));

  return sessionKeys.map(key => ({
    sessionId: key,
    sessionNum: parseInt(key.replace("session_", "")),
    turns: conversation[key] as Array<{ speaker: string; text: string; dia_id: string }>,
  }));
}

/** Extract session numbers from evidence IDs (e.g., "D1:3" -> 1, "D2:8" -> 2) */
function evidenceToSessionNums(evidence: string[]): number[] {
  const nums = new Set<number>();
  for (const ev of evidence) {
    const match = ev.match(/^D(\d+)/);
    if (match) nums.add(parseInt(match[1]));
  }
  return [...nums];
}

const args = process.argv.slice(2);
const topK = args.includes("--topk") ? parseInt(args[args.indexOf("--topk") + 1]) : 10;
const skipCat5 = args.includes("--skip-cat5");
const convArg = args.includes("--conv") ? parseInt(args[args.indexOf("--conv") + 1]) : 0;

async function main() {
  console.log("============================================");
  console.log("  CORTEX V2.4 -- LoCoMo Retrieval Benchmark");
  console.log("  Pure retrieval. No LLM. No tricks.");
  console.log("============================================");
  console.log(`Top-K: ${topK} | Skip Cat5: ${skipCat5}`);
  console.log();

  const dataFile = join(__dirname, "locomo10.json");
  let conversations: LoCoMoConversation[] = JSON.parse(readFileSync(dataFile, "utf-8"));
  console.log(`Loaded ${conversations.length} conversations\n`);

  if (convArg > 0) {
    if (convArg > conversations.length) {
      console.error(`--conv ${convArg} out of range (1-${conversations.length})`);
      process.exit(1);
    }
    conversations = [conversations[convArg - 1]];
    console.log(`Running only conversation ${convArg} (${conversations[0].sample_id})\n`);
  }

  const agentId = await initBenchmark("locomo-retrieval");
  const allResults: QuestionResult[] = [];
  const catResults: Record<number, QuestionResult[]> = {};
  let totalQuestions = 0;

  for (let ci = 0; ci < conversations.length; ci++) {
    const conv = conversations[ci];
    const sessions = extractSessions(conv.conversation);
    console.log(`\n--- Conv ${ci + 1}/${conversations.length}: ${conv.sample_id} (${sessions.length} sessions, ${conv.qa.length} questions) ---`);

    // Ingest all sessions
    await clearBenchmarkData(agentId);
    for (let si = 0; si < sessions.length; si++) {
      const session = sessions[si];
      const sessionText = session.turns
        .map(t => `[${t.speaker}] ${t.text}`)
        .join("\n");
      // Use session number as the ID so we can match against evidence
      await ingestSession(agentId, String(session.sessionNum), sessionText, "locomo");
    }
    console.log(`  Ingested ${sessions.length} sessions`);

    // Score each question (retrieval only)
    let qaList = conv.qa;
    if (skipCat5) qaList = qaList.filter(q => q.category !== 5);

    for (const qa of qaList) {
      totalQuestions++;

      // Skip cat5 (adversarial/unanswerable) for retrieval — there's no "correct" session to retrieve
      if (qa.category === 5) {
        // For cat5, a "hit" means we DON'T find strong evidence (correct abstention)
        // Skip for now — retrieval benchmarks typically exclude unanswerable questions
        continue;
      }

      // Get expected session numbers from evidence
      const expectedSessionNums = evidenceToSessionNums(qa.evidence);
      if (expectedSessionNums.length === 0) continue;

      const expectedSessionIds = expectedSessionNums.map(String);

      // Search
      const results = await search(agentId, qa.question, topK);

      // Extract session numbers from retrieved results
      // Source format: "locomo/{sessionNum}"
      const retrievedSessionIds = [...new Set(
        results.map(r => r.source?.split("/").pop() || "").filter(id => id.length > 0)
      )];

      const rank = findRank(expectedSessionIds, retrievedSessionIds);
      const hit = rank !== null;

      const result: QuestionResult = {
        questionId: `${conv.sample_id}_q${totalQuestions}`,
        question: qa.question,
        expectedSessionIds,
        retrievedSessionIds,
        rank,
        hit,
      };

      allResults.push(result);
      if (!catResults[qa.category]) catResults[qa.category] = [];
      catResults[qa.category].push(result);

      if (totalQuestions % 50 === 0 || !hit) {
        const status = hit ? "HIT" : "MISS";
        console.log(`  [${totalQuestions}] Cat${qa.category} ${status} (rank: ${rank || "-"}) | Q: "${String(qa.question).slice(0, 50)}..." | Expected sessions: ${expectedSessionIds.join(",")}`);
      }
    }
  }

  await clearBenchmarkData(agentId);

  // Score
  console.log("\n============================================");
  console.log("  RESULTS (Retrieval Only)");
  console.log("============================================\n");

  const overall = scoreBenchmark(allResults);
  console.log(formatScores("LoCoMo Retrieval (Overall)", overall));

  console.log("\n--- By Category ---\n");
  const catLabels: Record<number, string> = {
    1: "Multi-hop",
    2: "Temporal",
    3: "Open-domain",
    4: "Single-hop",
  };
  for (const cat of [1, 2, 3, 4]) {
    const results = catResults[cat] || [];
    if (results.length === 0) continue;
    const scores = scoreBenchmark(results);
    console.log(`Cat ${cat} (${catLabels[cat]}): R@1=${(scores.recallAt1 * 100).toFixed(1)}% | R@5=${(scores.recallAt5 * 100).toFixed(1)}% | R@10=${(scores.recallAt10 * 100).toFixed(1)}% | MRR=${(scores.mrr * 100).toFixed(1)}% | N=${results.length}`);
  }

  // Comparison context
  console.log("\n--- Comparison (Retrieval R@10) ---");
  console.log("MemPalace (raw, no LLM): 60.3%");
  console.log("MemPalace (hybrid + Haiku): 88.9%");
  console.log(`CORTEX V2.4 (no LLM): ${(overall.recallAt10 * 100).toFixed(1)}%`);

  // Save (per-question results included so piecewise --conv runs can be merged)
  const outputPath = join(
    __dirname,
    convArg > 0
      ? `results-retrieval-top${topK}-conv${convArg}.json`
      : `results-retrieval-top${topK}.json`
  );
  writeFileSync(outputPath, JSON.stringify({
    benchmark: "LoCoMo (Retrieval Only)",
    system: "CORTEX V2.4",
    conversation: convArg > 0 ? convArg : "all",
    embeddingProvider: process.env.EMBEDDING_PROVIDER || "ollama",
    topK,
    results: allResults,
    methodology: `Pure retrieval, no LLM. top_k=${topK} (honest, not bypassing retrieval). Same methodology as LongMemEval 500/500 run.`,
    timestamp: new Date().toISOString(),
    overall,
    byCategory: Object.fromEntries(
      [1, 2, 3, 4].map(cat => [cat, scoreBenchmark(catResults[cat] || [])])
    ),
    comparison: {
      mempalace_raw: "60.3% R@10",
      mempalace_hybrid: "88.9% R@10",
    },
  }, null, 2));
  console.log(`\nResults saved to ${outputPath}`);
}

// Explicit exit: the postgres connection pool otherwise keeps the event
// loop alive for minutes after the run completes, stalling batch scripts.
main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
