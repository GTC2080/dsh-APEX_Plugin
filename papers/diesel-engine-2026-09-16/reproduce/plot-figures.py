"""Replot saved measurements. No model calls, artifact edits, or inferred repeats."""
from pathlib import Path
import hashlib
import json
import math
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.font_manager import fontManager

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DATA = ROOT / 'data'
FIG = ROOT / 'figures'
FIG.mkdir(exist_ok=True)
inputs = {}

def read(path):
    import os
    inputs[os.path.relpath(path, DATA)] = hashlib.sha256(path.read_bytes()).hexdigest()
    return json.loads(path.read_text())

c = read(DATA / 'comparison.json')
g = read(DATA / 'geometry-native.json')
a = read(DATA / 'geometry-apex.json')
e = read(DATA / 'interaction-native.json')
o1 = read(DATA / 'performance-native-initial.json')
o2 = read(DATA / 'performance-native-remaining.json')
ap = read(DATA / 'performance-apex.json')
fontManager.addfont('/System/Library/Fonts/Supplemental/Arial.ttf')
fontManager.addfont('/System/Library/Fonts/Supplemental/Arial Bold.ttf')
plt.rcParams.update({
    'font.family': 'Arial', 'font.size': 7, 'axes.labelsize': 7,
    'xtick.labelsize': 6, 'ytick.labelsize': 6, 'legend.fontsize': 6,
    'axes.linewidth': .6, 'lines.linewidth': .9, 'xtick.major.width': .5,
    'ytick.major.width': .5, 'xtick.major.size': 2.5, 'ytick.major.size': 2.5,
    'axes.spines.top': False, 'axes.spines.right': False,
    'pdf.fonttype': 42, 'ps.fonttype': 42, 'svg.fonttype': 'none',
    'text.color': '#222222', 'axes.labelcolor': '#222222',
})
OFF, AX, RED = '#42667B', '#BC6C36', '#AB3E42'
colors = {'official': OFF, 'apex': AX}
labels = {'official': 'Native', 'apex': 'APEX'}
WIDTH = 183 / 25.4

def panel(ax, letter, title):
    ax.text(-.025 / ax.get_position().width, 1.08, letter, transform=ax.transAxes, weight='bold', fontsize=8, va='bottom')
    ax.text(0, 1.09, title, transform=ax.transAxes, fontsize=7, va='bottom')

def save(fig, name):
    # Preserve the exact 183-mm canvas; no tight cropping that changes publication size.
    for ext in ['pdf', 'svg', 'png']:
        fig.savefig(FIG / f'{name}.{ext}', dpi=600, facecolor='white')
        if ext == 'svg':
            path = FIG / f'{name}.{ext}'
            path.write_text('\n'.join(line.rstrip() for line in path.read_text().splitlines()) + '\n')
    plt.close(fig)

fig = plt.figure(figsize=(WIDTH, 106 / 25.4))
grid = fig.add_gridspec(2, 2, left=.12, right=.97, bottom=.11, top=.89, hspace=.66, wspace=.58)
ax1, ax2, ax3, ax4 = [fig.add_subplot(grid[i, j]) for i, j in [(0,0),(0,1),(1,0),(1,1)]]
panel(ax1, 'a', 'Raw and final scores')
for y, arm in [(1, 'official'), (0, 'apex')]:
    raw, final = c[arm]['rawScore'], c[arm]['finalScore']
    ax1.plot([final, raw], [y, y], color=colors[arm], lw=1.2)
    ax1.scatter([raw], [y], s=41, facecolors='white', edgecolors=colors[arm], zorder=3, linewidths=1)
    ax1.scatter([final], [y], s=14, color=colors[arm], zorder=4)
    ax1.text(raw, y+.19, f'{raw:.1f}', ha='center', fontsize=7)
    if raw != final: ax1.text(final, y-.24, f'{final:.1f}', ha='center', fontsize=7)
ax1.set(yticks=[0,1], yticklabels=['APEX','Native'], ylim=(-.55,1.7), xlim=(0,100), xlabel='Score (out of 100)', xticks=[0,25,50,75,100])
ax1.legend(handles=[Line2D([],[], marker='o', ls='', mfc='white', mec='#444444', ms=4, label='Raw'), Line2D([],[],marker='o',ls='',color='#444444',ms=3,label='Final')], frameon=False, ncol=2, loc='upper left', bbox_to_anchor=(0,1.02), borderpad=0, handletextpad=.3)

panel(ax2, 'b', 'Score within each category')
for i, row in enumerate(c['categories']):
    y=7-i
    vals=[row[arm]/row['maximum']*100 for arm in ['official','apex']]
    ax2.plot(vals,[y,y],color='#BABFC2',lw=.7)
    for value,arm in zip(vals,['official','apex']):ax2.scatter(value,y,s=16,color=colors[arm],zorder=3)
ax2.set(yticks=list(range(8)),yticklabels=[f"{r['key']} ({r['maximum']})" for r in reversed(c['categories'])],ylim=(-.5,7.7),xlim=(0,100),xticks=[0,25,50,75,100],xlabel='Fraction of available points (%)')

panel(ax3, 'c', 'Time to natural completion')
for y,arm in [(1,'official'),(0,'apex')]:
    val=c[arm]['durationMs']/60000
    ax3.barh(y,val,height=.34,color=colors[arm])
    ax3.text(val+1,y,f'{val:.2f}',va='center',fontsize=7)
ax3.set(yticks=[0,1],yticklabels=['APEX','Native'],ylim=(-.6,1.6),xlim=(0,61),xticks=[0,15,30,45,60],xlabel='Wall-clock time (min)')

panel(ax4, 'd', 'APEX / native token use')
token_keys=[('outputTokens','Output'),('uncachedInputTokens','Uncached input'),('cacheReadTokens','Cache read')]
ax4.axvline(1,color='#999999',ls=(0,(3,3)),lw=.7)
for y,(key,label) in zip([2,1,0],token_keys):
    val=c['differences']['usageRatiosApexOverOfficial'][key]
    ax4.plot([1,val],[y,y],color=AX,lw=1)
    ax4.scatter(val,y,color=AX,s=19)
    ax4.text(val+.10,y,f'{val:.2f}',va='center',fontsize=7)
ax4.set(yticks=[0,1,2],yticklabels=['Cache read','Uncached input','Output'],ylim=(-.6,2.6),xlim=(0,5.35),xticks=[0,1,2,3,4,5],xlabel='Ratio (native = 1)')
fig.legend(handles=[Line2D([],[],marker='o',ls='',color=OFF,label='Native',ms=4),Line2D([],[],marker='o',ls='',color=AX,label='APEX',ms=4)],loc='upper center',bbox_to_anchor=(.55,1.0),ncol=2,frameon=False)
save(fig,'Figure-1')

fig=plt.figure(figsize=(WIDTH, 108/25.4))
grid=fig.add_gridspec(2,3,width_ratios=[1.04,1,1],left=.075,right=.985,bottom=.15,top=.90,wspace=.56,hspace=.65)
aa=fig.add_subplot(grid[:,0]);bb=fig.add_subplot(grid[0,1:]);cc=fig.add_subplot(grid[1,1]);dd=fig.add_subplot(grid[1,2])
panel(aa,'a','Actual rod centres at 90°')
sample=next(s for s in g['samples'] if s['angle']==90)['cylinders'][0]
coords={key:sample[key]['centerMm'] for key in ['rodBig','rodSmall','pistonPin']}
big,small,pin=[coords[key] for key in ['rodBig','rodSmall','pistonPin']]
aa.plot([big[2],small[2]],[big[1],small[1]],lw=3.5,color=OFF,solid_capstyle='round')
aa.scatter([big[2],small[2]],[big[1],small[1]],s=39,facecolors='white',edgecolors=OFF,lw=1,zorder=3)
aa.scatter(pin[2],pin[1],s=25,marker='s',color=RED,zorder=3)
aa.plot([pin[2],small[2]],[pin[1],small[1]],color=RED,ls='--',lw=.8)
aa.annotate('105 mm',xy=(53,pin[1]),xytext=(53,pin[1]+48),ha='center',fontsize=7,color=RED,arrowprops={'arrowstyle':'-','color':RED,'lw':.6})
aa.text(pin[2]-5,pin[1]-22,'Piston pin',ha='right',fontsize=6)
aa.text(small[2]+4,small[1]-22,'Small bore',ha='left',fontsize=6)
aa.text(big[2]+8,big[1]-24,'Big bore /\ncrank pin',fontsize=6,va='top')
aa.text(60,212,'410 mm',rotation=82,ha='center',fontsize=7,color=OFF)
aa.set(xlim=(-110,180),ylim=(-70,505),xlabel='z (mm)',ylabel='y (mm)',xticks=[0,100],yticks=[0,100,200,300,400])
aa.set_aspect('equal',adjustable='box')

panel(bb,'b','Maximum centre separation across four cylinders')
gap_data=[]
for arm,geo in [('official',g),('apex',a)]:
    samples=sorted([s for s in geo['samples'] if 0<=s['angle']<=720],key=lambda s:s['angle'])
    for end,style in [('small','-'),('big','--')]:
        def gap(cyl):
            if arm=='official':return cyl[end+'PinGapMm']
            return cyl['rodSmallPinDistanceMm'] if end=='small' else math.hypot(cyl['rodBigPinAxialOffsetMm'],cyl['rodBigPinRadialDistanceMm'])
        vals=[max(gap(cyl) for cyl in s['cylinders']) for s in samples]
        bb.plot([s['angle'] for s in samples],vals,style,color=colors[arm],marker='o',ms=1.7,lw=.85,label=f'{labels[arm]}, {end}')
        gap_data += [{'arm':arm,'end':end,'angleDeg':s['angle'],'maxDistanceMm':v} for s,v in zip(samples,vals)]
bb.set(xlim=(0,720),ylim=(-5,120),xticks=[0,180,360,540,720],yticks=[0,50,100],xlabel='Crank angle (°)',ylabel='Distance (mm)')
fig.legend(*bb.get_legend_handles_labels(),ncol=4,frameon=False,loc='lower center',bbox_to_anchor=(.56,.004),columnspacing=1.8,handlelength=2)

panel(cc,'c','Actual cam-axis orbit')
cam=[s['camShaft']['centerMm'] for s in sorted(g['samples'],key=lambda s:s['angle']) if 0<=s['angle']<=720]
cc.plot([p[2] for p in cam],[p[1] for p in cam],color=OFF,lw=.8,marker='o',ms=1.9)
cc.plot(0,0,'+',color='#333333',ms=5)
cc.plot([0,cam[0][2]],[0,cam[0][1]],color='#999999',lw=.6,ls=':')
cc.annotate('r = 240 mm',xy=(0,-180),xytext=(70,-130),fontsize=6)
cc.set(xlim=(-290,290),ylim=(-290,290),xticks=[-240,0,240],yticks=[-240,0,240],xlabel='z (mm)',ylabel='y (mm)')
cc.set_aspect('equal',adjustable='box')

panel(dd,'d','Rendering after selection')
records=[e[key] for key in ['preClick','preClickLater','afterClick','afterClickLater']]
t=[(v['at']-records[0]['at'])/1000 for v in records]
dd.axvspan(t[1],t[2],color='#E8EAEB',zorder=0)
dd.plot(t,[v['frame'] for v in records],'-o',color=OFF,ms=3,lw=1)
dd.text(t[-1]-.07,242,'234',ha='right',color=RED,fontsize=7)
dd.text(.13,.12,'Phase still changes',transform=dd.transAxes,fontsize=6,color=RED)
dd.set(xlim=(-.08,2.75),ylim=(150,255),xticks=[0,1,2],yticks=[160,200,240],xlabel='Time from first sample (s)',ylabel='Cumulative rendered frames')
save(fig,'Figure-2')

states={'official':o1['states']+o2['states'],'apex':ap['states']}
assert all(len(v)==3 for v in states.values())
fig=plt.figure(figsize=(WIDTH,82/25.4))
grid=fig.add_gridspec(2,3,left=.09,right=.98,bottom=.14,top=.88,wspace=.37,hspace=.92,height_ratios=[1,1.05])
names=['Exterior','Section + flows','Section + flows + rotation']
for i in range(3):
    ax=fig.add_subplot(grid[0,i]);panel(ax,'abc'[i],names[i])
    ax.axhline(60,color='#999999',lw=.65,ls=(0,(3,3)))
    for arm in ['official','apex']:
        p=states[arm][i]['presented']
        assert len(p['perSecond'])==30 and abs(sum(p['perSecond'])/30-p['meanFps'])<1e-8
        ax.plot(range(1,31),p['perSecond'],color=colors[arm],lw=.75)
    ax.set(xlim=(1,30),ylim=(55,125),xticks=[1,15,30],yticks=[60,90,120],xlabel='Recorded second')
    if i==0:ax.set_ylabel('Presented frames per second')
ax=fig.add_subplot(grid[1,:])
box=ax.get_position()
ax.set_position([.155,box.y0,.825,box.height])
panel(ax,'d','Window means')
for i,label in enumerate(names):
    vals=[states[arm][i]['presented']['meanFps'] for arm in ['official','apex']]
    ax.plot(vals,[2-i,2-i],color='#AEB6BA',lw=.8)
    for j,(arm,val) in enumerate(zip(['official','apex'],vals)):
        ax.plot(val,2-i,'o',color=colors[arm],ms=3.5)
        # Opposite alignment avoids collisions of nearby means.
        ax.annotate(f'{val:.1f}',xy=(val,2-i),xytext=(-7 if val==min(vals) else 7,0),textcoords='offset points',ha='right' if val==min(vals) else 'left',va='center',fontsize=6,color=colors[arm])
ax.axvline(60,color='#999999',ls=(0,(3,3)),lw=.65)
ax.set(yticks=[0,1,2],yticklabels=['Rotation','Section + flows','Exterior'],ylim=(-.6,2.6),xlim=(0,132),xticks=[0,30,60,90,120],xlabel='Mean effective presentation rate (FPS)')
fig.legend(handles=[Line2D([],[],color=OFF,label='Native'),Line2D([],[],color=AX,label='APEX')],frameon=False,ncol=2,loc='upper center',bbox_to_anchor=(.55,1.0))
save(fig,'Figure-3')

source={
    'scope':'One generation per arm; within-artifact samples are not independent generations.',
    'figure1':{'comparison':c},
    'figure2':{'native90DegreesCylinder1':coords,'connectionDistances':gap_data,'nativeCamCentresMm':cam,'selectionSamples':records},
    'figure3':{arm:[{'condition':s['condition'],'beforeRpm':s['before']['app'].get('rpm'),'perSecond':s['presented']['perSecond'],'meanFps':s['presented']['meanFps'],'p95Ms':s['presented']['p95Ms'],'p99Ms':s['presented']['p99Ms'],'longFramesOver33_33Ms':s['presented']['longFramesOver33_33Ms']} for s in state] for arm,state in states.items()}
}
assert c['official']['rawScore']==72.8 and c['official']['finalScore']==40
assert c['apex']['rawScore']==83.8 and c['apex']['finalScore']==83.8
assert abs(max(v['maxDistanceMm'] for v in gap_data if v['arm']=='official')-105)<1e-6
assert e['renderFrozen'] and records[2]['frame']==records[3]['frame']==234
(DATA/'source-data.json').write_text(json.dumps(source,ensure_ascii=False,indent=2)+'\n')
(DATA/'inputs-manifest.json').write_text(json.dumps({'inputsSha256':inputs,'source':'Existing frozen observations only','generationNPerArm':1},ensure_ascii=False,indent=2)+'\n')
print('Created three vector figures with source data and input hashes.')
