import * as THREE from "three";
import type { ExpressionTarget } from "./expressions";

export const SCREEN_W = 512;
export const SCREEN_H = 256;

const EYE = "#fffaf0";
const EYE_SCALE = 1.25;
const EYE_Y = 112;
const MOUTH_Y = 193;
const GLOW = "rgba(255,236,190,0.85)";

function makeCanvas(w = SCREEN_W, h = SCREEN_H) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function gradientLayer(stops: [string, string, string]) {
  const c = makeCanvas();
  const g = c.getContext("2d")!;
  const gr = g.createLinearGradient(40, 30, 470, 230);
  gr.addColorStop(0, stops[0]);
  gr.addColorStop(0.5, stops[1]);
  gr.addColorStop(1, stops[2]);
  g.fillStyle = gr;
  g.fillRect(0, 0, SCREEN_W, SCREEN_H);
  return c;
}

/** Feathered rounded rect multiplied by a staggered halftone dot grid. Rendered once. */
function makeMask() {
  const c = makeCanvas();
  const g = c.getContext("2d")!;
  g.shadowColor = "#fff";
  g.shadowBlur = 26;
  g.shadowOffsetX = 1000;
  g.fillStyle = "#fff";
  g.beginPath();
  g.roundRect(34 - 1000, 38, 444, 180, 72);
  g.fill();
  g.shadowColor = "transparent";
  g.shadowBlur = 0;
  g.shadowOffsetX = 0;

  const dots = makeCanvas();
  const d = dots.getContext("2d")!;
  const rg = d.createRadialGradient(256, 128, 10, 256, 128, 250);
  rg.addColorStop(0, "rgba(255,255,255,0.5)");
  rg.addColorStop(1, "rgba(255,255,255,0.12)");
  d.fillStyle = rg;
  d.fillRect(0, 0, SCREEN_W, SCREEN_H);
  d.fillStyle = "#fff";
  const pitch = 8;
  for (let y = 0, row = 0; y < SCREEN_H + pitch; y += pitch * 0.866, row++) {
    for (let x = (row % 2) * (pitch / 2); x < SCREEN_W + pitch; x += pitch) {
      d.beginPath();
      d.arc(x, y, 2.9, 0, Math.PI * 2);
      d.fill();
    }
  }
  g.globalCompositeOperation = "destination-in";
  g.drawImage(dots, 0, 0);
  g.globalCompositeOperation = "source-over";
  return c;
}

function makeScanBand() {
  const c = makeCanvas(SCREEN_W, 48);
  const g = c.getContext("2d")!;
  const gr = g.createLinearGradient(0, 0, 0, 48);
  gr.addColorStop(0, "rgba(255,255,255,0)");
  gr.addColorStop(0.5, "rgba(255,250,235,0.55)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, SCREEN_W, 48);
  return c;
}

interface EyeView {
  w: number; h: number; r: number; t: number;
  b: number; ba: number; bl: number; by: number; bc: number;
}

/**
 * The face screen: pre-rendered layers + a per-redraw composite of the current
 * expression. The only per-draw cost is 2D canvas work; nothing is allocated.
 */
export function createScreen() {
  const canvas = makeCanvas();
  const ctx = canvas.getContext("2d")!;
  const layers = [
    gradientLayer(["#7ee0b0", "#f5e58a", "#f7a65a"]),
    gradientLayer(["#34d399", "#86efac", "#d9f99d"]),
    gradientLayer(["#fb7185", "#fda4af", "#fdba74"]),
  ];
  const mask = makeMask();
  const band = makeScanBand();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const eye: EyeView = { w: 0, h: 0, r: 0, t: 0, b: 0, ba: 0, bl: 0, by: 0, bc: 0 };

  function drawEye(cx: number, cy: number, v: EyeView, p: ExpressionTarget) {
    const other = Math.max(Math.abs(p.arc), p.cross, p.chev);
    const rectA = Math.max(0, 1 - other * 1.15);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(EYE_SCALE, EYE_SCALE);
    ctx.shadowColor = GLOW;
    ctx.shadowBlur = 18;
    ctx.fillStyle = EYE;
    ctx.strokeStyle = EYE;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (rectA > 0.01) {
      const h = Math.max(6, v.h * (1 - p.lid));
      const w = Math.max(v.w, 6);
      ctx.save();
      ctx.rotate(v.t);
      ctx.globalAlpha = rectA;
      ctx.beginPath();
      ctx.roundRect(-w / 2, -h / 2, w, h, (v.r * Math.min(w, h)) / 2);
      ctx.fill();
      ctx.restore();
    }

    if (Math.abs(p.arc) > 0.01) {
      ctx.globalAlpha = Math.min(1, Math.abs(p.arc) * 1.1);
      ctx.lineWidth = 11;
      const half = p.aw / 2;
      ctx.beginPath();
      ctx.moveTo(-half, p.arc > 0 ? -6 : 8);
      ctx.quadraticCurveTo(0, p.arc > 0 ? 26 : -24, half, p.arc > 0 ? -6 : 8);
      ctx.stroke();
    }

    if (p.cross > 0.01) {
      ctx.globalAlpha = Math.min(1, p.cross);
      ctx.lineWidth = 11;
      const s = p.cs;
      ctx.beginPath();
      ctx.moveTo(-s, -s);
      ctx.lineTo(s, s);
      ctx.moveTo(s, -s);
      ctx.lineTo(-s, s);
      ctx.stroke();
    }

    if (p.chev > 0.01) {
      ctx.globalAlpha = Math.min(1, p.chev);
      ctx.lineWidth = 11;
      const s = p.cs;
      const d = cx < SCREEN_W / 2 ? 1 : -1; // ">" on the left eye, "<" on the right
      ctx.beginPath();
      ctx.moveTo(-s * d, -s);
      ctx.lineTo(s * d, 0);
      ctx.lineTo(-s * d, s);
      ctx.stroke();
    }

    if (v.b > 0.01) {
      ctx.globalAlpha = Math.min(1, v.b);
      ctx.lineWidth = 9;
      ctx.translate(0, -(v.h / 2) - v.by);
      ctx.rotate(v.ba);
      ctx.beginPath();
      ctx.moveTo(-v.bl / 2, 0);
      ctx.quadraticCurveTo(0, -v.bc * v.bl * 0.55, v.bl / 2, 0);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawMouth(p: ExpressionTarget) {
    if (p.mouthV < 0.02) return;
    ctx.save();
    ctx.translate(256 + p.ox * 0.5, MOUTH_Y + p.oy * 0.5);
    ctx.shadowColor = GLOW;
    ctx.shadowBlur = 16;
    ctx.fillStyle = EYE;
    ctx.strokeStyle = EYE;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const w = p.mouthW;
    const cap = Math.min(1, Math.max(0, (p.mouthOpen - 2) / 6));
    const base = Math.min(1, p.mouthV);
    if (cap > 0.01) {
      ctx.globalAlpha = base * cap;
      const h = Math.max(p.mouthOpen, 6);
      ctx.beginPath();
      ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) / 2);
      ctx.fill();
    }
    const line = base * (1 - cap);
    ctx.lineWidth = 9;
    const wave = Math.min(1, p.mouthWave);
    if (line * (1 - wave) > 0.01) {
      ctx.globalAlpha = line * (1 - wave);
      ctx.beginPath();
      ctx.moveTo(-w / 2, -2);
      ctx.quadraticCurveTo(0, -2 + p.mouthCurve * 18, w / 2, -2);
      ctx.stroke();
    }
    if (line * wave > 0.01) {
      ctx.globalAlpha = line * wave;
      ctx.beginPath();
      for (let k = 0; k <= 12; k++) {
        const x = -w / 2 + (w * k) / 12;
        const y = (k % 2 ? 1 : -1) * 4;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /** scan: 0..1 vertical position of the scanline band, or <0 for none. */
  function draw(p: ExpressionTarget, scan: number) {
    ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(layers[0], 0, 0);
    if (p.mint > 0.01) {
      ctx.globalAlpha = Math.min(1, p.mint);
      ctx.drawImage(layers[1], 0, 0);
    }
    if (p.rose > 0.01) {
      ctx.globalAlpha = Math.min(1, p.rose);
      ctx.drawImage(layers[2], 0, 0);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(mask, 0, 0);
    if (scan >= 0) {
      ctx.globalCompositeOperation = "source-atop";
      ctx.drawImage(band, 0, 40 + scan * 180 - 24);
    }
    ctx.globalCompositeOperation = "source-over";

    const cy = EYE_Y + p.oy;
    const gx = p.gx * 22 + p.ox;
    const gy = p.gy * 12;

    eye.w = p.wL; eye.h = p.hL; eye.r = p.rL; eye.t = p.tL;
    eye.b = p.bL; eye.ba = p.baL; eye.bl = p.blL; eye.by = p.byL; eye.bc = p.bcL;
    drawEye(256 - (p.gap * EYE_SCALE) / 2 + gx, cy + gy, eye, p);

    eye.w = p.wR; eye.h = p.hR; eye.r = p.rR; eye.t = p.tR;
    eye.b = p.bR; eye.ba = p.baR; eye.bl = p.blR; eye.by = p.byR; eye.bc = p.bcR;
    drawEye(256 + (p.gap * EYE_SCALE) / 2 + gx, cy + gy, eye, p);

    drawMouth(p);
    ctx.globalAlpha = 1;
    texture.needsUpdate = true;
  }

  function dispose() {
    texture.dispose();
  }

  return { canvas, texture, draw, dispose };
}
