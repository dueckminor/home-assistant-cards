import { tempToColor } from './temperature-color.js'

class PufferStateCard extends HTMLElement {
  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
  }

  setConfig(config) {
    if (!config.sensors || config.sensors.length < 1) {
      throw new Error('puffer-state-card: sensors array required')
    }
    this._config = { min_temp: 20, max_temp: 95, ...config }
    this._render()
  }

  set hass(hass) {
    this._hass = hass
    this._update()
  }

  _render() {
    const { sensors } = this._config
    // Rows are rendered top-to-bottom = sensor N (hottest) down to sensor 1 (coldest)
    const rows = [...sensors].reverse().map((entityId, i) => {
      const idx = sensors.length - 1 - i
      return `
        <div class="row" id="row-${idx}">
          <div class="color-bar" id="bar-${idx}"></div>
          <div class="temp" id="temp-${idx}">–</div>
        </div>`
    }).join('')

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
      </ha-card>`
  }

  _update() {
    if (!this._hass || !this._config) return
    const { sensors, min_temp, max_temp } = this._config

    const temps = sensors.map(id => {
      const s = this._hass.states[id]
      if (!s) return null
      const v = parseFloat(s.state)
      return isNaN(v) ? null : v
    })

    temps.forEach((t, i) => {
      const bar  = this.shadowRoot.getElementById(`bar-${i}`)
      const tempEl = this.shadowRoot.getElementById(`temp-${i}`)
      if (bar) bar.style.backgroundColor = t !== null ? tempToColor(t, min_temp, max_temp) : '#bbb'
      if (tempEl) tempEl.textContent = t !== null ? `${t.toFixed(1)} °C` : '–'
    })

    // Smooth CSS gradient on the tank visual (sensor 0 = bottom, N-1 = top)
    const gradEl = this.shadowRoot.getElementById('gradient')
    if (gradEl && temps.length > 0) {
      const stops = temps.map((t, i) => {
        const pct = (i / (temps.length - 1)) * 100
        return `${t !== null ? tempToColor(t, min_temp, max_temp) : '#bbb'} ${pct.toFixed(0)}%`
      }).join(', ')
      gradEl.style.background = `linear-gradient(to top, ${stops})`
    }
  }
}

customElements.define('puffer-state-card', PufferStateCard)
