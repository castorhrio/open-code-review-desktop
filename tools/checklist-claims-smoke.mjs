// `tools/checklist-claims.mjs` 的规则，一格一个事实地钉住。
//
// 这一条要防的是「清单存在被读成读数已贴回」：删一行文档就能让欠账消失，而 run 还是绿的。
// 所以每一格反向控制都只改一个事实——删掉触发条件里的清单路径、删掉未验证清单的一行、
// 删掉第 9 节的一行、把 DOD-5 的方括号先勾上——并要求点名文件与行号。
//
// 最后一段看的是仓库本身而不是夹具：真文档必须绿，且第 9 节必须还点着那两行
// （`装好之后 Key 落在哪` / `免安装版（portable）的运行面`）——它们是 DOD-6 与 DOD-5
// 唯一没有脚本能替代的那半边。
import fs from "node:fs";
import path from "node:path";

import {
  CHECKLIST_DOC,
  CHECKLIST_EXECUTED_MARK,
  CHECKLIST_PENDING_MARK,
  DOD_DOC,
  MEASUREMENTS_DOC,
  checklistClaimRows,
  checklistClaimViolations,
  checklistStatus,
  citesChecklistStep,
  claimKey,
  claimsSummaryLine,
  claimsSummaryViolations,
  dodCheckboxOf,
  pastedReading,
  measuredTableRows,
  measurementTableViolations,
  quotedRowCounts,
  readClaimsSummary,
  recordedCountViolations,
  subsetFormViolations,
  subsetGridRows,
  subsetPastebackRows,
  SUBSET_BLANK,
  SUBSET_DATE_PLACEHOLDER,
  SUBSET_STEPS,
  stepOf,
  unverifiedRows,
} from "./checklist-claims.mjs";
import { auditScriptClosure } from "./upstream-watch.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok     " : "FAIL   "} ${name}${ok || !detail ? "" : `：${detail}`}`);
};

const read = (target) => {
  const full = path.join(ROOT, target);
  // 目录也算「存在」，而 `auditScriptClosure` 会拿它去读——EISDIR 不是这一条要问的事。
  return fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full, "utf8") : null;
};

/* ---- fixtures ---- */

const ROW_FIRST_RUN = `| 安装版之后的首启链路 | 真机 | 没跑过 | 按 \`${CHECKLIST_DOC}\` 第 1–4 步在 Windows x64 上装一次 |`;
const ROW_KEY = `| 装好之后 Key 落在哪 | 真机 | 没翻过 | 按 \`${CHECKLIST_DOC}\` 第 5 步与第 7 步装一次 |`;
const ROW_PORTABLE = `| 免安装版（portable）的运行面 | 真机 | 没打开过 | 按 \`${CHECKLIST_DOC}\` 第 6 步双击 portable 产物 |`;
/** 这一行引用清单是为了说「这一项不在那一趟里」——「第 8 节」不是「第 N 步」，
 *  所以它不该被要求进第 9 节的对照表。 */
const ROW_UPDATE = `| 应用内更新（NSIS 安装版） | 真机 | 没跑过 | 下一次发版前装一次；\`${CHECKLIST_DOC}\` 第 8 节写明这一项不在那一趟里 |`;

const measuredRow = ({ rows = 4, cited = 3 } = {}) =>
  `| 2026-11-04 | 门禁自己那句读数 | 打印「未验证清单 ${rows} 行，其中 ${cited} 行按清单的某一步去验」 | 命令 |`;

const measurementsDoc = ({
  rows = [ROW_FIRST_RUN, ROW_KEY, ROW_PORTABLE, ROW_UPDATE],
  why = {},
  reading = "| 2026-11-04 | 某次跑 | 绿 | 命令 |",
} = {}) => {
  const body = rows.map((row) => {
    const name = row.split("|")[1].trim();
    if (!why[name]) return row;
    const cells = row.split("|");
    cells[3] = ` ${why[name]} `;
    return cells.join("|");
  });
  return [
    "# 实测值",
    "",
    "| 日期 | 场景 | 实测 | 来源 |",
    "| --- | --- | --- | --- |",
    reading,
    "",
    "## 未验证清单（截至 2026-11-04）",
    "",
    "| 项 | 归属 | 为什么没验 | 下次要验的触发条件 |",
    "| --- | --- | --- | --- |",
    ...body,
    "",
  ].join("\n");
};

const CLAIM_ROWS = [
  "| 1 SmartScreen | 安装版之后的首启链路 | DOD-5 |",
  "| 5 配置与 Key 的位置 | 装好之后 Key 落在哪 | DOD-6 |",
  "| 6 portable | 免安装版（portable）的运行面 | DOD-5 |",
];

const SUBSET_GRID = [
  "| 1 SmartScreen | 双击 setup | 出现并走得下去 | 读数：____ |",
  "| 2.2 安装目录页 | 走到目录页 | 默认路径 + 无 UAC | 读数：____ |",
  "| 4.2 六行读数 | 设置 → 关于与卸载 | 六行一致 | 读数：____ |",
  "| 5.2 两个目录 grep | 两条命令 | 有命中 / 零命中 | 读数：____ |",
];

const SUBSET_PASTEBACK = [
  "| 安装版之后的首启链路 | 真机 | 读数（YYYY-MM-DD）：____ | 已按 `docs/win-install-checklist.md` 第 1 步跑过 |",
  "| 装好之后 Key 落在哪 | 真机 | 读数（YYYY-MM-DD）：____ | 已按 `docs/win-install-checklist.md` 第 5.2 步跑过 |",
];

const checklistDoc = ({
  status = CHECKLIST_PENDING_MARK,
  claims = CLAIM_ROWS,
  grid = SUBSET_GRID,
  pasteback = SUBSET_PASTEBACK,
} = {}) =>
  [
    "# Windows x64 安装包真机清单",
    "",
    `> 状态：**${status}**。这份文件是一次操作的说明书，不是验证记录。`,
    "",
    "## 9. 读数记回哪一行",
    "",
    "| 清单项 | 记回 `docs/measurements.md` 的哪一行 | 推进哪条 DoD |",
    "| --- | --- | --- |",
    ...claims,
    "",
    "## 10. 最小可行子集（5 分钟）",
    "",
    "### 10.1 四格读数（照这一张填）",
    "",
    "| 格 | 做什么 | 期望读数 | 读数格 |",
    "| --- | --- | --- | --- |",
    ...grid,
    "",
    "### 10.2 贴回模板（复制这两行，只填空）",
    "",
    "```markdown",
    ...pasteback,
    "```",
    "",
  ].join("\n");

const dodDoc = ({ five = " ", six = " " } = {}) =>
  [
    "# 产品标准",
    "",
    `- [${five}] DOD-5：**航运资产**：安装包可装可启`,
    `- [${six}] DOD-6：**安全底线**：Key 不进本程序副本`,
    "",
  ].join("\n");

const good = () => ({
  measurementsDoc: measurementsDoc(),
  checklistDoc: checklistDoc(),
  dodDoc: dodDoc(),
});

const violationsOf = (patch) => checklistClaimViolations({ ...good(), ...patch });

/** 夹具里某一行的行号，从夹具本身读出来——写死一个数字，改一行夹具就假红。 */
const lineOf = (doc, name) => {
  const row = unverifiedRows(doc).find((entry) => claimKey(entry.name) === claimKey(name));
  return row === undefined ? null : row.line;
};

/* ---- 1. the baseline, and the premises the controls rest on ---- */

{
  const base = good();
  check("基线：夹具本身是绿的（否则下面每一格反向控制都证明不了什么）", violationsOf({}).length === 0, violationsOf({}).join("；"));

  const rows = unverifiedRows(base.measurementsDoc);
  check("前提：未验证清单读出 4 行", rows.length === 4, JSON.stringify(rows.map((row) => row.name)));
  const claims = checklistClaimRows(base.checklistDoc);
  check("前提：第 9 节读出 3 行对照", claims.length === 3, JSON.stringify(claims.map((claim) => claim.target)));
  check(
    "前提：一条对照行只认第一个 DOD（`DOD-5（主）；…DOD-4…` 的主归属是 DOD-5）",
    checklistClaimRows(checklistDoc({ claims: ["| 4.1–4.2 | 安装版之后的首启链路 | DOD-5（主）；4.1 同时是 DOD-4 的一段 |"] }))[0]
      .primaryDod === "DOD-5",
    "主归属读成了别的"
  );
  check("前提：状态行读出 pending", checklistStatus(base.checklistDoc) === "pending", checklistStatus(base.checklistDoc));
  check("前提：DOD-5 未勾", dodCheckboxOf(base.dodDoc, "DOD-5") === false, String(dodCheckboxOf(base.dodDoc, "DOD-5")));
  check(
    "前提：「第 8 节」不算「按清单第 N 步去验」，「第 5 步」算",
    citesChecklistStep(ROW_UPDATE) === false && citesChecklistStep(ROW_KEY) === true,
    JSON.stringify({ update: citesChecklistStep(ROW_UPDATE), key: citesChecklistStep(ROW_KEY) })
  );
  check(
    "前提：读数格要同时有日期与「读数」二字",
    pastedReading("2026-11-04 读数：六行与清单一致") === true &&
      pastedReading("2026-11-04 还没验") === false &&
      pastedReading("读数：六行与清单一致") === false,
    "读数格的判定与约定不符"
  );
}

/* ---- 2. 触发条件里的清单路径被删掉 ---- */

{
  const broken = measurementsDoc({ rows: [ROW_FIRST_RUN, ROW_KEY.replace(`\`${CHECKLIST_DOC}\``, "那份清单"), ROW_PORTABLE, ROW_UPDATE] });
  const violations = violationsOf({ measurementsDoc: broken });
  const want = lineOf(broken, "装好之后 Key 落在哪");
  check(
    "删掉触发条件里的清单路径：点名那一行与行号",
    violations.length === 1 && violations[0].includes("装好之后 Key 落在哪") && violations[0].includes(`第 ${want} 行`),
    violations.join("；") || "没有违规"
  );
}

/* ---- 3. 未验证清单的一行被删掉（读数没贴回） ---- */

{
  const broken = measurementsDoc({ rows: [ROW_FIRST_RUN, ROW_PORTABLE, ROW_UPDATE] });
  const violations = violationsOf({ measurementsDoc: broken });
  const claimLine = checklistClaimRows(checklistDoc()).find((claim) => claimKey(claim.target) === claimKey("装好之后 Key 落在哪")).line;
  check(
    "清单还写着「尚未执行」时删掉未验证清单的一行：点名第 9 节那一行与那个行名",
    violations.length === 1 && violations[0].includes(`第 ${claimLine} 行`) && violations[0].includes("装好之后 Key 落在哪"),
    violations.join("；") || "没有违规"
  );
}

/* ---- 4. 第 9 节的一行被删掉（读数没有落点） ---- */

{
  const broken = checklistDoc({ claims: [CLAIM_ROWS[0], CLAIM_ROWS[2]] });
  const violations = violationsOf({ checklistDoc: broken });
  const keyLine = lineOf(measurementsDoc(), "装好之后 Key 落在哪");
  check(
    "删掉第 9 节的一行：点名未验证清单那一行（反向那一条）",
    violations.length === 1 && violations[0].includes("装好之后 Key 落在哪") && violations[0].includes(`第 ${keyLine} 行`),
    violations.join("；") || "没有违规"
  );
}

/* ---- 5. DoD 的方括号先勾 ---- */

{
  const violations = violationsOf({ dodDoc: dodDoc({ five: "x" }) });
  check(
    "DOD-5 先勾上而清单还写着「尚未执行」：点名状态行",
    violations.some((violation) => violation.includes("DOD-5") && violation.includes(CHECKLIST_PENDING_MARK)),
    violations.join("；") || "没有违规"
  );

  const executed = checklistDoc({ status: CHECKLIST_EXECUTED_MARK });
  const instruction = measurementsDoc({
    why: {
      "安装版之后的首启链路": `按 \`${CHECKLIST_DOC}\` 第 1–4 步去验`,
      "免安装版（portable）的运行面": `按 \`${CHECKLIST_DOC}\` 第 6 步去验`,
    },
  });
  const stillInstruction = violationsOf({ dodDoc: dodDoc({ five: "x" }), checklistDoc: executed, measurementsDoc: instruction });
  check(
    "清单已执行、DOD-5 已勾，但「为什么没验」还是「按清单去验」：点名那一行",
    stillInstruction.length === 2 &&
      stillInstruction.every((violation) => violation.includes("为什么没验") && violation.includes("还写着按")) &&
      stillInstruction.some((violation) => violation.includes("安装版之后的首启链路")),
    stillInstruction.join("；") || "没有违规"
  );

  const dateOnly = measurementsDoc({ why: { "安装版之后的首启链路": "2026-11-04 还没验" } });
  const noReading = violationsOf({ dodDoc: dodDoc({ five: "x" }), checklistDoc: executed, measurementsDoc: dateOnly });
  check(
    "有日期但没有「读数」二字：仍算没贴回，点名那一行",
    noReading.some((violation) => violation.includes("安装版之后的首启链路") && violation.includes("没有读数")),
    noReading.join("；") || "没有违规"
  );

  const pasted = measurementsDoc({
    why: {
      "安装版之后的首启链路": "2026-11-04 读数：SmartScreen 出现，更多信息 → 仍要运行可用；六行与清单一致",
      "免安装版（portable）的运行面": "2026-11-04 读数：徽章「免安装版 · win32」，注册表查询无命中",
    },
  });
  const green = violationsOf({ dodDoc: dodDoc({ five: "x" }), checklistDoc: executed, measurementsDoc: pasted });
  check("读数贴回、状态行改成已执行之后，DOD-5 勾上是绿的（正向控制）", green.length === 0, green.join("；"));

  const both = violationsOf({ dodDoc: dodDoc({ five: "x", six: "x" }), checklistDoc: executed, measurementsDoc: pasted });
  check(
    "同一份读数下 DOD-6 也勾上：点名 Key 那一行（它的读数还没贴）",
    both.length === 1 && both[0].includes("装好之后 Key 落在哪"),
    both.join("；") || "没有违规"
  );
}

/* ---- 6. 文档本身读不到 / 形状不对 ---- */

{
  check("清单为空：直接判红并点名路径", violationsOf({ checklistDoc: "" }).some((v) => v.includes(CHECKLIST_DOC)), "没有违规");
  {
    // 清单不见了坏掉的是两件事：说明书没了，以及未验证清单里那几行「按它去验」的补法
    // 失去了落点。只报第一件，读者会以为「把文件放回来」就够了。
    const gone = violationsOf({ checklistDoc: "" });
    const orphanLine = lineOf(measurementsDoc(), "装好之后 Key 落在哪");
    check(
      "清单不见了：第二句点名未验证清单里那几行（行号 + 行名），而不是只说文件没了",
      gone.length === 2 &&
        (() => {
          const listed = /第 ([\d、]+) 行/.exec(gone[1]);
          return Boolean(listed) && listed[1].split("、").map(Number).includes(orphanLine);
        })() &&
        gone[1].includes("装好之后 Key 落在哪") &&
        gone[1].includes("没有落点"),
      gone.join("；") || "没有违规"
    );
    // 那一句数的是「触发条件里出现清单路径」的行，不是未验证清单的全部行：加一行
    // 与清单无关的欠账（Linux / macOS 打包产物），它不该被点名。
    const withUnrelated = measurementsDoc({
      rows: [ROW_FIRST_RUN, ROW_KEY, ROW_PORTABLE, ROW_UPDATE, "| Linux / macOS 打包产物 | 真机 | 只跑过源码级门禁 | 第一次真的要发布这两个平台时 |"],
    });
    const goneWithUnrelated = violationsOf({ checklistDoc: "", measurementsDoc: withUnrelated });
    check(
      "...而那一句数的是「引用清单路径」的行，不是全部行（与清单无关的那一行不被点名）",
      goneWithUnrelated.length === 2 &&
        goneWithUnrelated[1].includes("4 行") &&
        !goneWithUnrelated[1].includes("Linux / macOS 打包产物"),
      goneWithUnrelated.join("；") || "没有违规"
    );
  }
  check(
    "没有第 9 节对照表：点名「没有那张表」",
    violationsOf({ checklistDoc: "# 清单\n\n> 状态：**尚未执行**。\n" }).some((v) => v.includes("第 9 节")),
    "没有违规"
  );
  check(
    "状态行不见了：点名「没有状态行」",
    violationsOf({ checklistDoc: checklistDoc().replace(/^> 状态：.*$/m, "") }).some((v) => v.includes("没有状态行")),
    "没有违规"
  );
  check(
    "状态行同时写着两个状态：点名冲突",
    violationsOf({ checklistDoc: checklistDoc({ status: `${CHECKLIST_PENDING_MARK}（跑完改成${CHECKLIST_EXECUTED_MARK}）` }) }).some((v) =>
      v.includes("同时写着")
    ),
    "没有违规"
  );
  check(
    "未验证清单整节不见了：点名那一节",
    violationsOf({ measurementsDoc: "# 实测值\n\n| 日期 | 场景 | 实测 | 来源 |\n| --- | --- | --- | --- |\n" }).some((v) =>
      v.includes("未验证清单")
    ),
    "没有违规"
  );
  check(
    "DoD 读不到：点名它（否则「提前勾」这一条无从核对）",
    violationsOf({ dodDoc: "" }).some((v) => v.includes(DOD_DOC)),
    "没有违规"
  );
  check(
    "DoD 里少了 DOD-6 那一行：点名缺的条目",
    violationsOf({ dodDoc: "- [ ] DOD-5：**航运资产**：安装包可装可启\n" }).some((v) => v.includes("DOD-6")),
    "没有违规"
  );
}

/* ---- 7. 门禁自己那句话 ------
 * 第 122 轮立的纪律是「数字要有断言」，而那条纪律没有覆盖它自己的读数：终端里那句
 * 「未验证清单 11 行，其中 6 行按清单的某一步去验」是手写模板，读的人拿表格去数，
 * 数出来的数不一样时没有任何东西会红。所以这句话改由现算得到，再把印出来的句子读
 * 回来与表格比一次；同时要求 `docs/measurements.md` 里最后一句引用它的读数也必须
 * 与现在的表格相等——历史行留着当时的数字，只有最后一句是「现在」。
 *
 * 反向控制按「改坏一个数字」各来一格：行数、其中数、对照表行数、状态、以及把
 * 「其中 M 行」整段删掉（读不回数字时不许静默通过）。
 */
{
  const base = good();
  const rows = unverifiedRows(base.measurementsDoc);
  const claims = checklistClaimRows(base.checklistDoc);
  const templateRows = subsetPastebackRows(base.checklistDoc);
  const line = claimsSummaryLine({ status: "pending", claimRows: claims, templateRows, rows });
  const parsed = readClaimsSummary(line);

  check(
    "前提：门禁那句读数印出来能读回五个数字（对照表 3 行 / 贴回模板 2 行 / 未验证清单 4 行 / 其中 3 行 / 状态 pending）",
    parsed.status === "pending" && parsed.claims === 3 && parsed.template === 2 && parsed.rows === 4 && parsed.cited === 3,
    JSON.stringify(parsed)
  );
  check(
    "基线：门禁自己那句读数与表格相等（绿）",
    claimsSummaryViolations({ line, status: "pending", claimRows: claims, templateRows, rows }).length === 0,
    claimsSummaryViolations({ line, status: "pending", claimRows: claims, templateRows, rows }).join("；") || "没有违规"
  );

  const wrongRows = claimsSummaryViolations({
    line: line.replace("未验证清单 4 行", "未验证清单 10 行"),
    status: "pending",
    claimRows: claims,
    templateRows,
    rows,
  });
  check(
    "把行数改成 10（表格是 4）：点名这个数字，两句都带上",
    wrongRows.length === 1 && wrongRows[0].includes("10") && wrongRows[0].includes("4") && wrongRows[0].includes("未验证清单的行数"),
    wrongRows.join("；") || "没有违规"
  );

  const wrongCited = claimsSummaryViolations({
    line: line.replace("其中 3 行按清单的某一步去验", "其中 2 行按清单的某一步去验"),
    status: "pending",
    claimRows: claims,
    templateRows,
    rows,
  });
  check(
    "把「其中 M 行」改错：点名那一项",
    wrongCited.length === 1 && wrongCited[0].includes("其中按清单某一步去验的行数"),
    wrongCited.join("；") || "没有违规"
  );

  const wrongClaims = claimsSummaryViolations({
    line: line.replace("第 9 节对照表 3 行", "第 9 节对照表 5 行"),
    status: "pending",
    claimRows: claims,
    templateRows,
    rows,
  });
  check(
    "把对照表行数改错：点名那一项",
    wrongClaims.length === 1 && wrongClaims[0].includes("第 9 节对照表的行数"),
    wrongClaims.join("；") || "没有违规"
  );

  const wrongStatus = claimsSummaryViolations({
    line: line.replace("状态 pending", "状态 executed"),
    status: "pending",
    claimRows: claims,
    templateRows,
    rows,
  });
  check(
    "把状态改错：点名清单状态",
    wrongStatus.length === 1 && wrongStatus[0].includes("清单状态") && wrongStatus[0].includes("executed"),
    wrongStatus.join("；") || "没有违规"
  );

  const missingCited = claimsSummaryViolations({
    line: line.replace("，其中 3 行按清单的某一步去验", ""),
    status: "pending",
    claimRows: claims,
    templateRows,
    rows,
  });
  check(
    "把「其中 M 行」整段删掉：读不出就红（不许静默跳过）",
    missingCited.length === 1 && missingCited[0].includes("读不出"),
    missingCited.join("；") || "没有违规"
  );

  const readMatching = recordedCountViolations({ measurementsDoc: measurementsDoc({ reading: measuredRow() }), rows });
  check("读数行记的是 4 / 3：绿（正向控制）", readMatching.length === 0, readMatching.join("；") || "没有违规");

  const readWrongDoc = measurementsDoc({ reading: measuredRow({ rows: 10 }) });
  const readWrongLine = quotedRowCounts(readWrongDoc)[0].line;
  const readWrong = recordedCountViolations({ measurementsDoc: readWrongDoc, rows });
  check(
    "读数行记的是 10 而行数是 4：点名那一行与两个数字",
    readWrong.length === 1 &&
      readWrong[0].includes("10") &&
      readWrong[0].includes("4") &&
      readWrong[0].includes(`第 ${readWrongLine} 行`),
    readWrong.join("；") || "没有违规"
  );

  const readHalf = recordedCountViolations({
    measurementsDoc: measurementsDoc({ reading: "| 2026-11-04 | 门禁 | 打印「未验证清单 4 行」 | 命令 |" }),
    rows,
  });
  check(
    "只记行数、不记「其中 M 行」：红（两个数字要一起记）",
    readHalf.length === 1 && readHalf[0].includes("其中 M 行"),
    readHalf.join("；") || "没有违规"
  );

  const readAbsent = recordedCountViolations({ measurementsDoc: measurementsDoc(), rows });
  check(
    "整个文件没有一句引用这两个数字：红（读数只出现在终端里不算记录）",
    readAbsent.length === 1 && readAbsent[0].includes("没有任何一行记下"),
    readAbsent.join("；") || "没有违规"
  );

  // 历史行允许留住当时的数字：只有最后一句是「现在」。
  const twoQuotes = measurementsDoc({
    reading: [measuredRow({ rows: 7, cited: 5 }), measuredRow()].join("\n"),
  });
  const historyThenNow = recordedCountViolations({ measurementsDoc: twoQuotes, rows });
  check(
    "上面留着旧读数、最后一句是新读数：绿（只核最后一句）",
    historyThenNow.length === 0,
    historyThenNow.join("；") || "没有违规"
  );
}

/* ---- 8. 实测表：一张表，还是一堆段落 ----
 *
 * `docs/measurements.md` 上半张表（`# 实测值`）是「跑过什么」的唯一记录。第 121–124
 * 轮各加一行、每行前留一个空行，Markdown 于是把它渲染成五张表：只有第一张有表头，
 * 后四段是带竖线的普通段落——而脚本按「`|` 开头」照读，行一个不少，所以「表还在」
 * 与「表渲染得出来」在门禁里是同一句话。这一节把两者分开：每格只改一个事实（空行、
 * 列数、正文行、第二个表头、表头改名、表头换列、缺分隔行、标题改名），要求点名文件
 * 与行号；最后一格看仓库本身，问的是这张表的行号是否连续——连续就是没有被切断。
 */
{
  const HEADER = "| 日期 | 场景 | 实测 | 来源 |";
  const SEPARATOR = "| --- | --- | --- | --- |";
  const ROW_A = "| 2026-11-04 | 某次跑 | 绿 | 命令 |";
  const ROW_B = "| 2026-11-04 | 又一次 | 也绿 | 命令 |";
  const measuredDoc = (table) =>
    [
      "# 实测值",
      "",
      "说明文字。",
      "",
      ...table,
      "",
      "## 未验证清单（截至 2026-11-04）",
      "",
      "| 项 | 归属 | 为什么没验 | 下次要验的触发条件 |",
      "| --- | --- | --- | --- |",
      ROW_FIRST_RUN,
      "",
    ].join("\n");
  const lineOfText = (doc, text) => {
    const index = String(doc).split(/\r?\n/).findIndex((line) => line === text);
    return index === -1 ? null : index + 1;
  };
  const violationsOfTable = (doc, path = MEASUREMENTS_DOC) => measurementTableViolations({ measurementsDoc: doc, measurementsPath: path });

  const base = measuredDoc([HEADER, SEPARATOR, ROW_A, ROW_B]);
  check(
    "基线：一张表两行读数，绿（否则下面每一格反向控制都证明不了什么）",
    violationsOfTable(base).length === 0,
    violationsOfTable(base).join("；")
  );
  check(
    "前提：读得出表头之外有几条读数（分隔行不算，所以 3 = 表头 + 2 行）",
    measuredTableRows(base).length === 3,
    JSON.stringify(measuredTableRows(base).map((row) => row.cells[0]))
  );

  // 1. 空行断表——第 121–124 轮留下的就是这一格。
  {
    const broken = measuredDoc([HEADER, SEPARATOR, ROW_A, "", ROW_B]);
    const violations = violationsOfTable(broken);
    const blankLine = lineOfText(broken, ROW_B) - 1;
    const lines = broken.split(/\r?\n/);
    check(
      "表中间插一个空行：点名文件与那个空行的行号，并说清「断成了两张」（markdown 会在这里结束表格）",
      violations.length === 1 &&
        violations[0].includes(MEASUREMENTS_DOC) &&
        violations[0].includes(`第 ${blankLine} 行`) &&
        lines[blankLine - 1] === "" &&
        violations[0].includes("断成了两张"),
      violations.join("；") || "没有违规"
    );
  }

  // 2. 列数少一格。
  {
    const short = "| 2026-11-04 | 某次跑 | 绿 |";
    const broken = measuredDoc([HEADER, SEPARATOR, ROW_A, short, ROW_B]);
    const violations = violationsOfTable(broken);
    const want = lineOfText(broken, short);
    check(
      "少写一列：点名那一行、两个列数，并给出补法（空着写「—」，不要省略）",
      violations.length === 1 &&
        violations[0].includes(`第 ${want} 行`) &&
        violations[0].includes("3 列") &&
        violations[0].includes("4 列") &&
        violations[0].includes("不要省略"),
      violations.join("；") || "没有违规"
    );
  }

  // 3. 一行正文夹在表中间。
  {
    const prose = "这一行是后来补的说明。";
    const broken = measuredDoc([HEADER, SEPARATOR, ROW_A, prose, ROW_B]);
    const violations = violationsOfTable(broken);
    const want = lineOfText(broken, prose);
    check(
      "正文行夹在表中间：点名那一行，并说清 markdown 会在这里结束表格",
      violations.length === 1 &&
        violations[0].includes(`第 ${want} 行`) &&
        violations[0].includes("不是表格行") &&
        violations[0].includes("结束表格"),
      violations.join("；") || "没有违规"
    );
  }

  // 4. 第二个表头 + 分隔行（这就是「两张表」的完整形状）。
  {
    const broken = measuredDoc([HEADER, SEPARATOR, ROW_A, HEADER, SEPARATOR, ROW_B]);
    const violations = violationsOfTable(broken);
    const firstHeader = lineOfText(broken, HEADER);
    check(
      "表中间又起了一个表头 + 分隔行：两句各自点名行号（第二次出现的表头、第二行分隔行），且不点名第一行表头",
      violations.length === 2 &&
        violations.some((violation) => violation.includes("又出现了一次表头")) &&
        violations.some((violation) => violation.includes("又是一行表头分隔行")) &&
        violations.every((violation) => /第 \d+ 行/.test(violation)) &&
        violations.every((violation) => !violation.includes(`第 ${firstHeader} 行`)),
      violations.join("；") || "没有违规"
    );
  }

  // 5. 表头被改名（这一节就找不到表头了）。
  {
    const broken = measuredDoc(["| 时间 | 场景 | 实测 | 来源 |", SEPARATOR, ROW_A]);
    const violations = violationsOfTable(broken);
    check(
      "表头改名（「日期」→「时间」）：点名「没有表头」，而不是逐行报列数",
      violations.length === 1 && violations[0].includes("没有表头") && violations[0].includes(MEASUREMENTS_DOC),
      violations.join("；") || "没有违规"
    );
  }

  // 6. 表头换列（还是四列，但顺序不是那四个问题）。
  {
    const swapped = "| 日期 | 实测 | 场景 | 来源 |";
    const broken = measuredDoc([swapped, SEPARATOR, ROW_A]);
    const violations = violationsOfTable(broken);
    const want = lineOfText(broken, swapped);
    check(
      "表头换列：点名那一行与应有的四个列名",
      violations.length === 1 &&
        violations[0].includes(`第 ${want} 行`) &&
        violations[0].includes("应为") &&
        violations[0].includes("日期 | 场景 | 实测 | 来源"),
      violations.join("；") || "没有违规"
    );
  }

  // 7. 分隔行丢了。
  {
    const broken = measuredDoc([HEADER, ROW_A, ROW_B]);
    const violations = violationsOfTable(broken);
    check(
      "表头下面没有分隔行：点名那一行，并说清「不把这一组行当表」",
      violations.length === 1 && violations[0].includes("分隔行") && violations[0].includes("不把这一组行当表"),
      violations.join("；") || "没有违规"
    );
  }

  // 8. 标题被改名 / 整节不见了。
  {
    const broken = measuredDoc([HEADER, SEPARATOR, ROW_A]).replace("# 实测值", "# 实测量");
    const violations = violationsOfTable(broken);
    check(
      "「# 实测值」标题被改名：点名路径（这一条靠标题定位那一节）",
      violations.length === 1 && violations[0].includes(MEASUREMENTS_DOC) && violations[0].includes("# 实测值"),
      violations.join("；") || "没有违规"
    );
  }
  check("文档整个空掉：也走「没有这一节」那句，而不是静默通过", violationsOfTable("").length === 1, violationsOfTable("").join("；") || "没有违规");

  // 9. 仓库本身：这张表现在必须是连续的、且行号一个不跳。
  {
    const measurements = read(MEASUREMENTS_DOC) || "";
    const violations = measurementTableViolations({ measurementsDoc: measurements });
    check("仓库里：实测表是一张表，没有空行切断、没有列数不符（正向）", violations.length === 0, violations.join("；") || "没有违规");
    const rows = measuredTableRows(measurements);
    // 表头与第一条读数之间隔着那行分隔行（`measuredTableRows` 不把分隔行算成读数），
    // 除此之外每两条相邻读数的行号必须差 1——差 2 就是中间夹了一个空行。
    const contiguous = rows.every((row, index) => {
      if (index === 0) return true;
      if (index === 1) return row.line === rows[0].line + 2;
      return row.line === rows[index - 1].line + 1;
    });
    check(
      "仓库里：实测表的读数行号连续（只在表头与第一条之间隔那一行分隔行），且至少 16 行（表头 + 15 条读数）",
      rows.length >= 16 && contiguous,
      JSON.stringify({
        rows: rows.length,
        contiguous,
        first: rows[0] && rows[0].line,
        last: rows.length ? rows[rows.length - 1].line : null,
      })
    );
    check(
      "仓库里：每一条读数都是四列（四个问题各有一格）",
      rows.every((row) => row.cells.length === 4),
      JSON.stringify(rows.filter((row) => row.cells.length !== 4).map((row) => ({ line: row.line, cells: row.cells.length })))
    );
  }
}

/* ---- 9. 第 10 节那张待填表 ----
 *
 * 第 122 轮把「清单存在 ≠ 读数已贴回」写成断言之后，第 10 节那四格仍是一段散文：
 * 一个拿到 Windows 机器的人要读完整节才知道「读数写在哪、贴回哪一行」。第 126 轮把它
 * 改成待填表（10.1 四格读数 + 10.2 两行贴回模板），这一节钉住那张表本身。
 *
 * 每格只改一个事实：删掉整节、把「读数格」表头改名、把某一格的空填掉、把四格换序、
 * 把围栏拆掉、把日期占位符删掉、把模板的行名换成第 9 节没点过的、换成不推进 DOD-6 的、
 * 把触发条件里的清单路径删掉、把未验证清单里那一行搬走。要求点名文件与行号。
 */
{
  const violationsOfForm = (patch) =>
    subsetFormViolations({ measurementsDoc: measurementsDoc(), checklistDoc: checklistDoc(), ...patch });

  check("基线：夹具里的第 10 节是绿的（否则下面每一格反向控制都证明不了什么）", violationsOfForm({}).length === 0, violationsOfForm({}).join("；"));

  const grid = subsetGridRows(checklistDoc());
  const paste = subsetPastebackRows(checklistDoc());
  check(
    "前提：读数格表读出四格，步骤号是 1 / 2.2 / 4.2 / 5.2",
    grid.length === 4 && grid.map((row) => row.step).join(",") === SUBSET_STEPS.join(","),
    JSON.stringify(grid.map((row) => row.step))
  );
  check("前提：贴回模板读出两行，每行四列", paste.length === 2 && paste.every((row) => row.cells.length === 4), JSON.stringify(paste.map((row) => row.cells.length)));
  check(
    "前提：步骤号只认开头那个数字（`4.1–4.2 首启与六行读数` → `4.1`）",
    stepOf("4.1–4.2 首启与六行读数") === "4.1" && stepOf("2.2 安装目录页") === "2.2" && stepOf("向导") === null,
    JSON.stringify([stepOf("4.1–4.2 首启与六行读数"), stepOf("2.2 安装目录页"), stepOf("向导")])
  );

  // 1. 整节不见了。
  {
    const broken = checklistDoc().replace(/## 10\.[\s\S]*$/, "");
    const violations = violationsOfForm({ checklistDoc: broken });
    check(
      "第 10 节整节不见了：点名文件与「没有第 10 节」",
      violations.length === 1 && violations[0].includes(CHECKLIST_DOC) && violations[0].includes("没有第 10 节"),
      violations.join("；") || "没有违规"
    );
  }

  // 2. 「读数格」表头被改名。
  {
    const broken = checklistDoc().replace("| 格 | 做什么 | 期望读数 | 读数格 |", "| 格 | 做什么 | 期望读数 | 备注 |");
    const violations = violationsOfForm({ checklistDoc: broken });
    check(
      "「读数格」表头被改名：点名「没有那张表」",
      violations.length === 1 && violations[0].includes("读数格") && violations[0].includes("没有"),
      violations.join("；") || "没有违规"
    );
  }

  // 3. 某一格的空被填掉（待填表退化成说明书）。
  {
    const filled = "| 4.2 六行读数 | 设置 → 关于与卸载 | 六行一致 | 读数：六行与清单一致 |";
    const broken = checklistDoc({ grid: SUBSET_GRID.map((row) => (row.startsWith("| 4.2") ? filled : row)) });
    const violations = violationsOfForm({ checklistDoc: broken });
    const want = broken.split(/\r?\n/).findIndex((line) => line === filled) + 1;
    check(
      "某一格的「读数格」没有留空：点名那一行与那一格",
      violations.length === 1 && violations[0].includes(`第 ${want} 行`) && violations[0].includes("4.2") && violations[0].includes(SUBSET_BLANK),
      violations.join("；") || "没有违规"
    );
  }

  // 4. 四格换序。
  {
    const swapped = [SUBSET_GRID[0], SUBSET_GRID[2], SUBSET_GRID[1], SUBSET_GRID[3]];
    const violations = violationsOfForm({ checklistDoc: checklistDoc({ grid: swapped }) });
    check(
      "四格换序：点名两边的步骤号（顺序也是这一条的一部分）",
      violations.length === 1 && violations[0].includes("4.2 / 2.2") && violations[0].includes(SUBSET_STEPS.join(" / ")),
      violations.join("；") || "没有违规"
    );
  }

  // 5. 围栏被拆掉（模板行落回正文，读不到）。
  {
    const broken = checklistDoc().replace("```markdown\n", "").replace(/\n```\n$/, "\n");
    const violations = violationsOfForm({ checklistDoc: broken });
    check(
      "贴回模板的围栏被拆掉：点名「没有贴回模板」",
      violations.some((violation) => violation.includes("没有贴回模板")),
      violations.join("；") || "没有违规"
    );
  }

  // 6. 日期占位符被删掉。
  {
    const broken = checklistDoc({
      pasteback: [SUBSET_PASTEBACK[0].replace("（YYYY-MM-DD）", ""), SUBSET_PASTEBACK[1]],
    });
    const violations = violationsOfForm({ checklistDoc: broken });
    check(
      "模板里少了日期占位符：点名那一行与缺的那一样",
      violations.length === 1 && violations[0].includes(SUBSET_DATE_PLACEHOLDER) && violations[0].includes("缺"),
      violations.join("；") || "没有违规"
    );
  }

  // 7. 模板的行名换成第 9 节没点过的。
  {
    const broken = checklistDoc({
      pasteback: [SUBSET_PASTEBACK[0].replace("安装版之后的首启链路", "首启链路"), SUBSET_PASTEBACK[1]],
    });
    const violations = violationsOfForm({ checklistDoc: broken });
    check(
      "模板的行名第 9 节没点过：点名那一行与那个名字",
      violations.some((violation) => violation.includes("首启链路") && violation.includes("第 9 节")),
      violations.join("；") || "没有违规"
    );
  }

  // 8. 模板两行都推进 DOD-5（DOD-6 那一行被换掉）。
  {
    const broken = checklistDoc({
      pasteback: [SUBSET_PASTEBACK[0], SUBSET_PASTEBACK[1].replace("装好之后 Key 落在哪", "免安装版（portable）的运行面")],
    });
    const violations = violationsOfForm({ checklistDoc: broken });
    check(
      "模板里没有一行推进 DOD-6：点名缺的那条 DoD",
      violations.length === 1 && violations[0].includes("DOD-6") && violations[0].includes("各留一条读数"),
      violations.join("；") || "没有违规"
    );
  }

  // 9. 模板的触发条件里没有清单路径。
  {
    const broken = checklistDoc({
      pasteback: [SUBSET_PASTEBACK[0].replace("`docs/win-install-checklist.md` 第 1 步", "那份清单"), SUBSET_PASTEBACK[1]],
    });
    const violations = violationsOfForm({ checklistDoc: broken });
    check(
      "模板的触发条件没有引用清单路径：点名那一行",
      violations.length === 1 && violations[0].includes("触发条件") && violations[0].includes(CHECKLIST_DOC),
      violations.join("；") || "没有违规"
    );
  }

  // 10. 未验证清单里那一行被搬走（模板指向一个不存在的行名）。
  {
    const violations = subsetFormViolations({
      checklistDoc: checklistDoc(),
      measurementsDoc: measurementsDoc({ rows: [ROW_FIRST_RUN, ROW_PORTABLE, ROW_UPDATE] }),
    });
    check(
      "模板指向的那一行已从未验证清单搬走：点名那一行与那个名字",
      violations.length === 1 && violations[0].includes("装好之后 Key 落在哪") && violations[0].includes("没有这一行"),
      violations.join("；") || "没有违规"
    );
  }
}

/* ---- 10. 仓库本身，而不是夹具 ---- */

{
  const measurements = read(MEASUREMENTS_DOC) || "";
  const checklist = read(CHECKLIST_DOC) || "";
  const dod = read(DOD_DOC) || "";
  const violations = checklistClaimViolations({ measurementsDoc: measurements, checklistDoc: checklist, dodDoc: dod });
  check(`仓库里的三份文档是绿的（${CHECKLIST_DOC} / ${MEASUREMENTS_DOC} / ${DOD_DOC}）`, violations.length === 0, violations.join("；"));

  // 门禁自己那句读数：数字由现算得到、能被读回来、且与仓库里的表格相等。
  const liveRows = unverifiedRows(measurements);
  const liveClaims = checklistClaimRows(checklist);
  const liveStatus = checklistStatus(checklist);
  const liveTemplate = subsetPastebackRows(checklist);
  const liveLine = claimsSummaryLine({ status: liveStatus, claimRows: liveClaims, templateRows: liveTemplate, rows: liveRows });
  const liveSummary = claimsSummaryViolations({
    line: liveLine,
    status: liveStatus,
    claimRows: liveClaims,
    templateRows: liveTemplate,
    rows: liveRows,
  });
  check(
    "仓库里：门禁那句读数能被读回来、且与表格逐项相等（不是同义反复——反向控制在夹具里各改坏一个数字）",
    liveSummary.length === 0 && readClaimsSummary(liveLine).rows === liveRows.length,
    liveSummary.join("；") || JSON.stringify(readClaimsSummary(liveLine))
  );
  const liveRecorded = recordedCountViolations({ measurementsDoc: measurements, rows: liveRows });
  check(
    "仓库里：实测表最后一句引用「未验证清单 N 行 / 其中 M 行」的读数与现在的表格相等",
    liveRecorded.length === 0,
    liveRecorded.join("；") || "没有违规"
  );

  const claims = checklistClaimRows(checklist);
  const targets = claims.map((claim) => claimKey(claim.target));
  check(
    "第 9 节还点着 DOD-5 / DOD-6 唯一没有脚本能替代的那两行",
    targets.includes(claimKey("装好之后 Key 落在哪")) && targets.includes(claimKey("免安装版（portable）的运行面")),
    JSON.stringify(targets)
  );
  check(
    "第 9 节点到的每一行都真的在未验证清单里（清单还写着「尚未执行」）",
    checklistStatus(checklist) !== "pending" ||
      claims.every((claim) => unverifiedRows(measurements).some((row) => claimKey(row.name) === claimKey(claim.target))),
    JSON.stringify(claims.map((claim) => claim.target))
  );
  check(
    "未验证清单里按清单某一步去验的每一行，都在第 9 节里有落点",
    unverifiedRows(measurements)
      .filter((row) => citesChecklistStep(row.trigger))
      .every((row) => targets.includes(claimKey(row.name))),
    JSON.stringify(unverifiedRows(measurements).filter((row) => citesChecklistStep(row.trigger)).map((row) => row.name))
  );
  check(
    "DOD-5 / DOD-6 的方括号仍是未勾（勾选归 scheduler 侧，编码侧不动）",
    dodCheckboxOf(dod, "DOD-5") === false && dodCheckboxOf(dod, "DOD-6") === false,
    JSON.stringify({ five: dodCheckboxOf(dod, "DOD-5"), six: dodCheckboxOf(dod, "DOD-6") })
  );
}

/* ---- 11. 接线 ---- */

{
  const pkg = JSON.parse(read("package.json"));
  const closure = auditScriptClosure(pkg, read);
  check(
    "接线：`audit:checklist-claims` 存在，且脚本在 audit 闭包里",
    typeof pkg.scripts["audit:checklist-claims"] === "string" && closure.files.has("tools/checklist-claims.mjs"),
    `audit:checklist-claims=${JSON.stringify(pkg.scripts["audit:checklist-claims"])}，闭包里有=${closure.files.has("tools/checklist-claims.mjs")}`
  );
  check(
    "接线：本文件也在 audit 闭包里（规则本身每轮都跑）",
    closure.files.has("tools/checklist-claims-smoke.mjs"),
    "audit:checklist-claims 没有把 smoke 一起跑"
  );
  check(
    "接线：它挂在 `audit:static` 里（不是只挂在 `audit:app`）",
    String(pkg.scripts["audit:static"] || "").includes("audit:checklist-claims"),
    `audit:static=${pkg.scripts["audit:static"]}`
  );
  check(
    "接线：它不在 `audit:app` 里（读文档的事不该拖进真 Electron 那一趟）",
    !String(pkg.scripts["audit:app"] || "").includes("audit:checklist-claims"),
    `audit:app=${pkg.scripts["audit:app"]}`
  );
}

const failed = results.filter((result) => !result.ok);
console.log(`\n真机清单欠账的规则：${results.length} 条检查，${failed.length} 条红`);
if (failed.length) {
  console.error(failed.map((result) => `  - ${result.name}：${result.detail}`).join("\n"));
  process.exit(1);
}
