import { tempToColor } from './temperature-color.js'

const HOURS_OPTIONS = [24, 48, 168]
const BUCKET_MS = 60 * 60 * 1000

class PufferHeatmapCard extends HTMLElement {
  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
    this._hours = 24
    this._data = null
    this._loading = false
  }

  setConfig(config) {
    if (!config.sensors || config.sensors.length < 1) {
      throw new Error('puffer-heatmap-card: sensors array required')
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
    const buttons = HOURS_OPTIONS.map(hours =>
      `<button class="btn${this._hours === hours ? ' active' : ''}" data-hours="${hours}">${hours < 48 ? hours + 'h' : hours / 24 + 'd'}</button>`
    ).join('')

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
      </ha-card>`

    this.shadowRoot.querySelectorAll('.btn').forEach(button => {
      button.addEventListener('click', () => {
        this._hours = parseInt(button.dataset.hours)
        this._render()
        if (this._hass) this._loadHistory()
      })
    })
  }

  async _loadHistory() {
    if (this._loading || !this._hass || !this._config) return
    this._loading = true

    const { sensors } = this._config
    const end = new Date()
    const start = new Date(end.getTime() - this._hours * BUCKET_MS)

    try {
      const result = await this._hass.callApi(
        'GET',
        `history/period/${start.toISOString()}?filter_entity_id=${sensors.join(',')}&end_time=${end.toISOString()}&minimal_response=true&no_attributes=true`
      )
      this._startTime = start.getTime()
      this._endTime = end.getTime()
      this._data = {}
      sensors.forEach((entityId, index) => {
        this._data[entityId] = (result[index] || [])
          .filter(state => state.state !== 'unavailable' && state.state !== 'unknown')
          .map(state => ({ t: new Date(state.last_changed).getTime(), v: parseFloat(state.state) }))
          .filter(point => !isNaN(point.v))
      })
      this._drawChart()
    } catch (error) {
      console.error('[puffer-heatmap-card]', error)
    } finally {
      this._loading = false
    }
  }

  _drawChart() {
    const canvas = this.shadowRoot.getElementById('chart')
    if (!canvas || !this._data) return

    const { sensors, min_temp, max_temp } = this._config
    const width = this.offsetWidth || 400
    const height = 300
    canvas.width = width
    canvas.height = height

    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, width, height)

    const padLeft = 42
    const padRight = 18
    const padTop = 12
    const padBottom = 36
    const depthX = 18
    const depthY = 18
    const totalDepthX = Math.max(0, sensors.length - 1) * depthX
    const totalDepthY = Math.max(0, sensors.length - 1) * depthY
    const chartWidth = width - padLeft - padRight - totalDepthX
    const chartHeight = height - padTop - padBottom - totalDepthY
    if (chartWidth < 20 || chartHeight < 20) return

    const bucketCount = Math.ceil((this._endTime - this._startTime) / BUCKET_MS)
    const bucketWidth = chartWidth / bucketCount
    const values = sensors.map(entityId => Array.from({ length: bucketCount }, (_, bucket) => {
      const bucketStart = this._startTime + bucket * BUCKET_MS
      const bucketEnd = Math.min(bucketStart + BUCKET_MS, this._endTime)
      return this._timeWeightedMean(this._data[entityId], bucketStart, bucketEnd)
    }))
    const vertices = values.map(series => Array.from({ length: bucketCount + 1 }, (_, boundary) => {
      if (boundary === 0) return series[0]
      if (boundary === bucketCount) return series[bucketCount - 1]
      const before = series[boundary - 1]
      const after = series[boundary]
      return before === null || after === null ? null : (before + after) / 2
    }))
    const project = (x, z, value) => ({
      x: padLeft + x * bucketWidth + z * depthX,
      y: padTop + totalDepthY + chartHeight - ((value - min_temp) / (max_temp - min_temp)) * chartHeight - z * depthY,
    })

    // Each hourly cell connects two sensor rows, creating an X-Z temperature surface.
    for (let sensor = sensors.length - 2; sensor >= 0; sensor--) {
      for (let bucket = 0; bucket < bucketCount; bucket++) {
        const leftFrontValue = vertices[sensor][bucket]
        const rightFrontValue = vertices[sensor][bucket + 1]
        const leftBackValue = vertices[sensor + 1][bucket]
        const rightBackValue = vertices[sensor + 1][bucket + 1]
        if ([leftFrontValue, rightFrontValue, leftBackValue, rightBackValue].includes(null)) continue
        const leftFront = project(bucket, sensor, leftFrontValue)
        const rightFront = project(bucket + 1, sensor, rightFrontValue)
        const rightBack = project(bucket + 1, sensor + 1, rightBackValue)
        const leftBack = project(bucket, sensor + 1, leftBackValue)
        const gradient = ctx.createLinearGradient(leftFront.x, leftFront.y, leftBack.x, leftBack.y)
        gradient.addColorStop(0, tempToColor(leftFrontValue, min_temp, max_temp))
        gradient.addColorStop(1, tempToColor(leftBackValue, min_temp, max_temp))
        ctx.beginPath()
        ctx.moveTo(leftFront.x, leftFront.y)
        ctx.lineTo(rightFront.x, rightFront.y)
        ctx.lineTo(rightBack.x, rightBack.y)
        ctx.lineTo(leftBack.x, leftBack.y)
        ctx.closePath()
        ctx.fillStyle = gradient
        ctx.fill()
      }
    }

    // Grid lines along both the time and sensor axes make the surface readable.
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'
    ctx.lineWidth = 2
    for (let sensor = 0; sensor < sensors.length; sensor++) {
      ctx.beginPath()
      for (let bucket = 0; bucket <= bucketCount; bucket++) {
        const value = vertices[sensor][bucket]
        if (value === null) continue
        const point = project(bucket, sensor, value)
        if (bucket === 0 || vertices[sensor][bucket - 1] === null) ctx.moveTo(point.x, point.y)
        else ctx.lineTo(point.x, point.y)
      }
      ctx.stroke()
    }

    const hourStep = this._hours <= 24 ? 4 : this._hours <= 48 ? 8 : 24
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'
    ctx.fillStyle = 'rgba(0,0,0,0.65)'
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'center'
    for (let hour = hourStep; hour < this._hours; hour += hourStep) {
      const x = padLeft + (hour / this._hours) * chartWidth
      ctx.beginPath()
      const bucket = Math.min(hour, bucketCount - 1)
      for (let sensor = 0; sensor < sensors.length; sensor++) {
        const value = vertices[sensor][bucket]
        if (value === null) continue
        const point = project(bucket, sensor, value)
        if (sensor === 0 || vertices[sensor - 1][bucket] === null) ctx.moveTo(point.x, point.y)
        else ctx.lineTo(point.x, point.y)
      }
      ctx.stroke()
      const time = new Date(this._startTime + hour * BUCKET_MS)
      const label = this._hours <= 48
        ? `${time.getHours().toString().padStart(2, '0')}:00`
        : `${time.getDate()}.${(time.getMonth() + 1).toString().padStart(2, '0')}.`
      ctx.fillText(label, x, padTop + totalDepthY + chartHeight + 14)
    }
  }

  _timeWeightedMean(series, start, end) {
    if (series.length === 0) return null
    let current = null
    let currentTime = start
    let total = 0
    let duration = 0

    for (const point of series) {
      if (point.t <= start) current = point.v
      else if (point.t < end) {
        if (current !== null) {
          total += current * (point.t - currentTime)
          duration += point.t - currentTime
        }
        current = point.v
        currentTime = point.t
      }
    }
    if (current !== null) {
      total += current * (end - currentTime)
      duration += end - currentTime
    }
    return duration > 0 ? total / duration : null
  }
}

customElements.define('puffer-heatmap-card', PufferHeatmapCard)