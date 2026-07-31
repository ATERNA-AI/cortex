#!/usr/bin/env python3
"""Extract plain text from a .docx (Office Open XML) with no third-party deps.

Reads word/document.xml plus any headers/footers, turns paragraph and tab
markers into real whitespace, strips the remaining XML tags, and unescapes
HTML entities. Prints UTF-8 text to stdout. Used by the cortex ingest pipeline
so Eric's uploaded Word reports become real, recallable text (not stubs).

Usage: python3 docx2txt.py <path-to-docx>
"""
import sys
import re
import html
import zipfile


def extract(path: str) -> str:
    parts = []
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        # main body first, then headers/footers in name order
        ordered = [n for n in names if n == "word/document.xml"]
        ordered += sorted(
            n for n in names if re.match(r"word/(header|footer)\d*\.xml$", n)
        )
        for name in ordered:
            xml = z.read(name).decode("utf-8", "ignore")
            # paragraph + line breaks -> newline, tabs -> tab
            xml = re.sub(r"</w:p>", "\n", xml)
            xml = re.sub(r"<w:br[^>]*/>", "\n", xml)
            xml = re.sub(r"<w:tab[^>]*/>", "\t", xml)
            # drop all remaining tags
            xml = re.sub(r"<[^>]+>", "", xml)
            parts.append(xml)
    text = html.unescape("\n".join(parts))
    # collapse runs of blank lines
    text = re.sub(r"\n[ \t]*\n[ \t]*\n+", "\n\n", text)
    return text.strip()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.stderr.write("usage: docx2txt.py <file.docx>\n")
        sys.exit(2)
    try:
        sys.stdout.write(extract(sys.argv[1]))
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"docx2txt error: {e}\n")
        sys.exit(1)
