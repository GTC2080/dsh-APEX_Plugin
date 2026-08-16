# DSH APEX Plugin

APEX 是一个 DeepSeek Harness 实验 preset。它先用官方 Minimal 的首请求形状锚定模型轨迹，
再在模型完成第一次动作后加入精简执行约束，并通过一个常驻发现工具按需开放 Standard
能力。目标是减少无关 prompt、工具 schema、代码和 token，同时保留完成复杂任务所需的工具。

当前版本是 **APEX v0.3**。它是可测试的实验版本，不代表已经证明 DeepSeek V4.1b 在所有
任务上都优于官方 Minimal 或 Standard。

## 可选 preset

| Preset id | 界面名称 | 用途 |
| --- | --- | --- |
| `apex-v03` | APEX v0.3（实验） | Minimal 锚定 + 一次性 APEX 策略 + 按需 Standard 工具 |
| `minimal-max-v2` | Minimal Max v0.2（实验） | 不含 APEX 策略的稳定对照组 |

升级到 v0.3 不会覆盖或改写 `minimal-max-v2`。包名暂时继续使用 `dsh-minimal-max`，以保持
现有 DSH profile 的插件升级路径稳定；对用户显示的产品名称和新 preset 已改为 APEX。

## APEX v0.3 如何工作

```text
新顶层会话
  -> 请求 1：官方 Minimal persona + bash + str_replace_editor
  -> 首次 assistant/message 或 tool/call 写入 session log
  -> 注入一次精简 APEX 策略
  -> 常驻：bash + str_replace_editor + dev_tool_search
  -> dev_tool_search(toolNames=[...])
  -> 下一次请求加入已确认存在的 Standard 工具
  -> compaction/end
  -> 新锚定周期，再次从 Minimal 双工具开始
```

首请求的 system prompt 仍然只有：

```text
You are a helpful software engineer assistant.
```

并保持 `complete: true`、`includeRuntimeContext: false`。首请求会过滤
`agent-instructions` 和 `skill-catalog`，APEX 策略也不会在这一轮出现。

晋级后，APEX 只添加一条带来源标记的 user-role instructions 消息；它会写入 session log，
因此同一锚定周期无需在每个请求重复注入。策略要求模型：

- 在正确位置做满足需求的最小可靠改动。
- 依次优先复用现有代码、平台能力、标准库和已有依赖。
- 只为下一项具体工作解锁所需工具。
- 避免推测性抽象、依赖、配置、脚手架、重复探索和无意义测试。
- 不牺牲安全、错误处理、兼容性和必要验证。

晋级、解锁和重新锚定都由持久 session events 重建，不依赖进程内缓存。恢复会话后状态
一致；`compaction/end` 会清空旧解锁并开始新的 Minimal 锚定周期。子 agent 保留完整工具
目录，并在首请求获得精简 APEX 策略，避免隐藏其汇报或委派能力。

## 为什么 v0.3 没有复制完整 routing-suite

V4.1b 的首请求工具形状会影响后续轨迹。若在首请求内加入关键词分类、额外路由 prompt 或
大量工具 schema，就同时改变了要验证的 Minimal 锚点。因此 v0.3 采用更小的能力路由：
首请求不分类，晋级后由 `dev_tool_search` 根据下一项具体需要开放工具。

本版明确不包含：

- 额外 LLM 路由调用。
- spec/react/weak 关键词分类器。
- super-injector、热重载或运行时覆写 Harness 源码。
- 自动调用子 agent 或工作流。
- “所有任务都能提升模型能力”的结论。

这些能力只有在 A/B 数据证明当前门控不足时才会进入后续版本。

## 要求

- Node.js `>=22.19.0`
- 与固定基线兼容的 DeepSeek Harness
- Windows 额外要求 Git Bash 的 `bash.exe` 可从 `PATH` 找到

当前审查基线对应 DeepSeek Harness commit
`74bd5f76ba8035639bf5b4f94ce0449187ca5489`。完整来源与固定 commit 见
[NOTICE](./NOTICE)。

## 安装与升级

使用已安装的 `dsh`：

```sh
cd /path/to/dsh-APEX_Plugin
dsh plugin --profile web add .
dsh web
```

从 Harness 源码运行：

```sh
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add /path/to/dsh-APEX_Plugin
pnpm dsh web
```

启动日志应同时出现：

```text
[dsh-apex] installed and mount-validated preset "minimal-max-v2"
[dsh-apex] installed and mount-validated preset "apex-v03"
```

相同内容已存在时，`installed` 会显示为 `existing`。安装器只创建缺失目录，不覆盖同名
用户内容；若新复制的 preset 挂载失败，只回滚该目录。

确认 bundle 已进入 profile：

```sh
dsh --profile web --dump-config
```

输出应包含 `minimal-max-preset-installer` 和 `dsh-minimal-max`。随后在 Web UI 新建会话并
选择“APEX v0.3（实验）”。preset 不会重组已有会话，所以旧会话不会自动切换到 v0.3。

## 使用 Standard 工具

通常只需直接描述任务。第一轮之后，模型会看到 `dev_tool_search` 的能力索引；当任务需要
联网、技能、目标、子 agent、工作流、后台任务或 Standard 文件工具时，应先解锁对应工具，
而不是用 `bash` 模拟缺失能力。

知道精确名称时，一次调用即可解锁，例如：

```json
{"toolNames":["web_search"]}
```

不知道名称时先搜索：

```json
{"query":"filesystem grep"}
```

搜索最多返回 20 个匹配工具及其首行说明，不会把完整 Standard schema 放进每个请求。
解锁从下一条模型请求生效，并持续到本次 compaction。

## 自动验证

插件没有第三方开发依赖，不需要运行 `npm install`：

```sh
cd /path/to/dsh-APEX_Plugin
npm test
npm run check
```

验证覆盖：

1. v0.2 基线保持不变，官方 Minimal composition 仍逐字节匹配固定基线。
2. APEX 首请求只有官方 Minimal system prompt 与双工具。
3. APEX 策略在首请求缺席、晋级后只注入一次、compaction 后重新进入新周期。
4. Standard package rows、常驻工具、显式解锁、恢复和子 agent 行为。
5. 两个 preset 的幂等安装、内容冲突拒绝、符号链接拒绝、挂载失败隔离回滚。
6. macOS、Linux 和 Windows 的组合路径，以及 Windows Git Bash fallback contract。

如果插件与 Harness 不在默认相邻目录，可指定 checkout：

```sh
DSH_CHECKOUT=/path/to/deepseek-harness npm test
```

### 隔离挂载验证

不要用日常 DSH home 做安装试验：

```sh
TEST_ROOT=/path/to/test-directory
TEST_HOME="$(mktemp -d "$TEST_ROOT/apex-v0.3-home.XXXXXX")"
DSH_HOME="$TEST_HOME" dsh plugin --profile web add /path/to/dsh-APEX_Plugin
DSH_HOME="$TEST_HOME" dsh --profile web --dump-config
DSH_HOME="$TEST_HOME" dsh web --port 0
```

检查 `.agent-presets/apex-v03/` 是否包含 composition、策略模块和三个跨平台运行模块，并在
新会话中确认请求工具序列：

```text
1. bash + str_replace_editor
2. bash + dev_tool_search + str_replace_editor
3. 第二步显式解锁的工具
```

## 模型能力评测

结构正确与模型能力是两个独立验收层。推荐使用四组盲测：

- A：官方 `minimal`
- B：`minimal-max-v2`
- C：`apex-v03`
- D：官方 `standard`

保持同一模型端点、版本、推理强度、max tokens、题目、workspace 初始状态和权限。每次使用
全新会话，每组至少重复 10 次，并记录：完成率、硬性需求覆盖率、首个动作、工具参数合法率、
返工次数、输入/输出 token、延迟和错误。比较 B/C 可以单独判断 APEX 策略的净影响；比较
A/B 可以判断工具锚定的影响；D 是完整 Standard 对照。不要以单次成功宣称普遍提升。

### 已发布的 pilot

- [2026-08-16 USP Match 四模式真实模型对比](https://github.com/GTC2080/dsh-APEX_Plugin/tree/main/benchmarks/2026-08-16-usp-match)：
  APEX v0.3、Minimal Max v0.2、官方 Minimal 与官方 Standard 的同题单样本测试，包含原始
  提示词、结构化指标、浏览器验收、最终产物和截图。该记录为 `n=1`，不代表稳定排序。

## 已知边界

- v0.3 的“路由”是晋级后的按需能力路由，不是完整任务模式分类器。
- APEX 策略是新的实验变量，必须通过 B/C 重复评测判断收益与副作用。
- Windows fallback 每次调用是新进程，不保留 shell 状态，也不应用 Harness OS sandbox；
  已有跨平台 contract，仍需真实 Windows 主机端到端验证。
- Harness 升级若改变 Minimal 或 Standard composition，基线测试会有意失败，必须审查差异
  后再升级。
- 删除 bundle 不会自动删除用户 preset。停止 DSH 后，再通过 preset 管理能力显式删除不再
  使用的 `apex-v03` 或 `minimal-max-v2`。

## 研究依据与致谢

- [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)：提供最小必要实现、
  YAGNI 和复杂度约束思路。
- [xiaobright/modeltest](https://github.com/xiaobright/modeltest)：提供 V4.1b 首请求工具形状与
  轨迹触发实验。
- [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)：
  提供 Minimal 锚定、持久晋级和按需工具门控基础。
- [yjh051108/dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite)：提供将模式选择
  放在首请求之外、避免污染已承诺轨迹的路由设计启发。
- [DeepSeek Harness 官方 preset](https://github.com/deepseek-ai/deepseek-harness/tree/main/apps/cli/config/agent-presets)
  与[插件开发文档](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)。

感谢以上作者和项目公开实验、代码与设计思路。APEX 是独立社区项目，不隶属于 DeepSeek，
也不代表 DeepSeek 官方背书。

## 许可证

MIT。第三方来源、采用范围与固定 commit 见 [NOTICE](./NOTICE)。
