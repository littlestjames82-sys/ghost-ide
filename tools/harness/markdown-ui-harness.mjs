// Batch 3 R5 (v2.36.0): markdown preview injection proof.
// renderMarkdown feeds innerHTML in the live preview, the
// preview panel, and the exported docs site - on an origin
// that holds the GitHub and pair tokens. Attribute breakouts
// and scriptable link schemes must render inert while
// ordinary markdown keeps rendering exactly as before.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const escPart = "function escHtml(s)" +
  src.split("function escHtml(s)")[1].split("/*@@DOCS@@*/")[0];
const block = src.split("/*@@DOCS@@*/")[1].split("/*@@DOCS-END@@*/")[0];
const { renderMarkdown } =
  new Function("window", escPart + block +
    "; return { renderMarkdown };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

// F1: image alt quote breakout - this fired with no
// click at all, the moment a hostile .md was previewed.
let h = renderMarkdown('![x" onerror="alert(1)](missing.png)');
ck("img alt quote cannot break out of the attribute",
   h.includes('alt="x&quot; onerror=&quot;alert(1)"')
   && !h.includes('" onerror="'));
// F1b: absolute image src quote breakout.
h = renderMarkdown('![a](https://x.test/i.png"onerror="alert(1))');
ck("img src quote cannot break out of the attribute",
   h.includes("&quot;onerror=&quot;")
   && !h.includes('"onerror="'));
// F2: scriptable link schemes render as plain text.
h = renderMarkdown("[click](javascript:alert)");
ck("javascript: link is inert text",
   !h.includes("javascript:") && !h.includes("<a")
   && h.includes("click"));
h = renderMarkdown("[click](data:text/html;base64,PHNjcmlwdD4=)");
ck("data: link is inert text",
   !h.includes('href="data:') && !h.includes("<a"));
// F2b: quote breakout inside an https link.
h = renderMarkdown('[t](https://x.test/"onclick="alert(1))');
ck("https href quote cannot break out",
   h.includes("&quot;onclick=&quot;")
   && !h.includes('"onclick="'));
// Sanity: ordinary markdown renders as before.
h = renderMarkdown("[ok](https://example.com)");
ck("https link keeps its shape",
   h.includes('<a href="https://example.com"'
     + ' target="_blank" rel="noopener">ok</a>'));
h = renderMarkdown("![pic](sub/pic.png)", "docs");
ck("relative image still resolves via /api/raw",
   h.includes('src="/api/raw?path=docs%2Fsub%2Fpic.png"'));
h = renderMarkdown("[guide](other.md)");
ck("in-workspace .md link keeps data-md routing",
   h.includes('href="#other.md"')
   && h.includes('data-md="other.md"'));
h = renderMarkdown("[mail](mailto:a@b.c)");
ck("mailto link still works",
   h.includes('<a href="mailto:a@b.c">mail</a>'));
h = renderMarkdown("[top](#top)");
ck("anchor link still works",
   h.includes('<a href="#top">top</a>'));
h = renderMarkdown("# Title\n\nhello **bold**");
ck("headings and bold still render",
   h.includes("<strong>bold</strong>"));
// F3 wiring: both update-check URL uses (Settings link
// and the quiet pill) are scheme-gated in the source.
ck("both update-check URL uses are scheme-gated",
   src.split("test(d.url)").length - 1 === 2);
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
