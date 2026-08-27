export const VERT = `#version 300 es
in vec2 a_pos;
uniform vec2 u_uvScale;
uniform vec2 u_uvOffset;
uniform float u_mirror;
out vec2 v_uv;
out vec2 v_ndc;
void main() {
  v_ndc = a_pos;
  vec2 uv = a_pos * 0.5 + 0.5;
  uv.y = 1.0 - uv.y;                       // video textures arrive top-down
  uv.x = mix(uv.x, 1.0 - uv.x, u_mirror);  // front camera preview is mirrored
  v_uv = uv * u_uvScale + u_uvOffset;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 v_uv;
in vec2 v_ndc;
out vec4 fragColor;

uniform sampler2D u_frame;
uniform sampler3D u_lut;

uniform float u_lutSize;
uniform float u_lutMix;      // 0..1 look intensity
uniform vec3  u_domainMin;
uniform vec3  u_domainMax;

uniform float u_exposure;    // stops
uniform float u_contrast;    // -1..1
uniform float u_saturation;  // -1..1
uniform float u_temp;        // -1..1  (+ warm)
uniform float u_tint;        // -1..1  (+ magenta)
uniform float u_fade;        // 0..1 lifted blacks
uniform float u_sharp;       // 0..1 unsharp amount

uniform float u_grain;       // 0..1
uniform float u_vignette;    // 0..1
uniform float u_halation;    // 0..1
uniform float u_bloomThresh;
uniform float u_seed;
uniform vec2  u_texel;       // 1 / frame resolution

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

vec3 applyLut(vec3 c) {
  vec3 n = clamp((c - u_domainMin) / max(u_domainMax - u_domainMin, vec3(1e-4)), 0.0, 1.0);
  float s = u_lutSize;
  vec3 coord = n * ((s - 1.0) / s) + (0.5 / s);   // half-texel inset
  return texture(u_lut, coord).rgb;
}

float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

void main() {
  vec3 col = texture(u_frame, v_uv).rgb;

  // ── unsharp mask (clarity) ───────────────────────────────
  if (u_sharp > 0.001) {
    vec3 blur =
      texture(u_frame, v_uv + vec2( u_texel.x, 0.0)).rgb +
      texture(u_frame, v_uv + vec2(-u_texel.x, 0.0)).rgb +
      texture(u_frame, v_uv + vec2(0.0,  u_texel.y)).rgb +
      texture(u_frame, v_uv + vec2(0.0, -u_texel.y)).rgb;
    col = clamp(col + (col - blur * 0.25) * u_sharp * 1.4, 0.0, 1.0);
  }

  // ── primary corrections, linear light ────────────────────
  vec3 lin = srgbToLinear(col) * exp2(u_exposure);
  vec3 wb = vec3(1.0 + 0.42 * u_temp + 0.02 * u_tint,
                 1.0 - 0.10 * abs(u_temp) - 0.30 * u_tint,
                 1.0 - 0.38 * u_temp + 0.06 * u_tint);
  wb /= max(dot(wb, LUMA), 1e-4);
  lin *= wb;

  // ── halation: warm glow bleeding out of the highlights ───
  if (u_halation > 0.001) {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7853981634;
      vec2 o = vec2(cos(a), sin(a)) * u_texel * 6.0;
      acc += srgbToLinear(texture(u_frame, v_uv + o).rgb);
    }
    acc /= 8.0;
    vec3 hi = max(acc - u_bloomThresh, 0.0);
    lin += hi * vec3(1.0, 0.42, 0.22) * u_halation * 1.6;
  }

  col = clamp(linearToSrgb(lin), 0.0, 1.0);

  // contrast around a filmic pivot
  col = clamp((col - 0.44) * (1.0 + u_contrast) + 0.44, 0.0, 1.0);

  // ── the look ─────────────────────────────────────────────
  col = mix(col, clamp(applyLut(col), 0.0, 1.0), u_lutMix);

  // saturation
  float l = dot(col, LUMA);
  col = clamp(mix(vec3(l), col, 1.0 + u_saturation), 0.0, 1.0);

  // fade / lifted blacks
  col = mix(col, col * 0.65 + 0.13, u_fade);

  // ── vignette ─────────────────────────────────────────────
  if (u_vignette > 0.001) {
    float d = length(v_ndc * vec2(1.0, 1.0)) * 0.72;
    float v = smoothstep(1.02, 0.34, d);
    col *= mix(1.0, v, u_vignette);
  }

  // ── grain, scaled so it sits in the mids like film ───────
  if (u_grain > 0.001) {
    float n = hash(gl_FragCoord.xy + u_seed) - 0.5;
    float lum = dot(col, LUMA);
    float weight = 1.0 - abs(lum - 0.45) * 1.25;
    col += n * u_grain * 0.16 * max(weight, 0.15);
  }

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
