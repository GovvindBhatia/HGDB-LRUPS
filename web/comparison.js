const C = HGDBCore;
const cards = document.getElementById('cards');
const btn = document.getElementById('btnRunCompare');
const bar = document.getElementById('barChart');
const line = document.getElementById('lineChart');

function card(item){
  return `<article class="card"><h3>${item.name}</h3><p><b>Hit Rate:</b> ${C.fmt(item.hitRate*100,2)}%</p><p><b>Weighted Miss Cost:</b> ${C.fmt(item.weightedMissCost,2)}</p><p><b>Misses:</b> ${item.misses}</p><p><b>Evictions:</b> ${item.evictions}</p><p><b>Decision Ops (proxy):</b> ${Math.round(item.decisionOps||0)}</p></article>`;
}

function drawBars(comp){
  const ctx=bar.getContext('2d'); ctx.clearRect(0,0,bar.width,bar.height);
  const data=[comp.hg,comp.lru,comp.arc,comp.rrip];
  const pad=60, W=bar.width-pad*2, H=bar.height-130;
  const panelGap=40;
  const panelW=(W-panelGap)/2;
  const leftX=pad, rightX=pad+panelW+panelGap;
  const slotL=panelW/data.length, slotR=panelW/data.length;
  const maxCost=Math.max(...data.map(d=>Number.isFinite(d.weightedMissCost)?d.weightedMissCost:0),1);
  ctx.fillStyle='#d6e4ff'; ctx.font='12px Manrope';
  ctx.fillText('Comparison metrics from identical input trace',20,24);
  ctx.fillText('Left panel: Hit Rate (%) with fixed 0-100 axis | Right panel: Weighted Miss Cost',20,42);

  ctx.strokeStyle='#2f3f69'; ctx.lineWidth=1;
  for(let i=0;i<=5;i++){
    const y=bar.height-50-(H*i/5);
    ctx.beginPath(); ctx.moveTo(leftX,y); ctx.lineTo(leftX+panelW,y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(rightX,y); ctx.lineTo(rightX+panelW,y); ctx.stroke();
  }

  data.forEach((d,i)=>{
    const hitPct = Number.isFinite(d.hitRate) ? d.hitRate * 100 : 0;
    const missCost = Number.isFinite(d.weightedMissCost) ? d.weightedMissCost : 0;
    const xl=leftX+i*slotL+slotL*0.25, wl=slotL*0.5, h1=Math.max(2,(hitPct/100)*H);
    const xr=rightX+i*slotR+slotR*0.25, wr=slotR*0.5, h2=Math.max(2,(missCost/maxCost)*H);
    ctx.fillStyle='#34e3b2'; ctx.fillRect(xl,bar.height-50-h1,wl,h1);
    ctx.fillStyle='#22b7ff'; ctx.fillRect(xr,bar.height-50-h2,wr,h2);
    ctx.fillStyle='#d6e4ff';
    ctx.fillText(`${C.fmt(hitPct,1)}%`,xl,bar.height-55-h1);
    ctx.fillText(`${C.fmt(missCost,1)}`,xr,bar.height-55-h2);
    ctx.fillText(d.name.replace('-LRUPS',''), xl, bar.height-30);
    ctx.fillText(d.name.replace('-LRUPS',''), xr, bar.height-30);
  });
  ctx.fillStyle='#9bb0d8';
  ctx.fillText('Hit Rate (%)', leftX + panelW/2 - 26, bar.height-8);
  ctx.fillText('Weighted Miss Cost', rightX + panelW/2 - 50, bar.height-8);
  ctx.fillText('0', leftX-12, bar.height-46);
  ctx.fillText('100', leftX-24, bar.height-50-H);
  ctx.fillText('0', rightX-12, bar.height-46);
  ctx.fillText(`${C.fmt(maxCost,0)}`, rightX-32, bar.height-50-H);
  ctx.strokeStyle='#8ea5d3';
  ctx.strokeRect(leftX, bar.height-50-H, panelW, H);
  ctx.strokeRect(rightX, bar.height-50-H, panelW, H);

  const allZeroHit = data.every(d => (Number.isFinite(d.hitRate) ? d.hitRate : 0) === 0);
  if (allZeroHit) {
    ctx.fillStyle = '#ffcc66';
    ctx.fillText('Note: All hit rates are 0% for this trace. Try Simulator -> Generate Stable/Drift and rerun.', 20, bar.height - 68);
  }
}

function drawLine(hg){
  const ctx=line.getContext('2d'); ctx.clearRect(0,0,line.width,line.height);
  let conf=(hg.confidenceSeries||[]).map(v=>Number.isFinite(v)?v:0);
  let ks=(hg.kSeries||[]).map(v=>Number.isFinite(v)?v:0);
  if(!conf.length || !ks.length){
    ctx.fillStyle='#d6e4ff';
    ctx.font='12px Manrope';
    ctx.fillText('No adaptation series available. Run simulator first, then refresh comparison.',20,24);
    return;
  }
  const pad=45, W=line.width-pad*2, H=line.height-pad*2, maxK=Math.max(...ks,1);
  ctx.strokeStyle='#2f3f69'; for(let i=0;i<=5;i++){ const y=pad+H*i/5; ctx.beginPath(); ctx.moveTo(pad,y); ctx.lineTo(line.width-pad,y); ctx.stroke(); }
  ctx.strokeStyle='#34e3b2'; ctx.lineWidth=2; ctx.beginPath(); conf.forEach((v,i)=>{const vv=Math.max(0,Math.min(1,v)); const x=pad+W*i/Math.max(1,conf.length-1), y=pad+(1-vv)*H; i?ctx.lineTo(x,y):ctx.moveTo(x,y);}); ctx.stroke();
  ctx.strokeStyle='#ffcc66'; ctx.beginPath(); ks.forEach((v,i)=>{const vv=Math.max(0,v); const x=pad+W*i/Math.max(1,ks.length-1), y=pad+(1-vv/maxK)*H; i?ctx.lineTo(x,y):ctx.moveTo(x,y);}); ctx.stroke();

  // Draw points so lines remain visible even when flat.
  ctx.fillStyle='#34e3b2';
  conf.forEach((v,i)=>{const vv=Math.max(0,Math.min(1,v)); const x=pad+W*i/Math.max(1,conf.length-1), y=pad+(1-vv)*H; ctx.beginPath(); ctx.arc(x,y,2.2,0,Math.PI*2); ctx.fill();});
  ctx.fillStyle='#ffcc66';
  ks.forEach((v,i)=>{const vv=Math.max(0,v); const x=pad+W*i/Math.max(1,ks.length-1), y=pad+(1-vv/maxK)*H; ctx.beginPath(); ctx.arc(x,y,2.2,0,Math.PI*2); ctx.fill();});
  ctx.fillStyle='#d6e4ff'; ctx.font='12px Manrope';
  ctx.fillText('HGDB adaptation: confidence and k_t',20,20);
  ctx.fillText('Teal = Conf_t, Yellow = k_t (normalized)',20,38);
  ctx.fillStyle='#9bb0d8';
  ctx.fillText('Y-axis: normalized value', 14, line.height/2);
  ctx.fillText('X-axis: request step', line.width/2 - 48, line.height - 8);

  const allFlat = conf.every(v => Math.abs(v - conf[0]) < 1e-9) && ks.every(v => Math.abs(v - ks[0]) < 1e-9);
  if (allFlat) {
    ctx.fillStyle = '#ffcc66';
    ctx.fillText('Note: Flat lines indicate little adaptation on this workload/config.', 20, line.height - 28);
  }
}

function build(){
  const cfgRaw=C.loadState(C.STORAGE_KEYS.cfg,null);
  const reqRaw=C.loadState(C.STORAGE_KEYS.workload,null);
  if(!cfgRaw||!reqRaw||!reqRaw.length){
    cards.innerHTML='<article class="card"><h3>No input found</h3><p>Go to Simulator page, provide inputs and run at least one step.</p></article>';
    return;
  }

  const cfg = {
    ...cfgRaw,
    C: Math.max(2, Number(cfgRaw.C)||8),
    P: Math.max(1, Number(cfgRaw.P)||2),
    N: Math.max(1, Number(cfgRaw.N)||30),
    kMin: Math.max(1, Number(cfgRaw.kMin)||1),
    kMax: Math.max(1, Number(cfgRaw.kMax)||4),
    rho: C.clamp(Number(cfgRaw.rho), 0, 0.99),
    theta: C.clamp(Number(cfgRaw.theta), 0, 1),
    rebalanceEvery: Math.max(1, Number(cfgRaw.rebalanceEvery)||6),
    weights: {
      a: Number(cfgRaw?.weights?.a)||0.25,
      b: Number(cfgRaw?.weights?.b)||0.20,
      g: Number(cfgRaw?.weights?.g)||0.35,
      d: Number(cfgRaw?.weights?.d)||0.25
    },
    seed: Number(cfgRaw.seed)||42
  };
  if(cfg.kMax<cfg.kMin) cfg.kMax=cfg.kMin;

  const req = reqRaw.map(r=>({
    id: Number(r.id),
    class: C.clamp(Number(r.class),0,cfg.P-1),
    priority: Math.max(1, Number(r.priority)||1),
    cost: Math.max(0.1, Number(r.cost)||1)
  })).filter(r=>Number.isFinite(r.id) && Number.isFinite(r.class));

  const activeReq = req.slice(0, cfg.N);
  C.saveState(C.STORAGE_KEYS.cfg, cfg);
  C.saveState(C.STORAGE_KEYS.workload, activeReq);
  const sim=new C.HGDBSimulator(cfg,activeReq);
  const hg=sim.runAll();
  const lru=C.runLRU(cfg,activeReq);
  const arc=C.runARC(cfg,activeReq);
  const rrip=C.runRRIP(cfg,activeReq);
  const comp={hg,lru,arc,rrip};
  cards.innerHTML=[hg,lru,arc,rrip].map(card).join('');
  const uniq = new Set(activeReq.map(r=>r.id)).size;
  cards.innerHTML += `<article class="card"><h3>Data Source</h3><p><b>Using current saved Simulator inputs</b></p><p>Requests used: ${activeReq.length}</p><p>Unique IDs: ${uniq}</p></article>`;
  drawBars(comp); drawLine(hg);
}

btn.addEventListener('click',build);
build();
