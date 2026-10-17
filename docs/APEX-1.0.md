# APEX 1.0.1 开发与迁移说明

> 当前版本核验日期：2026-09-30

## 定位与边界

1.0 是通用任务增强插件，不是新的 Harness、执行循环、模型路由器或领域 benchmark 框架。只修改插件和必要的用户级注册／默认预设；官方源码、预设和构建保持不变。当前本地版本为 `dsh-apex@1.0.1`，预设 `apex-v1`，选择器显示 APEX 1.0.1。APEX 通过官方 `dsh-agent-preset-registry` 与 `dsh-agent-preset` 的 bundle 声明注册，不再复制旧式预设目录或运行安装器。

源码和 Git 目录中的旧安装器、历史预设和非 v1 测试将随版本清理；研究产物数据保留。当前元数据以 `presets/apex-v1/agent.cordis.yml` 为准，不再读取旧 `preset.yml` 或 `index.js`。新入口 `apex.js`，子路径 `dsh-apex/apex-v1/*`。不创建旧包别名。

## 原生能力与最小插件层

| 层 | 职责 |
| --- | --- |
| 官方 Host | 模型声明、工具注册、原生 PTC、沙箱、审批、文件版本、取消、会话、压缩、子代理、Teams 持久化 |
| 官方 PTC 组合 | 原生文件／搜索、一次性 Bash 或 PowerShell、Web、后台任务、计划模式、目标和交付工具 |
| APEX persona | 简洁的任务理解、复用、合理分工、基于证据的验收和结束原则 |
| `team.mjs` | 只在 APEX 预设内注册九个原生同名工具，服务调用沿用官方；等待采用可继续的短窗口并增加可选回执字段，不自建调度 |
| 原生 `apex_review` | 可选 one-shot 审查，继承主模型，独立 native 呈现，仅允许 `read`、`read_image`、`glob`、`grep`，不提供 PTC `run_code` |
| `validation.mjs` / `artifacts.mjs` | 按需启动独立无头浏览器，执行明确检查，记录执行时间、参数、产物与截图身份，释放自有运行资源 |
| `evidence.mjs` | 按需读取当前会话的实际工具事件，区分 PTC 子调用与外围程序结果；现有 `eventAt()` 调用保留至官方提供适用的分页替代接口，不新增同步历史读取封装 |
| `bash.mjs` | 仅 macOS，执行前按原生声明拒绝额外参数，argv 扩展点追加 Seatbelt 信号限制；原生工具声明、文件策略、审批、超时与进程管理不变 |
| `script.mjs` | 在同一个受保护的 macOS 执行器下提供可选 stdin 脚本入口，复用原生权限 API、结果 schema 和显示，不自建进程管理器 |
| `file-tools.mjs` | 为嵌套图片依赖绑定隔离文件服务，文件工具实现、schema 和图片交接继续复用官方代码 |
| `cancellation.mjs` | 原生 host-only 会话投影维护取消状态，pre-step 阻止用户取消后的自动通知启动模型请求；不增加持久化队列或调度器 |

`tools.mjs` 共用原生注册、输入校验及调用示例。完整约束由现有 Zod 校验；Harness 当前不支持展示的 JSON Schema 数值／长度上限转换为字段说明。对 schema 允许空对象的工具，在官方生成的 SDK 工具说明中提供 `await tools.<name>({})` 示例；参数全可选不等于可以省略参数对象。`tools.list_agents()` 会在进入插件前被原生 PTC 拒绝，`as any` 不会改变这一行为。参数不会被自动改写，失败不会被替换为成功；调用说明降低歧义，不保证模型永不误用。

Zod 联合类型拒绝时展开分支的相对字段路径，优先展示错误较少的备选分支；最多八条、每条 512 字符。只是错误展示排序，不选择、改写或放行某个分支。例如 `hold_ms:2500` 明确指出 `interactions.0.hold_ms` 必须不超过 2000，保留原始参数和拒绝结果。

首轮直接 PTC，没有 Minimal 引导或手写 PTC 提示词拼接。SDK 出现的长工具声明由官方生成，不是逐轮重复 APEX 注入。原生权限／环境 context snapshot 保留；不把官方安全上下文误判为插件污染。

## 独立模式与同进程切换

APEX、官方 PTC 和 Minimal 可以在同一个 Host 中共存。通过原生预设选择器切换空白会话；已开始的会话仍受官方 `agent-preset/locked` 限制，新建会话即可选择其他模式。不需要关闭 APEX、修改补丁或重启 Host 才能使用官方模式。更新插件 JavaScript 包后的重新加载属于版本升级，不属于日常模式切换。

`apex-execution-services` 与 `apex-session` 使用官方 Cordis 的同名隔离作用域，APEX 的文件、沙箱、子进程及临时目录服务只供该组合使用。原生 `subprocess`、`sandbox`、`fs-sandbox` 始终启用，官方预设使用这些原生实例。

保留工具 `run_code` 共用 Host 入口，不能仅靠预设作用域选择执行后端。因此 bundle 保留原生 `ptc-runtime` 条目及其配置，将它放入独立命名作用域，并在公共 `PtcRuntime` 接口上增加按会话预设分流的适配器。官方模式委托原生实例；APEX 使用同一官方 Node 运行器类、同一份经验证的配置，在 APEX 服务作用域中创建的实例。不会按调用改写全局服务、复制官方执行循环或修改 Harness 源码。此适配器是 Host 插件层的一部分，不宣称安装 APEX 后 Host 完全没有扩展。

`test/apex-v1-mode-isolation.test.mjs` 覆盖同进程多次选择、Minimal 持久终端、开始对话后的预设锁定、原生服务身份、运行器配置继承，以及 APEX/PTC 并发执行时的文件和进程归属。与临时目录、取消及清理回归一起验证；这些检查使用脚本化模型响应，不证明真实模型质量提升。

## 会话私有临时目录（macOS）

APEX bundle 在独立的 `apex-execution-services` 作用域中注册 `apex-temporary-runtime`、`apex-temporary-sandbox`、`apex-temporary-fs`，复用同版本官方服务。APEX 专属文件／沙箱配置放在对应条目上；原生条目的自定义配置继续用于官方模式，不会自动复制到 APEX 专属后端。APEX 之外不创建私有临时目录。不修改官方源码、模型或权限默认值。

仅 macOS APEX 的 `workspace-write` 将写入范围收窄到工作区与当前会话的随机私有目录。Bash、`apex_run_script`、PTC 共用 `SandboxProvider`；`TMPDIR`、`TMP`、`TEMP` 指向私有目录，原生 Node PTC 仍保持可见 `process.env` 为空，但 `os.tmpdir()` 返回当前私有目录。工作区和私有目录本身不可移除，内部文件仍可正常清理。工作区不得包含共享临时根目录，也不得与 Host 私有容器重叠。读取权限没有收窄，不承诺跨会话读取隔离。`read-only` 仍禁止写入；显式批准或配置的 `danger-full-access` 保留原生文件豁免，不能将其作为隔离状态使用。

任务可以要求比沙箱更窄的文件范围。若要求全部文件留在工作区，测试夹具也必须留在工作区，不能因私有临时区可写而使用它。macOS 的裸 `mktemp -d` 可能优先选择系统临时目录，不能仅凭已设置 `TMPDIR` 推断创建位置。APEX 运行上下文提供两种显式模板：允许私有临时文件时用 `apex_tmp=$(mktemp -d "${TMPDIR%/}/apex.XXXXXX") || exit 1`；工作区内用 `apex_tmp=$(mktemp -d "./.apex.XXXXXX") || exit 1`。这些写入示例仅适用于任务与沙箱均允许写入的情况；创建失败立即结束，不继续生成无效检查结果。清理范围限于实际创建的随机目录，不能先删除猜测的固定目录。`workspaceOnly` 仍允许删除工作区内已有子目录，无法替命令判断文件归属；本地回归已确认固定路径预清理会删除该路径中的既有内容。

Bash 验证命令接 `tail`、`head` 或 `grep` 时，应显式使用 `set -o pipefail`，或在管道后立即保存 `${PIPESTATUS[0]}` 并检查、传递被测命令状态；预期的非零状态需单独处理。过滤器成功、末尾命令成功或 `|| true` 均不能证明测试成功。这些是 APEX 的调用指引，不会自动修改传入命令、全局打开 `errexit/pipefail`、扩大权限或改变原生工具返回值。本地回归运行真实示例，验证成功、失败即停和合法非零处理；指引进入请求不证明真实模型必然采用，也不代表稳定效率增益。

负向测试副本也通过 `apex_run_script.argv` 单独运行；PTC 负责准备副本、保留完整程序结果和清理。先确认正常测试通过，再运行故意失败副本。下例用于工作区中自包含的 `solver.mjs` 和 `solver.test.mjs`；实际项目需复制测试所需文件，并沿用其运行器。测试退出 1 与 PTC 成功验证这个预期可以同时成立，清理结果单独判断。

```js
// APEX negative-test example
const fs = await import('node:fs/promises');
const path = await import('node:path');
const assert = (await import('node:assert/strict')).default;
const directory = await fs.mkdtemp(path.join(process.cwd(), '.apex-failure-'));
let result;
try {
  for (const file of ['solver.mjs', 'solver.test.mjs']) {
    await fs.copyFile(file, path.join(directory, file));
  }
  await fs.appendFile(path.join(directory, 'solver.test.mjs'), "\nimport {test as negativeTest} from 'node:test';\nimport negativeAssert from 'node:assert/strict';\nnegativeTest('APEX deliberate failure',()=>negativeAssert.equal(1,2));\n");
  result = await tools.apex_run_script({
    argv: ['node', '--test', '--test-reporter=tap', 'solver.test.mjs'],
    workdir: directory, description: 'Run the deliberate assertion failure',
  });
  console.log(JSON.stringify(result));
  assert.equal(result.exitCode, 1);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout.text, /^not ok \d+ - APEX deliberate failure$/m);
  assert.match(result.stdout.text, /^# fail 1$/m);
  for (const field of ['cancelled', 'skipped', 'todo']) {
    assert.match(result.stdout.text, new RegExp('^# ' + field + ' 0$', 'm'));
  }
} finally {
  await fs.rm(directory, { recursive: true, force: false });
}
return result;
```

准备失败会抛错，清理仍针对本次创建的目录执行；清理失败也会抛错。创建失败时没有目录可清理。运行器未启动、超时、信号终止或其他测试失败均不能当作这个预期断言的验证成功。以上不会自动识别任意 Shell 包装内部的子进程状态。

Host 通过原生 Session 的实际 preset 投影判断适用范围，首次需要时分配目录；并发调用复用同一条记录。主会话与 fresh／fork 队友各有目录，同一 Host 内的卸载和冷恢复复用原目录。回合结束、idle、取消及 agent disposed 都不会提前删除仍可被后台任务使用的文件。正常 Host 关闭时拒绝新进程启动，对同一份受管句柄快照逐项尝试终止、等待退出，再检查目录身份并精确删除；重复关闭复用同一结果。无法确认退出或目录身份改变时不开始删除；删除本身失败时可能已经部分删除，不承诺完整保留。强制杀死 Host／系统崩溃不能保证回收；官方 CLI 的关闭超时或重复中断也可能触发强制退出。插件不扫描删除其他运行实例的目录。重启后分配新目录，通过原生已记录的 runtime context 告知模型；需要跨重启保留的内容应放在工作区。

关闭从入口开始共享 3 秒局部预算；身份检查后至少还需 250 毫秒才开始删除。固定版本官方 CLI 有 5 秒全局关闭上限，但插件无法获知其剩余时间，因此不保证总能在 Host 强制退出前完成。递归删除不支持取消，实际等待其结果，不以超时竞争伪装删除已经停止。目录身份检查是删除前检查，不是原子删除事务。

插件直接向标准错误写入 `APEX temporary cleanup: ` 前缀的有界结构化记录，含开始／完成／失败、阶段、精确容器路径，以及 `managedProcessExit` 和 `directoryCleanup` 两种状态。`confirmed` 只表示原生受管范围观察成功；`removed` 仅在删除实际完成后记录。观察失败为 `unknown`，未开始删除为 `not-started`，删除中／失败为 `incomplete`。日志通道失效仍继续尝试资源清理；Host 被强制终止或终态日志缺失时，受影响状态仍未知。退出码 0 不能证明无进程或文件残留，原生 macOS 进程范围观察也不保证覆盖逃逸后代。persona 会要求保留已确认事实、仅将受影响状态标记未知；首请求检查证明指引进入模型上下文，不证明模型总会遵守。

宿主 `write/edit` 在 macOS APEX workspace-write 下通过短时受限 Node 子进程调用官方 `LocalFileSystem`。同一文件的所有 Host 变更使用 FIFO 排队；原生创建检查、stale version、换行与原子发布逻辑保持。路径校验后再替换祖先目录，后续文件系统调用仍受内核策略约束。子进程只接收固定操作及结构化数据，不执行模型提供的程序。修改增加一次进程启动；30 秒上限从 worker 准备阶段开始，不包含此前的 FIFO 等待和初次路径解析，响应按文件／输入大小限制。排队中的取消立即向调用方返回 `FS_ABORTED`，该项仍保留队列位置直到前项结束，再跳过执行；取消不会让后项越过尚未完成的写入。运行中的 worker 取消仍终止并等待受管进程退出后返回。进程异常或取消可能发生在发布之后，错误会要求重新读取目标，不能假定文件一定未改变。

在 live profile 的用户补丁中设置下列条目并于无任务运行的维护窗口重启，可以关闭新增隔离、恢复原生临时写入范围，无须更改会话或迁移文件。重新开启同样需要重启：

```yaml
- id: apex-temporary-runtime
  config:
    privateTemp: false
```

`privateTemp` 默认 `true`，只影响 macOS APEX；关闭时不分配目录、不添加临时目录上下文，文件和进程沙箱委托原生实现。自定义 sandbox runner 无法满足原生 Seatbelt 参数约定时明确拒绝，不静默运行无保护代码。当前实际验证环境为 macOS / Node 24；Linux／Windows 和 Node 22 未实测。

### 可选的工作区写入限制

任务明确要求测试夹具也留在工作区时，可在用户补丁中指定工作区，并在无任务运行的维护窗口重新加载：

```yaml
- id: apex-temporary-runtime
  config:
    workspaceOnly:
      - /absolute/canonical/task-workspace
```

`workspaceOnly` 默认 `false`；保留 `true` 对全部 APEX 会话启用的原有行为，也接受非空的工作区路径列表。列表项必须是已存在的规范绝对目录，不能是符号链接、相对路径或目录前缀。只匹配会话的工作区根目录，不自动包含子目录或同名前缀目录；同一根目录的任务共享该限制。加载时保存目录身份，后续发现配置目录被替换就拒绝执行，不静默回退到默认范围。配置要求 `privateTemp: true`，当前只支持 macOS Seatbelt；无效配置会拒绝加载。

选中的 APEX 会话在 `workspace-write` 下通过现有沙箱限制 Bash、`apex_run_script`（含 `argv`）、直接 PTC 和 `write/edit` 的文件写入；工作区外的私有／共享临时区也不可写。`TMPDIR/TMP/TEMP` 与 `os.tmpdir()` 指向会话工作区，文件工具提前返回 `FS_SANDBOX_DENIED`。未选中的 APEX 会话保留默认私有临时区；官方 PTC／Minimal 不受该配置影响。

配置来自 Host 配置文件，作用于新建、恢复及 fresh／fork APEX 会话；按工作区选择，不是逐会话开关，也不会自动解析任务文字。`read-only` 仍拒绝写入。显式批准或配置的 `danger-full-access` 保留官方豁免，上下文会明确提示 `workspaceOnly` 已失效；需要工作区限制的任务必须保持受限模式。已有管道退出码处理仍由调用方负责。

这是任务代码和文件工具的写入限制，不是读取隔离或所有 Host 写入的限制；会话日志、浏览器验收设施和生命周期管理仍使用 Host 存储。既有私有容器保留用于身份核查及统一清理，但受限任务不能写入其中。工作区夹具属于任务文件，Host 关闭不会删除它们；任务应只清理自己创建的目录。将 `workspaceOnly` 改为 `false` 或删除该项后重启，即恢复默认私有临时区策略，无文件迁移。

本地组件验证覆盖真实文件拒绝、指引、模式边界、卸载恢复、fresh／fork 和重新加载相同配置后的 Host 恢复。配置和现有服务正式连通；全 profile 启动及真实模型采用仍需单独验证，不能由这些检查推断稳定收益。

定向验证：`node --test test/apex-v1-temporary.test.mjs test/apex-v1-lifecycle.test.mjs test/apex-v1-review.test.mjs`。组件夹具使用官方运行时包解析；不读取 live Home 的配置、凭据或依赖链接，临时工作文件与脚本化会话记录集中在可回收夹具内，不设置第二个 `DSH_HOME`、不挂载真实模型适配器、不启动另一个应用。测试覆盖真实 registry 创建／恢复、fresh／fork、后台 jobs、取消、Host 关闭后恢复、目录替换、版本冲突和关闭开关。全 profile 验证必须另外走官方 CLI，组件通过不能替代实际启动。

2026-09-16 初次正式集成验收（本轮生命周期修复前）：完整 APEX 回归 142/142，无失败或跳过。沿用原 live Home 的官方 CLI 实际加载三个新服务，16 个安装文件与源码一致；固定 PTC／Bash／stdin／write／edit 调用和共享临时区哨兵检查通过，真实模型调用为 0。分别验证无运行进程和仍有一个受管进程时的正常停止，退出码均为 0，进程停止且私有容器删除。安装前后的官方客户端构建校验和用户配置摘要保持一致。该结果证明工程集成行为，不表示模型产物质量或推理能力提升。

2026-09-16 生命周期修复验收：完整 APEX 回归 154/154，无失败或跳过。新增 12 项生命周期检查覆盖排队取消与 FIFO、运行中 worker 取消、同步启动与关闭交接、关闭重入、诊断通道异常、终止／退出观察失败、身份变化、预算不足与部分删除；父代理首请求包含状态表述约束。正式 CLI 的五项故障注入均产生可见失败终态及精确路径，其中观察超时约 3.06 秒，未触及该次运行的 5 秒 Host 上限。另一次只对自有 CLI 的强制终止仅产生开始记录，清理终态仍未知。无真实模型请求；该验收不证明模型能力或自述准确率提升。

## Teams 与审查

九个工具：`spawn_teammate`、`send_message`、`list_agents`、`wait_agent`、`interrupt_agent`、`team_task_create`、`team_task_list`、`team_task_get`、`team_task_update`。

- 自主组队仅适用于 APEX，简单任务自己完成；用户或项目后续的单代理要求优先。fresh 默认，fork 继承完成的前缀，复用已有成员。
- 原生服务是团队状态唯一来源；任务依赖不自动启动负责人。修改前读取最新 revision，过期修改按原生 CAS 拒绝。
- `writeScopes` 是协作提示，不是锁。共享文件冲突仍由原生文件版本检查和主代理最终集成处理；Shell、格式化器等也需要协调。广泛发现测试前先等所需测试入口及导入文件就绪；期间可检查明确已就绪的独立测试，但不能把部分通过当成最终验收。
- 修改已观察文件时优先原位 edit/write，不为普通修订删除重建目录。Shell 删除不会清空原生文件观察；删除后的 `FS_STALE_VERSION` 保持拒绝。必须重新观察并根据当前状态决定如何修改，不自动刷新版本再强写，也不绕过其他写入者的保护。
- 消息 `accepted` 和 `queued` 都是持久收据；queued 不确认立即投递，不能因此重发或为同一工作建立替代队友。空闲队友可结束运行实例并保留 inactive 成员；后续消息由官方冷恢复，不要求 APEX 持有私有 Agent 对象。
- `list_agents` 在既有 `diagnostics` 中显示各成员尚未记录投递的消息数，直接读取官方 `agentTeam` 投影的消息与 delivered 集合，不缓存或重新扫描历史。计数表示等待投递记录，不表示已经执行或已完成；诊断不包含消息正文。原生确认投递后，该诊断消失。
- 没有活跃队友时 APEX `wait_agent` 返回 noProgress 并附带成员诊断；不会自动唤醒或反复轮询。存在排队工作时应报告投递阻塞，不能将 inactive 当成团队已完成。取消沿用原生信号，中断不删除历史或 roster。官方冷恢复仍可能执行之前排队的消息，本次改动不清空队列或保证模型不再重复委派。
- `wait_agent.timeout_ms` 保留原生 10,000～3,600,000 ms 输入范围和默认 30,000 ms，但每次实际等待上限为 60,000 ms。较长请求增加可选 `waitWindow: {requestedTimeoutMs, effectiveTimeoutMs}`；`timedOut` 表示实际窗口到期，不表示队友或项目超时。无活跃队友仍立即返回 no-progress，非法值仍拒绝，活动变化和取消仍走原生服务。
- 单独执行 `return await tools.wait_agent({timeout_ms:60000});`，返回模型后重新查看状态，必要时再等。原生 PTC 的 600,000 ms 单次上限没有修改；若模型在同一程序循环多次等待或先运行很长的其他操作，仍可能触及该上限。当前官方接口不暴露运行剩余时间，本插件没有伪造动态剩余预算，也不读取运行器私有状态；自定义更短 PTC 上限需要相应缩短等待。
- 审查代理按实际工具可见性排除组队提示词；继承的只读子会话不能因为原生服务将其视为独立 root，就获得自主协作指导。APEX 通过官方 `AgentOptions` 创建标记与串行等待的 `agent/created` 钩子，在首次请求前为审查子代理设置 `tools.presentAs('native')` 并限制读取工具。只靠 `toolFilter` 不能阻止 PTC 直接导入 Node；现在同时去掉这一执行入口，冲突时拒绝创建，不退回 PTC。主代理、Teams 和其他预设不切换模式；没有新沙箱或调度器。这限制的是审查模型的调用能力，不是整个 Harness 进程的系统级安全隔离。
- 与新官方 Teams 工具一致，队友身份在创建时的 prompt 单独给出，不把角色、名称和 Team ID 拼入共享系统策略。保留 APEX 的自主协作与只读审查排除规则，不复制官方工具层的全局安装副作用；共享前缀更稳定不等于已证明付费模型质量或成本提高。
- 官方 Teams Web 面板由 Host 注册一次，可在其他模式可见；不意味着其他模式获得 APEX 工具和策略。

### 审查能力说明与反馈交接

现有 APEX persona 在父代理首请求中明确 `apex_review` 只读，不能执行命令、写入临时文件或委派。当前官方 `tool-subagent.Config` 不支持自定义工具描述，SDK 仍由官方生成；APEX 在原有 persona 中限定本实例的用途，不伪造配置项、不改写官方工具定义，也不增加逐轮消息。

审查反馈应引用文件位置或图片及支持证据，说明影响，给出能够确认或反驳发现的最小反例／检查，并区分观察、静态推断和未执行建议。没有支持证据时可以报告不确定或无发现，不为完成审查编造缺陷。主代理将发现视为待判断的假设：已有证据足以确认时复用证据，有实质不确定性时由自己或合适的已有队友进行最小检查，再决定是否修改。静态推断不等于实际失败，工具成功也不等于验收通过。

这些是调用与交接指引，不强制审查、组队或复测，不增加修复状态机、验收账本、反例工具或总轮次预算。权限仍由原生能力限制保证，未改变工具参数、结果或模型继承；指引不保证模型始终遵守。

### 后台等待与文件交付

APEX 为官方 `dsh-tool-jobs` 配置 `maxWaitTimeoutMs: 60000`，默认等待仍为 30,000 ms。`job_output({wait:true, timeout_ms:600000})` 由原生实现截短到 60,000 ms；到期读取真实任务状态，仍在运行就返回 running，不取消任务、不转换成工具错误。后续通过独立 PTC 请求继续读取。非阻塞读取、任务所有权、完成通知、取消与 `job_kill` 均保持原生语义，其他预设的配置不变。

当前官方 Node PTC 默认每次 120,000 ms，`run_code.timeoutMs` 可调整至部署上限 600,000 ms，包含嵌套工具和审批。60,000 ms 单独等待窗口短于该默认值；不能保证先执行其他长操作或在同一 `run_code` 中循环等待也不超时。自定义较短 PTC 上限时，须同步缩短 `maxWaitTimeoutMs` 与 `waitTimeoutMs`，并保持默认等待不超过上限；它们都不是项目总时长限制。

原生 `present` 显式配置 `maxFiles: 8`，沿用每批 1～8 个已存在普通文件的限制。首轮固定 persona 说明分批交付及后台等待窗口，不新增逐轮消息或自动重试。更改这两项配置时须同步该说明。空批次、超量或包含缺失文件的批次仍失败且不产生部分交付记录，分批成功也不表示验收通过。

### 取消与进程清理边界

用户取消后，APEX 依据原生 `turn/end` 的 `aborted/user` 记录暂停自动模型请求；当前 turn 的取消信号同时关闭记录提交前的竞态窗口。团队或后台通知仍记录在原生历史，自动通知引起的短暂 turn 会以带原因的 hook 取消结束，不调用模型、不执行新工具；这不等于删除通知或将取消伪装成成功。只有真实用户输入解除暂停。暂停同时约束该 Lead 的队友；单独 `interrupt_agent` 仍保留官方后续消息恢复语义。

取消状态使用原生 `sessionProjections` 的 host-only `apexCancellation` 投影，维护停止标志和最近用户消息位置；原生注册器负责回放、检查点和卸载，不在 pre-step 路径读取任意历史。未提交取消的瞬间只保留弱引用内存标志，新的用户消息解除它。与通知同时到达的用户指令通过原生 inbox 保留和重新唤醒，保留消息身份与用户指令顺序。没有 APEX 私有数据库、队列或续跑预算。取消主会话不自动等于终止所有既有后台工作：需要停止整个测试时，驱动仍须逐一取消该测试的子代理和自有 jobs，并等待它们真正结束；不能把一次取消 RPC 的回执当成整个进程树已退出。

macOS 的额外策略为 `(deny signal)` 加 `(allow signal (target same-sandbox))`。它与官方文件策略在同一次 Seatbelt 初始化中合并；文件 `danger-full-access` 下仍单独保留信号限制。该原语亦见 [Chromium 衍生的公开 Seatbelt 基线](https://github.com/openai/codex/blob/main/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl)，本插件以本机哨兵测试验证实际效果，不仅依赖配置文字。

APEX 只派生当前已挂载的官方 Bash 执行器，复用其配置读取、运行、超时、输出、取消和 managed process 清理。异步 argv 准备留在官方截止时间与取消信号内，准备失败或取消不得先启动进程。隔离的设置入口不会重复注册 Host 的 Shell 设置；不修改全局服务或其他预设。未知执行器／非 Seatbelt argv 拒绝执行，不降级为无保护执行。该约束针对本机 Bash／stdin 脚本的进程信号，不是对任意 PTC Node 程序、Apple Events、外部服务等所有操作的完整隔离证明；Linux/Windows 未增加或宣称同等进程隔离。

macOS APEX 的 `tools/pre-execute` 另用官方 `validateJsonSchemaValue` 检查 Bash 参数：仅对参数根对象设置 `additionalProperties:false`，不改变原生 schema 或 SDK。PTC 使用绑定时的工具声明，其他调用使用当前可见声明；不硬编码字段名单、不封闭原本允许扩展的嵌套对象。未声明的 `stdin`、`cwd`、`env`、`timeout` 等在命令／后台任务开始前返回原生 `ToolArgsError / INVALID_ARGS`，而不是由执行器静默忽略。诊断最多八条、每条不超过 256 字符，并明确命令未执行；不回显字段值，不自动剥离、猜测或重试参数。`workdir`、`timeoutMs`、权限字段及原生取消继续走原链路，命令非零退出和超时不改成参数错误。其他预设和非 macOS 组合不加该校验。

定向回归 `node --test test/apex-v1-bash-input.test.mjs` 通过实际 PTC／原生工具调度，检查拒绝前无执行、原参数日志、稳定 SDK、官方作用域隔离、合法 heredoc／工作目录／后台任务、取消、权限和声明扩展。当前契约由此回归覆盖；本地历史研究驱动不纳入公开版本。消除静默丢参是确定性正确性修复，不等于减少真实模型误用次数或证明质量／费用改善。

独立浏览器检查仍优先使用 `apex_validate_web`；自写检查必须使用独立无头实例和私有 profile，在成功、失败和取消路径通过 `finally` 关闭连接、停止并等待自有进程，之后删除该 profile，截图和交付物另存。提示词中的资源归属规则不能保证任意模型脚本遵守；文件写入边界由上文的会话私有临时目录策略执行，同一会话跨调用复用目录，不做全局临时目录清扫。实际进程信号限制由系统执行。原生 `job_kill` 可以通过所有权检查停止本任务先前启动的后台命令；直接从另一次 Bash 对它发信号会被限制。

### 原生 stdin 与字面参数入口（macOS）

`apex_run_script` 支持两种互斥调用：`{command, script, description, ...}` 保留原有 stdin 通道；`{argv, description, script?, ...}` 用于直接运行测试和已保存程序。两者都接受 `workdir?`、`timeoutMs?`、`sandbox_permissions?` 和 `justification?`。`command` 是读取 stdin 的解释器命令，例如 `node --input-type=module`、`python3 -` 或 `bash -s`。解释器需已安装，工具不安装或自动切换语言。它是可选前台工具，不替代普通 Bash 或后台 jobs。

`argv` 的第一项是程序，其余项是字面参数。空程序、NUL、非法 Unicode 和混用 `command` 均在执行前拒绝；空参数合法。每项按 Bash 字面量编码，再用原生 `exec` 替换 Bash，复用原有执行器与沙箱。没有管道、通配符展开、重定向或尾随打印；未提供 `script` 时发送空 stdin 并关闭。后续输出整理在 PTC 中进行，保留原结果：

```js
const result = await tools.apex_run_script({
  argv: ["node", "--test", "test/audit.test.mjs"],
  description: "Run the project tests"
});
console.log(result.stdout.text);
console.log(result.stderr.text);
return result; // 保留 exitCode、signal、timedOut 等独立事实
```

这个入口保留所启动程序的退出状态；程序内部、`npm` 脚本或显式 `bash -c` 仍可能自行吞掉更深层的失败，不能把退出 0 当作完整测量或验收通过。原有 `command + script` 和普通 Bash 调用也不会被自动改写。

```js
return await tools.apex_run_script({
  command: "node --input-type=module",
  description: "Check a workspace module",
  script: "import assert from 'node:assert/strict';\nimport {sum} from './sum.mjs';\nassert.equal(sum(2, 3), 5);\nconsole.log('one assertion passed');"
});
```

- 原生执行器把收到的正文编码为 UTF-8 写入 stdin 后关闭。没有临时脚本文件、Shell 插值、换行归一化或自动补尾换行；空正文也关闭 stdin。非法 Unicode 拒绝而非有损替换。**外层 PTC 在工具收到参数前就已执行**；含反引号、反斜杠或 `${...}` 的正文使用正确 JSON 转义的双引号字符串。`String.raw` 仍执行模板插值，给已经损坏的模板再套 `JSON.stringify` 不能补救。该约定也适用于原生 write 内容和队友 prompt；不自动改写 PTC 或猜测正文中的字面 `\\n`。
- 未指定 `workdir` 时使用当前会话的原生策略根目录；相对目录以它为基准，返回 `workdir` 为传给执行器的初始真实路径。不使用 PTC `process.cwd()` 或修改 Host 的 cwd。脚本内部可改变自身目录，但不会持久到下一次调用。无有效会话目录时拒绝执行，不回退到 Host。
- `node --input-type=module` 从 stdin 执行时，相对导入基于 `workdir`；保存为文件的 ESM 则相对导入者文件解析，改变 Shell cwd 不会纠正写错的导入。一次性多行检查可用 stdin，项目模块和可复用测试仍保存在项目文件中。Shell 脚本须保留换行或明确分隔符，工具不会修复用空格错误拼接的语句。
- 复用该 Host 已安装的原生 Bash 公共依赖、前台结果 schema 和呈现方式，不修改官方工具定义。原生 `tools` 策略链、会话文件策略、审批记录、环境清理、输出截断、超时和取消继续生效；macOS 的额外信号隔离也保留。升权只对已批准的这一次调用生效，拒绝／取消后不重试。权限扩大请求必须针对相同解释器命令及正文；关闭审批时不可请求升权。
- 当前官方 Host 通过 `pluginPackages` 定位选中的原生工具包，并以其规范化路径交给 Loader 解析公共 API。源码启动的 `tsx` 映射和构建产物启动各自保持原生作用域／审批模块身份，避免从 profile 根目录加载另一份模块后找不到已注册的 Bash。缺少包或工具契约时仍拒绝挂载。
- 返回 `exitCode`、`signal`、`timedOut`、`aborted`、`timeoutMs`、`stdout`、`stderr`、`sandbox` 和 `kind: foreground`，另附 `workdir`。非零退出不是工具协议异常；超时后捕获 SIGTERM 并退出 0 仍报告 `timedOut:true`。取消遵循原生工具取消错误。输出里出现“通过”或进程退出 0 都不认证断言或整体验收；不解析任意脚本的测试文本，也不增加 `passed` 裁判字段。
- 通过官方 SDK 首轮声明，工具描述附带可直接执行的 PTC 示例；原有 persona 简短说明字面参数和已列出 stdin 入口的用途。没有另一个 persona 注入、逐轮提醒、自动路由、验收账本或强制使用。原始参数和结果继续进入原生事件；`apex_read_evidence` 可回读，但历史不代表新执行。只读 `apex_review` 和官方预设不获得这个入口。

测试命令优先复用项目已有脚本，或使用运行器文档支持的文件选择语法；不把目录参数想当然地当成递归发现。输出经过管道或后续命令时，仍需检查内部测试进程的实际状态，不能只看最后一个命令的退出码。APEX 只提供通用调用指引，不加入 Node 版本分支、benchmark 关键词路由或测试结果解析器。

回归 `node --test test/apex-v1-script.test.mjs` 覆盖长文本与精确 stdin 字节、实际 PTC、并发目录及相对模块、权限与单次审批、真实取消及子进程退出、超时但退出 0、非零／语法错误／缺失解释器、输出截断和原生事件回放。测试复用现有无密钥夹具与官方已构建服务，不新增依赖或第二套安装。此入口仅在 macOS APEX 组合挂载；没有 Linux/Windows 实机结果，也没有据此宣称真实模型质量或成本改善。

## 通用浏览器验证

本地 HTML/JS 页面通过 PTC 调用 `tools.apex_validate_web`；普通表单和 DOM 页面设置 `require_canvas:false`。macOS 上，自建 Chrome 若经 Bash／`apex_run_script` 启动，可能同时遇到私有临时目录权限及嵌套沙箱的进程信号限制；批准 `danger-full-access` 也不会解除后者。已有验证工具由 Host 管理浏览器、独立 profile 和清理，应先复用这个入口。

APEX 的 macOS Shell 结果若为非零退出或超时，并包含已知 Chromium 启动／DevTools 故障，插件会通过官方结果上下文机制提示切换路径，每个活动代理最多一次。提示写入会话日志；原始参数、退出码、输出和失败状态保持不变，不自动重试、不代为批准权限，也不修改官方模式。成功命令和一般权限错误不触发提示。工具不支持的检查仍应标为未验证；这项修复不承诺任意自建浏览器脚本在 Shell 沙箱内都能运行。

`apex_validate_web` 必填 `check_id`、`assertion`、`root`、`interaction_required`。标签和说明不执行断言；实际标准必须通过结构化检查表达。

它会启动独立无头 Chromium，托管并实际执行本地 HTML/JS。可组合文字输入、点击、键盘、单选控件、刷新和 DOM 断言，并用 `width`／`height` 指定截图视口；“本地静态文件”不表示只做静态分析。视口设置／截图本身不证明没有横向溢出，仍需合适的检查或独立测量。

自动扫描和显式操作共用原生命中检查，先通过 `checkVisibility` 识别隐藏或跳过渲染的内容，再检查几何与实际遮挡。默认收起的 `details` 内容即使有非零矩形，也不会被当成遮挡错误；隐藏目标的点击、文字输入、滑块和下拉选值仍失败。扫描不滚动；显式操作先滚动，再检查可见性，允许普通视口外目标和恢复渲染的 `content-visibility:auto` 子树。可见性通过不代表可点击，真实遮挡仍会失败。

- `interactions` 最多 8 项；独立 `{reload:true}` 在同一浏览器、profile 和页面 URL 上刷新，等待新主文档的加载事件后才继续。它保留本次调用的浏览器存储；只证明刷新后的状态，不证明关闭／重启浏览器后仍保留，也不代表直接核验了存储介质。
- 用已有 `text_checks` 的 before／after 检查表达初态和最终结果，例如下面的保存流程。`reload` 不算鼠标／键盘输入；`interaction_required:true` 仍需实际填表、点击或按键。文本断言不逐动作执行；多个动作中间的正确性不能仅凭最终检查推断。
- 页面 load 不等于异步业务完成；业务需要时，在刷新前或后加入有界 `wait_ms` 并检查实际结果。刷新与 `clock_steps`、`sequence_start:before-actions` 不兼容，参数会在浏览器启动前被拒绝；刷新后的普通实时采样可用。超时、取消、页面错误和清理沿用现有路径，不自动重试刷新。
- 每次调用都是新 profile，不能拆成两次调用来测试同一份存储数据。旧调用结果、历史作品与分数不随新能力改写。

可选 `canvas_checkpoints` 在同次实时交互中记录最多 8 个画布截图。每项提供 `id`、`selector` 和 `after_interaction`：0 表示有序交互前，n 表示第 n 项交互结束后；按执行位置非递减排列。`compare_to` 引用此前 checkpoint 的 id，与 `expectation: "same" | "different"` 一起使用。它比较同选择器、同尺寸和 DPR 下的有界 PNG 截图 SHA-256，不接受任意脚本，不解码像素，不与 `clock_steps` 或顶层点击混用。绘制需要等待时，在交互序列中显式加入有界 `wait_ms`。

结果 `canvasChecks` 保存摘要、尺寸及比较结果。截图字节相同不能证明场景完整：检查“隐藏后无残留”时，还应加入“显示与隐藏时画面不同”的控制，避免空白画布误通过。`measurementComplete` 仅在检查完整执行、自有资源清理确认、工件前后稳定且未超时／取消时为 true；合法断言失败仍可完成测量。缺失画布、无法读取截图或尺寸变化属于测量未成立，不能冒充已测到的画面失败。

```js
// 按实际页面替换选择器和预期；这是刷新保留检查，不是整个页面的验收。
const result = await tools.apex_validate_web({
  check_id: "save-reload", assertion: "保存内容在刷新后仍显示", root: ".",
  interaction_required: true,
  interactions: [
    {selector: "#note", text: "待保留内容"},
    {click_selector: "#save"},
    {reload: true}
  ],
  text_checks: [
    {phase: "before", selector: "#saved", equals: ""},
    {phase: "after", selector: "#saved", equals: "待保留内容"}
  ]
});
// 查看 status、failedTextChecks 和 detail；需要视觉核验时再读截图。
```

- `selector_checks` 明确区分 `present`、`absent`、`visible`、`hidden`、`in-viewport`。存在不要求非零尺寸；布局可见不要求在当前视口内。隐藏必须有对应元素，不把不存在当成隐藏。
- 文本检查选择完整相等或包含；空状态使用 `equals:""`，`contains` 必须非空。包含、时序稳定／变化及首个数值比较使用完整 textContent，只有证据摘录截断，不用摘录重新计算断言；数值必须有限，数值摘要另列实际观察值。时序只在页面保留上一次完整文本，历史样本仍有数量和摘录长度上限。只检查元素存在时使用 `selector_checks`。textarea 采用浏览器 CRLF/CR → LF 归一化；单行输入仍拒绝换行。不接受任意脚本作为检查参数。
- 有序交互包含受支持的点击、文字替换、原生 range 数值、原生单选 select、按键和等待。按键增加 `Tab`、`Enter`、`Escape`、`Home`、`End`，沿用 CDP keyDown/keyUp，按当前焦点和浏览器原生行为执行，需要时先点击目标。`hold_ms` 上限保持 2000 ms；取消按住动作时尝试释放按键，再停止后续动作，连接中断仍由浏览器清理兜底。等待不算用户动作。`pointer_lock_selector` 与发起锁定的点击必须位于同一对象，错误提示给出有序点击示例，不自动搬移参数。Pointer Lock 在真实建立前不执行依赖输入，失败保留截图和原因。
- `interactions[].input:{selector,value}` 接受符合目标 min/max/step 的有限数值；在脱离页面的克隆上用浏览器原生规则预检，不对非法值自动钳制或取整。与 `clock_steps[].input` 共用执行路径，参数不合法时不改写原控件、不发送接受事件。
- `interactions[].select:{selector,value}` 按唯一选项的字符串 value 选择，允许空字符串；拒绝不存在／重复的 option value、隐藏或禁用的选项，以及 multiple select。两个控件动作都要求唯一、可操作的原生目标；不覆盖自定义控件、iframe 或物理拖动。
- range/select 使用原生 value setter，然后依次发送冒泡的程序化 `input`、`change`；事件 `isTrusted:false`，不声称可信用户激活。结果交互摘要记录实际保留的值，长值会截断。页面事件处理器替换／移除目标或不保留请求值时，保留失败并停止后续动作；已经发生的事件副作用不能自动回滚，也不自动重试。
- `require_graphics_api` 可要求 `2d`、`webgl`、`webgl2`、`webgpu` 的实际可见 canvas context；未观察到则失败，不接受替代 API。观察不初始化额外 context；context 存在仍不证明内容正确。
- 时序检查是离散 DOM 采样。只有真实时间采样完成才标记 `metricsKind: instrumented-raf`，表示 rAF 回调响应性，不是 GPU 渲染吞吐量。`fps` 与 `min_fps` 的单位是回调／秒，`p95FrameMs` 是回调间隔的第 95 百分位；结果详情记录回调数与实际采样时长。后续截图或诊断失败不会抹去已完成采样，也不会因已有采样而把失败改为通过。
- 未完成采样（例如浏览器缺失、启动失败、动作提前失败）或使用 `controlled-clock` 时标记 `not-measured`；保留现有数值字段的 `0` 占位，不视为实测零值。少于两个回调时 `p95FrameMs` 也只是占位，详情明确指出。受控时钟仅覆盖原始主文档的已支持回调，不覆盖 CSS 动画、Date 构造、iframe、worker 或网络调度。
- `clock_steps` 的顺序保持为推进时钟／可选回调 → 动作 → 立即检查。数值输入已经发送一次程序化 `input` 和 `change`，不是可信拖动；操作产生的 rAF／timer 更新要在后续 `run_callbacks:true` 检查点、满足到期时间后观察。失败结果说明这一时序，但不自动补回调、重试动作或抹去先前失败。
- 一次实际调用对应一次新执行，不按阶段自动续跑或修复。结果 `passed` 只说明配置检查通过；`overallAcceptance` 始终 `not-assessed`。工具参数异常、命令非零退出、页面失败和宿主能力阻塞分别保留真实含义。
- 结果 `checks` 是校验后的请求参数对象，不是结果数组；读取 `status`、`detail`、`failedTextChecks`／`failedSequenceChecks` 判断配置检查结果。`sequenceChecks` 是摘要字符串数组，`selectorChecks` 才是带 `passed` 等字段的元素结果数组。字段说明随原生 SDK 展示，不新增系统注入或兼容别名。
- 静态产物哈希限制 8192 个文件、16384 个目录项、256 MiB；排除 `.git`、`.cache`、`coverage`、`node_modules` 并在结果列出。动态接口、外部资源及被排除依赖的版本不由此哈希认证；需要项目自身锁定与检查。
- 根目录限定工作区内实际目录；特殊文件、逃逸链接、哈希过程中变化拒绝。验证前后产物变化标记 blocked，不把旧截图用于认证新产物。
- 截图用独立私有临时路径和 SHA-256，未写入产物目录。浏览器、静态服务和用户配置目录在 finally 清理；截图作为证据保留，但临时文件可能被系统清理。`screenshotIdentity` 可复核已记录文件；原生 `read_image` 显示当前路径内容，不被伪装成不可变历史附件。
- 浏览器清理未达到可确认的进程退出状态时不删除 profile；清理失败仍标记 blocked，并在结果详情中指出保留目录的精确路径及安全删除条件，不因警告列表已满而丢失。取消路径也记录保留路径，便于精确处理，不将请求停止等同于实际退出。
- profile 和截图目录先独占创建，再记录规范路径及设备／inode 身份；创建时不跟随新目录处的符号链接，身份无法确认时停止准备并报告原路径。profile 清理、截图写入失败后的清理、取消后未返回截图的清理共用身份复核，替换、缺失或无法检查时拒绝删除并保留失败。截图写入与清理同时失败时保留两种错误；人工清理前须重新确认原路径的归属。此检查不保证抵御同用户在检查与删除之间的并发替换，也不保护模型任意 Shell 命令的删除行为。
- 单工具运行与 CDP 调用有超时、取消和输出边界；没有父代理回合数或项目总时长预算。不默认启动浏览器、后台验证或交付后重新检查。

例如普通真实时间验证可使用以下有序动作，无需启用受控时钟：

```json
{"interactions":[{"input":{"selector":"#speed","value":2}},{"select":{"selector":"#mode","value":"density"}},{"click_selector":"#speed"},{"key":"Tab","hold_ms":0}]}
```

值设置与按键分工分别遵循 [HTML range 规则](https://html.spec.whatwg.org/multipage/input.html#range-state-(type=range)) 和 [CDP Input.dispatchKeyEvent](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchKeyEvent)。普通控件与取消回归仅加载已有原生进程服务，使用临时网页和独立无头浏览器，不创建第二个 Harness Home 或挂载模型适配器。

`apex_read_evidence` 每页最多六个记录；使用 `before_seq` 翻页或 `refs` 精确定位。保留对应参数、结果和错误标志，显式标记裁剪及未展示的非文本内容。支持当前会话历史而不只当前任务，结果不代表新执行、不推断退出码、测试数或验收状态。拒绝跨会话读取；压缩不改写原生历史。

## 安装与升级

源码通过本 GitHub 仓库封存，尚未发布到 npm。最终 rc.2 适配随 2026-10-17 封存提交保存；下列安装步骤属于历史兼容基线，恢复前请阅读[封存说明](../ARCHIVE.md)。安装入口为包含 `package.json` 的插件目录。

### 官方桌面端（macOS 已验证）

开发修改保存在独立插件源码目录；官方源码 checkout 用于跟踪接口和运行组件测试，日常执行使用安装的官方桌面应用。更新时同时核对 Harness 版本与四项 peer 声明，不改写应用包。

rc.2 桌面端自带插件 CLI，无需另装 Node 或 pnpm。可在应用菜单“管理 dsh 命令”设置入口；macOS 也可直接调用下列应用内入口。先等任务结束并完全退出应用，再在终端执行：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "/absolute/apex-source"
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop list
```

使用桌面端现有的 Home；若原启动方式设置了 `DSH_HOME`，命令也使用同一个值。先确认实际路径，不能因为源码 Web 使用另一目录就迁移桌面会话。`desktop` profile 由官方桌面端管理；普通 CLI 的 `--profile desktop --dump-config` 不受支持，安装后须重新打开应用，在“设置 → Agent 预设”确认四个官方模式及自定义 APEX 1.0.1，创建新会话选择 APEX，再核对实际工具执行。

本地安装是目录链接，源码目录必须保留；修改 JavaScript 后须等任务结束并重启应用。安装不要求把 APEX 设为默认模式，是否设为默认由用户选择。现有会话遵循官方 preset 锁定规则。

回退时等 APEX 任务结束，选择官方预设用于后续任务，完全退出应用后执行：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop remove dsh-apex
```

移除插件不删除会话和工作区。降级 Harness 时同时使用对应基线的插件；不要通过兼容豁免加载不同版本的 peer。

### 官方源码 Web

以下保留源码 Web 安装方式。此 profile 的安装与桌面 profile 独立；安装到其中一个不会自动安装到另一个。

先核验官方构建身份、提交和产物摘要；确认 live `DSH_HOME` 中没有正在运行的任务，停止旧 Host 后再迁移。以下命令中的路径须替换为实际路径，始终使用同一个 live Home：

```sh
DSH_HOME="/absolute/live-home" dsh plugin --profile web remove dsh-minimal-max
DSH_HOME="/absolute/live-home" dsh plugin --profile web add \
  "/absolute/official-checkout/packages/experimental/agent-team" \
  "/absolute/official-checkout/packages/experimental/client-ui-agent-team" \
  "/absolute/apex-source" --config.auto-install-peers=false
DSH_HOME="/absolute/live-home" dsh --profile web --dump-config
```

从官方源码运行时，将 `dsh` 换为该 checkout 的 `corepack pnpm dsh`。全新安装跳过旧包移除命令。两项 Teams 依赖以及 preset registry/preset 包必须与 Host 同为 `0.2.0-rc.2`；它们是普通依赖，由 APEX bundle 注册一次服务、官方 Web 面板和 APEX 自定义 preset 声明，不安装旧式全局 Team 工具层。bundle 的 `dsh.bundle.patch` 按顺序加载 `cordis.patch.yml` 和 `presets/apex-v1/agent.cordis.yml`，由官方 Loader 合并声明。

0.1.7-rc.1 起提供插件兼容性准入检查。APEX 的四项原生 peer 依赖现固定为 `0.2.0-rc.2`，旧 rc.1 及 0.1.7 声明会被当前 Host 拒绝；不要用兼容豁免掩盖未验证的版本差异。`--dump-config` 能显示声明不等于插件已通过准入，还需检查实际预设列表及挂载。设置中的 APEX 继续属于“自定义”，可直接使用原生“查看配置”。

0.2.0-rc.1 在工具调度异常后补齐原生错误结果：已开始但缺失已落盘结果的调用标记为 `TOOL_OUTCOME_UNKNOWN`，模型须先核实可能的副作用。APEX 直接保留这些原生记录；已验证内层 PTC 执行一次、外层未知结果保留、重载后续聊不自动重放。联网搜索现在可沿用 DeepSeek 账号认证，APEX 的 PTC 调用保留当前发起会话，API key 路由仍使用原有鉴权。两条路径均以本地脚本化响应验证，未访问真实搜索服务。定时任务已迁入官方可选 bundle；APEX 不依赖或自动安装该功能。既有链接安装无需重复安装插件，只需匹配的官方构建和一次 Host 重启。

0.1.7-rc.2 将模型接入拆分为协议库与提供商插件。已有 Home 若在 profile patch 中显式覆盖了 `llm-deepseek`，须将其 `name` 从 `@deepseek-ai/dsh-llm-deepseek` 改为 `@deepseek-ai/dsh-llm-deepseek-api-key`；保留 id、模型声明、密钥和默认模型。未覆盖的安装直接继承官方配置，不需另加一行提供商。协议库不再是可挂载的 API key 插件。组件测试的底层 adapter 鉴权夹具也使用新版 `resolveAuth`，不读取真实凭据。

从 0.1.7-rc.2 起，新会话模式选择入口由“设置 → 通用设置 → 代码工作工具”控制，旧 `modeSelectionEnabled` 配置已移除。默认预设与入口是否显示分开处理；本次保留既有 APEX 默认和已启用的代码工作工具。原生工具更新与历史记录机制由官方执行循环负责；回归验证现有 APEX 会话的 PTC SDK 可见新注册工具，卸载后移除，官方 PTC 会话不会继承该工具。APEX 没有另建工具同步器。

APEX 的证据、浏览器观察和错误摘要按原有长度预算截取时，现在去掉边界上的半个 UTF-16 代理项，避免把 Emoji 切成无效字符。首尾摘录的省略计数按实际长度计算；完整原文和基于完整文本的验收断言保持不变。这不是按可见字素计数，组合字符仍可能分开；没有增加输出预算或依赖。

新版 Team 面板从持久化会话投影读取成员和任务，APEX 继续调用原生任务服务；创建、认领和完成任务后的面板数据及会话重载均有回归覆盖。浏览器投影不包含团队消息正文，不另建轮询服务或状态存储。

当前插件页支持启用、禁用和 Host 插件配置；APEX 复用该页面及新版原生 Teams 面板。更新已有 JavaScript 包后仍需重启，不把运行时开关等同于热替换代码。APEX preset 是包内声明；升级时由 bundle 重新加载声明，用户级配置仍由官方 registry 管理，不覆盖用户修改。禁用 bundle 不删除历史会话；重新启用会重新加载声明。停用 APEX 前应结束其任务，并为后续任务选择官方预设。

alpha.2 将工具结果保留预算改为 `maxInlineTokens`，官方默认 `12500`；旧 `maxInlineBytes` 不再生效，有自定义预算时必须按 token 重新配置。APEX 不覆盖该策略，直接沿用官方的文本／图片统一预算、首尾保留和原始结果恢复位置。后台任务完成通知未配置 `maxConsecutiveWakes` 时不再有默认次数上限；APEX 保持原生唤醒机制和自身取消保护，不用通知绕过用户取消。

原生连续子代理链默认最多保留 8 个活动子代理；这是驻留数量限制，不是团队总成员数或模型能力指标。子代理结束并释放驻留实例后可复用名额，历史会话和团队成员记录保留。`apex_review` 的委派深度跟随 Host 设置，默认 1；队友触及深度限制时将审查需求交给 Lead，不绕过限制。证据实验使用一次性子代理，仍保留自身明确的深度及输出约束。官方 Inbox 恢复、侧栏子会话、Office 预览和上下文明细直接来自新版 Harness；这些工程改进不构成证据选择算法有效的证明。

`apex_run_script` 复用新版官方权限处理：显式请求当前已经生效的模式可以执行，且不重复申请批准；这不扩大写入范围。扩大权限仍须批准、只作用于该次调用；非法或更窄的显式目标仍按官方规则拒绝。相关检查同时覆盖同模式成功、越界写入失败和一次性授权后的权限恢复。

该基线使用官方 `ptc-runtime-node`，每次 `run_code` 为独立受文件策略约束的 Node 进程，默认单次 120 秒、最大 600 秒，`process.env` 初始为空；超时包含嵌套工具和审批等待，不是任务总预算。macOS 的附加进程信号保护只适用于 Bash／`apex_run_script`，不能推断任意 PTC Node 程序也受到相同信号保护。官方 Messages 协议与图片处理由 Host 提供，APEX 不覆盖模型路由；自定义 API 地址需要按官方升级说明检查协议兼容性。

官方新增的 `session-log-deepseek` 默认贡献完整会话事件后缀。需要保持升级前的数据发送范围时，可在用户级 `cordis.patch.yml` 为该 ID 配置 `enabled: false`；这不关闭正常模型请求，也不是 APEX 隐藏修改的全局默认。不自动启用实验性 Computer Use、Browser Use 或 Auto Review。

配置检查与 bundle 声明挂载成功后，使用原生设置选择 `apex-v1`；需要时再设置为新会话默认。不要在迁移中途启动 Host。官方 registry 负责 preset roster 和选择策略；APEX 不写入旧 `.agent-presets` 目录，也不覆盖用户 preset。

旧包名没有兼容别名。旧会话和测试作品不删除、不改写；旧任务不保证继续执行。旧预设目录不会由本包自动删除。移除 APEX 时使用原生 CLI 移除 `dsh-apex` 并选择官方默认预设；只移除已确认无人使用的 Teams 依赖，不回写旧会话。

## 安装安全与失败策略

1. 固定官方基线 `v0.2.0-rc.2`，提交 `639ed015397290b3745d163aafe02ffee4aa3f84`。源码运行核验 official build profile、commit、产物摘要；桌面运行核验官方应用版本、签名与打包运行时描述；不通过就停止，不新建第二套安装绕过。
2. live 维护窗口停止无任务运行的旧 Web。使用官方 CLI 移除旧依赖／bundle、加入 `dsh-apex` 与匹配官方 Teams 服务和面板依赖。安装配置不触碰凭据、模型、沙箱或会话。
3. 官方 Loader 校验实际 Host 与 preset registry/preset、Teams 依赖版本和服务能力；不存在或不匹配时失败。使用固定原生 Cordis ID 各注册一次 Teams 服务和面板，不安装旧式全局 Team 工具层。
4. bundle 以声明方式插入 `preset-apex-v1`，其 `config.id` 为 `apex-v1`，插件组保留 APEX 执行 realm；不写入旧 preset 目录，不覆盖用户声明。
5. 模块、bundle、配置和实际挂载检查成功后，通过原生设置确认预设可选，需要时再切换默认。检查旧依赖／bundle 为零、新依赖／bundle 各一份。
6. 失败则停止并报告，不带着半迁移状态启动，不自动回退旧框架。无需恢复旧会话状态；旧会话仅保证保留原记录供查看。

声明式 bundle 不会热覆盖用户级 preset 配置。后续开发更新必须在维护窗口重新加载 bundle，并确认新声明已经通过官方 registry 挂载。用户想退出 APEX 时可移除 bundle、把默认预设切回官方模式，历史文件仍原样保留。

## 测试迁移与验收

在插件源码目录运行：

```sh
npm test
npm run check:public
npm pack --dry-run --json
```

原生集成测试使用显式 `DSH_CHECKOUT` 指向已构建且匹配的官方 Harness checkout；helper 解析官方构建包，创建组件级 Cordis／agent fixture 和临时工作区。测试不读取 live Home 的配置、凭据或依赖链接，不设置 `DSH_HOME`，也不启动第二套完整 Harness Home。测试使用 Node 24 和脚本化模型响应，无 API 费用；浏览器检查使用独立无头 Chromium。缺少 Harness 时相应测试明确跳过，不能把跳过计为原生集成通过。测试配置与运行范围见 [公开版本说明](PUBLICATION.md)。

沿用 `node:test`，只运行 `test/apex-v1-*.test.mjs`；无新增测试框架。脚本化模型只用于确定性协议测试，不能作为真实模型能力评分。

| 旧测试的行为 | 1.0 的处理及依据 |
| --- | --- |
| 历史创建式安装、权限、目录／链接安全、并发出现与失败清理 | 创建式安装器已由官方 Loader 声明式 bundle 替代；当前 `apex-v1-installer` 只验证 bundle 外层 patch、registry／preset 组合、manifest／版本和失败拒绝路径，权限、并发与资源清理由对应原生回归覆盖 |
| Minimal 首轮快照、延后 PTC、能力激活与特殊编辑器 | 设计明确移除；原文件不改，替换为首轮原生 PTC、完整 SDK 与无切换断言 |
| Pro/Flash 路由、纯文本视觉桥接、自制 worker/等待/接管 | 设计明确移除；替换为实际原生模型继承、fresh/fork、消息、任务板、取消及冷恢复测试 |
| APEX Shell 解析、路径拦截、持久 cwd | 移除私有实现；通过官方一次性 Shell 验证 workdir、`cd ..`、长命令、Unicode、引号、heredoc、非零退出 |
| 浏览器静态服务、精确文本、有序动作、Pointer Lock、Canvas、时序探针、取消 | 迁移有效断言；增加真实无头浏览器的空状态、布局／视口、换行、截图身份、产物变化和失败证据 |
| final/repair 阶段、验证次数预算、自动交付账本、强制截图审查、历史图片认证桥 | 设计明确移除；改测每次实际验证的前后身份、原生图像传递、可选只读审查和原始执行记录 |
| 原生 tool/PTC 子调用配对、裁剪、错误与退出含义 | 保留；新任务仍能查询本会话历史，明确历史不等于当前证据。失配记录不认证，外层 JSON 错误不抹去内部已执行结果 |
| 旧核心本地补丁、老 Harness snapshot | 官方不改，不把旧测试当成 1.0 已验证；固定源码摘要并比对九个原生 Teams schema，单独断言等待说明与新增可选 waitWindow，其他字段仍逐项一致 |

确定性测试覆盖模型请求入口、预设并存、只读权限、任务 revision、依赖、消息队列、单次投递、冷恢复、中断、实际浏览器及资源释放。测试文件不纳入发布清单。Windows/Linux 未进行实机测试；平台组合契约通过不能替代实测。

审查定向回归 `node --test test/apex-v1-review.test.mjs` 使用原生内存 registry／scope／loop／provider 与实际 persona 配置，无 Host、第二个 `DSH_HOME` 或真实 API。覆盖父级首请求准确说明、单份 SDK、跨回合稳定、其他作用域隔离、子级四个只读工具及未验证反馈原样返回。脚本化响应仅验证传输与能力约束，不证明真实模型会提出正确反例或提高产物质量。

浏览器回归同时检查缺失／启动失败／Pointer Lock 失败时的未测量标记，以及真实 rAF 采样后截图存储失败的故障注入：保留采样、真实失败和资源释放，不把占位值当成测量结果。

接口回归还覆盖首轮 SDK 中的请求回显／结果类型说明、拒绝空 `contains` 而保留空状态检查，以及真实浏览器内一次 `input/change` 的即时提交和延后 rAF／timer 更新。提前检查仍失败，后续更新不反向改写结果；不改变回调顺序，也不增加系统提醒或领域专用规则。

`apex-v1-safety.test.mjs` 使用临时哨兵进程与脚本化模型，覆盖沙箱外／自有／跨调用信号、前台与后台、三种文件策略、原生 job 所有权与超时、真实子代理／job 通知、取消后的冷恢复、用户输入竞态和官方预设不串扰。不向真实应用发送信号，不启动用户浏览器，不产生 API 费用。

`apex-v1-native.test.mjs` 额外覆盖原生后台任务跨多个等待窗口存活、默认／短／超长／非法等待、取消等待不杀任务、早完成与权限边界；虚拟时间和缩短后的原生等待只验证协议，不冒充真实模型或耗时证据。PTC 集成检查原生状态和日志、与官方预设并存、首轮交付上限提示，以及失败批次不产生交付记录。

真实模型评估单独启动：小程序、多文件协作、图片驱动任务；对照产物质量、可避免错误、重复工作、耗时和用量。后台脚本和独立无头浏览器，不操作用户桌面；架构切换最多一次官方基线对照。没有真实盲测前，不声称性能提高、效果更强或“完美适配”。

### 公开版本验证

本版本固定兼容基线为 v0.2.0-rc.2。组件测试使用脚本化响应和官方运行时包解析，不读取 live Home 的配置、凭据或依赖链接，不发起真实模型请求；缺少匹配 Harness checkout 时原生集成项明确跳过。CI 的跨平台基础检查不能代替 Linux/Windows 真实宿主集成验证。历史发布验证结果见 [发布说明](PUBLICATION.md)；旧 alpha 版本的付费实验保留原环境身份，不与本版本混作同条件样本。

脚本工具的首轮说明明确 PTC `tools.*` 与外部解释器隔离：在 PTC 先获取数据，通过数据值或工作区文件交给脚本；不向脚本注入 SDK。错误调用继续以原生非零退出返回，不改写源码、自动恢复或增加提醒。脚本化集成覆盖准确传值、缺失 SDK 的失败语义与原有单份系统消息；这不证明真实模型的错误率已经降低。

策略试验先冻结任务、评分与候选说明，核对预期行为是否实际发生，再比较完整产物质量和全部父子开销。提示词已注入不等于机制已生效，工具错误更少不等于质量更高；同题各组全部通过时，不凭单次耗时差异更改默认策略。可由本地契约检查确认的说明、权限和返回值问题先在本地验证，不自动追加付费样本；新增默认策略需要跨任务重复证据，评测专用规则留在研究目录。

评测资料不属于模型项目：后续驱动应使用独立的空工作区，评测计划、评分细则、驱动、基线、请求记录与历史结果放在另一目录树，不放在工作区或其祖先目录，也不通过软链接、项目指令或环境变量向模型暴露。目录分离只减少意外读取，不是原生文件策略的读取隔离保证；严格盲测还需先证明所有可用读取通道都不能访问评测资料。不能证明时明确称为效果测试；发现模型读取评测资料时保留原始记录并标记污染，不改写报告或重跑后冒充原样本通过。不为此在通用插件内添加 benchmark 路径拦截器。
