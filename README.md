# DSH APEX Plugin

APEX 是一个 DeepSeek Harness 实验 preset。每个真实用户任务先保持官方 Minimal persona 与双工具，
并由宿主在首请求声明当前 Workspace；成功使用一次 Minimal 工具后只增加一个按需能力入口和一张一次性短能力卡。Pro 默认直接完成代码设计与实现，始终保留
编辑器；同一个具备视觉能力的 DeepSeek V4 Flash Max 只在 Pro 明确选择时承担真正独立、路径有界的代码模块，
或对 Workspace 内截图做只读质量复核。APEX v0.6.1 不再使用纯文本 `deepseek-v4-flash` 路由。

当前版本是 **APEX v0.6.1**。本次修订取消 Worker-first、父级第 8 步强制调度和 Worker 启动后移除
Pro editor 的做法，禁止 `**` 整个 Workspace 租约，并把等待、续作、接管等控制工具限制在对应生命周期
状态。Pro 可以先确定架构并实现主集成面，但只能把自己尚未修改的独立路径租给 Worker；`apex_wait` 可从
子会话持久日志恢复已经错过的结束事件。根 Shell 使用两级无编辑进展预算，Flash 使用基于重复检查证据的
停滞交接而非固定步骤或墙钟强杀。Flash 首请求保持极小 persona 与双工具形状。结构合同只能证明机制按设计工作，不能
替代真实模型的重复对照实验，也不代表已经证明它在所有任务上优于官方 Minimal。

## 可选 preset

| Preset id | 界面名称 | 用途 |
| --- | --- | --- |
| `apex-v061` | APEX v0.6.1（Pro 主导按需协作） | Minimal 直接路径 + 视觉版 Flash Max 有界代码 Worker / 只读复核 |
| `apex-v06` | APEX v0.6（实验） | Minimal 锚定 + Pro 主导验收 + Flash Max 有界实现与研究 |
| `apex-v051` | APEX v0.5.1（实验） | 极薄晋级策略 + 可续租直搜 + Pro 评审后的可续轮 Flash 研究 |
| `apex-v05` | APEX v0.5（实验） | 持久任务状态 + 有固定上限的 Pro/Flash 定向研究对照 |
| `apex-v041` | APEX v0.4.1（实验） | 自适应研究租约 + Standard 工具白名单 |
| `apex-v04` | APEX v0.4（实验） | 按任务动态提升 + 压缩恢复 + 跨平台 Guard |
| `apex-v03` | APEX v0.3（实验） | Minimal 锚定 + 一次性策略 + 按需 Standard 工具 |
| `minimal-max-v2` | Minimal Max v0.2（实验） | 不含 APEX 策略的稳定对照组 |

安装 v0.6.1 不会覆盖或改写任何早期 preset。包名继续使用 `dsh-minimal-max`，以保持现有
DSH profile 的插件升级路径稳定；界面产品名称使用 APEX。

## APEX v0.6.1 如何工作

```text
每条真人 user/message
  -> 清除上一任务的临时解锁和任务状态
  -> 请求 1：官方 Minimal persona + 持久化 shell（POSIX: bash / Windows: pwsh）+ str_replace_editor
     + 一条不含能力名称的可信 Workspace 提示
  -> 只有成功的 Minimal 工具结果才晋级；失败调用和纯 assistant/message 不晋级
  -> 请求 2：一次性显示适用的精确 APEX 查询；工具面增加 dev_tool_search
  -> 默认：持久化 shell + str_replace_editor + dev_tool_search；不注入完整 APEX 策略
  -> Pro 继续直接设计、实现、集成和验收
  -> 具体能力缺失时：精确名称一次激活；模糊查询先列候选再解锁 APEX 或 Standard 工具
  -> 仅独立有界模块：Pro 可先定架构，但必须在编辑租约路径前划分工作项 -> 1–4 个视觉版 Flash Max Worker 后台修改
  -> Worker 请求 1：独立极小 persona + 平台持久化 shell + str_replace_editor
  -> Worker 首次工具调用后：移除 shell，保留 str_replace_editor + read + read_image + glob + grep + report
  -> Worker 运行中出现 apex_wait / interrupt_agent；结算后仍先用 apex_wait 收集证据，之后才出现续作/接管
  -> Pro editor 始终存在；仅未转移的 Worker 租约路径禁止父子并发写
  -> Pro 用 apex_wait 读取持久化停止/写入证据；过去的结束事件也能从子会话日志恢复（无 sleep 轮询、无插件墙钟上限）
  -> Worker report/settlement -> Pro 查看租约文件并建立 pending / failed / passed 验收清单
  -> 普通租约内缺陷 -> apex_continue 结构化续作原 Worker
  -> max-tokens/失败/零写入/重复运行时错误/Pro-only 修复 -> apex_takeover 显式转移租约
  -> 静态 Web 成品 -> apex_validate_web 有限运行时验收
  -> 需要视觉证据 -> apex_inspect_image 用官方 V4 Flash Vision 只读检查 1–4 张 Workspace 图片
  -> 全部检查通过 -> 一次 final；确定性页面异常、FPS 门槛失败或结构化阻塞视觉缺陷可在修复后默认使用两轮 repair-proof，上一轮明确收敛时至多三轮
  -> 所有研究：Pro 直接 web_search 并判断证据
  -> compaction/end：临时工具清零，重新锚定后恢复当前任务状态
  -> 下一条真人 user/message：开始全新的任务边界
```

首请求的 system prompt 仍然只有：

```text
You are a helpful software engineer assistant.
```

并保持 `complete: true`、`includeRuntimeContext: false`，工具仍只有官方 Minimal 双工具。根会话首请求会
额外收到一条宿主生成的 Workspace user instruction，因此整个消息序列不再宣称与官方 Minimal 逐字节一致；
官方 Minimal 对照 preset 本身完全不变。该提示不包含任何能力或工具名称。第一轮不会出现完整 APEX policy、
`apex_build`、`apex_state`、`dev_tool_search`、自动 agent instructions 或 skill catalog。晋级、解锁、
任务状态和压缩恢复均从持久 session events 重建，不依赖额外状态文件或进程内缓存。

成功的首个本地工具动作之后只常驻 `dev_tool_search` 这一能力入口，并一次性给出可信 Workspace 根目录及
适用能力的精确查询方式；不会常驻这些工具 schema。即使 Pro 已经修改主集成文件，卡片仍可提示
`apex_build`；真正执行时，宿主只拒绝与 Pro 已成功修改路径重叠的租约。普通直接实现轨迹
不会看到 Worker、状态或浏览器验收 schema，也不会收到完整 APEX 策略。只有显式解锁 APEX 能力后，才注入
一段短的 Pro 主导说明。自上次成功实现编辑起，第 8 次 shell 调用给出收敛提醒；该提醒不会因使用过
broker 而失效。达到第 16 次时给出第二次提醒，之后仅暂停新的 shell 调用，直到成功实现编辑重置预算；
editor、按需工具、最终交付和任务本身不受总步骤或墙钟强杀。
`apex_build` 不再常驻，且不再由步骤检查点强制调用。每个选择性 Worker 都在后台运行并拥有持久 ID。
`apex_wait` 先订阅 Harness 的 `subagent/end` 生命周期事件，再检查子会话持久日志；因此 Worker 已停止但
父会话遗漏 settlement 时也会立即恢复，不会永久等待。它不使用 Bash `sleep` 或 `list_agents` 轮询，也不增加 Worker 墙钟上限；结算后返回
本轮 stop reason、output tokens、步骤数、工具调用数、成功写入数、触及路径和 report 状态。子任务正常完成、
报错、达到模型限制或被中断时，Harness 会向 Pro 投递 settlement；Flash 也通过 child-scoped
`report` 返回完成内容、剩余工作和阻塞。插件不使用关键词分类器，也不要求某一步必须委派。

### Workspace 访问边界

APEX v0.6.1 默认只允许模型访问当前会话由用户选定的 Workspace。只有当前最新一条真人消息中
逐字写出的非文件系统根目录绝对文件或目录路径，才会成为该任务的一次性 Workspace 外只读授权：可以通过
`read`、`read_image`、`glob`、`grep` 或 `str_replace_editor view` 查看该路径及其后代；下一条真人
消息会重新计算授权。模型回复、工具输出、较早任务、历史测试、相邻 Workspace、Home 目录和搜索中
偶然发现的路径都不能扩大授权。

外部授权不包含写权限，`write`、`edit` 和 editor 的修改命令始终只能作用于当前 Workspace；Flash
Worker 还要同时满足自己的非重叠写入租约。`bash` / `pwsh` 保持 Workspace-only，不能借外部只读
授权执行命令。守卫会规范化路径并检查已有 symlink 祖先，阻止从 Workspace 内的链接跳到外部。
Workspace 根目录在第一次模型动作前已经给出，shell 也直接从该目录启动；越界拒绝保持通用错误，
不再把“报错后补发路径”当作发现机制。
这是针对模型工具调用与自主越界搜索的执行策略，不是用来对抗恶意 shell 程序的独立机密计算沙箱。

### 可续租直接搜索

每个真人任务先有三次直接 `web_search`。之后每条新查询都必须通过
`dev_tool_search` 同时提交：

```json
{
  "researchGap": "仍缺少的具体证据",
  "nextWebQuery": "只针对该证据缺口的新查询"
}
```

成功结果只发放该查询的一次性租约。上一条租约未使用时不会发放下一条；已使用或已批准的规范化
重复查询会被拒绝。v0.6.1 不设置 10 次这类插件内固定总上限，证据仍不足时可以继续申请新的
不同查询。Harness 自身的会话生命周期、超时和工具执行边界仍然有效。

### 主模型 / 视觉版 V4 Flash Max 代码分工

Pro 默认直接实现。只有已经确认某个模块可以独立交付、与主实现低耦合且写入路径明确时，才通过
`dev_tool_search` 解锁 `apex_build`。Pro 可以先完成架构和主集成面；但任一成功修改过的文件都永久保持
Pro-owned，不能再租给新 Worker。工具 Guard 会按具体租约路径判断冲突，从而允许晚一点启动真正独立、
尚未触碰的叶模块，同时阻止主要工程完成后的重复施工。单文件交付物、强耦合整站实现和 `**` 整个 Workspace 都不得
委派。`apex_build` 复用 Harness 官方 `spawn` provider，以可继续后台方式运行，
将 provider/model 固定为 `deepseek-official` / `deepseek-v4-flash-vision-exp`，并通过官方
`agent/request` 扩展点把该子任务的推理强度固定为 `max`。纯文本 Flash 不再进入 APEX v0.6.1。
每个代码 Worker 使用独立的短 persona `You are a helpful assistant.`，不继承 Pro 的软件工程 persona 或完整 APEX policy。
子任务首请求只有平台持久化 shell（POSIX `bash` / Windows `pwsh`）和 `str_replace_editor`，保持 Minimal 工具形状；
固定工作项明确要求不用 shell，任意 Worker shell 调用也会被 Guard 拒绝。首次工具调用进入 session log 后，shell 被移除，
只保留 `str_replace_editor`、`read`、`read_image`、`glob`、`grep` 与 child-scoped `report`。`read_image`
只用于理解实现所需的 Workspace 视觉证据，最终视觉验收仍归 Pro。它没有网络、
Git、委派、工作流或用户交互工具。文件修改使用 Harness 原生 sandboxed filesystem，子会话固定为
`workspace-write`，即使父会话是 `danger-full-access` 也不会扩大权限。Harness 的 child-scoped
`report` 用于向直接父模型发送进度，不授予新的文件或命令能力。

`apex_build` 不再要求主模型手写六段 prompt，而是直接接收 `description`、`id`、`paths`、`goal`、
`context`、`non_goals` 和 `acceptance` 七个结构化字段。其中承载已验证架构事实的 `context` 最多
8000 字符，其余长文本字段最多 4000 字符；超限错误会同时返回标准化后的实际字符数，避免模型再用
shell 计数。宿主将这些字段编译成 Worker 的规范工作项，写入当前 Workspace 根目录及租约的精确绝对
editor 路径，并固定加入“只写租约路径、所有写入使用 editor、
禁止猜测其他根目录、禁止 shell/安装/网络/测试、由 Pro 验收”的约束。这样字段
错误会在启动前一次性返回，不会因标题拼写或段落格式消耗重复工具调用；安全的 `./index.html` 仍会
归一化为 `index.html`。同一份近场工作指引要求 Worker 只做有界实现、先确认接口与边界、避免重复读取，
并把每条推理分支收敛到具体编辑决定或一个明确缺口；续作则只处理 Pro 已给出的缺陷证据，不重新设计模块。

最多四个新 Worker；同一模型步骤最多启动两个。插件会拒绝重复 id、重叠路径、`**` 根租约和越界
写入。Worker 运行期间只增加 `apex_wait` 与 `interrupt_agent`；结算后仍只保留 `apex_wait`，直到它
返回持久证据，才增加 `apex_continue`；所有 Worker 均完成证据交接后才增加 `apex_takeover`。
`list_agents` 不进入模型工具面。Pro 的 editor 始终保留，未被任何
Worker 租用的 Workspace 路径可以继续编辑；租约内路径只有在 Worker 结算、Pro 查看实际文件并调用
`apex_takeover` 后才允许 Pro 修改。收到反馈并检查租约后，Pro 也可以用新证据续作原 Worker：

```json
{
  "child_id": "<apex_build 返回的 id>",
  "work_item_id": "water-renderer",
  "evidence": ["src/water.js 的 uniform 名称与 shader 不一致"],
  "instruction": "只修复这个 uniform 错配，保持其他 API 不变。"
}
```

模型不再手写 `APEX_CONTINUE` 首行和 JSON；宿主会校验 Worker 归属、work item、租约文件读取和新证据，再编译为子会话协议。
任意 Bash 输出不再单独算作续作前的复核证据。Pro 先把验收项映射到证据并合并同类检查；对无依赖的
小型单文件任务，初始预算是一遍租约文件读取和一个最小静态或运行检查。只有任务本身涉及相关风险，或
新证据暴露缺口时，才扩展到调用链、边界、状态/资源清理、用户路径和性能。仅仅“可以运行”不算验收完成；
确认具体缺陷后，用一次 `apex_continue` 续交同一个 Worker。每个必测断言在 `apex_state.checks` 中只有
`pending / failed / passed` 三态；新验证必须关闭 pending 项或重验 failed 项，不会因为“还能再看一下”重开 passed 项。
同一个真人任务的 Web 运行验收固定为同一个检查和同一份验收合同：一次 baseline、失败后至多一次
regression、修复后一次 final。换 `check_id` 或降低交互、时序、视口、FPS 等阈值都不能重置预算；
final 新发现的确定性页面异常、同一合同下的 FPS 门槛失败，或对最新一次通过截图给出的结构化
`repair` 视觉结论，都可在成功代码修复后开启 `repair-proof`。默认允许两轮；只有紧邻上一轮通过运行、
减少缺陷数量，或从 application-runtime 收敛到较低严重度的 performance failure 时，才开放第三轮。
同一运行时错误指纹修复后仍出现时，Flash 停止，下一轮必须先有 Pro 的直接成功修改。浏览器、超时、
清理、环境或网络阻塞单独只有一次不消耗修复轮次的复试；纯偏好和不确定视觉结论不能开启修复循环。

当 `apex_wait` 证明 Worker 达到 `max-tokens`、error/abort/refusal、没有成功写入，或一次 Worker 修复后仍得到
相同运行时诊断，Pro 可以在读取租约文件后调用 `apex_takeover`。final 暴露上述可修复运行时错误，或修复确实需要
Pro 承担时也可接管。接管要求当前所有 Worker 已结算，结果会把 work item 和路径作为持久工具元数据写入父会话；
随后该租约转交 Pro，原 Worker 永久禁止继续；其他 Pro 自有路径不受影响。缺少上下文是唯一阻塞时，
仍允许一次有证据的 Flash rebrief，避免把暂时的信息缺口误判成能力不足。

### 宿主级 `apex_validate_web`

`apex_validate_web` 面向已构建的静态 Web 目录。它不接受任意 shell 或 JavaScript，也不下载浏览器；宿主会：

- 在 `127.0.0.1` 的随机端口上短暂托管 `root`；
- 只查找本机已有的 Chrome / Chromium / Edge，通过 Harness `subprocess` seam 启动一个独立进程树；
- 关闭 Chromium 对无头后台页的 timer、occlusion 与 renderer 节流，并在结果中报告实际浏览器和图形渲染器；
- 有限等待页面就绪，收集 console、uncaught exception、network 和 HTTP 错误；
- 按需检查 selector / Canvas，派发有限键盘交互，对 `requestAnimationFrame` 做短采样，并可写入一张新的 Workspace 内 PNG；
- 无论成功、失败、超时还是取消，都关闭自己的 server、精确终止自己的 browser 进程树，并删除自己的临时 profile。

整个真人任务只允许一次 `baseline`；只有失败或阻塞后才能使用一次 `regression`，之后只剩一次 `final`。
final 之后，确定性 application-runtime failure、同一合同下的 FPS 门槛失败，或绑定最新通过截图的结构化
`repair` 视觉结论，在每次成功修复后默认可使用两轮 `repair-proof`。第三轮只有在紧邻上一轮通过运行、
缺陷分数下降或故障从 application-runtime 收敛到 performance 时开放，总修复复证最多三轮；同一运行时
指纹重复后要求 Pro 直接修改。网络、浏览器不可用、超时、清理失败或环境阻塞另有一次复试且不占修复轮次；
纯偏好或 `inconclusive` 不开启复证。所有运行必须复用 baseline 的 `check_id`、断言、root/entry、selector、交互、时序、视口与 FPS 门槛；只有
`mode` 和新截图路径可以变化。失败 regression 修复后可直接进入 final，不要求先把该运行检查伪装成
`passed`；其他验收项仍必须通过。返回的 FPS 只是无头浏览器 smoke 信号，不等于用户真实硬件性能结论。

Flash 不会收到额外 APEX 子代理长提示、自动 agent instructions、skill catalog 或 model-visible
delegation runtime context；权限与 sandbox 约束仍由 Harness 在模型外执行。普通租约内缺陷由原 Worker
修正；只有上述持久证据条件满足并显式接管后，Pro 才能修改转移的租约。v0.6.1 不内置递归 Swarm、
关键词分类器或额外路由模型。

代码子任务没有固定墙钟或绝对步骤上限，慢速 DeepSeek API 响应不会因为等待时间被插件取消。规范工作项
已经包含文件与工具边界，不再按步骤重复注入提示。只有自最近一次成功编辑后累计至少 12 次成功检查，且
最近 6 次都重复既有的同路径、同查询检查时，宿主才发送带 work item、实际成功写入路径和重复检查签名的
证据交接并停止该轮。读取新文件、提出新查询或继续产生成功写入都不会触发该交接。人工停止使用
`interrupt_agent`，只停止目标 Worker 当前轮次。

### 官方 V4 Flash Vision 只读复核

当运行时截图、渲染结果或参考图已经位于当前 Workspace，Pro 可以用精确查询
`{"query":"apex_inspect_image"}` 解锁视觉复核工具。一次调用接收 1–4 个 Workspace 相对路径，支持
PNG、JPEG、WebP 和 GIF，并要求给出一个明确的视觉问题。若一次通过的 `apex_validate_web` 已经写出
尚未审查的截图，宿主会在下一请求临时直接暴露该工具，省去额外搜索；对应截图产生视觉结果后自动收回。

宿主会通过官方 `spawn` provider 启动一次前台子任务，固定路由为
`deepseek-official/deepseek-v4-flash-vision-exp`，推理强度为 `max`，persona 为短视觉质量审查角色。
该子任务只看到 `read_image`，沙盒固定为 `read-only`，最多 12 个模型步骤；它逐张读取图片并固定检查
渲染伪影、曝光与可读性、材质区分、几何/对齐、用户可见需求和不确定性，返回
`pass / repair / inconclusive` 结构化结论。只有确定的用户可见阻塞缺陷可标记 `repair`；偏好和不确定观察不能。
Pro 继续负责代码修改、运行验证与最终判断。

该能力复用 Harness 的原生附件存储、图像校验和 DeepSeek 图片协议，不自行编码或复制图片，也不增加
新的依赖。它不是图像生成器，不允许视觉子任务写文件，也不会把主 Pro 路由变成多模态：APEX 主会话
仍应使用 V4 Pro；需要直接在主会话上传图片时，应另建使用官方 Vision 模型的会话。

### 研究由 Pro 主模型负责

v0.6.1 不提供 `apex_research`、通用 `subagent`、`subagent_fork`、`workflow` 或 `ralph`。Pro 自己
调用 `web_search`、判断来源和冲突，并通过上面的逐查询租约继续复杂研究。这样只有代码编辑能够
进入 Flash 子会话，研究与验收不会在两个模型间重复。

## 要求

- Node.js `>=22.19.0`
- 与固定基线兼容的 DeepSeek Harness

当前审查基线是 DeepSeek Harness `0.1.1-rc.1`，commit
`528c682e061696f5a160f363f236ecbf53cbd006`。v0.6.1 的 Minimal 双工具锚点仍与 rc.8
`141eb6fef83422698aef7a981029e843e8161534` 逐字节一致。完整来源与固定 commit 见
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

默认安装只维护当前实验版 `apex-v061`；正式对照使用 Harness 内置的官方 `minimal`。历史源码仍
保留在插件包中用于兼容性与回归检查，但不会再自动安装或把已卸载旧版本重新装回。最新一项日志为：

```text
[dsh-apex] installed and mount-validated preset "apex-v061"
```

相同内容已存在时，`installed` 会显示为 `existing`。安装器只创建缺失目录，不覆盖同名用户
内容；若新复制的 preset 挂载失败，只回滚该目录。

确认 bundle 已进入 profile：

```sh
dsh --profile web --dump-config
```

输出应包含 `minimal-max-preset-installer` 和 `dsh-minimal-max`。随后在 Web UI 新建会话并
选择“APEX v0.6.1（Pro 主导按需协作）”。已有会话不会自动切换 preset。

### 安全进程清理

v0.6.1 在工具实际执行前拒绝已知宽泛终止形式，包括 `pkill`、`killall`、
`taskkill /IM`、`Stop-Process -Name`，以及同一命令中的 `pgrep | kill` 和
`Get-Process | Stop-Process`。应记录当前任务启动的 PID，并使用：

```sh
kill -TERM 12345
```

Windows 对应使用 `taskkill /PID 12345` 或 `Stop-Process -Id 12345`。Guard 不增加首请求
prompt 或工具 schema。

持久 Bash 中的裸 `&` 后台运算符会被拒绝，避免后台输出破坏完成标记或留下无法归属的服务。
已构建的静态 Web 项目应直接用 `apex_validate_web`，不再临时编写 server/browser driver、不安装 Playwright / Selenium，
也不修改系统浏览器自动化设置。只有它不支持的动态服务才需自己组织有限 driver。
`playwright install`、`puppeteer browsers install` 等浏览器二进制下载会被拒绝；宿主验证器直接复用系统浏览器，
该受控宿主访问不放宽模型对 Workspace 外文件的通用读写边界。

直接运行 Chrome、Chromium 或 Firefox 的 headless smoke test 时，还必须使用独立于 Harness 工具
超时的进程 deadline。POSIX 可用系统 `timeout` / `gtimeout`，也可用前台
`subprocess.run(..., timeout=N)`；PowerShell 应使用 `Start-Process -PassThru`、
`WaitForExit(milliseconds)` 和 `Stop-Process -Id`。缺少这层保护的无头浏览器命令会在执行前被拒绝。
任一 shell 命令形状首次超时后，同一真人任务中不得通过只换参数再试同形操作。

任何依赖安装前，Pro 必须先成功读取现有 `package.json`、lockfile、`pyproject.toml` 或 requirements
文件；新建的无构建/单文件项目不能为了验证临时制造包环境。同一真人任务中，依赖清单没有发生可验证
修改时，同一条依赖安装命令只允许成功派发一次。Flash Worker 不能安装依赖、抓取远程源码或运行
headless browser；普通本地模块检查不受影响。

持久 Bash 中的所有 heredoc 都会在执行前被拒绝；短检查应使用现有测试命令或 `node -e` /
`python -c`，避免多行终止符让完成标记失步并消耗整个工具超时。Shell 也不能通过重定向、`tee`、Python/Node 文件写入 API、PowerShell
`Set-Content` / `Out-File` 等常见路径直接创建或修改源码、HTML、样式、文档和项目配置；这些写入
必须使用 `str_replace_editor`。同一真人任务中成功获取过的完全相同远程 URL 也会被拒绝再次获取，
应复用已有证据，并在扩展研究前先修复和复测已经确认的缺陷。路径扫描会忽略 HTML/XML
结束标签，`</script>` 不再被误识别成 Workspace 外的 `/script`。

## 使用 Standard 工具

通常只需描述任务。第一轮成功工具动作之后，模型会看到 `dev_tool_search` 和一次性短能力卡。知道精确工具名时，
一次调用即可解锁，例如：

```json
{"query":"apex_build"}
```

只有不知道工具名时才先做模糊搜索，使候选写入当前任务的持久结果：

```json
{"query":"web"}
```

然后每次只解锁一个此前发现的名称：

```json
{"toolNames":["web_search"]}
```

自然语言长查询也可以按命中词数量排序：

```json
{"query":"filesystem grep"}
```

一次最多返回 20 个白名单工具及首行说明，不会把整套 Standard schema 放入每次请求。成功解锁
从下一条模型请求生效，持续到下一条真人用户消息或本次 compaction。临时注册但不在当前
Standard 白名单中的外部工具不会被发现或解锁。

专用代码实现工具 `apex_build` 不走模糊搜索再解锁的两步流程；短能力卡会给出精确名称，模型以
`{"query":"apex_build"}` 一次调用即可解锁。通常无需手动调用 `apex_state` 或 `apex_build`；主模型会根据具体
任务需要使用。若需检查当前状态，可在晋级后调用 `apex_state` 的 `get` 动作。

视觉复核同样有精确名称，截图位于 Workspace 后可直接解锁：

```json
{"query":"apex_inspect_image"}
```

随后由 Pro 提交相对图片路径和一个聚焦问题；视觉子任务只返回证据，不修改文件。

## 跨平台状态

- macOS / Linux：复用 Harness 的 persistent Bash 与同一份 preset composition。
- Windows：复用 Minimal 的 persistent PowerShell，首请求工具名为 `pwsh`，无需 Git Bash fallback。
- Guard：同时识别 POSIX/Windows 宽泛终止命令，并以同一持久事件算法管理研究租约。
- Vision：三端都复用 Harness 原生 `read_image` 与官方 Vision 路由；Windows 仍需单独做原生端到端验证。
- CI：`cross-platform.yml` 会在 Ubuntu、macOS、Windows 上运行完整 `npm run check`。

Linux 与 Windows 只有代码合同和 CI 路径时，不视为已完成对应原生主机端到端验证。

## 自动验证

插件没有第三方开发依赖，不需要运行 `npm install`：

```sh
cd /path/to/dsh-APEX_Plugin
npm test
npm run check
```

验证覆盖：

1. 官方 rc.8 Minimal composition 与固定 commit 逐字节一致；历史版本继续锁定各自旧基线。
2. v0.6.1 根会话首请求使用官方 Minimal system prompt 与双工具，同时保留一条不含能力名的 Workspace 提示；
   晋级后才增加 broker 与一次性短能力卡。
3. `apex_state` 的输入边界、任务切换清零、跨 compaction 恢复、停滞提示和三态验收清单。
4. 第三次直搜后的逐查询租约、未使用租约阻塞、重复查询拒绝和超过旧上限后的继续续租。
5. 成功 Minimal 工具结果才晋级、短能力卡按 epoch 只出现一次、8/16 次无编辑 shell 探索的两级预算，
   broker 使用后预算仍生效，以及 `apex_build` / `apex_state` / `apex_validate_web` / `apex_inspect_image` 的精确按需解锁。
6. 代码与视觉子任务都只路由到官方 `deepseek-v4-flash-vision-exp` 并覆写为 Max；代码 Worker 固定为
   `workspace-write`，Vision 固定为 `read-only` 且只获得 `read_image`，两者都过滤无关自动上下文。
7. 结构化工作项编译、非重叠写入租约、每步/每任务 Worker 上限与越界编辑拒绝。
8. 七个必填工作项字段、`**` 整个 Workspace 租约拒绝、Pro 已编辑路径的租约冲突拒绝、未触碰独立路径仍可委派，以及 Pro 默认直接实现、不存在强制调度检查点。
9. Worker 持久化停止/用量/写入证据、错过 settlement 后的持久日志恢复、按生命周期显示的等待/续作/接管工具、Pro editor 常驻、租约内并发写拒绝和同一 Worker 接管后禁止再续作。
10. Flash 子任务无固定墙钟或绝对步骤上限；只有 12 次成功检查且最近 6 次重复旧证据时才触发宿主交接。
11. Pro 的需求映射、运行性、调用链、边界、资源生命周期、体验与性能复核职责。
12. 当前 Workspace 默认边界、最新真人消息的外部只读授权、任务切换清零、HTML 结束标签排除、外部写入拒绝，以及 POSIX / Windows 路径处理与 symlink 越界拒绝。
13. `apex_validate_web` 的 Workspace 路径、基线/失败回归/final、默认两轮且条件式扩展到三轮的 repair-proof、独立一次环境复试、运行/FPS/结构化视觉故障分类、loopback 服务、无浏览器降级和精确清理。
14. 宽泛终止、系统设置、裸 Bash 后台、超时命令形状重试、无 manifest 安装、带全局参数安装、重复安装、远程 URL 去重与 loopback 豁免。
15. macOS、Linux 使用 persistent Bash，Windows 使用 Minimal persistent PowerShell 的 composition contract。

如果插件与 Harness 不在默认相邻目录，可指定 checkout：

```sh
DSH_CHECKOUT=/path/to/deepseek-harness npm test
```

### 挂载验证

需要独立检查时可以指定临时 DSH home：

```sh
TEST_ROOT=/path/to/test-directory
TEST_HOME="$(mktemp -d "$TEST_ROOT/apex-v0.6.1-home.XXXXXX")"
DSH_HOME="$TEST_HOME" dsh plugin --profile web add /path/to/dsh-APEX_Plugin
DSH_HOME="$TEST_HOME" dsh --profile web --dump-config
DSH_HOME="$TEST_HOME" dsh web --port 0
```

检查 `.agent-presets/apex-v061/` 是否包含 composition、策略、Guard 和全部跨平台运行模块，并在
新会话中确认：

```text
1. 每条真人任务首次请求：可信 Workspace 提示 + 平台持久化 shell（`bash` 或 `pwsh`）+ str_replace_editor
2. 失败工具调用或纯 assistant/message 后：仍是 Minimal 双工具
3. 首次成功工具结果后：平台持久化 shell + str_replace_editor + dev_tool_search，并显示一次精确查询卡
4. 精确名称可一次激活；模糊查询需先列候选；Pro 已写路径不能租给 apex_build，未触碰独立路径仍可启动
5. Worker 运行和未取证结算状态只出现等待工具；取证后才出现续作/接管工具；Pro editor 始终存在
6. 下一条真人任务或 compaction 后：重新回到 Minimal 锚点
```

## 模型能力评测

结构正确与模型能力是两个独立验收层。建议使用同题盲测：

- A：官方 `minimal`
- B：`apex-v061`

保持同一模型端点、版本、推理强度、max tokens、题目、workspace 初始状态和权限。每组使用全新
会话并至少重复 10 次，记录完成率、硬性需求覆盖率、工具参数合法率、返工次数、输入/输出 token、
延迟、Flash 编辑次数、Pro 审查后发现的缺陷和修复轮数。比较 A/B 判断 v0.6.1 的净影响与额外
成本。不要以单次成功宣称普遍提升。

### 已发布的 pilot

- [2026-08-16 USP Match 四模式真实模型对比](https://github.com/GTC2080/dsh-APEX_Plugin/tree/main/benchmarks/2026-08-16-usp-match)：
  APEX v0.3、Minimal Max v0.2、官方 Minimal 与官方 Standard 的同题单样本测试。该记录为
  `n=1`，不代表稳定排序。

## 已知边界

- 动态提升按真人消息划分任务，不做语义任务分类或自动预测工具。
- Flash Max 编辑与 Pro 验收都是新的实验变量，必须通过重复 A/B 评测判断收益与副作用。
- 是否委派由主模型依据实际耦合度判断；插件不读取关键词，`apex_build` 不常驻，也不存在 Worker-first
  或第 8 步强制调度。默认路径始终是 Pro 直接实现；只有 Pro 已修改的具体路径会关闭租约。
- `apex_build` 最多运行四个可继续后台 Worker，但只有写入路径明确互不重叠时才允许并行；它不是
  自动无限 Swarm。能否发现并修复缺陷仍取决于主模型是否检查真实 diff、调用链和关键测试。
- 插件不设置 Worker 墙钟超时；Harness、provider、网络层或用户主动中断仍可能结束一次调用。
- `apex_state` 和其三态验收清单由模型主动维护，不是自动理解器；宿主只能限制验证预算，主模型仍需用真实工具结果校正状态。
- `apex_validate_web` 只服务于已构建的静态 Web 目录，不运行用户自定义 server command，也不把无头浏览器的 FPS 当作真实硬件 benchmark。
- `repair-proof` 只接纳确定性页面异常、同合同 FPS 门槛失败或绑定最新通过截图的结构化阻塞视觉证据；默认两轮、收敛时最多三轮，外部环境复试另计，但仍不是任意失败后的无限重试。
- 停滞检测是三次快照上的确定性启发式，不理解语义。
- 可续租并不保证每次新查询都有价值；当前通过“具体缺口、不同查询、单个未使用租约”和 Pro
  评审约束浪费，仍需用真实轨迹校准。
- Flash 为了保持官方 Minimal 首请求形状仍会看到平台 shell，但固定工作项要求不用 shell，Guard 会
  拒绝任意 Worker shell 调用，第一次工具调用后工具门也会移除 shell，避免重复尝试。所有代码写入只使用
  `str_replace_editor`。Pro 始终保留 editor，并可继续修改未租出的路径；只有 Worker 的未转移租约会被
  阻止并发写入。
- 状态化工具门和宿主复核改善的是执行轨迹约束；是否提高最终成品质量仍必须通过新的同题 A/B pilot
  验证，不能由结构测试直接推断。
- v0.6.1 的代码与视觉子任务都只使用 `deepseek-official/deepseek-v4-flash-vision-exp` 并设置
  `reasoningEffort: max`；纯文本 Flash 不再使用，也不会改写主模型。
  若未来 provider/model 目录不再支持该强度，请求会明确失败而不会静默降级。
- 视觉复核一次最多读取四张 Workspace 内的 PNG、JPEG、WebP 或 GIF；不接受外部绝对路径，也不自动
  修复代码。视觉判断仍可能出错，Pro 必须结合源代码和运行证据作最终判断。
- 进程 Guard 覆盖已知宽泛终止形式，并用轻量词法扫描识别未引用的 Bash `&`；它不是完整 shell 解析器。
- 工具白名单固定为当前 Standard 模型工具；Harness 新增工具时必须审查后显式加入。
- Windows 的 persistent PowerShell 路径来自官方 Minimal composition；真实 Windows 主机上的原生端到端表现仍需单独验证。
- Harness 升级若改变 Minimal 或 Standard composition，基线测试会有意失败，必须先审查差异。
- 删除 bundle 不会自动删除已安装 preset；停止 DSH 后应通过 preset 管理能力显式删除不再使用
  的目录。

## 研究依据与致谢

- [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)：最小必要实现、YAGNI 与
  复杂度约束思路。
- [xiaobright/modeltest](https://github.com/xiaobright/modeltest)：V4.1b 首请求工具形状与轨迹
  触发实验。
- [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)：
  Minimal 锚定、持久晋级和按需工具门控基础。
- [yjh051108/dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite)：首请求之外的
  模式选择与 Pro/Flash 分工设计启发。
- [yjh051108/dsh-router-standard](https://github.com/yjh051108/dsh-router-standard)：Pro 对控制类工具面
  更敏感、Pro/Flash 不能共用同一提示约束，以及必须验证真实 Harness 装配链的实验依据；v0.6.1 还借鉴
  Flash 中性 persona、同请求近场引导、决策收敛与小工具面的设计原则。APEX 未采用其关键词分类器或
  persona 路由实现，也未复制提示模块。
- [yjh051108/dsh-super-injector](https://github.com/yjh051108/dsh-super-injector/tree/c08136a526e7515dca106441e65cf7fccf63bbae)：
  有界续作、近场约束和防无效循环的设计参考。APEX 不使用其 injector、热重载、源码覆写或工具目录实现。
- [Tiger3807861189/J-Space-Cognition-Suite-V3.6](https://github.com/Tiger3807861189/J-Space-Cognition-Suite-V3.6)：
  Goal/Verified/Open/Next、停滞检测和压缩后任务连续性设计启发。
- [MoonshotAI Kimi Swarm](https://github.com/MoonshotAI/kimi-help-center/blob/master/en-US/agent/swarm.md)：
  主代理协调、边界明确的并行工作项和子代理结果回收设计启发。
- [DeepSeek Harness 官方 preset](https://github.com/deepseek-ai/deepseek-harness/tree/main/apps/cli/config/agent-presets)
  与[插件开发文档](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)。
- [DeepSeek Harness 官方 Vision 模型说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek/README.zh.md)
  与[原生图片输入实现说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-08-19-direct-deepseek-vision-input.zh.md)。

感谢以上作者和项目公开实验、代码与设计思路。APEX 是独立社区项目，不隶属于 DeepSeek，
也不代表 DeepSeek 官方背书。

## 许可证

MIT。第三方来源、采用范围与固定 commit 见 [NOTICE](./NOTICE)。
