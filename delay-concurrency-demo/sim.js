// sim.js —— 固定延迟服务 + 并发调节器 离散事件仿真（无 DOM 依赖，可直接被 Node 引用）
//
// 模型：
//   - 服务时间固定（固定延迟工况），W 个 worker，系统真实处理能力 = W / serviceTime
//   - 经典并发限流语义：请求被准入后即占用一个 permit（排队中 + 服务中都算），
//     达到并发上限立即快速拒绝（fail-fast），不堆积无界队列
//   - 排队时延 = 开始服务时刻 - 到达时刻；调节器按 EMA 排队时延调整 permit 上限
//   - AIMD 调节：加性增（慢）、乘性减（快），每步变化幅度封顶；带死区抑制振荡
//   - 低频高优先请求：不受普通 permit 上限约束，可使用预留容量 + 队头优先调度

export const DT = 0.05; // 仿真步长（秒）

// ---------- 随机数：mulberry32，保证两种模式消费同一条压力曲线 ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(rng, mean) {
  if (mean <= 0) return 0;
  const L = Math.exp(-mean);
  let k = 0,
    p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

// ---------- 压力曲线：基线 → 突发 → 回落恢复 → 持续过载 → 基线 ----------
export function rateAt(t, cfg) {
  const s = cfg.stages;
  if (t < s[0][0]) return cfg.baselineRate;
  for (const [end, rate] of s) {
    if (t < end) return rate;
  }
  return cfg.baselineRate;
}

// 预生成整条到达流（两种模式复用同一份，确保“同一段压力曲线”）
function generateArrivals(cfg) {
  const rng = mulberry32(cfg.seed);
  const rngPrio = mulberry32(cfg.seed ^ 0x9e3779b9);
  const nTicks = Math.round(cfg.duration / DT);
  const arrivals = new Array(nTicks);
  let id = 0;
  for (let i = 0; i < nTicks; i++) {
    const t = i * DT;
    const total = poisson(rng, rateAt(t, cfg) * DT);
    const prio = poisson(rngPrio, cfg.priorityRate * DT);
    const batch = [];
    for (let j = 0; j < total; j++) batch.push({ id: id++, prio: false, arrival: t });
    for (let j = 0; j < prio; j++) batch.push({ id: id++, prio: true, arrival: t });
    arrivals[i] = batch;
  }
  return arrivals;
}

// ---------- 单次仿真 ----------
// mode: 'fixed'（固定并发）| 'dynamic'（按排队时延动态调节）
export function simulate(cfg, mode, arrivals) {
  const nTicks = Math.round(cfg.duration / DT);
  const W = cfg.workers;
  const svcTicks = Math.round(cfg.serviceTime / DT); // 固定服务时间，按 tick 计

  // 动态调节器状态
  const ctrl = {
    limit: mode === 'fixed' ? cfg.fixedLimit : cfg.dynStart,
    emaDelay: 0, // 排队时延 EMA（秒）
    tickEvery: Math.round(cfg.controlInterval / DT),
    idleTicks: 0, // 本调节周期内 worker 空闲的 tick 数
  };
  const limitOf = () => (mode === 'fixed' ? cfg.fixedLimit : ctrl.limit);

  // 队列：普通 + 高优先（优先队头先服务）。数组 + 头指针，避免 shift 的 O(n) 开销
  const normalQ = [];
  let normalHead = 0;
  const prioQ = [];
  let prioHead = 0;
  const doneNormal = new Uint32Array(nTicks + svcTicks + 2);
  const donePrio = new Uint32Array(nTicks + svcTicks + 2);

  let normalOut = 0; // 普通请求在系统内数量（排队 + 服务），占普通 permit
  let prioOut = 0; // 高优先请求在系统内数量
  let freeWorkers = W;
  const prioCap = W + cfg.prioQueueCap; // 高优先准入上限：全部 worker + 专用短队列

  // 统计
  const stats = {
    normal: { arrived: 0, completed: 0, rejected: 0, sumWait: 0, maxWait: 0 },
    priority: { arrived: 0, completed: 0, rejected: 0, sumWait: 0, maxWait: 0 },
    limitMin: limitOf(),
    limitMax: limitOf(),
    timeAboveTarget: 0,
  };

  const records = new Array(nTicks);

  for (let i = 0; i < nTicks; i++) {
    const t = i * DT;
    const limit = limitOf();

    // 1) 到达 + 准入（permit 在准入时即占用）
    for (const req of arrivals[i]) {
      if (req.prio) {
        stats.priority.arrived++;
        // 高优先：绕过普通上限，只受预留容量约束 → 拥塞时仍有机会进入
        if (prioOut >= prioCap) {
          stats.priority.rejected++;
          continue;
        }
        prioQ.push(req);
        prioOut++;
      } else {
        stats.normal.arrived++;
        if (normalOut >= limit) {
          stats.normal.rejected++;
          continue;
        }
        normalQ.push(req);
        normalOut++;
      }
    }

    // 2) 空闲 worker 取队列（高优先队头先调度）
    let dispatched = 0;
    let waitSum = 0;
    while (freeWorkers > 0) {
      let req = null;
      let isPrio = false;
      if (prioHead < prioQ.length) {
        req = prioQ[prioHead++];
        isPrio = true;
      } else if (normalHead < normalQ.length) {
        req = normalQ[normalHead++];
      }
      if (!req) break;
      const wait = t - req.arrival;
      const cls = isPrio ? stats.priority : stats.normal;
      cls.completed++;
      cls.sumWait += wait;
      if (wait > cls.maxWait) cls.maxWait = wait;
      waitSum += wait;
      dispatched++;
      freeWorkers--;
      (isPrio ? donePrio : doneNormal)[i + svcTicks]++;
    }
    if (dispatched > 0) {
      const meanWait = waitSum / dispatched;
      // EMA 平滑，避免单次抖动触发频繁调节
      ctrl.emaDelay =
        ctrl.emaDelay === 0 ? meanWait : ctrl.emaDelay * (1 - cfg.emaAlpha) + meanWait * cfg.emaAlpha;
    }
    if (freeWorkers > 0) ctrl.idleTicks++;

    // 3) 固定延迟服务完成，释放 permit 与 worker
    const dn = doneNormal[i];
    const dp = donePrio[i];
    if (dn) {
      normalOut -= dn;
      freeWorkers += dn;
    }
    if (dp) {
      prioOut -= dp;
      freeWorkers += dp;
    }

    // 4) 动态调节器：每个控制周期评估一次，AIMD 且变化幅度封顶
    if (mode === 'dynamic' && i > 0 && i % ctrl.tickEvery === 0) {
      const q = ctrl.emaDelay;
      const target = cfg.targetDelay;
      let delta = 0;
      if (q > target * cfg.highBand) {
        // 排队时延偏高：乘性减（快速收敛），但每周期下调不超过 maxStepDown
        const md = Math.max(1, Math.round(ctrl.limit * cfg.beta));
        delta = -Math.min(cfg.maxStepDown, md);
      } else if (q < target * cfg.lowBand) {
        // 时延很低：加性增（缓慢放开），每周期 +1，抑制突发后的振荡
        delta = 1;
      }
      // 死区 [lowBand, highBand] 内保持不动
      ctrl.limit = Math.max(cfg.dynMin, Math.min(cfg.dynMax, ctrl.limit + delta));
      ctrl.idleTicks = 0;
      stats.limitMin = Math.min(stats.limitMin, ctrl.limit);
      stats.limitMax = Math.max(stats.limitMax, ctrl.limit);
    }
    if (ctrl.emaDelay > cfg.targetDelay) stats.timeAboveTarget += DT;

    // 5) 记录快照
    records[i] = {
      t,
      rate: rateAt(t, cfg),
      limit,
      normalOut,
      prioOut,
      inFlight: normalOut + prioOut,
      qLen: normalQ.length - normalHead + (prioQ.length - prioHead),
      emaDelay: ctrl.emaDelay,
      completed: stats.normal.completed + stats.priority.completed,
      rejected: stats.normal.rejected + stats.priority.rejected,
      prioCompleted: stats.priority.completed,
      prioRejected: stats.priority.rejected,
    };
  }

  const totalArrived = stats.normal.arrived + stats.priority.arrived;
  const totalCompleted = stats.normal.completed + stats.priority.completed;
  const totalRejected = stats.normal.rejected + stats.priority.rejected;
  return {
    mode,
    records,
    stats,
    summary: {
      arrived: totalArrived,
      completed: totalCompleted,
      rejected: totalRejected,
      rejectRate: totalArrived ? totalRejected / totalArrived : 0,
      avgWait: totalCompleted
        ? (stats.normal.sumWait + stats.priority.sumWait) / totalCompleted
        : 0,
      maxWait: Math.max(stats.normal.maxWait, stats.priority.maxWait),
      timeAboveTarget: stats.timeAboveTarget,
      finalLimit: limitOf(),
      limitMin: stats.limitMin,
      limitMax: stats.limitMax,
    },
  };
}

// 默认配置（页面可覆盖其中一部分）
export function defaultConfig() {
  return {
    duration: 60, // 仿真时长（秒）
    seed: 20261127,
    workers: 25, // worker 数
    serviceTime: 0.2, // 固定服务延迟（秒）→ 系统能力 125 req/s
    prioQueueCap: 4, // 高优先专用排队位（worker 之外）
    baselineRate: 40, // 基线到达率
    priorityRate: 2, // 低频高优先请求到达率
    stages: [
      [10, 40], // 0–10s 基线
      [22, 160], // 10–22s 突发（超过系统能力 125）
      [32, 40], // 22–32s 回落，检验恢复到稳定状态
      [40, 110], // 32–40s 持续中等过载（高于固定模式能力 100，低于系统能力 125）
      [60, 40], // 40–60s 回归基线
    ],
    // 固定并发模式
    fixedLimit: 20, // 有效处理能力 = 20 / 0.2 = 100 req/s
    // 动态调节器
    dynStart: 30,
    dynMin: 8,
    dynMax: 40,
    targetDelay: 0.05, // 目标排队时延 50ms
    lowBand: 0.5, // 死区下界倍数（25ms）
    highBand: 1.5, // 死区上界倍数（75ms）
    beta: 0.2, // 乘性减比例
    emaAlpha: 0.2, // EMA 平滑系数
    controlInterval: 0.5, // 调节周期（秒）
    maxStepDown: 4, // 每周期最大下调幅度（限制变化幅度）
  };
}

// 一次完整对比：同一条到达流，分别跑固定并发与动态并发
export function runComparison(overrideCfg = {}) {
  const cfg = { ...defaultConfig(), ...overrideCfg };
  const arrivals = generateArrivals(cfg);
  const fixed = simulate(cfg, 'fixed', arrivals);
  const dynamic = simulate(cfg, 'dynamic', arrivals);
  return { cfg, fixed, dynamic };
}
