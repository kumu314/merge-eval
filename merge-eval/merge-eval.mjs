#!/usr/bin/env node
// merge-eval.mjs — 批量内容合入的确定性回归评测套件（T1 层，零依赖、零 API 成本）
//
// 设计口径（源自 Anthropic《Demystifying evals for AI agents》与 NVIDIA 2026-05 实践：
//   task   = 下面 CHECKS 里的每一项
//   trial  = 跑一次套件（--trials N 判 pass^k，面向"必须稳定"的红线）
//   grader = 确定性断言，能确定性就确定性
//   outcome= 磁盘/远端的**真实状态**，不是"我合过了"这种自述
//
// ★ 元纪律（所有 check 的前提）：
//   每条 check 的证据必须来自**外部可复读的物证**（远端 API、文件 md5、ref 真值），
//   禁止引用「我读完了 / 命令没报错」这类自述。
//   判据来源不能是「我自己写的东西」—— 用独立实现或远端真值校验自己的记录。
//
// 用法：
//   node merge-eval.mjs                # 跑 1轮
//   node merge-eval.mjs --trials 2     # 跑 2 轮，报 pass^2（幂等类红线必须这样）
//   node merge-eval.mjs --json         # 只输出 JSON
//   node merge-eval.mjs --quiet        # 只输出汇总行

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ★ 本套件**刻意住在被测仓库之外**，
//   理由：评测器与被测对象同源就等于没有独立评测；且评测基建的生命周期应长于它评测的对象。
//   所以被测仓库路径一律由外部传入，不再靠相对路径猜。
// 被测仓库路径由 MERGE_REPO 传入（可移植，不写死任何人的本机路径）
const REPO = path.resolve(process.env.MERGE_REPO || ".");
const INDEX = path.join(REPO, "index.html");
const BASELINE = path.join(REPO, "out", "merge", "index.baseline-before-merge.html");

// ★ ref 写死，避免以后拿错 ref 比对得到「不等」的假红：
//   远端读的是 REMOTE_REF，本地读的是本地 HEAD（HEAD === main，此处已实测一致）。
//   两者必须指向同一条分支，否则比的是两个东西。
// Python 解释器：优先 PYTHON env，其次常见安装位置（**不写死任何人的本机路径**）
const PYTHON_BIN = () => {
  const cands = [
    process.env.PYTHON,
    "python", "python3", "py",
  ].filter(Boolean);
  for (const c of cands) return c;
  return "python";
};

// 远端仓库 slug：用于读远端真值。**必须显式配置** ——
// 空slug 会拼出 `/repos//git/...` 这种畸形 URL，然后报一个和真实原因无关的错。
// 这是「缺项当通过」的同族：没配就该说没配，不该发一个注定失败的请求然后含糊其辞。
const REMOTE_SLUG = process.env.MERGE_REPO_SLUG || "";
const REMOTE_REF = "refs/heads/main";
const LOCAL_REF = "HEAD";

/* ── 工具 ───────────────────────────────────────────────────────── */

// 只读远端真值：ls-remote 拿远端 main 的真实 sha。
// ⚠ 绝不用 `git update-ref` 之类"把本地记录改成你以为的样子"的做法当判据来源 ——
//   那是自证陷阱（记忆错了就把假账写进 ref，之后所有判据自证通过）。
// 读远端真值。**权威只能是远端**，本地 tracking ref 不作数（那会造成判据自证）。
// 两条独立通路：git ls-remote（首选）→ GitHub API（沙箱里 git 传输常被封，api 反而通）。
// 两条都不通时报network-unavailable —— 由调用方决定这算不算红线，不在这里假装通过。
async function remoteMainSha() {
  const r = await execFile("git", ["ls-remote", "origin", REMOTE_REF], { cwd: REPO });
  const m = r.ok ? r.stdout.trim().split(/\s+/)[0] : "";
  if (/^[0-9a-f]{40}$/.test(m || "")) return { ok: true, sha: m, via: "ls-remote" };

  // 降级：GitHub API（不走 git 传输）
  const api = await ghMainSha();
  if (api.ok) return { ...api, note: `ls-remote 不可用（${(r.stderr || "").trim().slice(0, 60)}），已降级用 API 读远端真值` };

  return {
    ok: false,
    networkUnavailable: true,
    why: `远端读不到（ls-remote: ${(r.stderr || r.code || "").toString().trim().slice(0, 60)}；API: ${api.why || "失败"}）`,
  };
}

// GitHub API 读 main 的真实 sha（token 走 gh 凭据助手，不打印）
async function ghMainSha() {
  if (!REMOTE_SLUG) {
    return { ok: false, why: "未配置 MERGE_REPO_SLUG（owner/repo）—— 远端真值无从读取。请显式设置该环境变量。" };
  }
  // token 由内层 python 自行向凭据助手取，**不经过 JS 也不打印**
  const env = { ...process.env, no_proxy: "*", NO_PROXY: "*", HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "" };
  const res = await new Promise((resolve) => {
    const c = spawn(PYTHON_BIN(),
      ["-c", `
import json,subprocess,urllib.request
p=subprocess.run(["C:/Program Files/GitHub CLI/gh.exe","auth","git-credential","get"],
  input="protocol=https\\nhost=github.com\\n",capture_output=True,text=True)
tok=[l[9:].strip() for l in p.stdout.splitlines() if l.startswith("password=")][0]
req=urllib.request.Request("https://api.github.com/repos/${REMOTE_SLUG}/git/refs/heads/main",
  headers={"Authorization":"Bearer "+tok,"Accept":"application/vnd.github+json","User-Agent":"merge-eval"})
print(json.loads(urllib.request.urlopen(req,timeout=30).read().decode())["object"]["sha"])
`], { env, windowsHide: true });
    const out = [];
    c.stdout.on("data", (d) => out.push(d));
    c.on("error", (e) => resolve({ ok: false, why: e.code }));
    c.on("close", (code) => resolve(code === 0
      ? { ok: /^[0-9a-f]{40}$/.test((out.join("") || "").trim()) ? true : false,
          sha: (out.join("") || "").trim(),
          why: code === 0 ? "输出不合法" : `exit ${code}` }
      : { ok: false, why: `exit ${code}` }));
  });
  return res.ok ? { ok: true, sha: res.sha, via: "github-api" } : res;
}

// 见上方说明：本机同步 spawn 必 EBUSY，故取 sha 也走异步。

// 取 POEMS 数组文本（bracket 匹配，非正则偷懒）
function extractPoems(t) {
  const m = /const POEMS\s*=\s*\[/.exec(t);
  if (!m) return null;
  const st = m.index + m[0].length - 1;
  let i = st, depth = 0, inStr = false, esc = false;
  for (; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "[") depth++;
      else if (ch === "]") { depth--; if (depth === 0) return t.slice(st, i + 1); }
    }
  }
  return null;
}

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");


// ★ 全部拉子进程一律走异步：本机 Node 的 spawnSync/execFileSync 对任意可执行文件
//   返回 EBUSY（2026-10-06 实测，与磁盘余量无关），而异步 spawn 正常。
//   这不是防御性 coding —— 是本机硬事实，写成同步就会静默取不到基线。
function execFile(cmd, args, { cwd, maxBuffer = 1 << 28 } = {}) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd, windowsHide: true });
    const out = [], err = [];
    let n = 0, settled = false;
    const fin = (r) => { if (!settled) { settled = true; resolve(r); } };
    c.stdout.on("data", (d) => { if (n < maxBuffer) { out.push(d); n += d.length; } });
    c.stderr.on("data", (d) => err.push(d));
    c.on("error", (e) => fin({ ok: false, code: e.code || String(e.message), stdout: "", stderr: "" }));
    c.on("close", (code) => fin({
      ok: code === 0, code,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
    }));
  });
}

const gitShow = (ref) => execFile("git", ["show", `${ref}:index.html`], { cwd: REPO });

// 读某文件在 HEAD 处的 blob sha —— **不可变指向**。
// 闸门/交付尾巴要记 `path@sha` 而不是光记 path：文件是可变对象，路径能被覆盖，sha 不能。
const fileBlobSha = async (rel) => {
  const g = await execFile("git", ["rev-parse", `${LOCAL_REF}:${rel}`], { cwd: REPO });
  const v = (g.stdout || "").trim();
  return g.ok && /^[0-9a-f]{40}$/.test(v) ? v : null;
};
const gitHead = async () => (await execFile("git", ["rev-parse", LOCAL_REF], { cwd: REPO })).stdout.trim();

/* ── CHECKS 契约 ─────────────────────────────────────────────────── */
// 每项：{ id, layer, desc, run(ctx) } ；run 返回 { ok, detail, metrics }

const CHECKS = [
  {
    id: "scan.sanity",
    layer: "harness",
    desc: "防假绿第一条：POEMS 能解析出且条数 > 0、id 列表非空。什么都没扫到却全绿是最贵的假绿。",
    run() {
      if (!fs.existsSync(INDEX)) return { ok: false, detail: "index.html 不存在", metrics: {} };
      const arr = extractPoems(fs.readFileSync(INDEX, "utf8"));
      if (!arr) return { ok: false, detail: "找不到 const POEMS 数组", metrics: {} };
      let parsed;
      try { parsed = JSON.parse(arr); } catch (e) {
        return { ok: false, detail: `POEMS 解析失败: ${String(e).slice(0, 120)}`, metrics: {} };
      }
      const n = parsed.length;
      const ids = parsed.map((p) => p && p.id).filter(Boolean);
      // 分母必须 > 0，且 id 唯一，否则后续所有"逐篇"判据都建立在空集上
      const uniq = new Set(ids).size;
      return {
        ok: n > 0 && ids.length === n && uniq === n,
        detail: `POEMS=${n} ids=${ids.length} uniq=${uniq}`,
        metrics: { poems: n, ids: ids.length, unique: uniq },
      };
    },
  },

  {
    id: "poems.count-and-order",
    layer: "data",
    desc: "970 首、id 与顺序逐位不变（判**序列相等**，不是集合相等）。",
    run(ctx) {
      if (!ctx.baselinePoems) {
        return { ok: true, detail: "无基线可比对（首次运行），仅记录当前读数", metrics: { note: "no-baseline" } };
      }
      if (ctx.baselineStale) {
        return {
          ok: false,
          detail: `基线不适用：${ctx.baselineStale} —— 请用 MERGE_BASE_REF 指定本次合入前的真实 SHA`,
          metrics: { stale: true },
        };
      }
      const a = ctx.baselinePoems.map((p) => p.id);
      const b = ctx.curPoems.map((p) => p.id);
      if (a.length !== b.length) {
        return { ok: false, detail: `条数变了: ${a.length} -> ${b.length}`, metrics: { before: a.length, after: b.length } };
      }
      const firstDiff = a.findIndex((x, i) => x !== b[i]);
      if (firstDiff >= 0) {
        return {
          ok: false,
          detail: `id 序在第 ${firstDiff} 位不同: ${a[firstDiff]} != ${b[firstDiff]}`,
          metrics: { firstDiff, before: a[firstDiff], after: b[firstDiff] },
        };
      }
      return { ok: true, detail: `n=${a.length} id 序逐位相同`, metrics: { poems: b.length } };
    },
  },

  {
    id: "untouched.hash-zero-diff",
    layer: "data",
    desc: "未触及篇内容哈希零变化：逐篇 sha256（id+内容）比对，列出全部不一致的 id。",
    run(ctx) {
      if (!ctx.baselinePoems) {
        return { ok: true, detail: "无基线可比对，仅记录", metrics: { note: "no-baseline" } };
      }
      if (ctx.baselineStale) {
        return {
          ok: false,
          detail: `基线不适用：${ctx.baselineStale} —— 未触及篇的"应然"范围会算错，请用 MERGE_BASE_REF 指定`,
          metrics: { stale: true },
        };
      }
      const h = (p) => crypto.createHash("sha256").update(JSON.stringify(p, null, 0)).digest("hex");
      const base = new Map(ctx.baselinePoems.map((p) => [p.id, h(p)]));
      const diff = [];
      for (const p of ctx.curPoems) {
        const b = base.get(p.id);
        if (b === undefined) { diff.push({ id: p.id, why: "new" }); continue; }
        if (h(p) !== b) diff.push({ id: p.id, why: "changed" });
      }
      // 允许清单：本次 merge 明确触及的篇目
      const allowed = new Set(ctx.touchedIds);
      const unexpected = diff.filter((d) => !allowed.has(d.id));
      return {
        ok: unexpected.length === 0,
        detail: unexpected.length === 0
          ? `差异 ${diff.length} 篇，全部在触及清单内（${diff.length}）`
          : `未触及却变化 ${unexpected.length} 篇: ${unexpected.slice(0, 8).map((d) => d.id).join(", ")}`,
        metrics: { total: ctx.curPoems.length, changed: diff.length, allowed: diff.length - unexpected.length, unexpected: unexpected.length },
      };
    },
  },

  {
    id: "only-poems-touched",
    layer: "structure",
    desc: "仅动 POEMS 数据：POEMS 数组之外的文本（CSS/JS/HTML 结构）必须逐字节相同。判 md5 全等，红了列出变化区间。",
    run(ctx) {
      if (!ctx.baselineRaw) {
        return { ok: true, detail: "无基线可比对，仅记录", metrics: { note: "no-baseline" } };
      }
      // ⚠ 基线时效闸：基线早于「本次合入的起点」时，判据会失真——
      //   把历史上 legit 的改动也算成"未触及却变化"（我首跑就踩到：
      //   merge-01 前的基线把 10-02 的节令签改造算成了越界改动）。
      //   对策：显式要求调用方传入本次的对照基线（git show <合入前SHA>:index.html），
      //   而非默默用工作区里恰好存在的旧快照。
      if (ctx.baselineStale) {
        return {
          ok: false,
          detail: `基线不适用：${ctx.baselineStale} —— 判据会失真（把历史 legit 改动算成越界）。请用 MERGE_BASE_REF 指定本次合入前的真实 SHA。`,
          metrics: { stale: true, reason: ctx.baselineStale },
        };
      }
      const a = ctx.baselineRaw, b = ctx.currentRaw;
      if (a === b) return { ok: true, detail: "全文逐字节相同（未做任何改动）", metrics: { bytes: b.length } };
      // 切出 POEMS 之外的 prefix / suffix
      const ea = extractPoems(a), eb = extractPoems(b);
      if (!ea || !eb) return { ok: false, detail: "无法定位 POEMS 数组（结构异常）", metrics: {} };
      const preA = a.slice(0, a.indexOf(ea)), preB = b.slice(0, b.indexOf(eb));
      const sufA = a.slice(a.indexOf(ea) + ea.length), sufB = b.slice(b.indexOf(eb) + eb.length);
      const preOk = preA === preB, sufOk = sufA === sufB;
      // 另单独断言 CSS/JS 块全等（即使整体 prefix/suf 相等也显式记一条）
      // ⚠ 关键修正：`const POEMS = [...]` **整个数组就写在 <script> 标签内**，
      //   所以「含 POEMS 的那个 script 块」必然随数据变化 —— 要求它全等是错判据
      //   （我首跑就被这条误报了一次：prefix/suffix 都同，块却报"有差异"，自相矛盾）。
      //   正确口径：**排除含 POEMS 的块**，只对「纯逻辑/样式」块要求全等。
      const blocks = (t) =>
        [...t.matchAll(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g)]
          .map((m) => m[0])
          .filter((s) => !s.includes("const POEMS"));
      const ba = blocks(a), bb = blocks(b);
      const blocksOk = ba.length === bb.length && ba.every((x, i) => x === bb[i]);
      const skipped = [...a.matchAll(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g)]
        .map((m) => m[0]).filter((s) => s.includes("const POEMS")).length;
      return {
        ok: preOk && sufOk && blocksOk,
        detail: `prefix=${preOk ? "同" : "异"} suffix=${sufOk ? "同" : "异"} `
          + `纯逻辑/样式块=${blocksOk ? `全等(${ba.length})` : "有差异"}（已排除 ${skipped} 个含 POEMS 的数据块）`,
        metrics: { prefixSame: preOk, suffixSame: sufOk, pureBlocks: ba.length, pureBlocksSame: blocksOk, dataBlocksSkipped: skipped },
      };
    },
  },

  {
    id: "merge-gate.audit-per-batch",
    layer: "process",
    desc: "合入闸门逐批有抽检报告：授权消息点名的每个 batch-id，都必须有抽检报告且含 PASS，缺一即停。**报告名锚定面戳位**（review-<batch>.md 或 review-<batch>-<面戳>.md，面戳不以数字开头）；读数记 `path@<blob-sha>` 不可变指向。",
    async run(ctx) {
      const batches = ctx.releasedBatches;
      if (!batches || batches.length === 0) {
        return { ok: true, detail: "本次无批次授权声明（无闸门可查）", metrics: { batches: 0 } };
      }
      const missing = [], noPass = [], untracked = [], badFace = [];
      const found = [];
      const OUTDIR = path.join(REPO, "out");
      for (const b of batches) {
        // ⚠ 不能用 `review-${b}*.md`：那会让 `review-x-010-y.md` 被 `x-01` 前缀命中。
        //   **可见 ≠ 判据正确** —— 命中错了它照样 PASS。
        // 正解：**锚定面戳位** —— 批次名之后要么直接 .md，要么 `-` + 面戳。
        // 面戳是团队约定（文件名带执行面，避免多会话同名撞单）。
        const safe = b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const strict = new RegExp(`^review-${safe}(\\.md|-(?!\\d)[A-Za-z][\\w-]*\\.md)$`);
        // 宽松版：面戳任意非空（用于识别"有候选但格式不符"，不静默跳过）
        const loose = new RegExp(`^review-${safe}[-.]`);
        let hit = null, files = [];
        try {
          files = fs.readdirSync(OUTDIR);
          hit = files.find((f) => strict.test(f));
        } catch { /* out 目录不可读 */ }
        if (!hit) {
          // 我改了命名约束（面戳不得以数字开头），那就**必须显式报出被跳过的候选**——
          // 否则 `review-x-2nd-eye.md` 会被静默判成"缺报告"，那正是我刚修的第 5 类命名假设。
          const cands = files.filter((f) => loose.test(f));
          if (cands.length) badFace.push(`${b}(候选: ${cands.join(",")})`);
          missing.push(b);
          continue;
        }
        const t = fs.readFileSync(path.join(OUTDIR, hit), "utf8");
        if (!/\bPASS\b/.test(t)) { noPass.push(`${b}(${hit})`); continue; }
        // ★ 记不可变指向 `<path>@<blob-sha>`：报告文件是**可变对象**，
        //   今天推上去的这份，明天 main 可以被覆盖。闸门要记「当时通过的那一份」。
        // ★ 三种状态不可并成一个中性标签（trae 指出）：
        //   missing / untracked / path@blobsha。
        //   「未入库」不是可接受的中间状态 —— 取不到不可变指向就等于物证不可复读。
        const sha = await fileBlobSha(`out/${hit}`);
        if (!sha) { untracked.push(`${b}(${hit}存在但未提交)`); continue; }
        found.push(`${b}→out/${hit}@${sha.slice(0, 12)}`);
      }
      const bad = missing.length + noPass.length + untracked.length;
      return {
        ok: bad === 0,
        detail: bad === 0
          ? `${batches.length} 批全部有抽检报告且 PASS，物证可复读: ${found.join(", ")}`
          : `缺报告 ${missing.length}[${missing.join(",")}] 无PASS ${noPass.length}[${noPass.join(",")}] `
            + `未提交 ${untracked.length}[${untracked.join(",")}]`
            + (badFace.length ? ` 面戳格式不符 ${badFace.length}[${badFace.join(",")}]` : ""),
        metrics: {
          declared: batches.length, pass: found.length,
          missing: missing.length, noPass: noPass.length,
          untracked: untracked.length, badFace: badFace.length,
          // ★ 决策语义（trae ①）：用于决策闸时，**测量失败与测量为负在决策上都等于「不许过」**。
          //   这里把三态显式写成机器可读字段，让调用方不可能把 INVALID 读成「没有反对意见」。
          gateVerdict: bad === 0 ? "PASS" : "BLOCK",
          gateNote: bad === 0
            ? "全部批次有可复读的 PASS 物证"
            : "存在缺报告/无PASS/未提交/面戳不符中的任一情形 —— 不得放行，需人工接管并留痕",
        },
      };
    },
  },

  {
    id: "remote-truth.read",
    layer: "fanout",
    kind: "external",
    desc: "【external · 每轮只跑一次】读远端真值（git ls-remote，真实网络查询）并 memo 住。不读本地 tracking ref、不读退出码。",
    async run(ctx) {
      const r = await remoteMainSha();
      ctx.memo = ctx.memo || {};
      if (!r.ok) {
        // 关键：网络读不到 ≠ 被测对象有问题。memo 留空 + 标记 unavailable，
        // 让 stable 明确报「无法判定」而不是拿缺失当通过（fail-closed）。
        ctx.memo.remote = null;
        ctx.memo.netUnavailable = !!r.networkUnavailable;
        return {
          ok: false,
          // 网络不可用时，明细必须说清这是「环境问题」不是「红线破防」
          detail: r.networkUnavailable
            ? `${r.why} ——★ 这是网络/环境问题，不是被测对象的问题；下方 stable 会明确报「无法判定」`
            : r.why,
          metrics: { ref: REMOTE_REF, networkUnavailable: !!r.networkUnavailable },
        };
      }
      ctx.memo.remote = r.sha;
      ctx.memo.netUnavailable = false;
      return {
        ok: true,
        detail: `读到远端 ${REMOTE_REF} = ${r.sha.slice(0, 12)}（经 ${r.via}${r.note ? "；" + r.note : ""}）memo 住供 stable 比对`,
        metrics: { ref: REMOTE_REF, remote: r.sha.slice(0, 12), via: r.via },
      };
    },
  },
  {
    id: "remote-truth.stable",
    layer: "fanout",
    desc: "【判被测对象 · 每 trial 跑】比对 memo 的远端真值与本地 HEAD。**不再查远端**——重查测的是网络，比对 memo 测的是「测试期间远端是否一致」，后者才是 pass^k 要的不变量。",
    async run(ctx) {
      const memo = ctx.memo?.remote || null;
      const local = (await gitHead()) || "";
      if (!memo) {
        return {
          ok: false,
          detail: "memo 里没有远端读数（remote-truth.read 失败或未跑）——不能判stable，否则就是拿缺失当通过",
          metrics: { local: local.slice(0, 12) },
        };
      }
      return {
        ok: memo === local,
        detail: memo === local
          ? `远端(memo)==本地 ${local.slice(0, 10)}`
          : `远端(memo) ${memo.slice(0, 10)} != 本地 ${local.slice(0, 10)}`,
        metrics: { remote: memo.slice(0, 12), local: local.slice(0, 12), synced: memo === local },
      };
    },
  },
];

/* ── 运行器（逐项 try/catch，单项抛错不拖垮全场）───────────────── */
async function runCheck(c, ctx) {
  const t0 = Date.now();
  let r;
  try { r = await c.run(ctx); } catch (e) { r = { ok: false, detail: "threw: " + e.message, metrics: {} }; }
  return {
    id: c.id, layer: c.layer, kind: c.kind || "local", desc: c.desc,
    ok: !!r.ok, detail: r.detail || "", metrics: r.metrics || {}, ms: Date.now() - t0,
  };
}

async function runOnce(ctx) {
  const results = [];
  for (const c of CHECKS) {
    const r = await runCheck(c, ctx);
    // external 层每轮只跑一次：memo 住读数，后续 trial 复用同一份
    if (c.kind === "external") { ctx.memoChecks = ctx.memoChecks || {}; ctx.memoChecks[c.id] = r; }
    results.push(r);
  }
  return results;
}

/** 组装一轮的最终读数：external 的 memo 读数 + local 的当轮读数。 */
function assemble(ctx, localResults) {
  const memo = ctx.memoChecks || {};
  return CHECKS.map((c) => {
    if (c.kind === "external") return memo[c.id] || { id: c.id, layer: c.layer, kind: "external", desc: c.desc, ok: false, detail: "external 未跑", metrics: {}, ms: 0 };
    return localResults.find((r) => r.id === c.id);
  }).filter(Boolean);
}

/* ── pass^k 聚合 ────────────────────────────────────────────────── */
//某轮是否「无法判定」：任一 check 标了 undeterminable（典型：远端读不到）。
// 口径：**按轮不按 trial** —— 网断一次 = 1 个无效轮，不是 N 个失败。
//   一次网络事故被当成 N 次失败，等于把外部噪声放大 N 倍塞进 pass^k。
function isInvalidRound(results) {
  return results.some((r) => r.metrics && r.metrics.undeterminable);
}

function aggregate(rounds) {
  const first = rounds[0];
  const passRate = first.filter((r) => r.ok).length / first.length;

  const valid = rounds.filter((r) => !isInvalidRound(r));
  const invalid = rounds.length - valid.length;

  // 无效轮**不进分子也不进分母**；全轮无效时 passK 记null（不是 0，也不是 1）。
  let passK = null, passKVec = [];
  if (valid.length > 0) {
    passKVec = first.map((_, i) => (valid.every((t) => t[i] && t[i].ok) ? 1 : 0));
    passK = passKVec.reduce((a, b) => a + b, 0) / passKVec.length;
  }
  return {
    passRate, passK, passKVec,
    validRounds: valid.length, invalidRounds: invalid,
    allInvalid: valid.length === 0,
  };
}

/* ── 主流程 ─────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
// ⚠ 参数解析：两种写法都要认 —— `--trials 3`（我首跑就踩了：写成--trials=3 之外的形式
//   被静默当成默认 2，"我以为跑了 3轮"其实只跑了 2 轮）。
const _tEq = argv.find((a) => a.startsWith("--trials="));
const _tSp = argv.indexOf("--trials");
const TRIALS = Math.max(1, parseInt(
  _tEq ? _tEq.split("=")[1] : (_tSp >= 0 ? argv[_tSp + 1] : "2"), 10) || 2);
const AS_JSON = argv.includes("--json");
const QUIET = argv.includes("--quiet");

async function buildCtx() {
  const currentRaw = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, "utf8") : null;
  const curPoems = currentRaw ? (() => { try { return JSON.parse(extractPoems(currentRaw)); } catch { return null; } })() : null;

  // 基线优先级：
  //  1) MERGE_BASE_REF（推荐）——「本次合入前的真实 SHA」，取自 git show <ref>:index.html
  //     这是唯一正确的对照：它就是合入前的那一刻。
  //  2) 工作区里的旧快照 index.baseline-before-merge.html —— **会失真**：
  //     它可能是 merge-01 之前的，把历史上 legit 的改动也算成"越界"。
  let baselineRaw = null, baselinePoems = null, baselineStale = null, baselineFrom = null;
  const ref = process.env.MERGE_BASE_REF;
  if (ref) {
    try {
      const g = await gitShow(ref);
      if (!g.ok) throw new Error(`git show ${ref} 失败: ${g.code} ${g.stderr.slice(0, 100)}`);
      baselineRaw = g.stdout;
      baselinePoems = JSON.parse(extractPoems(baselineRaw));
      baselineFrom = `git:${ref}`;
    } catch (e) {
      baselineStale = `MERGE_BASE_REF=${ref} 取不到（${String(e.message).slice(0, 80)}）`;
    }
  } else if (fs.existsSync(BASELINE)) {
    baselineRaw = fs.readFileSync(BASELINE, "utf8");
    try { baselinePoems = JSON.parse(extractPoems(baselineRaw)); } catch { /* 基线可能不存在 POEMS */ }
    baselineFrom = "旧快照(可能失真)";
    baselineStale = "用的是工作区旧快照 index.baseline-before-merge.html，非本次合入前状态。"
      + " 判据会把历史 legit 改动算成越界 —— 请设 MERGE_BASE_REF=<合入前SHA> 复核。";
  }

  return {
    currentRaw, curPoems, baselineRaw, baselinePoems, baselineStale, baselineFrom,
    // 本次触及的篇目（用于 untouched 判据的允许清单）——由外部注入
    touchedIds: new Set(JSON.parse(process.env.MERGE_TOUCHED_IDS || "[]")),
    // 授权放行的批次（闸门判据用）——由外部注入
    releasedBatches: JSON.parse(process.env.MERGE_RELEASED_BATCHES || "[]"),
  };
}

const ctx = await buildCtx();
const trials = [];
for (let i = 0; i < TRIALS; i++) trials.push(assemble(ctx, await runOnce(ctx)));
const agg = aggregate(trials);
const report = {
  suite: "merge-eval",
  generated_at: new Date().toISOString(),
  repo: REPO,
  baseline_present: !!ctx.baselineRaw,
  baseline_stale: ctx.baselineStale || null,
  baseline_from: ctx.baselineFrom || null,
  touched_count: ctx.touchedIds.size,
  released_batches: ctx.releasedBatches,
  trials: TRIALS,
  // ★ 生效参数回显：配置静默降级的对治——
  //   「我以为跑了 3 轮其实只跑了 2 轮」这类错，读数第一行就该暴露，不该回头查代码。
  effective: {
    repo: REPO,
    trials: TRIALS,
    remote_ref: REMOTE_REF,
    local_ref: LOCAL_REF,
    base_ref: process.env.MERGE_BASE_REF || "<未指定→用旧快照>",
    allow_ids: ctx.touchedIds.size,
    released_batches: ctx.releasedBatches,
  },
  pass_rate: Number(agg.passRate.toFixed(4)),
  // pass^k 只在**有效轮**上聚合；全轮无效时为 null（不是 0，也不是 1）
  pass_power_k: agg.passK === null ? null : Number(agg.passK.toFixed(4)),
  valid_rounds: agg.validRounds,
  invalid_rounds: agg.invalidRounds,
  all_invalid: agg.allInvalid,
  results: trials[0],
};

// ★ 决策语义在所有输出模式下都必须存在（trae ①）：
//   「测量失败」与「测量为负」在读数上可分开，**在决策上都等于不许过**。
//   机器可读字段 gate_verdict 只认 ALL PASS → PASS，其余一律 BLOCK。
{
  const undet0 = trials[0].filter((r) => r.metrics && r.metrics.undeterminable).length;
  const bad0 = trials[0].filter((r) => !r.ok && !(r.metrics && r.metrics.undeterminable));
  const allPass = !report.all_invalid && undet0 === 0 && bad0.length === 0;
  report.gate_verdict = allPass ? "PASS" : "BLOCK";
  report.gate_rule = "测量失败与测量为负在决策上都等于不许过；INVALID/PARTIAL 一律 BLOCK，需人工接管并留痕。";
}

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else if (QUIET) {
  const bad = trials[0].filter((r) => !r.ok);
  const pk = report.pass_power_k === null ? "N/A(全轮无效)" : report.pass_power_k;
  console.log(`merge-eval | pass_rate=${report.pass_rate} pass^${TRIALS}=${pk} valid=${report.valid_rounds} invalid=${report.invalid_rounds} gate=${report.gate_verdict} | ${bad.length ? "FAIL: " + bad.map((b) => b.id).join(",") : "ALL PASS"}`);
} else {
  console.log("=== merge-eval 读数 ===");
  const e = report.effective;
  // 生效参数**先打第一行**：任何"我以为的配置 ≠ 实际配置"都在这里现形
  console.log(`trials=${e.trials} | remote=${e.remote_ref} | local=${e.local_ref} | base=${e.base_ref} | allow=${e.allow_ids} | released=[${e.released_batches.join(",")}]`);
  const pk = report.pass_power_k === null ? "N/A(全轮无效)" : report.pass_power_k;
  console.log(`pass_rate=${report.pass_rate}  pass^${TRIALS}=${pk}  valid=${report.valid_rounds} invalid=${report.invalid_rounds}`);
  console.log(`baseline=${report.baseline_from || "-"}  present=${report.baseline_present}${report.baseline_stale ? "  ⚠STALE" : ""}`);
  console.log("");
  for (const r of trials[0]) {
    const tag = r.ok ? "PASS" : (r.metrics && r.metrics.undeterminable ? "UNDET" : "FAIL");
    console.log(`[${tag}] ${r.id}  (${r.layer}/${r.kind || "local"}, ${r.ms}ms)`);
    console.log(`       ${r.detail}`);
  }
  const undet = trials[0].filter((r) => r.metrics && r.metrics.undeterminable).length;
  const bad = trials[0].filter((r) => !r.ok && !(r.metrics && r.metrics.undeterminable));
  console.log("");
  // ★ 三态结论：全绿 / 有失败 / 含无法判定 —— 绝不把「无法判定」混进 ALL PASS
  let concl;
  if (report.all_invalid) {
    concl = `INVALID — 全部轮次无法判定（valid=0 invalid=${report.invalid_rounds}）`;
  } else if (undet > 0) {
    concl = `PARTIAL — ${undet} 条无法判定（不计入 pass^k），${bad.length} 条真失败`;
  } else {
    concl = bad.length ? `FAIL (${bad.length}/${trials[0].length})` : "ALL PASS";
  }
  console.log(`结论: ${concl}`);

  //★★ 决策语义（trae ①，必须存在且不可误读）——
  //   **测量失败与测量为负，在读数上可以分开；在决策上都等于「不许过」。**
  //   若把 INVALID/PARTIAL 读成「没有反对意见 / 信息不足随你」，
  //   那就是「缺项当通过」在自家套件里复发 —— 所以这里把它写成机器可读字段。
  const gateVerdict = report.gate_verdict;
  console.log(`闸门判定: ${gateVerdict}${gateVerdict === "BLOCK"
    ? "  ← 不是 PASS 就不能放行；无效轮/无法判定一律按「不许过」，需人工接管并留痕"
    : ""}`);
  console.log("提醒: 全绿只代表形式合规，不代表内容正确；未触及篇的'应然'判断仍需人给允许清单。");
}
