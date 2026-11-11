# HaluMem 记忆评测

使用 [HaluMem 论文](https://arxiv.org/abs/2511.03506)、[官方评测器](https://github.com/MemTensor/HaluMem) 和 [官方 Medium / Long 数据](https://huggingface.co/datasets/IAAR-Shanghai/HaluMem)，评测本工作台的记忆提取、记忆更新与问答。评测服务独立运行，默认端口 `4243`。

## 环境与启动

需要安装仓库的 Node 依赖、Python 3.11+ 和 Git。只有 judge 计分需要以下 Python 依赖：

```sh
python -m pip install -r benchmarks/halumem/requirements.txt
python scripts/halumem.py fetch --dataset medium
```

`fetch --dataset long` 或 `both` 可下载其他变体。下载固定官方代码提交 `d653749586bfc7d13f5b68e8851f52155b5b1650` 和数据集 revision `cb04336aa1b732d4b24f5186c552456b4099806e`，验证官方 LFS SHA-256，记录于 `.cache/halumem/sources.json`。Medium 为约 33.5 MB，Long 为约 106.5 MB。

在仓库根目录 `.env` 中填写以下字段。Workbench 应已在 `4242` 运行，并启用 `openai-codex/gpt-6-luna`：

```dotenv
HALUMEM_WORKBENCH_URL=http://127.0.0.1:4242
HALUMEM_WORKBENCH_TOKEN=<工作台启动链接中的 token>
HALUMEM_API_TOKEN=<至少16字符的独立随机令牌>
HALUMEM_PORT=4243
HALUMEM_URL=http://127.0.0.1:4243
HALUMEM_DATA_ROOT=.cache/halumem/state
judge_LLM_API_BASE=<兼容 OpenAI Chat Completions 的 API 根地址>
judge_LLM_API_KEY=<judge 的密钥>
judge_LLM_MODELID=<judge 的实际模型ID>
```

```sh
npm run eval:halumem
```

服务仅从工作台读取目标模型的非敏感声明，复用 Pi 原生认证，评测状态写入独立目录。可用 `HALUMEM_AGENT_DIR` 指定 Pi 凭证目录，`HALUMEM_EMBEDDING_ENV_FILE` 指定嵌入配置文件；省略时沿用原有默认配置。所有提取、相似性判断与问答请求固定使用 `gpt-6-luna`，judge 只由 `score` 命令调用。

## 冒烟、重试与计分

以下选择第一个官方用户的前四个会话，每会话至多一道问答，不跳过中间历史：

```sh
python scripts/halumem.py run --dataset medium --run-id smoke-medium --limit-users 1 --max-sessions 4 --max-questions 1
python scripts/halumem.py score --run-id smoke-medium --workers 1
```

相同命令与 run ID 可在中断后重试。已完成会话和提取收据复用，未完成会话会重新检索或生成尚未保存的问答，可能产生额外调用。更改数据、采样参数或模型时使用新 run ID。`max-questions` 是**每会话**上限，`0` 取消上限。新增的实验从空记忆开始，每个数据集用户均有独立的完整 WorkbenchApplication、SQLite、USER.md 和项目，避免跨用户污染。

全量需要另行确认用量，再运行 `--limit-users 20 --max-sessions 0 --max-questions 0`。Medium 与 Long 各有 20 个用户，均包含约 1.5 万记忆点、3,467 道题。judge 调用按需要评判的金标准记忆点、提取结果、更新记录和问答计算；还需计入提取、相似性判断、问答、嵌入和失败重试。冒烟分数不能代表全量表现。

## 三个接口

所有请求要求 `Authorization: Bearer <HALUMEM_API_TOKEN>`，仅监听回环地址并校验 Host / Origin。`run_id`、`user_id`、`session_id` 只接受 1–128 位 ASCII 字母、数字、下划线和连字符。时间使用 ISO 8601。

| 接口 | 输入 | 输出与用途 |
| --- | --- | --- |
| `POST /add-dialogue` | `{run_id,user_id,session_id,timestamp,dialogue:[{role,content,timestamp?}]}` | 导入原始 user / assistant 回合，调用原有项目复盘；返回已应用记忆、诊断、用时和不可变收据 |
| `GET /get-dialogue-memory` | URL 查询参数 `run_id,user_id,session_id` | 返回该会话当时实际生成的记忆快照；后续更新不会改写它 |
| `POST /retrieve-memory` | `{run_id,user_id,query,top_k,generate_answer?}` | 调用原有统一检索，返回记忆正文、语料时间和用时；可用官方 QA 模板调用 gpt-6-luna 生成回答 |

`GET /health` 同样需要认证，用于确认服务和实际目标模型。`top_k` 范围 1–50，更新验证请求 10，问答请求 20；原有检索预算可能使返回数少于该上限。

同一会话 ID 的相同对话可重试，修改对话返回 `409`。提取或模型请求失败会报错并停止重放，不会记为成功的空记忆。合法的原生证据拒绝、置信度拒绝或空更新保留在诊断中。接口不接受 persona、金标准记忆、问题答案等额外字段。

## 方法映射与边界

1. 按数据集用户、会话时间顺序导入，保留原始对话角色和消息。金标准记忆、persona、问题及答案不进入提取请求。更新验证使用金标准更新内容作检索查询，这是官方适配器的调用方式；原记忆和答案仍只用于计分。
2. 导入使用 Pi SessionManager 的公开接口，再刷新运行时句柄。用一个完成的导入运行记录框定整个会话，调用原有 `ProjectLearningService.reviewSession`。这里的“完成”表示静态语料导入完毕；助手原话仍是**未验证来源**，不能充当工具成功证据。
3. 本评测测量原生复盘提取与检索服务，每个官方会话显式复盘一次。网页端自动触发周期、执行工具后的情景记录和失败恢复流程不在这一静态语料实验中。它不能替代真实工具任务测试。
4. 保留原有学习提示、证据验证、相似性判断、置信度和更新规则，没有使用金标准指导提取。原生上限为每轮 3 条事实 / 2 项技能；证据窗口单运行至多 6,000 字符、总计 24,000 字符，且有原有的消息数和单条截断。官方会话可能含数十个记忆点，因此这些限制可能明显影响召回率，报告时必须保留这一条件。
5. 检索使用现有统一召回及上下文预算，只暴露语义与情景记忆正文，排除会话工作检查点、技能目录和项目骨架。每条记忆另记录语料时间用于时间问答，不更改原有事实的核验时间。嵌入不可用时沿用原有回退；检索诊断保存在产物中。
6. 问答只接收检索上下文和当前问题，使用下载的官方 `PROMPT_MEMZERO` 模板，禁用工具。论文使用 GPT-4o 的设置与本次 gpt-6-luna / 用户指定 judge 不同，结果不可宣称为完全复现论文配置。
7. `score` 加载缓存中**未经修改的官方** `process_user` 和 judge 例程、提示。官方解析器要求 JSON 代码块；本地传输层在服务返回完整裸 JSON 对象时仅添加代码块包裹，不改其中的字段、分数和理由，也不改变发往 judge 的提示。每个有效响应立即缓存，中断重试可复用；无效分类或分数不写响应缓存。
8. 本仓库的汇总按官方公式区分 all / valid，补全空分母为 JSON `null`，并验证分数必须为 0/1/2、分类必须为合法值。无效 judge 返回标为 `incomplete`，不冒充完整分数；更新含 `Other` 类别。官方在更新检索为空时将该点转入提取完整性评判的行为保持不变。

## 输出与复核

默认所有产物位于被 Git 忽略的 `.cache/halumem/`：

```text
sources.json                         # 官方提交、数据 revision 与 SHA-256
prompts.json                         # 从官方源文件读取的未修改 QA 模板
upstream/                            # 固定提交的官方评测器
data/                                # 未修改的官方 JSONL
state/<run>/users/<user>/application/ # 每用户独立工作台数据库与记忆
state/<run>/users/<user>/sessions/    # 每会话提取收据与快照
results/<run>/run.json                # 范围、模型、完成状态与产物哈希
results/<run>/users/                  # 逐用户重放结果
results/<run>/workbench_eval_results.jsonl
results/<run>/judged/<config-hash>/   # 按产物、judge 模型与服务地址隔离缓存
results/<run>/judge-responses/        # 逐提示缓存，减少中断后的重复调用
results/<run>/judge-transport.json    # 本次计分的请求、缓存和可用 Token 统计
results/<run>/scores.json             # 汇总分数、有效分母和逐条评判
```

运行前后检查结果中的 selection 与 judge 配置，不能把缓存中不同采样或不同 judge 的结果混合。judge 缺少任一配置会在调用前失败。报告包含模型 ID 与服务地址哈希，不保存 judge 密钥。

## 本地回归验证

```sh
# 从 packages/workbench-server 目录运行：
node ../../node_modules/vitest/dist/cli.js --run test/halumem.integration.test.ts
# 从仓库根目录运行，不访问模型或网络：
python -m unittest discover -s scripts -p halumem_test.py
npm run check
```

## 来源与许可证

官方代码、提示和数据遵循其 [CC BY-NC-ND 4.0](https://github.com/MemTensor/HaluMem/blob/main/LICENSE) 许可，并未包含在本仓库 MIT 授权的实现中。下载命令将原件保存在本地忽略目录；使用和分享这些材料时遵守上游许可。请引用论文，并在研究结果中注明数据 revision、评测器 commit、模型、样本范围和以上适配条件。
