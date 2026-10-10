# Evals 项目面检索（2026-10-06 第二轮）

工具：GitHub MCP `search_repositories`（**星数/更新时间均为 API 现读，非记忆**）+ anysearch。
**所有星数是 2026-10-06 读数，会变。**

## A.1 主流框架/平台（按星数）

| 仓库 | Stars | 语言 | 最后更新 | 定位（仓库自述） |
|---|---|---|---|---|
| `langfuse/langfuse` | 35412 | TS | 2026-10-06 | Open source agent evals & observability（topics 含 self-hosted、ycombinator） |
| `mlflow/mlflow` | 28274 | Py | 2026-10-06 | AI engineering platform（eval+monitor+optimize） |
| `promptfoo/promptfoo` | 25733 | TS | 2026-10-06 | Test prompts/agents/RAGs；**自述 "Used by OpenAI and Anthropic"** |
| `comet-ml/opik` | 22396 | Py | 2026-10-06 | tracing + automated evals + dashboards |
| `openai/evals` | 19559 | Py | 2026-10-06 | 官方 eval 框架 + benchmark registry（oaieval） |
| `confident-ai/deepeval` | 18648 | Py | 2026-10-06 | "The LLM Evaluation Framework"（pytest 风格） |
| `vibrantlabsai/ragas` | 15937 | Py | 2026-10-05 | RAG 专项指标（已从 explodinggradients 迁移到 vibrantlabsai） |
| `EleutherAI/lm-evaluation-harness` | 14135 | Py | 2026-10-06 | few-shot 语言模型评测（**需本地权重/GPU**） |
| `Arize-ai/phoenix` | 11719 | Py | 2026-10-06 | AI Observability & Evaluation（自托管） |
| `NVIDIA/garak` | 9439 | Py | 2026-10-05 | LLM 漏洞扫描（红队向） |
| `oumi-ai/oumi` | 9392 | Py | 2026-10-05 | 微调+评测+部署一体（GPU 向） |
| `open-compass/opencompass` | 7493 | Py | 2026-10-05 | **上海 AI Lab 系**：一站式大模型评测平台（100+ 数据集） |
| `Tencent/AI-Infra-Guard` | 6755 | Py | 2026-10-06 | **腾讯**：AI 红队平台（Agent/Skills/MCP/Infra 扫描 + Jailbreak 评测） |
| `jeinlee1991/chinese-llm-benchmark`（ReLE） | 6462 | - | 2026-10-06 | 非线智能：中文能力评测榜 + 200 万条缺陷库 |
| `Helicone/helicone` | 6199 | TS | 2026-10-05 | LLM observability（YC W23，自托管） |
| `SWE-bench/SWE-bench` | 5978 | Py | 2026-10-06 | 真实 GitHub issue 的 coding agent 基准（**事实标准**） |
| `Giskard-AI/giskard-oss` | 5860 | Py | 2026-10-05 | Agent 评测&测试库（含 red-team） |
| `openai/simple-evals` | 4650 | Py | 2026-10-01 | OpenAI 内部用的小而清晰评测实现 |
| `EvolvingLMMs-Lab/lmms-eval` | 4444 | Py | 2026-10-05 | 多模态评测工具包 |
| `THUDM/AgentBench` | 3763 | Py | 2026-10-05 | **清华**：LLM-as-Agent 综合基准（ICLR'24） |
| `truera/trulens` | 3590 | Py | 2026-10-05 | Evaluation & Tracking for LLM/Agents |
| `lmnr-ai/lmnr` | 3326 | TS | 2026-10-06 | Agent 可观测性（YC S24，Rust+TS，自托管） |
| `UKGovernmentBEIS/inspect_ai` | 2944 | Py | 2026-10-06 | **英国 AISI 官方**评测框架（Task/Solver/Scorer） |
| `stanford-crfm/helm` | 2934 | Py | 2026-10-05 | **斯坦福 CRFM**：Holistic 可复现评测 |
| `harbor-framework/terminal-bench-1` | 2598 | Py | 2026-10-02 | Terminal-Bench（**已迁到 harbor-framework 名下**） |
| `huggingface/lighteval` | 2551 | Py | 2026-10-05 | **HF 官方**多后端评测工具箱 |
| `sierra-research/tau2-bench` | 2166 | Py | 2026-10-05 | τ²-Bench（**pass^k 指标出处**） |
| `future-agi/future-agi` | 2111 | Py | 2026-10-05 | 端到端 eval+observability（Apache 2.0，自托管） |
| `evalplus/evalplus` | 1824 | Py | 2026-10-05 | 代码合成严格评测（NeurIPS'23/COLM'24） |
| `Jwuthri/Tracely-ai` | 1490 | Py | 2026-10-06 | trace-native CI（真实失败→回归用例，自托管） |
| `sierra-research/tau-bench` | 1456 | Py | 2026-10-05 | τ-Bench 原版 |
| `wandb/weave` | 1136 | Py | 2026-10-05 | W&B 的 eval/trace 工具包 |
| `harbor-framework/terminal-bench` | 848 | Py | 2026-10-05 | Terminal-Bench 新版（2026-01-25 建） |

**需警惕**（星数与年龄严重不匹配，判为疑似刷星/营销，不纳入方案）：`ifixai-ai/iFixAi` 21221 stars / 2026-04-27 创建；`Q00/ouroboros` 6183 stars / 2026-01-14 创建（topics 含 `dsh`、`dsh-plugin`，与本机 DSH 相关，但定位是"自我进化 Agent OS"，不是评测框架，不纳入选型）。

## A.2 中文侧

| 项目 | Stars | 说明 |
|---|---|---|
| `open-compass/opencompass`（司南） | 7493 | 上海 AI Lab 系；`opencompass.org.cn` + `rank.opencompass.org.cn` 榜单 |
| `Tencent/AI-Infra-Guard` | 6755 | 腾讯，含 **Skills Scan / MCP Scan / Agent Scan**（与本机 skill 库+MCP 直接对口） |
| `jeinlee1991/chinese-llm-benchmark`（ReLE） | 6462 | 中文能力榜 + 缺陷库，持续更新 |
| `THUDM/AgentBench` | 3763 | 清华 Agent 基准 |
| C-Eval | — | `cevalbenchmark.com`，13948 题 / 52 学科 / 4 难度，2025 已公开完整测试集 |
| CMMLU | `haonan-li/CMMLU` | 67 主题中文知识推理 |
| SuperCLUE | — | 产业向中文评测榜 |

## A.3 三方评测（媒体/对比文，**[S] 只拿到摘要**）

- `sfailabs.com/guides/promptfoo-vs-inspect-vs-langfuse-…`（2026-07-16）：**三者不是替代品** —— promptfoo = pre-deploy CI 回归套件；Inspect AI = 研究级（agent/工具使用/沙箱执行）；Langfuse = 生产可观测。与 Anthropic 的分工判断一致。
- `blog.agentailor.com/posts/top-ai-agent-eval-frameworks-2026`（2026-06-23）：点名 DeepEval、promptfoo、agentevals、Strands Evals。
- `aadhar-build.github.io/llm-evals-comparison`：厂商中立选型决策指南（RAGAS/DeepEval/promptfoo/Langfuse/inspect_ai/OpenAI Evals）。
- `kdnuggets.com/top-10-open-source-benchmarks-for-ai-coding-agents-in-2026`：SWE-bench、Terminal-Bench、SlopCodeBench、ProgramBench 等。
- `aiworkflowlab.dev/article/llm-evaluation-production-automated-testing-pipelines-catch-failures`（2026-02-13）：DeepEval 套件 + 自建 LLM-judge + golden dataset + GitHub Actions + Langfuse 监控的完整流水线。
- `spheron.network/blog/ai-agent-benchmarking-gpu-cloud-swebench-gaia`：**"SWE-bench Verified resolve rate became the de facto code agent leaderboard metric"**；GAIA = 466 个多步任务、人工判 ground-truth；大规模 benchmark 的瓶颈是**基础设施**。
- 知乎 `zhuanlan.zhihu.com/p/2024968196612997551`（2026-04-07，中文）：直接引述 Anthropic 评测方法论。

## A.4 与本机既有资产的重合点

- **promptfoo 已装**（本机 eval-skills 目录，v0.123.1）+ 已有 A/B 对照 config（control vs treated，`openai:codex-sdk` provider + regex assertion）。
- `codex` CLI 现读在 `%APPDATA%\npm\codex.ps1` → codex-sdk provider 可用。
- **无 GPU** → `lm-evaluation-harness` / `oumi` / `lighteval`(本地权重) 直接排除；本机只走 **API 型评测**（key 已有 5 把：OPENAI/DEEPSEEK/DASHSCOPE/OPENROUTER/ANYSEARCH）。
- 腾讯 **AI-Infra-Guard**（Skills Scan / MCP Scan）与本机"100+ 共享技能 + MCP"形态对口，作为可选补强候选。