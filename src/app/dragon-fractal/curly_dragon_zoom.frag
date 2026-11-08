// Curly dragon infinite zoom, with a transparent background
// The camera zooms forever into the dragon's tip. Because the dragon is made of
// smaller copies of itself, new curls keep growing out of the center endlessly.
// Darker colors are drawn as a rotated halftone: one crisp dot per grid cell,
// smaller as the ink gets darker. Lighter colors are drawn solid. The ASCII
// variant stamps one glyph per cell instead: a sparse mark for dark ink, a
// dense mark for light ink. Hovering paints a heat field that cools and
// spreads. The lift recolors the ink and pushes it toward the solid curve, or
// toward a denser glyph. Both fade back as the heat cools.

// ---- Tweakable settings ----
uniform vec3  u_color0;  // color #001023
uniform vec3  u_color1;  // color #082f60
uniform vec3  u_color2;  // color #265ea6
uniform vec3  u_color3;  // color #c3d2e6
uniform float u_apexX;   // 0.40, 0.65, 0.50
uniform float u_apexY;   // 0.40, 0.62, 0.50
uniform float u_zoom;    // 0.0, 0.5, 0.10
uniform float u_view;    // 0.1, 1.5, 0.35
uniform float u_focusX;  // 0.0, 1.0, 0.63
uniform float u_focusY;  // 0.0, 1.0, 0.41
uniform float u_morph;   // -0.1, 0.08, 0.0
uniform float u_drift;   // 0.0, 3.0, 0.0
uniform float u_spin;    // -0.2, 0.2, 0.0
uniform float u_bands;   // 0.05, 1.0, 0.20
uniform float u_flow;    // 0.0, 1.0, 0.05
uniform float u_line;    // 0.31, 4.0, 0.31
uniform float u_opacity; // 0.0, 1.0, 1.0

#ifndef ASCII
// ---- Halftone ----
uniform float u_dither;  // 0.0, 1.0, 1.0
uniform float u_cell;    // 4.0, 48.0, 6.4
uniform float u_dot;     // 0.2, 2.0, 0.55
uniform float u_angle;   // 0.0, 6.28, 2.0
uniform float u_dotCut;  // 0.05, 1.0, 1.0
uniform float u_dotMin;  // 0.0, 1.0, 0.35
uniform float u_dotTint; // 0.0, 1.0, 0.0
#else
// ---- ASCII ----
// One upright-or-rotated cell per glyph. Tone picks the character: dark ink
// stays sparse, light ink and heat step toward the densest mark.
uniform float u_dither;    // 0.0, 1.0, 0.7
uniform float u_cell;      // 8.0, 40.0, 16.0
uniform float u_angle;     // 0.0, 6.28, 0.0
uniform float u_toneCut;   // 0.05, 1.0, 1.0
uniform float u_glyphMin;  // 0.0, 1.0, 0.12
uniform float u_glyphTint; // 0.0, 1.0, 0.0
uniform float u_cellAspect;
uniform float u_glyphCount;
uniform sampler2D u_glyphMap;
#endif

// ---- Heat ----
// Screen-space field. Radius, dissipate, and spread drive it each frame.
// Lift recolors the ink. Halftone grows the dots until the lightest stop, then
// draws the curve solid. ASCII steps to a denser glyph. Both return as the
// spot cools.
uniform vec3  u_heatColor;     // color #c3d2e6
uniform float u_heatRadius;    // 0.02, 0.80, 0.10
uniform float u_heatDissipate; // 0.0, 3.0, 0.10
uniform float u_heatSpread;    // 0.0, 8.0, 0.80
uniform float u_heatLift;      // 0.0, 1.0, 1.0

// ---- Quality ----
const int MAX_DEPTH = 24;   // detail cap
const int BUDGET    = 800;  // search steps per sample
uniform int u_aa;           // 1 = fastest, 2 = smooth edges
uniform int u_useBound;
uniform float u_boundR;
uniform vec2 u_cellOrigin;
uniform vec2 u_cellTexSize;
uniform sampler2D u_cellMap;
const int AA_MAX    = 2;
const int EXTRA     = 3;    // safety steps toward the tip (prevents seams)

const vec2 ONE = vec2(1.0, 0.0);

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 cdiv(vec2 a, vec2 b) { return cmul(a, vec2(b.x, -b.y)) / dot(b, b); }
vec2 cpow(vec2 a, float n) { float r = pow(length(a), n); float th = atan(a.y, a.x) * n; return r * vec2(cos(th), sin(th)); }

mat2 rot(float a) {
    float c = cos(a), s = sin(a);
    return mat2(c, -s, s, c);
}

// The dragon is two shrunken copies of itself: f0(z) = a*z and f1(z) = 1 + (a - 1)*z
vec2 fwd(vec2 z, vec2 a, int m) { return m == 0 ? cmul(a, z) : ONE + cmul(a - ONE, z); }
vec2 inv(vec2 z, vec2 a, int m) { return m == 0 ? cdiv(z, a) : cdiv(z - ONE, a - ONE); }

// Radius of a circle around c that is guaranteed to contain the dragon
float bound(vec2 a, vec2 c) {
    float s0 = length(a);
    float s1 = length(a - ONE);
    float R = 0.0;
    for (int w = 0; w < 16; w++) {
        vec2 z = c;
        float sc = 1.0;
        for (int k = 0; k < 4; k++) {
            int m = (w >> k) & 1;
            z = fwd(z, a, m);
            sc *= (m == 0) ? s0 : s1;
        }
        R = max(R, length(z - c) / (1.0 - sc));
    }
    return R * 1.001;
}

// Hex stops are gamma-encoded. Blend in linear light so a midpoint is halfway
// in brightness, then encode back for the framebuffer.
vec3 srgbToLinear(vec3 c) {
    vec3 lo = c / 12.92;
    vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
    return mix(lo, hi, step(vec3(0.04045), c));
}

vec3 linearToSrgb(vec3 c) {
    c = max(c, vec3(0.0));
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
    return mix(lo, hi, step(vec3(0.0031308), c));
}

// Color 1 → 2 → 3 → 4 → 3 → 2 → 1, then repeat. The parameter moves at a
// constant rate, and each leg between stops takes the same share of the cycle.
vec3 gradientMap(float x) {
    float p = fract(x);
    float tri = p < 0.5 ? p * 2.0 : 2.0 - p * 2.0;
    float g = tri * 3.0;
    int i = int(min(floor(g), 2.0));
    float f = g - float(i);
    vec3 a = u_color0;
    vec3 b = u_color1;
    if (i == 1)      { a = u_color1; b = u_color2; }
    else if (i == 2) { a = u_color2; b = u_color3; }
    return linearToSrgb(mix(srgbToLinear(a), srgbToLinear(b), f));
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float heatAt(vec2 screenPx) {
    return texture(u_heatMap, screenPx / u_resolution).r;
}

// Mix toward the heat color. The dot radius tracks the same amount.
vec3 heatColor(vec3 col, float heat) {
    float t = clamp(heat, 0.0, 1.0) * u_heatLift;
    return mix(col, u_heatColor, t);
}

// Returns the position along the curve (0..1) if p is on the dragon, or -1 if not.
float dragon(vec2 p, vec2 a, vec2 c, float R, int depthN) {
    if (length(p - c) > R) return -1.0;
    vec2 q = p;
    int depth = 0;
    int path = 0;
    int m = 0;
    bool found = false;
    for (int s = 0; s < BUDGET; s++) {
        if (depth >= depthN) { found = true; break; }
        if (m < 2) {
            vec2 nq = inv(q, a, m);
            if (length(nq - c) <= R) {
                path = (path & ~(1 << depth)) | (m << depth);
                q = nq;
                depth++;
                m = 0;
            } else {
                m++;
            }
        } else {
            if (depth == 0) break;
            depth--;
            int pm = (path >> depth) & 1;
            q = fwd(q, a, pm);
            m = pm + 1;
        }
    }
    if (!found) return -1.0;

    float t = 0.5;
    for (int k = 0; k < MAX_DEPTH; k++) {
        int idx = depthN - 1 - k;
        if (idx < 0) break;
        t = ((path >> idx) & 1) == 0 ? 0.5 * t : 1.0 - 0.5 * t;
    }
    return t;
}

// ---- Scene state, set once in main() ----
vec2  gA, gC, gCam;
float gR, gSa, gSmax, gCamScale, gGen;

// Screen pixel -> dragon plane coordinates
vec2 pxToUV(vec2 px) {
    float aspect = u_resolution.x / u_resolution.y;
    return (px / u_resolution - vec2(u_focusX, u_focusY)) * 2.0 * vec2(aspect, 1.0);
}

// Samples the dragon at one point. `foot` is the sample's size in uv units:
// bigger footprints stop the search earlier, so the curve reads thicker.
bool sampleDragon(vec2 uv, float foot, out vec3 col) {
    col = vec3(0.0);
    vec2 p = cmul(uv, gCam);

    // Pull the point toward the tip until it lies inside the base dragon
    float r = max(length(p), 1e-6);
    float n = max(0.0, ceil(log(r / gR) / log(1.0 / gSa))) + float(EXTRA);
    n = min(n, 60.0);
    vec2 q = cmul(p, cpow(gA, n));

    // Only go as deep as one line width
    float pix = foot * gCamScale * pow(gSa, n);
    int depthN = clamp(int(ceil(log(u_line * pix / gR) / log(gSmax))), 1, MAX_DEPTH);

    float t = dragon(q, gA, gC, gR, depthN);
    if (t < 0.0) return false;

    // Color by generation so it flows smoothly through the endless zoom
    float v = log2(max(t, 1e-7)) + n - gGen;
    col = gradientMap(v * u_bands + u_time * u_flow);
    return true;
}

void main() {
    // Slowly wandering shape; the frequencies never line up, so it never repeats exactly
    float T = u_time * u_drift;
    vec2 wob = vec2(sin(T * 0.037) + 0.5 * sin(T * 0.061 + 1.3),
                    cos(T * 0.029) + 0.5 * sin(T * 0.053 + 2.1)) / 1.5;
    gA = vec2(u_apexX, u_apexY) + u_morph * wob;
    gC = cdiv(0.5 * ONE, 1.5 * ONE - gA);
    if (u_useBound != 0) gR = u_boundR;
    else gR = bound(gA, gC);
    gSa = length(gA);
    gSmax = max(gSa, length(gA - ONE));

    // Infinite zoom: the dragon's tip at 0 looks the same after scaling by a,
    // so we only ever zoom through one "generation" and wrap around seamlessly.
    float g = u_time * u_zoom;
    gGen = floor(g);
    vec2 cam = cpow(gA, fract(g));
    float spin = u_time * u_spin;
    gCam = cmul(cam, vec2(cos(spin), sin(spin))) * u_view;
    gCamScale = length(gCam);

    float pixUV = 2.0 / u_resolution.y; // one screen pixel in uv units

#ifdef CELL_WRITE
    // One dragon sample per cell. The screen pass only draws the dot or glyph.
    vec2 cellId = gl_FragCoord.xy - 0.5 + u_cellOrigin;
#ifdef ASCII
    vec2 cellSize = vec2(u_cell * u_cellAspect, u_cell);
    vec2 cellCenter = rot(-u_angle) * ((cellId + 0.5) * cellSize);
#else
    vec2 cellCenter = rot(-u_angle) * ((cellId + 0.5) * u_cell);
#endif
    vec3 cellCol = vec3(0.0);
    bool cellHit = sampleDragon(pxToUV(cellCenter), 0.5 * u_cell * pixUV, cellCol);
    fragColor = cellHit ? vec4(cellCol, 1.0) : vec4(0.0);
#else
    vec2 px = v_uv * u_resolution;

    // Palette brightness reference: the brightest of the four colors
    float l0 = luma(u_color0), l1 = luma(u_color1), l2 = luma(u_color2), l3 = luma(u_color3);
    float lmax = max(max(l0, l1), max(l2, l3));
    float lmin = min(min(l0, l1), min(l2, l3));
    vec3 brightest = lmax == l0 ? u_color0 : lmax == l1 ? u_color1 : lmax == l2 ? u_color2 : u_color3;

#ifdef ASCII
    float cutL = max(lmax * u_toneCut, 1e-4);
    vec2 cellSize = vec2(u_cell * u_cellAspect, u_cell);
    // Divide after rotating so a wide glyph cell matches the CPU grid.
    vec2 grid = (rot(u_angle) * px) / cellSize;
    vec2 id   = floor(grid);
    vec2 f    = fract(grid);
    vec2 centerPx = rot(-u_angle) * ((id + 0.5) * cellSize);

    vec3 colC = vec3(0.0);
    bool hitC;
#ifdef CELL_READ
    vec4 cached = texture(u_cellMap, (id - u_cellOrigin + 0.5) / u_cellTexSize);
    colC = cached.rgb;
    hitC = cached.a > 0.5;
#else
    hitC = sampleDragon(pxToUV(centerPx), 0.5 * u_cell * pixUV, colC);
#endif

    vec4 ink = vec4(0.0);
    if (hitC) {
        float heat = clamp(heatAt(centerPx), 0.0, 1.0);
        vec3 shown = heatColor(colC, heat);
        float span = max(cutL - lmin, 1e-4);
        float cold = clamp((luma(colC) - lmin) / span, 0.0, 1.0);
        float bright = mix(cold, 1.0, heat * clamp(u_heatLift, 0.0, 1.0));
        float tone = mix(u_glyphMin, 1.0, bright);

        float count = max(u_glyphCount, 1.0);
        float steps = count - 1.0;
        float idx = 0.0;
        if (steps > 0.0) {
            float scaled = clamp(tone, 0.0, 1.0) * steps;
            float jitter = fract(sin(dot(id + vec2(0.5), vec2(127.1, 311.7))) * 43758.5453);
            float pick = mix(0.5, jitter, clamp(u_dither, 0.0, 1.0));
            idx = clamp(floor(scaled + pick), 0.0, steps);
        }
        vec2 glyphUv = vec2((idx + f.x) / count, f.y);
        float mask = texture(u_glyphMap, glyphUv).a;
        vec3 dc = mix(shown, brightest, u_glyphTint * (1.0 - tone));
        ink = vec4(dc * mask, mask);
    }
    fragColor = ink * u_opacity;
#else
    vec2 fragPx = gl_FragCoord.xy;
    float cutL = max(lmax * u_dotCut, 1e-4);

    // ---- Solid layer: the dragon at full resolution (bright parts) ----
    vec3 colSum = vec3(0.0);
    float hits = 0.0;
    int aa = clamp(u_aa, 1, AA_MAX);
    for (int j = 0; j < AA_MAX; j++) {
        if (j >= aa) break;
        for (int i = 0; i < AA_MAX; i++) {
            if (i >= aa) break;
            vec2 o = (vec2(float(i), float(j)) + 0.5) / float(aa) - 0.5;
            vec3 sc;
            if (sampleDragon(pxToUV(px + o), pixUV, sc)) {
                colSum += heatColor(sc, heatAt(fragPx + o));
                hits += 1.0;
            }
        }
    }
    float cover = hits / float(aa * aa);
    vec3 colP = hits > 0.0 ? colSum / hits : vec3(0.0);
    // Same test as the lightest stop: once the lifted ink is that bright,
    // draw the full-resolution curve instead of the halftone.
    float solidP = smoothstep(0.8, 1.0, luma(colP) / cutL);
    float solidW = mix(1.0, solidP, u_dither);
    vec4 solid = vec4(colP * cover, cover) * solidW;

    // ---- Dot layer: one dot per rotated grid cell (dark parts) ----
    vec2 grid = rot(u_angle) * px / u_cell;
    vec2 id   = floor(grid);
    vec2 f    = fract(grid) - 0.5;

    vec3 colC = vec3(0.0);
    bool hitC;
#ifdef CELL_READ
    vec4 cached = texture(u_cellMap, (id - u_cellOrigin + 0.5) / u_cellTexSize);
    colC = cached.rgb;
    hitC = cached.a > 0.5;
#else
    vec2 centerPx = rot(-u_angle) * ((id + 0.5) * u_cell);
    hitC = sampleDragon(pxToUV(centerPx), 0.5 * u_cell * pixUV, colC);
#endif

    vec4 dots = vec4(0.0);
    if (hitC) {
        // Darker ink draws a smaller dot. Hovering mixes that size toward a
        // full dot, and the radius follows the heat back down as it cools.
        float heat = clamp(heatAt(fragPx), 0.0, 1.0);
        vec3 shown = heatColor(colC, heat);
        float span = max(cutL - lmin, 1e-4);
        float cold = clamp((luma(colC) - lmin) / span, 0.0, 1.0);
        float bright = mix(cold, 1.0, heat * clamp(u_heatLift, 0.0, 1.0));
        float tone = mix(u_dotMin, 1.0, bright);
        float radius = tone * 0.5 * u_dot;
        float aa = 1.5 / u_cell;
        float mask = 1.0 - smoothstep(radius - aa, radius + aa, length(f));
        float a = mask * (1.0 - smoothstep(0.8, 1.0, luma(shown) / cutL)) * u_dither;
        vec3 dc = mix(shown, brightest, u_dotTint * (1.0 - tone));
        dots = vec4(dc * a, a);
    }

    // Premultiplied alpha: solid over dots, everything else fully transparent.
    vec4 ink = solid + dots * (1.0 - solid.a);
    fragColor = ink * u_opacity;
#endif
#endif
}
