# agent-evals — 本机 Evals 落地方案

> **移植提示**：本套件默认读 `<SHARED>`（作者本机布局），用环境变量 `FLEET_SHARED` 覆盖成你自己的技能库根目录。
> 它假定该目录下有 `skills/`、`sync.ps1`、`scripts/skills-reconcile.py`——即一套"共享技能库 + 多端扇出"的布局。
> 若你的目录结构不同，`endpoints.*` 与 `reconcile.*` 这几条会红，属预期（它们本来就绑定那套布局）。

检索日 2026-10-06。方法论依据见 `research/`，项目面清单见 `research/project-landscape-2026-10-06.md`。

## 一句话

2026 的共识不是"选哪个框架"，而是**把 evals 当产品工程的基础设施养**：能确定性就确定性、outcome 高于 agent 的自述、面向"必须稳定"的对象用 `pass^k` 而不是 `pass@k`。
本机无 GPU，故不走本地权重路线（lm-evaluation-harness / oumi / lighteval 本地模式全部排除），只走**确定性 + API 型**两层。

## 分层（按"性价比 × 本机可行性"排）

| 层 | 做什么 | 成本 | 状态 |
|---|---|---|---|
| **T1 舰队回归套件** | 对本机 240 颗共享技能 + 4 个扇出端点做确定性断言 | 0 API 调用 | ✅ **已落地并跑通**（`fleet-eval/fleet-eval.mjs`） |
| **T2 技能 lift A/B** | 用 promptfoo + codex-sdk 量"加了某颗技能，答案变好了多少" | 有 API 成本 | 设施已装齐（`promptfooconfig.yaml`） |
| **T3 可选补强** | Inspect AI（UK AISI）/ Langfuse 自托管 / 腾讯 AI-Infra-Guard 的 Skills·MCP Scan | 视情况 | 未装，按需 |

## T1 怎么跑

```powershell
node fleet-eval.mjs                 # 1 轮
node fleet-eval.mjs --trials 3      # 3 轮，额外报 pass^3
node fleet-eval.mjs --json          # 只出 JSON
```

- 退出码 `0` = 全绿；`1` = 有条目失败（每个失败项在 JSON 里带 `detail`）。
- 报告落盘 `out/fleet-eval-YYYY-MM-DD.json`。

### 它检查什么（11 个 task，全确定性 grader）

| id | 层 | 断言 |
|---|---|---|
| `scan.sanity` | harness | 源目录存在且非空（防"扫到 0 条也算全绿"） |
| `frontmatter.valid` | structure | 每份 SKILL.md 都能解析出非空 `name` / `description` |
| `frontmatter.name-matches-dir` | structure | `name` == 目录名 |
| `frontmatter.name-unique` | routing | `name` 在源树内唯一 |
| `junk.absent` | hygiene | 无 `.git`/`node_modules`/`__pycache__`/`*.bak*`（`music-composition/.git` 为已登记豁免，计入 `metrics.allowed`） |
| `endpoints.present` | fanout | 声明的端点目录都存在 |
| `endpoints.match-authority` | fanout | 本套件现读 `sync.ps1` 的端点名单 == `skills-reconcile.py --targets` 的输出 |
| `endpoints.skillmd-parity` | fanout | 每端每颗技能 SKILL.md 的 md5 == 源（尊重 `$hideFrom`） |
| `reconcile.drift-zero` | fanout | 全库对账 `differing 0` / `unreadable 0` |
| `anysearch.encoding-verdict` | tooling | 某工具脚本的 UTF-8 守卫真的生效（**含对照臂**，防"探针本身失效"造成假绿） |
| `suite.determinism-contract` | suite | 套件自审：注册表良构 + 源内 id 与注册表一一对应 + 任一 task 体内无网络访问 |

### 三条必须知道的纪律

1. **端点名单现读 `sync.ps1`，绝不抄第二份。** 而且读之前必须按行剥掉 PowerShell `#` 注释——`sync.ps1` 里留着一行被注释掉的旧端点。实测不剥注释会凭空多出一端，240 条全报 ABSENT（纯假红）。`endpoints.match-authority` 就是为此设的交叉校验。
2. **`skills-reconcile.py` 恒返回退出码 0。** 它把读数印在汇总行里，坏了也不报错。所以 `reconcile.drift-zero` 是**解析汇总行的数字**判定的，不看 `$?`。
3. **只在舰队静止时读读数。** 扇出进行中跑本套件会红，而且与真漂移**外观完全一样**（都退 1、都报 `pass_rate 77.8% (7/9)`）。2026-10-06 演练实测：13:12–13:18 有人跑 `sync.ps1`（`$targets` 顺序 zcode → agentskills → trae → workbuddy，每端约 90s），我在 13:15 读到 7/9、13:19 读到 9/9、13:21 又读到 7/9（这次是真漂移：源已改、端点未扇出）——三处红都不是套件出错，但只有最后一处需要人管。判据两条：① 有没有 `sync.ps1` / `powershell` 在跑；② 端点技能目录的创建时间是否在最近几分钟内呈阶梯状刷新（`done-ledger` 实测：zcode 13:12:56 → agentskills 13:14:16 → trae 13:16:36 → workbuddy 13:18:06）。落在 2c 里没问题——它紧接 `sync.ps1` 之后跑，天然静止；**人临时手跑必须先确认静止**。

## 已接入既有定时任务（2026-10-06）

T1 已挂进 `<SHARED>\scripts\skills-update-scheduled.ps1` 的 **2c 步**，位于 2b 对账之后、黑板登记之前。这一轮的顺序是：
`npx skills update` → `sync.ps1` 扇出 → `skills-reconcile.py` 对账 → **`fleet-eval.mjs` 回归套件** → 黑板登记。

> **频率 = 每天 09:00（2026-10-06 已改，本轮现读确认）。**
> 先前这里断言过"实际是每周一，本机文档里的'每天'是错的"——那条依据是当时 `schtasks /query /tn skills-auto-update /xml` 读到 `CalendarTrigger` + `ScheduleByWeek`（`WeeksInterval=1`、`DaysOfWeek=Monday`、Next Run `2026-10-12 09:00`）。
> 该断言**已作废**：2026-10-06 按用户确认把触发器改成 `<ScheduleByDay><DaysInterval>1</DaysInterval>`（改前 XML 备份在 `out/skills-auto-update.trigger-backup.xml`）。
> 现读证据（2026-10-06 12:5x）：`Schedule Type: Daily`、`Days: Every 1 day(s)`、`Next Run Time: 2026/10/7 9:00:00`、`StartBoundary 2026-10-06T09:00:00+08:00` + `<ScheduleByDay><DaysInterval>1</DaysInterval>`。
> 于是 `sync.ps1` 头部注释第 9 行的"每天 09:00"从此为**正确**，`windows-scheduled-task/SKILL.md` 里的两处 `（每周一 09:00）` / `— 每周一 09:00，` 也已同步改成"每天 09:00"。
> 影响：漂移最坏**当天**就能被扫到（改前是 7 天）。

为什么要在 2b 之后再补 2c：2b 只看得到**文件内容漂移**，看不见结构/卫生/路由类缺陷——2c 首跑就抓到 3 处 `frontmatter name ≠ 目录名` 和 11 个源树残留，这些 2b 全报 0 漂移。

日志落 `<SHARED>\logs\skills-auto-update.LOG.md`：
- 全绿 → `| 时间 | fleet-eval 全绿: pass_rate = ... | ✅ |`
- 有失败 → `| 时间 | fleet-eval 未过 2/9 项: xxx {...} ; yyy {...} | ⚠️ |`，并把这句带进黑板 note。

原脚本的 `Add-Log` 把状态硬编码成 ✅，失败也会记成全绿；已拆成 `Add-LogStatus($line,$status)` + `Add-Log` 薄封装，并对 `|` 做转义（否则撑破 markdown 表）。

### 2c 的两条防假绿设计（都已实测）

1. **只认本轮新写出的报告。** 判据是报告文件的 mtime ≥ 本轮启动时刻。若只看"目录里有没有 `fleet-eval-*.json`"，套件没跑起来时会读到**昨天的旧报告**并报全绿。
2. **不解析控制台文本。** 失败明细从套件写出的 UTF-8 JSON 里取，避免中文在控制台编码上被吞。

实测（作者本机三个接线脚本，均直接从**已部署文件**里正则抽取 2c 块后执行，不是抄一份仿制品；因含本机私有路径，未随仓库发布）：

| 场景 | 结果 |
|---|---|
| 正常 | ✅ 落盘 `fleet-eval 未过 2/9 项: frontmatter.name-matches-dir {"mismatch":3} ; junk.absent {"junk":11} \| ⚠️` |
| node 不存在 | ⚠️ 走 catch 分支，未读旧报告 |
| node 正常但报告写到别处（旧报告留在盘上） | ⚠️ `未产出本轮报告(exit=1，报告 mtime 早于本轮启动)` —— 拒读旧报告 |

### 回滚

原文件备份在同目录 `skills-update-scheduled.ps1.bak-before-fleet-eval-20261006`，用 `Copy-Item -Force` 覆盖回去即可。

> 注意：改这个 `.ps1` 必须保留 **UTF-8 BOM**——PowerShell 5.1 读无 BOM 的 `.ps1` 会按 GBK 解码，中文立即乱码。本次是用 node 读原字节、只替换内容、原样保留 BOM 写回的（实测我的验证脚本自己就栽在这个坑上）。

## T1 首跑读数（2026-10-06，2 trials）

```
pass_rate = 77.8%  (7/9)   pass^2 = 77.8%     # 确定性任务 → pass^k == pass_rate，符合预期
240 skills | 922 个 SKILL.md 逐端比对 | diff 0 | absent 0
reconcile: differing 0 | unreadable 0 | hidden 38 | excluded-source 52
```

两个真失败（**是发现，不是套件坏了**）：

- `frontmatter.name-matches-dir` — 3 处目录名 ≠ frontmatter `name`：
  `Humanizer-zh`≠`humanizer-zh`、`guizang-social-card`≠`guizang-social-card-skill`、`taste-skill`≠`design-taste-frontend`。
- `junk.absent` — 源树里 11 个残留：9 个 `*.bak*` + 2 个 `__pycache__`。`sync.ps1` 的排除表让它们扇不出去，所以只污染真源树。

这两条当时**没有自动修**——真源是 4 端的唯一写入点，改它要走 `sharedskills` 的既有纪律（改真源 → 跑 sync → 逐端对账）。**2026-10-06 修复轮已按该纪律执行完毕，读数见下。**

## T1 修复轮读数（2026-10-06 12:58）— 9/9 全绿

```
pass_rate = 100.0%  (9/9)        # 退出码 0
240 skills | 922 个 SKILL.md 逐端比对 | diff 0 | absent 0
reconcile: differing 0 | unreadable 0 | aborted false
```

| 项 | 动作 | 修后读数 |
|---|---|---|
| `frontmatter.name-matches-dir` | 改 3 处 frontmatter `name` 去等于目录名（**不动目录**，目录名被 `$hideFrom` 等多处引用）：`Humanizer-zh`、`guizang-social-card`、`taste-skill` | `{"mismatch":0}` |
| 连带（名字改了，引用不能悬空） | `impeccable-design-polish/SKILL.md` 的 `` `design-taste-frontend` ``、`guizang-social-card/agents/openai.yaml` 的 `$guizang-social-card-skill` | 已改，逐端核对 md5 |
| `junk.absent` | 9 件真垃圾移入 `archive\junk-2026-10-06\`（8 个 `*.bak*` + 1 个 `__pycache__`，195.7 KB，逐件 sha256 台账） | `{"junk":0,"allowed":1}` |
| 豁免登记 | `music-composition/.git` 是刻意保留的上游克隆件（内含本机提交 `9ddcb4f`，禁止 push / 碰 origin），按**精确路径**豁免；别的技能下再出现 `.git` 仍算垃圾 | 计入 `metrics.allowed` |
| 套件自身的缺陷 | `junk.absent` 的 detail 原为 `slice(0,10)`，命中 11 时明细只列 10，读数与明细对不上；改为不截断 | 两份副本 md5 `1CF006A6` 一致 |

> 首跑明细的第 11 项被截断藏起来了，当时按顺序推断是 `music-composition/.git` —— 核对成立（行走序上 `music-composition` 在 `decision-hygiene` 之后）。修复轮重扫时 `decision-hygiene/scripts/__pycache__` 已自行消失，故实到 9 件。

改真源后的验证链：`sync.ps1` 扇出（4 端、0 冲突、excluded 42）→ **逐端定点核对** 6 个被改文件的 md5（含套件 `skillmd-parity` 不覆盖的 `openai.yaml`；唯一的 `ABSENT` 是 `Humanizer-zh` 在 agentskills，即 `$hideFrom` 的既定隐藏）→ `fleet-eval.mjs` 9/9。

## T3 候选（就绪但未启用）

- **Inspect AI** `UKGovernmentBEIS/inspect_ai`（英国 AISI 官方）——Task/Solver/Scorer 三件套，最中立，适合做研究级 agent 轨迹评测。需 Python + 各家 API key。
- **Langfuse** 自托管——把 trace 留在自己的 D 盘，适合给 T2 的 A/B 补"生产可观测"那一半。
- **腾讯 AI-Infra-Guard**——含 **Skills Scan / MCP Scan**，与本机"240 颗技能 + MCP"的形态直接对口，值得先做一次只读扫描再决定要不要纳入常规。