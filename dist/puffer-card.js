// Colour scale from cold (20°C) to hot (95°C)
const STOPS = [
  { t: 20, r:  13, g:  71, b: 161 }, // #0d47a1
  { t: 40, r:   0, g: 172, b: 193 }, // #00acc1
  { t: 60, r: 124, g: 179, b:  66 }, // #7cb342
  { t: 80, r: 251, g: 140, b:   0 }, // #fb8c00
  { t: 95, r: 183, g:  28, b:  28 }, // #b71c1c
];

function tempToRGB(temp, minTemp = 20, maxTemp = 95) {
  const t = Math.max(minTemp, Math.min(maxTemp, temp));
  if (t <= STOPS[0].t) return { ...STOPS[0] }
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (t <= STOPS[i + 1].t) {
      const s = STOPS[i], e = STOPS[i + 1];
      const f = (t - s.t) / (e.t - s.t);
      return {
        r: Math.round(s.r + (e.r - s.r) * f),
        g: Math.round(s.g + (e.g - s.g) * f),
        b: Math.round(s.b + (e.b - s.b) * f),
      }
    }
  }
  return { ...STOPS[STOPS.length - 1] }
}

function tempToColor(temp, minTemp = 20, maxTemp = 95, alpha = 1) {
  const { r, g, b } = tempToRGB(temp, minTemp, maxTemp);
  return alpha === 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`
}

class PufferStateCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  setConfig(config) {
    if (!config.sensors || config.sensors.length < 1) {
      throw new Error('puffer-state-card: sensors array required')
    }
    this._config = { min_temp: 20, max_temp: 95, ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._update();
  }

  _render() {
    const { sensors } = this._config;
    // Rows are rendered top-to-bottom = sensor N (hottest) down to sensor 1 (coldest)
    const rows = [...sensors].reverse().map((entityId, i) => {
      const idx = sensors.length - 1 - i;
      const label = entityId.split('.').pop();
      return `
        <div class="row" id="row-${idx}">
          <div class="color-bar" id="bar-${idx}"></div>
          <div class="temp" id="temp-${idx}">–</div>
          <div class="name">${label}</div>
        </div>`
    }).join('');

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .tank-wrapper {
          display: flex;
          align-items: stretch;
          padding: 12px 16px;
          gap: 10px;
        }
        .tank-visual {
          flex: 0 0 20px;
          border-radius: 4px;
          border: 1.5px solid rgba(0,0,0,0.18);
          overflow: hidden;
          position: relative;
        }
        .tank-gradient {
          position: absolute;
          inset: 0;
          transition: background 0.6s;
        }
        .rows {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .row {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 1;
          min-height: 36px;
        }
        .color-bar {
          width: 8px;
          flex-shrink: 0;
          border-radius: 3px;
          align-self: stretch;
          transition: background-color 0.6s;
        }
        .temp {
          font-size: 15px;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          min-width: 65px;
        }
        .name {
          font-size: 11px;
          color: var(--secondary-text-color, #888);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      </style>
      <ha-card>
        <div class="tank-wrapper">
          <div class="tank-visual">
            <div class="tank-gradient" id="gradient"></div>
          </div>
          <div class="rows">${rows}</div>
        </div>
      </ha-card>`;
  }

  _update() {
    if (!this._hass || !this._config) return
    const { sensors, min_temp, max_temp } = this._config;

    const temps = sensors.map(id => {
      const s = this._hass.states[id];
      if (!s) return null
      const v = parseFloat(s.state);
      return isNaN(v) ? null : v
    });

    temps.forEach((t, i) => {
      const bar  = this.shadowRoot.getElementById(`bar-${i}`);
      const tempEl = this.shadowRoot.getElementById(`temp-${i}`);
      if (bar) bar.style.backgroundColor = t !== null ? tempToColor(t, min_temp, max_temp) : '#bbb';
      if (tempEl) tempEl.textContent = t !== null ? `${t.toFixed(1)} °C` : '–';
    });

    // Smooth CSS gradient on the tank visual (sensor 0 = bottom, N-1 = top)
    const gradEl = this.shadowRoot.getElementById('gradient');
    if (gradEl && temps.length > 0) {
      const stops = temps.map((t, i) => {
        const pct = (i / (temps.length - 1)) * 100;
        return `${t !== null ? tempToColor(t, min_temp, max_temp) : '#bbb'} ${pct.toFixed(0)}%`
      }).join(', ');
      gradEl.style.background = `linear-gradient(to top, ${stops})`;
    }
  }
}

customElements.define('puffer-state-card', PufferStateCard);

const HOURS_OPTIONS = [24, 48, 168];

class PufferHistoryCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hours = 24;
    this._data = null;
    this._loading = false;
  }

  setConfig(config) {
    if (!config.sensors || config.sensors.length < 1) {
      throw new Error('puffer-history-card: sensors array required')
    }
    this._config = { min_temp: 20, max_temp: 95, ...config };
    this._render();
    if (this._hass) this._loadHistory();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._loadHistory();
  }

  connectedCallback() {
    this._ro = new ResizeObserver(() => this._drawChart());
    this._ro.observe(this);
  }

  disconnectedCallback() {
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
  }

  _render() {
    const buttons = HOURS_OPTIONS.map(h =>
      `<button class="btn${this._hours === h ? ' active' : ''}" data-hours="${h}">${h < 48 ? h + 'h' : h / 24 + 'd'}</button>`
    ).join('');

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .controls {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 10px 16px 4px;
        }
        .label {
          font-size: 12px;
          color: var(--secondary-text-color, #888);
          margin-right: 2px;
        }
        .btn {
          padding: 3px 11px;
          border: 1px solid var(--divider-color, #ccc);
          border-radius: 12px;
          background: transparent;
          font-size: 12px;
          color: var(--primary-text-color, #333);
          cursor: pointer;
        }
        .btn.active {
          background: var(--primary-color, #03a9f4);
          border-color: var(--primary-color, #03a9f4);
          color: #fff;
        }
        canvas { display: block; width: 100%; }
        .msg {
          padding: 40px;
          text-align: center;
          font-size: 13px;
          color: var(--secondary-text-color, #888);
        }
      </style>
      <ha-card>
        <div class="controls">
          <span class="label">History:</span>${buttons}
        </div>
        <canvas id="chart" height="300"></canvas>
      </ha-card>`;

    this.shadowRoot.querySelectorAll('.btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._hours = parseInt(btn.dataset.hours);
        this._render();
        if (this._hass) this._loadHistory();
      });
    });
  }

  async _loadHistory() {
    if (this._loading || !this._hass || !this._config) return
    this._loading = true;

    const { sensors } = this._config;
    const now = new Date();
    const start = new Date(now.getTime() - this._hours * 3600 * 1000);

    try {
      const result = await this._hass.callApi(
        'GET',
        `history/period/${start.toISOString()}` +
        `?filter_entity_id=${sensors.join(',')}` +
        `&end_time=${now.toISOString()}&minimal_response=true&no_attributes=true`
      );

      this._startTime = start.getTime();
      this._endTime   = now.getTime();
      this._data = {};

      sensors.forEach((entityId, i) => {
        this._data[entityId] = (result[i] || [])
          .filter(s => s.state !== 'unavailable' && s.state !== 'unknown')
          .map(s => ({ t: new Date(s.last_changed).getTime(), v: parseFloat(s.state) }))
          .filter(p => !isNaN(p.v));
      });

      this._drawChart();
    } catch (e) {
      console.error('[puffer-history-card]', e);
    } finally {
      this._loading = false;
    }
  }

  _drawChart() {
    const canvas = this.shadowRoot.getElementById('chart');
    if (!canvas || !this._data) return

    const { sensors, min_temp, max_temp } = this._config;
    const N = sensors.length;

    const W = this.offsetWidth || 400;
    const H = 300;
    canvas.width  = W;
    canvas.height = H;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    // Padding (room for axes and depth layers above/right)
    const PAD_L = 42;
    const PAD_R = 18;
    const PAD_T = 12;
    const PAD_B = 36;

    // Isometric depth: each layer back shifts right and up
    const DEPTH_X = 22;  // px per layer (right)
    const DEPTH_Y = 11;  // px per layer (up = negative screen y)
    const totalDX = (N - 1) * DEPTH_X;
    const totalDY = (N - 1) * DEPTH_Y;

    // Chart area for the front layer (sensor 1)
    const chartW = W - PAD_L - PAD_R - totalDX;
    const chartH = H - PAD_T - PAD_B - totalDY;
    if (chartW < 20 || chartH < 20) return

    const tStart = this._startTime;
    const tEnd   = this._endTime;

    // Map helpers — z=0 is front (sensor 1), z=N-1 is back (sensor N)
    const toX = (t, z) => PAD_L + ((t - tStart) / (tEnd - tStart)) * chartW + z * DEPTH_X;
    const toY = (v, z) => PAD_T + totalDY + chartH - ((v - min_temp) / (max_temp - min_temp)) * chartH - z * DEPTH_Y;
    const floorY = z => PAD_T + totalDY + chartH - z * DEPTH_Y;

    // --- Temperature axis (left, front layer) ---
    const tempStep = chartH > 160 ? 10 : 20;
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_L, PAD_T + totalDY);
    ctx.lineTo(PAD_L, floorY(0));
    ctx.stroke();

    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    for (let t = Math.ceil(min_temp / tempStep) * tempStep; t <= max_temp; t += tempStep) {
      const y = toY(t, 0);
      ctx.strokeStyle = 'rgba(0,0,0,0.06)';
      ctx.beginPath();
      ctx.moveTo(PAD_L, y);
      ctx.lineTo(PAD_L + chartW, y);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.beginPath();
      ctx.moveTo(PAD_L - 3, y);
      ctx.lineTo(PAD_L, y);
      ctx.stroke();
      ctx.fillText(`${t}°`, PAD_L - 5, y + 3);
    }

    // --- Time axis (bottom, front layer) ---
    const timeAxisY = floorY(0);
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.beginPath();
    ctx.moveTo(PAD_L, timeAxisY);
    ctx.lineTo(PAD_L + chartW, timeAxisY);
    ctx.stroke();

    const hourStep = this._hours <= 24 ? 4 : this._hours <= 48 ? 8 : 24;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    const tickStart = new Date(tStart);
    tickStart.setMinutes(0, 0, 0);
    tickStart.setHours(tickStart.getHours() + hourStep);
    for (let d = new Date(tickStart); d.getTime() <= tEnd; d.setHours(d.getHours() + hourStep)) {
      const x = toX(d.getTime(), 0);
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.beginPath();
      ctx.moveTo(x, timeAxisY);
      ctx.lineTo(x, timeAxisY + 4);
      ctx.stroke();
      const lbl = this._hours <= 48
        ? d.getHours().toString().padStart(2, '0') + ':00'
        : `${d.getDate()}.${(d.getMonth() + 1).toString().padStart(2, '0')}.`;
      ctx.fillText(lbl, x, timeAxisY + 14);
    }

    // --- Sensor ribbons: draw back to front ---
    for (let z = N - 1; z >= 0; z--) {
      const entityId = sensors[z];   // z=0 → sensors[0] = sensor1 (front)
      const series = (this._data[entityId] || []).filter(p => p.t >= tStart && p.t <= tEnd);
      if (series.length < 2) continue

      const avgTemp = series.reduce((s, p) => s + p.v, 0) / series.length;
      const { r, g, b } = tempToRGB(avgTemp, min_temp, max_temp);

      const xs = series.map(p => toX(p.t, z));
      const ys = series.map(p => toY(p.v, z));
      const fy = floorY(z);

      // Filled ribbon area
      ctx.beginPath();
      ctx.moveTo(xs[0], fy);
      ctx.lineTo(xs[0], ys[0]);
      for (let i = 1; i < series.length; i++) ctx.lineTo(xs[i], ys[i]);
      ctx.lineTo(xs[xs.length - 1], fy);
      ctx.closePath();
      ctx.fillStyle = `rgba(${r},${g},${b},0.30)`;
      ctx.fill();

      // Baseline
      ctx.beginPath();
      ctx.moveTo(xs[0], fy);
      ctx.lineTo(xs[xs.length - 1], fy);
      ctx.strokeStyle = `rgba(${r},${g},${b},0.5)`;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Top edge — one gradient stroke per ribbon
      const grad = ctx.createLinearGradient(xs[0], 0, xs[xs.length - 1], 0);
      series.forEach((p, i) => {
        grad.addColorStop(i / (series.length - 1), tempToColor(p.v, min_temp, max_temp));
      });
      ctx.beginPath();
      ctx.moveTo(xs[0], ys[0]);
      for (let i = 1; i < series.length; i++) ctx.lineTo(xs[i], ys[i]);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Sensor label at right edge
      const lx = xs[xs.length - 1] + 4;
      const ly = ys[ys.length - 1];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`S${z + 1}`, lx, ly + 4);
    }
  }
}

customElements.define('puffer-history-card', PufferHistoryCard);

console.info(
  '%c HOME-ASSISTANT-CARDS %c puffer-card loaded',
  'background:#0d47a1;color:#fff;padding:2px 6px;border-radius:3px 0 0 3px',
  'background:#1565c0;color:#fff;padding:2px 6px;border-radius:0 3px 3px 0'
);
