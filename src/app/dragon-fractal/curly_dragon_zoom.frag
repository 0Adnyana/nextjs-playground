// Curly dragon infinite zoom, with a transparent background
// The camera zooms forever into the dragon's tip. Because the dragon is made of
// smaller copies of itself, new curls keep growing out of the center endlessly.
// Darker colors are drawn as a rotated halftone: one crisp dot per grid cell,
// sized by how bright the dragon is at that cell's center. Lighter colors are
// drawn solid. Hovering paints a heat field that cools and spreads; as it
// lifts the ink, the halftone gives way to the solid curve.

// ---- Tweakable settings ----
uniform vec3  u_color0;  // color #030d19
uniform vec3  u_color1;  // color #05172e
uniform vec3  u_color2;  // color #4790f0
uniform vec3  u_color3;  // color #082244
uniform float u_apexX;   // 0.40, 0.65, 0.60
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
uniform float u_line;    // 0.31, 4.0, 0.60
uniform float u_opacity; // 0.0, 1.0, 1.0

// ---- Halftone ----
uniform float u_dither;  // 0.0, 1.0, 1.0
uniform float u_cell;    // 4.0, 48.0, 6.4
uniform float u_dot;     // 0.2, 2.0, 1.73
uniform float u_angle;   // 0.0, 6.28, 2.25
uniform float u_dotCut;  // 0.05, 1.0, 1.0
uniform float u_dotMin;  // 0.0, 1.0, 0.29
uniform float u_dotTint; // 0.0, 1.0, 0.0

// ---- Heat ----
// Screen-space field. Radius, dissipate, and spread drive it each frame.
// Lift mixes toward the heat color before the halftone test, so lighter ink
// is drawn solid instead of as dots.
uniform vec3  u_heatColor;     // color #adc9ed
uniform float u_heatRadius;    // 0.02, 0.80, 0.10
uniform float u_heatDissipate; // 0.0, 3.0, 0.20
uniform float u_heatSpread;    // 0.0, 8.0, 8.0
uniform float u_heatLift;      // 0.0, 1.0, 1.0

// ---- Quality ----
const int MAX_DEPTH = 24;   // detail cap
const int BUDGET    = 800;  // search steps per sample
const int AA        = 2;    // 1 = fastest, 2 = smooth edges
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

vec3 gradientMap(float x) {
    x = fract(x) * 4.0;
    float f = smoothstep(0.0, 1.0, fract(x));
    int i = int(floor(x));
    vec3 a, b;
    if (i == 0)      { a = u_color0; b = u_color1; }
    else if (i == 1) { a = u_color1; b = u_color2; }
    else if (i == 2) { a = u_color2; b = u_color3; }
    else             { a = u_color3; b = u_color0; }
    return mix(a, b, f);
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float heatAt(vec2 screenPx) {
    return texture(u_heatMap, screenPx / u_resolution).r;
}

// Lift runs before the solid-versus-dot test. A color that becomes light
// takes the solid path; the dots fade out over the same threshold.
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
    gR = bound(gA, gC);
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

    vec2 px = v_uv * u_resolution;
    vec2 fragPx = gl_FragCoord.xy;
    float pixUV = 2.0 / u_resolution.y; // one screen pixel in uv units

    // Palette brightness reference: the brightest of the four colors
    float l0 = luma(u_color0), l1 = luma(u_color1), l2 = luma(u_color2), l3 = luma(u_color3);
    float lmax = max(max(l0, l1), max(l2, l3));
    vec3 brightest = lmax == l0 ? u_color0 : lmax == l1 ? u_color1 : lmax == l2 ? u_color2 : u_color3;
    float cutL = max(lmax * u_dotCut, 1e-4);

    // ---- Solid layer: the dragon at full resolution (bright parts) ----
    vec3 colSum = vec3(0.0);
    float hits = 0.0;
    for (int j = 0; j < AA; j++) {
        for (int i = 0; i < AA; i++) {
            vec2 o = (vec2(float(i), float(j)) + 0.5) / float(AA) - 0.5;
            vec3 sc;
            if (sampleDragon(pxToUV(px + o), pixUV, sc)) {
                colSum += heatColor(sc, heatAt(fragPx + o));
                hits += 1.0;
            }
        }
    }
    float cover = hits / float(AA * AA);
    vec3 colP = hits > 0.0 ? colSum / hits : vec3(0.0);
    float solidP = smoothstep(0.8, 1.0, luma(colP) / cutL);
    float solidW = mix(1.0, solidP, u_dither);
    vec4 solid = vec4(colP * cover, cover) * solidW;

    // ---- Dot layer: one dot per rotated grid cell (dark parts) ----
    vec2 grid = rot(u_angle) * px / u_cell;
    vec2 id   = floor(grid);
    vec2 f    = fract(grid) - 0.5;
    vec2 centerPx = rot(-u_angle) * ((id + 0.5) * u_cell);

    vec3 colC;
    bool hitC = sampleDragon(pxToUV(centerPx), 0.5 * u_cell * pixUV, colC);

    vec4 dots = vec4(0.0);
    if (hitC) {
        // Dot size stays with the unheated ink. Presence follows the lifted
        // color, so a pixel that has become light loses its dot.
        float tone = mix(u_dotMin, 1.0, clamp(luma(colC) / cutL, 0.0, 1.0));
        float radius = tone * 0.5 * u_dot;
        float aa = 1.5 / u_cell;
        float mask = 1.0 - smoothstep(radius - aa, radius + aa, length(f));
        vec3 shown = heatColor(colC, heatAt(fragPx));
        float lr = luma(shown) / cutL;
        float a = mask * (1.0 - smoothstep(0.8, 1.0, lr)) * u_dither;
        vec3 dc = mix(shown, brightest, u_dotTint * (1.0 - tone));
        dots = vec4(dc * a, a);
    }

    // Premultiplied alpha: solid over dots, everything else fully transparent.
    vec4 ink = solid + dots * (1.0 - solid.a);
    fragColor = ink * u_opacity;
}
