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

  // F4 宣纸纹理（帘纹 laid lines + 稀疏纤维絮斑）：只作用于「无墨留白」（× paperGate，
  // paperGate 在 main() 里由墨量 dC 算出），墨上不叠纹——墨是主角，纸纹不抢戏，
  // 也避免把墨的饱和度冲淡（实测纸纹满铺会灰化墨色）。
  var PAPER_FX = [
    '',
    '    float wave = vnoise(uv * vec2(2.2, 1.0) * 3.0) * 0.5;',
    '    float laid = sin((uv.y + wave * 0.012) * 520.0);',
    '    paper -= laid * 0.006 * paperGate;',              // 帘纹 laid lines（仅留白）
    '    float speck = fbm(uv * vec2(aspectRatio * 22.0, 150.0));',
    '    speck = smoothstep(0.62, 0.92, speck);',
    '    paper -= speck * 0.020 * paperGate;',             // 稀疏纤维絮斑（仅留白）
    ''
  ].join('\n');

  /* ── reduced-motion：不跑模拟，静态海报 + 一对题跋静态展示 ──
     F2：跳过字入墨；DOM 静态展示题跋对（海报已含一对东西句）。 */
  if (reduced) {
    canvas.style.display = 'none';
    [paletteEl, renewEl, realmToggleEl, document.getElementById('lingBtn')]
      .forEach(function (el) { if (el) el.style.display = 'none'; });
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
    DENSITY_DISSIPATION: 0.31,   // 墨耗散：~70–95s 归近白（略缓于 0.34，墨更耐看不易沉空）
    VELOCITY_DISSIPATION: 0.2,
    PRESSURE: 0.8,
    PRESSURE_ITERATIONS: isMobile ? 16 : 30,
    CURL: 5,                      // 漩涡降档：12→5，别把墨撕成丝/掏空成铬环
    DYE_DIFFUSE: 0.15,           // 墨晕轻扩散权重（0.30→0.15：保守模糊更轻，峰值浓度留得住——薄墨也读得出本色，不糊成隐形薄膜）
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

  /* ── F2 字入墨：把东句文字形状注入 dye 场 ──
     uText.r = 离屏 canvas 笔画 alpha（已 FLIP_Y 对齐 UV）。
     注入玄墨 K 签名 → 昼显墨黑、夜经 display 的玄墨判定自动化月白（无需额外逻辑）。
     微噪声抖动笔画边缘 → 洇墨感；不注入速度（静字，让环流去冲散）。 */
  var TEXT_SPLAT_FRAG = HEADER_F + [
    'varying vec2 vUv;',
    'uniform sampler2D uTarget;',   // 当前 dye
    'uniform sampler2D uText;',     // 文字 alpha 图
    'uniform vec3 inkK;',           // 玄墨 K
    'uniform float amount;',        // 本帧注入权重（分帧叠加）
    'uniform float seed;',          // 每帧换种子，让洇墨抖动不同
    'float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}',
    'void main(){',
    '  float a = texture2D(uText, vUv).r;',
    // 笔画边缘洇墨：在中等 alpha 处加噪声抖动（实心内部不抖，背景不抖）
    '  float edge = a * (1.0 - a) * 4.0;',                 // 0..1，峰在 a=0.5
    '  float n = hash(vUv * 520.0 + seed) - 0.5;',
    '  a = clamp(a + n * edge * 0.5, 0.0, 1.0);',
    '  vec3 base = texture2D(uTarget, vUv).xyz;',
    '  gl_FragColor = vec4(base + inkK * (a * amount), 1.0);',
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
    'uniform sampler2D uVelocity;',// F4 夜星河：星随墨流漂
    'uniform vec2 texelSizeV;',    // 速度纹理 texel（manual bilerp 用）
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
    'vec2 sampleVelD(vec2 uv){',           // F4 星河用：两路安全采样
    '#ifdef MANUAL',
    '  return bilerp(uVelocity, uv, texelSizeV).xy;',
    '#else',
    '  return texture2D(uVelocity, uv).xy;',
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
    // ── 日·宣纸：暖白 + fbm 纤维 + 帘纹 + 絮斑 + 毛边 vignette，逐通道吸收 ──
    // （F4 克制：纸纹幅度都压在 ~0.012–0.02，墨永远是主角）
    '    vec3 paper = vec3(0.980, 0.969, 0.941);',
    '    float fiber = fbm(uv * vec2(aspectRatio, 1.0) * 380.0);',
    '    float blotch = fbm(uv * vec2(aspectRatio, 1.0) * 6.0);',
    '    paper -= (fiber - 0.5) * 0.018;',
    '    paper -= (blotch - 0.5) * 0.012;',
    '    float paperGate = 1.0 - smoothstep(0.02, 0.30, dC);',  // 1=留白 0=墨上（纸纹不上墨）
    PAPER_FX +
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
    // ── F4 夜·星河：程序化疏星，采样坐标被 velocity 偏移（星随涡漂）──
    // 缓而贵：星稀、动得慢、墨浓处星减淡（墨吞星光）。
    '    vec2 vel = sampleVelD(uv);',
    '    vec2 starUv = uv * vec2(aspectRatio, 1.0) * 2.0 + vel * 0.06;',  // 涡漂偏移
    '    vec2 cell = floor(starUv * 8.0);',
    '    float starSeed = hash(cell);',
    '    vec3 stars = vec3(0.0);',
    '    if (starSeed > 0.93) {',                          // 仅 ~7% 格子有星（疏）
    '      vec2 fpos = fract(starUv * 8.0) - 0.5;',
    '      float d = length(fpos);',
    '      float tw = 0.6 + 0.4 * sin(time * 0.7 + starSeed * 40.0);', // 轻微闪烁
    '      float s = smoothstep(0.18, 0.0, d) * tw;',
    '      float dim = 1.0 - smoothstep(0.05, 0.4, dC);',  // 墨浓处星减淡
    '      stars = vec3(0.62, 0.70, 0.85) * s * 0.5 * dim;',
    '    }',
    '    col = deep + emissive + stars;',
    '  }',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var splatPrg = program(BASE_VERT, SPLAT_FRAG);
  var textSplatPrg = program(BASE_VERT, TEXT_SPLAT_FRAG);
  var advectPrg = program(BASE_VERT, ADVECT_FRAG);
  var divergencePrg = program(BASE_VERT, DIVERGENCE_FRAG);
  var curlPrg = program(BASE_VERT, CURL_FRAG);
  var vorticityPrg = program(BASE_VERT, VORTICITY_FRAG);
  var pressurePrg = program(BASE_VERT, PRESSURE_FRAG);
  var clearPrg = program(BASE_VERT, CLEAR_FRAG);
  var gradientPrg = program(BASE_VERT, GRADIENT_FRAG);
  var displayPrg = program(BASE_VERT, DISPLAY_FRAG);
  if (!splatPrg || !textSplatPrg || !advectPrg || !divergencePrg || !curlPrg || !vorticityPrg ||
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
    textSplatPrg = program(BASE_VERT, TEXT_SPLAT_FRAG);
    advectPrg = program(BASE_VERT, ADVECT_FRAG);
    divergencePrg = program(BASE_VERT, DIVERGENCE_FRAG);
    curlPrg = program(BASE_VERT, CURL_FRAG);
    vorticityPrg = program(BASE_VERT, VORTICITY_FRAG);
    pressurePrg = program(BASE_VERT, PRESSURE_FRAG);
    clearPrg = program(BASE_VERT, CLEAR_FRAG);
    gradientPrg = program(BASE_VERT, GRADIENT_FRAG);
    displayPrg = program(BASE_VERT, DISPLAY_FRAG);
    if (!splatPrg || !textSplatPrg || !advectPrg || !divergencePrg || !curlPrg || !vorticityPrg ||
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
    // F2 字墨呼吸期：完全冻结 dye（不平流不扩散）→ 笔画像素级清晰、不被半拉格朗日数值扩散抹糊；
    //    呼吸结束解冻，字随恢复的水流自然冲散消融。
    if (freezeDye) return;                                        // 呼吸期：dye 静止不动（字稳住）
    var dyeDiss = config.DENSITY_DISSIPATION + washing * 2.2;
    var dyeDiff = config.DYE_DIFFUSE;
    gl.uniform1i(advectPrg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectPrg.uniforms.uSource, dye.read.attach(1));
    gl.uniform2f(advectPrg.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1f(advectPrg.uniforms.dissipation, dyeDiss);
    gl.uniform1f(advectPrg.uniforms.diffuse, dyeDiff);
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
    gl.uniform1i(displayPrg.uniforms.uVelocity, velocity.read.attach(1));   // F4 星河漂移
    gl.uniform2f(displayPrg.uniforms.texelSizeV, velocity.texelSizeX, velocity.texelSizeY);
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
     9b. F2 字入墨：离屏 canvas 写东句 → alpha 上传 → text-splat 注入 dye
        东句不再浮在上面，而是「写进流体的墨」，被环流冲散消融。
     ────────────────────────────────────────── */
  var brushReady = false;             // FontFace 加载完成（或超时走系统栈）
  var textCanvas = document.createElement('canvas');
  var textCtx = textCanvas.getContext('2d');
  var textTex = null;                 // 文字 alpha 上传的纹理（每次重画重传）

  // 把一句东句竖排画进离屏 canvas（逐字下排，毛笔字），返回是否成功
  function renderTextToCanvas(text) {
    if (!textCtx) return false;
    // 文字图分辨率对齐 dye（够清晰又不浪费）；竖排居中
    var W = dye.width, H = dye.height;
    textCanvas.width = W; textCanvas.height = H;
    textCtx.clearRect(0, 0, W, H);
    var chars = text.split('');
    // 字号随视口自适应（移动端缩小）：以画布高定基准，按字数不溢出收敛
    var base = isMobile ? 0.078 : 0.092;             // 占画布高比例（略收，留笔画间隙）
    var fs = H * base;
    var gap = fs * 1.26;                              // 行距（竖排逐字下移；加大避免竖向粘连）
    var totalH = gap * chars.length;
    var maxH = H * (isMobile ? 0.80 : 0.74);
    if (totalH > maxH) { var k = maxH / totalH; fs *= k; gap *= k; totalH = maxH; }
    // canvas 不解析 CSS 变量，给具体栈：自托管毛笔体首位 + 系统楷/行楷兜底
    var fam = '"MSZ Brush", "Xingkai SC", "Kaiti SC", "STKaiti", "KaiTi", "Songti SC", serif';
    // 画白字：上传后纹理 .r = 笔画覆盖度（抗锯齿边缘自带渐变），shader 读 .r 即字形
    textCtx.fillStyle = '#fff';
    textCtx.textAlign = 'center';
    textCtx.textBaseline = 'middle';
    textCtx.font = '500 ' + fs + 'px ' + fam + ', serif';
    var cx = W * 0.5;
    var y0 = (H - totalH) * 0.5 + gap * 0.5;
    for (var i = 0; i < chars.length; i++) {
      textCtx.fillText(chars[i], cx, y0 + gap * i);
    }
    return true;
  }

  // 上传当前 textCanvas 的 alpha 到纹理（R 通道 = alpha；FLIP_Y 对齐 GL UV）
  function uploadTextTex() {
    if (!textTex) textTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);     // 2D canvas 顶向下 → 翻成 GL UV
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);    // 复位，别污染后续上传
  }

  // 一帧注入：把文字 alpha×amount 的玄墨 K 加进 dye（分帧叠加，叠出厚度）
  function textSplatFrame(amount, seedV) {
    if (!textTex) return;
    var inkPig = PIGMENTS[0];          // 玄墨：昼墨黑 / 夜自动月白
    bindQuad(textSplatPrg);
    gl.uniform1i(textSplatPrg.uniforms.uTarget, dye.read.attach(0));
    gl.uniform1i(textSplatPrg.uniforms.uText, (gl.activeTexture(gl.TEXTURE1), gl.bindTexture(gl.TEXTURE_2D, textTex), 1));
    gl.uniform3f(textSplatPrg.uniforms.inkK, inkPig.K[0], inkPig.K[1], inkPig.K[2]);
    gl.uniform1f(textSplatPrg.uniforms.amount, amount);
    gl.uniform1f(textSplatPrg.uniforms.seed, seedV);
    blit(dye.write); dye.swap();
  }

  // 编排一次「字入墨」：渲染 → 上传 → 2-3 帧叠加注入。返回是否真注入了。
  var injecting = false;              // 入墨动画进行中（节流点击重注）
  function injectEastText(text) {
    if (!text) return false;
    if (!renderTextToCanvas(text)) return false;
    uploadTextTex();
    injecting = true;                                 // 节流：动画进行中点击题跋无效
    var frames = isMobile ? 2 : 3;                    // 分帧叠加：洇墨厚度
    var conc = 1.0;                                   // 字墨浓（清晰可读）
    for (var f = 0; f < frames; f++) {
      textSplatFrame(conc / frames * 1.15, rand() * 1000);   // 不过饱和，保笔画开口
    }
    inkBudget += conc * 1.6;                          // 字也算墨预算，别被近空白网误判
    setTimeout(function () { injecting = false; }, 900);
    return true;
  }

  // F2 题跋点击 → 该句重新入墨一次（节流：入墨动画进行中无效）
  function reinjectCouplet() {
    if (injecting || !currentCouplet || introActive || washing > 0) return;
    flowDamp = 0; freezeDye = true;                   // 重注时冻结，字清晰再被冲散
    injectEastText(currentCouplet.e);
    onAudio('bell');
    setTimeout(function () { freezeDye = false; }, 2400);
    rampFlowDamp(2400, 1200);                         // 看清后缓缓恢复环流冲散
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

  /* F2 后：东句已是「入墨的字」（流体里的墨），不再浮 DOM 大字。
     这里只管西文句 DOM 横排小字（Baskerville Italic），在字墨呼吸期淡入、冲散期淡出；
     并在淡出后把东西对写进右下题跋存档区。
     fadeInAt / holdMs 由开场编排传入，与字入墨呼吸窗对齐。 */
  var currentCouplet = null;          // 供题跋点击重注用
  function showCouplet(pair, fadeInAt, holdMs) {
    currentCouplet = pair;
    if (!coupletEl || !coupletEastEl || !coupletWestEl) return;
    coupletEastEl.textContent = '';                  // 东句不再 DOM 大字（已入墨）
    coupletWestEl.textContent = pair.w;
    coupletEl.classList.remove('fade');
    fadeInAt = fadeInAt || 60;
    holdMs = holdMs || 3000;
    laterC(function () { coupletEl.classList.add('show'); }, fadeInAt);              // 呼吸期淡入
    laterC(function () { coupletEl.classList.remove('show'); coupletEl.classList.add('fade'); }, fadeInAt + holdMs);  // 冲散期淡出
    laterC(function () {
      coupletEl.classList.remove('fade');
      if (colophonNoteEl) { colophonNoteEl.textContent = pair.note; colophonNoteEl.classList.add('show'); }
    }, fadeInAt + holdMs + 1400);
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
  // F2 环流阻尼：字墨呼吸期压到近零（墨字清晰可读），呼吸后恢复到 1（水流冲散）
  var flowDamp = 1;
  var freezeDye = false;          // 呼吸期 dye 静止（字像素级清晰，免数值扩散）
  var dampRampTimers = [];
  function rampFlowDamp(startMs, durMs) {
    dampRampTimers.forEach(clearTimeout); dampRampTimers = [];
    var steps = 12;
    for (var s = 0; s <= steps; s++) {
      (function (k) {
        dampRampTimers.push(setTimeout(function () {
          var p = k / steps;
          flowDamp = p * p * (3 - 2 * p);                         // smoothstep 0→1
        }, startMs + durMs * (k / steps)));
      })(s);
    }
  }
  // F4 铺卷：CSS mask 横扫进度（0..1），>0 时 canvas 被左→右软边揭开
  var unrollStart = 0;
  var UNROLL_MS = 1600;
  function rollFlowPersona() {
    flow.kind = Math.floor(rand() * 3);
    flow.dir = rand() * Math.PI * 2;
    // 微风(kind 0)：把方向偏到「近水平」——避免一卷的墨被整体吹出上/下边框（沉底=空场帧）。
    // 回漩/对流(kind 1/2) 的 dir 只决定旋向，不受此影响。
    if (flow.kind === 0) {
      var horiz = rand() < 0.5 ? 0 : Math.PI;            // 向左 or 向右
      flow.dir = horiz + (rand() - 0.5) * (50 * Math.PI / 180);  // ±25° 内的近水平
    }
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
    freezeDye = false;                       // 新卷起始不冻结（铺卷期空场）
    blobs.length = 0;                        // F1 活墨团登记清空
    clearIntro();
    clearCouplets();
    clearTimeout(tipTimer);                  // 清旧卷残留的隐藏 timer，避免到点吞掉新卷刚浮现的拍序小注
    rollFlowPersona();

    // ── F4 铺卷：纸从左向右铺展 ~1.6s，墨/字都等铺完再来 ──
    unrollStart = performance.now();

    // 本卷题跋对（东句即将入墨）
    var pair = drawCouplet();

    // ── F2 开场编排时间轴（接在铺卷之后）──
    // 字墨清晰窗 ≈ [tInk, tBreatheEnd]，覆盖 t≈1.8s–6.6s（含 day-t06 证据帧）。
    var UNROLL = UNROLL_MS;                            // 0     铺卷 ~1.6s
    var BREATHE_HOLD = 4800;                           // 呼吸：环流+扩散阻尼近零，墨字清晰可读
    var tInk = UNROLL;                                 // 铺完即入墨
    var tBreatheEnd = tInk + BREATHE_HOLD;             // 呼吸结束 → 环流恢复、字被冲散
    var tDao = tBreatheEnd + 400;                      // 道生一第一拍接上

    // 铺卷期 + 呼吸期：环流完全冻结（字清晰可读、不被残余速度抹糊）
    flowDamp = 0;
    // 西文句 DOM 横排小字：呼吸期淡入、冲散期淡出（与字墨同步）
    showCouplet(pair, tInk + 120, BREATHE_HOLD - 200);

    // 字入墨：铺卷完成后注入（玄墨 K → 昼墨黑 / 夜月白），分帧叠加；随即冻结 dye（字清晰）
    later(function () {
      freezeDye = true;
      injectEastText(pair.e);
      onAudio('bell');                                 // F5 一声磬（字入墨）
    }, tInk);
    // 呼吸将尽：解冻 dye + 环流在 ~1.2s 内缓缓恢复（字被水流慢慢冲散消融，不硬跳）
    later(function () { freezeDye = false; }, tBreatheEnd);
    rampFlowDamp(tBreatheEnd, 1200);

    // 三拍开场保持「一→二→三」哲学骨架，但每拍参数全随机（随机感+宿命感）
    var pigs = pick3Pigments();                       // 5 选 3 不重复有序：主墨不固定
    var tips = ['道生一', '一生二', '二生三'];
    // 落点：上沿 / 左右上沿随机段；羽流向量：垂直 ±35°、力度 0.7–1.4×；拍间隔随机
    var t = tDao;                                      // 第一拍从「呼吸后」起算
    [0, 1, 2].forEach(function (b) {
      if (b > 0) t += rng(2200, 3800);                // 二三拍间隔随机（收紧，墨早点铺开）
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
        registerBlob(x, y, pig, conc);                 // F1 登记活墨团
        onAudio('drop', { x: x, r: conc });            // F5 水滴
        inkBudget += conc;
        showTip(tips[b], 2600);
      }, when);
    });
    // 「三生万物」后：环流性格接管 + 自动续墨节奏（尽快接管，撞色早点登场）
    later(function () {
      showTip('三生万物', 3200);
      introActive = false;
      autoDrop();                                     // 立即先来一滴，别让场荒着
      scheduleAuto();
    }, t + rng(1500, 2500));
  }

  // 自动续墨：每 5–12s 一次轻柔随机落墨，滴径有方差（生生不息，永远是活的）
  /* ── F1 撞色编排：活墨团登记 + 瞄准边缘落异色 + 双滴连珠 ──
     维护最近落墨（位置/半径/颜料/age≤12s）；自动调度 ~45% 概率改为瞄准某活墨团
     边缘落异色滴，制造「绿还在晕染、蓝已入怀」的相撞。手动落墨不登记不受影响。 */
  var blobs = [];                                       // {x,y,r,pig,born}
  var BLOB_TTL = 12000;
  var lastAutoPig = -1;                                  // 上一滴自动续墨的色：散墨连珠避免同色，画面常多色并存
  function registerBlob(x, y, pig, conc, radiusScale) {
    blobs.push({ x: x, y: y, r: (config.SPLAT_RADIUS / 100) * (radiusScale || 1) * (0.8 + conc * 0.5), pig: pig, born: performance.now() });
    if (blobs.length > 24) blobs.shift();               // 软上限
  }
  function liveBlobs(now) {
    var out = [];
    for (var i = 0; i < blobs.length; i++) {
      if (now - blobs[i].born <= BLOB_TTL) out.push(blobs[i]);
    }
    blobs = out;
    return out;
  }

  // 一次自动落墨（撞色逻辑）：~45% 瞄活墨团边缘落异色；其余随机散落
  function autoDrop() {
    if (introActive || washing > 0 || document.visibilityState !== 'visible') return;
    var now = performance.now();
    var live = liveBlobs(now);
    var x, y, pig, conc, f, rs;
    conc = rng(0.5, 0.92);                              // 续墨浓度（v0.2 验证值）
    f = config.SPLAT_FORCE * rng(0.5, 1.05);
    rs = rng(0.7, 1.5);
    if (live.length > 0 && rand() < 0.32) {
      // 瞄准某活墨团边缘落异色滴（落点 = 团心 + 团半径×随机方向偏移）
      // 注：比例克制——撞色是「点睛」不是主旋律，过频会把各色相撞成灰
      var b = live[Math.floor(rand() * live.length)];
      var dir = rand() * Math.PI * 2;
      var off = b.r * rng(0.85, 1.35);                  // 落在边缘一带
      var aspect = canvas.width / canvas.height;
      x = b.x + Math.cos(dir) * off / Math.max(aspect, 1);
      y = b.y + Math.sin(dir) * off;
      x = Math.min(0.9, Math.max(0.1, x));
      y = Math.min(0.86, Math.max(0.16, y));
      // 异色：从其它「矿物色」里抽（撞色，不撞同色；玄墨留给字入墨，续墨只上彩色不灰场）
      do { pig = 1 + Math.floor(rand() * (PIGMENTS.length - 1)); } while (pig === b.pig && PIGMENTS.length > 2);
      conc = rng(0.6, 0.95);
    } else {
      x = rng(0.16, 0.84);
      y = rng(0.28, 0.82);
      // 续墨抽矿物色 1–4（不抽玄墨(0)，避免黑墨灰场）；且避开上一滴的色——连着的散墨不同色，画面常有多色并存
      do { pig = 1 + Math.floor(rand() * (PIGMENTS.length - 1)); } while (pig === lastAutoPig && PIGMENTS.length > 2);
    }
    lastAutoPig = pig;
    var ang = rand() * Math.PI * 2;
    dropInk(x, y, pig, {
      concentration: conc,
      force: f,
      dx: Math.cos(ang) * f * 0.5,
      dy: -Math.abs(Math.sin(ang)) * f * 0.8 - f * 0.12,   // 减弱恒定下沉，墨不那么快沉底
      radiusScale: rs
    });
    registerBlob(x, y, pig, conc, rs);
    onAudio('drop', { x: x, r: conc * (rs * 0.6 + 0.4) });
    inkBudget += conc;
  }

  function scheduleAuto() {
    if (autoTimer) clearTimeout(autoTimer);
    var delay = rng(3500, 6000);                        // 续墨节奏（再略密：保证 t40+ 窗口常有新鲜浓墨在场，不沉空）
    autoTimer = setTimeout(function () {
      autoDrop();
      // 偶发「双滴连珠」：同邻域 0.5–1.2s 内再落一滴异色（撞色加戏）
      if (!introActive && washing === 0 && rand() < 0.22) {
        var lag = rng(500, 1200);
        later(function () { autoDrop(); }, lag);
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
    if (flowDamp < 0.02) return;                         // F2 呼吸期：环流阻尼近零，墨字静止可读
    var base = 22 * flow.strength * flowDamp;            // 缓流基础力度（26→22：略柔但保留漩涡聚墨力——swirl 把墨拢成浓团才鲜活，过柔反而散成薄雾；相遇/洇染仍在）
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
    dampRampTimers.forEach(clearTimeout); dampRampTimers = [];   // 清字墨阻尼 ramp
    flowDamp = 1; freezeDye = false; // 洗卷期全力环流冲散
    onAudio('wash');                 // F5 水幕白噪 L→R 扫
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

  /* ── F4 铺卷：canvas 上 CSS mask 软边横扫（左→右），墨/字等铺完再来 ──
     不进 shader：直接驱动 canvas.style 的 mask-image 线性渐变揭开。 */
  function setUnrollMask(frac) {
    // frac: 已揭开比例 0..1；软边 ~10% 宽
    if (frac >= 1) { canvas.style.webkitMaskImage = ''; canvas.style.maskImage = ''; return; }
    var hard = Math.max(0, frac * 112 - 6);             // 全不透明边界(%)
    var soft = frac * 112 + 6;                          // 渐隐到透明(%)
    var grad = 'linear-gradient(to right, #000 ' + hard.toFixed(1) + '%, rgba(0,0,0,0) ' + soft.toFixed(1) + '%)';
    canvas.style.webkitMaskImage = grad;
    canvas.style.maskImage = grad;
  }
  function updateUnroll(now) {
    if (unrollStart === 0) return;
    var p = (now - unrollStart) / UNROLL_MS;
    if (p >= 1) { unrollStart = 0; setUnrollMask(1); return; }
    var e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;   // easeInOut
    setUnrollMask(e);
  }

  // 近空白安全网：长时间无墨则刷新题跋开新卷（页面永远是活的，频率放缓）
  // 估计衰减放慢到 0.55×（更贴近真实残墨，避免 inkBudget 提前归零误判触发重置 → 空场帧）；
  // 阈值与驻留时间放宽，只在场真死时才另起一卷。
  function maybeAutoRenew(now, dt) {
    inkBudget *= Math.exp(-config.DENSITY_DISSIPATION * dt * 0.55);
    if (introActive || washing > 0) { nearBlankSince = 0; return; }
    if (inkBudget < 0.04) {
      if (nearBlankSince === 0) nearBlankSince = now;
      else if (now - nearBlankSince > 14000) { beginScroll(); }
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
      if (ae && (ae.closest('.palette') || ae.classList.contains('renew') ||
                 ae.classList.contains('ling') || ae.classList.contains('realm-toggle') ||
                 ae.classList.contains('colophon'))) return;
      document.body.classList.add('chrome-idle');
    }, 5000);
  }
  window.addEventListener('pointermove', wakeChrome, { passive: true });
  [paletteEl, renewEl, realmToggleEl, document.getElementById('lingBtn'), document.getElementById('colophon')].forEach(function (el) {
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

  // F2 题跋存档区点击 → 该句重新入墨（好玩交互）
  var colophonEl = document.getElementById('colophon');
  if (colophonEl) {
    colophonEl.addEventListener('click', function () { reinjectCouplet(); wakeChrome(); });
    colophonEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reinjectCouplet(); }
    });
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
     12b. F5 声境「聆」：全程序化 Web Audio 合成，零音频文件
        默认静音；首次开启时创建 AudioContext（满足手势策略）。
        事件挂在已有编排钩子（落墨 / 字入墨 / 洗卷）上，卡点天然同步。
     ────────────────────────────────────────── */
  var AudioCtx = window.AudioContext || window.webkitAudioContext;
  var audio = {
    ctx: null, master: null, verb: null, bedGain: null,
    on: false, started: false, farTimer: null
  };
  try { audio.on = (localStorage.getItem('eastink-sound') === 'on'); } catch (e) {}

  // 程序化短混响脉冲：噪声指数衰减 buffer（喂 ConvolverNode 加深度）
  function makeImpulse(ctx, seconds, decay) {
    var rate = ctx.sampleRate, len = Math.floor(rate * seconds);
    var buf = ctx.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }
  // 棕噪 buffer（积分白噪），给底噪水房氛围
  function makeBrownNoise(ctx, seconds) {
    var rate = ctx.sampleRate, len = Math.floor(rate * seconds);
    var buf = ctx.createBuffer(1, len, rate);
    var d = buf.getChannelData(0), last = 0;
    for (var i = 0; i < len; i++) {
      var w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
    return buf;
  }

  function buildAudioGraph() {
    var ctx = audio.ctx;
    var master = ctx.createGain(); master.gain.value = 0.9;
    var comp = ctx.createDynamicsCompressor();          // 防爆音
    var verb = ctx.createConvolver(); verb.buffer = makeImpulse(ctx, 2.6, 3.0);
    var verbGain = ctx.createGain(); verbGain.gain.value = 0.32;
    // master → comp → 出；verb 并联回 master 前
    master.connect(verb); verb.connect(verbGain); verbGain.connect(comp);
    master.connect(comp);
    comp.connect(ctx.destination);
    audio.master = master; audio.verb = verb;

    // 底噪：极轻水房氛围（棕噪 → 谐振低通 + 慢 LFO），gain ≤ 0.05
    var bedSrc = ctx.createBufferSource();
    bedSrc.buffer = makeBrownNoise(ctx, 6); bedSrc.loop = true;
    var bedLP = ctx.createBiquadFilter(); bedLP.type = 'lowpass';
    bedLP.frequency.value = 420; bedLP.Q.value = 6;
    var lfo = ctx.createOscillator(); lfo.frequency.value = 0.06;
    var lfoGain = ctx.createGain(); lfoGain.gain.value = 140;
    lfo.connect(lfoGain); lfoGain.connect(bedLP.frequency);
    var bedGain = ctx.createGain(); bedGain.gain.value = 0.0;
    bedSrc.connect(bedLP); bedLP.connect(bedGain); bedGain.connect(master);
    bedSrc.start(); lfo.start();
    audio.bedGain = bedGain;
  }

  function ensureAudio() {
    if (!AudioCtx) return false;
    if (!audio.ctx) {
      try { audio.ctx = new AudioCtx(); } catch (e) { return false; }
      buildAudioGraph();
      audio.started = true;
    }
    if (audio.ctx.state === 'suspended') audio.ctx.resume();
    return true;
  }

  // 偶发远滴（8–20s 随机）——底噪之上一点空灵
  function scheduleFarDrop() {
    if (audio.farTimer) clearTimeout(audio.farTimer);
    audio.farTimer = setTimeout(function () {
      if (audio.on && audio.ctx && !document.hidden) sfxDrop((Math.random() * 0.8 + 0.1), 0.4, true);
      scheduleFarDrop();
    }, 8000 + Math.random() * 12000);
  }

  // 水滴：noise burst 经带通 + sine 600→150Hz 滑落；pan 随 x，响度随 r
  function sfxDrop(x, r, far) {
    var ctx = audio.ctx; if (!ctx) return;
    var t = ctx.currentTime;
    var pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) pan.pan.value = Math.max(-1, Math.min(1, (x - 0.5) * 1.8));
    var out = ctx.createGain();
    var amp = (far ? 0.05 : 0.16) * (0.6 + r * 0.7);
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(amp, t + 0.006);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    // 带通噪声「啵」
    var nb = ctx.createBufferSource(); nb.buffer = makeImpulse(ctx, 0.12, 1.0);
    var bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = 1400 - r * 400; bp.Q.value = 1.2;
    nb.connect(bp); bp.connect(out);
    // 正弦下滑（水滴主体）
    var osc = ctx.createOscillator(); osc.type = 'sine';
    var f0 = 600 - r * 120, f1 = 150 - r * 30;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(60, f1), t + 0.22);
    var oG = ctx.createGain(); oG.gain.value = 0.7;
    osc.connect(oG); oG.connect(out);
    var dest = pan || audio.master;
    out.connect(dest); if (pan) pan.connect(audio.master);
    nb.start(t); osc.start(t); nb.stop(t + 0.15); osc.stop(t + 0.5);
  }

  // 字入墨一声磬：FM 钟（载波 ~520–660、调制比 ~3.01、衰减 3–5s）
  function sfxBell() {
    var ctx = audio.ctx; if (!ctx) return;
    var t = ctx.currentTime;
    var carF = 520 + Math.random() * 140;
    var car = ctx.createOscillator(); car.type = 'sine'; car.frequency.value = carF;
    var mod = ctx.createOscillator(); mod.type = 'sine'; mod.frequency.value = carF * 3.01;
    var modG = ctx.createGain(); modG.gain.value = carF * 1.4;
    mod.connect(modG); modG.connect(car.frequency);
    var out = ctx.createGain();
    var dur = 3.5 + Math.random() * 1.5;
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    car.connect(out); out.connect(audio.master);
    car.start(t); mod.start(t); car.stop(t + dur); mod.stop(t + dur);
  }

  // 另起一卷：水幕白噪 L→R 扫 3s + 低通下滑
  function sfxWash() {
    var ctx = audio.ctx; if (!ctx) return;
    var t = ctx.currentTime;
    var src = ctx.createBufferSource(); src.buffer = makeBrownNoise(ctx, 3.2);
    var lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(5200, t);
    lp.frequency.exponentialRampToValueAtTime(380, t + 3.0);
    var out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.linearRampToValueAtTime(0.12, t + 0.4);
    out.gain.setValueAtTime(0.12, t + 2.2);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 3.1);
    var pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) { pan.pan.setValueAtTime(-1, t); pan.pan.linearRampToValueAtTime(1, t + 3.0); }
    src.connect(lp); lp.connect(out);
    if (pan) { out.connect(pan); pan.connect(audio.master); } else out.connect(audio.master);
    src.start(t); src.stop(t + 3.2);
  }

  // 对外统一事件分发（未开声则 no-op；已有编排钩子直接调）
  function onAudio(type, opts) {
    if (!audio.on || !audio.ctx || audio.ctx.state !== 'running') return;
    opts = opts || {};
    if (type === 'drop') sfxDrop(opts.x != null ? opts.x : 0.5, opts.r != null ? opts.r : 0.7, false);
    else if (type === 'bell') sfxBell();
    else if (type === 'wash') sfxWash();
  }

  // 聆 开关：首次开启 = 手势 → 建 ctx；底噪渐入；localStorage 记偏好
  function setSound(on) {
    if (on) {
      if (!ensureAudio()) return;
      audio.on = true;
      if (audio.bedGain) {
        var t = audio.ctx.currentTime;
        audio.bedGain.gain.cancelScheduledValues(t);
        audio.bedGain.gain.setTargetAtTime(0.045, t, 1.2);  // ≤0.05
      }
      scheduleFarDrop();
    } else {
      audio.on = false;
      if (audio.bedGain && audio.ctx) {
        var t2 = audio.ctx.currentTime;
        audio.bedGain.gain.setTargetAtTime(0.0001, t2, 0.4);
      }
      if (audio.farTimer) { clearTimeout(audio.farTimer); audio.farTimer = null; }
    }
    try { localStorage.setItem('eastink-sound', on ? 'on' : 'off'); } catch (e) {}
    if (lingBtn) {
      lingBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      lingBtn.classList.toggle('on', on);
    }
  }

  // 「聆」竖排按钮（左下「另起一卷」上方）
  var lingBtn = document.getElementById('lingBtn');
  if (lingBtn) {
    lingBtn.addEventListener('click', function () {
      setSound(!audio.on);
      wakeChrome();
    });
    // 初始视觉：偏好开过则标记按下态（但浏览器手势策略 → 仍需本次点击恢复 ctx）
    lingBtn.setAttribute('aria-pressed', audio.on ? 'true' : 'false');
    lingBtn.classList.toggle('on', audio.on);
    // 开过声的：下次进来 ctx 未建（无手势），保持视觉提示；首次任意手势恢复
    if (audio.on) {
      var resumeOnce = function () {
        if (ensureAudio()) { setSound(true); }
        window.removeEventListener('pointerdown', resumeOnce);
      };
      window.addEventListener('pointerdown', resumeOnce, { once: true });
    }
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
    updateUnroll(now);                // F4 铺卷：纸从左向右铺展
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
      if (audio.ctx && audio.ctx.state === 'running') audio.ctx.suspend();   // F5 后台 suspend
    } else {
      startLoop();
      if (audio.on && audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
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

  // ── 启动：先把毛笔体加载完再开第一卷（字入墨用），2s 超时兜底走系统栈 ──
  var started = false;
  function startFirstScroll() {
    if (started) return; started = true;
    beginScroll();
  }
  wakeChrome();
  rafId = requestAnimationFrame(loop);                  // 先开循环：铺卷/纸纹立即渲染

  if (document.fonts && document.fonts.load) {
    var fontTimeout = setTimeout(function () { startFirstScroll(); }, 2000);  // 兜底
    document.fonts.load('500 40px "MSZ Brush"', '東墨道生一').then(function () {
      brushReady = true;
      clearTimeout(fontTimeout);
      startFirstScroll();
    }).catch(function () {
      clearTimeout(fontTimeout);
      startFirstScroll();                               // 加载失败也开（系统栈兜底）
    });
  } else {
    startFirstScroll();
  }

  // 对外极小接口（调试用，可无）
  window.__eastink = {
    newScroll: beginScroll,
    renew: startWash,
    setPigment: function (i) { currentPigment = i; },
    setRealm: setRealm,
    reinject: function () { reinjectCouplet(); }
  };
})();
