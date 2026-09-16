"""Typeset the Chinese article and evidence supplement using installed PDF tools."""
from pathlib import Path
import hashlib
import html
import io
import json
import re
import sys
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Flowable,
    PageBreak, BalancedColumns, KeepTogether,
)
from pypdf import PdfReader, PdfWriter, Transformation

HERE = Path(__file__).resolve().parent
if sys.argv[1:] not in [[], ['--supplement-only']]:
    raise SystemExit('Usage: build-paper.py [--supplement-only]')
ROOT = HERE.parent
DATA = ROOT / 'data'
PAPER = ROOT
FIG = ROOT / 'figures'
W, H = A4
WIDTH = 183 / 25.4 * 72
MARGIN = (W-WIDTH)/2
FONT = '/System/Library/Fonts/Supplemental/Songti.ttc'
pdfmetrics.registerFont(TTFont('Song', FONT, subfontIndex=6))
pdfmetrics.registerFont(TTFont('SongBold', FONT, subfontIndex=1))
pdfmetrics.registerFontFamily('Song', normal='Song', bold='SongBold', italic='Song', boldItalic='SongBold')
pdfmetrics.registerFont(TTFont('Arial', '/System/Library/Fonts/Supplemental/Arial.ttf'))

body = ParagraphStyle('Body',fontName='Song',fontSize=9,leading=13.2,wordWrap='CJK',spaceAfter=5.2,splitLongWords=True,allowWidows=0,allowOrphans=0)
summary = ParagraphStyle('Summary',parent=body,fontName='SongBold',fontSize=10,leading=15,spaceAfter=13)
heading = ParagraphStyle('Heading',parent=body,fontName='SongBold',fontSize=10.2,leading=14,spaceBefore=7,spaceAfter=5,keepWithNext=True)
subheading = ParagraphStyle('Subheading',parent=heading,fontSize=9.2,leading=13,spaceBefore=5)
caption = ParagraphStyle('Caption',parent=body,fontSize=7.5,leading=10.2,spaceAfter=9)
small = ParagraphStyle('Small',parent=body,fontSize=8.3,leading=12,spaceAfter=5)
refstyle = ParagraphStyle('Reference',parent=small,fontSize=7.2,leading=10,spaceAfter=5)
cell = ParagraphStyle('Cell',parent=body,fontSize=7.2,leading=10,spaceAfter=0)
title = ParagraphStyle('Title',parent=heading,fontSize=21,leading=29,spaceBefore=4,spaceAfter=7)
subtitle = ParagraphStyle('Subtitle',parent=body,fontSize=10,leading=15,spaceAfter=13,textColor=colors.HexColor('#555555'))

def inline(text):
    text = html.escape(text,quote=False)
    text = re.sub(r'\[([^\]]+)\]\((https?://[^ )]+)\)',r'<a href="\2" color="#222222">\1</a>',text)
    text = re.sub(r'\*\*(.+?)\*\*',r'<b>\1</b>',text)
    text = re.sub(r'(?<!\*)\*([^*]+)\*(?!\*)',r'<i>\1</i>',text)
    text = re.sub(r'`([^`]+)`',r'\1',text)
    for symbol,num in [('¹','1'),('²','2'),('³','3'),('⁴','4')]:text=text.replace(symbol,f'<super>{num}</super>')
    return text

def paragraphs(text,style=body):
    output=[]
    for block in re.split(r'\n\s*\n',text.strip()):
        if block.startswith('### '):output.append(Paragraph(inline(block[4:]),subheading))
        elif block.startswith('## '):output.append(Paragraph(inline(block[3:]),heading))
        elif block.strip():output.append(Paragraph(inline(block.replace('\n',' ')),style))
    return output

def balanced(items):
    return BalancedColumns(items,nCols=2,innerPadding=18,leftPadding=0,rightPadding=0,topPadding=0,bottomPadding=0,spaceBefore=0,spaceAfter=7,showBoundary=False)

placements=[]
class VectorFigure(Flowable):
    def __init__(self,path):
        Flowable.__init__(self)
        self.path=path
        box=PdfReader(path).pages[0].mediabox
        self.width=WIDTH
        self.height=WIDTH*float(box.height)/float(box.width)
    def draw(self):
        x,y=self.canv.absolutePosition(0,0)
        placements.append((self.canv.getPageNumber()-1,self.path,x,y,self.width))

def decorate(canvas,doc):
    canvas.saveState()
    canvas.setFont('Song',7.2)
    canvas.setFillColor(colors.HexColor('#555555'))
    canvas.drawString(MARGIN,H-25,'研究论文' if doc.title.endswith('研究论文') else '补充材料')
    canvas.drawRightString(W-MARGIN,H-25,'APEX 1.0  |  单任务工程交付对照')
    canvas.setLineWidth(.35)
    canvas.setStrokeColor(colors.HexColor('#B5B5B5'))
    canvas.line(MARGIN,H-31,W-MARGIN,H-31)
    canvas.setFont('Song',7)
    canvas.drawString(MARGIN,24,'2026年9月16日  |  研究工作稿')
    canvas.setFont('Arial',7)
    canvas.drawRightString(W-MARGIN,24,str(doc.page))
    canvas.restoreState()

def make_pdf(path,story,name,vector=False):
    buffer=io.BytesIO()
    doc=SimpleDocTemplate(buffer,pagesize=A4,leftMargin=MARGIN,rightMargin=MARGIN,topMargin=43,bottomMargin=40,title=name,author='',subject='Descriptive single-case comparison; one generation per condition')
    doc.build(story,onFirstPage=decorate,onLaterPages=decorate)
    buffer.seek(0)
    reader=PdfReader(buffer)
    writer=PdfWriter()
    writer.append(reader)
    if vector:
        for page,path_,x,y,width in placements:
            figure=PdfReader(path_).pages[0]
            scale=width/float(figure.mediabox.width)
            writer.pages[page].merge_transformed_page(figure,Transformation().scale(scale).translate(x,y),over=True,expand=False)
    writer.add_metadata({'/Title':name,'/Author':'','/Subject':'Chinese research manuscript; descriptive n=1-per-arm comparison'})
    with path.open('wb') as handle:writer.write(handle)
    return len(writer.pages)

manifest=json.loads((DATA/'inputs-manifest.json').read_text())
assert all(hashlib.sha256((DATA/p).read_bytes()).hexdigest()==digest for p,digest in manifest['inputsSha256'].items())
text=(PAPER/'article.zh.md').read_text()
main,legend_text=text.split('## 图注',1)
legends=re.split(r'\n\s*\n',legend_text.strip())
assert len(legends)==3
pieces=re.split(r'<!-- FIGURE \d -->',main)
opening=pieces[0].strip().split('\n\n')
paper_title=opening[0].removeprefix('# ')
paper_subtitle=opening[1]
paper_summary=opening[2].strip('*')
intro='\n\n'.join(opening[3:])
mechanics,interaction=pieces[2].split('## 普通交互暴露持续渲染失效',1)
results,methods=pieces[3].split('## 方法',1)
methods,refs=methods.split('## 参考文献',1)

# The article has four reading units: argument, evidence plate, implications, end Methods.
story=[Paragraph(paper_title,title),Paragraph(paper_subtitle,subtitle),Paragraph(inline(paper_summary),summary)]
story.append(balanced(paragraphs(intro+pieces[1]+mechanics)))
story.append(PageBreak())
for i in [1,2]:
    story += [VectorFigure(FIG/f'Figure-{i}.pdf'),Paragraph(inline(legends[i-1]),caption)]
story += [PageBreak(),balanced(paragraphs('## 普通交互暴露持续渲染失效\n\n'+interaction))]
story += [VectorFigure(FIG/'Figure-3.pdf'),Paragraph(inline(legends[2]),caption)]
story += [balanced(paragraphs(results)),PageBreak()]
method_flows=paragraphs('## 方法\n\n'+methods,small)
method_flows += [Paragraph('参考文献',heading)]
for ref in re.split(r'\n(?=\d+\. )',refs.strip()):method_flows.append(Paragraph(inline(ref.replace('\n',' ')),refstyle))
story += [balanced(method_flows)]
main_pages=(len(PdfReader(PAPER/'article.pdf').pages)
            if sys.argv[1:] else make_pdf(PAPER/'article.pdf',story,paper_title+'：研究论文',vector=True))

native=json.loads((DATA/'native-evaluation.json').read_text())
apex=json.loads((DATA/'apex-evaluation.json').read_text())
comparison=json.loads((DATA/'comparison.json').read_text())
assert len(native['criteria'])==len(apex['criteria'])==37
assert round(sum(x['points'] for x in native['criteria'].values()),1)==72.8
assert round(sum(x['points'] for x in apex['criteria'].values()),1)==83.8
supp=['# 补充材料\n\nAPEX 与原生执行环境的工程交付对照\n\n本补充材料与中文研究论文配套，所有数据来自同一次冻结交付和既有验收。正文的“原生对照”对应机器记录中的 official / standard。各组独立生成 n = 1；不将零件、气缸、角度或逐秒帧率作为独立生成重复。']
supp += ['## 补充表 1 | 全部 37 项评分及判定依据\n\n分数为获得的部分信用；满分要求对应量表行全部条件成立。未验证项不按潜在满分记入。原生对照证据编号 E1-E9 见补充表 6；APEX 依据来自原冻结 evaluation.json 及其逐项链接。性能类别保留各自首次验收评分；同条件补测另列。\n\n| ID | 满分 | 原生 | APEX | 原生对照的判定依据 | APEX 的判定依据 |\n| --- | ---: | ---: | ---: | --- | --- |']
for key,row in native['criteria'].items():
    ar=apex['criteria'][key]
    reason=row['reason'].replace('|','／')+' ['+', '.join(row['evidence'])+']'
    supp.append(f"| {key} | {row['maximum']:g} | {row['points']:g} | {ar['points']:g} | {reason} | {ar['reason'].replace('|','／')} |")
supp += ['\n原始总分：原生对照 72.8；APEX 83.8。完整验收：两组均失败。原始记录中的 passed/partial/failed/not-verified 与上述数值共同保留在各自 evaluation.json，未因排版重新评分。',
'## 补充表 2 | 硬上限、未验证项与敏感性\n\n| 情形 | 原生对照 | APEX | 解释 |\n| --- | ---: | ---: | --- |\n| 原始分 | 72.8 | 83.8 | 37 项加总 |\n| 主结果最终分 | 40.0 | 83.8 | 原生 C2 = 40、C3 = 55，取最低适用上限 |\n| 仅移除 C2 | 55.0 | 83.8 | C3 仍成立 |\n| 移除全部上限 | 72.8 | 83.8 | 保留 11.0 分原始差异 |\n| 仅以同条件补测更新 APEX P2 | 40.0 | 84.8 | 补充重算，不替代主结果 83.8 |\n| 未验证可用分 | 1.0 | 0.7 | 不是置信区间或额外已得分 |\n\nC2 的依据是普通选中/旋转松手导致原程序持续渲染异常；C3 的依据是小头与活塞销完全径向分离 105 mm、孔轴与销轴近乎垂直。APEX 的 26 mm 为大头轴向错位，径向联动和部分支承仍存在，原评分在 S/K 中扣减而未应用 C3。两者均未达到完整机械要求。原生对照数值凸轮/曲轴转角比正确且存在实际运动，所以未加用 C4。\n\n原生对照未验证分包括连杆有效悬停 0.3、密闭燃烧室压缩比 0.5、后台恢复 0.2；APEX 包括后两项共 0.7。即使原生对照的未验证项全部成立，已确认的 C2/C3 仍限制最终分。',
'## 补充表 3 | 全会话树执行与资源\n\n| 指标 | 原生对照 | APEX | 说明 |\n| --- | ---: | ---: | --- |']
metrics=[('墙钟时间（ms）','durationMs'),('实际会话数','familySize'),('完成步骤','completedSteps')]
for label,key in metrics:supp.append(f"| {label} | {comparison['official'][key]:,} | {comparison['apex'][key]:,} | 提交至全树自然空闲；会话和步骤不作质量分 |")
for label,key in [('非缓存输入 token','uncachedInputTokens'),('输出 token','outputTokens'),('缓存读取 token','cacheReadTokens'),('缓存写入 token','cacheWriteTokens')]:
    supp.append(f"| {label} | {comparison['official']['tokenUsage'][key]:,} | {comparison['apex']['tokenUsage'][key]:,} | 官方 token-meter 汇总全会话树 |")
supp += ['| 工具失败事件 | 2 | 8 | 可与非零进程退出重叠 |','| 进程非零退出事件 | 9 | 10 | 含生成期间的试跑与修正过程 |',
'\n两组均一次父提示、零评价方补提示、零任务重投。原生对照提交于 11:06:09.954 UTC，自然完成事件为 11:57:12.284 UTC，保存的全树空闲边界为 11:57:23.839 UTC。墙钟时间按提交至空闲计算，包含末端轮询间隔。原始导出驱动在自然完成后退出 1，不应解释为模型生成中止。没有供应商账单，分类 token 不合并折算费用。',
'## 补充表 4 | 固定窗口的完整性能摘要\n\n| 组别 / 状态 | 均值 FPS | 最低逐秒 FPS | p95 / p99（ms） | >33.33 ms 长帧 |\n| --- | ---: | ---: | --- | ---: |']
state_names=['外观','剖视与流动','剖视、流动与旋转']
for arm,name in [('official','原生'),('apex','APEX')]:
    for i,row in enumerate(comparison['matchedPerformance'][arm]):
        supp.append(f"| {name} / {state_names[i]} | {row['meanFps']:.4f} | {row['minSecondFps']} | {row['p95Ms']:.3f} / {row['p99Ms']:.3f} | {row['longFramesOver33_33Ms']} |")
supp += ['\n每窗口预热 5 s、记录 30 s；图 3 使用各自 30 个逐秒值，不计算组间置信区间。原生对照外观最大帧间隔为 116.666 ms。目标转速均为 2100 rpm，但原生对照前两个窗口实际初始转速分别约 2033.97 和 2031.22 rpm，结束约 2100 rpm。原生负荷为 0.75；APEX 根据 RPM 导出的负荷约 0.94345，并非相同物理工况。原生持续拖动窗口本身有效，松手后出现渲染异常，不以该窗口高帧率替代交互稳定性。两组后台恢复尝试始终报告 visible，因此未验证真正的 hidden 恢复。',
'## 补充表 5 | 执行偏差及其处置\n\n| 事件 | 实际处置 | 对解释的影响 |\n| --- | --- | --- |\n| 运行内身份见证插件未加载 | 中文路径编码错误；驱动仍提交原题；保留唯一原生付费样本 | 原运行内身份链不完整，不能写成全流程见证成功 |\n| 首次零提示原型检查误报 | Cordis 对函数属性代理使直接 constructor 比较不可靠；改查精确原型、构造器及 instanceof | 后续仅确认同组合复演，不追溯补足原运行见证 |\n| 一次零提示核验启动目录错误 | tsx 在源码目录外未解析，发生于 Host 启动前；在正确目录核验 | 非模型任务重试，无新增模型提示 |\n| 原导出器拒绝内部符号链接 | 确认目标仍位于成品内；记录链接和目标摘要；只读恢复已完成运行 | 导出失败与模型自然完成分开报告 |\n| 初次性能浏览器关闭 | 第一窗口已完成，第二窗口未开始；保留第一窗口，新浏览器只记录余下两个窗口一次 | 原因不确定；不计作成品故障，不选择最佳样本 |\n| 普通选中后持续渲染异常 | 在新页面复现并对比渲染计数、内部相位、堆栈 | 支持 C2；未修改成品或覆盖初次结果 |\n| APEX 新增 Finder 元数据 | 71 个原文件逐项一致；额外 .DS_Store 单列，不删除 | 不把系统元数据变化误写成源码被改 |\n| 原生模型轨迹含宽泛 pkill | 保留在原事件审计；评价者未采用同类清理 | 无证据证明造成后来的浏览器关闭，不建立该因果关系 |',
'\n模型生成、冻结成品、测量适配与报告分别保留来源。目录分离、workspace-write 和污染日志筛查未证明所有读取通道严格隔离。量表原文提出匿名视觉评价，但本次实际评价非盲，且评价方参与过 APEX 开发；这是相对计划的偏差，不能宣称盲评完成。',
'## 补充表 6 | 数据与代码索引\n\n本表路径相对本论文公开目录。公开副本保留评分、选定测量与重建代码；完整会话、原始 trace、截图、私人配置和冻结应用未公开。删减范围见 SANITIZATION.md；公开摘要不能替代未公开原始证据的独立核验。\n\n| 编号 | 记录位置 | 对应内容 |\n| --- | --- | --- |']
index=[
('输入', 'data/prompt.md；data/rubric.md；data/protocol.md', '冻结原题、量表及运行前协议副本'),
('E1', 'data/comparison.json', '自然完成、耗时与用量摘要；原始会话和导出日志未公开'),
('E2', 'data/native-evaluation.json', '评分及判定依据；完整浏览器验收和截图未公开'),
('E3', 'data/geometry-native.json；data/mechanics-native.json', '世界坐标、孔轴、凸轮、气门与派生量'),
('E4', 'data/interaction-native.json', '新页面采样、渲染计数与错误摘要；原始堆栈未公开'),
('E5', 'data/performance-native-initial.json；data/performance-native-remaining.json；data/performance-apex.json', '六个窗口的逐秒呈现数与统计量；原始 trace 未公开'),
('E6', 'data/native-evaluation.json；data/apex-evaluation.json', '保留后台恢复未验证结论；原始尝试未公开'),
('E7', 'data/comparison.json；data/native-evaluation.json', '配置与全会话树用量摘要；完整事件和请求未公开'),
('E8', '冻结成品未公开', '不能仅凭派生坐标独立复验成品实现与缺陷'),
('E9', 'data/deviations.json', '偏差摘要；完整配置、身份见证和恢复日志未公开'),
('APEX', 'data/apex-evaluation.json；data/geometry-apex.json', '原 83.8 分、37 项判定与 APEX 实际坐标'),
('比较', 'data/comparison.json；data/scores.csv', '比较指标与全部评分'),
('原件', 'manifest.json；SANITIZATION.md', '公开文件摘要与删减范围；不证明未公开日志真实性'),
('图表', 'data/source-data.json；data/inputs-manifest.json；figures/', '显示值、七份公开输入摘要与矢量图'),
('排版', 'article.zh.md；supplement.zh.md；reproduce/', '中文文本与绘图、排版代码'),
('引文', 'citations.json；references.enw', '出版社与 Crossref 核对记录及 EndNote 导出'),
]
for row in index:supp.append('| '+' | '.join(row)+' |')
supp += ['\n## 补充说明 1 | 流动、尺寸与相位的补充证据\n\n原生对照润滑主输送曲线首尾相差 184.8134 mm，粒子在开放端回绕；独立回流曲线的存在不能证明全系统连通。冷却主曲线闭合，但支路网络未完整连接。原生喷油更新不使用曲轴相位；保持粒子状态并依次设置 0、180、340、348、360、400、540、720° 时，喷流位置和透明度不变。APEX 第 1 缸喷束在 346-372° 出现，345° 和 373° 关闭。\n\n原生对照连杆孔中心距 410 mm 保持不变，大头与曲柄销中心距接近零，但小头最大错位为 105 mm；孔轴问题另由世界方向检验。数值相位检验中的 96 次内部方向检查、25 对跨周期位置检查通过，不因此取消真实装配缺陷。原生推杆实体长度为 767.1516-774 mm，端点球间距仅 100 mm。原生气门组的 x、z 坐标均为零，而弹簧位于各缸坐标及 z = ±34 mm。\n\n原生 77 个受检圆截面有 24 个弦高不超过 0.1 mm，APEX 37 个中有 20 个。原生主轴颈、连杆颈、活塞销的相应弦高约 0.1233、0.1161、0.1258 mm；其活塞裙部几何单侧间隙 0.6 mm，与说明卡 0.09-0.12 mm 不一致。这些检查仅覆盖所列网格和角度，不替代全部几何的制造公差或密闭气体域验证。',
'## 补充说明 2 | 冻结原始任务\n\n以下为原 PROJECT_PROMPT.md 内容，保持原意和条目，不向模型加入本文的评分、错误位置或结论。\n\n'+(DATA/'prompt.md').read_text(),
'## 补充说明 3 | 研究与出版状态\n\n本研究未随机化、未盲评、未预注册跨任务重复。原评分、所有测量失败和恢复记录保留；论文重构没有新增模型生成或改变原始成品。作者、单位、通讯作者及经费信息未提供，未编造署名。本文是项目的中文研究工作稿，不代表经期刊同行评议、录用或发表。内部自查未作为独立同行评审证据。\n\n对发布前的作者核验，仍需确认正式署名、利益关系与研究责任分工；本文不擅自将未知信息写为“无利益冲突”或“无经费”。本仓库公开脱敏评分、选定测量与论文复现材料。完整日志和冻结应用未公开，因此公开读者不能独立复验全部运行与成品判定。']
supp_text='\n'.join(supp)+'\n'
(PAPER/'supplement.zh.md').write_text(supp_text)

def table(lines):
    rows=[]
    for line in lines:
        cells=[s.strip() for s in line.strip().strip('|').split('|')]
        if all(re.fullmatch(r':?-+:?',c) for c in cells):continue
        rows.append([Paragraph(inline(c),cell) for c in cells])
    n=len(rows[0])
    widths={6:[25,24,28,30,204,WIDTH-311],5:[135,69,85,130,WIDTH-419],4:[132,75,75,WIDTH-282],3:[49,248,WIDTH-297]}[n]
    result=Table(rows,colWidths=widths,repeatRows=1,hAlign='LEFT')
    result.setStyle(TableStyle([
        ('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),4),('RIGHTPADDING',(0,0),(-1,-1),4),
        ('TOPPADDING',(0,0),(-1,-1),4),('BOTTOMPADDING',(0,0),(-1,-1),4),
        ('BACKGROUND',(0,0),(-1,0),colors.HexColor('#F0F0F0')),
        ('LINEABOVE',(0,0),(-1,0),.65,colors.black),('LINEBELOW',(0,0),(-1,0),.4,colors.black),
        ('LINEBELOW',(0,-1),(-1,-1),.65,colors.black),
    ]))
    return result

lines=supp_text.splitlines();flows=[];i=0
while i<len(lines):
    line=lines[i].strip()
    if not line:i+=1;continue
    if line.startswith('|'):
        group=[]
        while i<len(lines) and lines[i].strip().startswith('|'):group.append(lines[i]);i+=1
        flows += [table(group),Spacer(1,9)];continue
    if line.startswith('# '):flows.append(Paragraph(inline(line[2:]),title));i+=1;continue
    if line.startswith('## '):flows.append(Paragraph(inline(line[3:]),heading));i+=1;continue
    block=[line];i+=1
    while i<len(lines) and lines[i].strip() and not lines[i].startswith(('#','|')):block.append(lines[i].strip());i+=1
    flows.append(Paragraph(inline(' '.join(block)),small))
supp_pages=make_pdf(PAPER/'supplement.pdf',flows,paper_title+'：补充材料')
print(json.dumps({'articlePages':main_pages,'supplementPages':supp_pages,'vectorFigurePlacements':len(placements)},ensure_ascii=False))
