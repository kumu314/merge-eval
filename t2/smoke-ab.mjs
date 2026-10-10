// T2 技能 lift 冒烟 A/B
// 目的：验证「带技能 vs 不带技能」能否被区分出来 —— 只验管线，不追求统计功效。
// 设计：同一批任务跑两臂（control 无技能 / treated 带技能正文），确定性正则判分，不用 LLM 当裁判（不额外花钱）。
// 用法：
//   node smoke-ab.mjs --dry                     # 零调用：用预置答案证明判分管线有判别力
//   $env:T2_BASE_URL=...; $env:T2_API_KEY=...; $env:T2_MODEL=...
//   node smoke-ab.mjs                           # 真跑
import fs from 'node:fs';
import path from 'node:path';

const BASE  = process.env.T2_BASE_URL;
const KEY   = process.env.T2_API_KEY;
const MODEL = process.env.T2_MODEL;
const TRIALS = Number(process.env.T2_TRIALS || 3);
const SKILL_ROOT = process.env.T2_SKILL_ROOT || path.join(import.meta.dirname, 'skills');
// 子集过滤：T2_TASK 逗号分隔任务 id；T2_ARM=control|treated|both（默认 both）
const ONLY_TASK = (process.env.T2_TASK || '').split(',').map((s) => s.trim()).filter(Boolean);
const ONLY_ARM = process.env.T2_ARM || 'both';
const DUMP = process.env.T2_DUMP === '1';
const DRY = process.argv.includes('--dry');

// ---- 任务集：每条任务自带确定性判据（全部命中才算过）----
// 设计原则：判据要落在「技能正文里有、裸模型答不到」的点上，否则两臂会撞天花板。
const TASKS = [
  {
    id: 'bad-advice-runtime',
    skill: 'runtime-resolution-and-abi',
    prompt: [
      '我这台 Windows 机器上，PATH 里有好几个 node。一个老同事给我留了张便条：',
      '',
      '> 「别折腾什么绝对路径，PATH 里那个 node 能跑就行，node 都互相兼容。」',
      '',
      '我要跑一个依赖 better-sqlite3 的命令行工具，他让我直接 `node tool.js` 就行。',
      '请判断：这张便条说的对吗？如果不对，错在哪？我该怎么确定该用哪个 node？',
      '只写你确实知道的；没把握的地方直说不确定，别顺着我的话说。',
    ].join('\n'),
    checks: [
      { name: '否定便条', re: /(不能互换|不可互换|不兼容|不一定兼容|版本[\s\S]{0,12}(不|冲突|不同|对不上)|NODE_MODULE_VERSION|abi|会报错|模块版本)/i },
      { name: '钉死手法', re: /(绝对路径|where\s+node|which\s+node|指定[\s\S]{0,8}node|钉死|pin)/i },
    ],
  },
  // ---- 候选（换掉天花板题用；probe 后再定去留）----
  {
    id: 'merge-verify-ritual',
    skill: 'silent-failure-triage',
    candidate: true,
    prompt: [
      '我在本地仓库用 `gh pr merge 42 --squash` 合并一个 PR。命令跑完退出码是 0，但一个字都没打印。',
      '我想确认到底合没合上，就接着跑了：',
      '',
      '```',
      'gh api repos/me/proj/pulls/42 --jq .state',
      '```',
      '',
      '输出是 `closed`。我印象里合并成功应该显示 `merged`，现在看到 `closed`，反而更不确定了。',
      '请判断：这个 PR 到底合上了没有？我该怎么确定地验证？',
      '只写你确实知道的；没把握的地方直说不确定，别顺着我的话说。',
    ].join('\n'),
    checks: [
      { name: '退出码0无信息', re: /(退出码\s*0[\s\S]{0,40}(不代表|不能说明|不携带|无信息|不可信|什么都没说|什么也说明不了)|成功时[\s\S]{0,12}(静默|不打印|没输出|一个字都不说))/ },
      { name: 'REST口径陷阱', re: /((REST|接口|API)[\s\S]{0,40}(closed|只有\s*open|没有\s*merged|永远不是\s*merged)|state[\s\S]{0,25}(只有|仅)[\s\S]{0,10}(open|closed))/i },
      { name: '正确复核', re: /(merged_at|merge_commit_sha|mergeCommit|MERGED|mergedAt)/i },
    ],
  },
  {
    id: 'guard-never-fires',
    skill: 'silent-failure-triage',
    candidate: true,
    prompt: [
      '我的启动脚本里有段守卫，想防止端口被占用时重复启动第二个实例：',
      '',
      '```',
      'netstat -ano | findstr /r /c:"LISTENING.*:8787"',
      '（命中就 exit）',
      '```',
      '',
      '实际跑起来端口 8787 确实被占着，但守卫没拦住，脚本还是起了第二个实例，',
      '最后 EADDRINUSE 退出了。',
      '请诊断：为什么这段守卫没生效？我该怎么修、怎么确认它真的会响？',
      '只写你确实知道的；没把握的地方直说不确定，别顺着我的话说。',
    ].join('\n'),
    checks: [
      { name: '列序根因', re: /(列序|列的顺序|顺序[\s\S]{0,12}(反|错|不对|颠倒)|状态[\s\S]{0,12}在[\s\S]{0,12}(端口|地址)[\s\S]{0,8}(之后|后面|后)|端口[\s\S]{0,8}在[\s\S]{0,8}状态[\s\S]{0,6}前)/ },
      { name: '恒假死代码', re: /(永远不(会)?(命中|成立|匹配)|恒假|不可能(成立|命中|匹配)|从没(触发|命中|生效)|死代码|形同虚设)/ },
    ],
  },
  {
    id: 'tautology-detector',
    skill: 'criterion-self-evidence-check',
    candidate: true,
    prompt: [
      '我写了个检测器，用来判断一批「记忆卡」是不是量产的模板：',
      '规则是——只要卡片文本里出现「每天慢读三遍」这句话，就判定它是模板。',
      '我拿一批卡跑了一遍，命中 40 条，看起来效果挺好，误伤也不多。',
      '',
      '请评审：这个检测器可靠吗？如果不可靠，问题在哪、我该怎么改？',
      '只写你确实知道的；没把握的地方直说不确定，别顺着我的话说。',
    ].join('\n'),
    checks: [
      { name: '硬编码脆弱', re: /(硬编码|写死|固定串|同义反复|自我满足|自证|循环|和生成器赛跑|赛跑|改一个字|改一个词)/i },
      { name: '换统计量', re: /(跨样本|跨篇|重复度|归一化|抹平|频次|不依赖措辞|统计量|统计方法)/i },
    ],
  },
];

// ---- 两臂的系统提示 ----
function systemFor(arm, skillName, skillText) {
  const base = '你是一个严谨的技术助手，回答用中文。';
  if (arm === 'control') return base;
  return base + '\n\n下面是你可用的技能，请遵循其中的检查项：\n\n<skill name="' + skillName + '">\n' + skillText + '\n</skill>';
}

const _skillCache = new Map();
function loadSkill(name) {
  if (_skillCache.has(name)) return _skillCache.get(name);
  const p = path.join(SKILL_ROOT, name, 'SKILL.md');
  if (!fs.existsSync(p)) throw new Error('技能不存在: ' + p);
  const t = fs.readFileSync(p, 'utf8');
  _skillCache.set(name, t);
  return t;
}

function score(answer, task) {
  const hits = task.checks.filter((c) => c.re.test(answer)).map((c) => c.name);
  return { passed: hits.length === task.checks.length, hits, total: task.checks.length };
}

async function askOnce(system, user) {
  // 上游会挂住不返回（实测 >150s 无响应），必须自带超时，否则整轮挂死
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  let r;
  try {
    r = await fetch(BASE.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({
        model: MODEL,
        messages: [ { role: 'system', content: system }, { role: 'user', content: user } ],
        temperature: 0,
      }),
      signal: ctl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('timeout：60s 无响应（上游挂住）');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const raw = await r.text();
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + raw.slice(0, 500));
  let j;
  try { j = JSON.parse(raw); } catch { throw new Error('非 JSON 响应: ' + raw.slice(0, 300)); }
  const msg = j.choices?.[0]?.message;
  const content = msg?.content;
  if (typeof content !== 'string' || content.length === 0) {
    // 模型可能返回工具调用而非文本（技能正文诱导"先去执行"）——这是可记录的现象，不是可重试的抖动
    const tc = msg?.tool_calls;
    if (Array.isArray(tc) && tc.length) {
      const e = new Error('TOOLCALL：返回工具调用而非文本（' + tc.map((x) => x.function?.name).join(',') + '）');
      e.toolCall = true;
      throw e;
    }
    // 空答案一律当错误抛出：静默返回 '' 会把「调用失败」伪装成「技能没用」
    throw new Error('空 content；finish_reason=' + j.choices?.[0]?.finish_reason +
      '；raw=' + JSON.stringify(j).slice(0, 600));
  }
  return content;
}

// 免费档上游常 503/限流 —— 瞬时错误退避重试，重试耗尽才当失败
async function ask(system, user, attempt = 1) {
  try {
    return await askOnce(system, user);
  } catch (e) {
    if (e.toolCall) throw e; // 工具调用不是抖动，重试无用
    const transient = /503|overloaded|429|rate|timeout|ECONN|fetch failed|ETIMEDOUT/i.test(e.message);
    if (transient && attempt <= 4) {
      const wait = 2000 * attempt;
      console.error(`  (transient: ${e.message.slice(0, 70)} — ${wait}ms 后重试 ${attempt}/4)`);
      await new Promise((res) => setTimeout(res, wait));
      return ask(system, user, attempt + 1);
    }
    throw e;
  }
}

// ---- dry 模式：每条任务预置两段答案，坏的一臂只答表象、好的一臂答到全部判据 ----
const DRY_ANSWERS = {
  'bad-advice-runtime': {
    control: '便条说得对，PATH 里的 node 能跑就行，node 各版本基本互相兼容，直接 `node tool.js` 没问题。',
    treated: '这张便条不对。node 之间并不兼容：原生模块按 NODE_MODULE_VERSION 编译，装了 better-sqlite3 的机器如果 node 大版本不同，加载时会报模块版本对不上（NODE_MODULE_VERSION mismatch）。别只靠 PATH 里第一个 node，用 `where node` 看清有哪些，再用绝对路径钉死你要的那个 node。',
  },
  'merge-verify-ritual': {
    control: '退出码 0 说明合并命令执行成功了，但 `closed` 表示 PR 只是被关闭了、并没有合并。建议改用 `--merge` 参数重试一次。',
    treated: '退出码 0 不代表合并成功——`gh pr merge` 成功时本来就不打印任何东西，退出码 0 不携带信息。你看到的 `closed` 是 REST 接口的口径陷阱：REST 的 state 只有 open / closed 两个值，永远不会是 merged，所以拿它去比 merged 是恒假判据。要确定就查 merged_at 与 merge_commit_sha（或 GraphQL 的 state=MERGED），并看 base 分支有没有真前进。',
  },
  'guard-never-fires': {
    control: '守卫没生效应该是 findstr 的正则转义写错了，或者 netstat 的输出被别的行干扰了。建议改用 PowerShell 的 Get-NetTCPConnection 来查端口。',
    treated: '根因是列序理解反了：netstat 的列是「本地地址:端口 … 远端地址 状态」，状态在端口之后，所以 `LISTENING.*:8787` 这个先后顺序永远不可能成立——守卫条件恒假，是死代码，从不触发。修法是改用不依赖顺序和本地化词的判据（本地端口 + 远端 0.0.0.0:0），并且拿一个必然命中的输入和一个必然不命中的输入正反两侧各验一次。',
  },
  'tautology-detector': {
    control: '检测器基本可用，命中 40 条说明规则有效。建议把匹配串做成配置项方便维护。',
    treated: '不可靠。这是硬编码串检测，等于和生成器赛跑：生成器改一个字（慢读→读）就失效，而且不会报错，你只会看到命中数变少。要改就换成不依赖措辞的统计量，比如抹平专有名词后统计跨样本重复度。',
  },
};

async function run() {
  const activeTasks = ONLY_TASK.length ? TASKS.filter((t) => ONLY_TASK.includes(t.id)) : TASKS;
  const arms = ONLY_ARM === 'both' ? ['control', 'treated'] : [ONLY_ARM];
  const rows = [];
  for (const task of activeTasks) {
    const skillText = DRY ? '(dry-run 不读技能正文)' : loadSkill(task.skill);
    for (const arm of arms) {
      for (let t = 1; t <= TRIALS; t++) {
        let ans, err = null;
        if (DRY) ans = DRY_ANSWERS[task.id][arm];
        else {
          try { ans = await ask(systemFor(arm, task.skill, skillText), task.prompt); }
          catch (e) { err = e; }
        }
        if (err) {
          const kind = err.toolCall ? 'TOOLCALL' : 'ERROR';
          if (DUMP) console.log('\n===== ' + task.id + ' / ' + arm + ' / t' + t + ' ===== [' + kind + '] ' + err.message.slice(0, 120) + '\n');
          rows.push({ task: task.id, arm, trial: t, passed: false, hits: [], chars: 0, err: kind, msg: err.message.slice(0, 90) });
          continue;
        }
        const s = score(ans, task);
        if (DUMP) console.log('\n===== ' + task.id + ' / ' + arm + ' / t' + t + ' =====\n' + ans + '\n');
        rows.push({ task: task.id, arm, trial: t, passed: s.passed, hits: s.hits, chars: ans.length });
      }
    }
  }
  // 汇总：有效率只算"拿到了文本答案"的调用；工具调用/报错单列，不混进通过率
  const by = (arm) => rows.filter((r) => r.arm === arm);
  const valid = (arm) => by(arm).filter((r) => !r.err);
  const rate = (arm) => { const a = valid(arm); return a.length ? a.filter((r) => r.passed).length / a.length : 0; };
  console.log('provider = ' + (DRY ? 'DRY (零调用)' : `${MODEL} @ ${BASE}`));
  console.log('tasks    = ' + activeTasks.map((t) => t.id + '(' + t.skill + ')').join(', ') + '   trials/arm = ' + TRIALS + '   arms = ' + arms.join('+'));
  console.log('-'.repeat(72));
  for (const r of rows) {
    const status = r.err ? r.err : (r.passed ? 'PASS' : 'FAIL');
    console.log(`[${r.arm.padEnd(7)}] ${r.task.padEnd(18)} t${r.trial}  ${status.padEnd(8)}  ${r.hits.join(',') || (r.err ? r.msg : '(无命中)')}  ${r.chars}c`);
  }
  console.log('-'.repeat(72));
  for (const arm of arms) {
    const e = by(arm).filter((r) => r.err);
    const tc = e.filter((r) => r.err === 'TOOLCALL').length;
    const er = e.filter((r) => r.err === 'ERROR').length;
    const a = valid(arm);
    console.log(`${arm.padEnd(7)} 有效 ${a.length}/${by(arm).length}（通过 ${a.filter((r) => r.passed).length}）  工具调用 ${tc}  报错 ${er}`);
  }
  const c = rate('control'), t = rate('treated');
  console.log(`control pass = ${(c * 100).toFixed(0)}%    treated pass = ${(t * 100).toFixed(0)}%    lift = ${((t - c) * 100).toFixed(0)} 个百分点`);
  const anyErr = rows.some((r) => r.err);
  console.log(t - c > 0
    ? '=> 两臂可区分（管线有判别力）'
    : (DRY ? '=> dry 两臂不可区分：判据或预置答案有问题，先修'
      : (anyErr ? '=> 两臂未拉开（本轮存在工具调用/报错，读数不完整，先看上方分布）' : '=> 本任务上两臂未拉开：换更贴技能的任务，或加 trial')));
  return { c, t };
}

run().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });