/* ─────────────────────────────────────────────
   東墨 EastInk · 道生一 — 水墨流体引擎
   WebGL stable-fluids (Stam 1999 + Harris GPU Gems 38)
   solver architecture inspired by
   PavelDoGreat/WebGL-Fluid-Simulation (MIT, © 2017 Pavel Dobryakov)
   —— 自有实现；渲染为「墨吸进宣纸」逐通道光学吸收，非黑底发光烟雾。

   每帧 pass：curl → vorticity → divergence → clear → pressure×N
              → gradientSubtract → advect(vel) → advect(dye)
   合成：color = paper * exp(-K · dye)，K = -log(pigment)；墨缘 granulation。
   道生一开场 + 自动演墨 + 涤净洗卷 + 近空白自动开新卷（生生不息）。
   运行时零外部请求。
   ───────────────────────────────────────────── */
(function () {
  'use strict';

  var canvas = document.getElementById('stage');
  var poster = document.getElementById('poster');
  var dock = document.getElementById('dock');
  var labelEl = document.getElementById('evolveLabel');
  var metaEl = document.getElementById('scrollMeta');
  if (!canvas) return;

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var isMobile = window.matchMedia('(max-width: 760px)').matches;

  /* ── reduced-motion：不跑模拟，静态海报 + 标签静态 ── */
  if (reduced) {
    canvas.style.display = 'none';
    if (dock) dock.style.display = 'none';
    if (poster) {
      poster.hidden = false;
      var pn = poster.querySelector('.poster-note');
      if (pn) pn.textContent = '道生一，一生二，二生三，三生万物。';
    }
    return;
  }

  /* ──────────────────────────────────────────
     1. GL 上下文 + 扩展降级链（WebGL2 优先）
     ────────────────────────────────────────── */
  var params = { alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };
  var gl = canvas.getContext('webgl2', params);
  var isWebGL2 = !!gl;
  if (!gl) {
    gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);
  }

  function bail() {
    canvas.style.display = 'none';
    if (dock) dock.style.display = 'none';
    if (metaEl) metaEl.style.display = 'none';
    if (poster) poster.hidden = false;
  }
  if (!gl) { bail(); return; }

  var halfFloat, supportLinear;
  if (isWebGL2) {
    gl.getExtension('EXT_color_buffer_float');
    supportLinear = !!gl.getExtension('OES_texture_float_linear');
  } else {
    halfFloat = gl.getExtension('OES_texture_half_float');
    supportLinear = !!gl.getExtension('OES_texture_half_float_linear');
  }
  // half-float 类型常量：WebGL2 用 HALF_FLOAT；老 iOS WebGL1 用 HALF_FLOAT_OES(0x8D61)
  var halfFloatType = isWebGL2 ? gl.HALF_FLOAT : (halfFloat ? halfFloat.HALF_FLOAT_OES : null);
  if (!isWebGL2 && !halfFloat) { bail(); return; }

  /* 探测可渲染内部格式（iOS RG 不一定可渲染：RG16F→RGBA16F→RGBA 回退） */
  function getSupportedFormat(internalFormat, format) {
    if (!supportRenderTextureFormat(internalFormat, format)) {
      if (isWebGL2) {
        if (internalFormat === gl.R16F) return getSupportedFormat(gl.RG16F, gl.RG);
        if (internalFormat === gl.RG16F) return getSupportedFormat(gl.RGBA16F, gl.RGBA);
      }
      return null;
    }
    return { internalFormat: internalFormat, format: format };
  }
  function supportRenderTextureFormat(internalFormat, format) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, halfFloatType, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.deleteTexture(tex); gl.deleteFramebuffer(fbo);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return status;
  }

  var fmtRGBA, fmtRG, fmtR;
  if (isWebGL2) {
    fmtRGBA = getSupportedFormat(gl.RGBA16F, gl.RGBA);
    fmtRG = getSupportedFormat(gl.RG16F, gl.RG);
    fmtR = getSupportedFormat(gl.R16F, gl.RED);
  } else {
    fmtRGBA = getSupportedFormat(gl.RGBA, gl.RGBA);
    fmtRG = fmtRGBA;
    fmtR = fmtRGBA;
  }
  if (!fmtRGBA) { bail(); return; }

  /* ──────────────────────────────────────────
     2. 颜料（authentic 国画矿物色）
        K = -log(pigment) 给逐通道光学吸收
     ────────────────────────────────────────── */
  // hex → 线性 0..1（这里直接当作反射率近似，不做 sRGB→linear，雅度靠手调 hex）
  function hexRGB(hex) {
    return [
      parseInt(hex.slice(1, 3), 16) / 255,
      parseInt(hex.slice(3, 5), 16) / 255,
      parseInt(hex.slice(5, 7), 16) / 255
    ];
  }
  // 颜料的吸收系数 K = -log(reflectance)，clamp 防 log(0)
  function pigmentK(hex, scale) {
    var c = hexRGB(hex);
    return [
      -Math.log(Math.max(c[0], 0.02)) * scale,
      -Math.log(Math.max(c[1], 0.02)) * scale,
      -Math.log(Math.max(c[2], 0.02)) * scale
    ];
  }
  // 五矿色：玄墨 / 朱砂 / 石青 / 石绿 / 藤黄
  // K 缩放各异：玄墨偏高（一色而墨分五色），矿物色偏雅不脏
  var PIGMENTS = [
    { id: 'xuanmo',  name: '玄墨', hex: '#1a1a18', K: pigmentK('#1a1a18', 1.15) },
    { id: 'zhusha',  name: '朱砂', hex: '#c8442e', K: pigmentK('#c8442e', 0.95) },
    { id: 'shiqing', name: '石青', hex: '#2e5a8f', K: pigmentK('#2e5a8f', 0.95) },
    { id: 'shilv',   name: '石绿', hex: '#3f8f6a', K: pigmentK('#3f8f6a', 0.95) },
    { id: 'tenghuang', name: '藤黄', hex: '#e0a82e', K: pigmentK('#e0a82e', 1.0) }
  ];
  var currentPigment = 1; // 朱砂默认；道生一首滴用玄墨

  /* ──────────────────────────────────────────
     3. 模拟配置（slow / viscous / graceful ink）
     ────────────────────────────────────────── */
  var SIM_RES = isMobile ? 96 : 128;
  var DYE_RES = isMobile ? 480 : 720;
  var RENDER_SCALE = isMobile ? 0.6 : 0.85;
  var config = {
    DENSITY_DISSIPATION: 0.34,   // 墨耗散：~60–90s 归近白
    VELOCITY_DISSIPATION: 0.2,
    PRESSURE: 0.8,
    PRESSURE_ITERATIONS: isMobile ? 16 : 30,
    CURL: 12,                    // 适中漩涡，非烟雾
    SPLAT_RADIUS: 0.15,
    SPLAT_FORCE: 3500
  };
  var washing = 0;               // 涤净进度（>0 时加速耗散 + 水流扫过）

  /* ──────────────────────────────────────────
     4. shader 编译 / 程序封装
     ────────────────────────────────────────── */
  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('shader: ' + gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }
  function program(vsSrc, fsSrc) {
    var vs = compile(gl.VERTEX_SHADER, vsSrc);
    var fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;
    var p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('link: ' + gl.getProgramInfoLog(p));
      return null;
    }
    var uniforms = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var name = gl.getActiveUniform(p, i).name;
      uniforms[name] = gl.getUniformLocation(p, name);
    }
    return { program: p, uniforms: uniforms };
  }

  // WebGL2 走 #version 300 es 会改语法；为最大兼容统一用 GLSL ES 1.00
  // （WebGL2 上下文亦完全支持 1.00），manual bilinear 作为通用安全路径。
  var BASE_VERT = [
    'precision highp float;',
    'attribute vec2 aPos;',
    'varying vec2 vUv;',
    'varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
    'uniform vec2 texelSize;',
    'void main(){',
    '  vUv = aPos * 0.5 + 0.5;',
    '  vL = vUv - vec2(texelSize.x, 0.0);',
    '  vR = vUv + vec2(texelSize.x, 0.0);',
    '  vT = vUv + vec2(0.0, texelSize.y);',
    '  vB = vUv - vec2(0.0, texelSize.y);',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  var HEADER_F = 'precision highp float; precision highp sampler2D;\n';

  // manual bilinear（无 linear filter 时用；advection 与合成需要平滑读取）
  var BILERP = [
    'vec4 bilerp(sampler2D tex, vec2 uv, vec2 ts){',
    '  vec2 st = uv / ts - 0.5;',
    '  vec2 iuv = floor(st);',
    '  vec2 fuv = fract(st);',
    '  vec4 a = texture2D(tex, (iuv + vec2(0.5, 0.5)) * ts);',
    '  vec4 b = texture2D(tex, (iuv + vec2(1.5, 0.5)) * ts);',
    '  vec4 c = texture2D(tex, (iuv + vec2(0.5, 1.5)) * ts);',
    '  vec4 d = texture2D(tex, (iuv + vec2(1.5, 1.5)) * ts);',
    '  return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);',
    '}'
  ].join('\n');

  var SPLAT_FRAG = HEADER_F + [
    'varying vec2 vUv;',
    'uniform sampler2D uTarget;',
    'uniform float aspectRatio;',
    'uniform vec3 color;',
    'uniform vec2 point;',
    'uniform float radius;',
    'void main(){',
    '  vec2 p = vUv - point.xy;',
    '  p.x *= aspectRatio;',
    '  vec3 splat = exp(-dot(p, p) / radius) * color;',
    '  vec3 base = texture2D(uTarget, vUv).xyz;',
    '  gl_FragColor = vec4(base + splat, 1.0);',
    '}'
  ].join('\n');

  var ADVECT_FRAG = HEADER_F + (supportLinear ? '' : '#define MANUAL\n') +
    (supportLinear ? '' : BILERP) + [
    'varying vec2 vUv;',
    'uniform sampler2D uVelocity;',
    'uniform sampler2D uSource;',
    'uniform vec2 texelSize;',
    'uniform vec2 dyeTexelSize;',
    'uniform float dt;',
    'uniform float dissipation;',
    'vec4 sampleSrc(vec2 uv){',
    '#ifdef MANUAL',
    '  return bilerp(uSource, uv, dyeTexelSize);',
    '#else',
    '  return texture2D(uSource, uv);',
    '#endif',
    '}',
    'vec2 sampleVel(vec2 uv){',
    '#ifdef MANUAL',
    '  return bilerp(uVelocity, uv, texelSize).xy;',
    '#else',
    '  return texture2D(uVelocity, uv).xy;',
    '#endif',
    '}',
    'void main(){',
    '  vec2 coord = vUv - dt * sampleVel(vUv) * texelSize;',
    '  vec4 result = sampleSrc(coord);',
    '  float decay = 1.0 + dissipation * dt;',
    '  gl_FragColor = result / decay;',
    '}'
  ].join('\n');

  var DIVERGENCE_FRAG = HEADER_F + [
    'varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
    'uniform sampler2D uVelocity;',
    'void main(){',
    '  float L = texture2D(uVelocity, vL).x;',
    '  float R = texture2D(uVelocity, vR).x;',
    '  float T = texture2D(uVelocity, vT).y;',
    '  float B = texture2D(uVelocity, vB).y;',
    '  vec2 C = texture2D(uVelocity, vUv).xy;',
    '  if (vL.x < 0.0) { L = -C.x; }',
    '  if (vR.x > 1.0) { R = -C.x; }',
    '  if (vT.y > 1.0) { T = -C.y; }',
    '  if (vB.y < 0.0) { B = -C.y; }',
    '  float div = 0.5 * (R - L + T - B);',
    '  gl_FragColor = vec4(div, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var CURL_FRAG = HEADER_F + [
    'varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
    'uniform sampler2D uVelocity;',
    'void main(){',
    '  float L = texture2D(uVelocity, vL).y;',
    '  float R = texture2D(uVelocity, vR).y;',
    '  float T = texture2D(uVelocity, vT).x;',
    '  float B = texture2D(uVelocity, vB).x;',
    '  float curl = R - L - T + B;',
    '  gl_FragColor = vec4(0.5 * curl, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var VORTICITY_FRAG = HEADER_F + [
    'varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
    'uniform sampler2D uVelocity;',
    'uniform sampler2D uCurl;',
    'uniform float curl;',
    'uniform float dt;',
    'void main(){',
    '  float L = texture2D(uCurl, vL).x;',
    '  float R = texture2D(uCurl, vR).x;',
    '  float T = texture2D(uCurl, vT).x;',
    '  float B = texture2D(uCurl, vB).x;',
    '  float C = texture2D(uCurl, vUv).x;',
    '  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));',
    '  force /= length(force) + 0.0001;',
    '  force *= curl * C;',
    '  force.y *= -1.0;',
    '  vec2 vel = texture2D(uVelocity, vUv).xy;',
    '  gl_FragColor = vec4(vel + force * dt, 0.0, 1.0);',
    '}'
  ].join('\n');

  var PRESSURE_FRAG = HEADER_F + [
    'varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
    'uniform sampler2D uPressure;',
    'uniform sampler2D uDivergence;',
    'void main(){',
    '  float L = texture2D(uPressure, vL).x;',
    '  float R = texture2D(uPressure, vR).x;',
    '  float T = texture2D(uPressure, vT).x;',
    '  float B = texture2D(uPressure, vB).x;',
    '  float divergence = texture2D(uDivergence, vUv).x;',
    '  float pressure = (L + R + B + T - divergence) * 0.25;',
    '  gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var CLEAR_FRAG = HEADER_F + [
    'varying vec2 vUv;',
    'uniform sampler2D uTexture;',
    'uniform float value;',
    'void main(){ gl_FragColor = value * texture2D(uTexture, vUv); }'
  ].join('\n');

  var GRADIENT_FRAG = HEADER_F + [
    'varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
    'uniform sampler2D uPressure;',
    'uniform sampler2D uVelocity;',
    'void main(){',
    '  float L = texture2D(uPressure, vL).x;',
    '  float R = texture2D(uPressure, vR).x;',
    '  float T = texture2D(uPressure, vT).x;',
    '  float B = texture2D(uPressure, vB).x;',
    '  vec2 velocity = texture2D(uVelocity, vUv).xy;',
    '  velocity.xy -= vec2(R - L, T - B);',
    '  gl_FragColor = vec4(velocity, 0.0, 1.0);',
    '}'
  ].join('\n');

  /* ── 合成 pass：宣纸 fbm 纤维 + 逐通道光学吸收 + 墨缘 granulation ── */
  var DISPLAY_FRAG = HEADER_F + (supportLinear ? '' : '#define MANUAL\n') +
    (supportLinear ? '' : BILERP) + [
    'varying vec2 vUv;',
    'uniform sampler2D uDye;',     // RGB = 累计颜料浓度（已乘各自 K 后求和存入）
    'uniform vec2 dyeTexelSize;',
    'uniform float aspectRatio;',
    'uniform float wash;',         // 涤净水流相位 0..1
    'uniform float washX;',        // 水流扫过的横向位置
    // 程序化纤维噪声
    'float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}',
    'float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);float a=hash(i),b=hash(i+vec2(1.0,0.0)),c=hash(i+vec2(0.0,1.0)),d=hash(i+vec2(1.0,1.0));vec2 u=f*f*(3.0-2.0*f);return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);}',
    'float fbm(vec2 p){float s=0.0,a=0.5;mat2 R=mat2(0.8,0.62,-0.62,0.8);for(int i=0;i<4;i++){s+=a*vnoise(p);p=R*p*2.03;a*=0.5;}return s;}',
    'vec3 sampleDye(vec2 uv){',
    '#ifdef MANUAL',
    '  return bilerp(uDye, uv, dyeTexelSize).rgb;',
    '#else',
    '  return texture2D(uDye, uv).rgb;',
    '#endif',
    '}',
    'void main(){',
    '  vec2 uv = vUv;',
    // 宣纸底：暖白 + fbm 纤维纹理（极轻）+ 四角 vignette 留白
    '  vec3 paper = vec3(0.980, 0.969, 0.941);',
    '  float fiber = fbm(uv * vec2(aspectRatio, 1.0) * 380.0);',     // 细密纸纹
    '  float blotch = fbm(uv * vec2(aspectRatio, 1.0) * 6.0);',      // 大尺度纸色不均
    '  paper -= (fiber - 0.5) * 0.018;',
    '  paper -= (blotch - 0.5) * 0.012;',
    '  float vig = smoothstep(1.35, 0.35, length((uv - 0.5) * vec2(1.0, 1.08)));',
    '  paper = mix(paper * 0.985, paper, 0.5 + 0.5 * vig);',          // 边缘略沉，中心亮（留白）
    // 累计吸收 K·dye（dye 已存 sum(K_i * concentration_i)）
    '  vec3 absK = sampleDye(uv);',
    // 墨缘 granulation：邻域密度梯度大处加深吸收（墨边比中心深）
    '  float dC = length(absK);',
    '  vec2 e = dyeTexelSize * 2.0;',
    '  float dL = length(sampleDye(uv - vec2(e.x, 0.0)));',
    '  float dR = length(sampleDye(uv + vec2(e.x, 0.0)));',
    '  float dT = length(sampleDye(uv + vec2(0.0, e.y)));',
    '  float dB = length(sampleDye(uv - vec2(0.0, e.y)));',
    '  float grad = abs(dR - dL) + abs(dT - dB);',
    '  absK *= 1.0 + grad * 1.6;',                                    // 边缘加深
    // 涤净：一道水流横扫，扫过处吸收被冲淡
    '  if (wash > 0.0) {',
    '    float band = smoothstep(0.16, 0.0, abs(uv.x - washX));',
    '    absK *= 1.0 - band * 0.9 * wash;',
    '    absK *= 1.0 - wash * 0.25;',
    '  }',
    // 逐通道光学吸收：color = paper * exp(-absK)
    '  vec3 col = paper * exp(-absK);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var splatPrg = program(BASE_VERT, SPLAT_FRAG);
  var advectPrg = program(BASE_VERT, ADVECT_FRAG);
  var divergencePrg = program(BASE_VERT, DIVERGENCE_FRAG);
  var curlPrg = program(BASE_VERT, CURL_FRAG);
  var vorticityPrg = program(BASE_VERT, VORTICITY_FRAG);
  var pressurePrg = program(BASE_VERT, PRESSURE_FRAG);
  var clearPrg = program(BASE_VERT, CLEAR_FRAG);
  var gradientPrg = program(BASE_VERT, GRADIENT_FRAG);
  var displayPrg = program(BASE_VERT, DISPLAY_FRAG);
  if (!splatPrg || !advectPrg || !divergencePrg || !curlPrg || !vorticityPrg ||
      !pressurePrg || !clearPrg || !gradientPrg || !displayPrg) { bail(); return; }

  /* ── 全屏三角形 ── */
  var quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  function blit(target) {
    if (target == null) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.width, target.height);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function bindQuad(prg) {
    gl.useProgram(prg.program);
    var loc = gl.getAttribLocation(prg.program, 'aPos');
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  /* ──────────────────────────────────────────
     5. FBO / doubleFBO
     ────────────────────────────────────────── */
  function createFBO(w, h, fmt, filter) {
    var tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internalFormat, w, h, 0, fmt.format, halfFloatType, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      texture: tex, fbo: fbo, width: w, height: h,
      texelSizeX: 1.0 / w, texelSizeY: 1.0 / h,
      attach: function (id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, tex); return id; },
      destroy: function () { gl.deleteTexture(tex); gl.deleteFramebuffer(fbo); }
    };
  }
  function createDouble(w, h, fmt, filter) {
    var fbo1 = createFBO(w, h, fmt, filter);
    var fbo2 = createFBO(w, h, fmt, filter);
    return {
      width: w, height: h, texelSizeX: 1.0 / w, texelSizeY: 1.0 / h,
      get read() { return fbo1; },
      get write() { return fbo2; },
      swap: function () { var t = fbo1; fbo1 = fbo2; fbo2 = t; },
      destroy: function () { fbo1.destroy(); fbo2.destroy(); }
    };
  }

  var filtering = supportLinear ? gl.LINEAR : gl.NEAREST;
  var velocity, dye, divergence, curl, pressure;

  function initFramebuffers() {
    if (velocity) {
      [velocity, dye, pressure].forEach(function (d) { d.destroy(); });
      [divergence, curl].forEach(function (f) { f.destroy(); });
    }
    var simRes = getRes(SIM_RES);
    var dyeRes = getRes(DYE_RES);
    velocity = createDouble(simRes.w, simRes.h, fmtRG, filtering);
    dye = createDouble(dyeRes.w, dyeRes.h, fmtRGBA, filtering);
    divergence = createFBO(simRes.w, simRes.h, fmtR, gl.NEAREST);
    curl = createFBO(simRes.w, simRes.h, fmtR, gl.NEAREST);
    pressure = createDouble(simRes.w, simRes.h, fmtR, gl.NEAREST);
  }
  function getRes(res) {
    var aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspect < 1) aspect = 1.0 / aspect;
    var min = Math.round(res);
    var max = Math.round(res * aspect);
    if (gl.drawingBufferWidth > gl.drawingBufferHeight) return { w: max, h: min };
    return { w: min, h: max };
  }

  /* ──────────────────────────────────────────
     6. resize（DPR 上限 2，FBO 重建）
     ────────────────────────────────────────── */
  function resizeCanvas() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.floor(window.innerWidth * dpr * RENDER_SCALE));
    var h = Math.max(1, Math.floor(window.innerHeight * dpr * RENDER_SCALE));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      return true;
    }
    return false;
  }
  resizeCanvas();
  initFramebuffers();

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (resizeCanvas()) initFramebuffers();   // 重建 FBO
    }, 180);
  });

  /* ──────────────────────────────────────────
     7. splat（落墨 / 搅墨）
        颜料以「K·浓度」累加进 dye 纹理：合成端直接 exp(-sum)
     ────────────────────────────────────────── */
  function splat(x, y, dx, dy, pigIdx, concentration) {
    var pig = PIGMENTS[pigIdx];
    var aspect = canvas.width / canvas.height;
    // 速度注入
    bindQuad(splatPrg);
    gl.uniform1i(splatPrg.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatPrg.uniforms.aspectRatio, aspect);
    gl.uniform2f(splatPrg.uniforms.point, x, y);
    gl.uniform3f(splatPrg.uniforms.color, dx, dy, 0.0);
    gl.uniform1f(splatPrg.uniforms.radius, correctRadius(config.SPLAT_RADIUS / 100.0));
    blit(velocity.write); velocity.swap();
    // 颜料注入：存 K * 浓度（合成端做 exp(-absK)）
    gl.uniform1i(splatPrg.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(splatPrg.uniforms.color,
      pig.K[0] * concentration, pig.K[1] * concentration, pig.K[2] * concentration);
    blit(dye.write); dye.swap();
  }
  function correctRadius(r) {
    var aspect = canvas.width / canvas.height;
    if (aspect > 1) r *= aspect;
    return r;
  }

  /* 一次落墨：带向下初速度（墨柱感）。fromTop=true 走强向下羽流。 */
  function dropInk(x, y, pigIdx, opts) {
    opts = opts || {};
    var conc = opts.concentration != null ? opts.concentration : 0.9;
    var force = opts.force != null ? opts.force : config.SPLAT_FORCE;
    var dxBias = opts.dx != null ? opts.dx : (Math.random() - 0.5) * 400;
    var dyDown = opts.dy != null ? opts.dy : -force; // y 向下（UV y 向上，故负）
    splat(x, y, dxBias, dyDown, pigIdx, conc);
  }

  /* ──────────────────────────────────────────
     8. step（一帧完整求解）
     ────────────────────────────────────────── */
  function step(dt) {
    var vRead = velocity.read;
    // curl
    bindQuad(curlPrg);
    gl.uniform2f(curlPrg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlPrg.uniforms.uVelocity, vRead.attach(0));
    blit(curl);
    // vorticity
    bindQuad(vorticityPrg);
    gl.uniform2f(vorticityPrg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vorticityPrg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityPrg.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vorticityPrg.uniforms.curl, config.CURL);
    gl.uniform1f(vorticityPrg.uniforms.dt, dt);
    blit(velocity.write); velocity.swap();
    // divergence
    bindQuad(divergencePrg);
    gl.uniform2f(divergencePrg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divergencePrg.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);
    // clear pressure (warm-start decay)
    bindQuad(clearPrg);
    gl.uniform1i(clearPrg.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearPrg.uniforms.value, config.PRESSURE);
    blit(pressure.write); pressure.swap();
    // pressure jacobi
    bindQuad(pressurePrg);
    gl.uniform2f(pressurePrg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressurePrg.uniforms.uDivergence, divergence.attach(0));
    for (var i = 0; i < config.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(pressurePrg.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write); pressure.swap();
    }
    // gradient subtract
    bindQuad(gradientPrg);
    gl.uniform2f(gradientPrg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradientPrg.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradientPrg.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write); velocity.swap();
    // advect velocity
    bindQuad(advectPrg);
    gl.uniform2f(advectPrg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform2f(advectPrg.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(advectPrg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectPrg.uniforms.uSource, velocity.read.attach(0));
    gl.uniform1f(advectPrg.uniforms.dt, dt);
    gl.uniform1f(advectPrg.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity.write); velocity.swap();
    // advect dye（涤净时耗散加速）
    var dyeDiss = config.DENSITY_DISSIPATION + washing * 2.2;
    gl.uniform1i(advectPrg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectPrg.uniforms.uSource, dye.read.attach(1));
    gl.uniform2f(advectPrg.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1f(advectPrg.uniforms.dissipation, dyeDiss);
    blit(dye.write); dye.swap();
  }

  /* ── 渲染合成（到屏幕）── */
  function render() {
    bindQuad(displayPrg);
    gl.uniform1i(displayPrg.uniforms.uDye, dye.read.attach(0));
    gl.uniform2f(displayPrg.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1f(displayPrg.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform1f(displayPrg.uniforms.wash, washing);
    gl.uniform1f(displayPrg.uniforms.washX, washX);
    blit(null);
  }

  /* ──────────────────────────────────────────
     9. 重置场（涤净/新卷/异常时清零）
     ────────────────────────────────────────── */
  function resetField() {
    bindQuad(clearPrg);
    [velocity, pressure].forEach(function (d) {
      gl.uniform1i(clearPrg.uniforms.uTexture, d.read.attach(0));
      gl.uniform1f(clearPrg.uniforms.value, 0.0);
      blit(d.write); d.swap();
    });
    gl.uniform1i(clearPrg.uniforms.uTexture, dye.read.attach(0));
    gl.uniform1f(clearPrg.uniforms.value, 0.0);
    blit(dye.write); dye.swap();
  }

  /* 近空白检测：half-float FBO 不便逐帧读回，改维护「墨预算」估计 ——
     落墨累加，时间按 DENSITY_DISSIPATION 指数衰减；低于阈值即近空白。 */
  var inkBudget = 0;

  /* ──────────────────────────────────────────
     10. 道生一编排 + 自动演墨 + 涤净 + 卷数
     ────────────────────────────────────────── */
  var scrollN = 0;
  var seed = 0;
  function rand() { // 每卷可换种子；演化本身不可复现（GPU 浮点 + 时序）
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  function newSeed() { seed = (Date.now() ^ (Math.random() * 1e9)) >>> 0; }

  function pickPigment(excludeIdx) {
    var i;
    do { i = Math.floor(rand() * PIGMENTS.length); } while (i === excludeIdx);
    return i;
  }

  // 标签
  var labelTimer = null;
  function showLabel(text, holdMs) {
    if (!labelEl) return;
    labelEl.textContent = text;
    labelEl.classList.add('show');
    if (labelTimer) clearTimeout(labelTimer);
    labelTimer = setTimeout(function () { labelEl.classList.remove('show'); }, holdMs || 2500);
  }

  var introTimers = [];
  function clearIntro() { introTimers.forEach(clearTimeout); introTimers = []; }
  function later(fn, ms) { introTimers.push(setTimeout(fn, ms)); }

  // 卷状态机
  var autoOn = true;
  var autoTimer = null;
  var nearBlankSince = 0;
  var introActive = false;

  function beginScroll() {
    scrollN += 1;
    if (metaEl) metaEl.textContent = '此卷不可复现 · 第 ' + scrollN + ' 卷';
    newSeed();
    resetField();
    inkBudget = 0;
    nearBlankSince = 0;
    introActive = true;
    clearIntro();

    var midX = 0.5, topY = 0.86;
    var c1 = 1, c2, c3; // c1 玄墨固定（道生一首滴）
    c2 = pickPigment(0);
    c3 = pickPigment(c2);

    // t≈1.2s 一滴玄墨自上方落下（强向下→墨柱羽流）+「道生一」
    later(function () {
      dropInk(midX + (rand() - 0.5) * 0.05, topY, 0, { concentration: 1.05, force: config.SPLAT_FORCE * 1.5, dx: (rand() - 0.5) * 200 });
      inkBudget += 1.05;
      showLabel('道生一', 2500);
    }, 1200);
    // t≈5s 第二色偏侧 +「一生二」
    later(function () {
      dropInk(0.34 + rand() * 0.06, 0.7, c2, { concentration: 0.85, force: config.SPLAT_FORCE * 1.2 });
      inkBudget += 0.85;
      showLabel('一生二', 2500);
    }, 5000);
    // t≈9s 第三色 +「二生三」
    later(function () {
      dropInk(0.64 + rand() * 0.06, 0.72, c3, { concentration: 0.85, force: config.SPLAT_FORCE * 1.2 });
      inkBudget += 0.85;
      showLabel('二生三', 2500);
    }, 9000);
    // t≈13s 自动演墨接管 +「三生万物」永退（本卷内）
    later(function () {
      showLabel('三生万物', 3200);
      introActive = false;
      scheduleAuto();
    }, 13000);
  }

  // 自动演墨：每 6–14s 一次轻柔随机落墨
  function scheduleAuto() {
    if (autoTimer) clearTimeout(autoTimer);
    var delay = 6000 + rand() * 8000;
    autoTimer = setTimeout(function () {
      if (autoOn && !introActive && document.visibilityState === 'visible') {
        var x = 0.18 + rand() * 0.64;
        var y = 0.3 + rand() * 0.5;
        var pig = Math.floor(rand() * PIGMENTS.length);
        dropInk(x, y, pig, { concentration: 0.55 + rand() * 0.35, force: config.SPLAT_FORCE * (0.6 + rand() * 0.5), dy: -config.SPLAT_FORCE * (0.4 + rand() * 0.4) });
        inkBudget += 0.7;
      }
      scheduleAuto();
    }, delay);
  }

  // 涤净：约 3s 洗卷（耗散加速 + 水流横扫），完后开新卷
  // washing 已在配置块声明（step/render 引用）；这里只补 washX / washStart
  var washX = 0.5;
  var washStart = 0;
  function startWash() {
    if (washing > 0) return;
    washStart = performance.now();
    washX = -0.1;
  }
  function updateWash(now) {
    if (washStart === 0) { washing = 0; return; }
    var WASH_MS = 3000;
    var p = (now - washStart) / WASH_MS;
    if (p >= 1) {
      washStart = 0; washing = 0;
      beginScroll();             // 洗完开新一卷（道生一重演）
      return;
    }
    // 钟形：中段最强
    washing = Math.sin(p * Math.PI);
    washX = -0.1 + p * 1.2;      // 水流从左扫到右
  }

  // 近空白自动开新卷：inkBudget 时间耗散估计
  function maybeAutoRenew(now, dt) {
    // inkBudget 指数耗散，近似 dye 的可见衰减
    inkBudget *= Math.exp(-config.DENSITY_DISSIPATION * dt * 0.9);
    if (introActive || washing > 0) { nearBlankSince = 0; return; }
    if (inkBudget < 0.06) {
      if (nearBlankSince === 0) nearBlankSince = now;
      else if (now - nearBlankSince > 5000) {   // 持续近空白 5s
        beginScroll();                          // 生生不息：自动新卷
      }
    } else {
      nearBlankSince = 0;
    }
  }

  /* ──────────────────────────────────────────
     11. 输入：pointer 落墨 / 拖拽搅墨（touch 可玩）
     ────────────────────────────────────────── */
  var pointers = {};
  function toUV(clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    return { x: (clientX - rect.left) / rect.width, y: 1.0 - (clientY - rect.top) / rect.height };
  }
  function onDown(id, clientX, clientY) {
    var uv = toUV(clientX, clientY);
    pointers[id] = { x: uv.x, y: uv.y, down: true, moved: false };
    // 点击即落墨（当前颜料），轻向下
    dropInk(uv.x, uv.y, currentPigment, { concentration: 0.85, force: config.SPLAT_FORCE, dy: -config.SPLAT_FORCE * 0.7, dx: 0 });
    inkBudget += 0.8;
    wakeDock();
  }
  function onMove(id, clientX, clientY) {
    wakeDock();
    var p = pointers[id];
    var uv = toUV(clientX, clientY);
    if (p && p.down) {
      // 拖拽 = 以 pointer 速度搅墨
      var dx = (uv.x - p.x) * config.SPLAT_FORCE * 6.0;
      var dy = (uv.y - p.y) * config.SPLAT_FORCE * 6.0;
      splat(uv.x, uv.y, dx, dy, currentPigment, 0.18);
      inkBudget += 0.04;
      p.x = uv.x; p.y = uv.y; p.moved = true;
    }
  }
  function onUp(id) { if (pointers[id]) pointers[id].down = false; }

  // mouse
  canvas.addEventListener('mousedown', function (e) { onDown('m', e.clientX, e.clientY); });
  window.addEventListener('mousemove', function (e) { onMove('m', e.clientX, e.clientY); });
  window.addEventListener('mouseup', function () { onUp('m'); });
  // touch（仅 canvas 非 passive，让 preventDefault 生效搅墨；不影响页面其他滚动）
  canvas.addEventListener('touchstart', function (e) {
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i]; onDown('t' + t.identifier, t.clientX, t.clientY);
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', function (e) {
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i]; onMove('t' + t.identifier, t.clientX, t.clientY);
    }
  }, { passive: false });
  canvas.addEventListener('touchend', function (e) {
    for (var i = 0; i < e.changedTouches.length; i++) onUp('t' + e.changedTouches[i].identifier);
  });

  /* ──────────────────────────────────────────
     12. 工具条交互 + 4s 自动隐去
     ────────────────────────────────────────── */
  var dockTimer = null;
  function wakeDock() {
    if (!dock) return;
    dock.classList.remove('hidden');
    if (dockTimer) clearTimeout(dockTimer);
    dockTimer = setTimeout(function () {
      if (dock.contains(document.activeElement)) return; // 键盘焦点在工具条内时不隐去
      dock.classList.add('hidden');
    }, 4000);
  }
  // 任何指针移动浮现
  window.addEventListener('pointermove', wakeDock, { passive: true });
  // 键盘 Tab 进入工具条时重新浮现（避免 focus 落在 opacity:0 的隐形控件）
  if (dock) dock.addEventListener('focusin', wakeDock);

  function buildDock() {
    if (!dock) return;
    var sw = dock.querySelector('#swatches');
    if (sw) {
      PIGMENTS.forEach(function (pig, idx) {
        var b = document.createElement('button');
        b.className = 'swatch';
        b.style.background = pig.hex;
        b.setAttribute('aria-label', pig.name);
        b.setAttribute('title', pig.name);
        b.setAttribute('aria-pressed', idx === currentPigment ? 'true' : 'false');
        b.addEventListener('click', function () {
          currentPigment = idx;
          sw.querySelectorAll('.swatch').forEach(function (el, i) {
            el.setAttribute('aria-pressed', i === idx ? 'true' : 'false');
          });
          wakeDock();
        });
        sw.appendChild(b);
      });
    }
    var autoBtn = dock.querySelector('#autoBtn');
    if (autoBtn) {
      autoBtn.setAttribute('aria-pressed', autoOn ? 'true' : 'false');
      autoBtn.addEventListener('click', function () {
        autoOn = !autoOn;
        autoBtn.setAttribute('aria-pressed', autoOn ? 'true' : 'false');
        if (autoOn) scheduleAuto();
        wakeDock();
      });
    }
    var washBtn = dock.querySelector('#washBtn');
    if (washBtn) washBtn.addEventListener('click', function () { startWash(); wakeDock(); });
  }
  buildDock();

  /* ──────────────────────────────────────────
     13. 主循环（dt clamp / document.hidden 暂停）
     ────────────────────────────────────────── */
  var lastTime = performance.now();
  var rafId = null;
  var running = true;

  function loop(now) {
    if (!running) return;
    var dt = (now - lastTime) / 1000;
    lastTime = now;
    if (dt > 0.0166) dt = 0.0166;     // clamp
    if (!(dt > 0)) dt = 0.0166;       // NaN/0 防护

    updateWash(now);
    step(dt);
    render();
    maybeAutoRenew(now, dt);

    rafId = requestAnimationFrame(loop);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
    } else {
      running = true;
      lastTime = performance.now();
      rafId = requestAnimationFrame(loop);
    }
  });

  /* ── WebGL context loss/restore（移动端/集显 GPU reset、切后台回前台常见）──
     lost：停主循环，避免每帧对失效 GL 对象 step()/render() 静默刷爆 console。
     restored：重建可恢复状态（FBO + 新卷）并恢复循环。
     注：shader programs/buffer 在 IIFE 顶层一次性编译，真丢失后需整套重编译；
     此处先保证不报错刷屏 + 尽力恢复 framebuffer 与运行，full recompile 留待后续重构。 */
  canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
  }, false);
  canvas.addEventListener('webglcontextrestored', function () {
    initFramebuffers();
    beginScroll();
    running = true;
    lastTime = performance.now();
    rafId = requestAnimationFrame(loop);
  }, false);

  // 启动：第一卷（道生一开场）
  beginScroll();
  wakeDock();
  rafId = requestAnimationFrame(loop);

  // 对外极小接口（调试用，可无）
  window.__eastink = {
    wash: startWash,
    newScroll: beginScroll,
    setPigment: function (i) { currentPigment = i; }
  };
})();
