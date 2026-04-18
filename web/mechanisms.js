const C = HGDBCore;
const btnPrev = document.getElementById('btnPrev');
const btnNext = document.getElementById('btnNext');
const btnAuto = document.getElementById('btnAuto');
const logEl = document.getElementById('mechanismLog');
const mStep = document.getElementById('mStep');
const mReq = document.getElementById('mReq');
const mConf = document.getElementById('mConf');
const mK = document.getElementById('mK');
const narrative = document.getElementById('mechanismNarrative');
const pipeline = document.getElementById('pipeline');
const canvas = document.getElementById('mechanismCanvas');

let timeline = [];
let ptr = 0;
let timer = null;

function pulse(stages){
  [...pipeline.querySelectorAll('.node')].forEach(n=>n.classList.remove('active'));
  stages.forEach((s,i)=>setTimeout(()=>{ const n=pipeline.querySelector(`.node[data-node="${s}"]`); if(n) n.classList.add('active'); },i*120));
  setTimeout(()=>{ const d=pipeline.querySelector('.node[data-node="done"]'); if(d) d.classList.add('active'); },stages.length*120+120);
}

function drawMechanism(ev){
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);

  const boxes = [
    {x:40,y:50,w:180,h:70,t:'Request In'},
    {x:260,y:50,w:180,h:70,t:'Lookup'},
    {x:480,y:50,w:180,h:70,t:'PRS Gate'},
    {x:700,y:50,w:160,h:70,t:'Tier2 Evict'},
    {x:260,y:200,w:180,h:70,t:'Ghost Cache'},
    {x:480,y:200,w:180,h:70,t:'Tier3 Rebalance'},
    {x:700,y:200,w:160,h:70,t:'Output State'}
  ];

  const activeColor = '#34e3b2';
  const normal = 'rgba(255,255,255,.12)';
  const text = '#dce8ff';

  const has = s => ev?.stages?.includes(s);

  function b(i, highlight){
    const q=boxes[i];
    ctx.fillStyle='rgba(255,255,255,.03)';
    ctx.strokeStyle = highlight ? activeColor : normal;
    ctx.lineWidth = highlight ? 3 : 1.2;
    ctx.fillRect(q.x,q.y,q.w,q.h);
    ctx.strokeRect(q.x,q.y,q.w,q.h);
    ctx.fillStyle=text; ctx.font='13px Manrope'; ctx.fillText(q.t,q.x+12,q.y+40);
  }

  b(0,true); b(1,has('lookup')); b(2,has('prs')); b(3,has('evict')); b(4,has('ghost')); b(5,has('rebalance')); b(6,true);

  const arrows = [
    [220,85,260,85],[440,85,480,85],[660,85,700,85],[350,120,350,200],[570,120,570,200],[660,235,700,235]
  ];
  ctx.strokeStyle='#5f739f'; ctx.lineWidth=1.5;
  arrows.forEach(a=>{ ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(a[2],a[3]); ctx.stroke(); });

  ctx.fillStyle='#a9bbdf'; ctx.font='14px Manrope';
  const req = ev?.req ? `id=${ev.req.id}, class=${ev.req.class}, priority=${ev.req.priority}, cost=${ev.req.cost}` : 'No event selected';
  ctx.fillText(`Current Request: ${req}`, 40, 330);
  const eventText = ev?.log?.join(' | ') || 'Run simulator first.';
  const lines = wrap(ctx, eventText, 820);
  lines.forEach((line,i)=>ctx.fillText(line, 40, 360+i*24));
}

function wrap(ctx, text, maxW){
  const words=text.split(' '); const lines=[]; let line='';
  for(const w of words){ const test=line?`${line} ${w}`:w; if(ctx.measureText(test).width>maxW){ lines.push(line); line=w; } else line=test; }
  if(line) lines.push(line); return lines.slice(0,4);
}

function render(){
  if(!timeline.length){
    mStep.textContent='0'; mReq.textContent='-'; mConf.textContent='-'; mK.textContent='-';
    logEl.textContent='No simulator timeline found. Run simulator page first.';
    drawMechanism(null);
    return;
  }
  const ev = timeline[ptr];
  mStep.textContent = `${ptr+1}/${timeline.length}`;
  mReq.textContent = `id ${ev.req.id}`;
  mConf.textContent = C.fmt(ev.conf,3);
  mK.textContent = ev.k;
  logEl.innerHTML = ev.log.map(x=>`<div>${x}</div>`).join('');
  pulse(ev.stages);
  drawMechanism(ev);
  narrative.textContent = ev.log.join(' | ');
}

function load(){
  const cfg=C.loadState(C.STORAGE_KEYS.cfg,null);
  const req=C.loadState(C.STORAGE_KEYS.workload,null);
  if(!cfg||!req||!req.length){ timeline=[]; render(); return; }
  const sim=new C.HGDBSimulator(cfg,req.slice(0,cfg.N));
  sim.runAll();
  timeline = sim.summary().timeline || [];
  ptr = Math.min(ptr, Math.max(0,timeline.length-1));
  render();
}

btnPrev.addEventListener('click', ()=>{ if(!timeline.length) return; ptr=Math.max(0,ptr-1); render(); });
btnNext.addEventListener('click', ()=>{ if(!timeline.length) return; ptr=Math.min(timeline.length-1,ptr+1); render(); });
btnAuto.addEventListener('click', ()=>{
  if(timer){ clearInterval(timer); timer=null; btnAuto.textContent='Auto Play'; return; }
  btnAuto.textContent='Stop';
  timer=setInterval(()=>{
    if(!timeline.length){ clearInterval(timer); timer=null; btnAuto.textContent='Auto Play'; return; }
    if(ptr>=timeline.length-1){ clearInterval(timer); timer=null; btnAuto.textContent='Auto Play'; return; }
    ptr++; render();
  }, 800);
});

load();
