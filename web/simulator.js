const C = HGDBCore;
const $ = id => document.getElementById(id);

const els = {
  cfgC:$('cfgC'), cfgP:$('cfgP'), cfgN:$('cfgN'), cfgKmin:$('cfgKmin'), cfgKmax:$('cfgKmax'),
  cfgRho:$('cfgRho'), cfgTheta:$('cfgTheta'), cfgA:$('cfgA'), cfgB:$('cfgB'), cfgG:$('cfgG'), cfgD:$('cfgD'), cfgReb:$('cfgReb'),
  workload:$('workload'), genStable:$('genStable'), genScan:$('genScan'), genDrift:$('genDrift'),
  btnReset:$('btnReset'), btnStep:$('btnStep'), btnRun:$('btnRun'), btnExport:$('btnExport'),
  kHitRate:$('kHitRate'), kCost:$('kCost'), kConf:$('kConf'), kKt:$('kKt'),
  kEvict:$('kEvict'), kGhostHits:$('kGhostHits'), kIdx:$('kIdx'), kMiss:$('kMiss'),
  budgetChips:$('budgetChips'), stateView:$('stateView'),
  pipeline:$('pipeline'), log:$('log')
};
const openCompareLink = document.querySelector('a[href="comparison.html"]');

let sim = null;
let lastSignature = '';
let workloadManual = false;
let workloadMode = 'scan';

function readCfg(){
  const cfg={
    C:Math.max(2,Number(els.cfgC.value)), P:Math.max(1,Number(els.cfgP.value)), N:Math.max(1,Number(els.cfgN.value)),
    kMin:Math.max(1,Number(els.cfgKmin.value)), kMax:Math.max(1,Number(els.cfgKmax.value)),
    rho:C.clamp(Number(els.cfgRho.value),0,0.99), theta:C.clamp(Number(els.cfgTheta.value),0,1),
    weights:{a:Number(els.cfgA.value),b:Number(els.cfgB.value),g:Number(els.cfgG.value),d:Number(els.cfgD.value)},
    rebalanceEvery:Math.max(1,Number(els.cfgReb.value)), seed:42
  };
  if(cfg.kMax<cfg.kMin) cfg.kMax=cfg.kMin;
  return cfg;
}

function fillCfg(cfg){
  els.cfgC.value=cfg.C; els.cfgP.value=cfg.P; els.cfgN.value=cfg.N; els.cfgKmin.value=cfg.kMin; els.cfgKmax.value=cfg.kMax;
  els.cfgRho.value=cfg.rho; els.cfgTheta.value=cfg.theta; els.cfgA.value=cfg.weights.a; els.cfgB.value=cfg.weights.b; els.cfgG.value=cfg.weights.g; els.cfgD.value=cfg.weights.d; els.cfgReb.value=cfg.rebalanceEvery;
}

function setupTrace(mode='stable'){
  const cfg=readCfg();
  const req=C.generateTrace(mode,cfg.N,cfg.P,cfg.seed);
  els.workload.value=C.toWorkloadText(req);
  workloadManual = false;
  workloadMode = mode;
  C.saveState(C.STORAGE_KEYS.workloadMeta, { manual: false, mode: workloadMode });
}

function signatureOf(cfg, req){
  return JSON.stringify({
    cfg: { ...cfg, weights: { ...cfg.weights } },
    req: req.slice(0, cfg.N)
  });
}

function getCurrentInput(){
  const cfg = readCfg();
  let req = C.parseWorkload(els.workload.value, cfg.P);
  if(!req.length){
    req = C.generateTrace(workloadMode || 'scan', cfg.N, cfg.P, cfg.seed);
    els.workload.value = C.toWorkloadText(req);
    workloadManual = false;
    C.saveState(C.STORAGE_KEYS.workloadMeta, { manual: false, mode: workloadMode || 'scan' });
  }
  if(!workloadManual && req.length !== cfg.N){
    req = C.generateTrace(workloadMode || 'scan', cfg.N, cfg.P, cfg.seed);
    els.workload.value = C.toWorkloadText(req);
  }
  if(!workloadManual && req.length){
    const uniqRatio = (new Set(req.map(r=>r.id)).size) / req.length;
    if(uniqRatio > 0.90){
      // Auto-heal stale degenerate generated traces that produce all misses.
      req = C.generateTrace('stable', cfg.N, cfg.P, cfg.seed);
      workloadMode = 'stable';
      els.workload.value = C.toWorkloadText(req);
      C.saveState(C.STORAGE_KEYS.workloadMeta, { manual: false, mode: workloadMode });
    }

    // Ensure auto traces actually span all classes when P changes.
    const present = new Set(req.map(r=>r.class));
    if(cfg.P > 1 && present.size < cfg.P){
      const clsById = new Map();
      let rr = 0;
      req = req.map(r=>{
        if(!clsById.has(r.id)){ clsById.set(r.id, rr % cfg.P); rr++; }
        return { ...r, class: clsById.get(r.id) };
      });
      els.workload.value = C.toWorkloadText(req);
    }
  }
  req = req.slice(0, cfg.N);
  return { cfg, req };
}

function persistCurrentInput(){
  const { cfg, req } = getCurrentInput();
  C.saveState(C.STORAGE_KEYS.cfg, cfg);
  C.saveState(C.STORAGE_KEYS.workload, req);
  C.saveState(C.STORAGE_KEYS.workloadMeta, { manual: workloadManual, mode: workloadMode });
}

function resetSim(){
  const { cfg, req } = getCurrentInput();
  sim=new C.HGDBSimulator(cfg,req);
  lastSignature = signatureOf(cfg, req);
  C.saveState(C.STORAGE_KEYS.cfg,cfg);
  C.saveState(C.STORAGE_KEYS.workload,req);
  C.saveState(C.STORAGE_KEYS.run,null);
  render(); clearPipeline(); els.log.innerHTML='';
}

function ensureFreshSim(forRunAll=false){
  const { cfg, req } = getCurrentInput();
  const sig = signatureOf(cfg, req);
  const completed = sim && sim.idx >= sim.requests.length;
  if(!sim || sig !== lastSignature || (forRunAll && completed)){
    resetSim();
  } else {
    // keep storage synced even if not resetting
    C.saveState(C.STORAGE_KEYS.cfg, cfg);
    C.saveState(C.STORAGE_KEYS.workload, req);
  }
}

function clearPipeline(){ [...els.pipeline.querySelectorAll('.node')].forEach(n=>n.classList.remove('active')); }
function pulseStages(stages){
  clearPipeline();
  stages.forEach((s,i)=>setTimeout(()=>{
    const n=els.pipeline.querySelector(`.node[data-node="${s}"]`); if(n) n.classList.add('active');
  },i*110));
  setTimeout(()=>{ const d=els.pipeline.querySelector('.node[data-node="done"]'); if(d) d.classList.add('active'); }, stages.length*110+100);
}

function append(lines){ lines.forEach(l=>{ const d=document.createElement('div'); d.textContent=l; els.log.appendChild(d); }); els.log.scrollTop=els.log.scrollHeight; }

function render(){
  if(!sim) return;
  const s=sim.summary(); const total=s.hits+s.misses; const hr=total?100*s.hits/total:0;
  els.kHitRate.textContent=`${C.fmt(hr,1)}%`;
  els.kCost.textContent=C.fmt(s.weightedMissCost,1);
  els.kConf.textContent=C.fmt(s.conf,3);
  els.kKt.textContent=s.k;
  els.kEvict.textContent=s.evictions;
  const ghostHits = (s.classStats || []).reduce((a,x)=>a+(x.ghostHits||0),0);
  els.kGhostHits.textContent=ghostHits;
  els.kIdx.textContent=`${s.idx}/${sim.requests.length}`;
  els.kMiss.textContent=s.misses;
  els.budgetChips.innerHTML=s.budget.map((b,p)=>`<span class="chip">class ${p}: budget ${b}</span>`).join('');
  els.stateView.innerHTML=s.cache.map((arr,p)=>{
    const g = s.ghost[p].join(' ');
    const msg = g ? g : 'none yet (no eviction from this class so far)';
    return `<div class="stateBox"><b>Class ${p}</b><div class="stateMono">Cache(MRU→LRU): ${arr.join(' ')||'-'}</div><div class="stateMono">Ghost tags: ${msg}</div></div>`;
  }).join('');
}

function step(){ ensureFreshSim(false); const out=sim.step(); if(!out) return; pulseStages(out.stages); append(out.log); render(); }
function runAll(){
  ensureFreshSim(true);
  const summary=sim.runAll();
  append([`Completed ${summary.hits+summary.misses} requests.`]);
  render();
  persistRunBundle(summary);
}

function runBaselines(cfg, req){
  const lru=C.runLRU(cfg,req), arc=C.runARC(cfg,req), rrip=C.runRRIP(cfg,req);
  return {lru,arc,rrip};
}

function persistRunBundle(hgSummary){
  const { cfg, req } = getCurrentInput();
  const lru=C.runLRU(cfg,req), arc=C.runARC(cfg,req), rrip=C.runRRIP(cfg,req);
  C.saveState(C.STORAGE_KEYS.run, {
    generatedAt: new Date().toISOString(),
    cfg,
    requests: req,
    hgdb: hgSummary,
    comparison: { hg:hgSummary, lru, arc, rrip }
  });
}

function exportReport(){
  if(!sim) resetSim();
  const hg=sim.summary();
  const cfg=readCfg(); const req=C.parseWorkload(els.workload.value,cfg.P).slice(0,cfg.N);
  const base=runBaselines(cfg,req);
  const payload={generatedAt:new Date().toISOString(),config:cfg,workload:req,hgdb:hg,comparison:{hg,...base},complexity:{LRU:'O(1)',ARC:'O(1) amortized',RRIP:'O(1) amortized',HGDB:'Hit O(1), Eviction O(B_p*k_t), Rebalance O(P*C^2)'}};
  persistRunBundle(hg);
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`hgdb_demo_${Date.now()}.json`; a.click(); URL.revokeObjectURL(a.href);
}

function init(){
  const savedCfg=C.loadState(C.STORAGE_KEYS.cfg,null);
  const savedReq=C.loadState(C.STORAGE_KEYS.workload,null);
  const savedMeta=C.loadState(C.STORAGE_KEYS.workloadMeta,null);
  if(savedCfg) fillCfg(savedCfg);
  if(savedMeta){
    workloadManual = !!savedMeta.manual;
    workloadMode = savedMeta.mode || 'scan';
  }
  if(savedReq?.length){
    const uniqueRatio = (new Set(savedReq.map(r=>r.id)).size) / Math.max(1, savedReq.length);
    // Self-heal very old stale traces that were fully unique and caused flat/degenerate comparison.
    if(!savedMeta && uniqueRatio > 0.95 && savedReq.length >= 20){
      setupTrace('scan');
    } else {
      els.workload.value=C.toWorkloadText(savedReq);
    }
  } else setupTrace('scan');
  resetSim();

  els.genStable.addEventListener('click',()=>{setupTrace('stable'); resetSim();});
  els.genScan.addEventListener('click',()=>{setupTrace('scan'); resetSim();});
  els.genDrift.addEventListener('click',()=>{setupTrace('drift'); resetSim();});
  els.btnReset.addEventListener('click',resetSim);
  els.btnStep.addEventListener('click',step);
  els.btnRun.addEventListener('click',runAll);
  els.btnExport.addEventListener('click',exportReport);
  if(openCompareLink){
    openCompareLink.addEventListener('click',()=>{
      persistCurrentInput();
      if(sim && sim.idx>0) persistRunBundle(sim.summary());
    });
  }
  [els.cfgC,els.cfgP,els.cfgN,els.cfgKmin,els.cfgKmax,els.cfgRho,els.cfgTheta,els.cfgA,els.cfgB,els.cfgG,els.cfgD,els.cfgReb].forEach(i=>{
    i.addEventListener('change',()=>{
      if(!workloadManual && (i===els.cfgP || i===els.cfgN)){
        setupTrace(workloadMode || 'scan');
      }
      resetSim();
    });
    i.addEventListener('input',()=>{
      persistCurrentInput();
    });
  });
  els.workload.addEventListener('input',()=>{
    workloadManual = true;
    persistCurrentInput();
  });
}

init();
