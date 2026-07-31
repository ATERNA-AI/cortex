import { Router, Request, Response } from "express";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join, extname, basename } from "node:path";
import { ingestContent } from "./ingest.js";
import { extractDocumentText, isExtractableDocument } from "./extract.js";
import { deliverToInbound } from "./inbound-delivery.js";

const router = Router();

const UPLOAD_DIR = process.env.CORTEX_UPLOAD_DIR || "/root/cortex-stormy-sandbox/uploads";
const MAX_UPLOAD_BYTES = Number(process.env.CORTEX_MAX_UPLOAD_BYTES || 64 * 1024 * 1024);

const TEXT_EXT = [".txt", ".md", ".markdown", ".csv", ".json", ".xml", ".log", ".yml", ".yaml", ".html", ".htm", ".rtf"];
function isTextLike(ct: string, filename: string): boolean {
  ct = (ct || "").toLowerCase();
  if (ct.startsWith("text/") || ct.includes("json") || ct.includes("xml") || ct.includes("csv") || ct.includes("markdown")) return true;
  return TEXT_EXT.includes(extname((filename || "").toLowerCase()));
}
function isImage(ct: string): boolean {
  return (ct || "").toLowerCase().startsWith("image/");
}

/**
 * POST /api/v1/ingest/raw
 *
 * Streaming, no-size-limit intake for the WinnStorm portal. The raw file bytes
 * are the request body (NOT base64, NOT JSON) — streamed straight to disk so
 * arbitrarily large documents/images never sit in memory. Metadata comes from
 * query params or headers:
 *   ?agentId=stormy&filename=foo.pdf&source=...&caption=...&priority=2
 *   (or X-Filename / X-Source / X-Caption headers; Content-Type = the file type)
 *
 * Behaviour:
 *  - text-like  -> file is read back and ingested as content (chunked in cortex)
 *  - image/*    -> stored on disk; a descriptor memory (name + caption + path) is
 *                  ingested so Stormy can recall and analyze it on demand
 *  - other/bin  -> stored on disk; descriptor ingested. If the caller already has
 *                  extracted text, prefer POST /api/v1/ingest/file with `text`.
 *
 * Designed for "unlimited" document/image volume: each call streams one file.
 */
router.post("/", async (req: Request, res: Response) => {
  const q = req.query as Record<string, string>;
  const h = req.headers;
  const agentId = q.agentId || (h["x-agent-id"] as string) || process.env.CORTEX_DEFAULT_AGENT || "stormy";
  const filename = q.filename || (h["x-filename"] as string) || "upload";
  const contentType = (req.headers["content-type"] as string) || "application/octet-stream";
  const source = q.source || (h["x-source"] as string) || `winnstorm-portal:${filename}`;
  const caption = q.caption || (h["x-caption"] as string) || "";
  const priority = q.priority ? Number(q.priority) : undefined;

  await mkdir(UPLOAD_DIR, { recursive: true });
  const safe = `${Date.now()}-${(filename || "upload").replace(/[^\w.\-]/g, "_")}`;
  const savedPath = join(UPLOAD_DIR, safe);

  try {
    const declaredLength = Number(req.header("content-length") || 0);
    if (declaredLength > MAX_UPLOAD_BYTES) {
      res.status(413).json({ error: "upload_too_large" });
      return;
    }
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) req.destroy(new Error("upload_too_large"));
    });
    // Stream the request body to disk — memory stays flat regardless of file size.
    await pipeline(req, createWriteStream(savedPath));
    const { size } = await stat(savedPath);

    let content: string;
    let keepFile = true;
    let sourceType = "file";
    let extraction = "raw";
    let inboundFiles: string[] = [];

    if (isExtractableDocument(contentType, filename)) {
      // PDF / DOCX — extract the REAL text so it becomes recallable, not a stub.
      // Checked BEFORE isTextLike: office MIME types contain "openxml", which
      // would otherwise be misrouted to the text branch and read as zip garbage.
      const ex = await extractDocumentText(savedPath, contentType, filename);
      extraction = ex.method;
      if (ex.ok) {
        content = [`# ${filename}`, caption ? `Caption: ${caption}` : null, "", ex.text]
          .filter(Boolean)
          .join("\n");
        inboundFiles = await deliverToInbound({
          filename,
          extractedText: ex.text,
          originalPath: savedPath,
          caption,
          source,
        });
      } else {
        // No text layer (e.g. scanned PDF). Deliver to inbound FIRST, then point the
        // descriptor at the stormy-readable inbound copy (not the root-owned upload).
        inboundFiles = await deliverToInbound({ filename, originalPath: savedPath, caption, source });
        const inboundOriginal = inboundFiles.find((p) => !p.endsWith(".txt")) || savedPath;
        content = [
          `[DOCUMENT] ${filename} (${contentType}, ${size} bytes)`,
          caption ? `Caption: ${caption}` : null,
          ex.note ? `Note: ${ex.note}` : null,
          `Inbound file: ${basename(inboundOriginal)}`,
          `Stored at: ${inboundOriginal}`,
          "No text layer could be extracted; open the exact file path above (not the directory) for manual/vision review.",
        ]
          .filter(Boolean)
          .join("\n");
      }
    } else if (isTextLike(contentType, filename)) {
      // Plain text/markdown/csv/xml/etc — ingest as-is, drop the text into inbound.
      const raw = await readFile(savedPath, "utf-8");
      content = caption ? `${caption}\n\n${raw}` : raw;
      extraction = "text";
      inboundFiles = await deliverToInbound({ filename, extractedText: raw, caption, source });
      keepFile = false; // text is now in cortex; no need to retain the raw upload
    } else if (isImage(contentType)) {
      sourceType = "image";
      // Deliver to inbound FIRST so the descriptor points the agent at a file it can
      // actually read. The root-owned uploads/ copy is unreadable by the stormy uid,
      // which previously left recalled image memories pointing at an unopenable path.
      inboundFiles = await deliverToInbound({ filename, originalPath: savedPath, caption, source });
      const inboundOriginal = inboundFiles.find((p) => !p.endsWith(".txt")) || savedPath;
      content = [
        `[IMAGE] ${filename} (${contentType}, ${size} bytes)`,
        caption ? `Caption: ${caption}` : null,
        `Inbound file: ${basename(inboundOriginal)}`,
        `Stored at: ${inboundOriginal}`,
        "Analyze this image with Stormy's vision pipeline when referenced — open the exact file path above, not the directory.",
      ]
        .filter(Boolean)
        .join("\n");
    } else {
      inboundFiles = await deliverToInbound({ filename, originalPath: savedPath, caption, source });
      const inboundOriginal = inboundFiles.find((p) => !p.endsWith(".txt")) || savedPath;
      content = [
        `[FILE] ${filename} (${contentType}, ${size} bytes)`,
        caption ? `Caption: ${caption}` : null,
        `Inbound file: ${basename(inboundOriginal)}`,
        `Stored at: ${inboundOriginal}`,
        "Binary stored; no text extractor for this type. Open the exact file path above (not the directory).",
      ]
        .filter(Boolean)
        .join("\n");
    }

    const result = await ingestContent({
      agentId,
      content,
      source,
      sourceType,
      priority,
      principal: req.cortexPrincipal?.id,
      trust: req.cortexPrincipal?.trust,
    });

    if (!keepFile) { try { await unlink(savedPath); } catch {} }

    console.log(
      `[ingest-raw] ${filename} (${contentType}, ${size}b) extraction=${extraction} ` +
        `chunks=${result.chunksStored} inbound=${inboundFiles.length}`
    );
    res.json({
      ...result,
      filename,
      bytes: size,
      extraction,
      inboundDelivered: inboundFiles.map((f) => basename(f)),
      savedPath: keepFile ? savedPath : null,
    });
  } catch (err: any) {
    try { await unlink(savedPath); } catch {}
    if (err?.message === "upload_too_large") { res.status(413).json({ error: "upload_too_large" }); return; }
    if (err && err.status) { res.status(err.status).json({ error: err.message }); return; }
    console.error("[ingest-raw] Error:", err);
    res.status(500).json({ error: "Raw ingestion failed" });
  }
});

export { router as ingestRawRouter };
