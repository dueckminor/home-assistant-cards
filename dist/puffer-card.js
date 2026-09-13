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
      return `
        <div class="row" id="row-${idx}">
          <div class="color-bar" id="bar-${idx}"></div>
          <div class="temp" id="temp-${idx}">–</div>
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

const HOURS_OPTIONS$1 = [24, 48, 168];

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
    const buttons = HOURS_OPTIONS$1.map(h =>
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
    const theme = getComputedStyle(this);
    const scaleTextColor = theme.getPropertyValue('--secondary-text-color').trim() || '#888';
    const scaleLineColor = theme.getPropertyValue('--divider-color').trim() || '#ccc';

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
    ctx.strokeStyle = scaleLineColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_L, PAD_T + totalDY);
    ctx.lineTo(PAD_L, floorY(0));
    ctx.stroke();

    ctx.fillStyle = scaleTextColor;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    for (let t = Math.ceil(min_temp / tempStep) * tempStep; t <= max_temp; t += tempStep) {
      const frontY = toY(t, 0);
      const rearY = toY(t, N - 1);
      ctx.strokeStyle = scaleLineColor;
      ctx.beginPath();
      ctx.moveTo(toX(tStart, N - 1), rearY);
      ctx.lineTo(toX(tEnd, N - 1), rearY);
      ctx.stroke();
      ctx.strokeStyle = scaleLineColor;
      ctx.beginPath();
      ctx.moveTo(PAD_L - 3, frontY);
      ctx.lineTo(PAD_L, frontY);
      ctx.stroke();
      ctx.fillText(`${t}°`, PAD_L - 5, frontY + 3);
    }

    // --- Time axis (bottom, front layer) ---
    const timeAxisY = floorY(0);
    ctx.strokeStyle = scaleLineColor;
    ctx.beginPath();
    ctx.moveTo(PAD_L, timeAxisY);
    ctx.lineTo(PAD_L + chartW, timeAxisY);
    ctx.stroke();
    const rearTimeAxisY = toY(max_temp, N - 1);
    for (let z = 1; z < N; z++) {
      ctx.beginPath();
      ctx.moveTo(toX(tStart, z), toY(max_temp, z));
      ctx.lineTo(toX(tStart, z), floorY(z));
      ctx.stroke();
    }
    for (let t = Math.ceil(min_temp / tempStep) * tempStep; t <= max_temp; t += tempStep) {
      ctx.beginPath();
      ctx.moveTo(toX(tStart, 0), toY(t, 0));
      ctx.lineTo(toX(tStart, N - 1), toY(t, N - 1));
      ctx.stroke();
    }

    const hourStep = this._hours <= 24 ? 4 : this._hours <= 48 ? 8 : 24;
    ctx.textAlign = 'center';
    ctx.fillStyle = scaleTextColor;
    const tickStart = new Date(tStart);
    tickStart.setMinutes(0, 0, 0);
    tickStart.setHours(tickStart.getHours() + hourStep);
    for (let d = new Date(tickStart); d.getTime() <= tEnd; d.setHours(d.getHours() + hourStep)) {
      const x = toX(d.getTime(), 0);
      const rearX = toX(d.getTime(), N - 1);
      ctx.strokeStyle = scaleLineColor;
      ctx.beginPath();
      ctx.moveTo(x, timeAxisY);
      ctx.lineTo(x, timeAxisY + 4);
      ctx.stroke();
      const lbl = this._hours <= 48
        ? d.getHours().toString().padStart(2, '0') + ':00'
        : `${d.getDate()}.${(d.getMonth() + 1).toString().padStart(2, '0')}.`;
      ctx.fillText(lbl, x, timeAxisY + 14);
      ctx.beginPath();
      ctx.moveTo(rearX, rearTimeAxisY);
      ctx.lineTo(rearX, floorY(N - 1));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, timeAxisY);
      ctx.lineTo(rearX, floorY(N - 1));
      ctx.stroke();
      ctx.fillText(lbl, rearX, rearTimeAxisY - 4);
    }

    // --- Sensor ribbons: draw back to front ---
    for (let z = N - 1; z >= 0; z--) {
      const entityId = sensors[z];   // z=0 → sensors[0] = sensor1 (front)
      const samples = (this._data[entityId] || []).filter(p => p.t >= tStart && p.t <= tEnd);
      if (samples.length === 0) continue

      // Home Assistant only records changes. Hold the last value through the
      // chart end so every ribbon shares the same right edge.
      const lastSample = samples[samples.length - 1];
      const series = lastSample.t < tEnd
        ? [...samples, { t: tEnd, v: lastSample.v }]
        : samples;

      const avgTemp = series.reduce((s, p) => s + p.v, 0) / series.length;
      const { r, g, b } = tempToRGB(avgTemp, min_temp, max_temp);
      const edgeColor = `rgb(${Math.round(r * 0.65)},${Math.round(g * 0.65)},${Math.round(b * 0.65)})`;

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
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fill();

      // Baseline
      ctx.beginPath();
      ctx.moveTo(xs[0], fy);
      ctx.lineTo(xs[xs.length - 1], fy);
      ctx.strokeStyle = edgeColor;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Vertical borders at the history range boundaries
      ctx.beginPath();
      ctx.moveTo(xs[0], fy);
      ctx.lineTo(xs[0], ys[0]);
      ctx.moveTo(xs[xs.length - 1], ys[ys.length - 1]);
      ctx.lineTo(xs[xs.length - 1], fy);
      ctx.stroke();

      // Top edge — one gradient stroke per ribbon
      const grad = ctx.createLinearGradient(xs[0], 0, xs[xs.length - 1], 0);
      series.forEach((p, i) => {
        const edge = tempToRGB(p.v, min_temp, max_temp);
        grad.addColorStop(
          i / (series.length - 1),
          `rgb(${Math.round(edge.r * 0.65)},${Math.round(edge.g * 0.65)},${Math.round(edge.b * 0.65)})`
        );
      });
      ctx.beginPath();
      ctx.moveTo(xs[0], ys[0]);
      for (let i = 1; i < series.length; i++) ctx.lineTo(xs[i], ys[i]);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

customElements.define('puffer-history-card', PufferHistoryCard);

const HOURS_OPTIONS = [24, 48, 168];
const HOUR_MS = 60 * 60 * 1000;

class PufferHeatmapCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hours = 24;
    this._data = null;
    this._loading = false;
  }

  setConfig(config) {
    if (!config.sensors || config.sensors.length < 1) {
      throw new Error('puffer-heatmap-card: sensors array required')
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
    const buttons = HOURS_OPTIONS.map(hours =>
      `<button class="btn${this._hours === hours ? ' active' : ''}" data-hours="${hours}">${hours < 48 ? hours + 'h' : hours / 24 + 'd'}</button>`
    ).join('');

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .controls { display: flex; align-items: center; gap: 6px; padding: 10px 16px 4px; }
        .label { font-size: 12px; color: var(--secondary-text-color, #888); margin-right: 2px; }
        .btn { padding: 3px 11px; border: 1px solid var(--divider-color, #ccc); border-radius: 12px; background: transparent; font-size: 12px; color: var(--primary-text-color, #333); cursor: pointer; }
        .btn.active { background: var(--primary-color, #03a9f4); border-color: var(--primary-color, #03a9f4); color: #fff; }
        canvas { display: block; width: 100%; height: 300px; }
      </style>
      <ha-card>
        <div class="controls"><span class="label">History:</span>${buttons}</div>
        <canvas id="chart"></canvas>
      </ha-card>`;

    this.shadowRoot.querySelectorAll('.btn').forEach(button => {
      button.addEventListener('click', () => {
        this._hours = parseInt(button.dataset.hours);
        this._render();
        if (this._hass) this._loadHistory();
      });
    });
  }

  async _loadHistory() {
    if (this._loading || !this._hass || !this._config) return
    this._loading = true;

    const { sensors } = this._config;
    const end = new Date();
    const start = new Date(end.getTime() - this._hours * HOUR_MS);

    try {
      const result = await this._hass.callApi(
        'GET',
        `history/period/${start.toISOString()}?filter_entity_id=${sensors.join(',')}&end_time=${end.toISOString()}&minimal_response=true&no_attributes=true`
      );
      this._startTime = start.getTime();
      this._endTime = end.getTime();
      this._data = {};
      sensors.forEach((entityId, index) => {
        this._data[entityId] = (result[index] || [])
          .filter(state => state.state !== 'unavailable' && state.state !== 'unknown')
          .map(state => ({ t: new Date(state.last_changed).getTime(), v: parseFloat(state.state) }))
          .filter(point => !isNaN(point.v));
      });
      this._drawChart();
    } catch (error) {
      console.error('[puffer-heatmap-card]', error);
    } finally {
      this._loading = false;
    }
  }

  _drawChart() {
    const canvas = this.shadowRoot.getElementById('chart');
    if (!canvas || !this._data) return

    const { sensors, min_temp, max_temp } = this._config;
    const width = this.offsetWidth || 400;
    const height = 300;
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    const theme = getComputedStyle(this);
    const scaleTextColor = theme.getPropertyValue('--secondary-text-color').trim() || '#888';
    const scaleLineColor = theme.getPropertyValue('--divider-color').trim() || '#ccc';

    const padLeft = 42;
    const padRight = 18;
    const padTop = 12;
    const padBottom = 36;
    const depthX = 18;
    const depthY = 18;
    const totalDepthX = Math.max(0, sensors.length - 1) * depthX;
    const totalDepthY = Math.max(0, sensors.length - 1) * depthY;
    const chartWidth = width - padLeft - padRight - totalDepthX;
    const chartHeight = height - padTop - padBottom - totalDepthY;
    if (chartWidth < 20 || chartHeight < 20) return

    const bucketHours = this._hours <= 24 ? 1 : this._hours <= 48 ? 2 : 6;
    const bucketMs = bucketHours * HOUR_MS;
    const bucketCount = Math.ceil((this._endTime - this._startTime) / bucketMs);
    const bucketWidth = chartWidth / bucketCount;
    const hourStep = this._hours <= 24 ? 4 : this._hours <= 48 ? 8 : 24;
    const values = sensors.map(entityId => Array.from({ length: bucketCount }, (_, bucket) => {
      const bucketStart = this._startTime + bucket * bucketMs;
      const bucketEnd = Math.min(bucketStart + bucketMs, this._endTime);
      return this._timeWeightedMean(this._data[entityId], bucketStart, bucketEnd)
    }));
    const vertices = values.map(series => Array.from({ length: bucketCount + 1 }, (_, boundary) => {
      if (boundary === 0) return series[0]
      if (boundary === bucketCount) return series[bucketCount - 1]
      const before = series[boundary - 1];
      const after = series[boundary];
      return before === null || after === null ? null : (before + after) / 2
    }));
    const project = (x, z, value) => ({
      x: padLeft + x * bucketWidth + z * depthX,
      y: padTop + totalDepthY + chartHeight - ((value - min_temp) / (max_temp - min_temp)) * chartHeight - z * depthY,
    });
    const edgeColor = scaleLineColor;
    const darkTempColor = temperature => {
      const { r, g, b } = tempToRGB(temperature, min_temp, max_temp);
      return `rgb(${Math.round(r * 0.65)},${Math.round(g * 0.65)},${Math.round(b * 0.65)})`
    };

    // Temperature axis at the front-left, with guides extending only along Z.
    const tempStep = chartHeight > 160 ? 10 : 20;
    const axisBottom = project(0, 0, min_temp);
    const axisTop = project(0, 0, max_temp);
    ctx.strokeStyle = scaleLineColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(axisBottom.x, axisBottom.y);
    ctx.lineTo(axisTop.x, axisTop.y);
    ctx.stroke();
    const rearLeftBottom = project(0, sensors.length - 1, min_temp);
    const rearLeftTop = project(0, sensors.length - 1, max_temp);
    ctx.beginPath();
    ctx.moveTo(rearLeftBottom.x, rearLeftBottom.y);
    ctx.lineTo(rearLeftTop.x, rearLeftTop.y);
    ctx.stroke();
    const rearEdgeBottom = project(bucketCount, sensors.length - 1, min_temp);
    const rearEdgeTop = project(bucketCount, sensors.length - 1, max_temp);
    ctx.beginPath();
    ctx.moveTo(rearEdgeBottom.x, rearEdgeBottom.y);
    ctx.lineTo(rearEdgeTop.x, rearEdgeTop.y);
    ctx.stroke();
    for (let sensor = 1; sensor < sensors.length - 1; sensor++) {
      const bottom = project(0, sensor, min_temp);
      const top = project(0, sensor, max_temp);
      ctx.beginPath();
      ctx.moveTo(bottom.x, bottom.y);
      ctx.lineTo(top.x, top.y);
      ctx.stroke();
    }
    for (let hour = hourStep; hour < this._hours; hour += hourStep) {
      const bucket = hour / bucketHours;
      const bottom = project(bucket, sensors.length - 1, min_temp);
      const top = project(bucket, sensors.length - 1, max_temp);
      ctx.beginPath();
      ctx.moveTo(bottom.x, bottom.y);
      ctx.lineTo(top.x, top.y);
      ctx.stroke();
    }
    ctx.fillStyle = scaleTextColor;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    for (let temperature = Math.ceil(min_temp / tempStep) * tempStep; temperature <= max_temp; temperature += tempStep) {
      const front = project(0, 0, temperature);
      const back = project(0, sensors.length - 1, temperature);
      ctx.strokeStyle = scaleLineColor;
      ctx.beginPath();
      ctx.moveTo(front.x, front.y);
      ctx.lineTo(back.x, back.y);
      ctx.stroke();
      const rearStart = project(0, sensors.length - 1, temperature);
      const rearEnd = project(bucketCount, sensors.length - 1, temperature);
      ctx.beginPath();
      ctx.moveTo(rearStart.x, rearStart.y);
      ctx.lineTo(rearEnd.x, rearEnd.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(front.x - 3, front.y);
      ctx.lineTo(front.x, front.y);
      ctx.stroke();
      ctx.fillText(`${temperature}°`, front.x - 5, front.y + 3);
    }

    // Front and right exterior faces turn the temperature surface into a solid.
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      const leftValue = vertices[0][bucket];
      const rightValue = vertices[0][bucket + 1];
      if (leftValue === null || rightValue === null) continue
      const leftTop = project(bucket, 0, leftValue);
      const rightTop = project(bucket + 1, 0, rightValue);
      const rightBase = project(bucket + 1, 0, min_temp);
      const leftBase = project(bucket, 0, min_temp);
      const gradient = ctx.createLinearGradient(leftBase.x, leftBase.y, rightBase.x, rightBase.y);
      gradient.addColorStop(0, tempToColor(leftValue, min_temp, max_temp));
      gradient.addColorStop(1, tempToColor(rightValue, min_temp, max_temp));
      ctx.beginPath();
      ctx.moveTo(leftTop.x, leftTop.y);
      ctx.lineTo(rightTop.x, rightTop.y);
      ctx.lineTo(rightBase.x, rightBase.y);
      ctx.lineTo(leftBase.x, leftBase.y);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    for (let sensor = 0; sensor < sensors.length - 1; sensor++) {
      const frontValue = vertices[sensor][bucketCount];
      const backValue = vertices[sensor + 1][bucketCount];
      if (frontValue === null || backValue === null) continue
      const frontTop = project(bucketCount, sensor, frontValue);
      const backTop = project(bucketCount, sensor + 1, backValue);
      const backBase = project(bucketCount, sensor + 1, min_temp);
      const frontBase = project(bucketCount, sensor, min_temp);
      const gradient = ctx.createLinearGradient(frontBase.x, frontBase.y, backBase.x, backBase.y);
      gradient.addColorStop(0, tempToColor(frontValue, min_temp, max_temp));
      gradient.addColorStop(1, tempToColor(backValue, min_temp, max_temp));
      ctx.beginPath();
      ctx.moveTo(frontTop.x, frontTop.y);
      ctx.lineTo(backTop.x, backTop.y);
      ctx.lineTo(backBase.x, backBase.y);
      ctx.lineTo(frontBase.x, frontBase.y);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    // Each hourly cell connects two sensor rows, creating an X-Z temperature surface.
    for (let sensor = sensors.length - 2; sensor >= 0; sensor--) {
      for (let bucket = 0; bucket < bucketCount; bucket++) {
        const leftFrontValue = vertices[sensor][bucket];
        const rightFrontValue = vertices[sensor][bucket + 1];
        const leftBackValue = vertices[sensor + 1][bucket];
        const rightBackValue = vertices[sensor + 1][bucket + 1];
        if ([leftFrontValue, rightFrontValue, leftBackValue, rightBackValue].includes(null)) continue
        const leftFront = project(bucket, sensor, leftFrontValue);
        const rightFront = project(bucket + 1, sensor, rightFrontValue);
        const rightBack = project(bucket + 1, sensor + 1, rightBackValue);
        const leftBack = project(bucket, sensor + 1, leftBackValue);
        const gradient = ctx.createLinearGradient(leftFront.x, leftFront.y, leftBack.x, leftBack.y);
        gradient.addColorStop(0, tempToColor(leftFrontValue, min_temp, max_temp));
        gradient.addColorStop(1, tempToColor(leftBackValue, min_temp, max_temp));
        ctx.beginPath();
        ctx.moveTo(leftFront.x, leftFront.y);
        ctx.lineTo(rightFront.x, rightFront.y);
        ctx.lineTo(rightBack.x, rightBack.y);
        ctx.lineTo(leftBack.x, leftBack.y);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();
      }
    }

    // Draw the vertical face-cell boundaries over the surface fills.
    ctx.strokeStyle = darkTempColor(min_temp);
    ctx.lineWidth = 2;
    ctx.beginPath();
    const frontBaseStart = project(0, 0, min_temp);
    const frontBaseEnd = project(bucketCount, 0, min_temp);
    ctx.moveTo(frontBaseStart.x, frontBaseStart.y);
    ctx.lineTo(frontBaseEnd.x, frontBaseEnd.y);
    ctx.stroke();
    for (let hour = 0; hour <= this._hours; hour += hourStep) {
      const bucket = hour / bucketHours;
      const value = vertices[0][bucket];
      if (value === null) continue
      const top = project(bucket, 0, value);
      const base = project(bucket, 0, min_temp);
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(base.x, base.y);
      ctx.strokeStyle = darkTempColor(value);
      ctx.stroke();
    }
    if (bucketCount % (hourStep / bucketHours) !== 0 && vertices[0][bucketCount] !== null) {
      const top = project(bucketCount, 0, vertices[0][bucketCount]);
      const base = project(bucketCount, 0, min_temp);
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(base.x, base.y);
      ctx.strokeStyle = darkTempColor(vertices[0][bucketCount]);
      ctx.stroke();
    }
    for (let sensor = 0; sensor < sensors.length - 1; sensor++) {
      const frontValue = vertices[sensor][bucketCount];
      const backValue = vertices[sensor + 1][bucketCount];
      if (frontValue === null || backValue === null) continue
      const frontTop = project(bucketCount, sensor, frontValue);
      const backTop = project(bucketCount, sensor + 1, backValue);
      const backBase = project(bucketCount, sensor + 1, min_temp);
      const frontBase = project(bucketCount, sensor, min_temp);
      ctx.beginPath();
      ctx.moveTo(frontTop.x, frontTop.y);
      ctx.lineTo(backTop.x, backTop.y);
      ctx.lineTo(backBase.x, backBase.y);
      ctx.lineTo(frontBase.x, frontBase.y);
      ctx.closePath();
      const edgeGradient = ctx.createLinearGradient(frontTop.x, frontTop.y, backTop.x, backTop.y);
      edgeGradient.addColorStop(0, darkTempColor(frontValue));
      edgeGradient.addColorStop(1, darkTempColor(backValue));
      ctx.strokeStyle = edgeGradient;
      ctx.stroke();
    }
    // Thick sensor traces use the same temperature gradient as the history graph.
    ctx.lineWidth = 2;
    for (let sensor = 0; sensor < sensors.length; sensor++) {
      const gradientStart = project(0, sensor, min_temp);
      const gradientEnd = project(bucketCount, sensor, min_temp);
      const gradient = ctx.createLinearGradient(gradientStart.x, gradientStart.y, gradientEnd.x, gradientEnd.y);
      for (let bucket = 0; bucket <= bucketCount; bucket++) {
        const value = vertices[sensor][bucket];
        gradient.addColorStop(
          bucket / bucketCount,
            value === null ? '#777' : darkTempColor(value)
        );
      }
      ctx.beginPath();
      for (let bucket = 0; bucket <= bucketCount; bucket++) {
        const value = vertices[sensor][bucket];
        if (value === null) continue
        const point = project(bucket, sensor, value);
        if (bucket === 0 || vertices[sensor][bucket - 1] === null) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      }
      ctx.strokeStyle = gradient;
      ctx.stroke();
    }

    // Outline the exposed front, left, and right edges.
    const frontGradient = ctx.createLinearGradient(
      project(0, 0, min_temp).x, project(0, 0, min_temp).y,
      project(bucketCount, 0, min_temp).x, project(bucketCount, 0, min_temp).y
    );
    for (let bucket = 0; bucket <= bucketCount; bucket++) {
      const value = vertices[0][bucket];
      frontGradient.addColorStop(bucket / bucketCount, value === null ? '#777' : darkTempColor(value));
    }
    ctx.strokeStyle = frontGradient;
    ctx.beginPath();
    for (let bucket = 0; bucket <= bucketCount; bucket++) {
      const value = vertices[0][bucket];
      if (value === null) continue
      const point = project(bucket, 0, value);
      if (bucket === 0 || vertices[0][bucket - 1] === null) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
    const frontLeftValue = vertices[0][0];
    if (frontLeftValue !== null) {
      const frontLeftTop = project(0, 0, frontLeftValue);
      const frontLeftBase = project(0, 0, min_temp);
      ctx.beginPath();
      ctx.moveTo(frontLeftTop.x, frontLeftTop.y);
      ctx.lineTo(frontLeftBase.x, frontLeftBase.y);
      ctx.strokeStyle = darkTempColor(frontLeftValue);
      ctx.stroke();
    }
    ctx.strokeStyle = edgeColor;
    ctx.beginPath();
    for (let sensor = 0; sensor < sensors.length; sensor++) {
      const value = vertices[sensor][0];
      if (value === null) continue
      const point = project(0, sensor, value);
      if (sensor === 0 || vertices[sensor - 1][0] === null) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
    const rightGradient = ctx.createLinearGradient(
      project(bucketCount, 0, min_temp).x, project(bucketCount, 0, min_temp).y,
      project(bucketCount, sensors.length - 1, min_temp).x, project(bucketCount, sensors.length - 1, min_temp).y
    );
    for (let sensor = 0; sensor < sensors.length; sensor++) {
      const value = vertices[sensor][bucketCount];
      rightGradient.addColorStop(sensor / (sensors.length - 1), value === null ? '#777' : darkTempColor(value));
    }
    ctx.strokeStyle = rightGradient;
    ctx.beginPath();
    for (let sensor = 0; sensor < sensors.length; sensor++) {
      const value = vertices[sensor][bucketCount];
      if (value === null) continue
      const point = project(bucketCount, sensor, value);
      if (sensor === 0 || vertices[sensor - 1][bucketCount] === null) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();

    ctx.lineWidth = 2;
    ctx.fillStyle = scaleTextColor;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    for (let hour = hourStep; hour < this._hours; hour += hourStep) {
      const x = padLeft + (hour / this._hours) * chartWidth;
      ctx.beginPath();
      const bucket = Math.min(hour / bucketHours, bucketCount - 1);
      const gradientStart = project(bucket, 0, min_temp);
      const gradientEnd = project(bucket, sensors.length - 1, min_temp);
      const gradient = ctx.createLinearGradient(gradientStart.x, gradientStart.y, gradientEnd.x, gradientEnd.y);
      for (let sensor = 0; sensor < sensors.length; sensor++) {
        const value = vertices[sensor][bucket];
        const stop = sensors.length === 1 ? 0 : sensor / (sensors.length - 1);
        gradient.addColorStop(stop, value === null ? '#777' : darkTempColor(value));
        if (value === null) continue
        const point = project(bucket, sensor, value);
        if (sensor === 0 || vertices[sensor - 1][bucket] === null) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      }
      if (sensors.length === 1) {
        const value = vertices[0][bucket];
        gradient.addColorStop(1, value === null ? '#777' : darkTempColor(value));
      }
      ctx.strokeStyle = gradient;
      ctx.stroke();
      const time = new Date(this._startTime + hour * HOUR_MS);
      const label = this._hours <= 48
        ? `${time.getHours().toString().padStart(2, '0')}:00`
        : `${time.getDate()}.${(time.getMonth() + 1).toString().padStart(2, '0')}.`;
      ctx.fillText(label, x, padTop + totalDepthY + chartHeight + 14);
      const rearTop = project(hour / bucketHours, sensors.length - 1, max_temp);
      ctx.fillText(label, rearTop.x, rearTop.y - 4);
    }
  }

  _timeWeightedMean(series, start, end) {
    if (series.length === 0) return null
    let current = null;
    let currentTime = start;
    let total = 0;
    let duration = 0;

    for (const point of series) {
      if (point.t <= start) current = point.v;
      else if (point.t < end) {
        if (current !== null) {
          total += current * (point.t - currentTime);
          duration += point.t - currentTime;
        }
        current = point.v;
        currentTime = point.t;
      }
    }
    if (current !== null) {
      total += current * (end - currentTime);
      duration += end - currentTime;
    }
    return duration > 0 ? total / duration : null
  }
}

customElements.define('puffer-heatmap-card', PufferHeatmapCard);

console.info(
  '%c HOME-ASSISTANT-CARDS %c puffer-card loaded',
  'background:#0d47a1;color:#fff;padding:2px 6px;border-radius:3px 0 0 3px',
  'background:#1565c0;color:#fff;padding:2px 6px;border-radius:0 3px 3px 0'
);
