import { VERT, FRAG } from './shaders.js';
import { toRGBA8 } from '../lut/cube.js';

/**
 * WebGL2 preview/capture pipeline.
 *
 * One quad, one video texture, one 3D LUT texture. The same renderer draws the
 * live viewfinder, the filmstrip thumbnails and the full-resolution capture —
 * so what you see is exactly what gets written to the JPEG.
 */
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const opts = {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false,
      powerPreference: 'high-performance', desynchronized: true,
    };
    const gl = canvas.getContext('webgl2', opts);
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;

    this.program = link(gl, VERT, FRAG);
    gl.useProgram(this.program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, 'a_pos');
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.u = {};
    for (const n of [
      'u_frame','u_lut','u_lutSize','u_lutMix','u_domainMin','u_domainMax',
      'u_exposure','u_contrast','u_saturation','u_temp','u_tint','u_fade','u_sharp',
      'u_grain','u_vignette','u_halation','u_bloomThresh','u_seed','u_texel',
      'u_uvScale','u_uvOffset','u_mirror',
    ]) this.u[n] = gl.getUniformLocation(this.program, n);

    // frame texture
    this.frameTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    for (const [k, v] of [
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    ]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.uniform1i(this.u.u_frame, 0);
    gl.uniform1i(this.u.u_lut, 1);

    this.lutTextures = new Map();   // id -> { tex, size, domainMin, domainMax }
    this.activeLut = null;
    this.frameSize = [1, 1];

    this.params = {
      lutMix: 1, exposure: 0, contrast: 0, saturation: 0, temp: 0, tint: 0,
      fade: 0, sharp: 0, grain: 0, vignette: 0, halation: 0, bloomThresh: 0.72,
    };

    this.setLut('__identity__', identityLutData(2));
  }

  /** Upload (or replace) a LUT under an id. `lut` is a parsed LUT object. */
  setLut(id, lut) {
    const gl = this.gl;
    let entry = this.lutTextures.get(id);
    if (!entry) {
      entry = { tex: gl.createTexture(), size: lut.size };
      this.lutTextures.set(id, entry);
    }
    entry.size = lut.size;
    entry.domainMin = lut.domainMin || [0, 0, 0];
    entry.domainMax = lut.domainMax || [1, 1, 1];

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, entry.tex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R])
      gl.texParameteri(gl.TEXTURE_3D, k, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(
      gl.TEXTURE_3D, 0, gl.RGBA8, lut.size, lut.size, lut.size, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, toRGBA8(lut)
    );
    if (!this.activeLut) this.useLut(id);
    return entry;
  }

  hasLut(id) { return this.lutTextures.has(id); }

  useLut(id) {
    if (!this.lutTextures.has(id)) return false;
    this.activeLut = id;
    return true;
  }

  dropLut(id) {
    const e = this.lutTextures.get(id);
    if (!e) return;
    this.gl.deleteTexture(e.tex);
    this.lutTextures.delete(id);
    if (this.activeLut === id) this.activeLut = '__identity__';
  }

  resize(w, h) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** Upload a video frame / image / canvas as the source texture. */
  uploadFrame(source, width, height) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.frameSize = [width || source.videoWidth || source.width || 1,
                      height || source.videoHeight || source.height || 1];
  }

  /**
   * Draw the current frame.
   * @param {object} o
   * @param {number} o.aspect  target aspect (w/h) of the output surface
   * @param {number} o.zoom    digital zoom (1 = none)
   * @param {boolean} o.mirror mirror horizontally (front camera)
   * @param {string}  o.lutId  override the active LUT for this draw
   * @param {number}  o.mix    override look intensity for this draw
   * @param {number[]} o.viewport [x,y,w,h] to draw a tile instead of the full canvas
   */
  draw(o = {}) {
    const gl = this.gl;
    const p = this.params;
    const id = o.lutId || this.activeLut || '__identity__';
    const lut = this.lutTextures.get(id) || this.lutTextures.get('__identity__');

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    const vp = o.viewport;
    if (vp) gl.viewport(vp[0], vp[1], vp[2], vp[3]);
    else gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, lut.tex);

    // centre-crop the source to the requested aspect, then apply digital zoom
    const [fw, fh] = this.frameSize;
    const target = o.aspect || this.canvas.width / this.canvas.height;
    const src = fw / fh;
    let sx = 1, sy = 1;
    if (src > target) sx = target / src; else sy = src / target;
    const z = Math.max(1, o.zoom || 1);
    sx /= z; sy /= z;
    gl.uniform2f(this.u.u_uvScale, sx, sy);
    gl.uniform2f(this.u.u_uvOffset, (1 - sx) / 2, (1 - sy) / 2);
    gl.uniform1f(this.u.u_mirror, o.mirror ? 1 : 0);

    gl.uniform1f(this.u.u_lutSize, lut.size);
    gl.uniform1f(this.u.u_lutMix, o.mix != null ? o.mix : p.lutMix);
    gl.uniform3fv(this.u.u_domainMin, lut.domainMin || [0, 0, 0]);
    gl.uniform3fv(this.u.u_domainMax, lut.domainMax || [1, 1, 1]);

    gl.uniform1f(this.u.u_exposure, p.exposure);
    gl.uniform1f(this.u.u_contrast, p.contrast);
    gl.uniform1f(this.u.u_saturation, p.saturation);
    gl.uniform1f(this.u.u_temp, p.temp);
    gl.uniform1f(this.u.u_tint, p.tint);
    gl.uniform1f(this.u.u_fade, p.fade);
    gl.uniform1f(this.u.u_sharp, p.sharp);
    gl.uniform1f(this.u.u_grain, o.grain != null ? o.grain : p.grain);
    gl.uniform1f(this.u.u_vignette, p.vignette);
    gl.uniform1f(this.u.u_halation, p.halation);
    gl.uniform1f(this.u.u_bloomThresh, p.bloomThresh);
    gl.uniform1f(this.u.u_seed, (performance.now() % 1000) * 0.37);
    gl.uniform2f(this.u.u_texel, 1 / Math.max(fw, 1), 1 / Math.max(fh, 1));

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Render once at an explicit size and hand back the GL canvas (same tick). */
  renderTo(width, height, opts) {
    this.resize(width, height);
    this.draw({ ...opts, aspect: width / height });
    return this.canvas;
  }

  destroy() {
    const gl = this.gl;
    for (const [, e] of this.lutTextures) gl.deleteTexture(e.tex);
    this.lutTextures.clear();
    gl.deleteTexture(this.frameTex);
    gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile failed: ' + log);
  }
  return sh;
}

function link(gl, vs, fs) {
  const p = gl.createProgram();
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v); gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v); gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

function identityLutData(size) {
  const data = new Float32Array(size ** 3 * 3);
  let p = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        data[p++] = r / (size - 1); data[p++] = g / (size - 1); data[p++] = b / (size - 1);
      }
  return { size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] };
}
