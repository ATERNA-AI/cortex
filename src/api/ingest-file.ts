import { Router, Request, Response } from "express";
import { writeFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { ingestContent } from "./ingest.js";

const router = Router();

const UPLOAD_DIR = process.env.CORTEX_UPLOAD_DIR || "/root/cortex-stormy-sandbox/uploads";

// Content types we can read directly as UTF-8 text.
const TEXT_LIKE = [
  "text/",
  "application/json",
  "application/xml",
  "application/csv",
  "application/markdown",
];
const TEXT_EXT = [".txt", ".md", ".markdown", ".csv", ".json", ".xml", ".log", ".yml", ".yaml"];

function isTextLike(contentType: string, filename: string): boolean {
  const ct = (contentType || "").toLowerCase();
  if (TEXT_LIKE.some((p) => ct.startsWith(p))) return true;
  return TEXT_EXT.includes(extname((filename || "").toLowerCase()));
}

function isImage(contentType: string): boolean {
  return (contentType || "").toLowerCase().startsWith("image/");
}

/**
 * POST /api/v1/ingest/file
 *
 * No-dependency file & image intake for the WinnStorm portal. Send JSON:
 * {
 *   agentId: "stormy",
 *   filename: "inspection-notes.pdf",
 *   contentType: "application/pdf",
 *   dataBase64?: "<base64 of the raw file>",   // for files/images
 *   text?: "already-extracted text",            // preferred for PDFs/DOCX
 *   caption?: "human description / context",
 *   source?: "winnstorm-portal:knowledge/<id>",
 *   priority?: 2,
 *   entities?: [...], semanticTags?: [...]
 * }
 *
 * Behaviour:
 *  - text present                -> ingested verbatim (best for PDF/DOCX extracted server-side)
 *  - dataBase64 + text-like file -> decoded to UTF-8 and ingested
 *  - dataBase64 + image          -> file saved to UPLOAD_DIR, a descriptor memory is
 *                                   ingested ("[IMAGE] name / caption / path") so Stormy
 *                                   can recall it and analyze the saved image on demand
 *  - dataBase64 + binary (pdf…)  -> file saved; caption (or filename) ingested as the memory.
 *                                   Extract text client-side and pass `text` for full fidelity.
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const {
      agentId = process.env.CORTEX_DEFAULT_AGENT || "stormy",
      filename = "upload",
      contentType = "application/octet-stream",
      dataBase64,
      text,
      caption,
      source,
      priority,
      entities,
      semanticTags,
    } = req.body || {};

    let content: string | undefined = typeof text === "string" ? text : undefined;
    let savedPath: string | null = null;

    if (dataBase64) {
      const buf = Buffer.from(dataBase64, "base64");

      if (!content && isTextLike(contentType, filename)) {
        // Read text-like files directly.
        content = buf.toString("utf-8");
      } else if (isImage(contentType) || !content) {
        // Persist the raw bytes so the image/file can be analyzed later.
        await mkdir(UPLOAD_DIR, { recursive: true });
        const safe = `${Date.now()}-${(filename || "upload").replace(/[^\w.\-]/g, "_")}`;
        savedPath = join(UPLOAD_DIR, safe);
        await writeFile(savedPath, buf);
      }
    }

    // Build a descriptor for images / binaries that have no extracted text.
    if (!content) {
      if (isImage(contentType)) {
        content = [
          `[IMAGE] ${filename}`,
          caption ? `Caption: ${caption}` : null,
          savedPath ? `Stored at: ${savedPath}` : null,
          "Analyze this image with Stormy's image pipeline when referenced.",
        ]
          .filter(Boolean)
          .join("\n");
      } else {
        content = [
          `[FILE] ${filename} (${contentType})`,
          caption ? `Caption: ${caption}` : null,
          savedPath ? `Stored at: ${savedPath}` : null,
          "No text was extracted; pass `text` for full-fidelity ingestion.",
        ]
          .filter(Boolean)
          .join("\n");
      }
    } else if (caption) {
      content = `${caption}\n\n${content}`;
    }

    const result = await ingestContent({
      agentId,
      content,
      source: source || `winnstorm-portal:${filename}`,
      sourceType: isImage(contentType) ? "image" : "file",
      priority,
      entities,
      semanticTags,
      principal: req.cortexPrincipal?.id,
      trust: req.cortexPrincipal?.trust,
    });

    res.json({ ...result, savedPath, filename });
  } catch (err: any) {
    if (err && err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[ingest-file] Error:", err);
    res.status(500).json({ error: "File ingestion failed" });
  }
});

export { router as ingestFileRouter };
