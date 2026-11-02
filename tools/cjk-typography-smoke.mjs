// The three Chinese typesetting rules, checked against the wrong implementation
// each one exists to catch — and against the real documents, because a rule that
// has never been pointed at the thing it is about is a rule nobody has tested.
//
// Why this file exists: `tools/cjk-typography.mjs` is a checker, and a checker
// is the kind of code that passes for two reasons at once — the documents are
// fine, or the rule stopped looking. Every assertion below therefore has a
// second half: the planted defect has to be reported, *and* the weakened
// implementation of that rule (the one that scans `line[0]`, the one that reads
// fenced code as prose, the one that only counts digits) has to be shown to miss
// it. If someone replaces a rule with its weak version, the smoke test goes red
// instead of the checker quietly going green.
//
// No Electron, no browser, no build: plain Node. Run with
// `npm run audit:typography` (the CLI gate first, then this file).
import fs from "node:fs";
import path from "node:path";
import {
  LINE_START_FORBIDDEN,
  docTypographyViolations,
  formatViolation,
  typographyTargets,
  typographyViolations,
  visibleText,
} from "./cjk-typography.mjs";
import { README_FILES } from "./upstream-watch.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};
const read = (target) => {
  const full = path.join(ROOT, target);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
};
const rules = (violations) => violations.map((violation) => violation.rule);

/* ---- 1. 行首禁则: a wrapped line must not begin with a closing mark ----
 *
 * The rule is about the first character a reader sees. The weak implementation
 * asks `line[0]`, which is enough for a hand-wrapped paragraph and blind to
 * every line of a blockquote or a list — and those are exactly the documents
 * here (the sync doc is a list of numbered rules, the DoD is a checklist).
 */
{
  const doc = ["正常的一行", "> ，这一行在引用里以逗号开头", "- **、列表项以顿号开头**", "一整句正常的中文，逗号在句中。"].join("\n");
  const found = typographyViolations("t.md", doc);
  const hits = found.filter((violation) => violation.rule === "行首禁则");
  check(
    "行首禁则 names both wrapped forms — a blockquote and a list item — with their lines",
    hits.length === 2 && hits[0].line === 2 && hits[1].line === 3,
    JSON.stringify(hits)
  );
  check(
    "...and does not fire for a comma inside the sentence",
    hits.every((violation) => violation.detail.includes("「，」") || violation.detail.includes("「、」")),
    JSON.stringify(hits.map((violation) => violation.detail))
  );

  // The implementation this rule exists to reject: no Markdown prefix, so both
  // planted lines start with `>` and `-`, neither of which is forbidden.
  const weak = (line) => (LINE_START_FORBIDDEN.includes(visibleText(line)[0] || "") ? "hit" : "miss");
  const weakAnswers = doc.split("\n").slice(1, 3).map((line) => weak(line) === "hit");
  check(
    "...and an implementation that reads the raw first character misses both (so replacing the rule turns this red)",
    weakAnswers.length === 2 && weakAnswers.every((hit) => hit === false),
    JSON.stringify(weakAnswers)
  );

  // A line whose first visible thing is a code span is a continuation, not a
  // start: the sync doc is full of `[UPSTREAM-DEBT]`、… and flagging those would
  // make the rule unusable on the one document that has to stay green.
  const codeFirst = typographyViolations("t.md", "`[UPSTREAM-DEBT]`、并写明两条路各自的原因");
  check(
    "...and a line that begins with a code span is not a line beginning with punctuation",
    codeFirst.length === 0,
    JSON.stringify(codeFirst)
  );
}

/* ---- 2. 半角标点后接中文 ----
 *
 * Two failure modes in opposite directions: miss the defect (a half-width comma
 * inside a Chinese sentence) and flag the innocent (a comma inside a code sample,
 * or the `1.` of an ordered list).
 */
{
  const doc = ["这一段中文,后面直接接中文。", "这一段中文.后面也直接接中文。", "代码里的 a,b 不算：`foo(a,b)`", "```", "中文,中文", "```", "1. 有序列表的第一条"].join("\n");
  const hits = typographyViolations("t.md", doc).filter((violation) => violation.rule === "半角标点后接中文");
  check(
    "半角标点后接中文 reports the comma and the full stop, on their own lines",
    hits.length === 2 && hits[0].line === 1 && hits[1].line === 2,
    JSON.stringify(hits)
  );
  check(
    "...and leaves code spans, fenced blocks and ordered list numbers alone",
    hits.every((violation) => violation.line < 3),
    JSON.stringify(hits.map((violation) => violation.line))
  );

  // The weakened implementation this rule exists to reject: no code awareness at
  // all. This is not hypothetical — stripping code spans was added after the
  // first run flagged every `foo(a,b)` in 使用说明.md, which is how a real rule
  // gets turned off instead of fixed. It also shows the other false positive the
  // strict "紧跟" wording avoids: an ordered list number is `.` followed by a
  // space and Chinese, and a rule that allowed the space would flag every step
  // of every numbered list in the repository.
  const naiveLines = (text) =>
    text
      .split("\n")
      .map((line, index) => ({ line, index: index + 1 }))
      .filter(({ line }) => /[,.]\s*[\u4e00-\u9fff]/u.test(line))
      .map(({ index }) => index);
  check(
    "...and a checker with no code awareness and a space-tolerant match would flag the fenced sample and the list number (lines 5 and 7)",
    JSON.stringify(naiveLines(doc)) === JSON.stringify([1, 2, 5, 7]),
    JSON.stringify(naiveLines(doc))
  );
}

/* ---- 3. 中英裸拼 ----
 *
 * The weak implementation that looks almost right: match a Han character next to
 * a *digit* (`第2轮`), which is a different question and passes for the planted
 * `用ocr跑` — so the test proves the rule is asking about letters.
 */
{
  const doc = ["这一句用ocr跑了一次", "release前的分支", "中文和 English 之间本来就有空格", "`ocr` 在代码里不算"].join("\n");
  const hits = typographyViolations("t.md", doc).filter((violation) => violation.rule === "中英裸拼");
  check(
    "中英裸拼 reports both directions of the adjacency, and not the spaced or code cases",
    hits.length === 3 && hits[0].line === 1 && hits[1].line === 1 && hits[2].line === 2,
    JSON.stringify(hits.map((violation) => `${violation.line}:${violation.detail}`))
  );

  const digitsOnly = (text) => text.split("\n").filter((line) => /[\u4e00-\u9fff][0-9]|[0-9][\u4e00-\u9fff]/u.test(line)).length;
  check(
    "...and a rule written against digits instead of letters answers zero here (an adjacency rule that agrees with the wrong class)",
    digitsOnly(doc) === 0,
    `${digitsOnly(doc)} lines`
  );
}

/* ---- 4. the document list is derived, not typed ----
 *
 * A hand-kept list goes stale exactly when a new document is added, which is the
 * case this check exists for. So `typographyTargets` walks the READMEs' relative
 * `*.md` pointers, the same walk `audit:upstream` uses for truncation.
 */
{
  const fake = [
    { path: "README.md", text: "see [the DoD](docs/PRODUCT-DOD.md) and [notes](docs/notes.md#top)" },
    { path: "README.zh-CN.md", text: "见 [`docs/PRODUCT-DOD.md`](docs/PRODUCT-DOD.md)" },
  ];
  const targets = typographyTargets(fake);
  check(
    "the target list is the two READMEs plus every relative .md they point at, deduped",
    JSON.stringify(targets) === JSON.stringify(["README.md", "docs/PRODUCT-DOD.md", "docs/notes.md", "README.zh-CN.md"]),
    JSON.stringify(targets)
  );

  // An external link is not ours to read, and a target reached twice is one file.
  const external = typographyTargets([{ path: "README.md", text: "[upstream](https://github.com/alibaba/open-code-review/blob/main/README.md)" }]);
  check(
    "...and an external link is not a document this repository owns",
    JSON.stringify(external) === JSON.stringify(["README.md"]),
    JSON.stringify(external)
  );

  const files = { "README.md": "clean", "docs/broken.md": "好的，然后中文,中文" };
  const docViolations = docTypographyViolations([{ path: "README.md", text: "见 [broken](docs/broken.md)" }], (target) => files[target] ?? null);
  check(
    "a pointer to a broken document is reported against that document and its line",
    docViolations.length === 1 && docViolations[0].file === "docs/broken.md" && docViolations[0].line === 1,
    JSON.stringify(docViolations)
  );

  const missing = docTypographyViolations([{ path: "README.md", text: "见 [gone](docs/gone.md)" }], () => null);
  check(
    "...and a target that cannot be read is a violation, not a silent skip",
    missing.length === 1 && missing[0].rule === "无法读取" && missing[0].file === "docs/gone.md",
    JSON.stringify(missing)
  );
}

/* ---- 5. the real documents, and one mutation of one of them ----
 *
 * This is the assertion the whole file points at: the repository's own prose is
 * clean, and it goes red — naming the file and the line — when one full stop in
 * `README.zh-CN.md` becomes half-width.
 */
{
  const readmes = README_FILES.map((name) => ({ path: name, text: fs.readFileSync(path.join(ROOT, name), "utf8") }));
  const targets = typographyTargets(readmes);
  check(
    "the real target list covers the two READMEs, the DoD and the usage guide",
    ["README.md", "README.zh-CN.md", "docs/PRODUCT-DOD.md", "使用说明.md"].every((target) => targets.includes(target)),
    JSON.stringify(targets)
  );

  const violations = docTypographyViolations(readmes, read);
  check(
    "every document a README points at follows the three rules",
    violations.length === 0,
    JSON.stringify(violations.slice(0, 3).map(formatViolation))
  );

  // The mutation is made on the real file's text and located by searching it, so
  // the expected line number is not a constant that goes stale on the next edit.
  const zh = fs.readFileSync(path.join(ROOT, "README.zh-CN.md"), "utf8");
  const at = zh.search(/。[\u4e00-\u9fff]/u);
  check(
    "...and the fixture found a full stop followed by Chinese to break",
    at !== -1,
    at === -1 ? "README.zh-CN.md has no 「。中文」 to mutate — the control below would prove nothing" : String(at)
  );
  if (at !== -1) {
    const mutated = `${zh.slice(0, at)}.${zh.slice(at + 1)}`;
    const wantLine = zh.slice(0, at + 1).split("\n").length;
    const after = docTypographyViolations(
      readmes.map((doc) => (doc.path === "README.zh-CN.md" ? { ...doc, text: mutated } : doc)),
      read
    );
    const hit = after.find((violation) => violation.file === "README.zh-CN.md" && violation.line === wantLine);
    check(
      "one full stop made half-width in README.zh-CN.md is reported by file and line",
      after.length >= 1 && hit !== undefined,
      JSON.stringify(after.slice(0, 2).map((violation) => `${violation.file}:${violation.line}`))
    );
    check(
      "...and the mutation changed exactly one character of the real file",
      mutated !== zh && mutated.length === zh.length && mutated.split("\n").length === zh.split("\n").length,
      `${zh.length} -> ${mutated.length}`
    );
  }
}

/* ---- 6. the gate is wired into the suite that runs ----
 *
 * Same shape as the `audit:upstream` gate check: the script has to point at the
 * CLI *and* this file, and `audit:static` has to run it, or the rules above are
 * a green light nobody turns on.
 */
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const scripts = pkg.scripts || {};
  check(
    "`audit:typography` runs the CLI gate and this file",
    scripts["audit:typography"] === "node tools/cjk-typography.mjs && node tools/cjk-typography-smoke.mjs",
    scripts["audit:typography"]
  );
  check(
    "...and it is part of `audit:static`",
    String(scripts["audit:static"] || "").includes("audit:typography"),
    scripts["audit:static"]
  );
  check(
    "...with both files present on disk",
    fs.existsSync(path.join(ROOT, "tools/cjk-typography.mjs")) && fs.existsSync(path.join(ROOT, "tools/cjk-typography-smoke.mjs")),
    "tools/cjk-typography{,-smoke}.mjs"
  );
}

if (failures.length) {
  console.log(`\n${failures.length} 条断言失败：`);
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
console.log("\n所有断言通过（含三条规则各自的反向控制）。");
