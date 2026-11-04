// `tools/fake-provider.mjs` + `tools/fake-provider-cli.mjs` 的每一格事实。
//
// 这一条要防的是「运行级的四种结局都只有夹具证据」：在此之前，本仓的每条运行级断言都对着
// `http://127.0.0.1:9`（一个拒绝连接的端口）跑，能证明的只有「拒绝」——一次运行永远失败，
// 永远不会发布发现。于是「完成态怎么显示」「预算截断算不算干净」「全量扫描问的是什么形态」
// 「provider 挂了与截断是不是同一件事」都停在预览级或组件级。
//
// 一半检查是纯函数（不 spawn）：相位按声明的工具区分，不是按提示词措辞；发现锚在该文件自己
// 的第一条新增行上；第二次 review 轮要跳过 `<confirmed_findings>` 里已确认的文件——否则同一
// 个发现会被发布两次，运行不报错，只是 `summary.comments` 说 2。
//
// 另一半请**钉住的 `ocr` 二进制真跑**四趟，替身只绑 loopback、不出网、不花 token：
//
//   A 完成态   → status=complete，一条标记发现，走完 review→filter 两相
//   B 预算截断 → status 仍是 complete，但 `summary.budget_exceeded` 为真且带 token_budget_reached
//                警告（这就是「截断不该装干净」在 CLI 侧的原话），已发布的发现没有被擦掉
//   C 全量扫描 → status=success（与 review 的 complete 不是同一个词），问的是
//                `<current_file_path>` 而不是 `<review_files>`
//   D 挂掉     → provider 答 500，运行以非零退出且 0 条发现，与「截断」不是同一个结局
//
// 四趟都断言 provider 真的被问过、URL 是 loopback 的 `/v1/chat/completions`：一条「回复能解析」
// 不等于「请求发生过」，而这里要钉的恰恰是后者。
import path from "node:path";

import {
  DEFAULT_USAGE,
  FINDING_CATEGORY,
  FINDING_CONTENT,
  FINDING_SEVERITY,
  PHASE_TOOLS,
  commentsFor,
  confirmedFilesOf,
  newlyReviewable,
  phaseOf,
  reviewFilesOf,
  reviewReply,
} from "./fake-provider.mjs";
import { PROVIDER_NAME, startFixture } from "./fake-provider-cli.mjs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok     " : "FAIL   "} ${name}${ok || !detail ? "" : `：${detail}`}`);
};

const tool = (name) => ({ type: "function", function: { name } });
const body = (tools, text) => ({ model: "fake-model", tools: tools.map(tool), messages: [{ role: "user", content: text }] });
const callsOf = (reply) => reply.choices[0].message.tool_calls;
const callNames = (reply) => callsOf(reply).map((call) => call.function.name);
const argsOf = (call) => JSON.parse(call.function.arguments);

/* ---- 1. 相位由声明的工具决定，不由措辞决定 ---- */

{
  const reviewText = "## Role\nYou are a code review assistant.";
  check("没有声明任何工具 → plan（上游 plan 模板就是这样）", phaseOf({ tools: [], messages: [] }) === "plan", phaseOf({ tools: [], messages: [] }));
  check("`tools` 整个缺失也答 plan（不是 undefined）", phaseOf({ messages: [] }) === "plan", String(phaseOf({ messages: [] })));
  check("声明了 code_comment → review", phaseOf(body([PHASE_TOOLS.review], reviewText)) === "review");
  check(
    "同一句话、换成 filter 的工具 → filter（判的是工具集，不是提示词）",
    phaseOf(body([PHASE_TOOLS.filter], reviewText)) === "filter" &&
      phaseOf(body([PHASE_TOOLS.review], reviewText)) === "review"
  );
  check(
    "两个工具都声明时 filter 优先（后置的复核轮不能被当成再review一次）",
    phaseOf(body([PHASE_TOOLS.review, PHASE_TOOLS.filter], reviewText)) === "filter"
  );
  check(
    "声明了其它工具（没有这两个）→ unknown，而不是猜一个相位",
    phaseOf(body(["code_search", "file_read"], reviewText)) === "unknown",
    String(phaseOf(body(["code_search"], reviewText)))
  );
  let thrown = "";
  try {
    reviewReply(body(["code_search"], reviewText));
  } catch (err) {
    thrown = String(err && err.message);
  }
  check("对着 unknown 相位会抛错，并把工具名点出来（不发明发现）", /does not speak this phase/.test(thrown) && /code_search/.test(thrown), thrown);
}

/* ---- 2. 两种提示词形态各读各的 ---- */

{
  const diff = [
    "<review_files>",
    '<file path="b.go">',
    "diff --git a/b.go b/b.go",
    "+++ b/b.go",
    "+package main",
    "+",
    "+func helper() int { return 1 }",
    "</file>",
    '<file path="c.go">',
    "+package util",
    "</file>",
    "</review_files>",
  ].join("\n");
  const files = reviewFilesOf(diff);
  check("diff 形态：每个 `<file path>` 一条", files.length === 2 && files[0].path === "b.go" && files[1].path === "c.go", JSON.stringify(files));
  check(
    "新增行去掉 `+`、丢掉 `+++` 头、丢掉空行",
    JSON.stringify(files[0].addedLines) === JSON.stringify(["package main", "func helper() int { return 1 }"]),
    JSON.stringify(files[0].addedLines)
  );

  const scan = "<current_file_path>b.go</current_file_path>\n<current_file_content>package main\n\nfunc helper() {}\n</current_file_content>";
  const scanned = reviewFilesOf(scan);
  check(
    "scan 形态：读 `<current_file_path>` + 整份内容（每行都可锚）",
    scanned.length === 1 && scanned[0].path === "b.go" && scanned[0].addedLines.join("|") === "package main|func helper() {}",
    JSON.stringify(scanned)
  );
  check("两种形态都没有时答空数组（不编一个文件名）", reviewFilesOf("nothing here").length === 0);
}

/* ---- 3. 已确认的发现不再报第二遍 ---- */

{
  const task = [
    "<review_files>",
    '<file path="b.go">',
    "+package main",
    "</file>",
    '<file path="c.go">',
    "+package util",
    "</file>",
    "</review_files>",
    "### Previously Confirmed Findings",
    "The following issues were already identified and confirmed in a prior review pass. Do not repeat them.",
    "<confirmed_findings>",
    "1. b.go",
    "   code: package main",
    "   issue: FAKE-PROVIDER: this added line needs a second look",
    "</confirmed_findings>",
  ].join("\n");
  check(
    "`confirmedFilesOf` 只读编号行里的路径，不把 issue 正文当路径",
    JSON.stringify(confirmedFilesOf(task)) === JSON.stringify(["b.go"]),
    JSON.stringify(confirmedFilesOf(task))
  );
  check("没有那个块时答空数组（第一趟）", confirmedFilesOf("<review_files></review_files>").length === 0);
  check(
    "`newlyReviewable` 留下没被确认的那些文件",
    newlyReviewable(reviewFilesOf(task), confirmedFilesOf(task)).map((f) => f.path).join() === "c.go",
    JSON.stringify(newlyReviewable(reviewFilesOf(task), confirmedFilesOf(task)).map((f) => f.path))
  );

  const first = reviewReply(body([PHASE_TOOLS.review], task.replace(/### Previously Confirmed Findings[\s\S]*$/, "")));
  check("第一趟：按文件报发现（一条 code_comment）", callNames(first).join() === PHASE_TOOLS.review, callNames(first).join());
  const onlyConfirmed = [
    "<review_files>",
    '<file path="b.go">',
    "+package main",
    "</file>",
    "</review_files>",
    "<confirmed_findings>",
    "1. b.go",
    "   code: package main",
    "</confirmed_findings>",
  ].join("\n");
  const second = reviewReply(body([PHASE_TOOLS.review], onlyConfirmed));
  check(
    "第二趟：只剩已确认的文件 → task_done，不重复发布",
    callNames(second).join() === "task_done",
    callNames(second).join()
  );
  check(
    "第二趟里还有没确认的文件时仍然会报（跳过的是已确认的那些，不是整趟静默）",
    callNames(reviewReply(body([PHASE_TOOLS.review], task))).join() === PHASE_TOOLS.review
  );

  const two = argsOf(callsOf(reviewReply(body([PHASE_TOOLS.review], task.replace(/### Previously Confirmed Findings[\s\S]*$/, "")), { findingsPerFile: 2 }))[0]);
  check(
    "`findingsPerFile` 决定每个文件报几条，锚点仍在该文件的新增行上",
    two.comments.length === 4 &&
      two.comments.filter((c) => c.path === "b.go").length === 2 &&
      two.comments.some((c) => /\(#2\)$/.test(c.content)) &&
      two.comments.every((c) => (c.path === "b.go" ? c.existing_code === "package main" : c.existing_code === "package util")),
    JSON.stringify(two.comments.map((c) => `${c.path}:${c.existing_code}:${c.content.slice(-4)}`))
  );
  check(
    "发现带固定标记、category/severity 稳定（屏幕上一眼能认出是替身发的）",
    two.comments[0].content.startsWith(FINDING_CONTENT) && two.comments[0].category === FINDING_CATEGORY && two.comments[0].severity === FINDING_SEVERITY
  );
}

/* ---- 4. 另外两个相位与信封形状 ---- */

{
  const filter = reviewReply(body([PHASE_TOOLS.filter], "<review_files></review_files>"));
  check("filter 相位：一条 approve_all_comments（上游说这是多数文件的正常结局）", callNames(filter).join() === PHASE_TOOLS.filter, callNames(filter).join());
  const plan = reviewReply(body([], "plan please"));
  check("plan 相位：立刻 task_done，不产生发现", callNames(plan).join() === "task_done", callNames(plan).join());

  const reply = reviewReply(body([PHASE_TOOLS.review], '<file path="b.go">\n+package main\n</file>'));
  check(
    "信封是 OpenAI chat.completion：choices[0].message.tool_calls + finish_reason + 回显 model",
    reply.object === "chat.completion" &&
      reply.model === "fake-model" &&
      reply.choices[0].finish_reason === "tool_calls" &&
      reply.choices[0].message.role === "assistant" &&
      Array.isArray(reply.choices[0].message.tool_calls) &&
      reply.choices[0].message.tool_calls.every((call) => call.type === "function" && typeof call.function.arguments === "string")
  );
  check(
    "默认 usage 是 160（小到任何预算都容得下）；传了就按传的答",
    JSON.stringify(reply.usage) === JSON.stringify(DEFAULT_USAGE) &&
      reviewReply(body([], "x"), { usage: { total_tokens: 999 } }).usage.total_tokens === 999
  );
}

/* ---- 5. 真跑：完成态 ---- */

const summary = [];
let completed = null;
{
  const fixture = await startFixture();
  try {
    const run = await fixture.runJson(fixture.review());
    const json = run.json;
    completed = { run, json };
    check("A 运行以 0 退出", run.code === 0, `退出码 ${run.code}；stderr：${run.stderr.slice(0, 500)}`);
    check("A 报告 parse 得出来（`--audience agent --format json` 的 stdout 就是它）", Boolean(json), run.stdout.slice(0, 500));
    check("A status=complete", json && json.status === "complete", json && json.status);
    const comments = (json && json.comments) || [];
    check(
      "A 只发布一条发现，内容是这个替身唯一会说的话",
      comments.length === 1 && comments[0].content === FINDING_CONTENT,
      JSON.stringify(comments.map((c) => c.content))
    );
    check(
      "A 发现落在 b.go 的第 1 行（CLI 的定位器真的匹配上了新增行）",
      comments.length === 1 && comments[0].path === "b.go" && comments[0].start_line >= 1 && /package main/.test(comments[0].existing_code || ""),
      JSON.stringify(comments[0])
    );
    const asked = fixture.provider.requests;
    check(
      "A provider 真的被问过，且每一次都是 loopback 上的 `/v1/chat/completions`",
      asked.length >= 4 && asked.every((r) => r.method === "POST" && r.url.endsWith("/v1/chat/completions") && /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(fixture.provider.url)),
      `${asked.length} 次：${asked.map((r) => `${r.method} ${r.url}`).join(", ")}`
    );
    const phases = asked.map((r) => phaseOf(JSON.parse(r.body)));
    check(
      "A 走完了 review 与 filter 两相（不是只问一次就当完事）",
      phases.includes("review") && phases.includes("filter"),
      phases.join(",")
    );
    const reviewBodies = asked.map((r) => JSON.parse(r.body)).filter((b) => phaseOf(b) === "review");
    const secondPass = reviewBodies.filter((b) =>
      /<confirmed_findings>/.test(b.messages.filter((m) => m.role === "user").slice(-1)[0].content)
    );
    check(
      "A 上游确实有第二趟 review，且带着 `<confirmed_findings>`（所以上面那条 1 是真的靠跳过换来的）",
      secondPass.length >= 1,
      `${reviewBodies.length} 趟 review，其中带已确认块的 ${secondPass.length} 趟`
    );
    check(
      "A CLI 的 token 计数等于这个替身报的数（每个请求 160）",
      json && json.summary.total_tokens === DEFAULT_USAGE.total_tokens * asked.length,
      json && `report=${json.summary.total_tokens} 报出=${DEFAULT_USAGE.total_tokens * asked.length}`
    );
    summary.push(`A 完成态 ${run.ms}ms / ${asked.length} 次请求 / ${comments.length} 条发现`);
  } finally {
    await fixture.close();
  }
}

/* ---- 6. 真跑：预算截断 ---- */

{
  const fixture = await startFixture({ providerOptions: { usage: { prompt_tokens: 20000, completion_tokens: 10000, total_tokens: 30000 } } });
  try {
    const run = await fixture.runJson(fixture.review(["--max-tokens-budget", "25000"]));
    const json = run.json;
    check("B 预算截断的运行以 0 退出（部分结果会被发布）", run.code === 0, `退出码 ${run.code}`);
    check(
      "B status 仍是 complete，但 `summary.budget_exceeded` 为真——干净与否不在 status 里",
      json && json.status === "complete" && json.summary && json.summary.budget_exceeded === true,
      json && JSON.stringify({ status: json.status, budget_exceeded: json.summary && json.summary.budget_exceeded })
    );
    const warnings = (json && json.warnings) || [];
    check(
      "B 带 token_budget_reached 警告（这是 CLI 自己的话，不是我们猜的）",
      warnings.some((w) => w.type === "token_budget_reached"),
      JSON.stringify(warnings.map((w) => w.type))
    );
    check(
      "B 截断没有擦掉已经发布的发现（1 条标记发现仍在）",
      (json && json.comments || []).length === 1 && json.comments[0].content === FINDING_CONTENT,
      JSON.stringify((json && json.comments) || [])
    );
    summary.push(`B 截断态 ${run.ms}ms / budget_exceeded=${json && json.summary.budget_exceeded} / 发现 ${((json && json.comments) || []).length} 条`);
  } finally {
    await fixture.close();
  }
}

/* ---- 7. 真跑：全量扫描 ---- */

{
  const fixture = await startFixture();
  try {
    const run = await fixture.runJson(["scan", "--path", "b.go", "--audience", "agent", "--format", "json"]);
    const json = run.json;
    check("C 全量扫描以 0 退出并给出报告", run.code === 0 && Boolean(json), `退出码 ${run.code}`);
    check(
      "C status=success（与 review 的 complete 不是同一个词，界面按哪个词认要照实）",
      json && json.status === "success",
      json && json.status
    );
    check(
      "C 一条标记发现落在 b.go",
      ((json && json.comments) || []).length === 1 && json.comments[0].content === FINDING_CONTENT && json.comments[0].path === "b.go",
      JSON.stringify((json && json.comments) || [])
    );
    const firstTaskText = fixture.provider.requests
      .map((r) => JSON.parse(r.body))
      .filter((b) => phaseOf(b) === "review")
      .map((b) => b.messages.filter((m) => m.role === "user").slice(-1)[0].content)[0];
    check(
      "C 扫描问的是 `<current_file_path>`（整份文件），不是 `<review_files>`（diff）",
      Boolean(firstTaskText) && /<current_file_path>/.test(firstTaskText) && !/<review_files>/.test(firstTaskText),
      firstTaskText ? `长度 ${firstTaskText.length}` : "没有 review 相位的请求"
    );
    summary.push(`C 全量扫描 ${run.ms}ms / ${fixture.provider.requests.length} 次请求`);
  } finally {
    await fixture.close();
  }
}

/* ---- 8. 真跑：provider 挂了 ---- */

{
  const fixture = await startFixture({ providerOptions: { refuse: true } });
  try {
    const run = await fixture.runJson(fixture.review());
    const json = run.json;
    check("D provider 答 500 时运行不是 0 退出", run.code !== 0, `退出码 ${run.code}`);
    check(
      "D status=failed 且没有发现——「provider 挂了」与「预算截断」是两个结局",
      Boolean(json) && json.status === "failed" && ((json.comments || []).length === 0),
      json ? JSON.stringify({ status: json.status, comments: (json.comments || []).length }) : run.stderr.slice(0, 300)
    );
    check(
      "D 失败原因指向 provider，而不是被当成本地仓库/参数错误",
      Boolean(json) && JSON.stringify(json).length > 0 && fixture.provider.requests.length > 0,
      `${fixture.provider.requests.length} 次请求`
    );
    summary.push(`D 挂掉 ${run.ms}ms / status=${json && json.status}`);
  } finally {
    await fixture.close();
  }
}

/* ---- 9. 这四趟真的跑过 ---- */

check("四趟真跑都拿到了读数（不是提前 return 掉的空壳）", summary.length === 4, summary.join("；"));
if (completed && completed.json) {
  console.log(
    `\n真跑读数：${summary.join("；")}；完成态 provider=${PROVIDER_NAME} ` +
      `session=${completed.json.session_id ? "有" : "无"}，路径=${path.basename(completed.run.args[0])}`
  );
}

const failed = results.filter((result) => !result.ok);
console.log(`\n假 provider 的规则：${results.length} 条检查，${failed.length} 条红`);
if (failed.length) {
  console.error(failed.map((result) => `  - ${result.name}：${result.detail}`).join("\n"));
  process.exit(1);
}
