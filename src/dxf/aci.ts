// AutoCAD Color Index → CSS hex. 1-9 and 250-255 are exact; 10-249 follow the standard
// hue/value/saturation pattern closely enough to tell layers apart.
const BASE: Record<number, string> = {
  1: "#ff0000",
  2: "#ffff00",
  3: "#00ff00",
  4: "#00ffff",
  5: "#0000ff",
  6: "#ff00ff",
  7: "#000000", // white/black: shown as black on the light canvas
  8: "#808080",
  9: "#c0c0c0",
  250: "#333333",
  251: "#505050",
  252: "#696969",
  253: "#828282",
  254: "#bebebe",
  255: "#ffffff",
};

const VALUES = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5, 0.3, 0.3];

function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return `#${[f(5), f(3), f(1)].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function aciToHex(aci: number): string {
  if (BASE[aci]) return BASE[aci]!;
  if (aci >= 10 && aci <= 249) {
    const hue = Math.floor((aci - 10) / 10) * 15;
    const variant = aci % 10;
    return hsvToHex(hue, variant % 2 === 0 ? 1 : 0.5, VALUES[variant]!);
  }
  return "#000000";
}
