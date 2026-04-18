(function(global){
  const STORAGE_KEYS = {
    cfg: 'hgdb_cfg',
    workload: 'hgdb_workload',
    workloadMeta: 'hgdb_workload_meta',
    run: 'hgdb_run'
  };

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const fmt = (n, d=2) => Number(n).toFixed(d);

  function lcg(seed=42){
    let x = seed >>> 0;
    return ()=>{ x=(1664525*x+1013904223)>>>0; return x/2**32; };
  }

  function generateTrace(mode, N, P, seed=42){
    const r = lcg(seed), req=[];
    const classById = new Map();
    const classFor = (id, preferred=null) => {
      if(classById.has(id)) return classById.get(id);
      const cls = preferred==null ? Math.floor(r()*P) : clamp(preferred,0,P-1);
      classById.set(id, cls);
      return cls;
    };
    if(mode==='stable'){
      const hot=[101,102,103,104,105];
      for(let i=0;i<N;i++){
        const id = r()<0.86 ? hot[Math.floor(r()*hot.length)] : 200+Math.floor(r()*50);
        const cls = classFor(id, i<P ? i : null);
        req.push({id,class:cls,priority:1+Math.floor(r()*4),cost:2+Math.floor(r()*10)});
      }
    }else if(mode==='scan'){
      const smallHot=[110,111,112,113,114,115];
      for(let i=0;i<N;i++){
        const scanPhase = i < N*0.40;
        const id = scanPhase
          ? 300+i
          : (r()<0.88 ? smallHot[Math.floor(r()*smallHot.length)] : 350+Math.floor(r()*20));
        const cls = classFor(id, i<P ? i : null);
        req.push({id,class:cls,priority:(i%3)+1,cost:i%2?8:3});
      }
    }else{
      for(let i=0;i<N;i++){
        const drift=i>N*0.45;
        const id=(drift?500:120)+Math.floor(r()*(drift?12:8));
        const cls = classFor(id, i<P ? i : null);
        req.push({id,class:cls,priority:drift?3+Math.floor(r()*2):1+Math.floor(r()*3),cost:drift?8+Math.floor(r()*8):2+Math.floor(r()*6)});
      }
    }
    return req;
  }

  function parseWorkload(text,P){
    return text.split('\n').map(s=>s.trim()).filter(Boolean).map(line=>{
      const [id,c,p,cost]=line.split(',').map(x=>Number(x.trim()));
      if([id,c,p,cost].some(Number.isNaN)) return null;
      return {id, class:clamp(c,0,P-1), priority:Math.max(1,p), cost:Math.max(0.1,cost)};
    }).filter(Boolean);
  }

  function toWorkloadText(req){ return req.map(r=>`${r.id},${r.class},${r.priority},${r.cost}`).join('\n'); }

  class HGDBSimulator {
    constructor(cfg, requests){
      this.cfg=cfg; this.requests=requests; this.idx=0;
      this.conf=1.0; this.prevReq=null;
      this.budget=Array(cfg.P).fill(Math.floor(cfg.C/cfg.P));
      for(let i=0;i<cfg.C%cfg.P;i++) this.budget[i]++;
      this.cache=Array.from({length:cfg.P},()=>[]);
      this.ghost=Array.from({length:cfg.P},()=>[]);
      this.ghostSet=Array.from({length:cfg.P},()=>new Set());
      this.ghostCap=Math.max(3,Math.floor(cfg.C/cfg.P)+2);
      this.obj=new Map(); this.trans=new Map();
      this.maxCost=1; this.maxPriority=1;
      this.metrics={hits:0,misses:0,weightedMissCost:0,evictions:0,decisionOps:0,
        classStats:Array.from({length:cfg.P},()=>({hits:0,misses:0,ghostHits:0,missCost:0})),
        confidenceSeries:[],kSeries:[],budgetSeries:[],timeline:[]};
    }
    transitionUpdate(from,to){ if(from==null) return; if(!this.trans.has(from)) this.trans.set(from,new Map()); const m=this.trans.get(from); m.set(to,(m.get(to)||0)+1); }
    bestNext(from){ const m=this.trans.get(from); if(!m||!m.size) return null; let b=null,c=-1; for(const [id,v] of m){ if(v>c){c=v;b=id;} } return b; }
    updateConfidence(curr){ if(this.prevReq==null) return; const pred=this.bestNext(this.prevReq); if(pred==null) return; const a=pred===curr?1:0; this.conf=this.cfg.rho*this.conf+(1-this.cfg.rho)*a; }
    currentK(){ return Math.max(this.cfg.kMin, Math.floor(this.cfg.kMax*this.conf)); }
    ensureObj(req,t){
      if(!this.obj.has(req.id)) this.obj.set(req.id,{id:req.id,class:clamp(req.class,0,this.cfg.P-1),priority:req.priority,cost:req.cost,freq:0,lastTime:-1,inCache:false});
      const o=this.obj.get(req.id);
      // Keep class sticky per object-id; class migration across requests corrupts partition semantics.
      o.priority=req.priority; o.cost=req.cost; o.freq++; o.lastTime=t;
      this.maxCost=Math.max(this.maxCost,o.cost); this.maxPriority=Math.max(this.maxPriority,o.priority); return o;
    }
    prs(o,t){
      const age=o.lastTime<0?t:t-o.lastTime, rec=1/(1+Math.max(0,age)), f=Math.min(1,o.freq/10), c=o.cost/this.maxCost, p=o.priority/this.maxPriority;
      const {a,b,g,d}=this.cfg.weights; const den=(a+b+g+d)||1; return (a*rec+b*f+g*c+d*p)/den;
    }
    predSeq(id,k){const out=[]; let cur=id; for(let i=0;i<k;i++){ const n=this.bestNext(cur); if(n==null) break; out.push(n); cur=n; } return out; }
    touch(cls,id){ const arr=this.cache[cls]; const ix=arr.indexOf(id); if(ix>=0) arr.splice(ix,1); arr.unshift(id); }
    ghostInsert(cls,id){ if(this.ghostSet[cls].has(id)) return; this.ghostSet[cls].add(id); this.ghost[cls].push(id); if(this.ghost[cls].length>this.ghostCap){ const x=this.ghost[cls].shift(); this.ghostSet[cls].delete(x);} }
    chooseVictim(cls, reqId, t){
      const k=this.currentK(), pred=this.predSeq(reqId,k), lambda=1-this.conf;
      let victim=null,best=Infinity;
      for(const id of this.cache[cls]){
        const o=this.obj.get(id);
        let L=0; pred.forEach((pid,h)=>{ if(pid===id) L+=Math.pow(0.9,h)*o.cost; });
        const age=Math.max(0,t-o.lastTime), rec=1/(1+age), f=Math.min(1,o.freq/10), p=o.priority/this.maxPriority, c=o.cost/this.maxCost;
        const greedy=0.35*rec+0.25*f+0.2*p+0.2*c;
        const score=(1-lambda)*L+lambda*greedy;
        if(score<best){best=score; victim=id;}
      }
      this.metrics.decisionOps += Math.max(1, this.cache[cls].length*Math.max(1,k));
      return victim;
    }
    rebalance(){
      const {P,C}=this.cfg;
      const U=Array.from({length:P},()=>Array(C+1).fill(0));
      for(let p=0;p<P;p++){
        const st=this.metrics.classStats[p], avg=st.misses?st.missCost/st.misses:1, pressure=st.misses+1.5*st.ghostHits+1, base=avg*pressure;
        for(let x=0;x<=C;x++) U[p][x]=base*(1-Math.exp(-x/3));
      }
      const F=Array.from({length:P+1},()=>Array(C+1).fill(-1e15));
      const take=Array.from({length:P+1},()=>Array(C+1).fill(0)); F[0][0]=0;
      for(let p=1;p<=P;p++) for(let c=0;c<=C;c++) for(let x=0;x<=c;x++){
        const v=F[p-1][c-x]+U[p-1][x]; if(v>F[p][c]){F[p][c]=v; take[p][c]=x;}
      }
      const nb=Array(P).fill(0); let rem=C;
      for(let p=P;p>=1;p--){ nb[p-1]=take[p][rem]; rem-=take[p][rem]; }
      if(C>=P){
        for(let p=0;p<P;p++) if(nb[p]===0) nb[p]=1;
        let sum=nb.reduce((a,b)=>a+b,0);
        while(sum>C){ let mx=0; for(let p=1;p<P;p++) if(nb[p]>nb[mx]) mx=p; if(nb[mx]>1){nb[mx]--;sum--;} else break; }
        while(sum<C){ let mn=0; for(let p=1;p<P;p++) if(nb[p]<nb[mn]) mn=p; nb[mn]++; sum++; }
      }
      this.budget=nb;
      for(let p=0;p<P;p++) while(this.cache[p].length>this.budget[p]){
        const ev=this.cache[p].pop(); this.obj.get(ev).inCache=false; this.ghostInsert(p,ev); this.metrics.evictions++;
      }
      this.metrics.decisionOps += P*C*C;
    }
    step(){
      if(this.idx>=this.requests.length) return null;
      const req=this.requests[this.idx], t=this.idx+1, log=[], stages=[];
      stages.push('lookup');
      this.updateConfidence(req.id); this.transitionUpdate(this.prevReq,req.id);
      const o=this.ensureObj(req,t), cls=o.class;
      if(this.ghostSet[cls].has(req.id)) this.metrics.classStats[cls].ghostHits++;
      if(o.inCache && this.cache[cls].includes(req.id)){
        this.metrics.hits++; this.metrics.classStats[cls].hits++; this.touch(cls,req.id); log.push(`HIT id=${req.id}`);
      } else {
        this.metrics.misses++; this.metrics.classStats[cls].misses++; this.metrics.classStats[cls].missCost+=o.cost; this.metrics.weightedMissCost+=o.cost;
        log.push(`MISS id=${req.id} cost=${o.cost}`);
        stages.push('prs'); const s=this.prs(o,t); log.push(`PRS=${fmt(s,3)} vs theta=${this.cfg.theta}`);
        if(s<this.cfg.theta){ log.push('BYPASS admission'); }
        else {
          stages.push('conf'); const k=this.currentK(); log.push(`ADMIT | Conf=${fmt(this.conf,3)} k=${k}`);
          if(this.cache[cls].length>=this.budget[cls]){
            stages.push('evict'); const v=this.chooseVictim(cls,req.id,t);
            if(v!=null){ this.cache[cls]=this.cache[cls].filter(x=>x!==v); this.obj.get(v).inCache=false; this.ghostInsert(cls,v); this.metrics.evictions++; stages.push('ghost'); log.push(`Evict id=${v}`); }
          }
          if(this.cache[cls].length<this.budget[cls]){ this.touch(cls,req.id); o.inCache=true; log.push('Inserted'); }
        }
      }
      if(t%this.cfg.rebalanceEvery===0){ stages.push('rebalance'); this.rebalance(); log.push('Knapsack rebalance'); }
      this.metrics.confidenceSeries.push(this.conf); this.metrics.kSeries.push(this.currentK()); this.metrics.budgetSeries.push([...this.budget]);
      this.metrics.timeline.push({t,req,log:[...log],stages:[...stages],conf:this.conf,k:this.currentK(),budget:[...this.budget]});
      this.prevReq=req.id; this.idx++; this.metrics.decisionOps++;
      return {t,req,log,stages};
    }
    runAll(){ while(this.idx<this.requests.length) this.step(); return this.summary(); }
    summary(){ const total=this.metrics.hits+this.metrics.misses; return {name:'HGDB-LRUPS', hits:this.metrics.hits, misses:this.metrics.misses, weightedMissCost:this.metrics.weightedMissCost, hitRate: total?this.metrics.hits/total:0, evictions:this.metrics.evictions, decisionOps:this.metrics.decisionOps, ...this.metrics, idx:this.idx, cache:this.cache, ghost:this.ghost, budget:this.budget, conf:this.conf, k:this.currentK()}; }
  }

  function runLRU(cfg, reqs, upto=reqs.length){
    const cache=[], st={name:'LRU',hits:0,misses:0,weightedMissCost:0,evictions:0,decisionOps:0,events:[]};
    for(let i=0;i<upto;i++){
      const r=reqs[i], ix=cache.indexOf(r.id);
      if(ix>=0){st.hits++; cache.splice(ix,1); cache.unshift(r.id); st.events.push({t:i+1,outcome:'HIT'});} else {st.misses++; st.weightedMissCost+=r.cost; if(cache.length>=cfg.C){cache.pop(); st.evictions++;} cache.unshift(r.id); st.events.push({t:i+1,outcome:'MISS'});} st.decisionOps++;
    }
    const total=st.hits+st.misses; st.hitRate=total?st.hits/total:0; return st;
  }

  function runRRIP(cfg, reqs, upto=reqs.length){
    const maxR=3, map=new Map(), st={name:'RRIP',hits:0,misses:0,weightedMissCost:0,evictions:0,decisionOps:0,events:[]};
    for(let i=0;i<upto;i++){
      const r=reqs[i];
      if(map.has(r.id)){st.hits++; map.set(r.id,0); st.events.push({t:i+1,outcome:'HIT'});} else {
        st.misses++; st.weightedMissCost+=r.cost;
        if(map.size>=cfg.C){
          while(true){
            let ev=false;
            for(const [id,rr] of map){ if(rr>=maxR){ map.delete(id); st.evictions++; ev=true; break; }}
            if(ev) break;
            for(const [id,rr] of map) map.set(id,rr+1);
            st.decisionOps += map.size;
          }
        }
        map.set(r.id,2); st.events.push({t:i+1,outcome:'MISS'});
      }
      st.decisionOps++;
    }
    const total=st.hits+st.misses; st.hitRate=total?st.hits/total:0; return st;
  }

  function runARC(cfg, reqs, upto=reqs.length){
    const T1=[],T2=[],B1=[],B2=[]; let p=0;
    const st={name:'ARC',hits:0,misses:0,weightedMissCost:0,evictions:0,decisionOps:0,events:[]};
    const replace=(x)=>{
      if(T1.length>0&&(T1.length>p||(B2.includes(x)&&T1.length===p))){ const old=T1.pop(); B1.unshift(old); if(B1.length>cfg.C)B1.pop(); st.evictions++; }
      else if(T2.length>0){ const old=T2.pop(); B2.unshift(old); if(B2.length>cfg.C)B2.pop(); st.evictions++; }
    };
    for(let i=0;i<upto;i++){
      const x=reqs[i].id;
      if(T1.includes(x)||T2.includes(x)){
        st.hits++; if(T1.includes(x)) T1.splice(T1.indexOf(x),1); else T2.splice(T2.indexOf(x),1); T2.unshift(x); st.events.push({t:i+1,outcome:'HIT'});
      } else {
        st.misses++; st.weightedMissCost += reqs[i].cost;
        if(B1.includes(x)){ p=Math.min(cfg.C,p+Math.max(1,Math.floor(B2.length/Math.max(1,B1.length)))); replace(x); B1.splice(B1.indexOf(x),1); T2.unshift(x); }
        else if(B2.includes(x)){ p=Math.max(0,p-Math.max(1,Math.floor(B1.length/Math.max(1,B2.length)))); replace(x); B2.splice(B2.indexOf(x),1); T2.unshift(x); }
        else {
          if(T1.length+B1.length===cfg.C){ if(T1.length<cfg.C){ B1.pop(); replace(x);} else if(T1.length>0){T1.pop(); st.evictions++;} }
          else if(T1.length+B1.length<cfg.C && T1.length+T2.length+B1.length+B2.length>=cfg.C){ if(T1.length+T2.length+B1.length+B2.length>=2*cfg.C&&B2.length>0)B2.pop(); replace(x); }
          T1.unshift(x);
        }
        st.events.push({t:i+1,outcome:'MISS'});
      }
      st.decisionOps += 2;
    }
    const total=st.hits+st.misses; st.hitRate=total?st.hits/total:0; return st;
  }

  function saveState(key,obj){ localStorage.setItem(key, JSON.stringify(obj)); }
  function loadState(key, fallback=null){ try{ const x=localStorage.getItem(key); return x?JSON.parse(x):fallback; }catch{return fallback;} }

  global.HGDBCore = {
    STORAGE_KEYS, clamp, fmt, generateTrace, parseWorkload, toWorkloadText,
    HGDBSimulator, runLRU, runARC, runRRIP,
    saveState, loadState
  };
})(window);
