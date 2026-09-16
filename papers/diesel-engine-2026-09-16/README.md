# APEX 与原生执行环境的工程交付对照

四冲程柴油机单案例研究 · 2026-09-16 · 中文 Nature 式研究工作稿

- **[研究论文 PDF](article.pdf)** 与 [中文正文](article.zh.md)。
- **[补充材料 PDF](supplement.pdf)** 与 [补充材料文本](supplement.zh.md)：全部 37 项评分、用量、性能、偏差与证据索引。
- [三张图表](figures/)：矢量 PDF、SVG 与 600 dpi PNG。
- [图表源数据](data/source-data.json)、[全部评分](data/scores.csv)、[公开文件摘要](manifest.json)。
- [引文核对](citations.json)、[EndNote 文献](references.enw)、[脱敏与复核边界](SANITIZATION.md)。

| 指标 | 原生对照 | APEX |
| --- | ---: | ---: |
| 原始分 | 72.8 | 83.8 |
| 最终分 | 40.0 | 83.8 |
| 墙钟时间（ms） | 3,073,885 | 1,604,643 |
| 输出 token | 265,713 | 1,229,906 |
| 完整验收 | 失败 | 失败 |

**每组独立生成 n = 1；非盲、固定顺序、总预算不等。** 不能证明普遍或因果能力提升，也不能推出费用优势。内部自查不属于独立同行评审；本文未声称期刊录用或发表。

## 离线复现

从本目录运行。Python 需要 matplotlib、ReportLab、pypdf；字体使用 macOS 自带 Arial 与宋体。其他平台需提供相同字体或记录替换后的排版差异。

~~~sh
python3 reproduce/plot-figures.py
python3 reproduce/build-paper.py
~~~

绘图读取 data/ 中选定测量，排版读取正文与评分。不调用模型或重测成品；补充材料由排版脚本生成。PDF/SVG 生成元数据可能变化，数据值与图形内容应保持一致。

data/protocol.md 保留运行前协议的准备状态，实际配置和偏差以论文与补充表 5 为准。

## 公开范围

本地完整原始记录保持不变。完整模型会话、系统请求、私人配置、原始 trace、截图和冻结应用没有加入本仓库。公开读者可以复核数值、评分加总与图表重建，无法独立重验全部模型行为和成品缺陷。见 [SANITIZATION.md](SANITIZATION.md)。
