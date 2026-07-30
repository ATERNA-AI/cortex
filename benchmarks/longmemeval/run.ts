/**
 * LongMemEval Benchmark Runner for CORTEX
 *
 * Evaluates CORTEX's memory retrieval on the LongMemEval benchmark:
 * 500 questions across 6 types testing information extraction,
 * multi-session reasoning, temporal reasoning, knowledge updates, and abstention.
 *
 * Methodology:
 *   1. For each question, ingest all haystack sessions into CORTEX as separate memories
 *   2. Search CORTEX with the question text
 *   3. Check if any answer_session_ids appear in the top K retrieved results
 *   4. Score Recall@K, MRR, Hit Rate
 *
 * No tricks. No teaching to the test. No hand-coded patches.
 * Raw CORTEX retrieval performance with honest scoring.
 *
 * Usage: npx tsx benchmarks/longmemeval/run.ts [--limit 50] [--topk 10] [--dataset oracle|s]
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

const __dirname = dirname(fileURLToPath(import.meta.url));

interface LongMemEvalQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: Array<Array<{ role: string; content: string; has_answer?: boolean }>>;
  answer_session_ids: string[];
}

// Parse CLI args
const args = process.argv.slice(2);
const limitArg = args.includes("--limit") ? parseInt(args[args.indexOf("--limit") + 1]) : 0;
const topK = args.includes("--topk") ? parseInt(args[args.indexOf("--topk") + 1]) : 10;
const datasetType = args.includes("--dataset") ? args[args.indexOf("--dataset") + 1] : "oracle";
const skipArg = args.includes("--skip") ? parseInt(args[args.indexOf("--skip") + 1]) : 0;

async function main() {
  console.log("============================================");
  console.log("  CORTEX V2.4 -- LongMemEval Benchmark");
  console.log("============================================");
  console.log(`Dataset: ${datasetType} | Top-K: ${topK} | Limit: ${limitArg || "all"}`);
  console.log();

  // Load dataset
  const dataFile = datasetType === "s"
    ? join(__dirname, "longmemeval_s.json")
    : join(__dirname, "longmemeval_oracle.json");

  console.log(`Loading dataset from ${dataFile}...`);
  const rawData = readFileSync(dataFile, "utf-8");
  let questions: LongMemEvalQuestion[] = JSON.parse(rawData);

  if (skipArg > 0) {
    questions = questions.slice(skipArg);
    console.log(`Skipping first ${skipArg} questions (resuming)\n`);
  }
  if (limitArg > 0) {
    questions = questions.slice(0, limitArg);
  }

  console.log(`Loaded ${questions.length} questions\n`);

  // Initialize benchmark agent
  const agentId = await initBenchmark("longmemeval");

  const allResults: QuestionResult[] = [];
  const typeResults: Record<string, QuestionResult[]> = {};
  let totalIngestTime = 0;
  let totalSearchTime = 0;

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const progress = `[${qi + 1}/${questions.length}]`;

    // Clear previous question's data (each question is independent)
    await clearBenchmarkData(agentId);

    // Ingest all haystack sessions
    const ingestStart = Date.now();
    for (let si = 0; si < q.haystack_sessions.length; si++) {
      const session = q.haystack_sessions[si];
      const sessionId = q.haystack_session_ids[si];
      const sessionDate = q.haystack_dates[si];

      // Convert session turns to a single text block
      const sessionText = session
        .map((turn) => `[${turn.role}] ${turn.content}`)
        .join("\n");

      await ingestSession(agentId, sessionId, sessionText, "longmemeval");
    }
    const ingestTime = Date.now() - ingestStart;
    totalIngestTime += ingestTime;

    // Search with the question
    const searchStart = Date.now();
    const results = await search(agentId, q.question, topK);
    const searchTime = Date.now() - searchStart;
    totalSearchTime += searchTime;

    // Extract session IDs from results (source format: "longmemeval/{sessionId}")
    const retrievedSessionIds = results
      .map((r) => r.source?.split("/").pop() || "")
      .filter((id) => id.length > 0);

    // Deduplicate (multiple chunks from same session)
    const uniqueRetrieved = [...new Set(retrievedSessionIds)];

    // Score
    const rank = findRank(q.answer_session_ids, uniqueRetrieved);
    const hit = rank !== null;

    const result: QuestionResult = {
      questionId: q.question_id,
      question: q.question,
      expectedSessionIds: q.answer_session_ids,
      retrievedSessionIds: uniqueRetrieved,
      rank,
      hit,
    };

    allResults.push(result);

    // Track by type
    if (!typeResults[q.question_type]) typeResults[q.question_type] = [];
    typeResults[q.question_type].push(result);

    // Log progress
    const status = hit ? "HIT" : "MISS";
    console.log(
      `${progress} ${status} (rank: ${rank || "-"}) | ${q.question_type} | ingest: ${ingestTime}ms | search: ${searchTime}ms | sessions: ${q.haystack_sessions.length}`
    );
  }

  // Final cleanup
  await clearBenchmarkData(agentId);

  // Score overall
  console.log("\n============================================");
  console.log("  RESULTS");
  console.log("============================================\n");

  const overall = scoreBenchmark(allResults);
  console.log(formatScores("LongMemEval (Overall)", overall));

  // Score by type
  console.log("\n--- By Question Type ---\n");
  for (const [type, results] of Object.entries(typeResults)) {
    const typeScore = scoreBenchmark(results);
    console.log(`### ${type} (${results.length} questions)`);
    console.log(`  R@1: ${(typeScore.recallAt1 * 100).toFixed(1)}% | R@5: ${(typeScore.recallAt5 * 100).toFixed(1)}% | R@10: ${(typeScore.recallAt10 * 100).toFixed(1)}% | MRR: ${(typeScore.mrr * 100).toFixed(1)}%`);
  }

  // Timing
  console.log(`\n--- Timing ---`);
  console.log(`Total ingest: ${(totalIngestTime / 1000).toFixed(1)}s (avg: ${(totalIngestTime / questions.length / 1000).toFixed(2)}s/question)`);
  console.log(`Total search: ${(totalSearchTime / 1000).toFixed(1)}s (avg: ${(totalSearchTime / questions.length).toFixed(0)}ms/question)`);

  // Save results
  const outputPath = join(__dirname, `results-${datasetType}-top${topK}.json`);
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        benchmark: "LongMemEval",
        dataset: datasetType,
        topK,
        timestamp: new Date().toISOString(),
        system: "CORTEX V2.4",
        methodology: "Raw retrieval, no hand-coded patches, no teaching to the test",
        overall,
        byType: Object.fromEntries(
          Object.entries(typeResults).map(([type, results]) => [
            type,
            scoreBenchmark(results),
          ])
        ),
        timing: {
          totalIngestMs: totalIngestTime,
          totalSearchMs: totalSearchTime,
          avgIngestMs: totalIngestTime / questions.length,
          avgSearchMs: totalSearchTime / questions.length,
        },
      },
      null,
      2
    )
  );
  console.log(`\nResults saved to ${outputPath}`);
}

// Explicit exit: the postgres connection pool otherwise keeps the event
// loop alive for minutes after the run completes, stalling batch scripts.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
