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
  dodCheckboxOf,
  pastedReading,
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

const measurementsDoc = ({ rows = [ROW_FIRST_RUN, ROW_KEY, ROW_PORTABLE, ROW_UPDATE], why = {} } = {}) => {
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
    "| 2026-11-04 | 某次跑 | 绿 | 命令 |",
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

const checklistDoc = ({ status = CHECKLIST_PENDING_MARK, claims = CLAIM_ROWS } = {}) =>
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

/* ---- 7. 仓库本身，而不是夹具 ---- */

{
  const measurements = read(MEASUREMENTS_DOC) || "";
  const checklist = read(CHECKLIST_DOC) || "";
  const dod = read(DOD_DOC) || "";
  const violations = checklistClaimViolations({ measurementsDoc: measurements, checklistDoc: checklist, dodDoc: dod });
  check(`仓库里的三份文档是绿的（${CHECKLIST_DOC} / ${MEASUREMENTS_DOC} / ${DOD_DOC}）`, violations.length === 0, violations.join("；"));

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

/* ---- 8. 接线 ---- */

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
