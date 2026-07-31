import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

// scripts/ lives at the sandbox root, two levels up from src/api/
const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts");
const DOCX_SCRIPT = join(SCRIPTS_DIR, "docx2txt.py");

// Below this many characters we treat extraction as "failed" (e.g. a scanned,
// image-only PDF with no text layer) and fall back to a descriptor memory.
const MIN_MEANINGFUL_CHARS = 120;
const MAX_BUF = 1024 * 1024 * 128; // 128MB stdout ceiling for huge reports

export interface Extraction {
  text: string; // extracted text (trimmed; may be empty)
  method: string; // pdftotext | docx | none | <tool>-failed
  ok: boolean; // true when we got meaningful text worth ingesting
  note?: string; // human-readable reason when !ok
}

/**
 * Strip bytes that Postgres TEXT columns reject. NUL (char code 0) is the main
 * offender from pdftotext/docx output; we also drop other C0 control chars
 * (codes 1-31) except tab (9), newline (10) and carriage-return (13). Done as a
 * char-code scan so no literal control bytes ever live in this source file.
 */
export function sanitizeText(s: string): string {
  if (!s) return "";
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || c >= 32) out += s[i];
  }
  return out;
}

function isPdf(ct: string, ext: string) {
  return ct.includes("pdf") || ext === ".pdf";
}
function isDocx(ct: string, ext: string) {
  return ext === ".docx" || ct.includes("officedocument.wordprocessingml");
}

/**
 * Extract plain text from a saved document file.
 *  - PDF  -> pdftotext -layout (poppler)
 *  - DOCX -> scripts/docx2txt.py (stdlib zip/xml, no deps)
 * Returns ok=false (with a note) for unsupported/binary or text-less files so
 * the caller can store a descriptor instead. Never throws.
 */
export async function extractDocumentText(
  savedPath: string,
  contentType: string,
  filename: string
): Promise<Extraction> {
  const ct = (contentType || "").toLowerCase();
  const ext = extname((filename || "").toLowerCase());

  if (isPdf(ct, ext)) {
    try {
      const { stdout } = await execFileP(
        "pdftotext",
        ["-layout", "-enc", "UTF-8", "-nopgbrk", savedPath, "-"],
        { maxBuffer: MAX_BUF, timeout: 25000, killSignal: "SIGKILL" }
      );
      const text = sanitizeText(stdout || "").trim();
      if (text.length >= MIN_MEANINGFUL_CHARS) {
        return { text, method: "pdftotext", ok: true };
      }
      return {
        text,
        method: "pdftotext",
        ok: false,
        note: "PDF has little/no text layer (likely a scanned/image-only PDF).",
      };
    } catch (e: any) {
      return { text: "", method: "pdftotext-failed", ok: false, note: String(e?.message || e) };
    }
  }

  if (isDocx(ct, ext)) {
    try {
      const { stdout } = await execFileP("python3", [DOCX_SCRIPT, savedPath], {
        maxBuffer: MAX_BUF, timeout: 25000, killSignal: "SIGKILL",
      });
      const text = sanitizeText(stdout || "").trim();
      if (text.length >= MIN_MEANINGFUL_CHARS) {
        return { text, method: "docx", ok: true };
      }
      return { text, method: "docx", ok: false, note: "DOCX produced little/no text." };
    } catch (e: any) {
      return { text: "", method: "docx-failed", ok: false, note: String(e?.message || e) };
    }
  }

  return { text: "", method: "none", ok: false, note: "Unsupported binary type for text extraction." };
}

export function isExtractableDocument(contentType: string, filename: string): boolean {
  const ct = (contentType || "").toLowerCase();
  const ext = extname((filename || "").toLowerCase());
  return isPdf(ct, ext) || isDocx(ct, ext);
}
