# merge-eval · 批量内容合入的确定性回归评测套件

一个零依赖、零 API 成本的 **regression eval 套件**：把「批量内容合入」这件事的红线写成可机械判定的断言，每次合入后跑一遍，掉了就报。

设计口径来自 2026-01Anthropic《Demystifying evals for AI agents》与 NVIDIA 的agent evaluation 实践：**能确定性就确定性、要稳定就报 pass^k、证据必须来自外部可复读物证。**

## ★ 本套件刻意住在被测仓库之外（`<此仓库路径>`）

不放在被测仓库里，三条理由：
1. **评测器与被测对象同源就等于没有独立评测** —— 住在一起，它就能被同一批改动顺手改掉。
2. **评测基建的生命周期应长于它评测的对象** —— 仓库会clone/归档/换 CI，评测不该跟着断。
3. **归属不同**：这是「我怎么干活」的质量工具，不是「这个仓库的产品」。

所以被测仓库路径用 `MERGE_REPO` 传入，不靠相对路径猜。

## 定位

**regression eval**（通过率应接近 100%，掉了就是坏了），不是 capability eval（那种起步就该低）。
每条红线都是"必须稳定"的资产 → 判 **`pass^k`**（N 次每次都过），不判 `pass@k`。

## 用法

```bash
# 正向：指定被测仓库 + 本次合入前的真实 SHA + 本次触及的篇目清单
MERGE_REPO="<被测仓库路径>" \
MERGE_BASE_REF="<合入前SHA>" \
MERGE_TOUCHED_IDS='["id1","id2"]' \
MERGE_RELEASED_BATCHES='["jingdu-batch-01"]' \
node <此仓库路径>merge-eval.mjs --trials 2

node merge-eval.mjs --json     # 只出 JSON
node merge-eval.mjs --quiet    # 只出汇总行
```

读数**第一行永远回显生效参数**（`trials / remote / local / base / allow / released`）——
「我以为跑了 3 轮其实只跑了 2 轮」这类配置静默降级，在第一行就现形，不用回头查代码。

## 环境变量

| 变量 | 作用 | 不给会怎样 |
|---|---|---|
| `MERGE_REPO_SLUG` | 远端仓库 `owner/repo`（GitHub API 降级通路用）。**不配就发不出请求**，会明确报「未配置」而不是拼畸形 URL | 空 → 仅 ls-remote 可用时正常；ls-remote 失败时明确报未配置 |
| `MERGE_REPO` | **被测仓库路径**（本套件住在仓库外，不再靠相对路径猜） | 回落到当前目录 `.`，且读数首行会显示实际用的是哪个 |
| `MERGE_BASE_REF` | **权威基线**：`git show <SHA>:index.html`，即"合入前那一刻" | 回落到工作区旧快照，并**主动报红**（`baselineStale`）——旧快照可能是 merge-01 之前的，会把历史 legit 改动算成越界 |
| `MERGE_TOUCHED_IDS` | 本次**允许**变化的篇目清单（JSON 数组） | 空 → 任何变化都算越界，`untouched` 必红 |
| `MERGE_RELEASED_BATCHES` | 授权放行的批次（闸门判据用） | 空 → 闸门判据 PASS 但 detail 写"无批次可查"（**不假装查过**） |

## 六条判据

| id | layer | kind | 判什么 |
|---|---|---|---|
| `scan.sanity` | harness | local | **防假绿第一条**：POEMS 可解析、条数 > 0、id 非空且唯一 |
| `poems.count-and-order` | data | local | 970 首、id 序**逐位**不变（判序列相等，非集合相等） |
| `untouched.hash-zero-diff` | data | local | 未触及篇逐篇 sha256 零变化，列出全部越界 id |
| `only-poems-touched` | structure | local | POEMS 数组外文本逐字节相同；**排除含 POEMS 的数据块**后纯逻辑/样式块全等 |
| `merge-gate.audit-per-batch` | process | local | 授权点名的每批都有抽检报告且含 PASS，缺一即停。**报告名锚定面戳位**（`review-<batch>.md` 或 `review-<batch>-<面戳>.md`，面戳**不以数字开头**）；读数给`path@<blob-sha>` |
| `remote-truth.read` | fanout | **external** | 读远端真值（ls-remote，失败降级 GitHub API）并 **memo 住**，每轮只跑一次 |
| `remote-truth.stable` | fanout | local | 每 trial 只比对 memo 值与本地 HEAD，**不再查网络** |

### local vs external（pass^k 的语义分层）

- **local**（判被测对象）：每 trial 跑，输入每次应相同 →以此证明幂等。
- **external**（判外部世界）：每轮**只跑一次**，读数memo 供所有 trial 复用。

为什么：`pass^k` 要验的是**被测对象**的稳定性。远端不会因为你问两次就变，重查 N 次只多花 N 倍时间、不增加信息；更危险的是**把网络抖动引进 pass^k** —— 网抖一下就假红，那是外部噪声被当成红线破防。

>「再查一次」测的是**网络**；「比对 memo 值」测的是**远端在测试期间是否一致**。后者才是真不变量。

**网络不可用时**：`remote-truth.read` 报红并标注「★ 这是网络/环境问题，不是被测对象的问题」，`stable` 报「无法判定」——**既不拿缺失当通过，也不假装通过**。

## ⚠ 硬约束（都是踩过的坑，别改回去）

1. **拉子进程一律走异步**。本机 Node 22.22.2 的 `spawnSync`/`execFileSync` 对**任意**可执行文件返回 `EBUSY`（与磁盘余量无关，2026-10-06 实测），异步 `spawn` 正常。写同步会**静默取不到基线**。

2. **判据来源不能是"我自己写的东西"**。`remote-truth` 必须用 `git ls-remote` 或 GitHub API（真实网络查询），而不是本地 tracking ref——`git update-ref` 是"把本地记录改成你以为的样子"，记忆错了就把假账写进 ref，之后所有判据自证通过。

3. **自相矛盾的读数 = 套件自身 bug 的信号，不是数据有问题**。首跑时 `only-poems-touched` 报「prefix=同 suffix=同 但块有差异」——因为 `const POEMS = [...]` 整个数组就写在 `<script>` 内，要求该块全等本身是错判据。**先怀疑判据，别照着读数去查业务。**

4. **判据的输入本身要有时效闸**。基线比被测对象还老，判据再对也会得出错结论：用旧快照时置 `baselineStale` 并**主动报红**，不静默给可能失真的 PASS。

## 套件自身失效分类（比加第 8 条 check 更值钱）

我这几轮报的红**全部落在判据侧，没有一条是真破防**。形态同源，归类如下——**看到症状先怀疑这里**：

| 症状 | 先怀疑哪 | 实例 |
|---|---|---|
| **读数与运行事实矛盾** | 参数解析 / 配置是否真生效 | `--trials 3` 以为跑 3 其实跑 2 |
| **同一句话里字段自相矛盾** | 判据本身写错了 | prefix=同suffix=同 但「块有差异」 |
| **判据自证** | 判据来源是不是「我自己写的东西」 | 用本地 tracking ref 验远端 |
| **判据输入过时** | 基线比被测对象老吗 | 用 merge-01 前的快照当基线 |
| **命名/路径假设** | 猜的还是锚定的 | 写死 `review-<batch>.md` 撞上面戳 |
| **缺项当通过** | 未命中 ≠ PASS | 未命中词表却记绿 |

## ★ 决策语义：测量失败与测量为负，在决策上都等于「不许过」

读数上 INVALID / PARTIAL / ALL PASS 三态分开；**但用于决策闸时，只认 `ALL PASS`**：

```
gate_verdict: PASS | BLOCK
gate_rule: 测量失败与测量为负在决策上都等于不许过；INVALID/PARTIAL 一律 BLOCK，需人工接管并留痕。
```

为什么不能把 INVALID 读成「没有反对意见 / 信息不足随你」——那正是本 README 里「缺项当通过」那类失效在**自家套件里复发**。所以 `gate_verdict` 是机器可读字段，三种输出模式（人读/ `--quiet` / `--json`）都带，调用方不可能误读。

同理由，闸门判据对「报告状态」拆三种，不合并成中性标签：

| 状态 | 含义 | 闸门 |
|---|---|---|
| `path@blobsha` | 物证可复读（已入库，有不可变指向） | 放行 |
| `untracked` | 报告存在但未提交 ⇒ **取不到不可变指向 = 物证不可复读** | BLOCK |
| `missing` | 报告根本没生成 | BLOCK |

「未入库」不是可接受的中间状态。

## 元纪律

每条 check 的证据必须来自**外部可复读的物证**（远端 API、文件 md5、ref 真值），禁止引用「我读完了 / 命令没报错」这类自述。

## 自检：反向验证

正向全绿不能证明判据有效。**必须跑一次反向**，确认它会红：

```bash
# 故意用错基线 + 空允许清单 → 应当 FAIL
MERGE_BASE_REF="<一个更早的SHA>" MERGE_TOUCHED_IDS='[]' \
  node out/merge/merge-eval.mjs --quiet
# 读数：FAIL: untouched.hash-zero-diff
```

实测记录：
- **首次真实用在他人交付上**（30 篇批量内容合入）
  →以 `MERGE_BASE_REF=3708805`（合入前）为基线 → **7/7 ALL PASS**，`untouched` 差异 30 篇全在允许清单内（正好是该批 30 篇），
  闸门读数 `out/review-jingdu-batch-01-pi.md@002c41621f5d`。
- 反向（空允许清单）→ **FAIL: untouched.hash-zero-diff**（证明判据真的会红）
