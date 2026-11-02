// Chinese typesetting, as three rules a reader would notice if they were broken
// and no check would have said so.
//
// Why this file exists: this repository's prose is Chinese in the documents a
// stranger reads first, and the way that prose is set — a full-width comma where
// a full-width comma belongs, a space between 中文 and `ocr`, a line that does
// not begin with 「，」— was only ever a matter of who wrote it. A typo of that
// kind is invisible to every other check here: the document still parses, still
// closes, and still reads; it just reads like a machine translated it. So the
// rules are written down once, and pointed at the documents by derivation rather
// than by a hand-kept list:
//
//   README.md / README.zh-CN.md  →  every relative `*.md` they link to
//
// The target list is the same pointer walk `tools/upstream-watch.mjs` uses for
// truncation (`docPointers`), because the two questions — "is this document
// whole" and "is it set like Chinese" — are about the same set of files. The
// READMEs are in their own list: they are what the repository page shows.
//
// The three rules, and the wrong implementation each one is tested against in
// `tools/cjk-typography-smoke.mjs`:
//
//   1. 行首禁则 — a line of Chinese prose may not *begin* with a closing mark
//      (，。！？；：、）】》」』, and the half-width forms). Wrapped text that
//      drops a comma to the next line is the classic symptom of a translation
//      pasted in one cell per line. Markdown quoting and list markers are
//      stripped before the question is asked — a rule that only looks at
//      `line[0]` sees `> ，` and passes.
//   2. 半角标点后接中文 — `,` or `.` immediately followed by a Chinese character
//      inside Chinese text. Code spans, fenced blocks, link targets and bare
//      URLs are excluded, because `foo(x,y)中` in a code sample is not prose:
//      that exclusion is the difference between a rule and a nuisance.
//   3. 中英裸拼 — a Chinese character touching a Latin letter with nothing
//      between them (`用ocr跑`, `release前`). A space (or punctuation, or a code
//      span) separates them; bare adjacency is what makes mixed text look
//      pasted. Digits are deliberately not in this rule — `第 2 轮` and `v0.1.13`
//      are set with a space by habit already, and `10 分钟` next to `10分钟`
//      is a style question, not a defect this repository has an opinion on.
//
// Nothing here rewrites a document. It reports file, line and the offending
// pair, so the fix is an edit a person makes; a formatter that silently reflows
// Chinese prose would be a much larger promise than this check is able to keep.
import fs from "node:fs";
import path from "node:path";
import { README_FILES, docPointers } from "./upstream-watch.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

// Han characters: the three blocks a Chinese document actually uses. Written as
// escapes, not literals, so the ranges survive any editor that normalises what
// it thinks is a range.
const HAN = "\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff";
const HAS_HAN = new RegExp(`[${HAN}]`);

// The closing marks that must not start a line: full-width forms first, then the
// half-width ones, which are just as wrong at the start of a Chinese line and
// much easier to paste in by accident.
export const LINE_START_FORBIDDEN = "，。！？；：、）】》」』〉〕〗,.;:!?)]";

// Markdown furniture in front of the actual first character: blockquote markers,
// a list bullet or an ordered marker, and an emphasis run. Stripped in that
// order, once — this is not a Markdown parser, it is the small prefix that makes
// `> ，…` and `- **，…` the same defect as `，…`.
const LINE_PREFIX = /^\s*(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__|\*|_)?/;

// The line as a reader sees it: what is inside a code span is code, and a URL is
// an address rather than prose. Both are replaced by a space so they also stop a
// neighbouring pair from looking adjacent.
export const visibleText = (line) =>
  String(line)
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\]\([^)]*\)/g, "]");

const fenceOf = (line) => {
  const hit = /^\s*(```|~~~)/.exec(line);
  return hit ? hit[1] : null;
};

const isClosingFence = (line) => /^\s*(```|~~~)\s*$/.test(line);

// The first character a reader would see at the start of the line, after the
// Markdown furniture. A line that begins with a code span begins with code: the
// punctuation that follows it belongs to the sentence the code sits in, not to
// the start of the line, so the answer is "nothing to judge here".
const firstProseCharacter = (line, visible) => {
  if (line.replace(LINE_PREFIX, "").startsWith("`")) return "";
  return Array.from(visible.replace(LINE_PREFIX, ""))[0] || "";
};

// The three rules, one document at a time. Returns `[{ file, line, rule, detail }]`
// — objects rather than sentences, because the smoke test asks which rule fired
// and the CLI turns them into `file:line` text.
export const typographyViolations = (file, text) => {
  const violations = [];
  let fence = null;

  String(text == null ? "" : text)
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (fence !== null) {
        if (isClosingFence(line)) fence = null;
        return;
      }
      const opener = fenceOf(line);
      if (opener !== null) {
        fence = opener;
        return;
      }

      const visible = visibleText(line);
      if (!visible.trim()) return;
      const at = index + 1;

      // 1. 行首禁则 — only asked of a line that is Chinese at all, and never of
      // a line whose first visible character is a code span: the punctuation
      // after `[UPSTREAM-DEBT]` is not at the start of anything a reader sees as
      // prose, it is a continuation of the same sentence as the code.
      if (HAS_HAN.test(visible)) {
        const first = firstProseCharacter(line, visible);
        if (first && LINE_START_FORBIDDEN.includes(first)) {
          violations.push({
            file,
            line: at,
            rule: "行首禁则",
            detail: `这一行以「${first}」开头：中文行不能以收尾标点起头，把上一行的断行挪开`,
          });
        }
      }

      // 2. 半角标点后接中文 — immediately, which is what "紧跟" means. Allowing a
      // space here would flag every ordered list (`1. 顶部…`) in the repository,
      // and a rule with a false positive on every numbered step is a rule nobody
      // keeps green.
      const halfWidth = new RegExp(`([,.])(?=[${HAN}])`, "g");
      let hit = halfWidth.exec(visible);
      while (hit !== null) {
        const following = visible.slice(hit.index + hit[0].length)[0] || "";
        violations.push({
          file,
          line: at,
          rule: "半角标点后接中文",
          detail: `「${hit[1]}${following}」是半角标点接中文，中文句子里要用全角「，」「。」`,
        });
        hit = halfWidth.exec(visible);
      }

      // 3. 中英裸拼.
      const adjacent = new RegExp(`[${HAN}][A-Za-z]|[A-Za-z][${HAN}]`, "g");
      hit = adjacent.exec(visible);
      while (hit !== null) {
        violations.push({
          file,
          line: at,
          rule: "中英裸拼",
          detail: `「${hit[0]}」中英之间没有分隔：中文与西文之间留一个空格`,
        });
        hit = adjacent.exec(visible);
      }
    });

  return violations;
};

/**
 * Which documents the rules are about, derived from the READMEs themselves.
 *
 * Same walk as `productDocViolations`: every relative `*.md` a README points at,
 * plus the READMEs. A second, hand-kept list would go stale in exactly the case
 * this check exists for — a new document nobody remembered to add.
 */
export const typographyTargets = (readmes) => {
  const targets = [];
  const add = (target) => {
    if (!targets.includes(target)) targets.push(target);
  };
  for (const { path: source, text } of readmes) {
    add(source);
    for (const pointer of docPointers(text)) add(pointer.target);
  }
  return targets;
};

/**
 * The rules over a set of documents. `readmes` is `[{ path, text }]`;
 * `readFile(target)` returns the text or `null` when it is missing.
 *
 * A missing target is reported instead of skipped: a document this check cannot
 * read is a document nothing here has looked at, and a green run that silently
 * dropped a file is the failure mode this whole repository is against. (Whether
 * the link itself is a 404 is `audit:upstream`'s question, not this one.)
 */
export const docTypographyViolations = (readmes, readFile) => {
  const violations = [];
  for (const target of typographyTargets(readmes)) {
    const provided = readmes.find((doc) => doc.path === target);
    const text = provided ? provided.text : readFile(target);
    if (text === null || text === undefined) {
      violations.push({
        file: target,
        line: 0,
        rule: "无法读取",
        detail: "README 指向的这份文档读不到，本检查因此没有看过它",
      });
      continue;
    }
    violations.push(...typographyViolations(target, text));
  }
  return violations;
};

export const formatViolation = (violation) =>
  `${violation.file}:${violation.line}：${violation.rule}——${violation.detail}`;

// ---- the gate ----
//
// Only runs when this file is the entry point, so the smoke test can import the
// rules without the real documents being read twice.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const readmes = README_FILES.map((name) => ({ path: name, text: fs.readFileSync(path.join(ROOT, name), "utf8") }));
  const read = (target) => {
    const full = path.join(ROOT, target);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
  };
  const targets = typographyTargets(readmes);
  const violations = docTypographyViolations(readmes, read);

  console.log(
    `中文排版：查了 ${targets.length} 份文档（来源：${README_FILES.join(" / ")} 的相对 .md 指针，外加两份 README 自身）——${targets.join("、")}`
  );
  for (const violation of violations) console.log(`FAIL    ${formatViolation(violation)}`);
  if (violations.length) {
    console.log(`\n${violations.length} 处中文排版问题。规则写在 tools/cjk-typography.mjs 顶部，反向控制在 tools/cjk-typography-smoke.mjs。`);
    process.exit(1);
  }
  console.log(`ok      ${targets.length} 份文档都守行首禁则、全角标点与中英分隔`);
}
