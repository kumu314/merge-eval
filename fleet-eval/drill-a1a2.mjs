#!/usr/bin/env node
// drill-a1a2.mjs — 证明 fleet-eval 新增的 A1/A2 两条检查「真的会红」。
//
// 思路：不碰任何活文件，而是把被测对象复制到临时目录、注入一个**真实的缺陷**，
// 再用**真实的套件代码**（--only 指定那一条）跑一遍，断言它翻成 FAIL，最后清理。
//
//   A1 注入：删掉 anysearch.py 的 UTF-8 守卫        → 期望 anysearch.encoding-verdict  FAIL
//   A2 注入：往 scan.sanity 体内塞一行 fetch(...)   → 期望 suite.determinism-contract  FAIL
//
// 退出码：0 = 两条都如期翻红；1 = 有 drill 未按预期工作（说明检查是假绿）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = path.join(HERE, 'fleet-eval.mjs');
const ANYSEARCH = process.env.FLEET_ANYSEARCH || 'D:\\AgentHub\\sharedskills\\skills\\anysearch\\scripts\\anysearch.py';
const NODE = process.execPath;
const TMP = path.join(os.tmpdir(), `fleet-drill-${Date.now()}`);

const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const before = { suite: md5(SUITE), anysearch: md5(ANYSEARCH) };

const drills = [];
const record = (name, ok, detail) => {
  drills.push({ name, ok });
  console.log(`[${ok ? 'DRILL-PASS' : 'DRILL-FAIL'}] ${name}\n              ${detail}`);
};

// 把套件源码复制一份到临时目录，并把 OUT_DIR 重定向进临时区（避免污染真实 out/）。
// extraPatch 可选，用来再改一处（A1 用）。
function makeDrillSuite(destName, extraPatch) {
  const src = fs.readFileSync(SUITE, 'utf8');
  let out = src.replace(
    /const OUT_DIR = path\.resolve\(HERE, '\.\.', 'out'\);/,
    `const OUT_DIR = path.resolve(String.raw\`${TMP}\`, 'out');`,
  );
  if (out === src) throw new Error('OUT_DIR 替换未命中');
  if (extraPatch) {
    const after = extraPatch(out);
    if (after === out) throw new Error('extraPatch 替换未命中');
    out = after;
  }
  const dest = path.join(TMP, destName);
  fs.writeFileSync(dest, out, 'utf8');
  return dest;
}

// --only 只跑一条时，该条若 FAIL 套件会退 1；execFileSync 抛错，故从 e.stdout 取 JSON。
function runSuiteJson(suitePath, onlyId) {
  try {
    const out = execFileSync(NODE, [suitePath, '--only', onlyId, '--json'],
      { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out);
  } catch (e) {
    const out = String(e.stdout || '');
    if (out.trim().startsWith('{')) return JSON.parse(out);
    throw e;
  }
}

function main() {
  fs.mkdirSync(TMP, { recursive: true });

  // ── A1：复制 anysearch.py 到临时目录并删掉 UTF-8 守卫 ──────────────────────
  const guardless = path.join(TMP, 'anysearch.py');
  const asrc = fs.readFileSync(ANYSEARCH, 'utf8');
  const guardBlock = /if hasattr\(sys\.stdout, "reconfigure"\):[\s\S]*?sys\.stderr\.reconfigure\(encoding="utf-8"\)\n/;
  if (!guardBlock.test(asrc)) {
    record('A1 前置：能在 anysearch.py 里定位守卫块', false, '未匹配到 reconfigure 守卫，drill 失效');
  } else {
    fs.writeFileSync(guardless, asrc.replace(guardBlock, '# [drill] UTF-8 守卫已移除\n'), 'utf8');
    const drillSuite = makeDrillSuite('fleet-eval-a1.mjs', (s) => s.replace(
      /const ANYSEARCH_PY = path\.join\(SHARED, 'skills', 'anysearch', 'scripts', 'anysearch\.py'\);/,
      `const ANYSEARCH_PY = String.raw\`${guardless}\`;`,
    ));
    const r = runSuiteJson(drillSuite, 'anysearch.encoding-verdict').results
      .find((x) => x.id === 'anysearch.encoding-verdict');
    record('A1 去守卫后应翻红', r && r.ok === false,
      `ok=${r && r.ok} metrics=${JSON.stringify(r && r.metrics)} detail=${r && r.detail}`);
  }

  // ── A2：往 scan.sanity 体内注入一行网络访问 ────────────────────────────────
  const anchor = 'const ok = skillDirs.length > 0;';
  const ssrc = fs.readFileSync(SUITE, 'utf8');
  if (!ssrc.includes(anchor)) {
    record('A2 前置：能在 scan.sanity 体内定位锚点', false, '锚点未命中');
  } else {
    const drillSuite2 = makeDrillSuite('fleet-eval-a2.mjs', (s) => s.replace(anchor,
      `${anchor}\n      void fetch('https://example.com/'); // [drill] 注入的网络访问`));
    const r = runSuiteJson(drillSuite2, 'suite.determinism-contract').results
      .find((x) => x.id === 'suite.determinism-contract');
    record('A2 注入网络访问后应翻红', r && r.ok === false && r.metrics.netViolations > 0,
      `ok=${r && r.ok} netViolations=${r && r.metrics.netViolations} detail=${r && r.detail}`);
  }

  // ── 活文件零改动自证 ───────────────────────────────────────────────────────
  const after = { suite: md5(SUITE), anysearch: md5(ANYSEARCH) };
  record('活文件零改动', before.suite === after.suite && before.anysearch === after.anysearch,
    `suite ${before.suite === after.suite ? 'unchanged' : 'CHANGED'} / anysearch ${before.anysearch === after.anysearch ? 'unchanged' : 'CHANGED'}`);
}

try {
  main();
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

const failed = drills.filter((d) => !d.ok);
console.log('-'.repeat(70));
console.log(`drill: ${drills.length - failed.length}/${drills.length} 如期`);
process.exit(failed.length ? 1 : 0);
