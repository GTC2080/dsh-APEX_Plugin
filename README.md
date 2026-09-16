# APEX 1.0

当前版本：**1.0.0**；技术包名：`dsh-apex`；预设 ID：`apex-v1`；安装器：`apex-preset-installer`。

APEX 是基于官方 Harness 原生能力的通用任务增强插件。固定开发基线为 **DeepSeek Harness v0.1.6-alpha.1**（`0a15e36e7f82b6ed45af6fa9759f29b40dcd965d`），不修改官方源码或内置预设。

## 当前行为

- macOS APEX 的 `workspace-write` 现在使用 Host 分配的会话私有临时目录。Bash、stdin 脚本、直接 PTC 及文件 write/edit 遵循同一写入范围；共享临时区与其他 APEX 会话临时目录不再自动可写。文件写入在受限子进程中复用官方文件后端，防止检查后的目录替换造成越界写入。目录在同一 Host 内跨回合／会话恢复保留，正常关闭并确认受管进程退出后回收。关闭记录包含进程观察与目录清理的独立状态；退出码 0 不代表无残留，删除失败可能已有部分文件被删。排队写入取消会及时返回 `FS_ABORTED`，并保留后续写入顺序。长期文件应保存到工作区。显式完全访问模式沿用官方豁免。配置与回滚见 [私有临时目录](docs/APEX-1.0.md#会话私有临时目录macos)。
- 首轮即使用官方 PTC，工具声明由官方生成；没有 Minimal 引导、能力激活、模式切换或自制 Shell 解析器。
- 文件、搜索、Shell、Web、后台任务、交付、APEX 验证与 Teams 工具首轮进入原生 SDK；实际调用时才执行。
- 保留项目 `AGENTS.md`；不挂载全局技能目录扫描器。提示词补充任务理解、合理分工、验证与交付原则，以及简短的安全调用约定；没有逐轮提醒。
- Teams 复用官方成员、消息、任务依赖、revision、取消与冷恢复。仅 APEX 预设开放九个同名原生接口及自主组队策略；简单任务无需组队，明确的单代理要求优先。
- `list_agents` 的 `diagnostics` 显示尚未记录投递的团队消息数。`queued` 表示消息已持久保存，不确认立即执行；成员 inactive 也不表示没有排队工作。`wait_agent` 无活动成员时同时给出排队诊断，提示报告投递阻塞，避免重发或为同一工作建立替代队友。插件不自动重发、清空消息或修改原生恢复机制。
- `wait_agent` 单次最多等待 60 秒，较长请求返回 `waitWindow` 说明实际窗口；通过独立 PTC 请求继续等待，不限制项目总时长或队友运行时间。不要在一个 `run_code` 内循环等待，官方单次执行上限仍然生效。
- 原生 `job_output` 默认等待 30 秒、单次上限 60 秒；超长请求由官方配置截短，窗口到期仍返回真实任务状态，不终止后台任务。`present` 每次交付 1～8 个文件，更多文件分批提交；这两项限制在首轮固定说明中明确，不增加逐轮提醒。
- `apex_review` 是可选的原生只读子代理，只能读取文件、搜索和读图；父代理首轮即获知它不能执行命令、写临时文件或委派。审查提供有证据的发现和最小反例／检查建议，区分静态推断与实际观察；执行者按需要确认后再修改，不强制审查或重新测试。它单独使用 native 工具呈现，不提供可直接导入 Node 模块的 PTC `run_code`；主代理和 Teams 继续使用 PTC。主模型、队友和审查模型沿用原生配置继承；没有 Pro/Flash 等级路由。
- `apex_validate_web` 在独立无头 Chromium 中运行本地 HTML/JS，检查真实交互、刷新后状态、DOM 和指定视口截图；`apex_read_evidence` 只读原生历史记录。二者均不强制调用。刷新动作和验证边界见 [APEX 1.0 浏览器说明](docs/APEX-1.0.md#通用浏览器验证)。
- 浏览器控件检查使用原生可见性判断，收起的 `details` 等隐藏区域不再仅因保留非零尺寸而被报告为遮挡。显式点击、输入和选值仍拒绝隐藏目标，真实遮挡仍失败；自动扫描不滚动，显式操作滚动后再检查。
- 不维护旧 worker 状态机、阶段预算、交付账本或自动续跑。工具错误、非零退出与验收失败保持各自含义；`present` 不代表测试通过。
- macOS Bash 在官方执行器的 Seatbelt 配置上增加进程信号隔离：不能向该次命令沙箱外的进程发信号。跨调用清理使用原生 `job_kill` 的自有任务 ID；不使用全局进程名清理，不借用用户浏览器配置。
- macOS APEX 的 Bash 调用在执行前拒绝未声明参数，返回原生 `INVALID_ARGS`，不再把被忽略的字段当成成功调用。参数名以当前 SDK 为准；`stdin` 不是 Bash 参数，正文可用现有 `apex_run_script` 传入。合法调用和官方预设不变，不自动删除参数、修复或重试。
- macOS 的 `apex_run_script` 可按需把多行脚本经原生 stdin 交给解释器，避免把源码嵌入 Shell／`node -e`；返回会话解析后的初始工作目录和原生进程结果。沿用同一受保护执行器、审批、超时与取消，不安装运行时、不自动改写源码或推断测试通过。普通命令／后台任务仍用 Bash／jobs；其他平台暂不挂载此入口。
- 字面源码、文件正文及队友 prompt 仍需正确构造外层 PTC 字符串；`String.raw` 不是免插值通道。脚本工具首轮提供可执行示例和导入路径说明；`tools.*` 只存在于调用它的 PTC，外部解释器不继承该 SDK，先取工具数据再传值或工作区文件。Node module stdin 与 `.mjs` 使用 JavaScript，不是 TypeScript。并行检查区分已就绪文件与完整测试发现，Shell 删除不会清空文件版本观察。这些是调用指引，不是强制路由或“零错误”保证。
- 用户取消 APEX 后，迟到的团队或后台通知不能再触发模型请求；新用户指令可以恢复执行。取消状态从原生记录恢复，通知仍留在原生历史中；不改官方模式的行为。

当前用户级默认模型可保持 `deepseek-flash / max`，插件不硬编码或改写模型目录。图片输入以模型声明为准；未来多模态模型通过 Harness 原生模型配置接入。

## 安装与升级

源码通过本 GitHub 仓库分发，尚未发布到 npm。安装入口为仓库根目录；可以克隆后按下列命令安装，也可用固定 commit 的 GitHub 依赖。

先核验官方构建身份、提交和产物摘要；确认 live `DSH_HOME` 中没有正在运行的任务，停止旧 Host 后再迁移。以下命令中的路径须替换为实际路径，始终使用同一个 live Home：

```sh
DSH_HOME="/absolute/live-home" dsh plugin --profile web remove dsh-minimal-max
DSH_HOME="/absolute/live-home" dsh plugin --profile web add \
  "/absolute/official-checkout/packages/experimental/agent-team" \
  "/absolute/official-checkout/packages/experimental/client-ui-agent-team" \
  "/absolute/apex-source" --config.auto-install-peers=false
DSH_HOME="/absolute/live-home" dsh --profile web --dump-config
```

从官方源码运行时，将 `dsh` 换为该 checkout 的 `corepack pnpm dsh`。全新安装跳过旧包移除命令。两项 Teams 依赖必须与 Host 同为 `0.1.6-alpha.1`；它们是普通依赖，由 APEX bundle 各注册一次服务和官方 Web 面板，不安装官方全局 Team 工具层。

该基线使用官方 `ptc-runtime-node`，每次 `run_code` 为独立受文件策略约束的 Node 进程，默认单次 120 秒、最大 600 秒，`process.env` 初始为空；超时包含嵌套工具和审批等待，不是任务总预算。macOS 的附加进程信号保护只适用于 Bash／`apex_run_script`，不能推断任意 PTC Node 程序也受到相同信号保护。官方 Messages 协议与图片处理由 Host 提供，APEX 不覆盖模型路由；自定义 API 地址需要按官方升级说明检查协议兼容性。

官方新增的 `session-log-deepseek` 默认贡献完整会话事件后缀。需要保持升级前的数据发送范围时，可在用户级 `cordis.patch.yml` 为该 ID 配置 `enabled: false`；这不关闭正常模型请求，也不是 APEX 隐藏修改的全局默认。不自动启用实验性 Computer Use、Browser Use 或 Auto Review。

配置检查与真实预设挂载成功后，使用原生设置把新会话默认预设设为 `apex-v1`。不要在迁移中途启动 Host。插件安装器只创建新预设；相同内容可重复安装，目录不安全、内容不同、Host 不兼容时明确失败，不覆盖用户预设。

旧包名没有兼容别名。旧会话和测试作品不删除、不改写；旧任务不保证继续执行。旧预设目录不会被安装器自动删除。移除 APEX 时使用原生 CLI 移除 `dsh-apex` 并选择官方默认预设；只移除已确认无人使用的 Teams 依赖，不回写旧会话。

## 验证与边界

```sh
npm test
npm pack --dry-run --json
```

`npm test` 只运行 `test/apex-v1-*.test.mjs`；原历史源码、测试和证据仍在仓库，不纳入新包。原生集成测试复用已构建的官方 checkout、脚本化模型响应和临时测试夹具，无 API 费用；浏览器测试使用独立无头 Chromium，不操作用户桌面。可通过 `DSH_CHECKOUT` 指向匹配 checkout；缺少它时会明确跳过相应集成测试，不能据此声称整体通过。

原生 API 必须经正在运行的 Host Loader 解析，不能把源码启动与编译包的作用域／审批模块混用。编译模块夹具通过不代表正式 CLI 启动通过。本地研究驱动和运行日志未纳入公开版本。

浏览器检查不等同于视觉质量或全需求验收。rAF 采样不是 GPU 实际渲染帧率；受控时钟不是现实耗时证明。原生 Pointer Lock、WebGPU 或浏览器缺失不会被假造通过。截图保存在私有临时目录并返回路径、哈希，系统清理临时目录后可能不可用；读图时须核对记录身份。

`metricsKind` 仅在真实时间采样完成后标记 `instrumented-raf`；未完成采样或使用受控时钟时为 `not-measured`，此时 `fps`／`p95FrameMs` 的 `0` 只是未测量占位值。后续截图或诊断失败仍保留已取得的采样值，失败状态不变。`min_fps` 检查 rAF 回调率，不认证 GPU 帧率；结果详情给出回调数与实际采样时长。

验证结果的 `checks` 是请求参数对象，不是结果数组；读取 `status`／`detail` 和失败列表。空文本用 `equals:""`，不能用空 `contains`。受控输入已发送程序化 `input/change`；若页面延后到 rAF／timer 更新，需用后续检查点观察，工具不会自动推进或把提前失败改成通过。

普通真实时间验证也支持 `interactions` 中的原生滑块 `input:{selector,value}` 和单选下拉 `select:{selector,value}`；记录控件实际保留的值。两者通过原生 value setter 加程序化 `input/change`，不证明物理拖动或可信用户手势。非法值、禁用／遮挡目标和页面回退数值仍会失败；不支持自定义下拉、多选或 iframe。按键支持新增 `Tab`、`Enter`、`Escape`、`Home`、`End`，按当前焦点执行；具体边界和示例见开发说明。

文本和时序断言比较完整内容，只有返回的证据摘录会截断；首个数值按完整文本解析并单列在数值摘要中，不能把截断后的数字当作实际观察值。

自写浏览器脚本需在 `finally` 中等待自有进程退出，再删除其私有 profile，证据另存；插件不会扫描清理任意脚本的临时目录。APEX 验证器自身无法确认进程退出或删除失败时，会保留目录并报告精确路径，不能把未完成清理判为通过。非法交互参数保留拒绝语义，并给出具体字段路径和范围诊断。

当前平台实测范围是 macOS Web。Linux/Windows 仅有预设与接口契约检查，未做真实主机验证。真实模型质量、用量、延迟及大型 benchmark 另行启动；结构测试通过不代表能力更强。

详细设计、验证范围与旧测试的迁移理由见 [APEX 1.0 开发说明](docs/APEX-1.0.md)。

## 公开实验论文

[四冲程柴油机单任务对照研究](papers/diesel-engine-2026-09-16/README.md) 提供中文正文、补充材料、图表、脱敏数据与离线复现脚本。

本次 APEX 原始分 83.8、原生对照 72.8；原生对照触发故障上限后的最终分为 40.0。**两组均未完整通过原题。** APEX 的墙钟时间较短，输出 token 约为对照的 4.63 倍。每组仅一次生成、非盲、总预算不等，不能据此证明普遍或因果能力提升。

公开资料的保留范围与复核限制见 [脱敏说明](papers/diesel-engine-2026-09-16/SANITIZATION.md)。完整会话、私人配置、原始浏览器 trace 和开发讨论不公开。
