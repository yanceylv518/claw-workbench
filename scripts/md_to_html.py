from __future__ import annotations

import html
import re
import sys
from pathlib import Path


def inline_format(text: str) -> str:
    text = html.escape(text, quote=False)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"\*([^*]+)\*", r"<em>\1</em>", text)
    return text


def flush_paragraph(lines: list[str], out: list[str]) -> None:
    if not lines:
        return
    text = " ".join(line.strip() for line in lines).strip()
    if text:
        out.append(f"<p>{inline_format(text)}</p>")
    lines.clear()


def flush_list(items: list[str], out: list[str], ordered: bool) -> None:
    if not items:
        return
    tag = "ol" if ordered else "ul"
    out.append(f"<{tag}>")
    for item in items:
        out.append(f"<li>{inline_format(item.strip())}</li>")
    out.append(f"</{tag}>")
    items.clear()


def markdown_to_html(md: str, title: str) -> str:
    lines = md.splitlines()
    body: list[str] = []
    para: list[str] = []
    ul_items: list[str] = []
    ol_items: list[str] = []
    in_code = False
    code_lines: list[str] = []

    def flush_all() -> None:
        flush_paragraph(para, body)
        flush_list(ul_items, body, ordered=False)
        flush_list(ol_items, body, ordered=True)

    for raw_line in lines:
        line = raw_line.rstrip("\n")

        if line.startswith("```"):
            flush_all()
            if in_code:
                code_html = html.escape("\n".join(code_lines))
                body.append(f"<pre><code>{code_html}</code></pre>")
                code_lines.clear()
                in_code = False
            else:
                in_code = True
            continue

        if in_code:
            code_lines.append(line)
            continue

        if not line.strip():
            flush_all()
            continue

        heading = re.match(r"^(#{1,6})\s+(.*)$", line)
        if heading:
            flush_all()
            level = len(heading.group(1))
            body.append(f"<h{level}>{inline_format(heading.group(2).strip())}</h{level}>")
            continue

        ul = re.match(r"^[-*]\s+(.*)$", line)
        if ul:
            flush_paragraph(para, body)
            flush_list(ol_items, body, ordered=True)
            ul_items.append(ul.group(1))
            continue

        ol = re.match(r"^\d+\.\s+(.*)$", line)
        if ol:
            flush_paragraph(para, body)
            flush_list(ul_items, body, ordered=False)
            ol_items.append(ol.group(1))
            continue

        body.append("<hr />") if line.strip() == "---" else para.append(line)

    flush_all()
    if in_code:
        code_html = html.escape("\n".join(code_lines))
        body.append(f"<pre><code>{code_html}</code></pre>")

    css = """
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif;
      color: #1f2328;
      background: #ffffff;
      line-height: 1.65;
      font-size: 14px;
    }
    main {
      max-width: 920px;
      margin: 0 auto;
      padding: 40px 52px 56px;
    }
    h1, h2, h3, h4, h5, h6 {
      line-height: 1.3;
      margin: 1.2em 0 0.5em;
      color: #111827;
      page-break-after: avoid;
    }
    h1 { font-size: 28px; border-bottom: 1px solid #e5e7eb; padding-bottom: 10px; }
    h2 { font-size: 22px; border-bottom: 1px solid #f0f1f3; padding-bottom: 8px; }
    h3 { font-size: 18px; }
    p, ul, ol, pre { margin: 0 0 14px; }
    ul, ol { padding-left: 24px; }
    li { margin: 4px 0; }
    code {
      font-family: Consolas, "Courier New", monospace;
      background: #f6f8fa;
      border: 1px solid #e5e7eb;
      border-radius: 4px;
      padding: 1px 5px;
      font-size: 0.92em;
    }
    pre {
      background: #0f172a;
      color: #e5e7eb;
      border-radius: 10px;
      padding: 14px 16px;
      overflow: hidden;
      white-space: pre-wrap;
      word-break: break-word;
    }
    pre code {
      background: transparent;
      border: 0;
      color: inherit;
      padding: 0;
    }
    a { color: #0969da; text-decoration: none; }
    hr {
      border: 0;
      border-top: 1px solid #e5e7eb;
      margin: 24px 0;
    }
    @page { size: A4; margin: 14mm 12mm; }
    """

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{html.escape(title)}</title>
  <style>{css}</style>
</head>
<body>
  <main>
    {''.join(body)}
  </main>
</body>
</html>
"""


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: python md_to_html.py <input.md> <output.html>")
        return 1

    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    text = src.read_text(encoding="utf-8")
    title = src.stem.replace("_", " ")
    dst.write_text(markdown_to_html(text, title), encoding="utf-8")
    print(dst)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
