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
// 第四件事是同一份文件里的另一半（第 125 轮）：**实测表本身有没有被空行切断**。
// `docs/measurements.md` 有两张表，上面那张是「跑过什么」，下面那张是「没跑过什么」；
// 前三件事核的是下面那张与人读的清单之间的缝，上面那张却只有「行读得出来」这一层
// 被用过——第 121–124 轮各加一行、每行前留一个空行，Markdown 于是渲染成五张表，
// 后四行是带竖线的段落，而脚本读到的行一个不少。断言因此问渲染形状而不是行数，
// 细节写在 `measurementTableViolations` 上面。
//
// 第五件事（第 126 轮）是第 10 节那一节本身：**最小可行子集从「说明书」推到「待填表」**。
// 前四件事核的都是「读数有没有落点」，而落点写得再准，一个拿到 Windows 机器的人仍要
// 读完整节才知道「读数写在哪、贴回哪一行」。所以第 10 节改成 10.1 四格读数 + 10.2 两行
// 贴回模板，这一条核的是那张待填表本身：四格都在、每格都留着空、模板两行与第 9 节的
// 落点是同一件事、模板的行名真的在未验证清单里。细节写在 `subsetFormViolations` 上面。
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
  templateRows = [],
  rows = [],
  checklistPath = CHECKLIST_DOC,
  measurementsPath = MEASUREMENTS_DOC,
}) => {
  const cited = rows.filter((row) => citesChecklistStep(row.trigger, checklistPath)).length;
  return (
    `真机清单的欠账：${checklistPath} 状态 ${status}，第 9 节对照表 ${claimRows.length} 行，` +
    `第 10 节贴回模板 ${templateRows.length} 行，` +
    `${measurementsPath} 未验证清单 ${rows.length} 行，其中 ${cited} 行按清单的某一步去验`
  );
};

/** 从印出来的那句话里把四个数字读回来。读不出（`null`）是一个要报的结果，
 *  不是「跳过」：句子形状变了却不报，等于读数又回到没人核对的状态。 */
export const CLAIMS_SUMMARY_SHAPE = Object.freeze({
  status: /状态\s*([^\s，]+)，/,
  claims: /第 9 节对照表\s*(\d+)\s*行/,
  template: /第 10 节贴回模板\s*(\d+)\s*行/,
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
  const template = pick(CLAIMS_SUMMARY_SHAPE.template);
  const rows = pick(CLAIMS_SUMMARY_SHAPE.rows);
  const cited = pick(CLAIMS_SUMMARY_SHAPE.cited);
  return {
    status: pick(CLAIMS_SUMMARY_SHAPE.status),
    claims: claims === null ? null : Number(claims),
    template: template === null ? null : Number(template),
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
export const claimsSummaryViolations = ({
  line,
  status,
  claimRows = [],
  templateRows = [],
  rows = [],
  checklistPath = CHECKLIST_DOC,
}) => {
  const parsed = readClaimsSummary(line);
  const violations = [];
  const want = {
    rows: rows.length,
    cited: rows.filter((row) => citesChecklistStep(row.trigger, checklistPath)).length,
    claims: claimRows.length,
    template: templateRows.length,
    status,
  };
  const label = {
    rows: "未验证清单的行数",
    cited: "其中按清单某一步去验的行数",
    claims: "第 9 节对照表的行数",
    template: "第 10 节贴回模板的行数",
    status: "清单状态",
  };
  for (const key of ["status", "claims", "template", "rows", "cited"]) {
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
 * `docs/measurements.md` 的实测表：`# 实测值` 这一节里那张表，一段一张。
 *
 * 这张表是「跑过什么」的唯一一份记录，也是本仓唯一一张**会被外面的人读**的表：
 * README 指着它，读者按它的行核对。第 121–124 轮各自往表里加了一行，但每行前面
 * 都留了一个空行——于是 Markdown 把它渲染成五张表：只有第一张有表头，后面四段是
 * 带竖线的**普通段落**。脚本读它时按「`|` 开头的行」照读，行都在，所以这件事在
 * 门禁里看不见：表格有两份形状（渲染出来的、脚本读的），只有一份被核对过。这正
 * 是第 119 轮收过的「同一份读数、两处各解析一次」那一类病的残留。
 *
 * 所以断言问的是**渲染形状**，四件事：
 *   1. `# 实测值` 这一节有一张表，表头逐字是 `| 日期 | 场景 | 实测 | 来源 |`；
 *   2. 表头下面紧跟分隔行（`| --- | …`），且整张表只有这一行分隔行；
 *   3. 从表头到最后一行表格行之间**没有空行、没有不是表格行的行**——空行把表切成
 *      两张，第二张没有表头；
 *   4. 每一行的列数与表头相等——列数不一致会渲染成错位的格子，或者干脆不成表。
 *
 * 只读文档正文，不读磁盘、不读 git，所以浅克隆里也能跑。反向控制在
 * `tools/checklist-claims-smoke.mjs`：每格只改一个事实，要求点名文件与行号。
 */
export const MEASURED_TABLE_HEADER = Object.freeze(["日期", "场景", "实测", "来源"]);

const measuredTableSection = (doc) => {
  const lines = String(doc == null ? "" : doc).split(/\r?\n/);
  const start = lines.findIndex((line) => /^#\s*实测值/.test(line.trim()));
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  return { lines, start, end };
};

/** 实测表的行（1-based 行号 + 单元格），分隔行不算——它不是一个读数。
 *  第一行是表头，所以「有几条实测」= `length - 1`。 */
export const measuredTableRows = (doc) => {
  const section = measuredTableSection(doc);
  if (section === null) return [];
  const rows = [];
  for (let index = section.start + 1; index < section.end; index += 1) {
    const trimmed = section.lines[index].trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = cellsOf(trimmed);
    if (isSeparator(cells)) continue;
    rows.push({ line: index + 1, cells });
  }
  return rows;
};

export const measurementTableViolations = ({ measurementsDoc, measurementsPath = MEASUREMENTS_DOC }) => {
  const section = measuredTableSection(measurementsDoc);
  if (section === null) {
    return [
      `${measurementsPath} 里找不到「# 实测值」这一节：这张表是「跑过什么」的唯一记录，` +
        "标题被改名或删掉时，下面几条都无从问起（形状：`# 实测值`）",
    ];
  }
  const { lines, start, end } = section;
  const at = (index) => index + 1;
  const isTableLine = (line) => line.trim().startsWith("|");

  // 表头是这一节里第一行以「日期」开头的表格行。它若不是（该节根本没有表，
  // 或者表头被换掉），下面那句话要说清「没有表头」，而不是逐行报列数。
  let headerIndex = -1;
  for (let index = start + 1; index < end; index += 1) {
    if (!isTableLine(lines[index])) continue;
    if (cellsOf(lines[index].trim())[0] === MEASURED_TABLE_HEADER[0]) headerIndex = index;
    break;
  }
  if (headerIndex === -1) {
    return [
      `${measurementsPath} 第 ${at(start)} 行起的「# 实测值」这一节里没有表头（形状：\`| 日期 | 场景 | 实测 | 来源 |\`）：` +
        "没有表头，这张表渲染出来只是一段带竖线的文字——读的人看到的不是表格",
    ];
  }

  const violations = [];
  const headerCells = cellsOf(lines[headerIndex].trim());
  if (headerCells.join("|") !== MEASURED_TABLE_HEADER.join("|")) {
    violations.push(
      `${measurementsPath} 第 ${at(headerIndex)} 行的表头是「${headerCells.join(" | ")}」，` +
        `应为「${MEASURED_TABLE_HEADER.join(" | ")}」：这四列是这张表的四个问题（何时、什么、多少、怎么来的），` +
        "改掉一列，下面的行就与它对不上"
    );
  }
  const separatorIndex = headerIndex + 1;
  const separatorOk =
    separatorIndex < end && isTableLine(lines[separatorIndex]) && isSeparator(cellsOf(lines[separatorIndex].trim()));
  if (!separatorOk) {
    violations.push(
      `${measurementsPath} 第 ${at(separatorIndex)} 行应为表头分隔行（\`| --- | --- | --- | --- |\`）：` +
        "缺了它，markdown 不把这一组行当表——连表头一起变成段落"
    );
  }

  // 最后一行表格行：它之后的空行与正文属于这一节，不属于表。
  let lastRow = headerIndex;
  for (let index = headerIndex + 1; index < end; index += 1) if (isTableLine(lines[index])) lastRow = index;

  for (let index = headerIndex + 1; index <= lastRow; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === "") {
      violations.push(
        `${measurementsPath} 第 ${at(index)} 行是空行，把实测表断成了两张：后面那几行因此没有表头，` +
          "渲染出来是带竖线的普通段落——脚本仍按「`|` 开头」把它们读成行，所以这件事只在人眼前才看得见"
      );
      continue;
    }
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
      violations.push(
        `${measurementsPath} 第 ${at(index)} 行夹在实测表里，却不是表格行（首尾都要是 \`|\`）：` +
          "一行正文落在表中间，markdown 会在这里结束表格，后面的行重新变成段落"
      );
      continue;
    }
    const cells = cellsOf(trimmed);
    if (isSeparator(cells)) {
      if (index !== separatorIndex) {
        violations.push(
          `${measurementsPath} 第 ${at(index)} 行又是一行表头分隔行：一张表只该有一行——` +
            "出现第二行，说明这张表被切成了两张（第二张没有表头，渲染出来是段落）"
        );
      }
      continue;
    }
    if (index !== headerIndex && cells[0] === MEASURED_TABLE_HEADER[0]) {
      violations.push(
        `${measurementsPath} 第 ${at(index)} 行又出现了一次表头（「${MEASURED_TABLE_HEADER[0]}」）：` +
          "表头在实测表里只该有一次，第二次出现意味着这里被断成了另一张表"
      );
      continue;
    }
    if (cells.length !== headerCells.length) {
      violations.push(
        `${measurementsPath} 第 ${at(index)} 行有 ${cells.length} 列，而表头是 ${headerCells.length} 列：` +
          "列数不一致时这一行会渲染成错位的格子，或者干脆不成为表格的一部分——" +
          "四列各回答一个问题，空着的那格写「—」，不要省略"
      );
    }
  }
  return violations;
};
/* ---- 第 10 节：最小可行子集，从「说明书」推到「待填表」 ----
 *
 * 第 122 轮把「清单存在 ≠ 读数已贴回」写成断言之后，第 10 节那四格仍然只是一段散文：
 * 一个拿到 Windows 机器的人要读完整节才知道「读数写在哪、贴回哪一行」。第 126 轮把它
 * 改成待填表——10.1 的四格各留一个「读数格」，10.2 是两行可以直接复制、只填空就能贴回
 * `docs/measurements.md` 的模板。
 *
 * 待填表比说明书多一个风险：**同一件事写了两处**。模板里的行名是第 9 节那张对照表的
 * 落点，第 9 节改了落点而模板没跟着改，人就会把读数贴到一行不存在的名字上——而那时
 * 清单还是绿的。所以这一条问四件事：
 *
 *   1. 10.1 那张「读数格」表在，四格的步骤号恰好是 1 / 2.2 / 4.2 / 5.2（顺序也照这个），
 *      且每一格的最后一列都留着一个空（`____`）——没有空，就不是待填表；
 *   2. 10.2 的围栏块里恰好两行，每行四列（与未验证清单同形），「为什么没验」那一格
 *      同时留着空、日期占位符 `YYYY-MM-DD` 与「读数」二字——这三样正是 `pastedReading`
 *      认的标记，缺一样，贴回去仍然算没贴；
 *   3. 模板的行名集合必须等于第 9 节里那四格点到的行名集合——两处说的是同一件事；
 *   4. 模板的每一行都真的在未验证清单里——贴回时替换的是同名行，名字错了就没有落点。
 *
 * 第 138 轮加的是第五件事，也是这一节唯一还缺的那一半：**四格仍然太长**。真机上被打断
 * 是常态，而「四格跑不完」和「一格都跑不了」在证据上是同一件事——什么都没留下。所以
 * 10.1 里有两格标着「可单独跑」（第 1 格 SmartScreen 与第 5.2 格两条 grep）：它们不依赖
 * 前面任何一格，装一次、填一个可丢弃的 Key 就能各留一条读数，分别给 DOD-5 与 DOD-6。
 * 这一条因此还问：标着「可单独跑」的恰好是这两格，且它们按第 9 节的归属真的落在两条
 * 不同的 DoD 上——标错了格，或者两格都归同一条 DoD，那「各留一条读数」就是假话。
 *
 * 第 141 轮加的是第六件事：§10.0 那条**合成命令**与 §5.2 那两处必须是同一件事。合成之前是两次
 * 复制（「3 分钟」并不成立），合成之后是同两个目录写在两个地方——所以绑一次：同两个路径、同一个
 * `-Pattern`、且只留一行可复制。细节写在 `subsetSoloCommandViolations` 上面。
 */
export const SUBSET_STEPS = Object.freeze(["1", "2.2", "4.2", "5.2"]);
export const SUBSET_BLANK = "____";
export const SUBSET_DATE_PLACEHOLDER = "YYYY-MM-DD";
export const SUBSET_GRID_HEADER_LAST = "读数格";

/** 10.1 里「这一格不依赖别的格」的标记。它出现在「做什么」那一格里，不是新加一列——
 *  加列会让「读数格」不再是最后一列，而那一列的位置是上面第 1 条在核的东西。 */
export const SUBSET_SOLO_MARK = "可单独跑";
/** 标着「可单独跑」的两格：第 1 格给 DOD-5，第 5.2 格给 DOD-6。 */
export const SUBSET_SOLO_STEPS = Object.freeze(["1", "5.2"]);
/** 第 10 节标题里那句时长承诺。四格约 5 分钟，两格约 3 分钟——标题写的是**最短**那条路。 */
export const SUBSET_MINUTES_MARK = "3 分钟";

/** 某一节的行范围（`start` 是标题行，`end` 是下一个二级标题）。`###` 不算二级标题，
 *  所以第 10 节里的 10.1 / 10.2 / 10.3 都落在同一段里。 */
const sectionRange = (doc, headingPattern) => {
  const lines = String(doc == null ? "" : doc).split(/\r?\n/);
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  return { lines, start, end };
};

/** 第 10 节那一行标题（`## 10. 最小可行子集（3 分钟起）`）。标题里那句时长是这一节
 *  对读者的承诺：最短那条路要多久。读不到标题时返回 null，由调用方决定怎么报。 */
export const subsetHeading = (doc) => {
  const range = sectionRange(doc, /^##\s*10[.、]/);
  return range === null ? null : range.lines[range.start].trim();
};

/** 一格开头那个步骤号（`1 SmartScreen` → `1`，`2.2 安装目录页` → `2.2`）。 */
export const stepOf = (cell) => {
  const hit = /^(\d+(?:\.\d+)*)/.exec(String(cell == null ? "" : cell).trim());
  return hit === null ? null : hit[1];
};

/** 第 10 节里那张「读数格」表：一行一格，最后一列是给人填的空。 */
export const subsetGridRows = (doc) => {
  const range = sectionRange(doc, /^##\s*10[.、]/);
  if (range === null) return [];
  const { lines, start, end } = range;
  let headerIndex = -1;
  for (let index = start + 1; index < end; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = cellsOf(trimmed);
    if (cells[cells.length - 1] === SUBSET_GRID_HEADER_LAST) {
      headerIndex = index;
      break;
    }
  }
  if (headerIndex === -1) return [];
  const rows = [];
  for (let index = headerIndex + 1; index < end; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed.startsWith("|")) break;
    const cells = cellsOf(trimmed);
    if (isSeparator(cells)) continue;
    rows.push({ line: index + 1, step: stepOf(cells[0]), cells });
  }
  return rows;
};

/** 第 10 节里那个围栏块中的表格行（贴回模板）。只认围栏里的行：围栏外的表格是
 *  10.1 那张读数格表，两者混在一起读会让「模板有几行」答错。 */
export const subsetPastebackRows = (doc) => {
  const range = sectionRange(doc, /^##\s*10[.、]/);
  if (range === null) return [];
  const { lines, start, end } = range;
  const rows = [];
  let inFence = false;
  for (let index = start + 1; index < end; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence || !trimmed.startsWith("|")) continue;
    const cells = cellsOf(trimmed);
    if (isSeparator(cells)) continue;
    rows.push({ line: index + 1, name: cells[0], cells });
  }
  return rows;
};

/* ---- 10.0 那一条合成命令（第 141 轮） ----
 *
 * 第 138 轮把三分钟那条路写成「原样复制 §5.2 那两条命令」，可两条命令就是两次复制、两种期望读数，
 * 而 §5.2 那两条里第二条还跨了两行——「3 分钟」在那一刻其实不成立。第 141 轮把它合成一条
 * （两个计数、一次输出）。合成之后多出来的东西不是便利，是一个**副本**：同两个目录现在写在两个地方，
 * 而清单的第 9 节把读数记回的是 §5.2 那一处。副本不核对就会各自漂——把 §10.0 那条里的安装目录改成
 * `D:\Apps\…`，跑的人扫的是别的目录，贴回来的读数说的却是默认目录，而整份清单仍是绿的。
 *
 * 所以这一条把 §10.0 那条命令绑回 §5.2：
 *   1. 两处围栏块都读得出来，且 §5.2 里真的读得出路径（读不出就红——那等于这一条没有权威）；
 *   2. §10.0 的块里**只有一行**命令：「复制一件事」是这一节的承诺，拆成两行就回到第 138 轮之前；
 *   3. 两条命令里出现的路径字面量（`$env:…`、`X:\…`、含 `\` 的那些）必须**两边相等**，
 *      `-Pattern` 的值也一样——差一个目录就是两个不同的读数。
 */
export const SUBSET_SOLO_HEADING = /^###\s*10\.0/;
export const GREP_STEP_HEADING = /^###\s*5\.2/;

/**
 * 某个小节（`### 5.2` / `### 10.0`）里围栏块中的非空行，带行号。
 *
 * 返回 `null` 表示**小节不存在**，返回空数组表示「小节在，里面没有可复制的那件事」——两者是不同的
 * 欠账，合成一句话会让读的人不知道该补哪一样。围栏外的正文一律不取：这一条问的是「要复制的那件事」，
 * 而散文里提到同一个路径不算副本。
 */
export const subsectionCommands = (doc, headingPattern) => {
  const lines = String(doc == null ? "" : doc).split(/\r?\n/);
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start === -1) return null;
  const out = [];
  let inFence = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (/^##/.test(trimmed)) break;
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence && trimmed !== "") out.push({ line: index + 1, text: trimmed });
  }
  return out;
};

/** 命令里的引号字面量（双引号与单引号都算——PowerShell 两种都接受）。 */
export const shellQuotedLiterals = (text) => {
  const found = [];
  const pattern = /"([^"\r\n]*)"|'([^'\r\n]*)'/g;
  let hit;
  while ((hit = pattern.exec(String(text == null ? "" : text))) !== null) found.push(hit[1] ?? hit[2]);
  return found;
};

/** 看起来像一个文件系统位置的引号字面量：`$env:` 开头、盘符开头，或含反斜杠。 */
export const isShellPathLiteral = (literal) => {
  const text = String(literal == null ? "" : literal);
  return /^\$env:/i.test(text) || /^[A-Za-z]:[\\/]/.test(text) || text.includes("\\");
};

/** 一条命令里出现的路径字面量集合（去重、保序）。 */
export const shellPathLiterals = (text) => [...new Set(shellQuotedLiterals(text).filter(isShellPathLiteral))];

/** 一条命令里 `-Pattern` 的值集合：两处比的是不是同一个东西。 */
export const shellPatternLiterals = (text) => {
  const found = [];
  const pattern = /-Pattern\s+"([^"\r\n]*)"|-Pattern\s+'([^'\r\n]*)'/g;
  let hit;
  while ((hit = pattern.exec(String(text == null ? "" : text))) !== null) found.push(hit[1] ?? hit[2]);
  return [...new Set(found)];
};

const symmetricDiff = (want, got) => {
  const a = [...new Set(want || [])];
  const b = [...new Set(got || [])];
  return { missing: a.filter((item) => !b.includes(item)), extra: b.filter((item) => !a.includes(item)) };
};

export const subsetSoloCommandViolations = ({ checklistDoc, checklistPath = CHECKLIST_DOC }) => {
  const grep = subsectionCommands(checklistDoc, GREP_STEP_HEADING);
  const solo = subsectionCommands(checklistDoc, SUBSET_SOLO_HEADING);
  if (grep === null) {
    return [
      `${checklistPath} 里读不到 §5.2 那一节的围栏命令（\`### 5.2\`）：那两条命令是「扫哪两个目录」的权威，` +
        "它不见了，第 10 节那条合成命令就没有可对照的另一半了",
    ];
  }
  const grepText = grep.map((entry) => entry.text).join("\n");
  const wantPaths = shellPathLiterals(grepText);
  if (wantPaths.length === 0) {
    return [
      `${checklistPath} §5.2 的围栏命令里读不出任何路径字面量（\`$env:…\`、\`X:\\…\` 或含 \`\\\` 的引号串）：` +
        "这一条靠那两处路径作权威，读不出时比对无从问起——不静默通过",
    ];
  }
  if (solo === null) {
    return [
      `${checklistPath} 里读不到 §10.0 那条合成命令的围栏块（\`### 10.0\`）：三分钟那条路因此又变成「复制两件事」，` +
        "而这一节存在的理由就是让被打断的人一次复制、一次输出",
    ];
  }
  if (solo.length === 0) {
    return [
      `${checklistPath} §10.0 那一节的围栏块里一行命令都没有：读得出小节却读不出要复制的那件事，` +
        "空围栏比没有围栏更容易被读成「已经写好了」",
    ];
  }

  const violations = [];
  const firstLine = solo[0].line;
  if (solo.length !== 1) {
    violations.push(
      `${checklistPath} 第 ${firstLine} 行起，§10.0 的围栏里有 ${solo.length} 行命令，应为 1 行：` +
        "这一节对读者的承诺是「三分钟里只复制一件事」，拆成两行就回到第 138 轮那个「两条命令、两种读数」的形状"
    );
  }
  const soloText = solo.map((entry) => entry.text).join("\n");
  const checks = [
    ["扫的目录", wantPaths, shellPathLiterals(soloText)],
    ["`-Pattern` 的值", shellPatternLiterals(grepText), shellPatternLiterals(soloText)],
  ];
  for (const [label, want, got] of checks) {
    const { missing, extra } = symmetricDiff(want, got);
    if (!missing.length && !extra.length) continue;
    violations.push(
      `${checklistPath} 第 ${firstLine} 行那条合成命令与 §5.2 不是同一件事——${label}：§5.2 里有而这条没有「${missing.join("、") || "（无）"}」，` +
        `这条多出「${extra.join("、") || "（无）"}」：同一个读数写在两个地方，第 9 节把读数记回的是 §5.2 那一处，` +
        "两处各扫一个目录时，贴回来的读数说的是另一个目录"
    );
  }
  return violations;
};

export const subsetFormViolations = ({
  checklistDoc,
  measurementsDoc,
  checklistPath = CHECKLIST_DOC,
  measurementsPath = MEASUREMENTS_DOC,
}) => {
  const checklist = String(checklistDoc == null ? "" : checklistDoc);
  if (sectionRange(checklist, /^##\s*10[.、]/) === null) {
    return [
      `${checklistPath} 里没有第 10 节（最小可行子集）：那一节是「一次跑不完也能留下一条读数」的入口，` +
        "它不见了，真机上被打断的人就只剩 20–30 分钟的完整跑这一条路",
    ];
  }

  const violations = [];

  // 0. 标题里那句时长承诺。四格约 5 分钟，标着「可单独跑」的两格约 3 分钟——标题写的是
  //    最短那条路，因为读者是在「我只有三分钟」的时候翻到这一节的。
  const heading = subsetHeading(checklist);
  if (heading !== null && !heading.includes(SUBSET_MINUTES_MARK)) {
    violations.push(
      `${checklistPath} 第 10 节的标题是「${heading}」，里面没有「${SUBSET_MINUTES_MARK}」：` +
        "标题那句时长是这一节对读者的承诺——四格约 5 分钟，而标着「可单独跑」的两格约 3 分钟；" +
        "标题只写 5 分钟，只有三分钟的人会以为这一节轮不到他，于是什么都不留"
    );
  }

  // 1. 10.1 的四格读数表。
  const grid = subsetGridRows(checklist);
  if (grid.length === 0) {
    violations.push(
      `${checklistPath} 第 10 节里没有「读数格」那张表（表头最后一列逐字是「${SUBSET_GRID_HEADER_LAST}」）：` +
        "没有它，这一节又回到「读完整节才知道读数写在哪」"
    );
  } else {
    const steps = grid.map((row) => row.step);
    if (steps.join(",") !== SUBSET_STEPS.join(",")) {
      violations.push(
        `${checklistPath} 第 10 节读数格表的四格是「${steps.join(" / ")}」，应为「${SUBSET_STEPS.join(" / ")}」：` +
          "这四格就是最小证据的四步，多一格少一格或换了顺序，第 9 节那张对照表就对不上了"
      );
    }
    for (const row of grid) {
      const cell = row.cells[row.cells.length - 1];
      if (cell.includes(SUBSET_BLANK)) continue;
      violations.push(
        `${checklistPath} 第 ${row.line} 行（第 ${row.step} 格）的「${SUBSET_GRID_HEADER_LAST}」里没有留空（\`${SUBSET_BLANK}\`）：` +
          "这一列是给人填的，没有空就只是一句期望读数——待填表与说明书的区别就在这一格"
      );
    }
  }

  // 1b. 「可单独跑」的两格：最小子集里还有一条更短的路。
  //
  // 这一条不是「允许出现」而是一条正面断言：标着的必须恰好是第 1 格与第 5.2 格。多标一格，
  // 读者会以为别的格也能单独跑（第 2.2 格要走到目录页、第 4.2 格要装完再起一次，都不止
  // 三分钟）；少标一格，这条路就不存在了，而它正是这一轮要补的那一半。
  //
  // 表本身不在时上面那句已经说了「没有那张表」；再报一条「一格都没标」只是同一件事的
  // 第二种说法，读者会以为缺了两样东西。
  const solo = grid.filter((row) => row.cells.some((cell) => cell.includes(SUBSET_SOLO_MARK)));
  const soloSteps = solo.map((row) => row.step);
  if (grid.length === 0) {
    // 没有表就没有格可标，上面那句已经报过。
  } else if (soloSteps.join(",") !== SUBSET_SOLO_STEPS.join(",")) {
    violations.push(
      `${checklistPath} 第 10 节标着「${SUBSET_SOLO_MARK}」的格是「${soloSteps.join(" / ") || "（没有）"}」，` +
        `应为「${SUBSET_SOLO_STEPS.join(" / ")}」：这两格是「装一次就能各留一条读数」的那条路，` +
        "多标一格会让读者以为别的格也能单独跑，少标一格则这条路不存在"
    );
  } else {
    // 两格必须真的落在两条不同的 DoD 上。第 9 节是按节组织的（`5 配置与 Key 的位置`
    // 覆盖 5.1–5.4），所以按步骤号的第一段去找那一行——找不到就是第 9 节改了落点。
    const claims = checklistClaimRows(checklist);
    const dodOfStep = (step) => {
      const head = step.split(".")[0];
      const claim = claims.find((row) => stepOf(row.item) === head);
      return claim === undefined ? null : claim.primaryDod;
    };
    const dods = soloSteps.map(dodOfStep);
    const missing = soloSteps.filter((step, index) => dods[index] === null);
    if (missing.length) {
      violations.push(
        `${checklistPath} 第 10 节标着「${SUBSET_SOLO_MARK}」的第 ${missing.join(" / ")} 格在第 9 节那张对照表里没有落点：` +
          "这两格的意义是「各给一条 DoD 留一条读数」，第 9 节读不出它推进哪一条，这一趟跑完就不知道该勾哪条"
      );
    } else if (new Set(dods).size !== dods.length) {
      violations.push(
        `${checklistPath} 第 10 节标着「${SUBSET_SOLO_MARK}」的两格按第 9 节都归 ${dods[0]}：` +
          "最小子集的意义是「两条 DoD 各留一条读数」，两格归同一条，另一条跑完仍然勾不上"
      );
    }
  }

  // 2. 10.2 的贴回模板。
  const paste = subsetPastebackRows(checklist);
  if (paste.length === 0) {
    violations.push(
      `${checklistPath} 第 10 节里没有贴回模板（围栏块里的表格行）：` +
        "没有它，跑完的人仍要自己拼一行 markdown 才能贴回未验证清单"
    );
  }
  for (const row of paste) {
    if (row.cells.length !== 4) {
      violations.push(
        `${checklistPath} 第 ${row.line} 行的贴回模板有 ${row.cells.length} 列，而未验证清单是四列（项 / 归属 / 为什么没验 / 触发条件）：` +
          "列数不对，贴回去会把整张表挤歪"
      );
      continue;
    }
    const why = row.cells[2];
    const missing = [
      why.includes(SUBSET_BLANK) ? null : `空（\`${SUBSET_BLANK}\`）`,
      why.includes(SUBSET_DATE_PLACEHOLDER) ? null : `日期占位符（\`${SUBSET_DATE_PLACEHOLDER}\`）`,
      why.includes("读数") ? null : "「读数」二字",
    ].filter(Boolean);
    if (missing.length) {
      violations.push(
        `${checklistPath} 第 ${row.line} 行的贴回模板「为什么没验」那一格缺 ${missing.join("、")}：` +
          "这三样正是 `pastedReading` 认的标记，缺一样，贴回去仍然算没贴"
      );
    }
    if (!citesChecklistStep(row.cells[3], checklistPath)) {
      violations.push(
        `${checklistPath} 第 ${row.line} 行的贴回模板「触发条件」那一格没有引用 ${checklistPath} 的某一步：` +
          "这一行的补法就是按清单跑一趟，路径与步骤不写在这里，贴回去之后这一行就没有落点"
      );
    }
  }

  // 3. 模板的行名必须是第 9 节真的点过的落点，且两条 DoD 各有一行。
  //
  // 这里刻意不按「第 10 节的四格 → 第 9 节的哪一行」去推：第 9 节是按节组织的
  // （`2 向导（目录、详情面板、完成页）` 覆盖 2.1–2.4，`4.1–4.2 首启与六行读数`
  // 覆盖两格），子集步骤与它没有一一对应，硬推会推出一张要人维护的映射表——那正是
  // 这一条要防的东西。所以只问两件能问清的事：模板点到的每一行，第 9 节都点过；
  // 以及 DOD-5 与 DOD-6 各至少有一行——最小子集的意义就是「两条 DoD 各留一条读数」。
  const claims = checklistClaimRows(checklist);
  const targetDod = new Map(claims.map((claim) => [claimKey(claim.target), claim.primaryDod]));
  const templateNames = [...new Set(paste.map((row) => claimKey(row.name)))];
  for (const row of paste) {
    if (targetDod.has(claimKey(row.name))) continue;
    violations.push(
      `${checklistPath} 第 ${row.line} 行的贴回模板指向「${row.name}」，而第 9 节那张对照表没有把任何一格记回这一行：` +
        "两处说的是同一件事——第 9 节改了落点，模板要跟着改，否则读数会贴到一行没人认的名字上"
    );
  }
  const coveredDods = new Set(templateNames.map((name) => targetDod.get(name)).filter(Boolean));
  // 模板一行都没有时，上面那句已经说了「没有贴回模板」；再报两条「没有一行推进 DOD-x」
  // 只是同一件事的三种说法，读者会以为缺了三样东西。
  for (const id of paste.length ? ["DOD-5", "DOD-6"] : []) {
    if (coveredDods.has(id)) continue;
    violations.push(
      `${checklistPath} 第 10 节的贴回模板没有一行推进 ${id}（模板点到的行按第 9 节归属是「${[...coveredDods].join("、") || "（空）"}」）：` +
        "最小子集的意义就是「两条 DoD 各留一条读数」，少一条，这一趟跑完仍有一条勾不上"
    );
  }

  // 4. 模板的每一行都真的在未验证清单里。
  const rows = unverifiedRows(measurementsDoc);
  const known = new Set(rows.map((row) => claimKey(row.name)));
  for (const row of paste) {
    if (known.has(claimKey(row.name))) continue;
    violations.push(
      `${checklistPath} 第 ${row.line} 行的贴回模板指向「${row.name}」，而 ${measurementsPath} 的未验证清单里没有这一行：` +
        "贴回时替换的是同名行，名字错了就没有落点——要么改模板，要么那一行已经被搬走了"
    );
  }

  // 5. 第 141 轮：§10.0 那一条合成命令必须与 §5.2 是同一件事（同两个目录、同一个 pattern、
  //    且只有一行可复制）。写在两个地方的读数不核对就会各自漂。
  violations.push(...subsetSoloCommandViolations({ checklistDoc: checklist, checklistPath }));

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
  const dod = String(dodDoc == null ? "" : dodDoc);

  // 正向：对照表点名的每一行，只要那一条 DoD 还没勾，就必须还在未验证清单里，且触发条件引用清单。
  //
  // 第 136 轮之前这里只认 `status === "pending"`。状态行是人手写的一句话，而
  // `docs/win-install-checklist.md` 第 10 节当时教人「跑完把状态行改成已执行」——只跑了
  // 四格子集的人也照做，于是「第 9 节点到的行还在不在」这一条整段失效：没跑到的
  // portable / 卸载 / 单实例 / 内置二进制自报版本那几行，删掉也不红。行没了只有两种可能：
  // 读数贴回之后搬走（允许，那时 DoD 已勾），或者欠账被删（不许）。区分它们的是 DoD 的
  // 方括号，不是状态行——状态行只说明「那一趟跑过」，方括号才说明「读数已经贴回」。
  for (const claim of claims) {
    const row = byName.get(claimKey(claim.target));
    if (row === undefined) {
      const dodChecked = claim.primaryDod !== null && dodCheckboxOf(dod, claim.primaryDod) === true;
      if (!dodChecked) {
        violations.push(
          `${checklistPath} 第 ${claim.line} 行说读数记回「${claim.target}」，而 ${measurementsPath} 的未验证清单里没有这一行：` +
            (status === "pending"
              ? `清单文件头还写着「${CHECKLIST_PENDING_MARK}」——行先没了，就是读数没贴回就把欠账删了`
              : `${claim.primaryDod === null ? "这一行没有归属的 DoD" : `${claim.primaryDod} 还没勾`}——` +
                `状态行改成「${CHECKLIST_EXECUTED_MARK}」不等于读数已贴回，行先没了，就是欠账被删了`)
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
  const templateRows = subsetPastebackRows(checklistDoc);
  const rows = unverifiedRows(measurementsDoc);
  const summaryLine = claimsSummaryLine({ status, claimRows: claims, templateRows, rows });
  const violations = [
    // 门禁自己那句话先过一遍自己的规则：印出来的数字要能读回来、且与表格相等。
    ...claimsSummaryViolations({ line: summaryLine, status, claimRows: claims, templateRows, rows }),
    ...recordedCountViolations({ measurementsDoc, rows }),
    ...checklistClaimViolations({ measurementsDoc, checklistDoc, dodDoc }),
    // 同一份文件的上半张表：读得出的行数不算数，渲染得出来的形状才算。
    ...measurementTableViolations({ measurementsDoc }),
    // 第 10 节那张待填表：四格都在、都留着空，模板与第 9 节的落点是同一件事。
    ...subsetFormViolations({ checklistDoc, measurementsDoc }),
  ];

  const measuredRows = measuredTableRows(measurementsDoc);
  console.log(summaryLine);
  console.log(
    `${MEASUREMENTS_DOC} 的实测表：${Math.max(0, measuredRows.length - 1)} 条读数，表头 + 分隔行之外一段到底（被空行切断时下面会点名行号）`
  );
  for (const violation of violations) console.log(`FAIL    ${violation}`);
  if (violations.length) {
    console.log(
      `\n${violations.length} 处问题。规则写在 tools/checklist-claims.mjs 顶部，反向控制在 tools/checklist-claims-smoke.mjs。`
    );
    process.exit(1);
  }
  console.log("真机清单的欠账：0 处问题（清单存在 ≠ 读数已贴回，这一条问的是后者）");
}
