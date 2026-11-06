"use client";

import { useEffect, useRef, useState } from "react";
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

// Shader comments are the tweak contract: `min, max, default`, or `color #rrggbb`.
function shaderControls(source: string): ShaderControl[] {
  const controls: ShaderControl[] = [];
  let section = "Shader";
  for (const line of source.split("\n")) {
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
): HeatTarget | null {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) {
    if (texture) gl.deleteTexture(texture);
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    return null;
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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

export function DragonFractal() {
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

    const dragon = linkProgram(
      gl,
      VERTEX_SRC,
      FRAGMENT_PRELUDE + fragmentSource.replace(CONTRACT_REDECLARE, ""),
    );
    if ("error" in dragon) {
      gl.deleteVertexArray(vao);
      setError(dragon.error);
      return;
    }
    const program = dragon.program;

    const heatPass = linkProgram(gl, HEAT_VERTEX_SRC, HEAT_FRAGMENT_SRC);
    if ("error" in heatPass) {
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
      setError(heatPass.error);
      return;
    }
    const heatProgram = heatPass.program;

    gl.useProgram(program);

    const controls = shaderControls(fragmentSource);
    const params: ShaderParams = {};
    for (const control of controls) params[control.name] = control.value;

    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    const locations = new Map<
      string,
      { loc: WebGLUniformLocation; type: number }
    >();
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      if (!info) continue;
      const loc = gl.getUniformLocation(program, info.name);
      if (!loc) continue;
      locations.set(info.name, { loc, type: info.type });
    }

    const applyControls = () => {
      for (const control of controls) {
        const slot = locations.get(control.name);
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
    applyControls();

    const pane = mountShaderPane(controls, params);

    const resolution = locations.get("u_resolution");
    const time = locations.get("u_time");
    const scale = locations.get("u_scale");
    const position = locations.get("u_position");
    if (scale) gl.uniform1f(scale.loc, 1);
    if (position) gl.uniform2f(position.loc, 0, 0);
    const heatMap = gl.getUniformLocation(program, "u_heatMap");
    if (heatMap) gl.uniform1i(heatMap, 0);

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

    const pointer = { x: 0, y: 0, inside: false };
    const placePointer = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x =
        ((event.clientX - rect.left) / Math.max(rect.width, 1)) * canvas.width;
      pointer.y =
        ((rect.bottom - event.clientY) / Math.max(rect.height, 1)) *
        canvas.height;
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
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const started = performance.now();
    let frame = 0;
    let lastNow = started;
    const formats = heatFormats(gl);
    let formatIndex = 0;
    const heatTargets: HeatTarget[] = [];
    let heatW = 0;
    let heatH = 0;
    let heatIndex = 0;

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
      if (heatTargets.length === 2 && heatW === width && heatH === height) {
        return true;
      }
      destroyHeat();
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

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - lastNow) / 1000);
      lastNow = now;
      const width = canvas.width;
      const height = canvas.height;
      if (!ensureHeat(width, height)) {
        setError("WebGL2 could not store the heat field.");
        return;
      }

      const src = heatIndex;
      const dst = 1 - heatIndex;
      gl.bindFramebuffer(gl.FRAMEBUFFER, heatTargets[dst].framebuffer);
      gl.viewport(0, 0, width, height);
      gl.useProgram(heatProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, heatTargets[src].texture);
      if (heatResolution) gl.uniform2f(heatResolution, width, height);
      if (heatMouse) gl.uniform2f(heatMouse, pointer.x, pointer.y);
      if (heatDt) gl.uniform1f(heatDt, dt);
      if (heatDeposit) gl.uniform1f(heatDeposit, pointer.inside ? 1 : 0);
      if (heatRadius) {
        gl.uniform1f(heatRadius, numberParam(params, "u_heatRadius", 0.1));
      }
      if (heatDissipate) {
        gl.uniform1f(
          heatDissipate,
          numberParam(params, "u_heatDissipate", 0.2),
        );
      }
      if (heatSpread) {
        gl.uniform1f(heatSpread, numberParam(params, "u_heatSpread", 8));
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.useProgram(program);
      gl.bindTexture(gl.TEXTURE_2D, heatTargets[dst].texture);
      if (resolution) gl.uniform2f(resolution.loc, width, height);
      if (time) gl.uniform1f(time.loc, (now - started) / 1000);
      applyControls();
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      heatIndex = dst;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      observer.disconnect();
      pane.dispose();
      destroyHeat();
      gl.deleteProgram(heatProgram);
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
    };
  }, []);

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
