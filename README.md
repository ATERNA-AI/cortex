# CORTEX

**Synthetic cognition infrastructure for AI agents.**

Memory that thinks. Not a vector database. Not a RAG pipeline. A cognitive architecture with learning, consolidation, decay, emotion, and reconsolidation, grounded in computational neuroscience.

---

## Why CORTEX Exists

Every AI agent has the same problem: they forget.

You can stuff context into a prompt. You can store vectors in a database and retrieve the top-K nearest neighbors. You can append conversation history until you hit the token limit and then summarize it into something that loses half the meaning. The entire industry is building elaborate workarounds for a fundamental architectural failure: AI agents don't have memory. They have search.

Memory is not search. Memory is a living system. It strengthens what matters, forgets what doesn't, consolidates patterns while you sleep, and updates beliefs when new evidence arrives. Your brain doesn't store a flat log of everything that happened to you. It builds a weighted, emotional, associative network that changes every time you access it.

That's what CORTEX is. Not a retrieval layer. A cognitive architecture.

I built this because I spent two years watching AI agents lose their minds every time a context window rolled over. I'd build something brilliant with an agent on Monday, and by Wednesday it was asking me the same questions like we'd never met. The tools existed to store information, but nothing existed to actually *remember*. To know what mattered. To notice when something contradicted what it already believed. To get better at things over time instead of starting from zero every session.

So I stopped looking for the tool and built the system. I went back to the neuroscience. Not as a metaphor, not as marketing language, but as an engineering blueprint. The hippocampus separates similar patterns so you don't confuse yesterday's meeting with last week's. The CA1 region detects novelty by comparing what arrived against what it predicted. Memories consolidate during sleep through a two-phase cycle that prunes the noise, strengthens the signal, and occasionally surfaces connections you never would have made while awake. Emotional experiences resist forgetting. Retrieved memories become temporarily malleable, so beliefs can be corrected instead of just appended.

All of this is in CORTEX. Running. In production. Powering a fleet of agents — each carrying 5,000+ active memories and 1.9 million+ synaptic connections on average — through 6+ months of uninterrupted nightly dream cycles and a 0.00 identity drift score that means the agents wake up the same people they were when they went to sleep.

This is what I think AI memory should look like. Now it's yours.

**Atanasio Juarez**, Founder, [ATERNA.AI](https://aterna.ai)

---

## At a glance

| | |
|---|---|
| **Status** | Running in production, v2.4, 6+ months |
| **Scale** | 5,000+ active memories · 1.9M+ synapses *avg per agent* |
| **Benchmarks** | [500/500 LongMemEval](BENCHMARKS.md) · [93.6% R@10 LoCoMo](BENCHMARKS.md) — zero LLM reranking |
| **Science** | [Neuroscience references](REFERENCES.md) — hippocampal indexing, CA3 autoassociative recall, reconsolidation, Ebbinghaus stability |
| **License** | Apache 2.0 |
| **Language** | TypeScript (Node 22+) · [Python port](https://github.com/Rezzyman/cortex-python) · [Zero-config SQLite version](https://github.com/Rezzyman/cortex-lite) |
| **Agents** | Any MCP client (Claude Code, Cursor, Windsurf) · REST API for everything else |

---

## What Makes CORTEX Different

Most agent memory systems store and retrieve. CORTEX **learns**.

| Feature | Vector DBs | RAG Pipelines | CORTEX |
|---------|-----------|---------------|--------|
| Store memories | Yes | Yes | Yes |
| Semantic search | Yes | Yes | Yes |
| Temporal validity (when was this true?) | No | No | **Yes** |
| Novelty detection (is this actually new?) | No | No | **Yes** |
| Memory consolidation (dream cycles) | No | No | **Yes** |
| Emotional weighting (what matters?) | No | No | **Yes** |
| Belief reconsolidation (update, don't append) | No | No | **Yes** |
| Adaptive forgetting (prune what doesn't matter) | No | No | **Yes** |
| Pattern separation (don't confuse similar memories) | No | No | **Yes** |
| Procedural learning (skills improve with practice) | No | No | **Yes** |

---

## Architecture

```
                    Ingestion Pipeline
                         |
        chunk -> embed -> entities -> valence
                         |
                 Hippocampal Encoding
                    |          |
              DG (separate)  CA1 (novelty)
                    |          |
              Sparse codes   Surprise gating
                         |
                   Memory Storage
                   (PostgreSQL + pgvector)
                         |
            +-----------+-----------+
            |           |           |
         Search      Recall     Reconsolidate
     (hybrid 7-factor) (token-budget) (labile window)
            |           |           |
            +-----------+-----------+
                         |
                   Dream Cycle (nightly)
                  |    |    |    |    |
               Resonance Prune Consolidate Associate Synthesize
                (SWS)   (SWS)   (SWS)      (REM)     (REM)
```

### Core Subsystems

**Hippocampus.** Pattern separation via Dentate Gyrus sparse coding (4096-dim expansion, 5% sparsity), CA1 novelty detection with sparse gating, CA3 autoassociative pattern completion. Two similar inputs that would confuse a cosine search get pushed apart into distinct sparse representations. This is how CORTEX avoids the "every Tuesday meeting looks the same" problem.

**Dream Cycle.** Five-phase synthetic sleep. Resonance decay (Ebbinghaus stability-adjusted), adaptive pruning (percentile-based, not hardcoded thresholds), cluster consolidation with LLM-generated abstractive summaries, free association via random activation, and synthesis of novel insights from newly formed connections. Runs nightly. Your agent wakes up smarter than it went to sleep.

**Emotional Valence.** Six-dimensional emotional vectors (valence, arousal, dominance, certainty, relevance, urgency) attached to every memory. Emotionally charged memories resist pruning and get boosted during recall. Because what matters should be harder to forget.

**Reconsolidation.** When a memory is retrieved, it enters a labile window where it can be updated with new information. The old version gets timestamped (`valid_until`) and the updated version gets marked as current (`valid_from`). Beliefs evolve. They don't just stack.

**Temporal Validity.** Every memory tracks when it was true, not just when it was stored. `valid_from`, `valid_until`, `superseded_by`. Your agent can answer "what did we believe about this last month?" and "when did that change?"

**Procedural Memory.** Skills, workflows, and habits stored in a separate, decay-resistant layer. Proficiency tracked through execution count and success rate. Your agent gets better at things it does repeatedly.

**Autonomous Cognition.** Background reasoning threads (strategic, operational, relational) that query the memory graph independently and surface insights. Your agent thinks about things even when nobody's talking to it.

**Proprioception.** Self-diagnostic system that monitors its own cognitive integrity: orphaned memories with no connections, synaptic collapse, embedding/sparse-code consistency, and learning rate stalls. The system knows when something is wrong with itself.

**Metacognition.** Reasoning traces, weekly audits with bias detection, and a feedback loop that injects corrective artifacts when inconsistencies are found. Self-reflection that actually changes future behavior.

---

## Quick Start

### Prerequisites

- Node.js 22+
- PostgreSQL 15+ with [pgvector](https://github.com/pgvector/pgvector) extension
- An embedding provider — one of:
  - VoyageAI API key (recommended, best quality; used for all published benchmarks)
  - Ollama running locally (`EMBEDDING_PROVIDER=ollama`)
  - Nothing at all: `EMBEDDING_PROVIDER=local` runs in-process on CPU with
    npm-bundled weights — zero keys, zero services, works offline

### Install

```bash
git clone https://github.com/Rezzyman/cortex.git
cd cortex
npm install
cp .env.example .env
# Edit .env with your DATABASE_URL and API keys
```

### Docker (Alternative)

```bash
cp .env.example .env
# Add your VOYAGE_API_KEY and/or ANTHROPIC_API_KEY
docker compose up
```

### Initialize Database

```bash
npm run db:push   # create the base schema (fresh databases)
npm run migrate   # apply incremental migrations + production indexes
```

### Run the MCP Server

CORTEX exposes its tools via the [Model Context Protocol](https://modelcontextprotocol.io/), making it available to any MCP-compatible agent (Claude Code, OpenClaw, custom agents):

```bash
npx tsx src/mcp/server.ts
```

Add to your agent's `.mcp.json`:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "npx",
      "args": ["tsx", "/path/to/cortex/src/mcp/server.ts"],
      "env": {
        "DATABASE_URL": "your-connection-string",
        "VOYAGE_API_KEY": "your-key"
      }
    }
  }
}
```

### Run the REST API

```bash
npx tsx src/index.ts
# Server starts on port 3100
```

---

## MCP Tools (20+)

### Core Memory
| Tool | What It Does |
|------|-------------|
| `cortex_init` | Session boot. Loads top memories, system stats, active entities. Call this first. |
| `cortex_search` | Hybrid 7-factor search across all memories |
| `cortex_recall` | Token-budget-aware retrieval. Ask for 4,000 tokens of context, get exactly that. |
| `cortex_ingest` | Store new memory. Chunks, embeds, extracts entities, encodes through hippocampus, forms synapses. |
| `cortex_status` | System health and statistics |
| `cortex_dream` | Trigger a dream cycle (full, SWS-only, REM-only, pruning-only) |

### Memory Evolution
| Tool | What It Does |
|------|-------------|
| `cortex_reconsolidate` | Update a recalled memory within its labile window |
| `cortex_labile` | List memories currently open for modification |

### Skills
| Tool | What It Does |
|------|-------------|
| `cortex_procedural_store` | Teach the agent a skill, workflow, or habit |
| `cortex_procedural_retrieve` | Find relevant procedures for a given context |

### Self-Awareness (Phases 1-6)
| Tool | What It Does |
|------|-------------|
| `cortex_self_check` | Run full cognitive integrity diagnostics |
| `cortex_journal` | Log agent state (energy, confidence, concerns) |
| `cortex_assess_state` | Infer human's energy/stress/focus from their messages |
| `cortex_bg_thread` | Run strategic, operational, or relational background reasoning |
| `cortex_synthesize` | Generate novel insights from recent synaptic connections |
| `cortex_observe` | Capture and analyze screen state (macOS) |
| `cortex_relationship` | Lookup a contact's profile, history, and open items |
| `cortex_reason` | Store a structured decision trace for audit |
| `cortex_audit` | Weekly reasoning consistency check with bias detection |
| `cortex_monologue` | Record inner thoughts (the agent's internal voice) |

---

## Search Scoring

CORTEX uses a 7-factor hybrid scoring system:

```
score = 0.50 * cosine_similarity    (semantic relevance)
      + 0.20 * text_match           (exact keyword hit)
      + 0.15 * recency              (exponential decay, 30-day half-life)
      + 0.10 * resonance            (Ebbinghaus stability-adjusted)
      + 0.05 * priority_boost       (P0=1.0 critical ... P4=0.1 ephemeral)
```

Plus CA3 pattern completion boost and emotional recall boost in `--verbose` mode. This isn't just "find the nearest vector." It's a judgment call about what's relevant right now, weighted by how important it is, how recent, and how connected to other things the agent knows.

---

## Dream Cycle

Five phases. Two stages. Inspired by real sleep neuroscience.

**SWS (Slow-Wave Sleep):**
1. **Resonance Analysis.** Ebbinghaus stability-adjusted decay across all active memories. Frequently accessed, highly connected memories resist decay.
2. **Adaptive Pruning.** Percentile-based thresholds (P5 delete, P15 archive) computed from the agent's actual resonance distribution. No hardcoded cutoffs. Safety floors prevent catastrophic pruning. P0/P1 and emotionally salient memories are always protected.
3. **Consolidation.** Connected component clustering of high-resonance memories. LLM generates abstractive summaries that capture the actual insight, not just a list of entities.

**REM (Rapid Eye Movement):**
4. **Free Association.** Random activation of memory nodes for novel cross-domain connections.
5. **Synthesis.** Generate insights from newly formed synapses. The kind of connections that only happen when you stop trying.

---

## Database

16 tables across 6 cognitive layers. PostgreSQL with pgvector.

`memory_nodes` (episodic), `memory_synapses` (associative connections), `hippocampal_codes` (DG sparse representations), `emotional_valence` (6D emotional context), `procedural_memories` (skills with proficiency), `cognitive_artifacts` (decisions, learnings, corrections), `dream_cycle_logs`, `self_diagnostics`, `agent_state_logs`, `principal_state`, `background_threads`, `relationship_graph`, `agents` (multi-agent isolation).

---

## Neuroscience

This isn't decorative. Every subsystem maps to established computational neuroscience:

- **Dentate Gyrus pattern separation**: Rolls (2013), Marr (1971)
- **CA1 predictive coding / novelty detection**: Lee et al. (2009)
- **CA3 autoassociative pattern completion**: Ramsauer et al. (2020) *Hopfield Networks is All You Need*, Rolls (2013)
- **Memory reconsolidation**: Nader et al. (2000), Lee, Nader & Schiller (2017)
- **Two-phase sleep consolidation**: Diekelmann & Born (2010), Hobson & Friston (2012)
- **Adaptive pruning / synaptic homeostasis**: Tononi & Cirelli (2014)
- **Ebbinghaus forgetting curve**: Ebbinghaus (1885), Murre & Dros (2015) — modern replication
- **Emotional valence and memory salience**: Cahill & McGaugh (1998), Russell (1980)
- **Procedural skill formation**: Anderson (1982) ACT-R framework

See [REFERENCES.md](REFERENCES.md) for DOIs, URLs, abstracts, and the mapping from each paper to the specific source file in this repo.

---

## Testing

```bash
npm test
```

34 tests covering Dentate Gyrus encoding (sparsity, determinism, normalization, pattern separation), entity extraction, and text chunking.

---

## The CORTEX ecosystem

CORTEX ships as a small family of compatible projects. Pick the one that matches how you want to integrate:

| Project | Language | Storage | Audience | Install |
|---|---|---|---|---|
| **[cortex](https://github.com/Rezzyman/cortex)** (this repo) | TypeScript (Node 22+) | PostgreSQL + pgvector | Production agent teams · benchmark-certified retrieval · MCP and REST | `git clone` + Docker Compose |
| **[cortex-lite](https://github.com/Rezzyman/cortex-lite)** | Python 3.10+ | SQLite (one file) | Individual developers · zero-config · local embeddings · 30-second quickstart | `pip install cortex-lite` |
| **[cortex-python](https://github.com/Rezzyman/cortex-python)** | Python 3.10+ | PostgreSQL + pgvector (shares schema with this repo) | Python agent codebases that need to read and write the same memory store as a TypeScript CORTEX deployment | `pip install cortex-ai` |

**Choose cortex** for the full benchmark-certified stack with dream cycles, CA3 pattern completion, reconsolidation, emotional valence, procedural learning, and autonomous cognition threads.

**Choose cortex-lite** to get the hybrid-search pattern running in under a minute with zero infrastructure. Graduate to full cortex when you need dream cycles or scale past ~10K memories.

**Choose cortex-python** when your agent code is already Python and you need first-class read/write access to a CORTEX memory store. cortex-python implements the core subsystems (hippocampus, dream cycle, procedural memory, hybrid search) and is schema-compatible with this flagship repo.

---

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md).

Priority areas: additional benchmarks, entity resolution, temporal reasoning queries, additional embedding providers, expanded test coverage, and bringing cortex-python to full parity with the TypeScript flagship.

---

## License

Apache 2.0. See [LICENSE](LICENSE).

---

Built by [Atanasio Juarez](https://github.com/Rezzyman) at [ATERNA.AI](https://aterna.ai).
