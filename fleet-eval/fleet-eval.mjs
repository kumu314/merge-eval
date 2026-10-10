#!/usr/bin/env node
// fleet-eval.mjs — 本机 agent 资产舰队的确定性回归评测套件（T1 层，零 API 成本）。
//
// 设计遵循 2026-10-06 检索到的共识（Anthropic《Demystifying evals for AI agents》/ NVIDIA）：
//   * task   = 下面 CHECKS 里的每一项
//   * trial  = 跑一次套件（--trials N 可重复跑，用于演示 pass^k）
//   * grader = 确定性断言（fileExists / countAtLeast / equals / regex），能确定性就确定性
//   * outcome= 磁盘真实状态，**不是**技能自己声称的状态
//   * pass^k = N 次里**每次都**过的比例（面向"必须稳定"的资产库，而不是"蒙对一次就行"）
//
// 本套件定位为 regression eval（通过率应接近 100%，掉了就是坏了），
// 不是 capability eval（那种起步就该低分）。
//
// 用法：
//   node fleet-eval.mjs                 # 跑 1 轮
//   node fleet-eval.mjs --trials 3      # 跑 3 轮，报 pass^k
//   node fleet-eval.mjs --json          # 只输出 JSON
//   node fleet-eval.mjs --quiet         # 只输出汇总行
//   node fleet-eval.mjs --only scan.sanity --only junk.absent   # 只跑指定 task（drill 用）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '..', 'out');

const SHARED = process.env.FLEET_SHARED || 'D:\\AgentHub\\sharedskills';
const SRC = path.join(SHARED, 'skills');
const SYNC_PS1 = path.join(SHARED, 'sync.ps1');
const RECONCILE = path.join(SHARED, 'scripts', 'skills-reconcile.py');
const ANYSEARCH_PY = path.join(SHARED, 'skills', 'anysearch', 'scripts', 'anysearch.py');
const SELF = fileURLToPath(import.meta.url);

const PY_CANDIDATES = ['D:\\Mysoftware\\python.exe', 'python'];

function pickPython() {
  for (const p of PY_CANDIDATES) {
    if (p === 'python') return p;
    try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
  }
  return 'python';
}

// ── 读真相源：端点名单与 $hideFrom 一律现读 sync.ps1，绝不抄第二份 ──────────────
// PowerShell 的 `#` 注释必须先在行级剥掉，否则会读进被注释掉的旧端点
// （作者的 sync.ps1 里就留着一行被注释掉的旧端点 —— 已移出名单）。
// 实测踩过：不剥注释会凭空多出一端 codex/skills，240 条全报 ABSENT，纯假绿/假红。
const stripPsComments = (s) => s.split(/\r?\n/).map((l) => { const i = l.indexOf('#'); return i < 0 ? l : l.slice(0, i); }).join('\n');

function readSyncPs1() {
  const code = stripPsComments(fs.readFileSync(SYNC_PS1, 'utf8'));
  const targets = [];
  const tb = code.match(/\$targets\s*=\s*@\(([\s\S]*?)\n\)/);
  if (tb) for (const m of tb[1].matchAll(/'([^']+)'/g)) targets.push(m[1]);

  const hide = new Map();
  const hb = code.match(/\$hideFrom\s*=\s*@\{([\s\S]*?)\n\}/);
  if (hb) {
    const km = /'([^']+)'\s*=\s*@\(([\s\S]*?)\)/g;
    for (const m of hb[1].matchAll(km)) {
      hide.set(m[1], [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]));
    }
  }
  return { targets, hide };
}

const isHidden = (hide, target, skill) =>
  (hide.get(target) || []).some((p) => skill.startsWith(p));

// ── 极简 frontmatter 解析：顶层 key: value，支持 >- / | 块标量 ──────────────────
function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end < 0) return null;
  const body = lines.slice(1, end);
  const out = {};
  for (let i = 0; i < body.length; i++) {
    const m = body[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val === '' || val === '>-' || val === '>' || val === '|' || val === '|-' || val === '>-') {
      const buf = [];
      while (i + 1 < body.length && /^\s+\S/.test(body[i + 1])) { buf.push(body[++i].trim()); }
      val = buf.join(' ').trim();
    }
    out[key] = val.replace(/^["']|["']$/g, '');
  }
  return out;
}

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

function listSkillDirs(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

// A2 自审用的网络访问黑名单：出现在任一 task 体内即判该 task 非"确定性、离线"。
// 回归套件必须能离线重跑、结果只取决于磁盘状态，所以这条是硬契约。
// 字面量刻意放在 CHECKS 之外——否则 A2 扫到自己正文里的这些字符串会自证其罪（self-red）。
const FORBIDDEN_NET = ['fetch(', 'XMLHttpRequest', 'axios',
  "require('http", 'require("http', "require('https", 'require("https',
  "from 'node:http", 'from "node:http', "from 'node:https", 'from "node:https',
  'http.get(', 'https.get('];
const NET_URL_RE = /https?:\/\//;

// ── task 定义：每项返回 { id, layer, desc, ok, detail, metrics } ───────────────
const CHECKS = [
  {
    id: 'scan.sanity',
    layer: 'harness',
    desc: '扫描本身是活的：源目录存在且非空（防"0 条通过"假绿）',
    run({ skillDirs }) {
      const ok = skillDirs.length > 0;
      return { ok, detail: `source=${SRC}`, metrics: { skills: skillDirs.length } };
    },
  },
  {
    id: 'frontmatter.valid',
    layer: 'structure',
    desc: '每个 SKILL.md 都能解析出非空的 name 与 description（description 是路由唯一依据）',
    run({ skillDirs }) {
      const bad = [];
      let parsed = 0;
      for (const s of skillDirs) {
        const f = path.join(SRC, s, 'SKILL.md');
        if (!fs.existsSync(f)) { bad.push(`${s}: 缺 SKILL.md`); continue; }
        const fm = parseFrontmatter(fs.readFileSync(f, 'utf8'));
        if (!fm) { bad.push(`${s}: 无 frontmatter`); continue; }
        if (!fm.name) bad.push(`${s}: name 空`);
        if (!fm.description) bad.push(`${s}: description 空`);
        parsed++;
      }
      return {
        ok: bad.length === 0,
        detail: bad.length ? bad.slice(0, 12).join(' | ') + (bad.length > 12 ? ` …共${bad.length}` : '') : 'all ok',
        metrics: { parsed, bad: bad.length },
      };
    },
  },
  {
    id: 'frontmatter.name-matches-dir',
    layer: 'structure',
    desc: 'frontmatter 的 name 与目录名一致（防止改了名字却没改目录，导致引用悬空）',
    run({ skillDirs }) {
      const bad = [];
      for (const s of skillDirs) {
        const f = path.join(SRC, s, 'SKILL.md');
        if (!fs.existsSync(f)) continue;
        const fm = parseFrontmatter(fs.readFileSync(f, 'utf8'));
        if (fm?.name && fm.name !== s) bad.push(`${s} != ${fm.name}`);
      }
      return { ok: bad.length === 0, detail: bad.length ? bad.join(' | ') : 'all ok', metrics: { mismatch: bad.length } };
    },
  },
  {
    id: 'frontmatter.name-unique',
    layer: 'routing',
    desc: 'frontmatter 的 name 在源树内唯一（重名会让技能选择退化成随机）',
    run({ skillDirs }) {
      const seen = new Map(); const dup = [];
      for (const s of skillDirs) {
        const f = path.join(SRC, s, 'SKILL.md');
        if (!fs.existsSync(f)) continue;
        const fm = parseFrontmatter(fs.readFileSync(f, 'utf8'));
        if (!fm?.name) continue;
        if (seen.has(fm.name)) dup.push(`${fm.name} (${seen.get(fm.name)}, ${s})`);
        else seen.set(fm.name, s);
      }
      return { ok: dup.length === 0, detail: dup.length ? dup.join(' | ') : 'all unique', metrics: { dup: dup.length } };
    },
  },
  {
    id: 'junk.absent',
    layer: 'hygiene',
    desc: '源树内无 .git / node_modules / __pycache__ / *.bak*（sync.ps1 的排除表，扇出会带回端点；music-composition/.git 为已登记豁免，计入 metrics.allowed）',
    run({ skillDirs }) {
      const excl = new Set(['.git', 'node_modules', '__pycache__']);
      // 精确路径豁免（不按名字放过，别的技能下再出现 .git 仍算垃圾）：
      // music-composition/.git 是刻意保留的上游克隆件 —— archive/junk-fanout-2026-10-02/MANIFEST.md
      // 记「只从扇出里排除，不动源」，内含本机提交 9ddcb4f，禁止 push / 碰 origin。
      const ALLOW = new Set(['music-composition/.git']);
      const hits = [];
      const allowed = [];
      for (const s of skillDirs) {
        const base = path.join(SRC, s);
        const walk = (dir, rel) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            const key = `${s}/${r}`;
            if (e.isDirectory()) {
              if (excl.has(e.name)) { (ALLOW.has(key) ? allowed : hits).push(key); }
              else walk(path.join(dir, e.name), r);
            } else if (/\.bak/i.test(e.name)) hits.push(key);
          }
        };
        walk(base, '');
      }
      return {
        ok: hits.length === 0,
        // 命中多时不再截掉尾部（此前 slice(0,10) 会把第 11 项藏起来，读数对不上明细）
        detail: hits.length ? hits.slice(0, 12).join(' | ') + (hits.length > 12 ? ` …共${hits.length}` : '') : 'clean',
        metrics: { junk: hits.length, allowed: allowed.length },
      };
    },
  },
  {
    id: 'endpoints.present',
    layer: 'fanout',
    desc: 'sync.ps1 里声明的每个端点目录都真实存在',
    run({ targets }) {
      const missing = targets.filter((t) => { try { return !fs.statSync(t).isDirectory(); } catch { return true; } });
      return { ok: missing.length === 0, detail: missing.length ? missing.join(' | ') : `${targets.length} ok`, metrics: { targets: targets.length, missing: missing.length } };
    },
  },
  {
    id: 'endpoints.match-authority',
    layer: 'fanout',
    desc: '本套件现读 sync.ps1 得到的端点名单 == 权威对账脚本 skills-reconcile.py --targets 的输出（防"自建解析器悄悄漂移"）',
    run({ targets }) {
      let out = '';
      try { out = execFileSync(pickPython(), [RECONCILE, '--targets'], { encoding: 'utf8', timeout: 60000 }); }
      catch (e) { out = (e.stdout || ''); }
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const authority = lines.slice(1); // 第 1 行是源
      const a = [...authority].sort().join('|');
      const b = [...targets].sort().join('|');
      return {
        ok: a === b && authority.length > 0,
        detail: a === b ? `both = ${targets.length} 端` : `suite=[${targets.join(', ')}] vs authority=[${authority.join(', ')}]`,
        metrics: { suite: targets.length, authority: authority.length },
      };
    },
  },
  {
    id: 'endpoints.skillmd-parity',
    layer: 'fanout',
    desc: '每端每颗技能的 SKILL.md md5 == 源（尊重 $hideFrom；这是路由最关键的那个文件）',
    run({ skillDirs, targets, hide }) {
      let checked = 0; const diff = []; const absent = [];
      for (const s of skillDirs) {
        const sf = path.join(SRC, s, 'SKILL.md');
        if (!fs.existsSync(sf)) continue;
        const dig = md5(sf);
        for (const t of targets) {
          if (isHidden(hide, t, s)) continue;
          const tf = path.join(t, s, 'SKILL.md');
          if (!fs.existsSync(tf)) { absent.push(`${path.basename(path.dirname(t))}/${s}`); continue; }
          checked++;
          if (md5(tf) !== dig) diff.push(`${path.basename(path.dirname(t))}/${s}`);
        }
      }
      return {
        ok: diff.length === 0 && absent.length === 0,
        detail: [diff.length ? `DIFF=${diff.length} (${diff.slice(0, 5).join(',')})` : 'diff 0',
                 absent.length ? `ABSENT=${absent.length} (${absent.slice(0, 5).join(',')})` : 'absent 0'].join(' | '),
        metrics: { checked, diff: diff.length, absent: absent.length },
      };
    },
  },
  {
    id: 'reconcile.drift-zero',
    layer: 'fanout',
    desc: '全库对账（skills-reconcile.py）读数为 0 漂移、0 不可读；**不读退出码**（该脚本恒退 0）',
    run() {
      let out; let timedOut = false;
      try {
        // 600s：本机 I/O 拥挤时这个只读对账实测会从 8s 涨到 40s+（2026-10-09 曾把 300s 撑爆）。
        // 它是只读的、结果只取决于磁盘，慢≠坏，所以给足余量，别让机器一忙就假红。
        out = execFileSync(pickPython(), [RECONCILE, '--quiet'], { encoding: 'utf8', timeout: 600000 });
      } catch (e) {
        timedOut = e.signal != null || e.code === 'ETIMEDOUT';
        out = String(e.stdout || '') + String(e.stderr || '');
      }
      const line = out.split(/\r?\n/).filter((l) => l.includes('reconcile: source')).pop() || '';
      const num = (k) => { const m = line.match(new RegExp(`${k}\\s+(\\d+)`)); return m ? Number(m[1]) : null; };
      const nskills = num('source'), diff = num('differing'), unread = num('unreadable');
      const aborted = /ABORTED/.test(line) || nskills === null;
      const ok = !aborted && diff === 0 && unread === 0;
      return {
        ok,
        detail: line.trim() || (timedOut ? 'reconcile 超时 600s —— 机器 I/O 拥挤时的假红，不是漂移' : 'no summary line (scan aborted?)'),
        metrics: { skills: nskills, differing: diff, unreadable: unread, aborted, timedOut },
      };
    },
  },
  {
    id: 'anysearch.encoding-verdict',
    layer: 'tooling',
    desc: 'anysearch.py 的 UTF-8 守卫是真的：PYTHONIOENCODING=gbk 下打印 ²/✓ 不崩（含对照臂，防"探针本身失效"造成假绿）',
    run() {
      const py = pickPython();
      if (!fs.existsSync(ANYSEARCH_PY)) {
        return { ok: false, detail: `anysearch.py 不存在: ${ANYSEARCH_PY}`, metrics: { guardRc: null, controlRc: null } };
      }
      const dir = path.dirname(ANYSEARCH_PY);
      // 探针源码里用 \u 转义写死字符，保证 argv 全程纯 ASCII（Windows 传参不踩编码坑）。
      const withGuard = [
        'import sys',
        `sys.path.insert(0, r'${dir}')`,
        'import anysearch', // 只为触发模块级 reconfigure(utf-8)；不调用 rpc，故不联网
        "sys.stdout.write('tau=\\u03c4 sup2=\\u00b2 check=\\u2713\\n')",
      ].join('\n');
      const control = [
        'import sys',
        "sys.stdout.write('tau=\\u03c4 sup2=\\u00b2 check=\\u2713\\n')",
      ].join('\n');
      const runProbe = (code) => {
        try {
          const out = execFileSync(py, ['-c', code], {
            env: { ...process.env, PYTHONIOENCODING: 'gbk' }, encoding: 'utf8', timeout: 30000,
            stdio: ['ignore', 'pipe', 'pipe'], // stderr 必须被捕获而非继承，否则对照臂的 traceback 会灌进日志
          });
          return { rc: 0, out };
        } catch (e) {
          return { rc: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
        }
      };
      const a = runProbe(withGuard);
      const b = runProbe(control);
      const guardWorks = a.rc === 0 && /check=/.test(a.out);
      const controlBreaks = b.rc !== 0; // 对照臂必须复现缺陷，否则探针没有判别力
      const lastLine = (s) => String(s).split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
      return {
        ok: guardWorks && controlBreaks,
        detail: guardWorks && controlBreaks
          ? '守卫臂通过 + 对照臂如期报错（探针有判别力）'
          : [
            guardWorks ? '守卫臂 ok' : `守卫臂失败 rc=${a.rc}: ${lastLine(a.out)}`,
            controlBreaks ? '对照臂如期报错' : '对照臂竟然通过 —— 本环境已不复现 GBK 缺陷，此检查当前无判别力',
          ].join(' | '),
        metrics: { guardRc: a.rc, controlRc: b.rc },
      };
    },
  },
  {
    id: 'suite.determinism-contract',
    layer: 'suite',
    desc: '套件自审：注册表良构 + 源内 id 与注册表一一对应 + 任一 task 体内无网络访问',
    run() {
      const problems = [];
      const ids = CHECKS.map((c) => c.id);
      const seen = new Set();
      for (const c of CHECKS) {
        if (typeof c.id !== 'string' || !c.id) problems.push('存在无 id 的 task');
        else if (seen.has(c.id)) problems.push(`id 重复: ${c.id}`);
        else seen.add(c.id);
        if (typeof c.layer !== 'string' || !c.layer) problems.push(`${c.id}: layer 空`);
        if (typeof c.desc !== 'string' || !c.desc) problems.push(`${c.id}: desc 空`);
        if (typeof c.run !== 'function') problems.push(`${c.id}: run 不是函数`);
      }
      // 只剥「整行注释」（行首 //），不碰行内 //——否则会把代码里 'https://…' 字符串拦腰截断成假阴性。
      const src = fs.readFileSync(SELF, 'utf8');
      const noLineComments = src.split(/\r?\n/).map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n');
      const hits = [...noLineComments.matchAll(/^\s+id:\s*'([^']+)',\s*$/gm)];
      const srcIds = hits.map((m) => m[1]);
      const missingInSrc = ids.filter((x) => !srcIds.includes(x));
      const extraInSrc = srcIds.filter((x) => !ids.includes(x));
      if (missingInSrc.length) problems.push(`注册表有、源里找不到: ${missingInSrc.join(',')}`);
      if (extraInSrc.length) problems.push(`源里有、注册表没有: ${extraInSrc.join(',')}`);
      // 逐 task 取源切片（本 task 到下一个 id 之间，最后一项到 CHECKS 的 '];' 之前），扫网络访问
      const netHits = [];
      for (let i = 0; i < hits.length; i++) {
        const id = hits[i][1];
        const start = hits[i].index;
        const end = i + 1 < hits.length ? hits[i + 1].index : noLineComments.indexOf('\n];', start);
        const body = noLineComments.slice(start, end > start ? end : undefined);
        for (const tok of FORBIDDEN_NET) if (body.includes(tok)) netHits.push(`${id}→${tok}`);
        if (NET_URL_RE.test(body)) netHits.push(`${id}→<url>`);
      }
      if (netHits.length) problems.push(`task 体内出现网络访问: ${netHits.join(', ')}`);
      return {
        ok: problems.length === 0,
        detail: problems.length ? problems.slice(0, 6).join(' | ') : `registry=${ids.length} 项，源/注册表一致，无网络访问`,
        metrics: { registered: ids.length, idsInSource: srcIds.length, netViolations: netHits.length },
      };
    },
  },
];

// ── 运行器 ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { trials: 1, json: false, quiet: false, only: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--trials') a.trials = Math.max(1, Number(argv[++i]) || 1);
    else if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--quiet') a.quiet = true;
    else if (argv[i] === '--only') a.only.push(argv[++i]);
  }
  return a;
}

function buildContext() {
  const { targets, hide } = readSyncPs1();
  return { skillDirs: listSkillDirs(SRC), targets, hide };
}

function runOnce(ctx, checks = CHECKS) {
  const results = [];
  for (const c of checks) {
    const t0 = Date.now();
    let r;
    try { r = c.run(ctx); } catch (e) { r = { ok: false, detail: `threw: ${e.message}`, metrics: {} }; }
    results.push({ id: c.id, layer: c.layer, desc: c.desc, ok: !!r.ok, detail: r.detail, metrics: r.metrics || {}, ms: Date.now() - t0 });
  }
  return results;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ctx = buildContext();
  const unknown = args.only.filter((id) => !CHECKS.some((c) => c.id === id));
  if (unknown.length) { console.error(`unknown --only id: ${unknown.join(', ')}`); process.exit(2); }
  const selected = args.only.length ? CHECKS.filter((c) => args.only.includes(c.id)) : CHECKS;
  const trials = [];
  for (let k = 0; k < args.trials; k++) trials.push(runOnce(ctx, selected));

  const first = trials[0];
  const passRate = first.filter((r) => r.ok).length / first.length;
  const passK = trials[0].map((_, i) => trials.every((t) => t[i].ok) ? 1 : 0);
  const passHatK = passK.reduce((a, b) => a + b, 0) / passK.length;

  const report = {
    suite: 'fleet-eval',
    generated_at: new Date().toISOString(),
    source: SRC,
    endpoints: ctx.targets,
    trials: args.trials,
    skills_scanned: ctx.skillDirs.length,
    pass_rate: passRate,
    pass_power_k: passHatK,
    results: first,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    if (!args.quiet) {
      console.log('fleet-eval — 本机 agent 资产舰队回归套件 (source: %s, %d skills, %d endpoints)',
        SRC, ctx.skillDirs.length, ctx.targets.length);
      console.log('-'.repeat(78));
      for (const r of first) {
        console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.id.padEnd(30)} ${JSON.stringify(r.metrics)} (${r.ms}ms)`);
        if (!r.ok) console.log(`       ↳ ${r.detail}`);
      }
      console.log('-'.repeat(78));
    }
    console.log(`pass_rate = ${(passRate * 100).toFixed(1)}%  (${first.filter((r) => r.ok).length}/${first.length})` +
      (args.trials > 1 ? `  |  pass^${args.trials} = ${(passHatK * 100).toFixed(1)}%` : ''));
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(OUT_DIR, `fleet-eval-${stamp}.json`), JSON.stringify(report, null, 2), 'utf8');

  process.exit(first.every((r) => r.ok) ? 0 : 1);
}

main();