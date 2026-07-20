#!/usr/bin/env node
/**
 * build-fixture.mjs
 *
 * Generates a reproducible 3-chapter EPUB 3 test fixture (multichapter.epub).
 *
 * Usage: node frontend/tests/fixtures/build-fixture.mjs
 *
 * Output: frontend/tests/fixtures/multichapter.epub
 *
 * Properties:
 *   - 3 spine items: chapter-1.xhtml, chapter-2.xhtml, chapter-3.xhtml
 *   - Each chapter >= 9 KB of <p> Latin text (>= 200 paragraphs)
 *   - No @font-face, no <style> beyond the single mandated rule,
 *     no <script>, no epub:type page-break markers, no remote resources
 *   - Every ZIP entry date set to 1980-01-01T00:00:00 for byte-reproducible output
 *   - mimetype entry is first and uncompressed (compression method 0)
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeFileSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Check for adm-zip ---
let AdmZip;
try {
  const require = createRequire(import.meta.url);
  AdmZip = require("adm-zip");
} catch {
  console.error("Error: adm-zip is not installed. Run: npm install");
  process.exit(1);
}

// --- Constants ---
const FIXED_DATE = new Date("1980-01-01T00:00:00").getTime();
const OUTPUT_PATH = join(__dirname, "multichapter.epub");

// Latin lorem ipsum paragraph (deterministic, no randomness)
const LOREM_PARAGRAPHS = [
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.",
  "Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.",
  "Curabitur pretium tincidunt lacus. Nulla gravida orci a odio. Nullam varius, turpis et commodo pharetra, est eros bibendum elit, nec luctus magna felis sollicitudin mauris.",
  "Integer in mauris eu nibh euismod gravida. Duis ac tellus et risus vulputate vehicula. Donec lobortis risus a elit. Etiam tempor. Ut ullamcorper, ligula ut dictum pharetra, nisi nunc fringilla magna, in commodo elit erat nec magna.",
  "Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.",
  "Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt. Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet.",
  "At vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis praesentium voluptatum deleniti atque corrupti quos dolores et quas molestias excepturi sint occaecati cupiditate non provident.",
  "Similique sunt in culpa qui officia deserunt mollitia animi, id est laborum et dolorum fuga. Et harum quidem rerum facilis est et expedita distinctio. Nam libero tempore, cum soluta nobis est eligendi optio cumque nihil impedit.",
  "Temporibus autem quibusdam et aut officiis debitis aut rerum necessitatibus saepe eveniet ut et voluptates repudiandae sint et molestiae non recusandae. Itaque earum rerum hic tenetur a sapiente delectus, ut aut reiciendis voluptatibus.",
  "Quis autem vel eum iure reprehenderit qui in ea voluptate velit esse quam nihil molestiae consequatur, vel illum qui dolorem eum fugiat quo voluptas nulla pariatur. Ut enim ad minima veniam, quis nostrum exercitationem ullam corporis suscipit.",
];

/**
 * Generate N paragraphs of lorem ipsum text.
 * Cycles through the paragraph pool deterministically.
 */
function generateParagraphs(count) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    parts.push(`<p>${LOREM_PARAGRAPHS[i % LOREM_PARAGRAPHS.length]}</p>`);
  }
  return parts.join("\n");
}

/**
 * Build a minimal XHTML chapter document.
 * Only style: p{margin:0 0 1em 0;line-height:1.5}
 */
function buildChapter(title, chapterNumber) {
  // 220 paragraphs to ensure >= 9 KB of body text
  const paragraphs = generateParagraphs(220);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="la">
<head>
<meta charset="UTF-8"/>
<title>${title}</title>
<style>p{margin:0 0 1em 0;line-height:1.5}</style>
</head>
<body>
<h1>${title}</h1>
${paragraphs}
</body>
</html>`;
}

/**
 * Build the EPUB 3 navigation document.
 */
function buildNav() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head>
<meta charset="UTF-8"/>
<title>Navigation</title>
</head>
<body>
<nav epub:type="toc" id="toc">
<h1>Table of Contents</h1>
<ol>
<li><a href="chapter-1.xhtml">Chapter 1</a></li>
<li><a href="chapter-2.xhtml">Chapter 2</a></li>
<li><a href="chapter-3.xhtml">Chapter 3</a></li>
</ol>
</nav>
</body>
</html>`;
}

/**
 * Build the container.xml that points to the package document.
 */
function buildContainerXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>`;
}

/**
 * Build the EPUB 3 package document (content.opf).
 */
function buildContentOpf() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:fixture-multichapter-001</dc:identifier>
<dc:title>Multichapter Test Fixture</dc:title>
<dc:language>en</dc:language>
<dc:creator>Test Fixture Generator</dc:creator>
<meta property="dcterms:modified">1980-01-01T00:00:00Z</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="chapter-1" href="chapter-1.xhtml" media-type="application/xhtml+xml"/>
<item id="chapter-2" href="chapter-2.xhtml" media-type="application/xhtml+xml"/>
<item id="chapter-3" href="chapter-3.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine>
<itemref idref="chapter-1"/>
<itemref idref="chapter-2"/>
<itemref idref="chapter-3"/>
</spine>
</package>`;
}

// --- Build the EPUB ---
// noSort: true preserves insertion order so mimetype stays first (EPUB requirement)
const zip = new AdmZip({ noSort: true });

// 1. mimetype MUST be first and uncompressed (method 0 = STORE)
//    addFile always compresses non-empty files, so we override the method afterward
const mimeEntry = zip.addFile("mimetype", Buffer.from("application/epub+zip"));
mimeEntry.header.method = 0; // STORE (no compression)

// 2. META-INF/container.xml
zip.addFile("META-INF/container.xml", Buffer.from(buildContainerXml(), "utf8"));

// 3. OEBPS/content.opf
zip.addFile("OEBPS/content.opf", Buffer.from(buildContentOpf(), "utf8"));

// 4. OEBPS/nav.xhtml
zip.addFile("OEBPS/nav.xhtml", Buffer.from(buildNav(), "utf8"));

// 5. OEBPS/chapter-{1,2,3}.xhtml
for (let i = 1; i <= 3; i++) {
  const content = buildChapter(`Chapter ${i}`, i);
  zip.addFile(`OEBPS/chapter-${i}.xhtml`, Buffer.from(content, "utf8"));
}

// Set every entry's date to the fixed 1980 date for reproducibility
for (const entry of zip.getEntries()) {
  entry.header.time = FIXED_DATE;
}

// Write the EPUB
writeFileSync(OUTPUT_PATH, zip.toBuffer());

console.log(`Generated multichapter.epub`);
process.exit(0);
