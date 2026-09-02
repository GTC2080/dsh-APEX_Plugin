# DSH APEX Plugin

APEX 是一个 DeepSeek Harness 实验 preset。它保留官方 Minimal persona 与双工具首请求，
并由宿主在模型第一次行动前给出正确 Workspace。成功完成一次 Minimal 工具动作后，
默认只增加一个带精简名称目录的按需能力入口，并给出一句不含能力名称的证据缺口提示，不展开可选工具 schema；研究、代码协作、Web 运行验收、显式交付复核、视觉复核和持久状态
是彼此独立的可选能力，只在出现具体证据缺口时解锁。

当前开发版本是 **APEX v0.6.3（证据收敛）**。它继承 v0.6.2 的通用核心：不使用任务关键词分类，不预设任务必须
委派、搜索或做浏览器验证，也不再用全局 Shell 次数、安装前置、重复查询与固定研究租约
约束所有任务。Pro 默认直接工作，并先建立当前任务自己的不变量与完成证据。
当关键领域判断无法由 Workspace 证据或已检查不变量确定时，Pro 会明确一个证据缺口，按需发现研究能力，
把准确问题及其将影响的工程决策交给只读 Vision Flash 检索；子会话优先使用一手资料并返回来源映射、
实现约束、冲突和剩余缺口，主 Pro 再决定采纳、续查或升级复核。普通路径查找、本地代码检查和常规调试不触发研究。
真正独立且路径边界明确的实现租约可选择两个角色：隔离的单文件或冻结接口后的机械实现默认交给
Vision Flash Production；只有困难算法或紧耦合集成逻辑才交给 Pro Core。两者从首请求直接使用 Harness 官方 PTC，只向模型呈现 `run_code`，
不再先经过 Minimal shell 引导；父 Pro 始终保留架构、跨租约集成、验收和最终判断。
如果尚未开始实现且连续十二次成功调用都仍在只读调研，宿主只给出一次非阻断的收敛提醒：仍有明确
API、算法或领域事实缺口时可以继续查，否则先落下最小端到端实现。它不是研究次数上限，也不会拒绝工具。
如果同一解释器族已经完成两次各自至少 10 秒的试算，或连续完成六次短试算，
同时本轮仍无成功实现写入，宿主会建立一个可从会话恢复的计算检查点；Workspace 中原有代码、参考图或其他输入不会冒充本轮实现，不同类型命令也不会拼成阈值。
检查点后仍保留一次针对明确阻塞不变量的外部计算；该结果成功返回后，仅暂停不产生实现的解释器 Shell，直到交付物内容真实变化。
首次有效写入只发放一次临时计算租约；租约被一次成功计算消耗后，必须再次修改交付物内容才能续租，重复写入相同字节不会解锁。直接写入实现的 Shell 与 editor 始终可用。这不是墙钟、整任务 Shell 次数或思考长度限制，也不限制模型内部长思考。
验收项只来自用户或项目明确要求、本地合同以及已经观察到的具体缺陷。用户明确给出可量化要求时，
Pro 选择能直接覆盖相关状态的最低成本证据；插件不会自行添加 FPS、静止/移动路径或其他领域 Benchmark。
同一份仍有效的证据可以关闭它直接证明的多个检查，成品未修改时不会为了“final”重复运行相同验证。
v0.6.3 新增一个宿主侧、跨真人修复轮次的证据层：静态工件以 SHA-256 内容摘要识别实现代次，
运行验收阶段由宿主选择；视觉复核以图片内容、聚焦问题和稳定缺陷 ID 去重与续查。Vision 没有整任务
调用次数上限；只有内容和问题都相同的证据才直接复用缓存，工件、视角、状态、问题、未解决缺陷或矛盾变化时均可继续取证。
同一 Web 合同存在上一张已复核截图时，宿主会把它作为只读对照一并交给 Vision，要求明确报告当前目标、保留事实和新回归；
新截图路径不会再让同一视觉缺陷丢失稳定 issue ID。已经开启的 Web、Vision 或交付证据若落后于当前工件摘要，
宿主会在模型准备结束时追加一次有签名的当前代检查点；同一未变化缺口只提醒一次，避免无限自证。
自动运行验收、交付约束证据、视觉证据、Pro 的工程判断与用户验收仍是五个不同层次，不会互相冒充通过。
成品出现后，宿主会额外显示一个只读的 `apex_verify_delivery`：仅当用户或项目明确给出完整交付文件集合、文件数量、
文本字符上限或必备字面量时，Pro 才把这些约束原样提交给宿主检查。相同契约与相同工件直接复用证据，
失败时返回全部不合格项；它不解析任务关键词，也不会把文件/文本合格冒充为运行、视觉或领域正确。
v0.6.2 作为冻结的通用核心对照保留；v0.6.1 继续作为已锁定的工程特化实验保留。

## 可选 preset

| Preset id | 界面名称 | 用途 |
| --- | --- | --- |
| `apex-v063` | APEX v0.6.3（证据收敛） | v0.6.2 通用核心 + 跨轮工件、运行与视觉证据收敛 |
| `apex-v062` | APEX v0.6.2（通用核心） | Minimal 直接路径 + 互相独立的按需能力包 |
| `apex-v061` | APEX v0.6.1（冻结实验） | 工程特化的 Pro / 视觉版 Flash Max 有界协作对照 |
| `apex-v06` | APEX v0.6（实验） | Minimal 锚定 + Pro 主导验收 + Flash Max 有界实现与研究 |
| `apex-v051` | APEX v0.5.1（实验） | 极薄晋级策略 + 可续租直搜 + Pro 评审后的可续轮 Flash 研究 |
| `apex-v05` | APEX v0.5（实验） | 持久任务状态 + 有固定上限的 Pro/Flash 定向研究对照 |
| `apex-v041` | APEX v0.4.1（实验） | 自适应研究租约 + Standard 工具白名单 |
| `apex-v04` | APEX v0.4（实验） | 按任务动态提升 + 压缩恢复 + 跨平台 Guard |
| `apex-v03` | APEX v0.3（实验） | Minimal 锚定 + 一次性策略 + 按需 Standard 工具 |
| `minimal-max-v2` | Minimal Max v0.2（实验） | 不含 APEX 策略的稳定对照组 |

安装 v0.6.3 不会覆盖或改写任何早期 preset。包名继续使用 `dsh-minimal-max`，以保持现有
DSH profile 的插件升级路径稳定；界面产品名称使用 APEX。

## APEX v0.6.3 如何工作

```text
每条真人 user/message
  -> 请求 1：官方 Minimal persona + 平台持久 Shell + str_replace_editor
     + 一条不含能力名的宿主 Workspace 提示
  -> 只有成功的 Minimal 工具结果才晋级
  -> 请求 2 起：Minimal 双工具 + dev_tool_search；同轮给出一次极短证据缺口提示，唯一的精简能力目录内嵌在 broker schema 中
  -> Pro 默认直接完成任务，根据任务本身建立不变量、证据缺口与完成条件
  -> 只为明确要求、项目合同或真实缺陷建立验收项；可量化要求使用最低成本的直接证据
  -> 出现具体缺口时：单独搜索并解锁所需能力，不连带暴露其他 schema
  -> 外部资料缺口：Pro 定义问题与决策 -> Vision Flash 定向检索 -> Pro 判断来源适用性并决定实现
  -> 独立实现租约：Vision Flash Production 默认处理隔离单文件或机械实现；Pro Core 只处理困难算法或紧耦合集成
     -> 首请求直接进入 PTC -> 受限 SDK 修改租约路径 -> 结构化 report 交还父 Pro
  -> 存在明确文件/文本交付约束时：宿主直接复核文件集合、字符上限和必备字面量
  -> 代码 Worker、Web 验收、视觉复核、研究、持久状态互不代替对方的证据
  -> 下一条真人 user/message 清除临时解锁，回到 Minimal 锚点；同会话验收证据继续可核验
```

v0.6.3 的宿主守卫只保留通用安全与所有权边界：Workspace 内写入、Worker 非重叠路径租约、
禁止按进程名宽泛杀死、禁止自动下载浏览器二进制与修改系统设置。任务专属的安装、测试、
性能与验收预算由 Pro 结合仓库规范和真实证据决定，不由插件用固定次数代替。
POSIX Pro 可以直接使用官方 persistent Bash 已支持的闭合 heredoc；带引号的简单 `cat` / `tee`
正文按字面数据处理，重定向目标必须位于 Workspace 或系统临时目录的后代。缺失结束符会在派发前失败，
`$HOME`、`../`、外部 symlink 和可执行 heredoc 中真实文件 API 的其他外部目标仍由 Workspace 守卫拒绝；
Python / Node 正文里与文件操作无关的字符串、注释和嵌入代码不会被当成 shell 路径。
带前置 `cd` / `mkdir` 的闭合 heredoc 同样按实际命令与文件操作检查；普通非执行 `sed` 替换程序里的
斜杠文本、`sed` 地址正则和内联 `awk` 程序里的正则字面量不会被误当成文件路径，但真实外部文件参数以及 `sed` 的读写文件命令
仍会被拒绝越界。
长文件创建可用一次 heredoc，小范围修改继续优先使用 editor，不需要改写为 Python 绕行。
POSIX / Windows 持久 shell 返回的非零 `[exit code: N]` 会被 APEX 规范化为失败结果，避免会话把失败命令误记为成功证据；原始输出仍保留用于诊断。
`str_replace_editor` 的 schema 与首请求形状保持不变；DeepSeek Harness v0.1.2-alpha.3 保留了官方编辑器
入口兼容未使用可选字段的 `null` 占位，APEX 不再重复改写参数。其他参数类型、未读先改、
EOF 范围或重复创建错误仍收敛为一条命令特定的重试形状，避免模型围绕同一个协议错误连续试探。
Minimal 晋级后的一次性短提示会要求：首次修改一个已经存在的路径前，先用同一个 editor 查看一次；Shell 输出不替代
editor 的 freshness 观察。该提示不改变首请求工具形状，也不放宽宿主的未读先改保护。
`apex_validate_web` 的合同摘要会递归排序对象键；数组与值保持原顺序，因此等价的交互对象键顺序不会
消耗一次调用，而真实的 selector、交互、时序、视口或 FPS 变化仍被拒绝。模型不再提交
`baseline / regression / final / repair-proof` 模式；宿主根据固定合同、跨轮证据账本和当前工件摘要选择合法阶段。
任何来自 Bash、editor 或 Worker 的真实 Workspace 文件变化都会改变工件摘要；宿主截图位于 Workspace 外的临时证据仓，
因此不会伪装成产品变更。若旧版截图或其他文件实际遗留在 Workspace，交付文件集合检查会把它视为真实多余文件。

### Vision Flash 定向资料研究

`apex_research` 接收一个外部证据问题及它将影响的工程决策；可选字段只补充已知上下文和来源要求。
宿主把这些字段编译为固定检索模板，再通过 Harness 官方 `spawn` provider 启动
`deepseek-official/deepseek-v4-flash-vision-exp`，推理强度固定为 `max`。研究子会话为 `read-only`，
首轮只有 `web_search` 和结构化回报能力；没有文件读取/写入、Shell、代码 Worker、Vision 图像读取、工作流或用户交互工具。
纯文本 `deepseek-v4-flash` 不是回退路由。

搜索返回新 URL 后，宿主暂时隐藏继续搜索，并只开放一个内部来源读取器；若模型仍凭前一轮记忆调用已经隐藏的
搜索能力，执行期拦截器不会访问网络，而会以成功结果重新呈现尚未读取的来源并引导直接阅读。这既不是仅修改下一请求
schema 的软提示，也不会用失败工具结果消耗一次纠错。读取器只能读取当前研究子会话已经搜索到的
HTTP(S) URL，并采用公共 IPv4 校验、DNS 固定、同源重定向、无凭据请求、内容类型/响应大小/超时边界。
子会话若把返回链接改写为猜测的 canonical URL，读取器不会发起网络请求或把它记作证据，而会返回一个
`available: false` 的可恢复结果，要求改用搜索实际返回的精确 URL。
来源正文以不可信数据返回，不能作为指令。普通读取保持 512 KiB 响应上限；规范等大型文本可在首次读取时提供
1–8 个关键词，由宿主在 8 MiB 扫描硬上限内只返回相关的有界片段，模型不会收到整份大文档。
同一 URL 不会重复读取；成功读取一份新内容后才恢复搜索。
连续两次搜索都没有增加新 URL 时，宿主收起搜索，让子会话用现有证据提交 `partial` / `conflicted` 结果，
但新 URL 或新内容摘要会恢复进度。Harness 返回凭据缺失、provider 不可用或明确的 HTTP 4xx 时，
宿主会直接收敛；`429`、`5xx`、网络或其他未确定 provider 错误保留一次恢复机会，只有同一端点与同一错误再次出现才停止。
成功搜索会清除该失败状态；这里仍没有整任务固定搜索次数上限。

子会话必须把每条结论映射到可追溯的 HTTP(S) 来源，并返回结论摘要、实现约束、来源冲突和仍未解决的证据缺口。
它只负责检索，不能设计工程、修改代码或替主 Pro 宣布结论。主 Pro 检查来源是否适用于当前版本、单位、边界条件和实现，
再决定接受、拒绝或细化下一条问题。相同问题、决策、上下文与来源要求
直接复用会话证据；任一项发生实质变化即可重新检索，不设置整任务调用次数上限。主 Pro 的直接 `web_search`
保留给已经明确的一手来源或聚焦冲突，不承担泛化资料搜集。

## 冻结实验：APEX v0.6.1

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
  -> 全部检查通过 -> 当前工件代的运行、视觉与显式交付证据闭环；确定性缺陷修复后按新证据开放 repair-proof，不设固定总轮数
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

成功的首个本地工具动作之后只常驻 `dev_tool_search` 这一能力入口；同一轮只注入一句不含能力名称的提示，要求存在当前工具无法建立的明确证据时先解决该缺口，再起草兜底或宣布交付。精简能力目录只在该 broker 的说明中
出现一次，不再额外注入第二份目录消息，也不会常驻可选工具 schema。即使 Pro 已经修改主集成文件，目录仍可提示
`apex_build`；真正执行时，宿主只拒绝与 Pro 已成功修改路径重叠的租约。普通直接实现轨迹
不会看到 Worker、状态或浏览器验收 schema，也不会收到完整 APEX 策略。只有显式解锁 APEX 能力后，才注入
一段短的 Pro 主导说明。插件不设置全局 Shell 次数或墙钟预算；只有同一解释器族完成两次
至少 10 秒的长试算，或六次短试算，却仍无本轮成功实现写入时，才建立一次持久计算检查点；预先存在的参考素材与项目文件不会关闭它。检查点允许一个
明确阻塞项的计算结果；随后只拦截继续空转的解释器 Shell，写入 Workspace 的 Shell 和 editor 不受影响。每次经
SHA-256 指纹确认的内容变化只换取一轮纯计算；该轮成功后必须继续修改交付物才能续租，空壳文件和 no-op 重写不会永久解除阶段门。按需工具、最终交付和模型内部长思考均不受限制。
`apex_build` 不再常驻，且不再由步骤检查点强制调用。每个选择性 Worker 都在后台运行并拥有持久 ID。
`apex_wait` 先订阅 Harness 的 `subagent/end` 生命周期事件，再检查子会话持久日志；因此 Worker 已停止但
父会话遗漏 settlement 时也会立即恢复，不会永久等待。它不使用 Bash `sleep` 或 `list_agents` 轮询，也不增加 Worker 墙钟上限；结算后返回
本轮 stop reason、output tokens、步骤数、工具调用数、成功写入数、触及路径和 report 状态。子任务正常完成、
报错、达到模型限制或被中断时，Harness 会向 Pro 投递 settlement；Flash 也通过 child-scoped
`report` 返回完成内容、剩余工作和阻塞。插件不使用关键词分类器，也不要求某一步必须委派。

### Workspace 访问边界

APEX v0.6.3 默认只允许模型访问当前会话由用户选定的 Workspace。只有当前最新一条真人消息中
逐字写出的非文件系统根目录绝对文件或目录路径，才会成为该任务的一次性 Workspace 外只读授权：可以通过
`read`、`read_image`、`glob`、`grep` 或 `str_replace_editor view` 查看该路径及其后代；下一条真人
消息会重新计算授权。模型回复、工具输出、较早任务、历史测试、相邻 Workspace、Home 目录和搜索中
偶然发现的路径都不能扩大授权。

外部授权不包含写权限。Pro 的 shell 可以把解析后的系统临时目录根作为工作目录，文件与 shell 工具也可访问其
后代，供一次性脚本和中间数据使用；临时目录根本身仍不能被删除、覆盖或作为最终文件目标，最终交付、截图与
验收根目录必须位于 Workspace。进入临时根后，`rm -rf .`、`rm -rf *` 等整目录相对清理同样会被拒绝；明确的
临时子路径仍可删除。临时文件的回收由操作系统负责，APEX 不承诺立即清理。Flash Worker 仍只能修改自己的
Workspace 非重叠租约。`bash` / `pwsh` 不能借外部只读授权执行命令。守卫会规范化路径并检查已有
symlink 祖先，阻止从 Workspace 或临时目录内的既有链接跳到其他位置。命令位置上的绝对可执行路径只有在
它解析为当前 Node 运行时，或与宿主 `PATH` 已能解析到的同一可执行文件时才会放行；命令参数中的外部文件
仍按原边界检查。带 `PYTHONPATH=...` 等前置环境变量的 Python / Node heredoc 会先识别真实解释器，代码除法
不会再被误判为文件路径。
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

### 父 Pro / Pro Core / Vision Flash Production 分工

父 Pro 默认直接实现。只有已经确认某个范围可以独立交付且写入路径明确时，才通过
`dev_tool_search` 解锁 `apex_build`。Pro 可以先完成架构和主集成面；但任一成功修改过的文件都永久保持
Pro-owned，不能再租给新 Worker。工具 Guard 会按具体租约路径判断冲突，从而允许晚一点启动真正独立、
尚未触碰的叶模块，同时阻止主要工程完成后的重复施工。单文件交付物、强耦合整站实现和 `**` 整个 Workspace 都不得
委派。`apex_build` 复用 Harness 官方 `spawn` provider，以可继续后台方式运行，并把推理强度固定为 `max`：

- `flash-production` 使用 `deepseek-official/deepseek-v4-flash-vision-exp`，是隔离单文件或冻结接口后机械实现的默认角色；SDK 不含 POSIX `bash` 或 Windows `pwsh`。
- `pro-core` 使用 `deepseek-official/deepseek-v4-pro`，只负责租约内真正困难的算法或紧耦合集成决策；SDK 除编辑和读取外只开放平台 Shell 用于有界检查，Workspace 写入仍必须经过 editor。

纯文本 Flash 不再进入 APEX v0.6.3。每个实现 Worker 使用独立的短 persona `You are a helpful assistant.`，
不继承父 Pro 的完整 APEX policy。两类 Worker 从首请求直接使用 Harness 官方 child-scoped PTC：模型只看到
`run_code`，共同 SDK 包含 `str_replace_editor`、`read`、`read_image`、`glob`、`grep`，以及 Harness 在子会话内提供的 `report`。
每份初始或继续工作单都会附带已经填入 handoff id、revision、文件租约和 acceptance id 的严格单行报告模板；Worker 只需按实际证据调整值，不再猜测状态枚举、路径形式或 `decisions` 结构。
PTC 内部的 SDK 调用仍重新进入 Harness 工具管线、
APEX Guard 和路径租约校验，不是绕过权限的文件 API。官方 PTC 对 `read_image` 的调用会把原生图片上下文
交给视觉模型，只用于理解实现所需的 Workspace 证据，最终视觉验收仍归 Pro。Worker 没有网络、Git、委派、
工作流或用户交互工具。文件修改使用 Harness 原生 sandboxed filesystem，子会话固定为
`workspace-write`，即使父会话是 `danger-full-access` 也不会扩大权限。Harness 的 child-scoped
`report` 用于向直接父模型发送进度，不授予新的文件或命令能力。

`apex_build` 接收 `role`、`description`、`id`、`paths`、`goal`、`context`、`read_only_inputs`、
`interfaces`、`invariants`、`non_goals` 和 `acceptance`。宿主把它们编译为版本化 `APEX_HANDOFF`：
写入租约、只读输入的 SHA-256、冻结接口、命名不变量、命名验收项和非目标都进入首条不可变工作单。
宿主同时写入当前 Workspace 根目录及租约的精确绝对 editor 路径，并固定加入“只写租约路径、
禁止猜测其他根目录、禁止安装/网络/浏览器、由父 Pro 验收”的约束。这样字段
错误会在启动前一次性返回，不会因标题拼写或段落格式消耗重复工具调用；安全的 `./index.html` 仍会
归一化为 `index.html`。同一份近场工作指引要求 Worker 只做有界实现、先确认接口与边界、避免重复读取，
并把每条推理分支收敛到具体编辑决定或一个明确缺口；续作每次递增 handoff revision，只处理父 Pro 已给出的
缺陷证据，不重新设计模块。Worker 结束前必须通过官方 `report` 返回一行 `APEX_HANDOFF_REPORT`，列出实际
修改路径、完成的验收 ID、关键决定、未验证项、剩余缺口、blocker 和建议接手角色。宿主读取官方持久化的
`tool/code-dispatch` 事件，将声明路径与真实成功编辑逐项核对，并在结算时复核只读输入摘要；缺报、错报、
输入漂移或致命停止都会明确交还父 Pro，而不会让父模型猜测子会话发生了什么。

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
确认具体缺陷后，用一次 `apex_continue` 续交同一个 Worker。`apex_state` 只在长任务可能跨越上下文压缩时
保存任务级不变量与验收项，不再是 Web 验证的前置工具调用。第一次 Web 验收会自行绑定同一个检查和
同一份验收合同；此后模型继续提交相同合同，宿主以当前工件摘要自动选择 baseline、regression、final
或 repair-proof。已经通过且工件未修改时直接复用证据；失败后没有实际代码变化时也不会重复运行。
换 `check_id` 或降低交互、时序、视口、FPS 等阈值都不能重置证据账本；
final 新发现的确定性页面异常、同一合同下的 FPS 门槛失败、对最新一次通过截图给出的结构化
`repair` 视觉结论，或后续真人反馈指出的缺陷，都可在后续代码修复后开启 `repair-proof`。复证不再使用固定总轮数：
相同工件与相同证据直接复用，只有明确缺口和真实工件变化才能继续；视觉结果会标出是否解决旧问题、保留哪些事实以及是否引入新回归。
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
- 按需检查 selector / Canvas，点击一个可见 DOM selector、点击 Canvas 或派发有限键盘交互，并可在动作前后检查指定 DOM 文本；对 `requestAnimationFrame` 做短采样；运行到真实页面验收阶段后，从当前浏览器页面写入宿主临时证据仓，并返回 `.apex-evidence/` 下的逻辑 PNG 路径，不向交付 Workspace 增加测试文件；
- 无论成功、失败、超时还是取消，都关闭自己的 server、精确终止自己的 browser 进程树，并删除自己的临时 profile。

`assertion` 只是验收标签，不会自动执行其中描述的动作。每次调用都必须显式提交
`interaction_required`：只要验收依赖点击、输入、拖拽、按键或切换，就设为 `true`，并同时提供宿主实际支持的
`click_selector`、`click_canvas` 或有限按键动作；否则调用会被拒绝。DOM 状态变化用 `text_checks` 在
`before` / `after` 两个阶段核对。当前未提供通用文本输入或拖拽自动化，因此不得仅凭断言文字声称这些行为已经验收。

一次会话只绑定一份 Web 验收合同。第一次调用由宿主选为 `baseline`；后续调用仍提交相同的模型可见参数，
宿主会读取会话级证据账本，并对 `root` 中的有界交付文件树计算 SHA-256 摘要，然后选择
`regression`、`final` 或 `repair-proof`。模型工具 schema 中没有 `mode` 字段。已经通过且工件摘要未变时
复用现有证据；失败后摘要未变时也拒绝无效复跑。Bash、editor 和 Worker 产生的文件变化都由内容识别，
不依赖某个特定工具名。合同与证据可跨同一会话中的后续真人修复消息恢复；若要验收无关成品，应新建会话。
第一次结果元数据会直接绑定 `check_id`、断言、目录、交互、时序、视口与 FPS 门槛，
不要求模型先用 `apex_state` 重复登记这份合同。
final 之后，确定性 application-runtime failure、同一合同下的 FPS 门槛失败、绑定最新通过截图的结构化
`repair` 视觉结论，或后续真人反馈指出的缺陷在工件再次修改后，可按证据继续 `repair-proof`，不设置固定总轮数。
同一工件不会重复运行；同一运行时指纹重复后要求 Pro 直接修改。网络、浏览器不可用、超时、清理失败或环境阻塞另有一次复试；
纯偏好或 `inconclusive` 不开启复证。所有运行必须复用 baseline 的 `check_id`、断言、root/entry、selector、交互、时序、视口与 FPS 门槛；
每次获准运行都会在宿主临时证据仓自动分配新截图路径；模型只有在确需自定义逻辑文件名时才提交 `.apex-evidence/*.png` 形式的 `screenshot_path`。失败 regression 修复后可直接进入 final，不要求先把该运行检查伪装成
`passed`；其他验收项仍必须通过。返回的 FPS 只是无头浏览器 smoke 信号，不等于用户真实硬件性能结论。

Flash 不会收到额外 APEX 子代理长提示、自动 agent instructions、skill catalog 或 model-visible
delegation runtime context；权限与 sandbox 约束仍由 Harness 在模型外执行。普通租约内缺陷由原 Worker
修正；只有上述持久证据条件满足并显式接管后，Pro 才能修改转移的租约。v0.6.3 不内置递归 Swarm、
关键词分类器或额外路由模型。

代码子任务没有固定墙钟或绝对步骤上限，慢速 DeepSeek API 响应不会因为等待时间被插件取消。规范工作项
已经包含文件与工具边界，不再按步骤重复注入提示。只有自最近一次成功编辑后累计至少 12 次成功检查，且
最近 6 次都重复既有的同路径、同查询检查时，宿主才发送带 work item、实际成功写入路径和重复检查签名的
证据交接并停止该轮。读取新文件、提出新查询或继续产生成功写入都不会触发该交接。人工停止使用
`interrupt_agent`，只停止目标 Worker 当前轮次。

### 官方 V4 Flash Vision 只读复核

当运行时截图、渲染结果或参考图已经可用时，Pro 可以针对一个明确视觉证据缺口用精确查询
`{"query":"apex_inspect_image"}` 解锁视觉复核工具。一次调用接收 1–4 个 Workspace 相对路径，支持
PNG、JPEG、WebP 和 GIF；`apex_validate_web` 返回的逻辑 `.apex-evidence` 路径也可直接提交，并要求给出一个明确的视觉问题。宿主截图不会仅因生成就自动开启 Vision；没有未解决视觉要求时可直接复用运行证据。
待审宿主截图存在时，该轮视觉调用必须只读取这张真实浏览器截图；PIL、Canvas 或其他方式重绘的预览图不能替代、
混入或抢先关闭这条证据缺口。`.apex-evidence` 逻辑路径对应的宿主截图按不可变证据处理：宿主只向只读视觉子会话提供系统临时证据的实际读取路径，不创建 Workspace 映射；Shell 不能对它做裁剪、缩放或重绘，
需要看局部时应在问题中准确描述区域；不新增图像处理依赖。未记录的派生图不会被当作宿主证据。
宿主截图若返回阻塞缺陷，视觉工具会收起，等待 Pro 修改并由相同 Web 合同生成新截图；若通过且无剩余缺口，
该代截图证据关闭并复用。新的工件代次、视角、交互状态、明确未解决缺口或矛盾证据仍会重新开放取证，
同一截图后来出现另一个具体问题时也可重新精确发现一次视觉能力；参考图或下一条真人任务中的其他真实状态
不受旧截图关闭状态影响。阻塞缺陷不能靠重复发现绕过，必须先修改工件并取得新截图。
若新截图与同一合同下上一张已复核截图兼容，宿主会自动把旧图作为 comparison baseline 提供给只读子会话；
结构化结果同时返回 `targetStatus`、`preservedFacts` 和 `regressions`。旧图只用于比较，所有 finding 必须落在当前截图；
同一区域的缺陷可跨不同宿主截图路径复用原 issue ID，因此 Pro 能区分“真正修好”“仍未修好”和“修一处坏一处”。

Vision 采用与 `web_search` 相同的证据缺口原则，不设置整任务调用次数上限。宿主对图片内容与规范化后的
问题分别计算摘要：同一图片内容和同一问题会直接复用持久结果，不再启动子会话；图片、视角、交互状态、
聚焦问题、未解决缺陷或相互矛盾的结论发生变化时，可以再次检查。每个阻塞缺陷由宿主分配稳定 issue ID，
复查必须显式报告已解决 ID 与剩余缺口；同一工件出现 `pass` / `repair` 冲突时，下一次调用进入聚焦的
`resolve` 模式，而不是让 Pro 猜哪一次正确。

当同一工件代次的运行验收和最终宿主截图都已通过、结构化视觉缺陷与剩余证据缺口均为空时，工具结果会明确提示
Pro 检查尚未关闭的显式交付项和用户要求；这些也全部通过且没有新状态或矛盾时，应停止继续调用工具并交付。
这是一条证据闭环条件，不是思考时长、步骤数或 Vision 次数上限。

宿主会通过官方 `spawn` provider 启动一次前台子任务，固定路由为
`deepseek-official/deepseek-v4-flash-vision-exp`，推理强度为 `max`，persona 为短视觉质量审查角色。
该子任务只看到 `read_image` 与宿主 `structured_output`，沙盒固定为 `read-only`，最多 12 个模型步骤；它逐张读取图片并固定检查
渲染伪影、曝光与可读性、材质区分、几何/对齐、用户可见需求和不确定性，返回
`pass / repair / inconclusive` 结构化结论，以及 observation、inference、severity、confidence、已解决
issue ID 和剩余证据缺口。返回值由 Harness 的 `outputSchema` 约束，不再依赖解析自由文本 JSON。
视觉子会话仍以 `max` 强度完整检查，但只回传影响 Pro 决策的最小证据集：一个根缺陷只记录一次，正常或未受影响区域不作为 finding；
若一个阻塞缺陷使后续项目暂时不可判定，则只记录该缺陷并把具体缺失证据放入 `remaining_gaps`。这是一条输出收敛规则，不降低旧会话证据的宿主兼容上限。
非空画面、selector 存在或运行检查通过都不等于视觉合格；对完整作品截图还会检查主体是否完整、清晰、
构图与比例是否合理，以及核心空间关系和要求的行为是否可理解。
只有确定的用户可见阻塞缺陷可标记 `repair`；偏好和不确定观察不能。
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

当前本地兼容性审查对象是 DeepSeek Harness `0.1.2-alpha.3`，官方 tag commit
`dd6322d604e00eec1ba5e0c8541159906a21094a`。v0.6.3 的 Minimal 双工具锚点仍与该版本
逐字节一致，SHA-256 为 `c952e72ff87cb09e6d2700dcf806c6584a67cf867adcd103ec822a6c538d4f87`。完整来源与固定 commit 见
[NOTICE](./NOTICE)。

`0.1.2-alpha.3` 的原生 `read_image` 可以按文件签名识别无扩展名附件路径。APEX 因此允许无扩展名
`image_paths` 直接进入只读 Vision 子会话，同时对带扩展名路径继续只接受 PNG、JPEG、WebP 与 GIF；纯文本 Pro 父会话不会获得原生图片入口。插件不复制、
重命名或重新编码图片。该版本也允许 Harness 子会话续接携带图片，但 APEX 的代码修复续接仍保持
结构化文本合同，视觉证据继续走独立的只读 Vision 验收路径，避免扩大代码 Worker 的交接面。

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

默认安装只维护当前开发版 `apex-v063`；正式对照使用 Harness 内置的官方 `minimal`。历史源码仍
保留在插件包中用于兼容性与回归检查，但不会再自动安装或把已卸载旧版本重新装回。最新一项日志为：

```text
[dsh-apex] installed and mount-validated preset "apex-v063"
```

相同内容已存在时，`installed` 会显示为 `existing`。安装器只创建缺失目录，不覆盖同名用户
内容；若新复制的 preset 挂载失败，只回滚该目录。

确认 bundle 已进入 profile：

```sh
dsh --profile web --dump-config
```

输出应包含 `minimal-max-preset-installer` 和 `dsh-minimal-max`。随后在 Web UI 新建会话并
选择“APEX v0.6.3（证据收敛）”。已有会话不会自动切换 preset。

### 安全与 Workspace 边界

v0.6.3 在工具实际执行前拒绝已知宽泛终止形式，包括 `pkill`、`killall`、
`taskkill /IM`、`Stop-Process -Name`，以及同一命令中的 `pgrep | kill` 和
`Get-Process | Stop-Process`。应记录当前任务启动的 PID，并使用：

```sh
kill -TERM 12345
```

Windows 对应使用 `taskkill /PID 12345` 或 `Stop-Process -Id 12345`。Guard 不增加首请求
prompt 或工具 schema。

`playwright install`、`playwright@<version> install`、`puppeteer browsers install` 等浏览器二进制下载会被拒绝；
宿主验证器复用系统已有浏览器。当本任务已经成功写入 HTML，Pro 随后开始探测或安装
Playwright、Puppeteer、jsdom、Selenium、Canvas 仿真依赖，或自行搜索系统浏览器路径时，`apex_validate_web`
已经随成功 HTML 写入自动出现在下一请求，守卫会要求直接使用它。这条规则由真实工具轨迹触发，不读取用户
提示词关键词，也不会把浏览器工具常驻到非 Web 任务。默认交付写入仍发生在当前 Workspace；系统临时目录及后代
只用于可丢弃中间数据，用户在最新真人消息中明确给出的其他外部绝对路径只产生一次性只读授权。背景进程、依赖安装、Shell 编写与验收轮数不再被
插件的全局工程启发式一刀切限制；它们应遵循当前项目规范与任务证据。
Shell 路径检查会先排除网络 URL、脚本注释和语言运算符，再检查真正出现的路径；Workspace 内相对文件、
系统临时目录后代、带环境变量前缀的解释器 heredoc，以及命令位置上由宿主 `PATH` 解析出的绝对可执行文件
可以正常使用，`/Applications`、`../`、Home 别名和可执行脚本中的其他真实外部文件参数仍会被拒绝。

## 使用 Standard 工具

通常只需描述任务。第一轮成功工具动作之后，模型会看到 `dev_tool_search`；它的说明内含唯一一份精简
APEX 能力目录，但不会展开任何可选工具 schema。其他白名单 Standard 工具仍可按具体能力缺口模糊搜索；查询只返回最高相关度的一组候选，避免常用虚词把整个目录展开。
知道精确工具名时，
一次调用即可解锁，例如：

```json
{"query":"apex_build"}
```

只有不知道工具名时才先做模糊搜索，使候选写入当前任务的持久结果：

```json
{"query":"web"}
```

若非空查询没有词法命中（例如查询语言与英文工具描述不同），broker 会返回最多 20 个稳定排序的
allowlist 候选摘要，但不会自动解锁任何能力；模型仍须从结果中准确选择一个名称再次提交。该回退不读取
任务关键词、不增加额外模型调用，也不会把候选 schema 常驻到后续请求。

然后每次只解锁一个此前发现的名称：

```json
{"toolNames":["web_search"]}
```

自然语言长查询会过滤常用虚词，并只保留最高相关度候选：

```json
{"query":"filesystem grep"}
```

并列时一次最多返回 20 个白名单工具及首行说明，不会把整套 Standard schema 放入每次请求。成功解锁
从下一条模型请求生效，持续到下一条真人用户消息或本次 compaction。临时注册但不在当前
Standard 白名单中的外部工具不会被发现或解锁。

知道可选能力的精确名称时可一次解锁；不知道时先用中性需求搜索候选。插件不会因为任务看起来像
Web 开发、物理模拟或大型工程就自动解锁或强制使用它们。
精确命中或提交已发现名称后，结果会直接要求下一请求使用目标工具，不再同时给出“再次搜索”的矛盾提示。

视觉复核同样有精确名称；Workspace 图片或宿主返回的逻辑截图路径可直接解锁：

```json
{"query":"apex_inspect_image"}
```

随后由 Pro 提交相对图片路径和一个聚焦问题；视觉子任务只返回证据，不修改文件。
如果图片来自 `apex_validate_web`，视觉复核只接受最新一轮宿主截图，并同时校验截图 SHA-256 与对应
工件摘要；文件变化后旧截图立即失效。模型继续提交同一验收合同，宿主选择下一阶段、自动生成新截图并返回
baseline、regression、final、按证据开放的 repair-proof 与环境复试状态，不需要模型构造 `mode` 参数。

## 跨平台状态

- macOS / Linux：复用 Harness 的 persistent Bash 与同一份 preset composition。
- Windows：复用 Minimal 的 persistent PowerShell，首请求工具名为 `pwsh`，无需 Git Bash fallback。
- Guard：同时识别 POSIX/Windows 宽泛终止命令，不对根会话施加固定 Shell 或研究次数。
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

1. 官方 v0.1.2-alpha.3 Minimal composition 与固定 commit 逐字节一致；历史版本继续锁定各自旧基线。
2. v0.6.1 整树摘要不变，v0.6.2 保持冻结；v0.6.3 只作为新 preset 增加。
3. v0.6.3 根会话首请求使用 Minimal system prompt 与双工具，同时保留一条不含能力名的 Workspace 提示。
4. 只有成功 Minimal 工具结果才晋级；晋级后只常驻带唯一精简目录的 broker，并在同轮注入一次不含能力名称的证据缺口提示，不再额外注入重复目录消息或可选工具 schema。
5. 研究、代码 Worker、Web 验收、视觉复核和状态工具可独立解锁，不会相互带出 schema；新建代码 Worker
   从首请求只看到 `run_code`，其 PTC SDK 没有 shell，旧标签会话不会在恢复时被中途切换协议。
6. `apex_research` 固定使用只读 Vision Flash；搜索到新 URL 后必须先通过会话限定、安全有界的内部读取器检查直接来源，连续无新来源或确定性 provider 失败时收敛为结构化结果，瞬时失败允许一次恢复；相同证据请求复用缓存，变化后的缺口可继续检索。
7. 根会话可按任务需要使用后台进程、Shell 编写、依赖安装和重复研究；连续只读调研只触发一次非阻断提醒。同一解释器族两次长 Shell 或六次短计算后仍无本轮成功实现写入时，检查点允许一次明确阻塞项计算，随后要求先形成实现；预先存在的参考素材或项目文件不会冒充本轮实现，每次真实内容变化只发放一轮临时计算租约，no-op 重写、换解释器、压缩上下文或把求解器写入系统临时目录都不能永久绕过。
8. Workspace 路径扫描不会把网络 URL、脚本注释、`//` 运算符、内联 `awk` 正则，或带环境变量前缀的解释器 heredoc 中的除法误判成外部文件；shell 可进入系统临时目录根、使用其后代，并在命令位置调用宿主 `PATH` 已解析的绝对可执行文件，但删除或覆盖临时根及其他真实越界参数仍会被阻止。
9. 精确能力解锁不会要求重复搜索；成功 HTML 写入会直接暴露 Web 验收，宿主按工件摘要选择验收阶段。
10. 跨真人修复消息的 Web 合同、工件代次和截图有效性可从 session events 恢复。
11. Vision 使用宿主结构化输出，缓存同图同问，允许新工件、新视角、新状态、新问题和矛盾消解，不设整任务调用上限。
12. Workspace 外部只读授权、symlink 越界、Worker 租约、宽泛杀进程、浏览器下载和系统设置防护仍有回归验证。
13. 代码 Worker、资料研究、视觉子任务和宿主 Web 验收的成熟能力包保留原有合同，但不属于默认轨迹。
14. macOS、Linux 使用 persistent Bash，Windows 使用 Minimal persistent PowerShell 的 composition contract。
15. 工件形成后才显示显式交付复核；完整文件集合、文件数量、Unicode 字符上限和必备字面量逐项返回证据，越界路径、空合同与不受支持的 schema 关键字有回归保护。

如果插件与 Harness 不在默认相邻目录，可指定 checkout：

```sh
DSH_CHECKOUT=/path/to/deepseek-harness npm test
```

### 挂载验证

需要独立检查时可以指定临时 DSH home：

```sh
TEST_ROOT=/path/to/test-directory
TEST_HOME="$(mktemp -d "$TEST_ROOT/apex-v0.6.3-home.XXXXXX")"
DSH_HOME="$TEST_HOME" dsh plugin --profile web add /path/to/dsh-APEX_Plugin
DSH_HOME="$TEST_HOME" dsh --profile web --dump-config
DSH_HOME="$TEST_HOME" dsh web --port 0
```

检查 `.agent-presets/apex-v063/` 是否包含 composition、策略、Guard、证据模块和全部跨平台运行模块，并在
新会话中确认：

```text
1. 每条真人任务首次请求：可信 Workspace 提示 + 平台持久化 shell（`bash` 或 `pwsh`）+ str_replace_editor
2. 失败工具调用或纯 assistant/message 后：仍是 Minimal 双工具
3. 首次成功工具结果后：平台持久化 shell + str_replace_editor + dev_tool_search；仅显示精简名称目录，不展开可选 schema
4. 唯一匹配或精确名称可一次激活；歧义查询需先列候选；各可选能力包可独立解锁；工件存在后自动显示只读交付复核
5. Worker 运行和未取证结算状态只出现等待工具；取证后才出现续作/接管工具；Pro editor 始终存在
6. 下一条真人任务或 compaction 后：重新回到 Minimal 锚点
7. 新建代码 Worker 的首请求：模型工具面只有 `run_code`；SDK 仅含受限文件工具与 child-scoped `report`，不含 shell
```

## 模型能力评测

结构正确与模型能力是两个独立验收层。建议使用同题盲测：

- A：官方 `minimal`
- B：`apex-v063`

保持同一模型端点、版本、推理强度、max tokens、题目、workspace 初始状态和权限。每组使用全新
会话并至少重复 10 次，记录完成率、硬性需求覆盖率、工具参数合法率、返工次数、输入/输出 token、
延迟、Flash 编辑次数、运行与视觉验收发现的缺陷、来源质量和修复轮数。比较 A/B 判断 v0.6.3 的净影响与额外
成本。不要以单次成功宣称普遍提升。

### 已发布的 pilot

- [2026-08-22 Poolrooms 官方 Minimal 与 APEX v0.6.1 对比](https://github.com/GTC2080/dsh-APEX_Plugin/tree/main/benchmarks/2026-08-22-poolrooms)：
  官方 Minimal 成品 85/100；APEX v0.6.1 最新成品 83/100，但后者包含宿主修复与会话恢复，
  不能作为无偏收益样本。最新干净配对中 APEX 为 74/100，因此现有证据尚未证明稳定提升。
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
- `apex_state` 是可选的长任务压缩恢复记录，不是自动理解器，也不再是 `apex_validate_web` 的前置条件；主模型仍需用真实工具结果校正任务状态。
- `apex_validate_web` 只服务于已构建的静态 Web 目录，不运行用户自定义 server command，也不把无头浏览器的 FPS 当作真实硬件 benchmark；当前只派发 selector/Canvas 单击和有限按键，不支持通用文本输入或拖拽。
- 工件摘要单次最多扫描 8192 个常规文件和 256 MiB，仅忽略 `.git`、`node_modules`、`.cache`、`coverage`
  等非交付目录；宿主截图存放在 Workspace 外。更大的项目应把 `root` 指向有界静态构建目录，而不是整个源码仓库。
- `apex_verify_delivery` 不理解自然语言，也不会自行添加约束；Pro 必须只抄入用户或项目明确给出的完整文件集合、文件数量、
  字符上限和必备字面量。完整文件集合中的每个文件还必须进入文本检查，或明确列入 `content_unconstrained_files`；两者遗漏或重叠都会拒绝。
  字符数按去除首尾空白后的 Unicode code point 计算，必备文本按大小写敏感字面量匹配。
- `repair-proof` 只接纳确定性页面异常、同合同 FPS 门槛失败、绑定最新通过截图的结构化阻塞视觉证据，或后续真人反馈及其后的工件修改；没有固定总轮数，但相同工件、相同证据或没有真实修复时不会重复运行，外部环境复试仍单独有界。
- 停滞检测是三次快照上的确定性启发式，不理解语义。
- v0.6.3 不设整任务研究次数或查询租约；研究仅由无法从 Workspace 证据或已检查不变量确定的关键领域缺口触发。
  Vision Flash 负责检索与来源整理，主 Pro 负责适用性判断和工程决策；结构化来源不能保证来源本身正确，准确度与成本仍需用真实轨迹校准。
- 新建实现 Worker 直接使用官方 PTC，只看到 `run_code`；Vision Flash Production 的 SDK 不含 shell，
  Pro Core 的 shell 仅用于有界检查，所有代码写入通过 `str_replace_editor` 并继续受 Guard、sandbox 与租约约束。
  升级前已经持久化、没有 PTC 标签的旧 Worker
  为保持历史协议可恢复，不会被中途切换。Pro 始终保留 editor，并可继续修改未租出的路径；只有 Worker
  的未转移租约会阻止并发写入。
- 状态化工具门和宿主复核改善的是执行轨迹约束；是否提高最终成品质量仍必须通过新的同题 A/B pilot
  验证，不能由结构测试直接推断。
- v0.6.3 的 Pro Core 使用 `deepseek-official/deepseek-v4-pro`；Flash Production、资料研究与视觉子任务使用
  `deepseek-official/deepseek-v4-flash-vision-exp`。两者均设置 `reasoningEffort: max`；纯文本 Flash 不再使用，也不会改写主模型。
  若未来 provider/model 目录不再支持该强度，请求会明确失败而不会静默降级。
- 视觉复核每个子会话最多读取四张 Workspace 内的 PNG、JPEG、WebP 或 GIF；不接受外部绝对路径，也不自动
  修复代码。整任务没有 Vision 次数上限，但相同图片内容与相同问题会复用缓存；视觉判断仍可能出错，
  Pro 必须结合源代码和运行证据作最终判断。当前原生读取不提供独立区域裁剪 API，因此局部复核直接读取原始宿主截图并在问题中指定区域；
  只有真实分辨率证据证明这种方式不足时，才考虑扩展宿主原生区域读取，而不是恢复 PIL 重绘旁路。
- 进程 Guard 覆盖已知按名称宽泛终止形式；它不是完整 shell 解析器，也不阻止任务必需的有界后台进程。
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
  更敏感、Pro/Flash 不能共用同一提示约束，以及必须验证真实 Harness 装配链的实验依据；冻结的 v0.6.1 还借鉴
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
