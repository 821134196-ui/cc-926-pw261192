// chart.js —— 零依赖 Canvas 时间序列图表：多系列折线、参考线、阶段底色、十字线 tooltip
// 颜色全部走 CSS 自定义属性（角色色），明暗主题切换时自动重绘。

const PALETTE = {
  blue: 'var(--series-blue)',
  orange: 'var(--series-orange)',
  aqua: 'var(--series-aqua)',
  red: 'var(--series-red)',
  violet: 'var(--series-violet)',
};

function cssColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name.replace('var(', '').replace(')', '')).trim();
}

function niceTicks(max, min = 0, target = 5) {
  if (max <= min) max = min + 1;
  const span = max - min;
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(+v.toFixed(6));
  return ticks;
}

export class TimeSeriesChart {
  // opts: { title, unit, series:[{name,color,dash?}], yMax?, refLines:[{value,label,color}], bands:[{from,to,label}], fmtY }
  constructor(container, opts) {
    this.container = container;
    this.opts = opts;
    this.data = [];
    container.innerHTML = '';
    container.classList.add('chart-card');

    const head = document.createElement('div');
    head.className = 'chart-head';
    const title = document.createElement('h3');
    title.textContent = opts.title;
    head.appendChild(title);
    this.legendEl = document.createElement('div');
    this.legendEl.className = 'legend';
    head.appendChild(this.legendEl);
    container.appendChild(head);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-canvas';
    container.appendChild(this.canvas);

    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    this.tip.setAttribute('role', 'status');
    container.appendChild(this.tip);

    this._onMove = (e) => this._handleMove(e);
    this._onLeave = () => this._hideTip();
    this.canvas.addEventListener('pointermove', this._onMove);
    this.canvas.addEventListener('pointerleave', this._onLeave);

    this._ro = new ResizeObserver(() => this.render());
    this._ro.observe(container);
  }

  setData(records, accessors) {
    // accessors: 与 series 等长的取值函数数组
    this.data = records.map((r, i) => ({ t: r.t, vals: accessors.map((a) => a(r, i)), raw: r }));
    this.render();
  }

  _geo() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.container.clientWidth;
    const h = 340;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const padL = 52,
      padR = 92,
      padT = 14,
      padB = 34;
    return { ctx, w, h, plot: { x: padL, y: padT, w: w - padL - padR, h: h - padT - padB } };
  }

  render() {
    if (!this.data.length) return;
    const { ctx, w, h, plot } = this._geo();
    const o = this.opts;
    const ink = {
      grid: cssColor('var(--grid)'),
      axis: cssColor('var(--axis)'),
      muted: cssColor('var(--text-muted)'),
      text: cssColor('var(--text-secondary)'),
      band: cssColor('var(--band-fill)'),
      surface: cssColor('var(--surface-1)'),
    };
    ctx.clearRect(0, 0, w, h);

    const t0 = this.data[0].t;
    const t1 = this.data[this.data.length - 1].t;
    let yMax = o.yMax ?? 0;
    if (yMax == null || !o.yMax) {
      for (const d of this.data) for (const v of d.vals) if (v > yMax) yMax = v;
      for (const rl of o.refLines || []) if (rl.value > yMax) yMax = rl.value;
      yMax *= 1.08;
    }
    const ticks = niceTicks(yMax);
    const yTop = ticks[ticks.length - 1];
    const x = (t) => plot.x + ((t - t0) / (t1 - t0 || 1)) * plot.w;
    const y = (v) => plot.y + plot.h - (v / yTop) * plot.h;

    // 阶段底色（突发/过载区间）
    for (const b of o.bands || []) {
      ctx.fillStyle = ink.band;
      const bx = x(b.from);
      ctx.fillRect(bx, plot.y, Math.max(1, x(b.to) - bx), plot.h);
      ctx.fillStyle = ink.muted;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(b.label, (x(b.from) + x(b.to)) / 2, plot.y + 12);
    }

    // 网格 + y 轴刻度
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const tv of ticks) {
      const yy = y(tv);
      ctx.strokeStyle = ink.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plot.x, yy);
      ctx.lineTo(plot.x + plot.w, yy);
      ctx.stroke();
      ctx.fillStyle = ink.muted;
      ctx.fillText(o.fmtY ? o.fmtY(tv) : String(tv), plot.x - 8, yy);
    }

    // x 轴时间刻度
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xStep = Math.ceil((t1 - t0) / 10 / 5) * 5 || 5;
    for (let tv = 0; tv <= t1; tv += xStep) {
      ctx.fillStyle = ink.muted;
      ctx.fillText(tv + 's', x(tv), plot.y + plot.h + 8);
    }
    ctx.strokeStyle = ink.axis;
    ctx.beginPath();
    ctx.moveTo(plot.x, plot.y);
    ctx.lineTo(plot.x, plot.y + plot.h);
    ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
    ctx.stroke();

    // 参考线（实线 hairline + 行内标签，避免与网格混淆）
    for (const rl of o.refLines || []) {
      const yy = y(rl.value);
      ctx.strokeStyle = rl.color || ink.axis;
      ctx.lineWidth = 1;
      ctx.setLineDash(rl.dash ? [5, 4] : []);
      ctx.beginPath();
      ctx.moveTo(plot.x, yy);
      ctx.lineTo(plot.x + plot.w, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = rl.color || ink.text;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(rl.label, plot.x + 6, yy - 2);
    }

    // 数据折线（2px，round join；可选虚线做辅助编码）
    o.series.forEach((s, si) => {
      const col = cssColor(s.color);
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash(s.dash || []);
      ctx.beginPath();
      this.data.forEach((d, i) => {
        const px = x(d.t);
        const py = y(d.vals[si]);
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // 末端直接标签（选择性标注，兼作 CVD 辅助编码）；碰撞时做最小纵向位移而非堆叠
    const last = this.data[this.data.length - 1];
    const endLabels = o.series.map((s, si) => ({
      text: s.name + ' ' + (s.fmt ? s.fmt(last.vals[si]) : Math.round(last.vals[si])),
      y: y(last.vals[si]),
    }));
    const rowH = 15;
    endLabels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < endLabels.length; i++) {
      if (endLabels[i].y - endLabels[i - 1].y < rowH) endLabels[i].y = endLabels[i - 1].y + rowH;
    }
    const overflow = endLabels[endLabels.length - 1].y - (plot.y + plot.h) + 4;
    if (overflow > 0) endLabels.forEach((l) => (l.y -= overflow));
    ctx.fillStyle = ink.text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = '11px system-ui, sans-serif';
    for (const l of endLabels) ctx.fillText(l.text, plot.x + plot.w - 4, l.y - 8);

    // 图例
    this.legendEl.replaceChildren();
    o.series.forEach((s) => {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const key = document.createElement('span');
      key.className = 'legend-key';
      key.style.cssText = `background:${s.color};${s.dash ? 'height:0;border-top:2px dashed ' + s.color + ';background:none;' : ''}`;
      const name = document.createElement('span');
      name.textContent = s.name;
      item.append(key, name);
      this.legendEl.appendChild(item);
    });

    this._scales = { x, y, plot, t0, t1 };
  }

  _handleMove(e) {
    if (!this._scales) return;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const { x, plot, t0, t1 } = this._scales;
    // 反解最近 tick
    const frac = Math.min(1, Math.max(0, (mx - plot.x) / plot.w));
    const t = t0 + frac * (t1 - t0);
    const idx = Math.round(t / (this.data[1]?.t - this.data[0]?.t || 0.05));
    const d = this.data[Math.min(this.data.length - 1, Math.max(0, idx))];
    const px = x(d.t);

    // 重绘后补十字线
    this.render();
    const ctx = this.canvas.getContext('2d');
    ctx.strokeStyle = cssColor('var(--axis)');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, plot.y);
    ctx.lineTo(px, plot.y + plot.h);
    ctx.stroke();
    for (let si = 0; si < this.opts.series.length; si++) {
      ctx.fillStyle = cssColor(this.opts.series[si].color);
      ctx.beginPath();
      ctx.arc(px, this._scales.y(d.vals[si]), 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = cssColor('var(--surface-1)');
      ctx.stroke();
    }

    // tooltip：一个浮层列出全部系列（值为主、名称为辅）
    this.tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'tip-time';
    head.textContent = `t = ${d.t.toFixed(1)}s`;
    this.tip.appendChild(head);
    this.opts.series.forEach((s, si) => {
      const row = document.createElement('div');
      row.className = 'tip-row';
      const key = document.createElement('span');
      key.className = 'tip-key';
      key.style.borderTop = `2px solid ${s.color}`;
      const name = document.createElement('span');
      name.className = 'tip-name';
      name.textContent = s.name;
      const val = document.createElement('strong');
      val.textContent = s.fmt ? s.fmt(d.vals[si]) : String(Math.round(d.vals[si]));
      row.append(key, name, val);
      this.tip.appendChild(row);
    });
    this.tip.style.display = 'block';
    const cw = this.container.clientWidth;
    const tw = this.tip.offsetWidth || 150;
    this.tip.style.left = (px + 12 + tw > cw ? px - tw - 12 : px + 12) + 'px';
    this.tip.style.top = '24px';
  }

  _hideTip() {
    this.tip.style.display = 'none';
    this.render();
  }
}
