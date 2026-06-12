/* ─────────────────────────────────────────────
   東墨 EastInk · v0.2 — 水墨流体引擎
   WebGL stable-fluids (Stam 1999 + Harris GPU Gems 38)
   solver architecture inspired by
   PavelDoGreat/WebGL-Fluid-Simulation (MIT, © 2017 Pavel Dobryakov)
   —— 自有实现。两境合成：
      日·宣纸 = 逐通道光学吸收 color = paper * exp(-K·dye)（非黑底发光）
      夜·深水 = 深水底 + 加色发光，墨入夜化光（玄墨→月白，阴阳互转）

   每帧 pass：curl → vorticity → divergence → clear → pressure×N
              → gradientSubtract → advect(vel) → advect(dye)
   每卷从新种子抽签：三拍开场（主墨随机）+ 环流性格 + 自动续墨。
   全场 curl-noise 缓流 → 多色相遇、洇染、共同消融。
   控件：五瓷色碟 + 另起一卷 + 日/月双境。运行时零外部请求。
   ───────────────────────────────────────────── */
(function () {
  'use strict';

  var canvas = document.getElementById('stage');
  var poster = document.getElementById('poster');
  var paletteEl = document.getElementById('palette');
  var renewEl = document.getElementById('renewBtn');
  var realmToggleEl = document.getElementById('realmToggle');
  var coupletEl = document.getElementById('couplet');
  var coupletEastEl = document.getElementById('coupletEast');
  var coupletWestEl = document.getElementById('coupletWest');
  var colophonNoteEl = document.getElementById('colophonNote');
  var colophonTipEl = document.getElementById('colophonTip');
  var metaEl = document.getElementById('scrollMeta');
  if (!canvas) return;

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var isMobile = window.matchMedia('(max-width: 760px)').matches;

  /* 夜境：?realm=night URL 参数直接进（测试 + 可分享），UI 切换同步 */
  var realm = 'day';
  try {
    if (/[?&]realm=night/.test(window.location.search)) realm = 'night';
  } catch (e) {}
  document.documentElement.setAttribute('data-realm', realm);

  /* ── reduced-motion：不跑模拟，静态海报 + 一对题跋静态展示 ── */
  if (reduced) {
    canvas.style.display = 'none';
    [paletteEl, renewEl, realmToggleEl].forEach(function (el) { if (el) el.style.display = 'none'; });
    if (poster) poster.hidden = false;
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
    [paletteEl, renewEl, realmToggleEl, coupletEl].forEach(function (el) { if (el) el.style.display = 'none'; });
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
  // nightName / glow：夜境每色映射的发光变体（玄墨→月白，黑墨入夜化白，阴阳互转）
  var PIGMENTS = [
    { id: 'xuanmo',    name: '玄墨', nightName: '月白', hex: '#1a1a18', glow: '#eaf2fb', K: pigmentK('#1a1a18', 1.15) },
    { id: 'zhusha',    name: '朱砂', nightName: '赤焰', hex: '#c8442e', glow: '#ff5a3c', K: pigmentK('#c8442e', 0.95) },
    { id: 'shiqing',   name: '石青', nightName: '月辉', hex: '#2e5a8f', glow: '#5aa6ff', K: pigmentK('#2e5a8f', 0.95) },
    { id: 'shilv',     name: '石绿', nightName: '萤绿', hex: '#3f8f6a', glow: '#54e6a0', K: pigmentK('#3f8f6a', 0.95) },
    { id: 'tenghuang', name: '藤黄', nightName: '暖金', hex: '#e0a82e', glow: '#ffcf57', K: pigmentK('#e0a82e', 1.0) }
  ];
  var currentPigment = 1; // 默认朱砂（每卷开场主墨改为随机抽签，见 beginScroll）

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
    CURL: 5,                      // 漩涡降档：12→5，别把墨撕成丝/掏空成铬环
    DYE_DIFFUSE: 0.30,           // 墨晕轻扩散权重（0=纯平流硬边丝带）
    SPLAT_RADIUS: 0.22,          // 落墨即带柔边：0.15→0.22
    SPLAT_FORCE: 2600            // 羽流保留但降幅：3500→2600，别把墨喷成丝
  };
  var washing = 0;               // 「另起一卷」洗卷进度（>0 时加速耗散 + 水幕扫过）

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
    'uniform float diffuse;',          // >0 only on dye pass：墨晕轻扩散，0 时退化为纯平流
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
    // 轻扩散：以 backtraced coord 为中心做 5-tap 对称模糊，权重守恒（不偷墨量）。
    // 把半拉格朗日折出的硬丝带软化成云雾渐变；velocity pass 传 diffuse=0 故不受影响。
    '  if (diffuse > 0.0) {',
    // 半径 2.5 texel + 含对角的 8-tap：宽核才能侵蚀「站立」的结壳花纹，1-texel 软不动
    '    vec2 d = dyeTexelSize * 2.5;',
    '    vec4 blur = sampleSrc(coord + vec2(d.x, 0.0))',
    '              + sampleSrc(coord - vec2(d.x, 0.0))',
    '              + sampleSrc(coord + vec2(0.0, d.y))',
    '              + sampleSrc(coord - vec2(0.0, d.y))',
    '              + sampleSrc(coord + vec2(d.x, d.y)) * 0.5',
    '              + sampleSrc(coord + vec2(-d.x, d.y)) * 0.5',
    '              + sampleSrc(coord + vec2(d.x, -d.y)) * 0.5',
    '              + sampleSrc(coord + vec2(-d.x, -d.y)) * 0.5;',
    '    result = mix(result, blur / 6.0, diffuse);',     // (4 + 4*0.5) = 6 归一
    '  }',
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

  /* ── 合成 pass：两境分支 ──
     日：宣纸 fbm 纤维 + 逐通道光学吸收 + 墨缘 granulation
     夜：深水底 #0c1118 + 微深度噪声 + 加色发光（墨入夜化光，玄墨→月白） */
  var DISPLAY_FRAG = HEADER_F + (supportLinear ? '' : '#define MANUAL\n') +
    (supportLinear ? '' : BILERP) + [
    'varying vec2 vUv;',
    'uniform sampler2D uDye;',     // RGB = 累计颜料浓度（已乘各自 K 后求和存入）
    'uniform vec2 dyeTexelSize;',
    'uniform float aspectRatio;',
    'uniform float wash;',         // 洗卷水幕相位 0..1
    'uniform float washX;',        // 水幕扫过的横向位置
    'uniform float realm;',        // 0=日·宣纸  1=夜·深水
    'uniform float time;',         // 夜境深度噪声微动
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
    // 累计吸收 K·dye（dye 已存 sum(K_i * concentration_i)）
    '  vec3 absK = sampleDye(uv);',
    // 墨缘 granulation：只在「低密度边缘」隐约一线（不满身结壳）
    '  float dC = length(absK);',
    '  vec2 e = dyeTexelSize * 2.0;',
    '  float dL = length(sampleDye(uv - vec2(e.x, 0.0)));',
    '  float dR = length(sampleDye(uv + vec2(e.x, 0.0)));',
    '  float dT = length(sampleDye(uv + vec2(0.0, e.y)));',
    '  float dB = length(sampleDye(uv - vec2(0.0, e.y)));',
    '  float grad = abs(dR - dL) + abs(dT - dB);',
    '  float edgeGate = 1.0 - smoothstep(0.15, 0.6, dC);',
    '  absK *= 1.0 + grad * 0.5 * edgeGate;',
    // 洗卷：一道水幕横扫，扫过处吸收被冲淡
    '  if (wash > 0.0) {',
    '    float band = smoothstep(0.16, 0.0, abs(uv.x - washX));',
    '    absK *= 1.0 - band * 0.9 * wash;',
    '    absK *= 1.0 - wash * 0.25;',
    '  }',
    '  absK = max(absK, 0.0);',
    '  vec3 col;',
    '  if (realm < 0.5) {',
    // ── 日·宣纸：暖白 + fbm 纤维 + vignette 留白，逐通道吸收 ──
    '    vec3 paper = vec3(0.980, 0.969, 0.941);',
    '    float fiber = fbm(uv * vec2(aspectRatio, 1.0) * 380.0);',
    '    float blotch = fbm(uv * vec2(aspectRatio, 1.0) * 6.0);',
    '    paper -= (fiber - 0.5) * 0.018;',
    '    paper -= (blotch - 0.5) * 0.012;',
    '    float vig = smoothstep(1.35, 0.35, length((uv - 0.5) * vec2(1.0, 1.08)));',
    '    paper = mix(paper * 0.985, paper, 0.5 + 0.5 * vig);',
    '    col = paper * exp(-absK);',     // color = paper * exp(-K·dye)
    '  } else {',
    // ── 夜·深水：深水底 + 微深度噪声，墨改加色发光渲染 ──
    // 深水底色 #0c1118 系 + 极缓动的深度噪声（水有深浅，不是死黑）
    '    vec3 deep = vec3(0.047, 0.067, 0.094);',
    '    float depth = fbm(uv * vec2(aspectRatio, 1.0) * 3.2 + vec2(0.0, time * 0.012));',
    '    deep += (depth - 0.5) * vec3(0.012, 0.018, 0.028);',
    '    float vigN = smoothstep(1.45, 0.25, length((uv - 0.5) * vec2(1.0, 1.08)));',
    '    deep *= 0.78 + 0.22 * vigN;',
    // 从吸收签名反推发光色：透射色 vis=exp(-absK) 携带颜料色相（朱砂偏红/石青偏蓝…），
    // 其「与灰的偏离」即色相方向；玄墨吸收近中性高 → vis 近中性 → 无色相 → special 化月白。
    '    float amt = 1.0 - exp(-dC * 0.85);',          // 墨量 0..1（越浓越亮），亮度曲线柔
    '    vec3 vis = exp(-absK);',
    '    float lum = dot(vis, vec3(0.333));',
    '    vec3 chroma = vis - vec3(lum);',               // 色相方向（去亮度）
    '    float chromaMag = length(chroma);',
    // 玄墨判定：吸收高(dC 大) 且 色相弱(chromaMag 小) → 黑墨入夜化白（月白偏冷白）
    '    float moonW = smoothstep(0.22, 0.05, chromaMag) * smoothstep(0.25, 0.9, dC);',
    // 彩色发光：以色相方向提纯成饱和发光色（归一化 chroma 抬到发光强度）
    '    vec3 tint = normalize(max(chroma, vec3(0.0)) + vec3(0.0008));',
    '    vec3 chromaGlow = tint * 1.35 + vec3(0.12);',  // 留一点白芯，发光不死板
    '    vec3 moonGlow = vec3(0.86, 0.91, 1.0);',       // 月白：冷白
    '    vec3 glowCol = mix(chromaGlow, moonGlow, moonW);',
    '    vec3 emissive = glowCol * amt * 1.15;',         // 加色发光，不挂 bloom 管线
    '    col = deep + emissive;',
    '  }',
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
  // context 真丢失后 program/buffer 全部失效：整套重编译 + 重建 quad + 重建 FBO
  function rebuildGL() {
    splatPrg = program(BASE_VERT, SPLAT_FRAG);
    advectPrg = program(BASE_VERT, ADVECT_FRAG);
    divergencePrg = program(BASE_VERT, DIVERGENCE_FRAG);
    curlPrg = program(BASE_VERT, CURL_FRAG);
    vorticityPrg = program(BASE_VERT, VORTICITY_FRAG);
    pressurePrg = program(BASE_VERT, PRESSURE_FRAG);
    clearPrg = program(BASE_VERT, CLEAR_FRAG);
    gradientPrg = program(BASE_VERT, GRADIENT_FRAG);
    displayPrg = program(BASE_VERT, DISPLAY_FRAG);
    if (!splatPrg || !advectPrg || !divergencePrg || !curlPrg || !vorticityPrg ||
        !pressurePrg || !clearPrg || !gradientPrg || !displayPrg) { return false; }
    quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    velocity = null;   // 旧 FBO 句柄已随 context 失效，置空让 initFramebuffers 跳过 destroy 死对象
    initFramebuffers();
    return true;
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
  function splat(x, y, dx, dy, pigIdx, concentration, radiusScale) {
    var pig = PIGMENTS[pigIdx];
    var aspect = canvas.width / canvas.height;
    var r = correctRadius((config.SPLAT_RADIUS * (radiusScale || 1)) / 100.0);
    // 速度注入
    bindQuad(splatPrg);
    gl.uniform1i(splatPrg.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatPrg.uniforms.aspectRatio, aspect);
    gl.uniform2f(splatPrg.uniforms.point, x, y);
    gl.uniform3f(splatPrg.uniforms.color, dx, dy, 0.0);
    gl.uniform1f(splatPrg.uniforms.radius, r);
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
    splat(x, y, dxBias, dyDown, pigIdx, conc, opts.radiusScale);
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
    gl.uniform1f(advectPrg.uniforms.diffuse, 0.0);   // 速度场不扩散，保持流动锐利
    blit(velocity.write); velocity.swap();
    // advect dye（涤净时耗散加速 + 轻扩散晕染）
    var dyeDiss = config.DENSITY_DISSIPATION + washing * 2.2;
    gl.uniform1i(advectPrg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectPrg.uniforms.uSource, dye.read.attach(1));
    gl.uniform2f(advectPrg.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1f(advectPrg.uniforms.dissipation, dyeDiss);
    gl.uniform1f(advectPrg.uniforms.diffuse, config.DYE_DIFFUSE);  // 墨晕扩散
    blit(dye.write); dye.swap();
  }

  /* ── 渲染合成（到屏幕）：两境由 realm uniform 分支 ── */
  function render(now) {
    bindQuad(displayPrg);
    gl.uniform1i(displayPrg.uniforms.uDye, dye.read.attach(0));
    gl.uniform2f(displayPrg.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1f(displayPrg.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform1f(displayPrg.uniforms.wash, washing);
    gl.uniform1f(displayPrg.uniforms.washX, washX);
    gl.uniform1f(displayPrg.uniforms.realm, realm === 'night' ? 1.0 : 0.0);
    gl.uniform1f(displayPrg.uniforms.time, (now || 0) * 0.001);
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

  /* 速度场专用注入（只搅水不落墨）：环流缓流 / 拖拽搅墨复用 */
  function splatVelocity(x, y, dx, dy, radiusScale) {
    bindQuad(splatPrg);
    gl.uniform1i(splatPrg.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatPrg.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatPrg.uniforms.point, x, y);
    gl.uniform3f(splatPrg.uniforms.color, dx, dy, 0.0);
    gl.uniform1f(splatPrg.uniforms.radius, correctRadius((config.SPLAT_RADIUS * (radiusScale || 1)) / 100.0));
    blit(velocity.write); velocity.swap();
  }

  /* ──────────────────────────────────────────
     10. 每卷生成语法（随机感引擎）+ 环流性格 + 自动续墨 + 洗卷
     ────────────────────────────────────────── */
  var scrollN = 0;
  var seed = 0;
  function rand() { // 每卷换种子；演化本身亦不可复现（GPU 浮点 + 时序）
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  function newSeed() { seed = (Date.now() ^ (Math.random() * 1e9)) >>> 0; }
  function rng(a, b) { return a + (b - a) * rand(); }

  // 5 选 3 不重复有序抽（主墨不固定，随机感来源之一）
  function pick3Pigments() {
    var pool = [0, 1, 2, 3, 4], out = [];
    for (var k = 0; k < 3; k++) {
      var i = Math.floor(rand() * pool.length);
      out.push(pool.splice(i, 1)[0]);
    }
    return out;
  }

  var CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  function cnNum(n) {
    if (n <= 10) return CN_NUM[n];
    if (n < 20) return '十' + (n % 10 === 0 ? '' : CN_NUM[n % 10]);
    if (n < 100) return CN_NUM[Math.floor(n / 10)] + '十' + (n % 10 === 0 ? '' : CN_NUM[n % 10]);
    return String(n);
  }

  // 题跋区：拍序小注（道生一 / 一生二 …）随拍浮现
  var tipTimer = null;
  function showTip(text, holdMs) {
    if (!colophonTipEl) return;
    colophonTipEl.textContent = text;
    colophonTipEl.classList.add('show');
    if (tipTimer) clearTimeout(tipTimer);
    tipTimer = setTimeout(function () { colophonTipEl.classList.remove('show'); }, holdMs || 2600);
  }

  /* ── 东西相照题跋：九对真实出处，抽签不放回，九卷内不重复 ── */
  var COUPLETS = [
    { e: '上善若水', w: '“Panta rhei — 万物皆流.” — Heraclitus 赫拉克利特', note: '上善若水 ——《道德经》／ 万物皆流 — Heraclitus' },
    { e: '逝者如斯夫，不舍昼夜', w: '“You cannot step into the same river twice.” — Heraclitus', note: '逝者如斯夫 ——《论语》／ — Heraclitus' },
    { e: '道生一，一生二，二生三，三生万物', w: '“From all things one, and from one all things.” — Heraclitus', note: '道生一 ——《道德经》／ — Heraclitus' },
    { e: '大象无形', w: '“Nature loves to hide.” — Heraclitus', note: '大象无形 ——《道德经》／ — Heraclitus' },
    { e: '反者道之动', w: '“The way up and the way down are one and the same.” — Heraclitus', note: '反者道之动 ——《道德经》／ — Heraclitus' },
    { e: '覆水难收', w: '“What’s done cannot be undone.” — Shakespeare 《Macbeth》', note: '覆水难收 —— 汉语成语 ／ — Shakespeare' },
    { e: '天下莫柔弱于水', w: '“In rivers, the water you touch is the last of what has passed and the first of that which comes.” — Leonardo da Vinci', note: '天下莫柔弱于水 ——《道德经》／ — Leonardo da Vinci' },
    { e: '万物并作，吾以观复', w: '“In all things of nature there is something of the marvelous.” — Aristotle', note: '万物并作，吾以观复 ——《道德经》／ — Aristotle' },
    { e: '知者乐水', w: '“Be water, my friend.” — Bruce Lee 李小龙', note: '知者乐水 ——《论语》／ — Bruce Lee 李小龙' }
  ];
  var coupletBag = [];
  function drawCouplet() {
    if (coupletBag.length === 0) {                 // 洗牌补袋（抽签不放回）
      coupletBag = COUPLETS.map(function (_, i) { return i; });
      for (var i = coupletBag.length - 1; i > 0; i--) {
        var j = Math.floor(rand() * (i + 1));
        var t = coupletBag[i]; coupletBag[i] = coupletBag[j]; coupletBag[j] = t;
      }
    }
    return COUPLETS[coupletBag.pop()];
  }
  var coupletTimers = [];
  function clearCouplets() { coupletTimers.forEach(clearTimeout); coupletTimers = []; }
  function laterC(fn, ms) { coupletTimers.push(setTimeout(fn, ms)); }

  function showCouplet(pair) {
    if (!coupletEl || !coupletEastEl || !coupletWestEl) return;
    coupletEastEl.textContent = pair.e;
    coupletWestEl.textContent = pair.w;
    coupletEl.classList.remove('fade');
    // 0.5s 淡入
    laterC(function () { coupletEl.classList.add('show'); }, 60);
    // 6s 内淡出
    laterC(function () { coupletEl.classList.remove('show'); coupletEl.classList.add('fade'); }, 6000);
    // 淡出后缩入右下题跋区与卷号共存
    laterC(function () {
      coupletEl.classList.remove('fade');
      if (colophonNoteEl) { colophonNoteEl.textContent = pair.note; colophonNoteEl.classList.add('show'); }
    }, 7600);
  }

  var introTimers = [];
  function clearIntro() { introTimers.forEach(clearTimeout); introTimers = []; }
  function later(fn, ms) { introTimers.push(setTimeout(fn, ms)); }

  // 卷状态机
  var autoTimer = null;
  var nearBlankSince = 0;
  var introActive = false;

  // 环流性格三选一：每卷一个 curl-noise 缓流场，让多色相遇、洇染、共同消融
  // kind: 0 微风(定向缓漂) / 1 回漩(全场慢涡) / 2 对流(双胞环流)
  var flow = { kind: 0, dir: 0, strength: 1, t: 0 };
  function rollFlowPersona() {
    flow.kind = Math.floor(rand() * 3);
    flow.dir = rand() * Math.PI * 2;
    flow.strength = rng(0.8, 1.25);
    flow.t = rand() * 1000;
  }

  function beginScroll() {
    scrollN += 1;
    if (metaEl) metaEl.textContent = '第 ' + cnNum(scrollN) + ' 卷 · 不可复现';
    if (colophonNoteEl) colophonNoteEl.classList.remove('show');
    newSeed();
    resetField();
    inkBudget = 0;
    nearBlankSince = 0;
    introActive = true;
    clearIntro();
    clearCouplets();
    clearTimeout(tipTimer);                  // 清旧卷残留的隐藏 timer，避免到点吞掉新卷刚浮现的拍序小注
    rollFlowPersona();

    // 东西相照题跋：开卷浮现一对
    showCouplet(drawCouplet());

    // 三拍开场保持「一→二→三」哲学骨架，但每拍参数全随机（随机感+宿命感）
    var pigs = pick3Pigments();                       // 5 选 3 不重复有序：主墨不固定
    var tips = ['道生一', '一生二', '二生三'];
    // 落点：上沿 / 左右上沿随机段；羽流向量：垂直 ±35°、力度 0.7–1.4×；拍间隔随机
    var t = 0;
    [0, 1, 2].forEach(function (b) {
      var interval = b === 0 ? rng(1000, 2000) : rng(3000, 6000);
      t += interval;
      var when = t;
      var pig = pigs[b];
      // 落点横向分段：第一拍中上区，二三拍偏左 / 偏右上沿
      var x = b === 0 ? rng(0.40, 0.60) : (b === 1 ? rng(0.20, 0.45) : rng(0.55, 0.80));
      var y = rng(0.74, 0.90);                          // 上沿
      var ang = (rand() - 0.5) * (70 * Math.PI / 180);  // 垂直 ±35°
      var f = config.SPLAT_FORCE * rng(0.7, 1.4);       // 力度 0.7–1.4×
      var dxV = Math.sin(ang) * f;
      var dyV = -Math.cos(ang) * f;                      // 主向下（UV y 向上故负）
      var conc = b === 0 ? rng(0.9, 1.05) : rng(0.78, 0.95);
      later(function () {
        dropInk(x, y, pig, { concentration: conc, force: f, dx: dxV, dy: dyV });
        inkBudget += conc;
        showTip(tips[b], 2600);
      }, when);
    });
    // 「三生万物」后：环流性格接管 + 自动续墨节奏
    later(function () {
      showTip('三生万物', 3200);
      introActive = false;
      scheduleAuto();
    }, t + rng(3000, 5000));
  }

  // 自动续墨：每 5–12s 一次轻柔随机落墨，滴径有方差（生生不息，永远是活的）
  function scheduleAuto() {
    if (autoTimer) clearTimeout(autoTimer);
    var delay = rng(5000, 12000);
    autoTimer = setTimeout(function () {
      if (!introActive && washing === 0 && document.visibilityState === 'visible') {
        var x = rng(0.16, 0.84);
        var y = rng(0.28, 0.82);
        var pig = Math.floor(rand() * PIGMENTS.length);
        var conc = rng(0.5, 0.92);
        var ang = rand() * Math.PI * 2;
        var f = config.SPLAT_FORCE * rng(0.5, 1.05);
        // 落点带轻向下羽流 + 滴径方差（生生不息，永远是活的）
        dropInk(x, y, pig, {
          concentration: conc,
          force: f,
          dx: Math.cos(ang) * f * 0.5,
          dy: -Math.abs(Math.sin(ang)) * f - f * 0.3,
          radiusScale: rng(0.7, 1.5)
        });
        inkBudget += conc;
      }
      scheduleAuto();
    }, delay);
  }

  /* 全场环流缓流：curl-noise 力场，per 卷性格。强度要「缓」——水有性情，不是搅拌机。
     在低分辨率网格上撒少量速度脉冲（只搅水不落墨），让分离的墨团彼此漂近、相遇、洇染。 */
  function vnoise2(x, y) {
    var s = Math.sin(x * 1.7 + y * 0.6) + Math.sin(y * 1.3 - x * 0.9) * 0.7 + Math.sin((x + y) * 0.8) * 0.5;
    return s / 2.2;
  }
  var flowAccum = 0;
  function ambientFlow(now, dt) {
    if (washing > 0) return;
    flow.t += dt;
    flowAccum += dt;
    // 约每 0.16s 注入一轮（缓），避免每帧灌入把场打硬
    if (flowAccum < 0.16) return;
    flowAccum = 0;
    var base = 26 * flow.strength;                       // 缓流基础力度（远低于落墨 SPLAT_FORCE）
    var phase = flow.t * 0.05;
    var n = 5;                                            // 每轮少量点，疏密随机
    for (var k = 0; k < n; k++) {
      var x = rand(), y = rand();
      var dx = 0, dy = 0;
      if (flow.kind === 0) {
        // 微风：定向缓漂 + 轻微 curl 扰动
        var c = vnoise2(x * 4 + phase, y * 4);
        dx = Math.cos(flow.dir) * base + Math.cos(flow.dir + 1.57) * c * base * 0.5;
        dy = Math.sin(flow.dir) * base + Math.sin(flow.dir + 1.57) * c * base * 0.5;
      } else if (flow.kind === 1) {
        // 回漩：全场慢涡（绕中心切向）
        var rx = x - 0.5, ry = y - 0.5;
        var sgn = flow.dir > Math.PI ? -1 : 1;
        dx = -ry * base * 2.0 * sgn;
        dy = rx * base * 2.0 * sgn;
      } else {
        // 对流：双胞环流（左涡 + 右涡 + curl 噪声软化）
        var cx = x < 0.5 ? 0.27 : 0.73;
        var rx2 = x - cx, ry2 = y - 0.5;
        var sgn2 = x < 0.5 ? 1 : -1;
        var cc = vnoise2(x * 5 - phase, y * 5);
        dx = (-ry2 * base * 2.2 + cc * base * 0.4) * sgn2;
        dy = (rx2 * base * 2.2) * sgn2;
      }
      splatVelocity(x, y, dx, dy, 2.4);
    }
  }

  // 「另起一卷」：约 4s 可见洗卷大动作（水幕横扫 + 墨色褪尽 + 留白呼吸 + 新卷开张）
  var washX = 0.5;
  var washStart = 0;
  var WASH_MS = 4000;
  function startWash() {
    if (washing > 0) return;
    washing = 0.001;                 // 同帧连点防护：立即占位，下一帧 updateWash 即按 washStart 重算
    washStart = performance.now();
    washX = -0.1;
    if (colophonNoteEl) colophonNoteEl.classList.remove('show');
    if (coupletEl) coupletEl.classList.remove('show');
  }
  function updateWash(now) {
    if (washStart === 0) { washing = 0; return; }
    var p = (now - washStart) / WASH_MS;
    if (p >= 1) {
      washStart = 0; washing = 0;
      beginScroll();                                     // 留白呼吸后新卷开张（新种子 + 新题跋）
      return;
    }
    // 0–0.62：水幕横扫冲墨；0.62–1：留白呼吸（washing 渐隐，washX 出场外）
    if (p < 0.62) {
      var q = p / 0.62;
      washing = Math.sin(q * Math.PI * 0.85);            // 扫过段最强
      washX = -0.1 + q * 1.2;                            // 一道水幕从左扫到右
    } else {
      washing = (1 - (p - 0.62) / 0.38) * 0.18;          // 余韵渐隐，留白呼吸 ~1.5s
      washX = 1.3;
    }
  }

  // 近空白安全网：长时间无墨则刷新题跋开新卷（页面永远是活的，频率放缓）
  function maybeAutoRenew(now, dt) {
    inkBudget *= Math.exp(-config.DENSITY_DISSIPATION * dt * 0.9);
    if (introActive || washing > 0) { nearBlankSince = 0; return; }
    if (inkBudget < 0.05) {
      if (nearBlankSince === 0) nearBlankSince = now;
      else if (now - nearBlankSince > 9000) { beginScroll(); }
    } else {
      nearBlankSince = 0;
    }
  }

  /* ──────────────────────────────────────────
     11. 输入：pointer 落墨 / 拖拽搅墨（手笔随时加入同一宇宙，无模式切换）
     ────────────────────────────────────────── */
  var pointers = {};
  function toUV(clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    return { x: (clientX - rect.left) / rect.width, y: 1.0 - (clientY - rect.top) / rect.height };
  }
  function onDown(id, clientX, clientY) {
    var uv = toUV(clientX, clientY);
    pointers[id] = { x: uv.x, y: uv.y, down: true, moved: false };
    dropInk(uv.x, uv.y, currentPigment, { concentration: 0.85, force: config.SPLAT_FORCE, dy: -config.SPLAT_FORCE * 0.7, dx: 0 });
    inkBudget += 0.8;
    wakeChrome();
  }
  function onMove(id, clientX, clientY) {
    wakeChrome();
    var p = pointers[id];
    var uv = toUV(clientX, clientY);
    if (p && p.down) {
      var dx = (uv.x - p.x) * config.SPLAT_FORCE * 6.0;
      var dy = (uv.y - p.y) * config.SPLAT_FORCE * 6.0;
      splat(uv.x, uv.y, dx, dy, currentPigment, 0.18);
      inkBudget += 0.04;
      p.x = uv.x; p.y = uv.y; p.moved = true;
    }
  }
  function onUp(id) { if (pointers[id]) pointers[id].down = false; }

  canvas.addEventListener('mousedown', function (e) { onDown('m', e.clientX, e.clientY); });
  window.addEventListener('mousemove', function (e) { onMove('m', e.clientX, e.clientY); });
  window.addEventListener('mouseup', function () { onUp('m'); });
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
     12. 文房 UI：瓷色碟 + 另起一卷 + 日/月双境 + chrome 闲置 5s 隐去
     ────────────────────────────────────────── */
  var chromeTimer = null;
  function wakeChrome() {
    document.body.classList.remove('chrome-idle');
    if (chromeTimer) clearTimeout(chromeTimer);
    chromeTimer = setTimeout(function () {
      // 键盘焦点落在控件上时不隐去（避免 focus 落在 opacity:0 的隐形控件）
      var ae = document.activeElement;
      if (ae && (ae.closest('.palette') || ae.classList.contains('renew') || ae.classList.contains('realm-toggle'))) return;
      document.body.classList.add('chrome-idle');
    }, 5000);
  }
  window.addEventListener('pointermove', wakeChrome, { passive: true });
  [paletteEl, renewEl, realmToggleEl].forEach(function (el) {
    if (el) el.addEventListener('focusin', wakeChrome);
  });

  // 应用某颜料色到瓷碟 CSS（日 hex / 夜 glow），并设选中态
  function applyDishVisual(btn, pig) {
    btn.style.setProperty('--pig', pig.hex);
    btn.style.setProperty('--glow', pig.glow);
  }
  function refreshDishNames() {
    if (!paletteEl) return;
    var night = realm === 'night';
    paletteEl.querySelectorAll('.dish').forEach(function (btn, i) {
      var pig = PIGMENTS[i];
      var nameEl = btn.querySelector('.dish-name');
      if (nameEl) nameEl.textContent = night ? pig.nightName : pig.name;
      btn.setAttribute('aria-label', (night ? pig.nightName : pig.name));
      btn.setAttribute('title', (night ? pig.nightName : pig.name));
    });
  }

  function buildPalette() {
    if (!paletteEl) return;
    PIGMENTS.forEach(function (pig, idx) {
      var b = document.createElement('button');
      b.className = 'dish';
      b.setAttribute('aria-pressed', idx === currentPigment ? 'true' : 'false');
      applyDishVisual(b, pig);
      var nm = document.createElement('span');
      nm.className = 'dish-name';
      nm.textContent = pig.name;
      b.appendChild(nm);
      b.addEventListener('click', function () {
        currentPigment = idx;
        paletteEl.querySelectorAll('.dish').forEach(function (el, i) {
          el.setAttribute('aria-pressed', i === idx ? 'true' : 'false');
        });
        wakeChrome();
      });
      paletteEl.appendChild(b);
    });
    refreshDishNames();
  }
  buildPalette();

  // 另起一卷
  if (renewEl) {
    renewEl.addEventListener('click', function () { startWash(); wakeChrome(); });
  }

  // 日 / 月双境切换（UI 与 ?realm 同步）
  function setRealm(next) {
    realm = next;
    document.documentElement.setAttribute('data-realm', realm);
    refreshDishNames();
    wakeChrome();
  }
  if (realmToggleEl) {
    realmToggleEl.addEventListener('click', function () {
      setRealm(realm === 'night' ? 'day' : 'night');
    });
  }

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
    ambientFlow(now, dt);             // 全场环流缓流（多色相遇洇染）
    step(dt);
    render(now);
    maybeAutoRenew(now, dt);

    rafId = requestAnimationFrame(loop);
  }

  // 单一入口启动主循环：先取消任何在途 rAF，杜绝并发 loop 链叠加（双速/GPU 翻倍）
  function startLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    running = true;
    lastTime = performance.now();
    rafId = requestAnimationFrame(loop);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
    } else {
      startLoop();
    }
  });

  /* ── WebGL context loss/restore（移动端/集显 GPU reset、切后台回前台常见）──
     lost：停主循环，避免每帧对失效 GL 对象 step()/render() 静默刷爆 console。
     restored：整套重编译 program + 重建 quad/FBO（rebuildGL），再开新卷恢复循环。
     真丢失后 program/buffer 全部失效，必须 full recompile 才能真正恢复渲染。
     若 rebuildGL 失败（极少数 GPU 重建失败），保持停机不刷屏，等用户刷新。 */
  canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
  }, false);
  canvas.addEventListener('webglcontextrestored', function () {
    if (!rebuildGL()) return;
    beginScroll();
    startLoop();
  }, false);

  // 启动：第一卷
  beginScroll();
  wakeChrome();
  rafId = requestAnimationFrame(loop);

  // 对外极小接口（调试用，可无）
  window.__eastink = {
    newScroll: beginScroll,
    renew: startWash,
    setPigment: function (i) { currentPigment = i; },
    setRealm: setRealm
  };
})();
