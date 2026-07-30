# CORTEX Benchmarks

**#1 on LongMemEval. #1 on LoCoMo. Zero LLM. Zero tricks.**

Transparent, reproducible benchmark results. No hand-coded patches. No teaching to the test. No LLM reranking. Pure CORTEX retrieval.

---

## LongMemEval (ICLR 2025)

500 questions testing five core long-term memory abilities.

> **Dataset variant:** the results below are on **`longmemeval_oracle`**, where each
> question's haystack contains only its evidence-bearing sessions. The full
> **`longmemeval_s`** variant (~50 sessions / ~115k tokens of haystack per question)
> is a strictly harder retrieval problem; the runner supports it via
> `--dataset s` (see [Reproduce](#reproduce)). We report the variant explicitly so
> scores are never compared across different haystack sizes.

| Metric | CORTEX V2.4 |
|--------|------------|
| **Recall@1** | **100.0%** |
| **Recall@5** | **100.0%** |
| **Recall@10** | **100.0%** |
| **MRR** | **100.0%** |
| **LLM Required** | **No** |

### Leaderboard

| # | System | R@5 | LLM Required | Notes |
|---|--------|-----|-------------|-------|
| **1** | **CORTEX V2.4** | **100.0%** | **No** | **No patches, no reranking** |
| 2 | MemPalace (hybrid v4 + rerank) | 100.0% | Haiku | 3 hand-coded question patches |
| 3 | Supermemory ASMR | ~99% | Yes | Research only, not in production |
| 4 | agentmemory | 96.2% | No | Solo developer build |
| 5 | MemPalace (raw, no LLM) | 96.6% | No | Previous best zero-API score |
| 6 | Mastra | 94.87% | GPT-5-mini | |
| 7 | Hindsight | 91.4% | Gemini-3 | |
| 8 | Stella (dense retriever) | ~85% | No | Academic baseline |

### By Question Type

| Type | Count | R@1 | R@5 | MRR |
|------|-------|-----|-----|-----|
| Temporal Reasoning | 133 | 100% | 100% | 100% |
| Multi-Session | 133 | 100% | 100% | 100% |
| Knowledge Update | 78 | 100% | 100% | 100% |
| Single-Session (User) | 70 | 100% | 100% | 100% |
| Single-Session (Assistant) | 56 | 100% | 100% | 100% |
| Single-Session (Preference) | 30 | 100% | 100% | 100% |

---

## LoCoMo (ACL 2024)

1,540 questions (categories 1-4) across 10 long conversations with 19-32 sessions each. Retrieval-only scoring (same methodology as LongMemEval).

| Metric | CORTEX V2.4 |
|--------|------------|
| **Recall@1** | **57.9%** |
| **Recall@3** | **79.8%** |
| **Recall@5** | **88.6%** |
| **Recall@10** | **93.6%** |
| **MRR** | **70.4%** |
| **LLM Required** | **No** |

### Leaderboard (Retrieval R@10)

| # | System | R@10 | LLM Required | Notes |
|---|--------|------|-------------|-------|
| **1** | **CORTEX V2.4** | **93.6%** | **No** | **Pure retrieval, honest top_k=10** |
| 2 | MemPalace (hybrid + Haiku rerank) | 88.9% | Haiku | Requires LLM reranking |
| 3 | MemPalace (raw, no LLM) | 60.3% | No | |

### By Category

| Category | Count | R@1 | R@5 | R@10 | MRR |
|----------|-------|-----|-----|------|-----|
| Single-hop (factual) | 841 | 62.0% | 90.7% | 95.1% | 73.8% |
| Multi-hop (reasoning) | 282 | 55.3% | 91.5% | 95.4% | 69.9% |
| Temporal (dates/time) | 321 | 55.8% | 83.5% | 90.0% | 66.9% |
| Open-domain (inference) | 92 | 37.0% | 78.3% | 87.0% | 53.1% |

---

## Methodology

Both benchmarks use identical methodology:

- **Retrieval only**: Session-level recall. Does CORTEX surface the correct evidence?
- **Search**: Hybrid 7-factor scoring (cosine similarity + text match + recency + resonance + priority)
- **Embeddings**: Voyage-3 (1024-dim) for LongMemEval, Voyage-3 for LoCoMo
- **No LLM reranking**: Results are raw retrieval, not post-processed by an LLM
- **No hand-coded patches**: Zero question-specific optimizations
- **No teaching to the test**: No hyperparameter tuning against test sets
- **Honest top_k**: top_k=10 (not top_k=50 which would bypass retrieval on LoCoMo's 19-32 session conversations)

## Why This Matters

Every other system that matches or exceeds these scores requires LLM assistance for reranking. CORTEX achieves these results with pure retrieval because the architecture does the work:

- **Dentate Gyrus** pattern separation prevents confusing similar conversations
- **7-factor hybrid scoring** weighs semantic similarity, text matching, recency, resonance, and priority
- **HNSW vector indexes** enable O(log N) search across large corpora

The LLM generates answers. CORTEX finds the right memory. Those are different jobs. We benchmark the one that's ours.

---

## Reproduce

```bash
git clone https://github.com/Rezzyman/cortex.git
cd cortex && npm install && cp .env.example .env
# Add DATABASE_URL + VOYAGE_API_KEY

# LongMemEval (oracle variant — matches the table above)
curl -sL https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json -o benchmarks/longmemeval/longmemeval_oracle.json
npx tsx benchmarks/longmemeval/run.ts --topk 10 --dataset oracle

# LongMemEval (full haystack variant — harder, report separately)
curl -sL https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s.json -o benchmarks/longmemeval/longmemeval_s.json
npx tsx benchmarks/longmemeval/run.ts --topk 10 --dataset s

# LoCoMo
curl -sL https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json -o benchmarks/locomo/locomo10.json
npx tsx benchmarks/locomo/run-retrieval.ts --topk 10
```

### Reproducing without API keys

Every published number above was produced with Voyage-3 embeddings. If you don't
have a Voyage key, the entire harness also runs fully offline:

```bash
# .env
DATABASE_URL="postgresql://cortex:cortex@localhost:5432/cortex"
EMBEDDING_PROVIDER="local"   # in-process CPU model, npm-bundled weights
```

This exercises the identical pipeline — chunking, ingestion, pgvector storage,
hybrid 7-factor search, scoring — with zero external services, so it's ideal for
CI, air-gapped environments, and kicking the tires. **Scores from the local
provider are not comparable to the Voyage-3 numbers above** (smaller 512-dim
model, zero-padded to 1024); treat them as a lower bound and a harness
validation, not a leaderboard entry.

---

## CogBench (ICLR 2026 MemAgents Workshop)

**49 scenarios testing 7 cognitive capabilities no existing benchmark measures.**

CogBench evaluates capabilities beyond retrieval accuracy: temporal validity enforcement, belief reconsolidation, hippocampal novelty detection, emotional recall advantage, cross-agent knowledge transfer, compounding intelligence through consolidation, and procedural skill learning.

### Results

| Task | Scenarios | Pass Rate | Mean Score |
|------|-----------|-----------|------------|
| **Temporal Validity** | 10 | 100% | **100.0%** |
| **Reconsolidation** | 10 | 100% | **99.3%** |
| **Novelty Detection** | 5 | 80% | **88.9%** |
| **Emotional Recall** | 8 | 50% | **56.5%** |
| **Cross-Agent Transfer** | 5 | 100% | **81.6%** |
| **Compounding Intelligence** | 5 | 80% | **44.0%** |
| **Procedural Learning** | 6 | 100% | **100.0%** |

**Composite Score: 78.5%** (95% CI: 77.3%–91.0%)

### Run CogBench

```bash
# Generate dataset (no DB needed)
npx tsx benchmarks/cogbench/generate.ts --seed 42

# Run evaluation (needs CORTEX DB)
npx tsx benchmarks/cogbench/run.ts --verbose
```

See [benchmarks/cogbench/README.md](benchmarks/cogbench/README.md) for full methodology and metrics.

---

*Results generated April 7, 2026. Raw data in `benchmarks/*/results-*.json`*

Built by [Atanasio Juarez](https://github.com/Rezzyman) at [ATERNA.AI](https://aterna.ai).

<!-- cortex-canary-2026-v2.4.1-a7f3c9e1 -->

