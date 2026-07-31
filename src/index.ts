import express from "express";
import cors from "cors";
import "dotenv/config";
import { initDatabase } from "./db/index.js";
import { searchRouter } from "./api/search.js";
import { recallRouter } from "./api/recall.js";
import { ingestRouter } from "./api/ingest.js";
import { ingestFileRouter } from "./api/ingest-file.js";
import { ingestRawRouter } from "./api/ingest-raw.js";
import { healthRouter } from "./api/health.js";
import { reconsolidateRouter } from "./api/reconsolidate.js";
import { proceduralRouter } from "./api/procedural.js";
import { graphRouter } from "./api/graph.js";
import { dreamRouter } from "./api/dream.js";
import { verifyFirebaseIdToken } from "./api/firebase-auth.js";
import { verifyTicket } from "./api/ticket.js";
import { verifyWinnstormUpload } from "./api/winnstorm-upload.js";
import { assertRequiredEnvironment, enforceAgentScope, requireServiceToken, secretMatches } from "./api/security.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3100", 10);
const HOST = process.env.HOST || "127.0.0.1";

// CORS — allow the WinnStorm portal (winnstorm.com + subdomains + its Vercel
// preview domains) to upload directly from the browser. Reflects the request
// origin when it matches; otherwise falls back to permissive for non-browser
// (server-to-server) callers that send no Origin.
const ALLOWED_ORIGIN = /^https?:\/\/([a-z0-9-]+\.)*(winnstorm\.com|vercel\.app)$/i;
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGIN.test(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Filename", "X-Source", "X-Caption", "X-Agent-Id"],
    maxAge: 86400,
  })
);
app.use(express.json({ limit: "25mb" }));

// Ingest auth gate. A request is authorized if EITHER:
//   (a) it presents the static CORTEX_INGEST_TOKEN (server-to-server), or
//   (b) it presents a valid Firebase ID token for the WinnStorm project
//       (browser uploads by a signed-in portal user — no static secret in the
//       client, and no Vercel function size cap on the path).
// When CORTEX_INGEST_TOKEN is unset, internal localhost calls pass through.
const INGEST_TOKEN = process.env.CORTEX_INGEST_TOKEN;
async function requireIngestToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const header = (req.headers["authorization"] as string) || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token && secretMatches(token, process.env.CORTEX_SERVICE_TOKEN || "")) {
    req.cortexPrincipal = { id: "meridian-runtime", trust: "runtime" };
    return next();
  }
  if (token && secretMatches(token, INGEST_TOKEN || "")) {
    req.cortexPrincipal = { id: "internal-ingest", trust: "operator" };
    return next();
  }
  if (token) {
    // WinnStorm portal direct-upload token — validated via callback to the
    // portal (no shared secret). Most common path for Eric's uploads.
    if (token.startsWith("ws1.")) {
      const ws = await verifyWinnstormUpload(token);
      if (ws) {
        (req as any).winnstormUpload = ws;
        req.cortexPrincipal = { id: "winnstorm:upload", trust: "external" };
        return next();
      }
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    // Short-lived HMAC upload ticket (alternative server-minted path).
    const ticket = verifyTicket(token);
    if (ticket) {
      (req as any).winnstormTicket = ticket;
      req.cortexPrincipal = { id: "winnstorm:ticket", trust: "external" };
      return next();
    }
    // Firebase ID token (main app / iOS signed-in users).
    const user = await verifyFirebaseIdToken(token);
    if (user) {
      (req as any).winnstormUser = user;
      req.cortexPrincipal = { id: `firebase:${user.uid}`, trust: "external" };
      return next();
    }
  }
  res.status(401).json({ error: "unauthorized" });
}

// Routes
app.use("/api/v1/search", requireServiceToken, enforceAgentScope, searchRouter);
app.use("/api/v1/recall", requireServiceToken, enforceAgentScope, recallRouter);
// Streaming large-file route: mounted BEFORE json parsing so the raw body
// streams to disk (no size cap). express.json only buffers application/json,
// so it won't touch these binary/text uploads, but mounting explicitly is clearer.
app.use("/api/v1/ingest/raw", requireIngestToken, enforceAgentScope, ingestRawRouter);
app.use("/api/v1/ingest/file", requireIngestToken, enforceAgentScope, ingestFileRouter);
app.use("/api/v1/ingest", requireIngestToken, enforceAgentScope, ingestRouter);
app.use("/api/v1/reconsolidate", requireServiceToken, enforceAgentScope, reconsolidateRouter);
app.use("/api/v1/procedural", requireServiceToken, enforceAgentScope, proceduralRouter);
app.use("/api/v1/graph", requireServiceToken, enforceAgentScope, graphRouter);
app.use("/api/v1/dream", requireServiceToken, enforceAgentScope, dreamRouter);
app.use("/api/v1/status", requireServiceToken, enforceAgentScope);
app.use("/api/v1", healthRouter);

// Root
app.get("/", (_req, res) => {
  res.json({
    service: "CORTEX V2",
    description: "Synthetic cognition infrastructure for AI agents",
    version: "2.2.0",
    endpoints: {
      health: "GET /api/v1/health",
      status: "GET /api/v1/status",
      search: "POST /api/v1/search",
      recall: "POST /api/v1/recall",
      ingest: "POST /api/v1/ingest",
      reconsolidate: "POST /api/v1/reconsolidate",
      labileMemories: "GET /api/v1/reconsolidate/labile?agentId=xxx",
      proceduralStore: "POST /api/v1/procedural",
      proceduralRetrieve: "POST /api/v1/procedural/retrieve",
      proceduralExecute: "POST /api/v1/procedural/:id/execute",
      proceduralRefine: "PATCH /api/v1/procedural/:id",
      graph: "GET /api/v1/graph?agentId=xxx",
      dream: "POST /api/v1/dream",
    },
  });
});

// Start
async function start() {
  assertRequiredEnvironment();
  try {
    await initDatabase();
    console.log("[cortex] Database connected");
  } catch (err) {
    console.error("[cortex] Database connection failed:", err);
    console.log("[cortex] Starting without database — some endpoints will fail");
  }

  app.listen(PORT, HOST, () => {
    console.log(`[cortex] CORTEX V2 running on http://${HOST}:${PORT}`);
  });
}

start();

export default app;
