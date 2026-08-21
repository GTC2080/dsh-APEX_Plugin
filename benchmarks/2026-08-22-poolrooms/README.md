# Poolrooms：官方 Minimal 与 APEX v0.6.1 pilot 对比

测试日期：2026-08-20 至 2026-08-22（Australia/Sydney）

这是同一道 Poolrooms WebGL 工程题下的单样本 pilot。它评价最终可运行产物和执行轨迹，
不把模型自述当作证据，也不用于宣称 APEX 已经稳定优于官方 Minimal。

## 结论

- 官方 Minimal 的干净成品评分为 **85/100**。
- APEX v0.6.1 最新成品评分为 **83/100**，低 2 分；但该会话中途修复了宿主
  `apex_validate_web` 的 FPS 采样，并由评测方恢复会话，因此只能视为“有人为介入的成品评分”。
- 最新没有宿主修复介入的配对记录中，APEX v0.6.1 为 **74/100**，低于 Minimal 11 分。
- 当前证据支持发布 v0.6.1 作为实验版本，但**不支持稳定质量提升的结论**。

## 固定条件

- 两组使用同一份[原始提示词](./prompt.md)，SHA-256：
  `a7ada83fd3c53bf16f6560405a2eebd0a15f33a8bba0f941f04636729288ad93`。
- Provider/model：`deepseek-official/deepseek-v4-pro`。
- Reasoning effort：`max`；权限：`workspace-write`。
- Harness 基线：`post-dsh-v0.1.0-rc.8`。
- 每个 case 使用全新 session 和独立 workspace。
- 评分使用同一份[100 分量表](./rubric.md)，量表 SHA-256：
  `c9764eefb78ff7849d0c29e0750dae63fdb154526f33b1f0e1ac16ea53e8619d`。
- 每条评分记录都只来自一次运行；尚未完成每组至少 5 次的重复盲测。

结构化数据见 [`results.json`](./results.json)。

## 成品评分

| 类别 | 满分 | 官方 Minimal | APEX v0.6.1 最新成品 |
| --- | ---: | ---: | ---: |
| 可运行性与任务边界 | 8 | 8 | 8 |
| 程序化空间与无限感 | 18 | 17 | 16 |
| 水体与 PBR 材质 | 22 | 20 | 20 |
| 光照、反射与后处理 | 18 | 15 | 12 |
| 第一人称交互与氛围 | 12 | 10 | 9 |
| 性能、流式资源与兼容性 | 15 | 9 | 12 |
| 工程可靠性 | 7 | 6 | 6 |
| **总计** | **100** | **85** | **83** |

APEX 的主要优势是留下了可复核的运行性能证据，并实现有界 3×3 区块流式、双 Render Target
水体和程序化 PBR 材质。主要扣分来自曝光过高、门洞纯黑、缺少 bloom/色差/效果开关、无音频，
以及 WebGPU/后处理能力检测和降级不完整。

Minimal 的主要优势是画面层次、后期效果和氛围反馈更完整，并使用 5×5 动态区块。主要扣分来自
没有保存可比较的固定 FPS/p95 数据、只支持 WebGL2，以及能力检测和降级不完整。

## 运行验收

### APEX v0.6.1 最新成品

- Google Chrome，1440×900，DPR 1，WebGL2。
- 3 秒 `requestAnimationFrame` 采样：119.89 FPS，p95 9.3 ms。
- 点击画布及 W、方向键、Space、D 的固定输入序列完成。
- console、page、network、HTTP 错误均为 0。
- 存在一条非致命 SSR Gaussian blur 采样裁剪 warning。

### 官方 Minimal

- Chrome 中页面、resize、键盘移动、跨门进入浅水区、动态区块切换和水体渲染通过。
- SSR 开关实际改变全帧输出。
- 没有保存与 APEX 同合同的固定 rAF FPS/p95 数值，因此不能直接比较帧率。

## 实验有效性边界

APEX 最新成品会话不是干净的模型对比样本：宿主 FPS 采样缺陷在运行中被修复，随后评测方恢复
会话并要求收敛；该轮没有启动代码 Worker，只启动了 5 个只读 Vision 子会话。因此 83 分只能说明
最终产物达到的质量，不能单独归因于插件调度。

作为干净配对参考，较早的 APEX v0.6.1 成品为 74/100：运行成功，但在画面、音频、兼容降级和
工程细节上明显落后于 Minimal。两组都只有单样本，正式结论仍需要在不修宿主、不恢复会话、
不暴露评分材料的条件下重复盲测。

公开记录有意排除了 session ID、本机路径、压缩会话历史、依赖缓存和完整生成 workspace。
