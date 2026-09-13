import { tempToColor, tempToRGB } from './temperature-color.js'

const HOURS_OPTIONS = [24, 48, 168]

class PufferHistoryCard extends HTMLElement {
  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
    this._hours = 24
    this._data = null
    this._loading = false
  }

  setConfig(config) {
    if (!config.sensors || config.sensors.length < 1) {
      throw new Error('puffer-history-card: sensors array required')
    }
    this._config = { min_temp: 20, max_temp: 95, ...config }
    this._render()
    if (this._hass) this._loadHistory()
  }

  set hass(hass) {
    const first = !this._hass
    this._hass = hass
    if (first) this._loadHistory()
  }

  connectedCallback() {
    this._ro = new ResizeObserver(() => this._drawChart())
    this._ro.observe(this)
  }

  disconnectedCallback() {
    if (this._ro) { this._ro.disconnect(); this._ro = null }
  }

  _render() {
    const buttons = HOURS_OPTIONS.map(h =>
      `<button class="btn${this._hours === h ? ' active' : ''}" data-hours="${h}">${h < 48 ? h + 'h' : h / 24 + 'd'}</button>`
    ).join('')

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
      </ha-card>`

    this.shadowRoot.querySelectorAll('.btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._hours = parseInt(btn.dataset.hours)
        this._render()
        if (this._hass) this._loadHistory()
      })
    })
  }

  async _loadHistory() {
    if (this._loading || !this._hass || !this._config) return
    this._loading = true

    const { sensors } = this._config
    const now = new Date()
    const start = new Date(now.getTime() - this._hours * 3600 * 1000)

    try {
      const result = await this._hass.callApi(
        'GET',
        `history/period/${start.toISOString()}` +
        `?filter_entity_id=${sensors.join(',')}` +
        `&end_time=${now.toISOString()}&minimal_response=true&no_attributes=true`
      )

      this._startTime = start.getTime()
      this._endTime   = now.getTime()
      this._data = {}

      sensors.forEach((entityId, i) => {
        this._data[entityId] = (result[i] || [])
          .filter(s => s.state !== 'unavailable' && s.state !== 'unknown')
          .map(s => ({ t: new Date(s.last_changed).getTime(), v: parseFloat(s.state) }))
          .filter(p => !isNaN(p.v))
      })

      this._drawChart()
    } catch (e) {
      console.error('[puffer-history-card]', e)
    } finally {
      this._loading = false
    }
  }

  _drawChart() {
    const canvas = this.shadowRoot.getElementById('chart')
    if (!canvas || !this._data) return

    const { sensors, min_temp, max_temp } = this._config
    const N = sensors.length

    const W = this.offsetWidth || 400
    const H = 300
    canvas.width  = W
    canvas.height = H

    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, W, H)

    // Padding (room for axes and depth layers above/right)
    const PAD_L = 42
    const PAD_R = 18
    const PAD_T = 12
    const PAD_B = 36

    // Isometric depth: each layer back shifts right and up
    const DEPTH_X = 22  // px per layer (right)
    const DEPTH_Y = 11  // px per layer (up = negative screen y)
    const totalDX = (N - 1) * DEPTH_X
    const totalDY = (N - 1) * DEPTH_Y

    // Chart area for the front layer (sensor 1)
    const chartW = W - PAD_L - PAD_R - totalDX
    const chartH = H - PAD_T - PAD_B - totalDY
    if (chartW < 20 || chartH < 20) return

    const tStart = this._startTime
    const tEnd   = this._endTime

    // Map helpers — z=0 is front (sensor 1), z=N-1 is back (sensor N)
    const toX = (t, z) => PAD_L + ((t - tStart) / (tEnd - tStart)) * chartW + z * DEPTH_X
    const toY = (v, z) => PAD_T + totalDY + chartH - ((v - min_temp) / (max_temp - min_temp)) * chartH - z * DEPTH_Y
    const floorY = z => PAD_T + totalDY + chartH - z * DEPTH_Y

    // --- Temperature axis (left, front layer) ---
    const tempStep = chartH > 160 ? 10 : 20
    ctx.strokeStyle = 'rgba(0,0,0,0.12)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(PAD_L, PAD_T + totalDY)
    ctx.lineTo(PAD_L, floorY(0))
    ctx.stroke()

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'right'
    for (let t = Math.ceil(min_temp / tempStep) * tempStep; t <= max_temp; t += tempStep) {
      const y = toY(t, 0)
      ctx.strokeStyle = 'rgba(0,0,0,0.06)'
      ctx.beginPath()
      ctx.moveTo(PAD_L, y)
      ctx.lineTo(PAD_L + chartW, y)
      ctx.stroke()
      ctx.strokeStyle = 'rgba(0,0,0,0.12)'
      ctx.beginPath()
      ctx.moveTo(PAD_L - 3, y)
      ctx.lineTo(PAD_L, y)
      ctx.stroke()
      ctx.fillText(`${t}°`, PAD_L - 5, y + 3)
    }

    // --- Time axis (bottom, front layer) ---
    const timeAxisY = floorY(0)
    ctx.strokeStyle = 'rgba(0,0,0,0.12)'
    ctx.beginPath()
    ctx.moveTo(PAD_L, timeAxisY)
    ctx.lineTo(PAD_L + chartW, timeAxisY)
    ctx.stroke()

    const hourStep = this._hours <= 24 ? 4 : this._hours <= 48 ? 8 : 24
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    const tickStart = new Date(tStart)
    tickStart.setMinutes(0, 0, 0)
    tickStart.setHours(tickStart.getHours() + hourStep)
    for (let d = new Date(tickStart); d.getTime() <= tEnd; d.setHours(d.getHours() + hourStep)) {
      const x = toX(d.getTime(), 0)
      ctx.strokeStyle = 'rgba(0,0,0,0.12)'
      ctx.beginPath()
      ctx.moveTo(x, timeAxisY)
      ctx.lineTo(x, timeAxisY + 4)
      ctx.stroke()
      const lbl = this._hours <= 48
        ? d.getHours().toString().padStart(2, '0') + ':00'
        : `${d.getDate()}.${(d.getMonth() + 1).toString().padStart(2, '0')}.`
      ctx.fillText(lbl, x, timeAxisY + 14)
    }

    // --- Sensor ribbons: draw back to front ---
    for (let z = N - 1; z >= 0; z--) {
      const entityId = sensors[z]   // z=0 → sensors[0] = sensor1 (front)
      const samples = (this._data[entityId] || []).filter(p => p.t >= tStart && p.t <= tEnd)
      if (samples.length === 0) continue

      // Home Assistant only records changes. Hold the last value through the
      // chart end so every ribbon shares the same right edge.
      const lastSample = samples[samples.length - 1]
      const series = lastSample.t < tEnd
        ? [...samples, { t: tEnd, v: lastSample.v }]
        : samples

      const avgTemp = series.reduce((s, p) => s + p.v, 0) / series.length
      const { r, g, b } = tempToRGB(avgTemp, min_temp, max_temp)
      const edgeColor = `rgb(${Math.round(r * 0.65)},${Math.round(g * 0.65)},${Math.round(b * 0.65)})`

      const xs = series.map(p => toX(p.t, z))
      const ys = series.map(p => toY(p.v, z))
      const fy = floorY(z)

      // Filled ribbon area
      ctx.beginPath()
      ctx.moveTo(xs[0], fy)
      ctx.lineTo(xs[0], ys[0])
      for (let i = 1; i < series.length; i++) ctx.lineTo(xs[i], ys[i])
      ctx.lineTo(xs[xs.length - 1], fy)
      ctx.closePath()
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fill()

      // Baseline
      ctx.beginPath()
      ctx.moveTo(xs[0], fy)
      ctx.lineTo(xs[xs.length - 1], fy)
      ctx.strokeStyle = edgeColor
      ctx.lineWidth = 1
      ctx.stroke()

      // Vertical borders at the history range boundaries
      ctx.beginPath()
      ctx.moveTo(xs[0], fy)
      ctx.lineTo(xs[0], ys[0])
      ctx.moveTo(xs[xs.length - 1], ys[ys.length - 1])
      ctx.lineTo(xs[xs.length - 1], fy)
      ctx.stroke()

      // Top edge — one gradient stroke per ribbon
      const grad = ctx.createLinearGradient(xs[0], 0, xs[xs.length - 1], 0)
      series.forEach((p, i) => {
        const edge = tempToRGB(p.v, min_temp, max_temp)
        grad.addColorStop(
          i / (series.length - 1),
          `rgb(${Math.round(edge.r * 0.65)},${Math.round(edge.g * 0.65)},${Math.round(edge.b * 0.65)})`
        )
      })
      ctx.beginPath()
      ctx.moveTo(xs[0], ys[0])
      for (let i = 1; i < series.length; i++) ctx.lineTo(xs[i], ys[i])
      ctx.strokeStyle = grad
      ctx.lineWidth = 2
      ctx.stroke()
    }
  }
}

customElements.define('puffer-history-card', PufferHistoryCard)
