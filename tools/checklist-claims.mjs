// 「清单存在」与「读数已贴回」是两件事，这一条把两者之间的缝钉住。
//
// 第 120 轮写了 `docs/win-install-checklist.md`（一次 Windows x64 真机跑的说明书），
// 第 121 轮把清单里那两个期望版本接进了 `tools/release-pin.mjs`。两轮之后，链条上还剩
// 一处只靠人的纪律连接的地方：
//
//   清单文件头写着「这份文件是一次操作的说明书，不是验证记录；它自己也因此不能当证据用」，
//   但这句话本身没有断言。于是「清单已经写好」可以被读成「DOD-5 快能勾了」，而把
//   `docs/measurements.md` 未验证清单里那两行删掉，欠账就消失了——没有任何检查会红。
//
// 这一条问的是三件互相咬合的事，每一件都能被脚本答：
//
//   1. **未验证清单里那些「按清单第 N 步去验」的行，必须真的引用清单路径。**
//      触发条件列是这一行的「下次怎么补」；把路径删掉，这一行就变成一句没有落点的
//      待办，而清单被改名/删除时也不会有任何东西变红。
//   2. **清单第 9 节那张「读数记回哪一行」的对照表与未验证清单必须双向对上。**
//      正向：对照表点名的每一行都得在未验证清单里（清单还写着「尚未执行」时）——
//      行先没了就是「读数没贴回就把行删了」。反向：未验证清单里每一行「按清单第 N 步
//      去验」的，都得在对照表里有一格说它记回哪一行——否则那一趟跑完，读数没有落点。
//      两个方向各堵一个洞：删清单的行、删清单第 9 节的行。
//   3. **DoD 的方括号不许先勾。** `docs/PRODUCT-DOD.md` 的 DOD-5 / DOD-6 一旦是 `[x]`，
//      清单文件头就不能还写着「尚未执行」，而且这两条在对照表里点到的每一行，其
//      「为什么没验」那一格必须已经换成实测读数（含日期与「读数」二字），不许还是
//      「按清单第 N 步去验」这种指令句——勾上之后那句「为什么还没验」就是假话。
//
// 三件事都只读文档，不读 git、不读网络，所以它和 `tools/release-pin.mjs` 的规则那一半
// 一样能在浅克隆里跑。反向控制在 `tools/checklist-claims-smoke.mjs`：每一格只改一个事实，
// 要求点名文件与行号。
//
// 两个读法上的约定，写在这里因为规则靠它们区分「这一行在说什么」：
//
//   - **「第 N 步」与「第 N 节」不是一回事。** 触发条件里写「按清单第 5 步去验」是
//     「这一行要按清单那一步补」，必须进对照表；写「清单第 8 节写明这一项不在那一趟里」
//     是「清单在说这一项不归它管」（`应用内更新` 那一行就是这样），不该进对照表。
//     所以反向那一条只认「第 … 步」。
//   - **一条对照行只认第一个 `DOD-<n>`。** 第 9 节里有一格写着
//     「DOD-5（主）；4.1 同时是 DOD-4 的一段」——主归属是第一个，第二个是附带说明。
//     按整格里的每个 ID 都算，会让 DOD-4 勾上时反过来要求这一行已经贴过读数，而
//     DOD-4 的证据面在别处（`tools/e2e-first-run.cjs`）。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

export const MEASUREMENTS_DOC = "docs/measurements.md";
export const CHECKLIST_DOC = "docs/win-install-checklist.md";
export const DOD_DOC = "docs/PRODUCT-DOD.md";

/** 清单文件头状态行的两个取值。只认 `> 状态：` 开头那一行，别处的同名字样不算——
 *  第 10 节要教人「跑完把状态改成另一个」，那句话里必然出现这两个词。 */
export const CHECKLIST_PENDING_MARK = "尚未执行";
export const CHECKLIST_EXECUTED_MARK = "已执行";

/** 一条「读数已贴回」的单元格长什么样：有日期、并且说了这是读数。
 *  两个条件一起要，是因为单看日期会放过「2026-11-04 还没验」这种句子。 */
export const READING_DATE = /\b20\d\d-\d\d-\d\d\b/;

/** 表格行拆成单元格。行首行尾的 `|` 不算一格。 */
const cellsOf = (line) => line.split("|").slice(1, -1).map((cell) => cell.trim());

/** 名字比对用的形状：反引号与空白都不算内容（`发布资产里带的是哪一版 \`ocr\``
 *  在两张表里可能一处带反引号一处不带）。 */
export const claimKey = (name) => String(name == null ? "" : name).replace(/`/g, "").replace(/\s+/g, "");

const isSeparator = (cells) => cells.every((cell) => /^:?-{2,}:?$/.test(cell));

/**
 * `docs/measurements.md` 的未验证清单，一行一条。
 *
 * 只读 `## 未验证清单` 这一节，读到下一个二级标题为止：上面那张实测表是「跑过什么」，
 * 这一节是它的反面，两张表的行名会重名（`安装版之后的首启链路` 两边都有），混在一起
 * 读会让「这一行还在不在」这个问题答错。
 */
export const unverifiedRows = (doc) => {
  const lines = String(doc == null ? "" : doc).split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s*未验证清单/.test(line.trim()));
  if (start === -1) return [];
  const rows = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s/.test(line.trim())) break;
    if (!line.trim().startsWith("|")) continue;
    const cells = cellsOf(line);
    if (cells.length < 4) continue;
    if (cells[0] === "项" || isSeparator(cells)) continue;
    rows.push({ line: index + 1, name: cells[0], owner: cells[1], why: cells[2], trigger: cells[3] });
  }
  return rows;
};

/**
 * 清单第 9 节那张对照表：`| 清单项 | 记回 docs/measurements.md 的哪一行 | 推进哪条 DoD |`。
 *
 * `primaryDod` 是这一格里的第一个 `DOD-<n>`（见文件头的约定）。
 */
export const checklistClaimRows = (doc) => {
  const lines = String(doc == null ? "" : doc).split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s*9[.、]/.test(line.trim()));
  if (start === -1) return [];
  const rows = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s/.test(line.trim())) break;
    if (!line.trim().startsWith("|")) continue;
    const cells = cellsOf(line);
    if (cells.length < 3) continue;
    if (cells[0] === "清单项" || isSeparator(cells)) continue;
    const dod = /DOD-\d+/.exec(cells[2]);
    rows.push({ line: index + 1, item: cells[0], target: cells[1], dod: cells[2], primaryDod: dod ? dod[0] : null });
  }
  return rows;
};

/** 清单文件头的状态：`pending` / `executed` / `unknown`（没有状态行）。 */
export const checklistStatus = (doc) => {
  const lines = String(doc == null ? "" : doc).split(/\r?\n/);
  const statusLine = lines.find((line) => /^>\s*状态[:：]/.test(line.trim()));
  if (statusLine === undefined) return "unknown";
  const pending = statusLine.includes(CHECKLIST_PENDING_MARK);
  const executed = statusLine.includes(CHECKLIST_EXECUTED_MARK);
  if (pending && executed) return "conflict";
  if (pending) return "pending";
  if (executed) return "executed";
  return "unknown";
};

/** `true` / `false` / `null`（这一条在文档里找不到）。 */
export const dodCheckboxOf = (doc, id) => {
  const pattern = new RegExp(`^-\\s*\\[([ xX])\\]\\s*${id}[:：]`);
  for (const line of String(doc == null ? "" : doc).split(/\r?\n/)) {
    const hit = pattern.exec(line.trim());
    if (hit) return hit[1].toLowerCase() === "x";
  }
  return null;
};

/** 触发条件里「按清单第 N 步去验」的形状。`第 8 节` 不算（见文件头）。 */
export const citesChecklistStep = (cell, checklistPath = CHECKLIST_DOC) =>
  String(cell == null ? "" : cell).includes(checklistPath) &&
  /第\s*[\d.]+(?:\s*[–\-—~]\s*[\d.]+)?\s*步/.test(String(cell));

/** 「为什么没验」那一格是否已经换成实测读数。 */
export const pastedReading = (cell) => {
  const text = String(cell == null ? "" : cell);
  return READING_DATE.test(text) && text.includes("读数");
};

/**
 * 门禁自己那句读数。第 122 轮把「清单存在 ≠ 读数已贴回」写成断言时，这句话还
 * 有个尾巴没被自己的规则覆盖：它里面四个数字（状态、第 9 节几行、未验证清单几行、
 * 其中几行按某一步去验）都是「数出来的」，而读者拿这张表去数，数出来的可能不是
 * 这个数——第 122 轮的提交与 `docs/measurements.md` 里记的是 11 行，另一位数出 10 行，
 * 而没有任何检查会红。数字要有断言，这条纪律对这句话也成立。
 *
 * 所以这句话不再手写在 run 里，而是由这个函数从三个数组现算；它的反面
 * `readClaimsSummary` 把印出来的句子重新读成数字。两个方向一起，才叫「读数」：
 * 写进句子的数字与表格里的数字是同一件事，读回来的数字又与自己相等。
 */
export const claimsSummaryLine = ({
  status,
  claimRows = [],
  rows = [],
  checklistPath = CHECKLIST_DOC,
  measurementsPath = MEASUREMENTS_DOC,
}) => {
  const cited = rows.filter((row) => citesChecklistStep(row.trigger, checklistPath)).length;
  return (
    `真机清单的欠账：${checklistPath} 状态 ${status}，第 9 节对照表 ${claimRows.length} 行，` +
    `${measurementsPath} 未验证清单 ${rows.length} 行，其中 ${cited} 行按清单的某一步去验`
  );
};

/** 从印出来的那句话里把四个数字读回来。读不出（`null`）是一个要报的结果，
 *  不是「跳过」：句子形状变了却不报，等于读数又回到没人核对的状态。 */
export const CLAIMS_SUMMARY_SHAPE = Object.freeze({
  status: /状态\s*([^\s，]+)，/,
  claims: /第 9 节对照表\s*(\d+)\s*行/,
  rows: /未验证清单\s*(\d+)\s*行/,
  cited: /其中\s*(\d+)\s*行按清单的某一步去验/,
});

export const readClaimsSummary = (line) => {
  const text = String(line == null ? "" : line);
  const pick = (pattern) => {
    const hit = pattern.exec(text);
    return hit === null ? null : hit[1];
  };
  const claims = pick(CLAIMS_SUMMARY_SHAPE.claims);
  const rows = pick(CLAIMS_SUMMARY_SHAPE.rows);
  const cited = pick(CLAIMS_SUMMARY_SHAPE.cited);
  return {
    status: pick(CLAIMS_SUMMARY_SHAPE.status),
    claims: claims === null ? null : Number(claims),
    rows: rows === null ? null : Number(rows),
    cited: cited === null ? null : Number(cited),
  };
};

/**
 * 「印出来的数字」与「算出来的数字」对不对得上。
 *
 * 这一条能红的唯一方式是那句话不再由现算得到——比如有人图省事把 11 写进模板、
 * 或者把某一项数漏。它不是同义反复：两边走的是两条路（一边是模板插值，一边是
 * 正则读回），反向控制就是拿一句被改坏一个数字的话喂进来。
 */
export const claimsSummaryViolations = ({ line, status, claimRows = [], rows = [], checklistPath = CHECKLIST_DOC }) => {
  const parsed = readClaimsSummary(line);
  const violations = [];
  const want = {
    rows: rows.length,
    cited: rows.filter((row) => citesChecklistStep(row.trigger, checklistPath)).length,
    claims: claimRows.length,
    status,
  };
  const label = { rows: "未验证清单的行数", cited: "其中按清单某一步去验的行数", claims: "第 9 节对照表的行数", status: "清单状态" };
  for (const key of ["status", "claims", "rows", "cited"]) {
    if (parsed[key] === null) {
      violations.push(
        `门禁这句话里读不出「${label[key]}」（形状见 tools/checklist-claims.mjs 的 CLAIMS_SUMMARY_SHAPE）：` +
          "读数要能被读回来才叫读数，形状变了却不报，等于这句话又回到没人核对的状态"
      );
      continue;
    }
    if (parsed[key] === want[key]) continue;
    violations.push(
      `门禁这句话里的「${label[key]}」是 ${parsed[key]}，而表格里实际是 ${want[key]}：` +
        "这句话是给人核对的第一手数字，它与表格对不上时，读的人会以为欠账比实际多或少"
    );
  }
  return violations;
};

/**
 * `docs/measurements.md` 里那句被引用最多的数字：门禁打印的「未验证清单 N 行，
 * 其中 M 行按清单的某一步去验」。实测表是历史读数，逐行都留着当时的样子；但
 * **最后一句**说「现在有几行」的读数必须与这张表现在相等——不然它就从「读数」
 * 变成了「去年的一句话」，而没有任何东西会红。
 */
export const QUOTED_ROW_COUNT = /未验证清单\s*(\d+)\s*行/;
export const QUOTED_CITED_COUNT = /其中\s*(\d+)\s*行按清单的某一步去验/;

/** 实测表里每一句引用这两个数字的行（1-based 行号）。 */
export const quotedRowCounts = (doc) => {
  const hits = [];
  String(doc == null ? "" : doc)
    .split(/\r?\n/)
    .forEach((text, index) => {
      const rows = QUOTED_ROW_COUNT.exec(text);
      if (rows === null) return;
      const cited = QUOTED_CITED_COUNT.exec(text);
      hits.push({ line: index + 1, rows: Number(rows[1]), cited: cited === null ? null : Number(cited[1]) });
    });
  return hits;
};

export const recordedCountViolations = ({ measurementsDoc, rows = [], checklistPath = CHECKLIST_DOC, measurementsPath = MEASUREMENTS_DOC }) => {
  const quoted = quotedRowCounts(measurementsDoc);
  const cited = rows.filter((row) => citesChecklistStep(row.trigger, checklistPath)).length;
  if (quoted.length === 0) {
    return [
      `${measurementsPath} 里没有任何一行记下门禁那句读数（形状：「未验证清单 N 行，其中 M 行按清单的某一步去验」）：` +
        "这两个数字每一轮都有人引用，却只在终端里出现过一次——下一次它腐掉时，没人能看出是哪一轮开始腐的",
    ];
  }
  const last = quoted[quoted.length - 1];
  const violations = [];
  if (last.cited === null) {
    violations.push(
      `${measurementsPath} 第 ${last.line} 行引用了「未验证清单 ${last.rows} 行」，却没写「其中 M 行按清单的某一步去验」：` +
        "两个数字要一起记，只记一个，另一个腐掉时这一行仍然是绿的"
    );
  } else if (last.cited !== cited) {
    violations.push(
      `${measurementsPath} 第 ${last.line} 行写「其中 ${last.cited} 行按清单的某一步去验」，而实际是 ${cited} 行：` +
        "读数与表格是同一件事，两个说法必须一致"
    );
  }
  if (last.rows !== rows.length) {
    violations.push(
      `${measurementsPath} 第 ${last.line} 行写「未验证清单 ${last.rows} 行」，而这张表现在有 ${rows.length} 行：` +
        "欠账行数变了就要补一行新读数（历史行留着当时的样子），否则最后一次读数成了假话"
    );
  }
  return violations;
};

/**
 * 三件事的违规清单。空数组是唯一可接受的结果。
 *
 * 参数都是文档正文（字符串），不是路径：这样反向控制可以只改一个事实，而不必在
 * 磁盘上造一份仓库。
 */
export const checklistClaimViolations = ({
  measurementsDoc,
  checklistDoc,
  dodDoc,
  checklistPath = CHECKLIST_DOC,
  measurementsPath = MEASUREMENTS_DOC,
  dodPath = DOD_DOC,
}) => {
  const checklist = String(checklistDoc == null ? "" : checklistDoc);
  if (checklist.trim() === "") {
    // 清单不见了要红两次，因为坏掉的是两件事：说明书没了，以及未验证清单里那几行
    // 「按它去验」的补法失去了落点。只报第一件，读者会以为「把文件放回来」就够了，
    // 而真正要问的是「那几行现在指向哪里」——所以第二句点名行号与行名。
    const orphans = unverifiedRows(measurementsDoc).filter((row) => row.trigger.includes(checklistPath));
    return [
      `${checklistPath} 读不到或为空：真机那一趟的说明书不见了，而未验证清单里还有几行写着「按它去验」——` +
        "一份空文件不会说它错了，所以这里直接判红",
      ...(orphans.length
        ? [
            `${measurementsPath} 里还有 ${orphans.length} 行把补法指向那份清单（第 ${orphans
              .map((row) => row.line)
              .join("、")} 行：${orphans.map((row) => row.name).join("、")}）：` +
              "清单不见了，这几行的「下次怎么补」就没有落点——放回文件，或者把这几行改指别处",
          ]
        : []),
    ];
  }

  const violations = [];
  const status = checklistStatus(checklist);
  if (status === "unknown") {
    violations.push(
      `${checklistPath} 的文件头没有状态行（\`> 状态：\` 开头，写「${CHECKLIST_PENDING_MARK}」或「${CHECKLIST_EXECUTED_MARK}」）：` +
        "这一条靠它区分「还没跑」与「跑过了」，读不出状态就无从判断下面几条该按哪一边问"
    );
  }
  if (status === "conflict") {
    violations.push(
      `${checklistPath} 的状态行同时写着「${CHECKLIST_PENDING_MARK}」与「${CHECKLIST_EXECUTED_MARK}」：` +
        "两个状态只能留一个——同时写着，读者与脚本会各读一半"
    );
  }

  const claims = checklistClaimRows(checklist);
  if (claims.length === 0) {
    violations.push(
      `${checklistPath} 里没有第 9 节那张「读数记回哪一行」的对照表（\`## 9.\` 标题下的三列表格）：` +
        "没有它，那一趟跑完的读数没有落点，未验证清单里那几行也就没人知道该换成什么"
    );
  }

  const rows = unverifiedRows(measurementsDoc);
  if (rows.length === 0) {
    violations.push(
      `${measurementsPath} 里没有「## 未验证清单」这一节，或那一节的表里一行都没有：` +
        "这一条问的是「哪些欠账还在、它们指向哪份记录」，没有行就没有可核对的欠账"
    );
  }

  const byName = new Map(rows.map((row) => [claimKey(row.name), row]));
  const claimed = new Set(claims.map((claim) => claimKey(claim.target)));

  // 正向：对照表点名的每一行，在清单还没执行时必须在未验证清单里，且触发条件引用清单。
  for (const claim of claims) {
    const row = byName.get(claimKey(claim.target));
    if (row === undefined) {
      if (status === "pending") {
        violations.push(
          `${checklistPath} 第 ${claim.line} 行说读数记回「${claim.target}」，而 ${measurementsPath} 的未验证清单里没有这一行：` +
            `清单文件头还写着「${CHECKLIST_PENDING_MARK}」——行先没了，就是读数没贴回就把欠账删了`
        );
      }
      continue;
    }
    if (!row.trigger.includes(checklistPath)) {
      violations.push(
        `${measurementsPath} 第 ${row.line} 行（${row.name}）的「下次要验的触发条件」没有引用 ${checklistPath}：` +
          "这一行的补法就是按那份清单跑一趟，路径不写在这里，清单被改名或删掉时这一行会变成一句没有落点的待办"
      );
    }
  }

  // 反向：未验证清单里「按清单第 N 步去验」的每一行，都得在对照表里有一格。
  for (const row of rows) {
    if (!citesChecklistStep(row.trigger, checklistPath)) continue;
    if (claimed.has(claimKey(row.name))) continue;
    violations.push(
      `${measurementsPath} 第 ${row.line} 行（${row.name}）说按 ${checklistPath} 的某一步去验，` +
        `而清单第 9 节没有给它「记回哪一行」：那一趟跑完，这一行的读数没有落点`
    );
  }

  // DoD 的方括号：勾上之前，读数必须已经贴回。
  const dod = String(dodDoc == null ? "" : dodDoc);
  if (dod.trim() === "") {
    violations.push(`${dodPath} 读不到或为空：DOD-5 / DOD-6 的方括号无从核对，而这一条要防的正是「提前勾」`);
    return violations;
  }
  for (const id of ["DOD-5", "DOD-6"]) {
    const checked = dodCheckboxOf(dod, id);
    if (checked === null) {
      violations.push(`${dodPath} 里找不到 ${id} 的方括号行（\`- [ ] ${id}：\`）：这一条要核对的条目不见了`);
      continue;
    }
    if (!checked) continue;
    if (status !== "executed") {
      violations.push(
        `${dodPath} 的 ${id} 已经勾上，而 ${checklistPath} 的文件头还写着「${CHECKLIST_PENDING_MARK}」：` +
          "那一趟真机跑还没做过，勾选就没有读数撑着——先跑、把读数贴回，再改状态行"
      );
    }
    for (const claim of claims.filter((entry) => entry.primaryDod === id)) {
      const row = byName.get(claimKey(claim.target));
      if (row === undefined) continue; // 行已搬走 = 读数贴回，这是允许的形状
      if (row.why.includes(checklistPath)) {
        violations.push(
          `${measurementsPath} 第 ${row.line} 行（${row.name}）的「为什么没验」还写着按 ${checklistPath} 去验：` +
            `${id} 已经勾了，这一格该换成实测读数——勾上之后「为什么还没验」就是假话`
        );
        continue;
      }
      if (!pastedReading(row.why)) {
        violations.push(
          `${measurementsPath} 第 ${row.line} 行（${row.name}）的「为什么没验」里没有读数（要含日期 YYYY-MM-DD 与「读数」二字）：` +
            `${id} 已经勾了，这一格必须已经换成那一趟跑出来的读数`
        );
      }
    }
  }

  return violations;
};

/* ---- the run ---- */

const isEntryPoint = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (isEntryPoint) {
  const read = (target) => {
    const full = path.join(ROOT, target);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
  };
  const measurementsDoc = read(MEASUREMENTS_DOC);
  const checklistDoc = read(CHECKLIST_DOC);
  const dodDoc = read(DOD_DOC);

  const status = checklistStatus(checklistDoc);
  const claims = checklistClaimRows(checklistDoc);
  const rows = unverifiedRows(measurementsDoc);
  const summaryLine = claimsSummaryLine({ status, claimRows: claims, rows });
  const violations = [
    // 门禁自己那句话先过一遍自己的规则：印出来的数字要能读回来、且与表格相等。
    ...claimsSummaryViolations({ line: summaryLine, status, claimRows: claims, rows }),
    ...recordedCountViolations({ measurementsDoc, rows }),
    ...checklistClaimViolations({ measurementsDoc, checklistDoc, dodDoc }),
  ];

  console.log(summaryLine);
  for (const violation of violations) console.log(`FAIL    ${violation}`);
  if (violations.length) {
    console.log(
      `\n${violations.length} 处问题。规则写在 tools/checklist-claims.mjs 顶部，反向控制在 tools/checklist-claims-smoke.mjs。`
    );
    process.exit(1);
  }
  console.log("真机清单的欠账：0 处问题（清单存在 ≠ 读数已贴回，这一条问的是后者）");
}
