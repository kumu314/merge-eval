#!/usr/bin/env node
// 一键看效果：拿仓库自带的样例技能库跑 fleet-eval 里"与布局无关"的 5 项断言。
// fixture-broken 故意留了 4 处缺陷 -> 报红；fixture-clean 修好 -> 全绿。
// 零配置、零 API 调用、离线可跑。
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const EVAL = path.join(import.meta.dirname, '..', 'fleet-eval', 'fleet-eval.mjs');
const TASKS = [
  'scan.sanity',
  'frontmatter.valid',
  'frontmatter.name-matches-dir',
  'frontmatter.name-unique',
  'junk.absent',
];
const EVAL_ARGS = [EVAL].concat(TASKS.reduce((a, id) => a.concat(['--only', id]), []));

function runOne(fixture) {
  const env = Object.assign({}, process.env, { FLEET_SHARED: path.join(import.meta.dirname, fixture) });
  try {
    return { code: 0, out: execFileSync(process.execPath, EVAL_ARGS, { env: env, encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

const broken = runOne('fixture-broken');
const clean = runOne('fixture-clean');

if (process.argv.indexOf('--assert') !== -1) {
  const bad = [];
  if (broken.code === 0) bad.push('破坏版样例本应报红（退出码非 0），实际全绿');
  if (clean.code !== 0) bad.push('修好版样例本应全绿（退出码 0），实际报红');
  if (bad.length) {
    console.error('demo 自检失败：' + bad.join('；'));
    process.exit(1);
  }
  console.log('demo 自检通过：破坏版 exit=' + broken.code + '（红），修好版 exit=' + clean.code + '（绿）');
  process.exit(0);
}

const bar = '============================================================';
console.log('同一个套件，先看它把坏掉的技能库抓出来，再看修好的全绿。');
console.log('');
console.log(bar);
console.log(' 1/2  fixture-broken（故意留了 4 处缺陷）—— 预期报红');
console.log(bar);
console.log('');
console.log(broken.out.replace(/\s+$/, ''));
console.log('');
console.log('=> 退出码 ' + broken.code + '（非 0 = 有失败项，CI 会据此把改动拦下）');
console.log('');
console.log(bar);
console.log(' 2/2  fixture-clean（把上面 4 处改好）—— 预期全绿');
console.log(bar);
console.log('');
console.log(clean.out.replace(/\s+$/, ''));
console.log('');
console.log('=> 退出码 ' + clean.code + '（0 = 全绿）');