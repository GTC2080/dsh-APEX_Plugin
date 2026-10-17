# 原生执行反馈闭环（实验功能）

本模块有两条互不改变默认行为的路径：旧路径在模型使用原生工具完成任务后检查 `solver.mjs`；可选的 `project` 路径对操作者预先配置的项目工件执行一次只读验收。任一路径公开检查失败时，都可以在**同一个会话**中加入真实失败事实，允许一次继续修复。project 还可显式要求最终回复；缺少正文时共用这一次修复额度。模型仍可读写文件、执行自测和使用原有工具。

旧 solver 路径的范围是同步纯 ESM `solve(input)`，返回有限 JSON 值，源码不超过 128 KiB；检查集为工作区的 `public-cases.json`，每项包含 `input`、`expected`、`expectedSource`，并沿用候选搜索的受限执行器。当前组件支持基线为 macOS、Node 24 和官方 Harness v0.2.0-rc.2；工程验证与付费模型效果分别记录。

## Project evaluation

`project` 是默认关闭的可选验收路径，不改变上述 solver 路径：

```yaml
project:
  command: node /absolute/path/to/checker.mjs
  protectedFiles: ["/absolute/path/to/checker.mjs"]
  checkIds: [source, build]
workspaceRoot: "/absolute/path/to/project"
reportDirectory: "/absolute/path/to/host-reports"
```

`command`、`protectedFiles` 和完整唯一的 `checkIds` 必须由可信操作者固定配置。启用 project 时，`workspaceRoot` 也必须是绝对真实目录；插件只为 `session.cwd` 的 canonical realpath 精确匹配的 Host 挂载项目反馈，其他同 Host 工作区会跳过且不写报告或注入反馈。配置行应放在 `apex-session` 的 `config` 组内，以继承该 preset 的 scoped fs/shell 服务。project 是配置的只读验收路径，不是任意测试命令调度器；需要写入 build 或 cache 的准备步骤必须在验收前完成，检查器本身不能依赖写权限或通过此路径获得写权限。检查器通过官方 `ctx.shell` seam 执行，工作目录是会话项目根，强制使用 `read-only` sandbox policy，并携带 Harness 的受管 `shellEnv`。

检查器 stdout 必须是精确的 `{measurementComplete:true,checks:[{id,passed,expected?,actual?,detail?}]}`。检查器必须在所有必要测量完成后才设置 `measurementComplete:true`；测量异常时应返回 `false` 或非零退出，不能把未取得的数值转换成项目失败。缺少完成声明、声明不是布尔值 `true`、未知/重复/缺失检查项、错误类型、非零退出、超时、取消或截断都会产生 `verification-error`，不触发修复。该声明仍需通过独立校准核实，不能单凭检查器自报证明测量正确。

### 测试状态与完成说明

模型在 PTC 中运行测试时，可使用 `apex_run_script({argv:["node","--test","test/audit.test.mjs"],description:"Run project tests"})`，随后在 PTC 中整理输出并保留返回值。这条入口避免尾随 Shell 打印或过滤覆盖被启动程序的退出状态；普通 Bash、测试脚本内部自行吞错和最终回复判断仍需要下述独立验收。

被测程序的退出状态和检查器自身的退出状态需要分别保留。检查器用直接的可执行文件及参数启动测试，立即保存进程返回的 `status`、`signal` 和启动错误，再整理输出；不能把 `测试命令; echo ...` 或 `测试命令 | tail ...` 的最终状态当作测试状态，也不能从输出中的 `EXIT:0` 推断成功。Node 的进程字段见 [spawnSync 文档](https://nodejs.org/download/release/v24.16.0/docs/api/child_process.html#child_processspawnsynccommand-args-options)。

测试有完整、经过校准的测量且断言失败时，检查器正常退出 0，输出 `measurementComplete:true`，并在对应检查中保留 `passed:false` 和原始进程状态，例如：

```json
{"measurementComplete":true,"checks":[{"id":"tests","passed":false,"expected":{"exitCode":0},"actual":{"exitCode":1,"tests":5,"passed":1,"failed":4}}]}
```

检查器退出 0 表示结果成功送达；上述项目检查仍然失败。只有退出码还不足以确认完整测量：应同时核对测试运行器的完成结果和固定检查集合。Node 可以通过自定义 reporter 读取 [`test:summary`](https://nodejs.org/download/release/v24.16.0/docs/api/test.html#event-testsummary)，检查实际执行数量、失败、跳过、取消和总结果，不解析面向人的输出猜测数量。未启动、加载失败、没有完整结果、超时或结果互相矛盾时，保留为验收错误。需要写入夹具、构建或缓存的测试应走原有受管执行路径；project 检查器仍使用只读沙箱。

把“README 已说明某项行为”等可检查的交付要求配置成独立检查，并关联到 `requirements`。功能测试通过不会替这项文档检查计为通过；缺少证据仍按覆盖状态处理。当前接口不会自动理解最终回复、提取任意陈述或验证所有文档语义。原生 `turn/end: completed` 只说明模型回合结束；只有推理块、没有最终正文的回复也可能结束回合，不能由此判定文档或整个任务已经完成。文字包含检查只证明指定文字存在；检查条件必须由操作者校准，避免将另一种正确表述误判为失败。最终说明引用证据时，也要保留命令、检查范围和文件版本，文件变更后用 `projectCoverage` 核对旧结果是否仍适用。

明确要求交付某个文件时，检查器可将该文件的 `ENOENT` 记录为已测量失败。权限不足、读取异常或检查器自身故障仍属于未完成测量，不能统统改写为“文件缺失”。

#### 要求最终回复

任务需要最终文字说明时，在同一反馈模块配置中设置 `requireFinalResponse: true`，与 `project`、`workspaceRoot` 同级。默认值为 `false`，且只有配置 `project` 才能启用。它不改变正式预设的默认行为。

控制器读取当前回合最后一条原生 `assistant/message`：必须含有去除首尾空白后非空的 `text` 块，且不能含有工具调用块。仅有推理、空正文、历史回合的说明或较早步骤的进度文字都不满足要求。这只测量正文是否存在，不核实其中的结论、准确性或完整语义；例如一句“Done.”也能满足存在性检查。

启用后，报告的 `candidates`、`feedback`、`delivery` 按实际阶段记录 `finalResponse: {required, present, turn, eventSeq}`，不复制推理或回复正文。文件检查分数保持原有含义，回复不虚增检查数量。`observe` 只记录结果；`repair` 在原生模型正常停止且额度未消费时，将缺失事实与文件失败合并为一次原生反馈。最终仍缺少正文且文件检查通过时，状态为 `delivery-incomplete`；文件仍失败则保留 `public-fail`，同时记录回复状态和需求覆盖。检查器测量无效、取消、超时或预算终止仍按原有错误路径处理，不因缺少回复追加重试。

文件和回复共用**最多一次**修复：若文件修复已用完额度，随后缺少回复也不会追加第二次。关闭该选项即可恢复仅按已配置文件检查与需求覆盖验收。此项经过本地脚本模型回归；真实模型能否稳定补齐交付仍需独立验证。

#### 新增或修改自测脚本

优先使用项目已有的断言与测试运行器。无依赖的 Node 检查可使用内置 `node:test` 和 `node:assert/strict`。例如，对已约定的“双倍输入”行为编写：

```js
// selfcheck.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { solve } from './solver.mjs';
test('double input', () => assert.equal(solve(2), 4));
```

直接运行 `node --test selfcheck.test.mjs`，保留退出状态和完整汇总。断言失败会让运行器记录失败并非零退出；仅给打印 `FAIL` 的脚本套上 `node --test`，运行器仍可能把该文件记为通过。

已有计数式脚本可在全部检查后保留失败状态，例如 `fails` 是失败项数组时：

```js
if (fails.length > 0) process.exitCode = 1;
```

这会让程序自然结束并保留输出与清理机会；不能替代 `finally`、等待异步检查或验证汇总完整性。新增或修改测试驱动时，在独占临时副本中放入一个故意错误的用例，确认非零退出与失败汇总一致，再运行正式检查。不要修改冻结的历史作品或把故意错误留在交付中。

APEX 的使用指引包含此要求，但不自动改写测试脚本，也不从任意 stdout 推断真假。负控只验证该失败路径，不能证明断言覆盖了全部需求或真实模型一定采用此写法。

### 查询 Host 验收结论

在已启用 `project` 验收的会话中输入 `/apex-status` 并发送，通过 Harness 0.2.0 的原生命令卡片查看本次运行的结论。从斜杠菜单选择后仍需发送。无需参数或附件；使用现有 `commands` 服务，未挂载此服务的运行环境不提供该入口。命令声明原生输入入口，让误带参数的提交也进入 Host 参数校验，显示用法错误，不转成普通模型消息。命令只在匹配的工作区和会话预设生效；默认关闭的反馈模块及旧 solver 路径不注册它。

Harness 0.2.0-rc.1 的空白欢迎页会隐藏仅含命令事件的对话内容：查询已执行并保存，但结果要等会话产生对话内容后才显示。当前请在已有任务记录的会话中查询。此限制来自官方 Chat 视图的活动判断；插件不为显示卡片伪造模型消息或启动一次模型调用。

命令读取当前控制器已完成、已保存的验收状态，区分检查通过、检查失败、覆盖不完整、交付不完整、运行中与未验证。启用 `requireFinalResponse` 时还显示正文存在或缺少，并注明不判断内容准确性。它显示失败检查 ID 和尚未通过的需求 ID（各最多 16 个，并注明其余数量），不展示检查器配置、原始输出或任意错误正文。原生命令的 `kind:success` 表示**查询成功**；项目是否通过以卡片正文中的验收状态为准。

展示最终结论前，命令复用 `artifactSnapshot` 和 `protectedIdentity` 核对当前工件与检查器／需求绑定。文件变化、读取失败或取消／超时不会沿用旧通过结论。快照范围沿用既有排除项和 8192 文件／256 MiB 上限，时间上限沿用 `evaluationTimeoutMs`。这是查询时的内容绑定复核，不重新执行测试，也不证明目录外依赖、外部服务或环境状态仍然相同。结果卡片是查询时的记录；之后发生的变化需要再次查询。

查询不调用模型、不增加修复轮次、不修改工件或验收报告，只由 Harness 保存原生 `command/run` 与 `command/done` 事件；这些事件不进入模型消息。未配置需求清单时会明确说明检查通过不代表全部需求已验收。报告保存失败则拒绝给出已确认结果。

会话恢复或插件重新挂载后，没有本次挂载的可信测量就返回“未验证”，不会自动读取磁盘上的旧 JSON 充当当前结论，也不会重新消费验收额度。已有 Host 报告继续保留供独立复核。此入口需要用户主动查询；当前不自动改写模型最终回复，不自动判断任意自然语言完成陈述，也不替代检查器校准。

### 浏览器与工件绑定

可选的 `webChecks` 是同一 project 验收中的真实浏览器检查数组，最多 8 项。每项复用 `apex_validate_web` 的完整请求 JSON（包括唯一的 `check_id`、`root`、`entry`、交互和结构化 DOM/canvas 断言）；`webChecks[].check_id` 不得与 CLI `checkIds` 重复。控制器先运行只读 CLI 检查，再按配置顺序运行受管浏览器。浏览器检查的 `root` 必须位于会话工作区；本地入口由只读静态服务提供，不能替代 build 或 cache 准备步骤。浏览器 profile 和截图由独立临时目录管理；这不代表浏览器进程严格读隔离或禁网。project 路径不会给 shell 增加写权限。

验收前后会对整个项目做 `artifactSnapshot`，沿用快照原有对 `.git`、`.cache`、`coverage` 和 `node_modules` 的目录排除，不再排除项目内的反馈报告文件；源码和构建产物必须位于快照覆盖范围内，依赖安装目录不属于本绑定。CLI 与 `webChecks` 配置、受保护材料和整个项目工件都绑定到同一轮验收。浏览器结果只有在完成测量、artifact 保持稳定且浏览器/server/profile 清理已确认时，才会转成正常的 `passed` 或 `failed` check；浏览器启动、超时、取消、清理、结果结构或工件重检异常都会产生 `verification-error`，不会注入模型反馈。检查器或并发写入项目、检查器材料在生成阶段被修改、或身份不一致，都不能通过。`repair` 最多发出一次同会话持久插件反馈；最终完整重放只保留模型当前文件，不做多文件回滚或按局部分数混合。报告的 `delivery.fixed` 和 `delivery.regressed` 记录 CLI 与 browser 的完整 check IDs；剩余失败明确为 `public-fail`。

修复阶段或最终复测中，若工件摘要不变，同一检查 ID 的通过／失败结果必须一致。结果翻转时保留为 `verification-error`，不产生最终交付结论或追加修复；Host 报告的 `errorFacts` 以 `checker-inconsistent` 记录变化项、前后布尔结果及文件／检查器绑定，`/apex-status` 显示未验证。检查返回顺序和诊断文字变化不影响此判断。文件摘要不覆盖外部环境、服务或排除目录，结果矛盾不能自动归因为代码缺陷，也不能据此声称修复成功；应先查明测量或环境变化。实际修改已覆盖的项目文件后，仍按原流程验收新的文件版本。

发送给模型的项目反馈包含失败检查的事实、通过项数量、总项数、验收绑定摘要和工件摘要。显式要求且缺少最终回复时，另外包含 `finalResponse` 缺失事实；这时文件失败数组可以为空。显式配置下述 `requirements` 时，另外包含需求覆盖计数与未通过需求；未验证需求会明确标为缺少证据，不当作已测量缺陷。通过检查的内容、完整配置、受保护材料路径、原始 stdout/stderr 不由控制器注入修复消息。`feedbackBytes` 约束实际发送的事实 JSON；Host 报告保留完整审核信息。

`project-evaluation.mjs` 的 `projectFeedbackText(evaluation, feedbackBytes)` 复用 `projectFeedbackFacts(evaluation, feedbackBytes)` 生成事实 JSON。未启用最终回复要求时保留原有修复文字；缺少必需回复时追加补齐正文的指引。配对实验可以在两组完全相同的修复指令后，仅为反馈组附加该 JSON，避免混入提示语言差异。调用者必须先完成测量、检查集合校验及工件绑定；这两个函数只序列化已经验证的结果，不执行验收，也不自行读取会话。没有文件检查失败或已测量的必需回复缺失时，拒绝生成修复消息。原生会话分叉的公开对照实验可在相同历史和工件基础上，通过官方消息接口提交该文本；这种实验只衡量事实反馈相对普通复查的增益，不能代替自动触发闭环的集成验证，也不证明 APEX 相对官方预设的总收益。

旧 `solver.mjs` 路径仍保留原有的最佳单文件选择和回滚语义；这不适用于 `project` 路径。project 的工件摘要只是验收证据，不是备份，project 路径不会自动恢复多文件旧树。

### 需求与验收证据对应

可选 `project.requirements` 将操作者核对过的需求关联到已有 CLI 或浏览器检查。所有列出的检查都通过，才算对应需求通过；空数组明确表示尚未建立验收证据。

```yaml
project:
  command: node /absolute/path/to/checker.mjs
  protectedFiles: ["/absolute/path/to/checker.mjs"]
  checkIds: [source, build]
  requirements:
    - id: consistent-delivery
      description: 源码行为正确，交付构建与源码一致
      checkIds: [source, build]
    - id: restore-session
      description: 重新打开后恢复先前状态
      checkIds: []
```

清单支持 1–256 项，需求 ID 唯一且不超过 128 UTF-8 字节，说明不超过 1024 UTF-8 字节。每个 `checkIds` 内不得重复或引用未配置的检查；允许不同需求复用同一检查，但不会因此增加检查通过数。`[]` 表示没有检查，省略整个 `requirements` 则维持原有输出、身份摘要及反馈文字。

`evaluateProject()` 在完成测量后，将 `coverage` 写入结果；原生反馈控制器把它保存到 `candidates`、`feedback` 和 `delivery`。清单及关联关系纳入验收身份摘要，改变需求说明或对应关系都会使旧绑定失效。

| 状态 | 含义 |
| --- | --- |
| `passed` | 当前工件、当前验收绑定下，对应检查全部通过。 |
| `failed` | 有完整、有效测量，且对应检查至少一项失败。 |
| `unverified` | 尚未测量或该需求没有关联检查，不表示实现失败。 |
| `invalid` | 测量不完整或结构无效，或者工件、检查器、需求绑定已经变化；不能沿用旧通过结果。 |

报告带有 `scope: configured-requirements`、工件摘要、验收摘要和各状态计数。这只证明**配置清单在指定检查下的覆盖情况**，不能证明清单包含用户的全部需求，也不能证明关联的检查足够严格。当前版本不自动从自然语言提取完整需求，不自动生成正确检查器；这些需要分别验证。

已有检查全过但仍有未验证需求时，Host 最终状态为 `coverage-incomplete`，保留真实检查分数；不会因缺少证据而凭空制造失败或自动增加修复轮。有已测量失败时，仍最多反馈修复一次，随后完整复测。启用需求清单后，反馈正文会解释未验证状态，并仅附加未通过需求；仍受原有字节限制，超限明确失败。

历史报告保持为历史快照，不会自行更新。需要判断旧证据能否用于当前项目时，调用 `projectCoverage(agent, project, evaluation, { signal })`：它通过已有文件快照与检查器身份机制重新读取当前状态，不执行检查、不写入工件。`evaluation` 省略时返回未验证；无效测量不能变成需求失败。当前采取保守策略：快照覆盖范围内任一文件变化，会使全部已关联需求的旧证据失效；只有完成新测量才能重新得到通过。依赖目录等原有快照排除项仍不在绑定范围内。

兼容与回退：这是现有实验路径中的可选配置，正式 `apex-v1` 不自动启用，官方预设不变。省略 `requirements` 可恢复原有行为，但已冻结实验的配置和结果不应修改。没有新增依赖、后台扫描或常驻状态库；正常验收复用已有摘要，只有显式刷新历史覆盖时才重新读取文件。

## 启用

正式预设不自动启用此机制。在独立研究预设中添加：

```yaml
- id: apex-native-feedback
  name: dsh-apex/apex-v1/native-feedback
  config:
    mode: repair
    requestsPerPhase: null
    maxTokens: null
    evaluationTimeoutMs: 10000
    feedbackBytes: 16384
    reportDirectory: /absolute/path/to/host-reports
```

`mode` 默认为 `off`；`observe` 只评估和交付，`repair` 在正常完成且公开检查失败或必需的最终回复缺失时增加一次修复阶段。

启用任一路径都必须提供已存在的绝对 `reportDirectory`，与工作区解析后的真实路径互不包含。Host 在其中创建 `SHA256(canonical workspace path)/report.json`，目录以独占创建保留本次运行；同一报告目录下，恢复会话或新会话不能再次消费这个工作区的反馈额度。报告采用同目录临时文件加原子替换，文件权限为 `0600`，运行目录为 `0700`（POSIX）。持久化失败会中止相应操作，不回退到项目目录，也不删除已有报告。

初始报告只保留通用运行参数与完整配置的摘要，省略 `project` 内容和 `reportDirectory`。报告位置及真实读隔离是不同问题：普通 Harness 文件/Shell 工具仍可能读取工作区外的文件，同一系统用户的文件权限不能阻止这些读取。因此报告明确保留 `disclosure.strictReadIsolationProven:false`；此功能没有提供进程级读隔离，不能作为盲测依据。公开验收条件可以在两组对称提供；若研究需要隐藏最终评分材料，必须另行验证所有模型可用读取渠道，未通过时不得称为盲测。

从旧实验配置迁移时，新增 `reportDirectory`，并为 CLI 检查器补充真实的 `measurementComplete` 声明。缺少新字段的已启用配置或旧检查输出会明确拒绝；默认关闭的正式模式不受影响。不要改写冻结的历史实验结果。若工作区仍有旧 `.apex-native-feedback.json`，控制器在首次模型请求前停止；保留旧证据并为新实验创建工作区。项目验收本身不会自动迁移或删除旧文件。

控制器记录挂载时的 preset，并在每个全局事件、模型请求和状态处理前核对当前 live preset。Host 把同一 agent 切到 PTC 或 Minimal 时，控制器让请求正常通过，不取消该任务，也不写入或改写 project report；返回原 preset 后继续使用已有状态，已消费的修复轮不会重新开启。这里的 recompose 回归使用官方服务接口验证生命周期；它不改变官方 UI 对已开始对话的 preset 锁定，正常 UI 仍不能在首个 turn 后切换 preset。

`requestsPerPhase` 和 `maxTokens` 默认为 `null`，也可以省略。此时插件不额外限制调用次数，不改写单次输出长度；输出长度、上下文容量与请求重试沿用 Harness、会话和提供商原生配置。超过 12 次调用可以继续正常工作，仍完整记录实际调用、用量、结束原因和耗时。报告中请求的 `maxTokens: null` 表示该请求未显式指定输出上限，不代表模型服务没有上限。

等预算对照需要固定额度时，可以显式设置 `requestsPerPhase`（1–100）和 `maxTokens`（256–393216）；既有数值配置保持原语义。每阶段所有已归属该任务的模型请求共用次数额度；子会话、重试、带会话 ID 的压缩和标题调用计入。显式输出额度同时约束原生会话和辅助调用。外部独立模型服务或未标记会话 ID 的调用不在此统计范围内。

## 结果与约束

- 检查前后核对公开检查集和源码指纹；后台任务、子会话未停止时拒绝交付。
- 使用完整已执行失败事实，不要求多个候选或不同失败签名。反馈超出字节上限则停止，不能暗中截断。
- 每个正常完成阶段保存源码、执行结果和回归项。选择公开通过数最高的源码，同分保留较早源码，再全量重放并通过文件版本检查写回 `solver.mjs`。
- 报告位于配置的 Host 目录。中止、预算耗尽和工具/模型故障不等同于成功；异常中止后可能没有最终交付，报告保留已测量的检查结果。只有 solver 路径保存过的单文件源码可直接取回，project 工件摘要不能恢复多文件初稿。
- 每个新工作区只执行一轮，最多一次自动反馈修复；用户取消、执行超时和终止后的调用拦截仍有效。恢复已结束的相同工作区不能重新运行。重新研究需显式建立新工作区。
- Host 报告不是防同权限进程恶意篡改的审计存储。实验驱动须在全会话树静止后另行冻结证据，并独立评分。

该机制的工程测试不证明模型能力提升。真实效果需要等条件对照、独立检查与明确记录总成本。删除研究预设中的条目即可关闭，原有正式预设不变。
