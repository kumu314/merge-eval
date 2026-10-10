# demo — 30 秒看它红了 / 绿了

`fleet-eval` 默认要指到你自己的技能库才能跑。这个目录自带一份最小的样例技能库，**零配置**就能看它工作：

```bash
node demo/run.mjs
```

它把同一批断言跑两遍：`fixture-broken/skills/` 故意留了 4 处缺陷，`fixture-clean/skills/` 是同一套技能、把缺陷改好。输出：

```text
同一个套件，先看它把坏掉的技能库抓出来，再看修好的全绿。

============================================================
 1/2  fixture-broken（故意留了 4 处缺陷）—— 预期报红
============================================================

fleet-eval — 本机 agent 资产舰队回归套件 (source: demo/fixture-broken/skills, 5 skills, 0 endpoints)
------------------------------------------------------------------------------
[PASS] scan.sanity                    {"skills":5} (1ms)
[FAIL] frontmatter.valid              {"parsed":5,"bad":1} (6ms)
       ↳ delta: description 空
[FAIL] frontmatter.name-matches-dir   {"mismatch":2} (4ms)
       ↳ epsilon != alpha | gamma != gamma-typo
[FAIL] frontmatter.name-unique        {"dup":1} (4ms)
       ↳ alpha (alpha, epsilon)
[FAIL] junk.absent                    {"junk":1,"allowed":0} (5ms)
       ↳ beta/cache.bak
------------------------------------------------------------------------------
pass_rate = 20.0%  (1/5)

=> 退出码 1（非 0 = 有失败项，CI 会据此把改动拦下）

============================================================
 2/2  fixture-clean（把上面 4 处改好）—— 预期全绿
============================================================

fleet-eval — 本机 agent 资产舰队回归套件 (source: demo/fixture-clean/skills, 5 skills, 0 endpoints)
------------------------------------------------------------------------------
[PASS] scan.sanity                    {"skills":5} (0ms)
[PASS] frontmatter.valid              {"parsed":5,"bad":0} (18ms)
[PASS] frontmatter.name-matches-dir   {"mismatch":0} (9ms)
[PASS] frontmatter.name-unique        {"dup":0} (6ms)
[PASS] junk.absent                    {"junk":0,"allowed":0} (10ms)
------------------------------------------------------------------------------
pass_rate = 100.0%  (5/5)

=> 退出码 0（0 = 全绿）
```

`--assert` 只校验不打印全文，CI 用它防止样例腐烂：

```bash
node demo/run.mjs --assert
```

## 两份 fixture 差在哪

| 位置 | fixture-broken | 撞上的检查项 |
|---|---|---|
| `skills/gamma/SKILL.md` | `name: gamma-typo`（和目录名不一致） | `frontmatter.name-matches-dir` |
| `skills/delta/SKILL.md` | 漏了 `description` | `frontmatter.valid` |
| `skills/epsilon/SKILL.md` | `name: alpha`（和 alpha 撞车） | `frontmatter.name-unique`（也顺带踩到 name-matches-dir） |
| `skills/beta/cache.bak` | 一个散落的备份文件 | `junk.absent` |

demo 只跑这 5 项「与布局无关」的断言，这样它不依赖 `sync.ps1` 里的端点布局。完整的 11 项要指到真实的技能库，见 [../fleet-eval/README.md](../fleet-eval/README.md)。
