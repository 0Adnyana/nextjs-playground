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
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform float u_time;
uniform float u_scale;
uniform vec2  u_position;
in  vec2 v_uv;
out vec4 fragColor;
`;

const CONTRACT_REDECLARE =
  /^\s*uniform\s+\w+\s+u_(?:resolution|mouse|time|scale|position)\s*;.*$/gm;

const RESERVED = new Set([
  "u_resolution",
  "u_mouse",
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

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fs = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      FRAGMENT_PRELUDE + fragmentSource.replace(CONTRACT_REDECLARE, ""),
    );
    if ("error" in vs || "error" in fs) {
      if ("shader" in vs) gl.deleteShader(vs.shader);
      if ("shader" in fs) gl.deleteShader(fs.shader);
      const message = [
        "error" in vs ? vs.error : "",
        "error" in fs ? fs.error : "",
      ]
        .filter(Boolean)
        .join("\n");
      setError(message);
      return;
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs.shader);
      gl.deleteShader(fs.shader);
      setError("Could not create the shader program.");
      return;
    }
    gl.attachShader(program, vs.shader);
    gl.attachShader(program, fs.shader);
    gl.linkProgram(program);
    gl.deleteShader(vs.shader);
    gl.deleteShader(fs.shader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || "Program link failed";
      gl.deleteProgram(program);
      setError(message);
      return;
    }

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
    const draw = (now: number) => {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      if (resolution) gl.uniform2f(resolution.loc, canvas.width, canvas.height);
      if (time) gl.uniform1f(time.loc, (now - started) / 1000);
      applyControls();
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      pane.dispose();
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
