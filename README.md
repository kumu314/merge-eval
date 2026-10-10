# agent-evals

把「AI agent 干活到底靠不靠谱」写成可机械判定的断言，每次改动后跑一遍，掉了就报红。

三个子套件，按"要不要花钱"分层：

| 套件 | 测什么 | 成本 | 需要什么 |
|---|---|---|---|
| [`fleet-eval/`](fleet-eval/) | 技能库全量回归：frontmatter 合法性、重名、垃圾残留、多端扇出一致性（11 项断言） | 0 API 调用 | 一个磁盘上的技能库 |
| [`merge-eval/`](merge-eval/) | 批量内容合入：未触及的条目必须逐字节不变（7 项断言） | 0 API 调用 | 一个被测仓库 |
| [`t2/`](t2/) | 技能增益 A/B：同一批任务，带技能 vs 不带技能，比通过率 | 需要 API key | 任意 OpenAI 兼容端点 |

## 为什么这样拆

三套件共享同一套判断口径，也是这个仓库存在的理由：

1. **能确定性判定，就不要请 LLM 当裁判。** 三个套件的 grader 全部是确定性断言——正则、md5、字节比对、退出码、远端 ref 真值。没有一个用模型打分：既贵，又不可复现。
2. **证据必须来自外部可复读的物证。** 判据只认远端 API 读数、文件 sha256、磁盘真实状态，不认"我跑完了""命令没报错"这类自述。
3. **面向"必须稳定"的资产判 `pass^k`，不判 `pass@k`。** 技能库和内容库的正确性是红线，要求 N 次里每次都过，而不是蒙对一次就算。
4. **判据本身也会出错，看到红先怀疑判据。** merge-eval 第一轮跑出来的红全是它自己的 bug。这条写进了两个子套件的 README，因为它是这里最贵的经验。

这三条不是原创，来源见 [fleet-eval/research/](fleet-eval/research/)（Anthropic《Demystifying evals for AI agents》、NVIDIA 的 agent evaluation 实践）。

## 快速开始

需要 Node ≥ 20.11（用了 `import.meta.dirname` 与内置 `fetch`）。

```bash
# 1) T2 判分管线自检：零 API 调用，证明"判据真的能区分好坏答案"
node t2/smoke-ab.mjs --dry

# 2) fleet-eval：先指到你的技能库根目录，再跑
FLEET_SHARED=/path/to/sharedskills node fleet-eval/fleet-eval.mjs --trials 2

# 3) merge-eval：先指到被测仓库 + 合入前的 sha
MERGE_REPO=/path/to/repo MERGE_REPO_SLUG=owner/repo \
MERGE_BASE_REF=<合入前的 sha> MERGE_TOUCHED_IDS='["id1","id2"]' \
node merge-eval/merge-eval.mjs --trials 2
```

各套件的环境变量、判据清单、以及踩过的坑，都在各子目录的 README 里。

## 目录

```
agent-evals/
├── fleet-eval/        技能库回归（11 项断言，零 API 成本）
│   ├── fleet-eval.mjs
│   ├── drill-a1a2.mjs     反向验证脚本：证明新增断言真的会红
│   └── research/          方法论来源
├── merge-eval/        批量内容合入回归（7 项断言）
│   ├── merge-eval.mjs
│   └── README.md
└── t2/                技能增益 A/B（需要 API key）
    ├── smoke-ab.mjs
    └── skills/        三颗被测技能（自研，MIT）
```

## 一处诚实说明

`fleet-eval` 与 `merge-eval` 是从作者自己的两个真实项目里长出来的：一个共享技能库（240+ 颗技能、4 个扇出端点），一个内容站点的批量入库流程。它们的判据和踩坑记录都来自真实事故，所以文档里保留了大量"本机实测"的具体读数——这些不是设计目标，是现场证据。

## 许可

MIT，见 [LICENSE](LICENSE)。
