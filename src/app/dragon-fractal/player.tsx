"use client";

import { useEffect, useRef, useState } from "react";
import Stats from "stats.js";
import { Pane } from "tweakpane";
import fragmentSource from "./curly_dragon_zoom.frag";

const VERTEX_SRC = `#version 300 es
uniform vec2  u_resolution;
uniform float u_scale;
uniform vec2  u_position;
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  float aspect = u_resolution.x / u_resolution.y;
  v_uv = p * u_scale + 0.5 * (1.0 - u_scale)
       - vec2(u_position.x / aspect, u_position.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FRAGMENT_PRELUDE = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 u_resolution;
uniform sampler2D u_heatMap;
uniform float u_time;
uniform float u_scale;
uniform vec2 u_position;
in vec2 v_uv;
out vec4 fragColor;
`;

// Screen-space heat. The pointer paints a spot; what it leaves behind cools
// and spreads. The dragon shader only samples the resulting field.
const HEAT_VERTEX_SRC = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const HEAT_FRAGMENT_SRC = `#version 300 es
precision highp float;
uniform sampler2D u_prev;
uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform float u_dt;
uniform float u_deposit;
uniform float u_heatRadius;
uniform float u_heatDissipate;
uniform float u_heatSpread;
in vec2 v_uv;
out vec4 fragColor;

void main() {
  // Spread is a blur radius in pixels at 60fps, scaled so it stays put
  // when the frame time changes. Five taps cover the gaussian.
  float blur = max(u_heatSpread, 0.0) * u_dt * 60.0;
  vec2 texel = 1.0 / u_resolution;
  float acc = 0.0;
  float wsum = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      float d2 = float(i * i + j * j);
      float w = exp(-d2 * 0.5);
      vec2 uv = v_uv + vec2(float(i), float(j)) * blur * texel;
      acc += texture(u_prev, uv).r * w;
      wsum += w;
    }
  }
  float heat = (acc / wsum) * exp(-u_dt * max(u_heatDissipate, 0.0));
  if (u_deposit > 0.5) {
    vec2 px = v_uv * u_resolution;
    float radius = max(u_heatRadius * min(u_resolution.x, u_resolution.y), 1.0);
    float dist = length(px - u_mouse) / radius;
    float brush = exp(-dist * dist * 2.2);
    brush *= 1.0 - smoothstep(0.72, 1.0, dist);
    heat = max(heat, brush);
  }
  fragColor = vec4(clamp(heat, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

const CONTRACT_REDECLARE =
  /^\s*uniform\s+\w+\s+u_(?:resolution|heatMap|time|scale|position)\s*;.*$/gm;

const RESERVED = new Set([
  "u_resolution",
  "u_heatMap",
  "u_time",
  "u_scale",
  "u_position",
]);

type ShaderControl =
  | {
      kind: "float";
      name: string;
      section: string;
      min: number;
      max: number;
      value: number;
    }
  | {
      kind: "color";
      name: string;
      section: string;
      value: string;
    };

type ShaderParams = Record<string, number | string>;

const NO_DEFINES: ReadonlySet<string> = new Set();

// Shader comments are the tweak contract: `min, max, default`, or `color #rrggbb`.
// `#ifdef` / `#ifndef` branches follow the same defines the shader is compiled with.
function shaderControls(
  source: string,
  defines: ReadonlySet<string> = NO_DEFINES,
): ShaderControl[] {
  const controls: ShaderControl[] = [];
  let section = "Shader";
  const stack: { parent: boolean; active: boolean }[] = [
    { parent: true, active: true },
  ];
  const taking = () => stack[stack.length - 1]?.active ?? true;
  for (const line of source.split("\n")) {
    const branch = line.match(/^\s*#\s*if(n)?def\s+([A-Za-z_]\w*)/);
    if (branch) {
      const parent = taking();
      const defined = defines.has(branch[2]);
      const cond = branch[1] ? !defined : defined;
      stack.push({ parent, active: parent && cond });
      continue;
    }
    if (/^\s*#\s*else\b/.test(line)) {
      const frame = stack[stack.length - 1];
      if (frame && stack.length > 1) {
        frame.active = frame.parent && !frame.active;
      }
      continue;
    }
    if (/^\s*#\s*endif\b/.test(line)) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (!taking()) continue;
    const heading = line.match(/^\s*\/\/\s*-+\s*(.+?)\s*-+\s*$/);
    if (heading) {
      section = heading[1];
      continue;
    }
    const uniform = line.match(
      /^\s*uniform\s+(\w+)\s+(\w+)\s*;\s*\/\/\s*(.*)$/,
    );
    if (!uniform) continue;
    const [, type, name, comment] = uniform;
    if (RESERVED.has(name)) continue;
    if (type === "vec3") {
      const hex = comment.match(/#([0-9a-fA-F]{6})\b/);
      if (!hex) continue;
      controls.push({
        kind: "color",
        name,
        section,
        value: `#${hex[1]}`,
      });
      continue;
    }
    if (type !== "float") continue;
    const nums = comment.match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
    if (nums.length < 2) continue;
    controls.push({
      kind: "float",
      name,
      section,
      min: nums[0],
      max: nums[1],
      value: nums[2] ?? (nums[0] + nums[1]) / 2,
    });
  }
  return controls;
}

function controlLabel(name: string) {
  const words = name
    .replace(/^u_/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d+)/g, "$1 $2");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function controlStep(min: number, max: number) {
  const span = Math.abs(max - min);
  if (span >= 10) return 0.1;
  if (span >= 1) return 0.01;
  return 0.001;
}

function hexToVec3(hex: string): [number, number, number] | null {
  const match = hex.match(/#?([0-9a-fA-F]{6})\b/);
  if (!match) return null;
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function formatFloat(value: number) {
  const text = value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return text.includes(".") ? text : `${text}.0`;
}

function formatColor(value: string) {
  const match = value.match(/#?([0-9a-fA-F]{6})\b/);
  return match ? `#${match[1].toLowerCase()}` : value;
}

function exportControls(controls: ShaderControl[], params: ShaderParams) {
  const rows = controls.map((control) => {
    const current = params[control.name];
    if (control.kind === "color") {
      const hex = typeof current === "string" ? current : control.value;
      return {
        section: control.section,
        type: "vec3",
        name: control.name,
        comment: `color ${formatColor(hex)}`,
      };
    }
    const value = typeof current === "number" ? current : control.value;
    return {
      section: control.section,
      type: "float",
      name: control.name,
      comment: `${formatFloat(control.min)}, ${formatFloat(control.max)}, ${formatFloat(value)}`,
    };
  });
  const typePad = Math.max(...rows.map((row) => row.type.length)) + 1;
  const namePad = Math.max(...rows.map((row) => row.name.length));
  const lines: string[] = [];
  let section = "";
  for (const row of rows) {
    if (row.section !== section) {
      if (lines.length) lines.push("");
      lines.push(`// ---- ${row.section} ----`);
      section = row.section;
    }
    const declaration = `${row.name};`.padEnd(namePad + 1);
    lines.push(
      `uniform ${row.type.padEnd(typePad)}${declaration}  // ${row.comment}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function mountShaderPane(controls: ShaderControl[], params: ShaderParams) {
  const pane = new Pane({ title: "Shader", expanded: true });
  const frame = pane.element.parentElement;
  if (frame) {
    frame.style.position = "fixed";
    frame.style.zIndex = "2";
    frame.style.maxHeight = "calc(100vh - 16px)";
    frame.style.overflow = "auto";
    frame.style.overscrollBehavior = "contain";
  }

  const folders = new Map<string, ReturnType<Pane["addFolder"]>>();
  for (const control of controls) {
    let folder = folders.get(control.section);
    if (!folder) {
      folder = pane.addFolder({ title: control.section, expanded: true });
      folders.set(control.section, folder);
    }
    if (control.kind === "float") {
      folder.addBinding(params, control.name, {
        label: controlLabel(control.name),
        min: control.min,
        max: control.max,
        step: controlStep(control.min, control.max),
      });
    } else {
      folder.addBinding(params, control.name, {
        label: controlLabel(control.name),
        color: { alpha: false },
      });
    }
  }

  const copy = pane.addButton({ title: "Copy values", index: 0 });
  let copiedTimer = 0;
  copy.on("click", () => {
    const text = exportControls(controls, params);
    void navigator.clipboard.writeText(text).then(
      () => {
        copy.title = "Copied";
        window.clearTimeout(copiedTimer);
        copiedTimer = window.setTimeout(() => {
          try {
            copy.title = "Copy values";
          } catch {
            // The pane can unmount before the label resets.
          }
        }, 1200);
      },
      () => {
        copy.title = "Copy failed";
      },
    );
  });
  return pane;
}

function numberParam(params: ShaderParams, name: string, fallback: number) {
  const value = params[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

type Vec2 = [number, number];

function cmul(a: Vec2, b: Vec2): Vec2 {
  return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
}

function cdiv(a: Vec2, b: Vec2): Vec2 {
  const denominator = b[0] * b[0] + b[1] * b[1];
  const numerator = cmul(a, [b[0], -b[1]]);
  return [numerator[0] / denominator, numerator[1] / denominator];
}

function fwd(z: Vec2, a: Vec2, branch: number): Vec2 {
  if (branch === 0) return cmul(a, z);
  const scaled = cmul([a[0] - 1, a[1]], z);
  return [1 + scaled[0], scaled[1]];
}

// Same search as the shader's bound(), once per frame instead of once per pixel.
function boundRadius(a: Vec2, c: Vec2) {
  const s0 = Math.hypot(a[0], a[1]);
  const s1 = Math.hypot(a[0] - 1, a[1]);
  let radius = 0;
  for (let w = 0; w < 16; w++) {
    let z: Vec2 = [c[0], c[1]];
    let scale = 1;
    for (let k = 0; k < 4; k++) {
      const branch = (w >> k) & 1;
      z = fwd(z, a, branch);
      scale *= branch === 0 ? s0 : s1;
    }
    radius = Math.max(
      radius,
      Math.hypot(z[0] - c[0], z[1] - c[1]) / (1 - scale),
    );
  }
  return radius * 1.001;
}

function sceneRadius(time: number, params: ShaderParams) {
  const drift = time * numberParam(params, "u_drift", 0);
  const wobX =
    (Math.sin(drift * 0.037) + 0.5 * Math.sin(drift * 0.061 + 1.3)) / 1.5;
  const wobY =
    (Math.cos(drift * 0.029) + 0.5 * Math.sin(drift * 0.053 + 2.1)) / 1.5;
  const morph = numberParam(params, "u_morph", 0);
  const ax = numberParam(params, "u_apexX", 0.5) + morph * wobX;
  const ay = numberParam(params, "u_apexY", 0.5) + morph * wobY;
  return boundRadius([ax, ay], cdiv([0.5, 0], [1.5 - ax, -ay]));
}

// Column-major mat2(c, -s, s, c), matching the shader's rot().
function rotate(angle: number, x: number, y: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c * x + s * y, -s * x + c * y];
}

type CellGrid = {
  originX: number;
  originY: number;
  texW: number;
  texH: number;
};

function cellGrid(
  width: number,
  height: number,
  angle: number,
  cell: number,
  aspect = 1,
): CellGrid {
  const cellX = cell * aspect;
  const corners = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of corners) {
    const [gx, gy] = rotate(angle, x, y);
    minX = Math.min(minX, gx / cellX);
    minY = Math.min(minY, gy / cell);
    maxX = Math.max(maxX, gx / cellX);
    maxY = Math.max(maxY, gy / cell);
  }
  const originX = Math.floor(minX) - 2;
  const originY = Math.floor(minY) - 2;
  return {
    originX,
    originY,
    texW: Math.ceil(maxX) - originX + 2,
    texH: Math.ceil(maxY) - originY + 2,
  };
}

type HeatFormat = { internal: number; format: number; type: number };

type HeatTarget = { texture: WebGLTexture; framebuffer: WebGLFramebuffer };

function heatFormats(gl: WebGL2RenderingContext): HeatFormat[] {
  const bytes = {
    internal: gl.RGBA8,
    format: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
  };
  if (!gl.getExtension("EXT_color_buffer_float")) return [bytes];
  return [
    { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT },
    bytes,
  ];
}

function createHeatTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  format: HeatFormat,
  filter?: number,
): HeatTarget | null {
  const texelFilter = filter ?? gl.LINEAR;
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) {
    if (texture) gl.deleteTexture(texture);
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    return null;
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, texelFilter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, texelFilter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    format.internal,
    width,
    height,
    0,
    format.format,
    format.type,
    null,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0,
  );
  const complete =
    gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  if (!complete) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    return null;
  }
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { texture, framebuffer };
}

const GLYPH_FONT =
  '600 120px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

function createGlyphAtlas(glyphs: string) {
  const measure = document.createElement("canvas").getContext("2d");
  if (!measure || glyphs.length === 0) return null;
  measure.font = GLYPH_FONT;
  const probe = measure.measureText("Mg@#%");
  const advance = measure.measureText("M").width;
  if (!Number.isFinite(advance) || advance <= 0) return null;
  const ascent = probe.actualBoundingBoxAscent || 96;
  const descent = probe.actualBoundingBoxDescent || 24;
  const padX = Math.ceil(advance * 0.12);
  const padY = Math.ceil((ascent + descent) * 0.14);
  const tileW = Math.ceil(advance + padX * 2);
  const tileH = Math.ceil(ascent + descent + padY * 2);
  const canvas = document.createElement("canvas");
  canvas.width = tileW * glyphs.length;
  canvas.height = tileH;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = GLYPH_FONT;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const baseline = padY + ascent;
  for (let i = 0; i < glyphs.length; i++) {
    if (glyphs[i] === " ") continue;
    ctx.fillText(glyphs[i], (i + 0.5) * tileW, baseline);
  }
  return { canvas, aspect: tileW / tileH };
}

function fragmentVariant(defines: string) {
  const body =
    FRAGMENT_PRELUDE + fragmentSource.replace(CONTRACT_REDECLARE, "");
  if (!defines) return body;
  return body.replace("#version 300 es", `#version 300 es\n${defines}\n`);
}

type UniformSlot = { loc: WebGLUniformLocation; type: number };
type UniformSlots = Map<string, UniformSlot>;

function uniformSlots(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
): UniformSlots {
  const slots: UniformSlots = new Map();
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    if (!info) continue;
    const loc = gl.getUniformLocation(program, info.name);
    if (!loc) continue;
    slots.set(info.name, { loc, type: info.type });
  }
  return slots;
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): { program: WebGLProgram } | { error: string } {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if ("error" in vs || "error" in fs) {
    if ("shader" in vs) gl.deleteShader(vs.shader);
    if ("shader" in fs) gl.deleteShader(fs.shader);
    const message = [
      "error" in vs ? vs.error : "",
      "error" in fs ? fs.error : "",
    ]
      .filter(Boolean)
      .join("\n");
    return { error: message };
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vs.shader);
    gl.deleteShader(fs.shader);
    return { error: "Could not create the shader program." };
  }
  gl.attachShader(program, vs.shader);
  gl.attachShader(program, fs.shader);
  gl.linkProgram(program);
  gl.deleteShader(vs.shader);
  gl.deleteShader(fs.shader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "Program link failed";
    gl.deleteProgram(program);
    return { error: message };
  }
  return { program };
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): { shader: WebGLShader } | { error: string } {
  const shader = gl.createShader(type);
  if (!shader) return { error: "Could not create shader" };
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader) || "Shader compile failed";
    gl.deleteShader(shader);
    return { error };
  }
  return { shader };
}

export function DragonFractal({ glyphs }: { glyphs?: string } = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
    });
    if (!gl) {
      setError("WebGL2 is required to run this shader.");
      return;
    }

    const vao = gl.createVertexArray();
    if (!vao) {
      setError("WebGL2 could not create a vertex array.");
      return;
    }
    gl.bindVertexArray(vao);

    const modeDefine = glyphs ? "#define ASCII" : "";
    const linkDragon = (defines: string) =>
      linkProgram(
        gl,
        VERTEX_SRC,
        fragmentVariant([modeDefine, defines].filter(Boolean).join("\n")),
      );
    const dragon = linkDragon("");
    if ("error" in dragon) {
      gl.deleteVertexArray(vao);
      setError(dragon.error);
      return;
    }
    const cellWrite = linkDragon("#define CELL_WRITE");
    if ("error" in cellWrite) {
      gl.deleteProgram(dragon.program);
      gl.deleteVertexArray(vao);
      setError(cellWrite.error);
      return;
    }
    const cellRead = linkDragon("#define CELL_READ");
    if ("error" in cellRead) {
      gl.deleteProgram(cellWrite.program);
      gl.deleteProgram(dragon.program);
      gl.deleteVertexArray(vao);
      setError(cellRead.error);
      return;
    }
    const program = dragon.program;
    const cellWriteProgram = cellWrite.program;
    const cellReadProgram = cellRead.program;
    const locations = uniformSlots(gl, program);
    const cellWriteSlots = uniformSlots(gl, cellWriteProgram);
    const cellReadSlots = uniformSlots(gl, cellReadProgram);

    const heatPass = linkProgram(gl, HEAT_VERTEX_SRC, HEAT_FRAGMENT_SRC);
    if ("error" in heatPass) {
      gl.deleteProgram(cellReadProgram);
      gl.deleteProgram(cellWriteProgram);
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
      setError(heatPass.error);
      return;
    }
    const heatProgram = heatPass.program;

    const controls = shaderControls(
      fragmentSource,
      glyphs ? new Set(["ASCII"]) : NO_DEFINES,
    );
    const params: ShaderParams = {};
    for (const control of controls) params[control.name] = control.value;

    const applyControls = (slots: UniformSlots) => {
      for (const control of controls) {
        const slot = slots.get(control.name);
        if (!slot) continue;
        const current = params[control.name];
        if (
          control.kind === "float" &&
          typeof current === "number" &&
          slot.type === gl.FLOAT
        ) {
          gl.uniform1f(slot.loc, current);
        } else if (
          control.kind === "color" &&
          typeof current === "string" &&
          slot.type === gl.FLOAT_VEC3
        ) {
          const rgb = hexToVec3(current);
          if (rgb) gl.uniform3fv(slot.loc, rgb);
        }
      }
    };

    let glyphTexture: WebGLTexture | null = null;
    let glyphAspect = 1;
    if (glyphs) {
      const atlas = createGlyphAtlas(glyphs);
      const texture = atlas ? gl.createTexture() : null;
      if (!atlas || !texture) {
        if (texture) gl.deleteTexture(texture);
        gl.deleteProgram(heatProgram);
        gl.deleteProgram(cellReadProgram);
        gl.deleteProgram(cellWriteProgram);
        gl.deleteProgram(program);
        gl.deleteVertexArray(vao);
        setError("Could not build the ASCII glyph atlas.");
        return;
      }
      glyphTexture = texture;
      glyphAspect = atlas.aspect;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        atlas.canvas,
      );
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.activeTexture(gl.TEXTURE0);
    }

    const bindDragonSamplers = (dragonProgram: WebGLProgram) => {
      gl.useProgram(dragonProgram);
      const heat = gl.getUniformLocation(dragonProgram, "u_heatMap");
      if (heat) gl.uniform1i(heat, 0);
      const cell = gl.getUniformLocation(dragonProgram, "u_cellMap");
      if (cell) gl.uniform1i(cell, 1);
      const glyphMap = gl.getUniformLocation(dragonProgram, "u_glyphMap");
      if (glyphMap) gl.uniform1i(glyphMap, 2);
      const glyphCount = gl.getUniformLocation(dragonProgram, "u_glyphCount");
      if (glyphCount && glyphs) gl.uniform1f(glyphCount, glyphs.length);
      const cellAspect = gl.getUniformLocation(dragonProgram, "u_cellAspect");
      if (cellAspect) gl.uniform1f(cellAspect, glyphAspect);
    };
    bindDragonSamplers(program);
    bindDragonSamplers(cellWriteProgram);
    bindDragonSamplers(cellReadProgram);

    const pane = mountShaderPane(controls, params);
    const perf = {
      frameCap: true,
      singleSample: true,
      cellSamples: true,
      sharedRadius: true,
      coarseHeat: true,
      halfRes: false,
    };
    const lowPower = pane.addFolder({
      title: "Low power",
      expanded: true,
      index: 0,
    });
    lowPower.addBinding(perf, "frameCap", { label: "30 fps" });
    lowPower.addBinding(perf, "singleSample", { label: "Single sample" });
    lowPower.addBinding(perf, "cellSamples", { label: "Cell samples" });
    lowPower.addBinding(perf, "sharedRadius", { label: "Shared radius" });
    lowPower.addBinding(perf, "coarseHeat", { label: "Coarse heat" });
    lowPower.addBinding(perf, "halfRes", { label: "Half resolution" });

    gl.useProgram(heatProgram);
    const heatPrev = gl.getUniformLocation(heatProgram, "u_prev");
    if (heatPrev) gl.uniform1i(heatPrev, 0);
    const heatResolution = gl.getUniformLocation(heatProgram, "u_resolution");
    const heatMouse = gl.getUniformLocation(heatProgram, "u_mouse");
    const heatDt = gl.getUniformLocation(heatProgram, "u_dt");
    const heatDeposit = gl.getUniformLocation(heatProgram, "u_deposit");
    const heatRadius = gl.getUniformLocation(heatProgram, "u_heatRadius");
    const heatDissipate = gl.getUniformLocation(heatProgram, "u_heatDissipate");
    const heatSpread = gl.getUniformLocation(heatProgram, "u_heatSpread");
    gl.useProgram(program);

    const pointer = { nx: 0, ny: 0, inside: false };
    const placePointer = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.nx = (event.clientX - rect.left) / Math.max(rect.width, 1);
      pointer.ny = (rect.bottom - event.clientY) / Math.max(rect.height, 1);
    };
    const onPointerMove = (event: PointerEvent) => {
      placePointer(event);
      pointer.inside = true;
    };
    const onPointerLeave = () => {
      pointer.inside = false;
    };
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);

    const resize = () => {
      const scale = perf.halfRes ? 0.5 : 1;
      const width = Math.max(1, Math.round(canvas.clientWidth * scale));
      const height = Math.max(1, Math.round(canvas.clientHeight * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const stats = new Stats();
    document.body.appendChild(stats.dom);

    const started = performance.now();
    let frame = 0;
    let lastNow = started;
    let lastPresented = 0;
    const frameCapMs = 1000 / 30;
    const formats = heatFormats(gl);
    let formatIndex = 0;
    const heatTargets: HeatTarget[] = [];
    let heatW = 0;
    let heatH = 0;
    let heatIndex = 0;
    let heatReset = false;
    let heatEnvelope = 0;
    let cellTarget: HeatTarget | null = null;
    let cellW = 0;
    let cellH = 0;
    let cellFormatIndex = 0;
    let elapsed = 0;
    let screenW = 1;
    let screenH = 1;
    let shared = false;
    let radius = 0;

    const destroyHeat = () => {
      for (const target of heatTargets) {
        gl.deleteFramebuffer(target.framebuffer);
        gl.deleteTexture(target.texture);
      }
      heatTargets.length = 0;
      heatW = 0;
      heatH = 0;
    };

    const ensureHeat = (width: number, height: number) => {
      heatReset = false;
      if (heatTargets.length === 2 && heatW === width && heatH === height) {
        return true;
      }
      destroyHeat();
      heatReset = true;
      while (formatIndex < formats.length) {
        const format = formats[formatIndex];
        const first = createHeatTarget(gl, width, height, format);
        const second = first
          ? createHeatTarget(gl, width, height, format)
          : null;
        if (first && second) {
          heatTargets.push(first, second);
          heatW = width;
          heatH = height;
          heatIndex = 0;
          return true;
        }
        if (first) {
          gl.deleteFramebuffer(first.framebuffer);
          gl.deleteTexture(first.texture);
        }
        formatIndex += 1;
      }
      return false;
    };

    const destroyCell = () => {
      if (!cellTarget) return;
      gl.deleteFramebuffer(cellTarget.framebuffer);
      gl.deleteTexture(cellTarget.texture);
      cellTarget = null;
      cellW = 0;
      cellH = 0;
    };

    const ensureCell = (width: number, height: number) => {
      const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      if (width > max || height > max) return false;
      if (cellTarget && cellW === width && cellH === height) return true;
      destroyCell();
      while (cellFormatIndex < formats.length) {
        const target = createHeatTarget(
          gl,
          width,
          height,
          formats[cellFormatIndex],
          gl.NEAREST,
        );
        if (target) {
          cellTarget = target;
          cellW = width;
          cellH = height;
          return true;
        }
        cellFormatIndex += 1;
      }
      return false;
    };

    const paintDragon = (
      dragonProgram: WebGLProgram,
      slots: UniformSlots,
      viewW: number,
      viewH: number,
      grid?: CellGrid,
    ) => {
      gl.useProgram(dragonProgram);
      gl.viewport(0, 0, viewW, viewH);
      const resolution = slots.get("u_resolution");
      const time = slots.get("u_time");
      const scale = slots.get("u_scale");
      const position = slots.get("u_position");
      const samples = slots.get("u_aa");
      const boundFlag = slots.get("u_useBound");
      const boundValue = slots.get("u_boundR");
      if (resolution) gl.uniform2f(resolution.loc, screenW, screenH);
      if (time) gl.uniform1f(time.loc, elapsed);
      if (scale) gl.uniform1f(scale.loc, 1);
      if (position) gl.uniform2f(position.loc, 0, 0);
      if (samples) gl.uniform1i(samples.loc, perf.singleSample ? 1 : 2);
      if (boundFlag) gl.uniform1i(boundFlag.loc, shared ? 1 : 0);
      if (boundValue && shared) gl.uniform1f(boundValue.loc, radius);
      if (grid) {
        const origin = slots.get("u_cellOrigin");
        const texSize = slots.get("u_cellTexSize");
        if (origin) gl.uniform2f(origin.loc, grid.originX, grid.originY);
        if (texSize) gl.uniform2f(texSize.loc, grid.texW, grid.texH);
      }
      applyControls(slots);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const draw = (now: number) => {
      if (perf.frameCap && now - lastPresented < frameCapMs - 1) {
        frame = requestAnimationFrame(draw);
        return;
      }
      lastPresented = now;

      stats.begin();
      resize();
      const dt = Math.min(0.05, (now - lastNow) / 1000);
      lastNow = now;
      screenW = canvas.width;
      screenH = canvas.height;
      const heatScale = perf.coarseHeat ? 0.25 : 1;
      const heatWidth = Math.max(1, Math.round(screenW * heatScale));
      const heatHeight = Math.max(1, Math.round(screenH * heatScale));
      if (!ensureHeat(heatWidth, heatHeight)) {
        stats.end();
        setError("WebGL2 could not store the heat field.");
        return;
      }

      const dissipate = numberParam(params, "u_heatDissipate", 0.1);
      if (heatReset || pointer.inside) heatEnvelope = pointer.inside ? 1 : 0;
      else heatEnvelope *= Math.exp(-dt * Math.max(dissipate, 0));
      const heatLive = !perf.coarseHeat || heatEnvelope > 1 / 255;

      let heatTexture = heatTargets[heatIndex].texture;
      if (heatLive) {
        const src = heatIndex;
        const dst = 1 - heatIndex;
        gl.bindFramebuffer(gl.FRAMEBUFFER, heatTargets[dst].framebuffer);
        gl.viewport(0, 0, heatWidth, heatHeight);
        gl.useProgram(heatProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, heatTargets[src].texture);
        if (heatResolution) gl.uniform2f(heatResolution, heatWidth, heatHeight);
        if (heatMouse) {
          gl.uniform2f(
            heatMouse,
            pointer.nx * heatWidth,
            pointer.ny * heatHeight,
          );
        }
        if (heatDt) gl.uniform1f(heatDt, dt);
        if (heatDeposit) gl.uniform1f(heatDeposit, pointer.inside ? 1 : 0);
        if (heatRadius) {
          gl.uniform1f(heatRadius, numberParam(params, "u_heatRadius", 0.1));
        }
        if (heatDissipate) gl.uniform1f(heatDissipate, dissipate);
        if (heatSpread) {
          gl.uniform1f(
            heatSpread,
            numberParam(params, "u_heatSpread", 0.8) * heatScale,
          );
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        heatIndex = dst;
        heatTexture = heatTargets[dst].texture;
      }

      elapsed = (now - started) / 1000;
      // Slightly outside the shader's circle so CPU rounding cannot open a seam.
      radius = perf.sharedRadius ? sceneRadius(elapsed, params) * 1.0005 : 0;
      shared = perf.sharedRadius && Number.isFinite(radius) && radius > 0;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, heatTexture);

      let drewCells = false;
      if (perf.cellSamples) {
        const grid = cellGrid(
          screenW,
          screenH,
          numberParam(params, "u_angle", glyphs ? 0 : 2.0),
          Math.max(numberParam(params, "u_cell", glyphs ? 16 : 6.4), 0.001),
          glyphAspect,
        );
        if (ensureCell(grid.texW, grid.texH) && cellTarget) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, cellTarget.framebuffer);
          paintDragon(
            cellWriteProgram,
            cellWriteSlots,
            grid.texW,
            grid.texH,
            grid,
          );
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, cellTarget.texture);
          gl.activeTexture(gl.TEXTURE0);
          paintDragon(cellReadProgram, cellReadSlots, screenW, screenH, grid);
          drewCells = true;
        }
      } else if (cellTarget) {
        destroyCell();
      }
      if (!drewCells) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        paintDragon(program, locations, screenW, screenH);
      }

      stats.end();
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      stats.dom.remove();
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      observer.disconnect();
      pane.dispose();
      if (glyphTexture) gl.deleteTexture(glyphTexture);
      destroyCell();
      destroyHeat();
      gl.deleteProgram(heatProgram);
      gl.deleteProgram(cellReadProgram);
      gl.deleteProgram(cellWriteProgram);
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
    };
  }, [glyphs]);

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{
          position: "fixed",
          inset: 0,
          width: "100%",
          height: "100%",
          display: "block",
          background: "#0c0b0a",
        }}
      />
      {error ? (
        <pre
          data-shader-error=""
          style={{
            position: "fixed",
            inset: 0,
            margin: 0,
            padding: 16,
            overflow: "auto",
            color: "#f3efe6",
            background: "#0c0b0a",
            whiteSpace: "pre-wrap",
          }}
        >
          {error}
        </pre>
      ) : null}
    </>
  );
}
