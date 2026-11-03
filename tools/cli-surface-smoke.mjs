// SPDX-License-Identifier: Apache-2.0
// Checks that `tools/cli-surface.mjs` can go red.
//
// The parameter-surface gate reads two machines: the pinned binary's `--help`,
// and the argv the wrapper hands to `spawn`. Neither belongs in a self-check that
// has to run without a binary, and a self-check that only recites the tables
// proves nothing. So the base below is *built from the tables*: helps, recorded
// invocations and consumer sources are synthesised so the honest answer is empty,
// every rule then faces one doctored fact, and each control asks whether the rule
// that owns that fact says so in its own words.
//
// The three tables are inputs to the rule function for exactly this reason — a
// rule whose data cannot be doctored cannot be shown to fire, and "it looks
// right" is what a table that stopped matching the code has always said.
//
// Three checks look at the repository instead of the fixture, because those claims
// would otherwise be true only when the binary happens to be around: the
// `llm test` needle must be in `config-handler.js` as written, the flag literals in
// the two consumer modules must be exactly the declared ones, and the sync doc must
// still carry a comparison row for the two run commands.
import fs from "node:fs";
import path from "node:path";

import {
  CLI_ABSENCES,
  CLI_COMMANDS,
  CLI_SURFACE,
  CLI_UNCONSUMED,
  classifyInvocation,
  cliSurfaceViolations,
  flagLiteralsIn,
  parseCobraHelp,
  previewResumeViolations,
  versionAttribution,
} from "./cli-surface.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

// A finding "names" a token or a command when one of its sentences contains it.
// Which message fires is not the contract; that the reader can locate the row is.
const namesToken = (report, token) => report.some((line) => line.includes(token));
const namesCommand = (report, command) => report.some((line) => line.includes(command));

// ---- the base: the tables, fed back to themselves ----

const longOf = (row) => row.long || row.token;
const rowsFor = (command, table = CLI_SURFACE) => table.filter((row) => row.command === command);
const cloneFlags = (entries) => {
  const flags = new Map();
  for (const entry of entries) flags.set(entry.long, { ...entry });
  return flags;
};

const helpFor = (command, { surface = CLI_SURFACE, unconsumed = CLI_UNCONSUMED, extra = [], unknown = [] } = {}) => {
  const entries = rowsFor(command, surface).map((row) => ({
    token: row.token,
    long: longOf(row),
    short: row.token.startsWith("-") && !row.token.startsWith("--") ? row.token : null,
    kind: row.kind,
    help: `synthesized help for ${longOf(row)}`,
  }));
  for (const entry of unconsumed.filter((item) => item.command === command)) {
    entries.push({ token: entry.token, long: entry.token, short: null, kind: "string", help: "offered, not used here" });
  }
  return { flags: cloneFlags([...entries, ...extra]), unknown };
};

const baseHelps = (overrides = {}) => {
  const helps = new Map();
  for (const command of CLI_COMMANDS) {
    helps.set(command, helpFor(command, overrides[command] || {}));
  }
  return helps;
};

// One recorded invocation per command, spelling every declared flag of that
// command — except the rows that declare a needle, whose whole point is that no
// recorder reaches their call site.
//
// `--resume` is spelled on a line of its own when the same command also declares
// `--preview`. The wrapper never pairs them (the CLI rejects the pair, rule 6), so
// a fixture that spelled both at once would put two findings into the base that
// the tables did not cause — and every control below is judged against that base,
// which is how a base that is not the honest answer makes a whole file of controls
// pass or fail for the wrong reason. Both rows are still spelled, so rule 2 ("a
// row nobody spells any more") sees no copy.
const baseInvocations = (table = CLI_SURFACE) =>
  CLI_COMMANDS.flatMap((command) => {
    const rows = rowsFor(command, table).filter((row) => !row.needle);
    const spell = (picked) => ({
      command,
      argv: [command, ...picked.flatMap((row) => (row.kind === "bool" ? [row.token] : [row.token, "x"]))],
      flags: picked.map((row) => ({ token: row.token, value: row.kind === "bool" ? null : "x", known: true })),
    });
    const together = rows.filter((row) => row.token !== "--resume");
    const resumed = rows.filter((row) => row.token === "--resume");
    const runs = [];
    if (together.length) runs.push(spell(together));
    if (resumed.length) runs.push(spell(resumed));
    return runs;
  });

// The help side and the source side come from the *real* tables even when a
// control doctored one of them: a fixture that moved all three at once would
// report a mismatch that no single edit could have caused.
const baseSources = () => {
  const tokens = [...new Set(CLI_SURFACE.map((row) => row.token))];
  const needles = CLI_SURFACE.filter((row) => row.needle);
  return new Map([
    ["ocr-service.js", tokens.map((token) => `"${token}"`).join(", ")],
    ["config-handler.js", needles.map((row) => row.needle.text).join("\n")],
  ]);
};

const evaluate = (over = {}) => {
  const base = {
    helps: baseHelps(over.helpOverrides || {}),
    invocations: baseInvocations(),
    sources: baseSources(),
    surface: CLI_SURFACE,
    absences: CLI_ABSENCES,
    unconsumed: CLI_UNCONSUMED,
  };
  const patch = { ...base, ...over };
  if (over.helps === null) patch.helps = new Map();
  if (over.invocations === null) patch.invocations = [];
  if (over.sources === null) patch.sources = new Map();
  return cliSurfaceViolations(patch);
};

const clean = evaluate();
check(
  "the tables, fed back to themselves, are the honest answer: no finding at all",
  clean.length === 0,
  clean.slice(0, 3).join(" | ")
);
check(
  "...and the base itself never pairs --preview with --resume (the premise rule 6 is judged against)",
  previewResumeViolations(baseInvocations().map((run, index) => ({ ...run, index: index + 1 }))).length === 0,
  baseInvocations()
    .filter((run) => run.flags.some((flag) => flag.token === "--preview"))
    .map((run) => `${run.command}: ${run.flags.map((flag) => flag.token).join(" ")}`)
    .join(" | ")
);
check(
  "...and that answer is not vacuous: 12 commands, dozens of declared rows, a recorded invocation per command",
  CLI_COMMANDS.length === 12 &&
    CLI_SURFACE.length > 40 &&
    baseInvocations().length >= 10 &&
    CLI_UNCONSUMED.length > 8,
  `commands=${CLI_COMMANDS.length} rows=${CLI_SURFACE.length} runs=${baseInvocations().length} unused=${CLI_UNCONSUMED.length}`
);

/* ---- rule 1: a declared flag must exist on the command, with the same kind ---- */
{
  const retyped = evaluate({
    helpOverrides: { review: { extra: [{ token: "--max-tokens", long: "--max-tokens", short: null, kind: "string", help: "now a string" }] } },
  });
  check(
    "a CLI that retypes --max-tokens goes red and says which side claims what",
    namesToken(retyped, "--max-tokens") && retyped.some((line) => line.includes("类型不一致")),
    retyped.join(" | ")
  );

  const missingHelp = baseHelps();
  missingHelp.set("review", { flags: cloneFlags([...missingHelp.get("review").flags.values()].filter((e) => e.long !== "--effort")), unknown: [] });
  const dropped = cliSurfaceViolations({
    helps: missingHelp,
    invocations: baseInvocations(),
    sources: baseSources(),
  });
  check(
    "a flag the command stopped accepting is reported as the run-killer it is, not dropped from the table",
    dropped.length === 1 && namesToken(dropped, "--effort") && dropped[0].includes("unknown flag"),
    dropped.join(" | ")
  );

  const reShorted = baseHelps();
  reShorted.set("session export", {
    flags: cloneFlags([...reShorted.get("session export").flags.values()].map((e) => (e.long === "--output" ? { ...e, short: "-O" } : e))),
    unknown: [],
  });
  const shortChanged = cliSurfaceViolations({
    helps: reShorted,
    invocations: baseInvocations(),
    sources: baseSources(),
  });
  check(
    "...and a short alias that stops matching the long flag is named, not matched by luck",
    namesToken(shortChanged, "-o") && shortChanged.some((line) => line.includes("短写法")),
    shortChanged.join(" | ")
  );
}

/* ---- rule 2: a declared row has to be spelled by something ---- */
{
  const invocations = baseInvocations().map((run) =>
    run.command === "scan" ? { ...run, flags: run.flags.filter((flag) => flag.token !== "--no-plan") } : run
  );
  const copy = cliSurfaceViolations({ helps: baseHelps(), invocations, sources: baseSources() });
  check(
    "a row nobody spells any more goes red: the table may not keep a copy of an old contract",
    copy.length === 1 && namesToken(copy, "--no-plan") && copy[0].includes("是拷贝"),
    copy.join(" | ")
  );

  const lostNeedle = new Map(baseSources());
  lostNeedle.set("config-handler.js", "// that array moved away\n");
  const needleless = cliSurfaceViolations({ helps: baseHelps(), invocations: baseInvocations(), sources: lostNeedle });
  check(
    "the exempt row (`llm test`) pays for its exemption with a literal: drop the literal, go red",
    needleless.some((line) => namesCommand([line], "llm test") && line.includes("字面量")),
    needleless.join(" | ")
  );

  const row = CLI_SURFACE.find((item) => item.needle);
  const misnamed = evaluate({
    surface: CLI_SURFACE.map((item) =>
      item === row ? { ...item, needle: { file: "config-handler.js", text: `["llm", "providers", "--color", "never"]` } } : item
    ),
  });
  check(
    "...and a needle whose command path is a different command is refused on its own terms",
    misnamed.some((line) => line.includes("没有「llm test」这条命令路径")),
    misnamed.join(" | ")
  );

  const emptyNeedle = evaluate({
    surface: CLI_SURFACE.map((item) => (item === row ? { ...item, needle: { file: "config-handler.js", text: "  " } } : item)),
  });
  check(
    "...and an empty needle is not an exemption: the row has to say what pins it",
    emptyNeedle.some((line) => line.includes("没有字面量")),
    emptyNeedle.join(" | ")
  );

  const foreignFile = evaluate({
    surface: CLI_SURFACE.map((item) => (item === row ? { ...item, needle: { file: "run-handler.js", text: row.needle.text } } : item)),
  });
  check(
    "...and a needle in a file this check does not read is named, so the exemption cannot move somewhere unwatched",
    foreignFile.some((line) => line.includes("run-handler.js") && line.includes("不在本检查读的消费模块里")),
    foreignFile.join(" | ")
  );
}

/* ---- rule 3: whatever is spelled has to be in the table ---- */
{
  const invocations = baseInvocations().map((run) =>
    run.command === "review" ? { ...run, flags: [...run.flags, { token: "--effort-plus", value: "x", known: false }] } : run
  );
  const report = cliSurfaceViolations({ helps: baseHelps(), invocations, sources: baseSources() });
  check(
    "a flag the wrapper starts sending without a row is named twice (help + table), with the file blame left to the reader",
    namesToken(report, "--effort-plus") &&
      report.some((line) => line.includes("参数面表里没有这一行")) &&
      report.some((line) => line.includes("--help 里没有它")),
    report.join(" | ")
  );

  const newCommand = baseInvocations().concat([{ command: "delegate", argv: ["delegate"], flags: [{ token: "--json", value: null, known: false }] }]);
  const added = cliSurfaceViolations({ helps: baseHelps(), invocations: newCommand, sources: baseSources() });
  check(
    "...and a spawn of a command that was never compared goes red by its own name",
    namesCommand(added, "delegate") && added.some((line) => line.includes("不在核对清单里")),
    added.join(" | ")
  );
}

/* ---- rule 4: everything the CLI offers is either sent or decided against ---- */
{
  const withNew = evaluate({
    helpOverrides: { review: { extra: [{ token: "--stream", long: "--stream", short: null, kind: "bool", help: "new upstream flag" }] } },
  });
  check(
    "an upstream flag this wrapper has not classified goes red — the whole point of the coverage half",
    withNew.length === 1 && namesToken(withNew, "--stream") && withNew[0].includes("没写为什么不用"),
    withNew.join(" | ")
  );

  const decidedAway = evaluate({
    unconsumed: CLI_UNCONSUMED.filter((entry) => !(entry.command === "review" && entry.token === "--tools")),
  });
  check(
    "deleting a written-down decision reopens the same question, on the same token",
    decidedAway.length === 1 && namesToken(decidedAway, "--tools") && decidedAway[0].includes("没写为什么不用"),
    decidedAway.join(" | ")
  );

  const smallerHelps = baseHelps();
  smallerHelps.set("session export", {
    flags: cloneFlags([...smallerHelps.get("session export").flags.values()].filter((e) => e.long !== "--color")),
    unknown: [],
  });
  const staleDecision = cliSurfaceViolations({
    helps: smallerHelps,
    invocations: baseInvocations(),
    sources: baseSources(),
  });
  check(
    "a decision about a flag the CLI no longer offers is named as a decision that guards nothing",
    staleDecision.length === 1 && namesToken(staleDecision, "--color") && staleDecision[0].includes("看起来比实际长"),
    staleDecision.join(" | ")
  );

  const noisy = baseHelps();
  noisy.set("rules check", { flags: cloneFlags(noisy.get("rules check").flags.values()), unknown: ["--mystery ??"] });
  const noise = cliSurfaceViolations({ helps: noisy, invocations: baseInvocations(), sources: baseSources() });
  check(
    "a help line the parser could not read is a finding, not a silently smaller surface",
    noise.length === 1 && namesCommand(noise, "rules check") && noise[0].includes("解析不出来"),
    noise.join(" | ")
  );

  const noReason = evaluate({
    unconsumed: CLI_UNCONSUMED.map((entry, index) => (index === 0 ? { ...entry, why: "  " } : entry)),
  });
  check(
    "a bare token in the 「不用」 list is refused: a decision needs the decision",
    noReason.some((line) => line.includes("没有写下为什么不")),
    noReason.join(" | ")
  );
}

/* ---- rule 5: believed absences ---- */
{
  const withNew = evaluate({
    helpOverrides: { scan: { extra: [{ token: "--effort", long: "--effort", short: null, kind: "string", help: "review effort preset" }] } },
  });
  check(
    "the day scan accepts --effort, the whitelist has to be reopened on purpose",
    withNew.some((line) => namesCommand([line], "scan") && line.includes("现在收 --effort")),
    withNew.join(" | ")
  );

  const contradiction = evaluate({
    surface: CLI_SURFACE.concat([{ command: "scan", token: "--effort", kind: "string", why: "pretend we spell it" }]),
  });
  check(
    "a flag cannot be both spelled and believed absent",
    contradiction.some((line) => line.includes("不能既拼又不拼")),
    contradiction.join(" | ")
  );

  const noReasonAbsence = evaluate({ absences: CLI_ABSENCES.map((entry, i) => (i === 0 ? { ...entry, why: "" } : entry)) });
  check(
    "...and an absence without a reason is refused too, because 「不收」 is a claim about the CLI",
    noReasonAbsence.some((line) => line.includes("却没有写下理由")),
    noReasonAbsence.join(" | ")
  );

  check(
    "the real tables keep the two lists apart (premise for the control above)",
    CLI_ABSENCES.every((entry) => !CLI_SURFACE.some((row) => row.command === entry.command && row.token === entry.token)),
    `${CLI_ABSENCES.length} absence rows`
  );
}

/* ---- rule 6: --preview never carries --resume ---- */
{
  const leaked = previewResumeViolations([
    { index: 1, command: "review", flags: [{ token: "--preview" }, { token: "--resume" }] },
    { index: 2, command: "scan", flags: [{ token: "--preview" }] },
  ]);
  check(
    "the preview/run split is judged on the recorded command lines, and only the offending one is named",
    leaked.length === 1 && leaked[0].includes("第 1 次"),
    leaked.join(" | ")
  );
  const invocations = baseInvocations().map((run) =>
    run.command === "review" ? { ...run, flags: [...run.flags, { token: "--preview", value: null, known: true }] } : run
  );
  const combined = cliSurfaceViolations({ helps: baseHelps(), invocations, sources: baseSources() });
  check(
    "...and the same pair, arriving through the rule set, is reported there as well",
    combined.some((line) => line.includes("同时拼了 --preview 与 --resume")),
    combined.join(" | ")
  );
}

/* ---- the source-literal bijection ---- */
{
  const extra = new Map(baseSources());
  extra.set("ocr-service.js", `${extra.get("ocr-service.js")}, "--sneaky"`);
  const report = cliSurfaceViolations({ helps: baseHelps(), invocations: baseInvocations(), sources: extra });
  check(
    "a flag added in code without a row is named together with the file that added it",
    report.length === 1 && namesToken(report, "--sneaky") && report[0].includes("ocr-service.js"),
    report.join(" | ")
  );

  const orphan = evaluate({
    surface: CLI_SURFACE.concat([{ command: "scan", token: "--ghost", kind: "bool", why: "a row for code that does not exist" }]),
  });
  check(
    "...and a row whose literal exists in neither consumer module goes red",
    orphan.some((line) => line.includes("--ghost") && line.includes("不存在的代码")),
    orphan.join(" | ")
  );
}

/* ---- row shape, checked before anything is compared ---- */
{
  const dupe = evaluate({ surface: CLI_SURFACE.concat([CLI_SURFACE[0]]) });
  check(
    "the same (command, flag) written twice is refused, naming both ordinals",
    dupe.some((line) => line.includes("与第 1 行重复")),
    dupe.join(" | ")
  );
  const noWhy = evaluate({ surface: CLI_SURFACE.map((row, i) => (i === 0 ? { ...row, why: "" } : row)) });
  check("a row without a reason is refused", noWhy.some((line) => line.includes("没有写「本仓为什么拼它」")), noWhy.join(" | "));
  const badKind = evaluate({ surface: CLI_SURFACE.map((row, i) => (i === 0 ? { ...row, kind: "int64" } : row)) });
  check("a kind outside string/int/bool is refused", badKind.some((line) => line.includes("不是 string/int/bool 之一")), badKind.join(" | "));
  const badLong = evaluate({ surface: CLI_SURFACE.map((row, i) => (i === 0 ? { ...row, long: "-r" } : row)) });
  check("a `long` that is not a long flag is refused", badLong.some((line) => line.includes("long 必须是长写法")), badLong.join(" | "));
  const badCommand = evaluate({ surface: CLI_SURFACE.map((row, i) => (i === 0 ? { ...row, command: "reviewx" } : row)) });
  check("a row on a command outside the comparison list is refused", badCommand.some((line) => line.includes("reviewx")), badCommand.join(" | "));
  const badUnconsumed = evaluate({ unconsumed: CLI_UNCONSUMED.map((e, i) => (i === 0 ? { ...e, command: "scanx" } : e)) });
  check("a 「不用」 row on an unknown command is refused", badUnconsumed.some((line) => line.includes("scanx")), badUnconsumed.join(" | "));
}

/* ---- the inputs themselves are refused when empty ---- */
{
  const noHelps = evaluate({ helps: null });
  const noRuns = evaluate({ invocations: null });
  const noTable = evaluate({ surface: [] });
  check(
    "no --help output, no recorded invocation, or an empty table is a finding rather than a pass",
    noHelps.some((line) => line.includes("参数面无法核对")) &&
      noRuns.some((line) => line.includes("一次调用都没录到")) &&
      noTable.some((line) => line.includes("参数面表是空的")),
    `${noHelps.length}/${noRuns.length}/${noTable.length}`
  );
}

/* ---- classifyInvocation: how an argv becomes a command + flags ---- */
{
  const positional = classifyInvocation(["config", "set", "provider", "openai"], { commands: CLI_COMMANDS, kindsFor: () => null });
  const eaten = classifyInvocation(["review", "--repo", "/tmp/-weird/repo", "--no-filter", "x.go"], {
    kindsFor: (c, t) => (t === "--repo" ? "string" : t === "--no-filter" ? "bool" : null),
  });
  const valueLooksLikeFlag = classifyInvocation(["review", "--rule", "--repo", "/r"], {
    kindsFor: (c, t) => (t === "--rule" || t === "--repo" ? "string" : null),
  });
  const unknown = classifyInvocation(["review", "--mystery", "value", "--repo", "/r"], {
    kindsFor: (c, t) => (t === "--repo" ? "string" : null),
  });
  check(
    "positional arguments after `config set` stay positional (the command is the longest known prefix)",
    positional.command === "config set" && positional.flags.length === 0,
    JSON.stringify(positional)
  );
  check(
    "a value that begins with `-` is a value when the flag before it takes one, and never a flag of its own",
    eaten.command === "review" && eaten.flags.map((f) => f.token).join(",") === "--repo,--no-filter",
    JSON.stringify(eaten.flags)
  );
  check(
    "a string flag's value is consumed even when it looks exactly like another flag — so the line has one flag, not two",
    valueLooksLikeFlag.flags.length === 1 &&
      valueLooksLikeFlag.flags[0].token === "--rule" &&
      valueLooksLikeFlag.flags[0].value === "--repo",
    JSON.stringify(valueLooksLikeFlag.flags)
  );
  check(
    "an unknown flag is marked as such, so the rules can report it instead of reading it as a value",
    unknown.flags[0].token === "--mystery" && unknown.flags[0].known === false,
    JSON.stringify(unknown.flags)
  );
}

/* ---- parseCobraHelp ---- */
{
  const text = [
    "Some intro",
    "",
    "Flags:",
    '  -f, --format string            output format: text, json (default "text")',
    "      --no-filter                keep all comments",
    "      --max-tokens int           per-group ceiling",
    "  -h, --help                     help for review",
    "",
    "Global Flags:",
    "      --color string             when to emit ANSI color",
    "",
    'Use "ocr [command] --help" for more information.',
  ].join("\n");
  const parsed = parseCobraHelp(text);
  check(
    "the parser reads kind, short alias and the global block, and drops --help",
    parsed.flags.get("--format")?.kind === "string" &&
      parsed.flags.get("--format")?.short === "-f" &&
      parsed.flags.get("--no-filter")?.kind === "bool" &&
      parsed.flags.get("--max-tokens")?.kind === "int" &&
      parsed.flags.has("--color") &&
      !parsed.flags.has("--help") &&
      parsed.unknown.length === 0,
    JSON.stringify([...parsed.flags.keys()])
  );
  const weird = parseCobraHelp("Flags:\n      --mystery unicorn   some new kind\n");
  check(
    "...and a line whose type word is not one cobra prints lands in `unknown` instead of being guessed",
    weird.flags.size === 0 && weird.unknown.length === 1,
    JSON.stringify(weird)
  );
  check(
    "...and help text with nothing in it parses to nothing (the rule layer turns that into a finding)",
    parseCobraHelp("").flags.size === 0,
    JSON.stringify(parseCobraHelp(""))
  );
}

/* ---- versionAttribution: which release answered ---- */
{
  const want = { tag: "v1.13.5", sha: "abb7abcd5c5196fa0278dc87db85780fa269562f" };
  const good = versionAttribution("open-code-review v1.13.5 (abb7abcd) linux/amd64", want);
  const otherTag = versionAttribution("open-code-review v1.13.4 (76ab46ac) linux/amd64", want);
  const otherCommit = versionAttribution("open-code-review v1.13.5 (deadbeef) linux/amd64", want);
  const noCommit = versionAttribution("open-code-review v1.13.5 linux/amd64", want);
  const seven = versionAttribution("open-code-review v1.13.5 (abb7abc) linux/amd64", want);
  const brokenPin = versionAttribution("open-code-review v1.13.5 (abb7abcd)", { tag: "v1.13.5", sha: "abb7abc" });
  check(
    "the version line is accepted only when it names the pinned tag AND a prefix of the pinned commit",
    good.ok && good.commit === "abb7abcd",
    JSON.stringify(good)
  );
  check(
    "the previous release, a different commit, a missing commit and an incomplete pin are four separate refusals",
    !otherTag.ok && !otherCommit.ok && !noCommit.ok && !brokenPin.ok,
    [otherTag.reason, otherCommit.reason, noCommit.reason, brokenPin.reason].join(" | ")
  );
  check(
    "...and 7 characters is accepted as the shortest real prefix, 8 is what this CLI prints",
    seven.ok && seven.commit === "abb7abc",
    JSON.stringify(seven)
  );
}

/* ---- the repository, not the fixture ---- */
{
  const needleRow = CLI_SURFACE.find((row) => row.command === "llm test");
  check(
    "`llm test` is the exempt row, and its needle is the array config-handler.js really writes",
    Boolean(needleRow?.needle) && read("config-handler.js").includes(needleRow.needle.text),
    needleRow ? `${needleRow.command} ${needleRow.token}` : "no such row"
  );

  const declared = new Set(CLI_SURFACE.map((row) => row.token));
  const literals = ["ocr-service.js", "config-handler.js"].map((file) => [file, flagLiteralsIn(read(file))]);
  const undeclared = literals.flatMap(([, set]) => [...set]).filter((token) => !declared.has(token));
  const unhunted = [...declared].filter((token) => !literals.some(([, set]) => set.has(token)));
  check(
    "the two consumer modules spell exactly the flags the table declares, both directions, with no binary in sight",
    undeclared.length === 0 && unhunted.length === 0,
    `undeclared=${undeclared.join(",")} unbacked=${unhunted.join(",")}`
  );

  const syncDoc = read("docs/OCR-UPSTREAM-SYNC.md");
  check(
    "the sync doc carries a comparison row naming both run commands' --help, so the two lists cannot drift apart",
    syncDoc.includes("`ocr review --help`") && syncDoc.includes("`ocr scan --help`"),
    syncDoc.includes("`ocr review --help`") ? "review present" : "review row missing"
  );

  const scripts = JSON.parse(read("package.json")).scripts || {};
  const surfaceScript = String(scripts["audit:surface"] || "");
  check(
    "audit:surface runs the self-check then the gate, and audit:static runs audit:surface",
    surfaceScript.includes("tools/cli-surface-smoke.mjs") &&
      surfaceScript.includes("tools/cli-surface.mjs") &&
      String(scripts["audit:static"] || "").includes("npm run audit:surface"),
    surfaceScript || "no audit:surface script"
  );
}

console.log(`\n${failures.length === 0 ? "all cli-surface self-checks passed" : `${failures.length} failed`}`);
if (failures.length) {
  console.error(`\ncli-surface self-checks failed: ${failures.join(", ")}`);
  process.exit(1);
}
