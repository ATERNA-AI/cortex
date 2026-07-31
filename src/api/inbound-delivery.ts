import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { join, extname, basename } from "node:path";

const execFileP = promisify(execFile);

// Stormy's OpenClaw live inbound directory — the surface he watches for new
// uploads. Portal uploads previously never reached here ("ghost town"); we now
// drop a readable copy so his live runtime + file tools can see each report.
const INBOUND_DIR =
  process.env.STORMY_INBOUND_DIR || "/home/stormy/.openclaw/media/inbound";
const OWNER = process.env.STORMY_OWNER || "stormy:stormy";

function safeName(filename: string): string {
  return (filename || "upload").replace(/[^\w.\-]/g, "_");
}

async function chownToStormy(path: string): Promise<void> {
  try {
    await execFileP("chown", [OWNER, path]);
  } catch {
    /* best-effort: cortex runs as root, but never fail ingest over ownership */
  }
}

/**
 * Deliver an uploaded report to Stormy's live inbound directory.
 *
 * Writes the extracted text as a `.txt` sidecar (so Stormy can read the content
 * directly even though the gateway has no native PDF/DOCX pipeline), and also
 * copies the original file when provided. Both are chowned to `stormy`. This is
 * best-effort: any failure is logged and swallowed so it can never block the
 * primary cortex ingest.
 *
 * Returns the paths written (empty array on total failure).
 */
export async function deliverToInbound(opts: {
  filename: string;
  extractedText?: string;
  originalPath?: string;
  caption?: string;
  source?: string;
}): Promise<string[]> {
  const written: string[] = [];
  try {
    await mkdir(INBOUND_DIR, { recursive: true });
    const base = safeName(opts.filename);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    // 1) text sidecar with the real content
    if (opts.extractedText && opts.extractedText.trim()) {
      const txtName = `${stamp}__${base.replace(/\.[^.]+$/, "")}.txt`;
      const txtPath = join(INBOUND_DIR, txtName);
      const header = [
        `# ${opts.filename}`,
        opts.caption ? `Caption: ${opts.caption}` : null,
        opts.source ? `Source: ${opts.source}` : null,
        `Delivered: ${new Date().toISOString()}`,
        "",
        "----------------------------------------",
        "",
      ]
        .filter(Boolean)
        .join("\n");
      await writeFile(txtPath, header + opts.extractedText, "utf-8");
      await chownToStormy(txtPath);
      written.push(txtPath);
    }

    // 2) original file copy (so the source document is also present)
    if (opts.originalPath) {
      const ext = extname(opts.originalPath) || extname(opts.filename) || "";
      const origName = `${stamp}__${base.replace(/\.[^.]+$/, "")}${ext}`;
      const destPath = join(INBOUND_DIR, origName);
      await copyFile(opts.originalPath, destPath);
      await chownToStormy(destPath);
      written.push(destPath);
    }
  } catch (e: any) {
    console.error("[inbound-delivery] failed:", e?.message || e);
  }
  return written;
}
