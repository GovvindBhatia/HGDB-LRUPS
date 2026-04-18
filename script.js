const els = {
  runCta: document.getElementById('runCta'),
  heroRun: document.getElementById('heroRun'),
  heroStep: document.getElementById('heroStep'),
  btnRun: document.getElementById('btnRun'),
  btnStep: document.getElementById('btnStep'),
  btnReset: document.getElementById('btnReset'),
  btnCompare: document.getElementById('btnCompare'),
  btnExport: document.getElementById('btnExport'),
  genStable: document.getElementById('genStable'),
  genScan: document.getElementById('genScan'),
  genDrift: document.getElementById('genDrift'),
  workload: document.getElementById('workload'),

  cfgC: document.getElementById('cfgC'),
  cfgP: document.getElementById('cfgP'),
  cfgN: document.getElementById('cfgN'),
  cfgKmin: document.getElementById('cfgKmin'),
  cfgKmax: document.getElementById('cfgKmax'),
  cfgRho: document.getElementById('cfgRho'),
  cfgTheta: document.getElementById('cfgTheta'),
  cfgA: document.getElementById('cfgA'),
  cfgB: document.getElementById('cfgB'),
  cfgG: document.getElementById('cfgG'),
  cfgD: document.getElementById('cfgD'),
  cfgReb: document.getElementById('cfgReb'),

  stepLog: document.getElementById('stepLog'),
  pipeline: document.getElementById('pipeline'),

  sIdx: document.getElementById('sIdx'),
  sHits: document.getElementById('sHits'),
  sMisses: document.getElementById('sMisses'),
  sCost: document.getElementById('sCost'),
  sConf: document.getElementById('sConf'),
  sK: document.getElementById('sK'),
  budgetView: document.getElementById('budgetView'),
  cacheView: document.getElementById('cacheView'),
  whatifResult: document.getElementById('whatifResult'),
  whatLru: document.getElementById('whatLru'),
  whatArc: document.getElementById('whatArc'),
  whatRrip: document.getElementById('whatRrip'),

  mHitRate: document.getElementById('mHitRate'),
  mMissCost: document.getElementById('mMissCost'),
  mConf: document.getElementById('mConf'),
  mK: document.getElementById('mK'),

  compCards: document.getElementById('compCards'),
  barChart: document.getElementById('barChart'),
  lineChart: document.getElementById('lineChart'),
};

const state = {
  cfg: null,
  requests: [],
  hgdb: null,
  comparison: null,
  lastRunTs: null,
};

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function fmt(n, d = 2) { return Number(n).toFixed(d); }

function readConfig() {
  const cfg = {
    C: Math.max(2, Number(els.cfgC.value)),
    P: Math.max(1, Number(els.cfgP.value)),
    N: Math.max(1, Number(els.cfgN.value)),
    kMin: Math.max(1, Number(els.cfgKmin.value)),
    kMax: Math.max(1, Number(els.cfgKmax.value)),
    rho: clamp(Number(els.cfgRho.value), 0, 0.99),
    theta: clamp(Number(els.cfgTheta.value), 0, 1),
    weights: {
      a: Number(els.cfgA.value),
      b: Number(els.cfgB.value),
      g: Number(els.cfgG.value),
      d: Number(els.cfgD.value)
    },
    rebalanceEvery: Math.max(1, Number(els.cfgReb.value)),
    seed: 42,
  };
  if (cfg.kMax < cfg.kMin) cfg.kMax = cfg.kMin;
  return cfg;
}

function parseWorkload(text, P) {
  const rows = text.split('\n').map(s => s.trim()).filter(Boolean);
  const reqs = [];
  for (const row of rows) {
    const parts = row.split(',').map(x => x.trim());
    if (parts.length !== 4) continue;
    const id = Number(parts[0]);
    const cls = clamp(Number(parts[1]), 0, P - 1);
    const priority = Math.max(1, Number(parts[2]));
    const cost = Math.max(0.1, Number(parts[3]));
    if ([id, cls, priority, cost].some(Number.isNaN)) continue;
    reqs.push({ id, class: cls, priority, cost });
  }
  return reqs;
}

function lcg(seed = 42) {
  let x = seed >>> 0;
  return () => {
    x = (1664525 * x + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

function generateTrace(mode, N, P, seed = 42) {
  const rnd = lcg(seed);
  const reqs = [];
  if (mode === 'stable') {
    const hot = [101, 102, 103, 104, 105];
    for (let i = 0; i < N; i++) {
      const useHot = rnd() < 0.8;
      const id = useHot ? hot[Math.floor(rnd() * hot.length)] : 200 + Math.floor(rnd() * 40);
      const cls = Math.floor(rnd() * P);
      const priority = 1 + Math.floor(rnd() * 4);
      const cost = 2 + Math.floor(rnd() * 10);
      reqs.push({ id, class: cls, priority, cost });
    }
  } else if (mode === 'scan') {
    for (let i = 0; i < N; i++) {
      const id = (i < N * 0.55) ? (300 + i) : (110 + (i % 9));
      const cls = i % P;
      const priority = (i % 3) + 1;
      const cost = (i % 2 === 0) ? 3 : 8;
      reqs.push({ id, class: cls, priority, cost });
    }
  } else {
    for (let i = 0; i < N; i++) {
      const drift = i > N * 0.45;
      const base = drift ? 500 : 120;
      const span = drift ? 12 : 8;
      const id = base + Math.floor(rnd() * span);
      const cls = drift ? ((Math.floor(rnd() * P) + 1) % P) : Math.floor(rnd() * P);
      const priority = drift ? 3 + Math.floor(rnd() * 2) : 1 + Math.floor(rnd() * 3);
      const cost = drift ? 8 + Math.floor(rnd() * 8) : 2 + Math.floor(rnd() * 6);
      reqs.push({ id, class: cls, priority, cost });
    }
  }
  return reqs;
}

function toWorkloadText(reqs) {
  return reqs.map(r => `${r.id},${r.class},${r.priority},${r.cost}`).join('\n');
}

class HGDBSimulator {
  constructor(cfg, requests) {
    this.cfg = cfg;
    this.requests = requests;
    this.idx = 0;

    this.conf = 1.0;
    this.prevReq = null;

    this.budget = Array(cfg.P).fill(Math.floor(cfg.C / cfg.P));
    for (let i = 0; i < cfg.C % cfg.P; i++) this.budget[i]++;

    this.cache = Array.from({ length: cfg.P }, () => []); // MRU first
    this.ghost = Array.from({ length: cfg.P }, () => []);
    this.ghostSet = Array.from({ length: cfg.P }, () => new Set());
    this.ghostCap = Math.max(3, Math.floor(cfg.C / cfg.P) + 2);

    this.obj = new Map();
    this.trans = new Map();

    this.metrics = {
      hits: 0,
      misses: 0,
      weightedMissCost: 0,
      evictions: 0,
      decisionOps: 0,
      classStats: Array.from({ length: cfg.P }, () => ({ hits: 0, misses: 0, ghostHits: 0, missCost: 0 })),
      confidenceSeries: [],
      kSeries: [],
      budgetSeries: [],
      timeline: [],
    };

    this.maxCost = 1;
    this.maxPriority = 1;
  }

  transitionUpdate(from, to) {
    if (from == null) return;
    if (!this.trans.has(from)) this.trans.set(from, new Map());
    const m = this.trans.get(from);
    m.set(to, (m.get(to) || 0) + 1);
  }

  bestNext(from) {
    const m = this.trans.get(from);
    if (!m || m.size === 0) return null;
    let best = null, bestCnt = -1;
    for (const [id, cnt] of m.entries()) {
      if (cnt > bestCnt) { bestCnt = cnt; best = id; }
    }
    return best;
  }

  updateConfidence(curr) {
    if (this.prevReq == null) return;
    const pred = this.bestNext(this.prevReq);
    if (pred == null) return;
    const acc = pred === curr ? 1 : 0;
    this.conf = this.cfg.rho * this.conf + (1 - this.cfg.rho) * acc;
  }

  currentK() {
    return Math.max(this.cfg.kMin, Math.floor(this.cfg.kMax * this.conf));
  }

  ensureObj(req, t) {
    if (!this.obj.has(req.id)) {
      this.obj.set(req.id, {
        id: req.id,
        class: req.class,
        priority: req.priority,
        cost: req.cost,
        freq: 0,
        lastTime: -1,
        inCache: false,
      });
    }
    const o = this.obj.get(req.id);
    o.class = req.class;
    o.priority = req.priority;
    o.cost = req.cost;
    o.freq += 1;
    o.lastTime = t;
    this.maxCost = Math.max(this.maxCost, o.cost);
    this.maxPriority = Math.max(this.maxPriority, o.priority);
    return o;
  }

  prs(o, t) {
    const age = o.lastTime < 0 ? t : t - o.lastTime;
    const recency = 1 / (1 + Math.max(0, age));
    const f = Math.min(1, o.freq / 10);
    const c = o.cost / this.maxCost;
    const p = o.priority / this.maxPriority;
    const { a, b, g, d } = this.cfg.weights;
    const denom = (a + b + g + d) || 1;
    return (a * recency + b * f + g * c + d * p) / denom;
  }

  generatePred(reqId, k) {
    const pred = [];
    let cur = reqId;
    for (let i = 0; i < k; i++) {
      const nxt = this.bestNext(cur);
      if (nxt == null) break;
      pred.push(nxt);
      cur = nxt;
    }
    return pred;
  }

  ghostInsert(cls, id) {
    if (this.ghostSet[cls].has(id)) return;
    this.ghostSet[cls].add(id);
    this.ghost[cls].push(id);
    if (this.ghost[cls].length > this.ghostCap) {
      const x = this.ghost[cls].shift();
      this.ghostSet[cls].delete(x);
    }
  }

  touchInClass(cls, id) {
    const arr = this.cache[cls];
    const ix = arr.indexOf(id);
    if (ix >= 0) arr.splice(ix, 1);
    arr.unshift(id);
  }

  evictVictim(cls, reqId, t) {
    const k = this.currentK();
    const pred = this.generatePred(reqId, k);
    const lambda = 1 - this.conf;

    let victim = null;
    let best = Infinity;
    const candidates = this.cache[cls];

    for (const id of candidates) {
      const o = this.obj.get(id);
      let predKeep = 0;
      pred.forEach((pid, h) => {
        if (pid === id) predKeep += Math.pow(0.9, h) * o.cost;
      });
      const age = Math.max(0, t - o.lastTime);
      const rec = 1 / (1 + age);
      const f = Math.min(1, o.freq / 10);
      const p = o.priority / this.maxPriority;
      const c = o.cost / this.maxCost;
      const greedy = 0.35 * rec + 0.25 * f + 0.2 * p + 0.2 * c;

      const score = (1 - lambda) * predKeep + lambda * greedy;
      if (score < best) { best = score; victim = id; }
    }

    this.metrics.decisionOps += Math.max(1, candidates.length * Math.max(1, k));
    return victim;
  }

  rebalance() {
    const { P, C } = this.cfg;
    const U = Array.from({ length: P }, () => Array(C + 1).fill(0));

    for (let p = 0; p < P; p++) {
      const st = this.metrics.classStats[p];
      const avgCost = st.misses > 0 ? st.missCost / st.misses : 1;
      const pressure = st.misses + 1.5 * st.ghostHits + 1;
      const base = avgCost * pressure;
      for (let x = 0; x <= C; x++) U[p][x] = base * (1 - Math.exp(-x / 3));
    }

    const F = Array.from({ length: P + 1 }, () => Array(C + 1).fill(-1e15));
    const take = Array.from({ length: P + 1 }, () => Array(C + 1).fill(0));
    F[0][0] = 0;

    for (let p = 1; p <= P; p++) {
      for (let c = 0; c <= C; c++) {
        for (let x = 0; x <= c; x++) {
          const val = F[p - 1][c - x] + U[p - 1][x];
          if (val > F[p][c]) {
            F[p][c] = val;
            take[p][c] = x;
          }
        }
      }
    }

    const nb = Array(P).fill(0);
    let rem = C;
    for (let p = P; p >= 1; p--) {
      nb[p - 1] = take[p][rem];
      rem -= take[p][rem];
    }

    if (C >= P) {
      for (let p = 0; p < P; p++) if (nb[p] === 0) nb[p] = 1;
      let sum = nb.reduce((a, b) => a + b, 0);
      while (sum > C) {
        let mx = 0;
        for (let p = 1; p < P; p++) if (nb[p] > nb[mx]) mx = p;
        if (nb[mx] > 1) { nb[mx]--; sum--; } else break;
      }
      while (sum < C) {
        let mn = 0;
        for (let p = 1; p < P; p++) if (nb[p] < nb[mn]) mn = p;
        nb[mn]++; sum++;
      }
    }

    this.budget = nb;
    for (let p = 0; p < P; p++) {
      while (this.cache[p].length > this.budget[p]) {
        const ev = this.cache[p].pop();
        this.obj.get(ev).inCache = false;
        this.ghostInsert(p, ev);
        this.metrics.evictions++;
      }
    }

    this.metrics.decisionOps += P * C * C;
  }

  step() {
    if (this.idx >= this.requests.length) return null;

    const req = this.requests[this.idx];
    const t = this.idx + 1;
    const log = [];
    const stages = [];

    stages.push('lookup');
    this.updateConfidence(req.id);
    this.transitionUpdate(this.prevReq, req.id);

    const o = this.ensureObj(req, t);
    const cls = o.class;

    if (this.ghostSet[cls].has(req.id)) this.metrics.classStats[cls].ghostHits++;

    if (o.inCache && this.cache[cls].includes(req.id)) {
      this.metrics.hits++;
      this.metrics.classStats[cls].hits++;
      this.touchInClass(cls, req.id);
      log.push(`HIT on id=${req.id} (class ${cls})`);
    } else {
      this.metrics.misses++;
      this.metrics.classStats[cls].misses++;
      this.metrics.classStats[cls].missCost += o.cost;
      this.metrics.weightedMissCost += o.cost;
      log.push(`MISS on id=${req.id} (cost=${o.cost})`);

      stages.push('prs');
      const score = this.prs(o, t);
      log.push(`PRS=${fmt(score,3)} vs theta=${this.cfg.theta}`);

      if (score < this.cfg.theta) {
        log.push('Bypass admission (not inserted)');
      } else {
        stages.push('conf');
        const k = this.currentK();
        log.push(`Admit enabled | Conf=${fmt(this.conf,3)} => k=${k}`);

        if (this.cache[cls].length >= this.budget[cls]) {
          stages.push('evict');
          const victim = this.evictVictim(cls, req.id, t);
          if (victim != null) {
            this.cache[cls] = this.cache[cls].filter(x => x !== victim);
            this.obj.get(victim).inCache = false;
            this.ghostInsert(cls, victim);
            this.metrics.evictions++;
            stages.push('ghost');
            log.push(`Evicted id=${victim} from class ${cls}`);
          }
        }

        if (this.cache[cls].length < this.budget[cls]) {
          this.touchInClass(cls, req.id);
          o.inCache = true;
          log.push('Inserted into class cache');
        } else {
          log.push('Class still full -> insert skipped');
        }
      }
    }

    if (t % this.cfg.rebalanceEvery === 0) {
      stages.push('rebalance');
      this.rebalance();
      log.push('Periodic knapsack-DP rebalance applied');
    }

    this.metrics.confidenceSeries.push(this.conf);
    this.metrics.kSeries.push(this.currentK());
    this.metrics.budgetSeries.push([...this.budget]);
    this.metrics.timeline.push({ t, req, log: [...log], stages: [...stages] });

    this.prevReq = req.id;
    this.idx++;
    this.metrics.decisionOps += 1;

    return { t, req, log, stages };
  }

  runAll() {
    while (this.idx < this.requests.length) this.step();
    return this.summary();
  }

  summary() {
    const total = this.metrics.hits + this.metrics.misses;
    return {
      name: 'HGDB-LRUPS',
      hits: this.metrics.hits,
      misses: this.metrics.misses,
      weightedMissCost: this.metrics.weightedMissCost,
      hitRate: total ? this.metrics.hits / total : 0,
      evictions: this.metrics.evictions,
      decisionOps: this.metrics.decisionOps,
      confidenceSeries: this.metrics.confidenceSeries,
      kSeries: this.metrics.kSeries,
      budgetSeries: this.metrics.budgetSeries,
      classStats: this.metrics.classStats,
      timeline: this.metrics.timeline,
    };
  }
}

function runLRU(cfg, requests, upto = requests.length) {
  const cache = [];
  const stats = { name: 'LRU', hits: 0, misses: 0, weightedMissCost: 0, evictions: 0, decisionOps: 0, events: [] };

  for (let i = 0; i < upto; i++) {
    const r = requests[i];
    const ix = cache.indexOf(r.id);
    if (ix >= 0) {
      stats.hits++;
      cache.splice(ix, 1);
      cache.unshift(r.id);
      stats.events.push({ t: i + 1, outcome: 'HIT' });
    } else {
      stats.misses++;
      stats.weightedMissCost += r.cost;
      if (cache.length >= cfg.C) {
        cache.pop();
        stats.evictions++;
      }
      cache.unshift(r.id);
      stats.events.push({ t: i + 1, outcome: 'MISS' });
    }
    stats.decisionOps += 1;
  }
  const total = stats.hits + stats.misses;
  stats.hitRate = total ? stats.hits / total : 0;
  return stats;
}

function runRRIP(cfg, requests, upto = requests.length) {
  const maxR = 3;
  const state = new Map();
  const stats = { name: 'RRIP', hits: 0, misses: 0, weightedMissCost: 0, evictions: 0, decisionOps: 0, events: [] };

  for (let i = 0; i < upto; i++) {
    const r = requests[i];
    if (state.has(r.id)) {
      stats.hits++;
      state.set(r.id, 0);
      stats.events.push({ t: i + 1, outcome: 'HIT' });
    } else {
      stats.misses++;
      stats.weightedMissCost += r.cost;
      if (state.size >= cfg.C) {
        while (true) {
          let evicted = false;
          for (const [id, rr] of state.entries()) {
            if (rr >= maxR) {
              state.delete(id);
              stats.evictions++;
              evicted = true;
              break;
            }
          }
          if (evicted) break;
          for (const [id, rr] of state.entries()) state.set(id, rr + 1);
          stats.decisionOps += state.size;
        }
      }
      state.set(r.id, 2);
      stats.events.push({ t: i + 1, outcome: 'MISS' });
    }
    stats.decisionOps += 1;
  }
  const total = stats.hits + stats.misses;
  stats.hitRate = total ? stats.hits / total : 0;
  return stats;
}

function runARC(cfg, requests, upto = requests.length) {
  const T1 = [], T2 = [], B1 = [], B2 = [];
  let p = 0;
  const stats = { name: 'ARC', hits: 0, misses: 0, weightedMissCost: 0, evictions: 0, decisionOps: 0, events: [] };

  const moveToFront = (arr, id) => {
    const ix = arr.indexOf(id);
    if (ix >= 0) arr.splice(ix, 1);
    arr.unshift(id);
  };

  const replace = (x) => {
    if (T1.length > 0 && (T1.length > p || (B2.includes(x) && T1.length === p))) {
      const old = T1.pop();
      B1.unshift(old);
      if (B1.length > cfg.C) B1.pop();
      stats.evictions++;
    } else if (T2.length > 0) {
      const old = T2.pop();
      B2.unshift(old);
      if (B2.length > cfg.C) B2.pop();
      stats.evictions++;
    }
  };

  for (let i = 0; i < upto; i++) {
    const x = requests[i].id;

    if (T1.includes(x) || T2.includes(x)) {
      stats.hits++;
      if (T1.includes(x)) {
        T1.splice(T1.indexOf(x), 1);
      } else {
        T2.splice(T2.indexOf(x), 1);
      }
      T2.unshift(x);
      stats.events.push({ t: i + 1, outcome: 'HIT' });
    } else {
      stats.misses++;
      stats.weightedMissCost += requests[i].cost;

      if (B1.includes(x)) {
        p = Math.min(cfg.C, p + Math.max(1, Math.floor(B2.length / Math.max(1, B1.length))));
        replace(x);
        B1.splice(B1.indexOf(x), 1);
        T2.unshift(x);
      } else if (B2.includes(x)) {
        p = Math.max(0, p - Math.max(1, Math.floor(B1.length / Math.max(1, B2.length))));
        replace(x);
        B2.splice(B2.indexOf(x), 1);
        T2.unshift(x);
      } else {
        if (T1.length + B1.length === cfg.C) {
          if (T1.length < cfg.C) {
            B1.pop();
            replace(x);
          } else if (T1.length > 0) {
            T1.pop();
            stats.evictions++;
          }
        } else if (T1.length + B1.length < cfg.C && T1.length + T2.length + B1.length + B2.length >= cfg.C) {
          if (T1.length + T2.length + B1.length + B2.length >= 2 * cfg.C && B2.length > 0) B2.pop();
          replace(x);
        }
        T1.unshift(x);
      }
      stats.events.push({ t: i + 1, outcome: 'MISS' });
    }
    stats.decisionOps += 2;
  }

  const total = stats.hits + stats.misses;
  stats.hitRate = total ? stats.hits / total : 0;
  return stats;
}

function resetSimulation() {
  const cfg = readConfig();
  let requests = parseWorkload(els.workload.value, cfg.P);
  if (!requests.length) {
    requests = generateTrace('stable', cfg.N, cfg.P, cfg.seed);
    els.workload.value = toWorkloadText(requests);
  }
  state.cfg = cfg;
  state.requests = requests.slice(0, cfg.N);
  state.hgdb = new HGDBSimulator(cfg, state.requests);
  state.comparison = null;
  state.lastRunTs = null;

  renderHGDB();
  renderPipeline([]);
  els.stepLog.innerHTML = '';
  els.whatifResult.textContent = '';
  renderComp(null);
  drawBarChart(null);
  drawLineChart([],
    []);
}

function runStep() {
  if (!state.hgdb) resetSimulation();
  const out = state.hgdb.step();
  if (!out) return;
  renderPipeline(out.stages);
  appendLogs(out.log);
  renderHGDB();
}

function runAll() {
  if (!state.hgdb) resetSimulation();
  const result = state.hgdb.runAll();
  renderPipeline([]);
  appendLogs([`Completed ${result.hits + result.misses} requests.`]);
  renderHGDB();
  runComparison();
}

function runComparison() {
  if (!state.hgdb) return;
  const hg = state.hgdb.summary();
  const lru = runLRU(state.cfg, state.requests);
  const arc = runARC(state.cfg, state.requests);
  const rrip = runRRIP(state.cfg, state.requests);

  state.comparison = { hg, lru, arc, rrip, generatedAt: new Date().toISOString() };
  renderComp(state.comparison);
  drawBarChart(state.comparison);
  drawLineChart(hg.confidenceSeries, hg.kSeries);
}

function renderPipeline(stages) {
  const nodes = [...els.pipeline.querySelectorAll('.node')];
  nodes.forEach(n => n.classList.remove('active'));
  stages.forEach((s, i) => {
    setTimeout(() => {
      const node = els.pipeline.querySelector(`.node[data-node="${s}"]`);
      if (node) node.classList.add('active');
    }, i * 120);
  });
}

function appendLogs(lines) {
  lines.forEach(line => {
    const div = document.createElement('div');
    div.textContent = line;
    els.stepLog.appendChild(div);
  });
  els.stepLog.scrollTop = els.stepLog.scrollHeight;
}

function renderHGDB() {
  if (!state.hgdb) return;
  const s = state.hgdb.summary();
  const idx = state.hgdb.idx;
  const total = s.hits + s.misses;
  const hitRate = total ? s.hits / total : 0;

  els.sIdx.textContent = `${idx}/${state.requests.length}`;
  els.sHits.textContent = s.hits;
  els.sMisses.textContent = s.misses;
  els.sCost.textContent = fmt(s.weightedMissCost, 2);
  els.sConf.textContent = fmt(state.hgdb.conf, 3);
  els.sK.textContent = state.hgdb.currentK();

  els.mHitRate.textContent = `${fmt(hitRate * 100, 1)}%`;
  els.mMissCost.textContent = fmt(s.weightedMissCost, 1);
  els.mConf.textContent = fmt(state.hgdb.conf, 2);
  els.mK.textContent = state.hgdb.currentK();

  els.budgetView.innerHTML = state.hgdb.budget
    .map((b, p) => `<span class="chip">class ${p}: budget ${b}</span>`).join('');

  els.cacheView.innerHTML = state.hgdb.cache.map((arr, p) => {
    const g = state.hgdb.ghost[p].join(' ') || '-';
    const c = arr.join(' ') || '-';
    return `
      <div class="cache-box">
        <b>Class ${p}</b>
        <div class="cache-line">Cache (MRU→LRU): ${c}</div>
        <div class="cache-line">Ghost tags: ${g}</div>
      </div>`;
  }).join('');
}

function renderComp(comp) {
  if (!comp) {
    els.compCards.innerHTML = '';
    return;
  }
  const rows = [comp.hg, comp.lru, comp.arc, comp.rrip];
  els.compCards.innerHTML = rows.map(r => `
    <article class="card">
      <h3>${r.name || (r === comp.hg ? 'HGDB-LRUPS' : '')}</h3>
      <p><b>Hit Rate:</b> ${fmt(r.hitRate * 100, 2)}%</p>
      <p><b>Weighted Miss Cost:</b> ${fmt(r.weightedMissCost, 2)}</p>
      <p><b>Misses:</b> ${r.misses}</p>
      <p><b>Evictions:</b> ${r.evictions}</p>
      <p><b>Decision Ops (proxy):</b> ${Math.round(r.decisionOps)}</p>
    </article>`).join('');
}

function drawBarChart(comp) {
  const c = els.barChart;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!comp) return;

  const data = [
    { n: 'HGDB', h: comp.hg.hitRate * 100, m: comp.hg.weightedMissCost },
    { n: 'LRU', h: comp.lru.hitRate * 100, m: comp.lru.weightedMissCost },
    { n: 'ARC', h: comp.arc.hitRate * 100, m: comp.arc.weightedMissCost },
    { n: 'RRIP', h: comp.rrip.hitRate * 100, m: comp.rrip.weightedMissCost },
  ];

  const pad = 60;
  const maxHit = 100;
  const maxMiss = Math.max(...data.map(x => x.m), 1);
  const slot = (c.width - pad * 2) / data.length;

  ctx.fillStyle = '#c9d8ff';
  ctx.font = '12px Manrope';
  ctx.fillText('Hit Rate (%) and Weighted Miss Cost (normalized bars)', 20, 24);

  data.forEach((d, i) => {
    const x = pad + i * slot + 20;
    const w = slot * 0.28;

    const h1 = (d.h / maxHit) * (c.height - 130);
    const h2 = (d.m / maxMiss) * (c.height - 130);

    ctx.fillStyle = '#31e2b1';
    ctx.fillRect(x, c.height - 50 - h1, w, h1);

    ctx.fillStyle = '#3bc4ff';
    ctx.fillRect(x + w + 10, c.height - 50 - h2, w, h2);

    ctx.fillStyle = '#c9d8ff';
    ctx.fillText(`${d.n}`, x, c.height - 28);
    ctx.fillText(`${fmt(d.h, 1)}%`, x, c.height - 55 - h1);
    ctx.fillText(`${fmt(d.m, 1)}`, x + w + 10, c.height - 55 - h2);
  });

  ctx.fillStyle = '#31e2b1';
  ctx.fillRect(c.width - 290, 24, 16, 10);
  ctx.fillStyle = '#c9d8ff';
  ctx.fillText('Hit Rate', c.width - 268, 34);
  ctx.fillStyle = '#3bc4ff';
  ctx.fillRect(c.width - 190, 24, 16, 10);
  ctx.fillStyle = '#c9d8ff';
  ctx.fillText('Miss Cost', c.width - 168, 34);
}

function drawLineChart(confSeries, kSeries) {
  const c = els.lineChart;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!confSeries?.length) return;

  const pad = 45;
  const W = c.width - pad * 2;
  const H = c.height - pad * 2;

  ctx.strokeStyle = '#2d3b61';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const y = pad + (H * i) / 5;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(c.width - pad, y);
    ctx.stroke();
  }

  const maxK = Math.max(...kSeries, 1);

  ctx.strokeStyle = '#31e2b1';
  ctx.lineWidth = 2;
  ctx.beginPath();
  confSeries.forEach((v, i) => {
    const x = pad + (i / Math.max(1, confSeries.length - 1)) * W;
    const y = pad + (1 - v) * H;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.strokeStyle = '#ffce63';
  ctx.beginPath();
  kSeries.forEach((v, i) => {
    const x = pad + (i / Math.max(1, kSeries.length - 1)) * W;
    const y = pad + (1 - v / maxK) * H;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = '#d8e5ff';
  ctx.font = '12px Manrope';
  ctx.fillText('Confidence and adaptive k over time', 20, 20);
  ctx.fillStyle = '#31e2b1';
  ctx.fillRect(c.width - 260, 16, 14, 8);
  ctx.fillStyle = '#d8e5ff';
  ctx.fillText('Confidence', c.width - 240, 24);
  ctx.fillStyle = '#ffce63';
  ctx.fillRect(c.width - 150, 16, 14, 8);
  ctx.fillStyle = '#d8e5ff';
  ctx.fillText('k_t', c.width - 130, 24);
}

function whatIf(alg) {
  if (!state.hgdb) return;
  const step = state.hgdb.idx;
  if (step <= 0) {
    els.whatifResult.textContent = 'Run at least one step first.';
    return;
  }

  let res;
  if (alg === 'LRU') res = runLRU(state.cfg, state.requests, step);
  if (alg === 'ARC') res = runARC(state.cfg, state.requests, step);
  if (alg === 'RRIP') res = runRRIP(state.cfg, state.requests, step);
  const ev = res.events[step - 1]?.outcome || 'N/A';
  els.whatifResult.textContent = `At step ${step}, ${alg} outcome: ${ev}. Cumulative hit-rate=${fmt(res.hitRate * 100, 2)}%, weighted miss cost=${fmt(res.weightedMissCost, 2)}.`;
}

function exportReport() {
  if (!state.hgdb) return;
  if (!state.comparison) runComparison();

  const payload = {
    generatedAt: new Date().toISOString(),
    config: state.cfg,
    workloadSize: state.requests.length,
    workload: state.requests,
    hgdb: state.hgdb.summary(),
    comparison: state.comparison,
    complexity: {
      LRU: 'O(1) per access',
      ARC: 'O(1) amortized (simplified model)',
      RRIP: 'O(1) amortized (simplified model)',
      HGDB: 'Hit O(1), Eviction O(B_p*k_t), Rebalance O(P*C^2)'
    }
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hgdb_report_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function bind() {
  [els.runCta, els.heroRun, els.btnRun].forEach(b => b.addEventListener('click', runAll));
  [els.heroStep, els.btnStep].forEach(b => b.addEventListener('click', runStep));

  els.btnReset.addEventListener('click', resetSimulation);
  els.btnCompare.addEventListener('click', runComparison);
  els.btnExport.addEventListener('click', exportReport);

  els.genStable.addEventListener('click', () => {
    const cfg = readConfig();
    els.workload.value = toWorkloadText(generateTrace('stable', cfg.N, cfg.P, cfg.seed));
    resetSimulation();
  });
  els.genScan.addEventListener('click', () => {
    const cfg = readConfig();
    els.workload.value = toWorkloadText(generateTrace('scan', cfg.N, cfg.P, cfg.seed));
    resetSimulation();
  });
  els.genDrift.addEventListener('click', () => {
    const cfg = readConfig();
    els.workload.value = toWorkloadText(generateTrace('drift', cfg.N, cfg.P, cfg.seed));
    resetSimulation();
  });

  [els.whatLru, els.whatArc, els.whatRrip].forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn === els.whatLru) whatIf('LRU');
      if (btn === els.whatArc) whatIf('ARC');
      if (btn === els.whatRrip) whatIf('RRIP');
    });
  });

  [
    els.cfgC, els.cfgP, els.cfgN, els.cfgKmin, els.cfgKmax, els.cfgRho,
    els.cfgTheta, els.cfgA, els.cfgB, els.cfgG, els.cfgD, els.cfgReb
  ].forEach(i => i.addEventListener('change', resetSimulation));
}

function init() {
  const cfg = readConfig();
  const sample = generateTrace('stable', cfg.N, cfg.P, cfg.seed);
  els.workload.value = toWorkloadText(sample);
  bind();
  resetSimulation();
}

init();
