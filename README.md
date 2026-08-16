# DSH APEX Plugin

本仓库仅用于开发 DeepSeek Harness 的 APEX 插件。当前已经完成并可运行的实验基线是
Minimal Max v0.2；在 APEX v0.3 的路由与约束机制完成前，包名和 preset id 继续保留
`dsh-minimal-max` 与 `minimal-max-v2`，避免把尚未实现的能力标记为已完成。

## 当前基线：Minimal Max v0.2

Minimal Max v0.2 是一个 DeepSeek Harness 实验 preset：每个顶层会话的第一条模型请求
严格保持官方 Minimal 的 prompt 与双工具形状；出现第一条持久化的模型回复或工具调用
后，再进入一个小型常驻工具集，并通过 `dev_tool_search` 按需解锁 Standard 工具。

> v0.2 已验证请求结构、持久晋级、恢复和压缩后的重新锚定。它还没有证明 DeepSeek
> V4.1b 在所有题目上都获得更高成功率；模型能力需要独立、重复的 A/B 评测。

## 核心行为

```text
新顶层会话
  -> 第一次模型请求：Minimal prompt + bash + str_replace_editor
  -> 首次 assistant/message 或 tool/call 写入 session log
  -> 常驻：bash + str_replace_editor + dev_tool_search
  -> dev_tool_search(toolNames=[...])
  -> 下一次模型请求加入已确认存在的 Standard 工具
  -> compaction/end
  -> 新锚定周期，再次从 Minimal 双工具开始
```

- 首请求 system prompt 是完整的
  `You are a helpful software engineer assistant.`，并保持 `complete: true`、
  `includeRuntimeContext: false`。
- 首请求会过滤 `agent-instructions` 与 `skill-catalog`，不会偷偷把 Standard 上下文带入
  Minimal 锚点。
- 晋级状态和工具解锁只从 DSH 的持久 session event 重建，不依赖进程内缓存；重启或恢复
  会话后仍能得到同一状态。
- `agent-instructions` 在晋级后恢复；`skill-catalog` 只在显式解锁 `skill` 后恢复。
- 子 agent 保留完整工具目录，避免隐藏其汇报或委派所需能力。
- 安装器只创建 `minimal-max-v2`，不覆盖 v0.1 的 `minimal-max` 或任何同名用户内容。

研究与实现依据：

- [V4.1b 触发机制实验](https://github.com/xiaobright/modeltest/blob/main/docs/v4.1/DEEPSEEK_V4_TRIGGER_MECHANISM_EXPERIMENTS_20260814.md)
- [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)
- [DeepSeek Harness 官方 preset](https://github.com/deepseek-ai/deepseek-harness/tree/main/apps/cli/config/agent-presets)
- [DeepSeek Harness 插件开发文档](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)

当前组合对应 DeepSeek Harness commit
`74bd5f76ba8035639bf5b4f94ce0449187ca5489`，锚定实现的审查基线见
[NOTICE](./NOTICE)。

## 要求

- Node.js `>=22.19.0`
- 与上述基线兼容的 DeepSeek Harness
- Windows 额外要求 Git Bash 的 `bash.exe` 可从 `PATH` 找到

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

启动日志应出现：

```text
[dsh-minimal-max] installed and mount-validated preset "minimal-max-v2"
```

相同内容已存在时状态为 `existing`。从 v0.1 升级不会改写旧 preset；如果仍保留 v0.1，
Web UI 中可同时看到旧的“Minimal Max（实验）”与新的“Minimal Max v0.2（实验）”。
请为 v0.2 新建会话，因为 preset 不会重组已有会话。

确认 bundle 已进入 profile：

```sh
dsh --profile web --dump-config
```

输出应包含 `minimal-max-preset-installer` 和 `dsh-minimal-max`。

## 使用按需工具

普通任务直接描述需求即可。晋级后，模型能看到 `dev_tool_search` 的能力索引，并应在需要
联网、技能、目标、子 agent、工作流、后台任务或 Standard 文件工具时先调用它。

按精确名称解锁联网搜索的等价调用是：

```json
{"toolNames":["web_search"]}
```

不知道工具名时，先搜索再解锁：

```json
{"query":"filesystem grep"}
```

搜索结果只返回最多 20 个匹配工具及其简述，不会把所有 schema 塞进每次请求。随后再次
调用 `dev_tool_search`，将所需精确名称放入 `toolNames`。解锁从下一条模型请求生效，并
持续到本次 compaction；压缩后按新锚定周期重新解锁。

## 自动测试

插件没有第三方开发依赖，不需要 `npm install`：

```sh
cd /path/to/dsh-APEX_Plugin
npm test
npm run check
```

测试覆盖：

1. bundle manifest、无安装时脚本和精简发布文件。
2. v0.1 POSIX 基线与官方 Minimal 逐字节一致。
3. v0.2 包含当前 Standard package rows，但请求时只暴露阶段允许的 schema。
4. 首轮双工具、文本回复晋级、工具调用晋级、按需解锁和非法解锁输入。
5. session resume、compaction 后重新锚定、子 agent 目录与自动上下文过滤。
6. 安装幂等、内容冲突拒绝、符号链接拒绝、挂载失败回滚和平台判断。
7. Windows Git Bash fallback 的参数 schema、子进程调用和输入错误。

如果插件与 Harness 不在默认相邻目录，可指定 checkout：

```sh
DSH_CHECKOUT=/path/to/deepseek-harness npm test
```

## 隔离集成测试

不要使用日常 DSH home 做安装试验。将测试 home 放到专用测试目录：

```sh
DSH_TEST_ROOT=/path/to/test-directory
DSH_TEST_HOME="$(mktemp -d "$DSH_TEST_ROOT/minimal-max-v0.2-home.XXXXXX")"
DSH_HOME="$DSH_TEST_HOME" dsh plugin --profile web add /path/to/dsh-APEX_Plugin
DSH_HOME="$DSH_TEST_HOME" dsh --profile web --dump-config
DSH_HOME="$DSH_TEST_HOME" dsh web
```

检查：

1. 启动日志报告 `minimal-max-v2` 已安装并通过挂载校验。
2. `$DSH_TEST_HOME/.agent-presets/minimal-max-v2/` 含 composition 与三个运行模块。
3. 新建会话时可以选择“Minimal Max v0.2（实验）”。
4. 第一条模型请求只有 `bash` 与 `str_replace_editor`。
5. 第一条回复后出现 `dev_tool_search`，解锁的工具从下一条请求开始出现。

## 模型性能评测

结构正确与模型性能是两个验收层。推荐比较：

- A：官方 `minimal`
- B：`minimal-max-v2`
- C：官方 `standard`

保持同一模型端点、版本、推理强度、max tokens、workspace、题目和权限。每次使用全新
会话，每组至少重复 10 次，记录完成率、首个动作、工具参数合法率、返工次数、输入/输出
token、延迟和错误。先比较 A/B 首请求，再比较 B 在需要 Standard 工具时是否能稳定发现、
解锁并完成任务；不要用单次成功宣称性能提升。

## 已知边界

- v0.2 是 Anchored Standard 的最小可验证阶段，不包含 routing-suite 的模式分类、UI、
  super-injector，也不包含最终 APEX 的 Code / Cordis 路由。
- 当前不会把 Ponytail 规则写入模型 prompt；Ponytail 仅用于约束本插件实现复杂度，避免
  在性能基线稳定前新增另一项实验变量。
- Windows Git Bash 每次调用是新进程，不保留 shell 状态，也不应用 Harness OS sandbox；
  当前只有跨平台 contract test，仍需真实 Windows 主机端到端验证。
- Harness 升级若改变 Minimal 或 Standard composition，基线测试会有意失败，必须先审查
  差异再升级。
- 删除 bundle 不会自动删除用户 preset。请先停止 DSH，再通过 preset 管理能力显式删除
  不再使用的 `minimal-max-v2`。

## 许可证

MIT。上游来源与固定 commit 见 [NOTICE](./NOTICE)。
