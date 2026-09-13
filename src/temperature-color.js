// Colour scale from cold (20°C) to hot (95°C)
const STOPS = [
  { t: 20, r:  13, g:  71, b: 161 }, // #0d47a1
  { t: 40, r:   0, g: 172, b: 193 }, // #00acc1
  { t: 60, r: 124, g: 179, b:  66 }, // #7cb342
  { t: 80, r: 251, g: 140, b:   0 }, // #fb8c00
  { t: 95, r: 183, g:  28, b:  28 }, // #b71c1c
]

export function tempToRGB(temp, minTemp = 20, maxTemp = 95) {
  const t = Math.max(minTemp, Math.min(maxTemp, temp))
  if (t <= STOPS[0].t) return { ...STOPS[0] }
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (t <= STOPS[i + 1].t) {
      const s = STOPS[i], e = STOPS[i + 1]
      const f = (t - s.t) / (e.t - s.t)
      return {
        r: Math.round(s.r + (e.r - s.r) * f),
        g: Math.round(s.g + (e.g - s.g) * f),
        b: Math.round(s.b + (e.b - s.b) * f),
      }
    }
  }
  return { ...STOPS[STOPS.length - 1] }
}

export function tempToColor(temp, minTemp = 20, maxTemp = 95, alpha = 1) {
  const { r, g, b } = tempToRGB(temp, minTemp, maxTemp)
  return alpha === 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`
}

export function tempToHex(temp, minTemp = 20, maxTemp = 95) {
  const { r, g, b } = tempToRGB(temp, minTemp, maxTemp)
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')
}
