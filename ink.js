/* ─────────────────────────────────────────────
   Lindaly.cn · 流体墨水消融背景
   GPU 域扭曲 fbm 流噪声：墨在水里缓慢游动、消融、混色
   昼 = 金/玉/宣纸色墨在暖白水；夜 = 靛蓝/月白/墨色在深水
   开销只跟像素数挂钩，手机也顺；无 WebGL 时静默回退
   ───────────────────────────────────────────── */
(function () {
  'use strict';

  var canvas = document.getElementById('ink');
  if (!canvas) return;

  var gl = null;
  try {
    gl = canvas.getContext('webgl', { antialias: false, depth: false, alpha: false, premultipliedAlpha: false })
      || canvas.getContext('experimental-webgl');
  } catch (e) { gl = null; }

  if (!gl) {
    /* 老旧 webview 无 WebGL：藏起墨层，回退到 body 底色 + 星空层 */
    canvas.style.display = 'none';
    window.__ink = { setMode: function () {} };
    return;
  }

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var isMobile = window.matchMedia('(max-width: 760px)').matches;
  var renderScale = isMobile ? 0.55 : 0.82;

  /* ── 调色板（rgb 0..1）──────────────────────
     每套四色：water 底 / 墨A / 墨B / 高光墨C
     昼保持轻透（淡彩晕染），夜可深邃浓郁          */
  var PALETTES = {
    day: {
      c0: [0.984, 0.973, 0.949],  /* 宣纸暖白 */
      c1: [0.915, 0.720, 0.330],  /* 阳光金墨（浓） */
      c2: [0.420, 0.640, 0.520],  /* 山岚玉墨（浓） */
      c3: [0.880, 0.430, 0.300]   /* 朱砂入水高光 */
    },
    night: {
      c0: [0.025, 0.040, 0.090],  /* 深水墨底 */
      c1: [0.150, 0.230, 0.520],  /* 靛蓝墨（浓） */
      c2: [0.080, 0.420, 0.440],  /* 苍青墨（浓） */
      c3: [0.920, 0.870, 0.720]   /* 月白高光 */
    }
  };

  var VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}';

  var FRAG = [
    'precision highp float;',
    'uniform vec2 uRes;',
    'uniform float uTime;',
    'uniform vec3 uC0;uniform vec3 uC1;uniform vec3 uC2;uniform vec3 uC3;',
    'float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}',
    'float noise(vec2 p){vec2 i=floor(p),f=fract(p);float a=hash(i),b=hash(i+vec2(1.0,0.0)),c=hash(i+vec2(0.0,1.0)),d=hash(i+vec2(1.0,1.0));vec2 u=f*f*(3.0-2.0*f);return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);}',
    /* 每层旋转 2.05x 缩放，打破网格规律性 */
    'float fbm(vec2 p){float s=0.0,a=0.5;mat2 R=mat2(0.80,0.62,-0.62,0.80);for(int i=0;i<6;i++){s+=a*noise(p);p=R*p*2.05;a*=0.5;}return s;}',
    /* 脊线湍流：abs 折叠出尖锐墨丝拖尾 */
    'float turb(vec2 p){float s=0.0,a=0.5;mat2 R=mat2(0.80,0.62,-0.62,0.80);for(int i=0;i<5;i++){s+=a*abs(noise(p)*2.0-1.0);p=R*p*2.05;a*=0.5;}return s;}',
    'void main(){',
    '  vec2 uv=gl_FragCoord.xy/uRes.xy;',
    '  vec2 p=uv*vec2(uRes.x/uRes.y,1.0)*2.2;',
    '  float t=uTime*0.09;',
    /* 三重域扭曲，每层不同方向不同速度 = 不可预测的洇散 */
    '  vec2 q=vec2(fbm(p+vec2(1.7,2.3)+vec2(0.0,t)),fbm(p+vec2(8.3,1.1)+vec2(t*0.7,0.0)));',
    '  vec2 r=vec2(fbm(p+3.5*q+vec2(1.7,9.2)+vec2(-t*0.6,t*0.4)),fbm(p+3.5*q+vec2(8.3,2.8)+vec2(t*0.5,-t*0.8)));',
    '  float f=fbm(p+4.0*r);',
    '  float td=turb(p*1.5+2.5*r+vec2(t*0.35,-t*0.25));',
    /* 三层墨脉，各自受控覆盖率：底色始终占主导，昼夜分明 */
    '  float ink1=smoothstep(0.42,0.86,f);',
    '  float ink2=smoothstep(0.50,0.96,length(q)*0.72);',
    '  float hi=pow(smoothstep(0.52,0.92,td),2.0);',
    '  vec3 col=uC0;',
    '  col=mix(col,uC1,ink1*0.92);',
    '  col=mix(col,uC2,ink2*0.72);',
    '  col=mix(col,uC3,hi*0.55);',
    /* 较轻的中心 vignette：保留磅礴，又不糊文字 */
    '  float vig=smoothstep(1.30,0.24,length((uv-vec2(0.5,0.42))*vec2(1.0,1.2)));',
    '  col=mix(uC0,col,0.62+0.38*vig);',
    '  gl_FragColor=vec4(col,1.0);',
    '}'
  ].join('\n');

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { gl.deleteShader(s); return null; }
    return s;
  }

  var vs = compile(gl.VERTEX_SHADER, VERT);
  var fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) { canvas.style.display = 'none'; window.__ink = { setMode: function () {} }; return; }

  var prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { canvas.style.display = 'none'; window.__ink = { setMode: function () {} }; return; }
  gl.useProgram(prog);

  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var locP = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(locP);
  gl.vertexAttribPointer(locP, 2, gl.FLOAT, false, 0, 0);

  var uRes = gl.getUniformLocation(prog, 'uRes');
  var uTime = gl.getUniformLocation(prog, 'uTime');
  var uC = [
    gl.getUniformLocation(prog, 'uC0'),
    gl.getUniformLocation(prog, 'uC1'),
    gl.getUniformLocation(prog, 'uC2'),
    gl.getUniformLocation(prog, 'uC3')
  ];

  /* 当前色 / 目标色：切换昼夜时缓慢 lerp 出"墨色化开"的过渡 */
  function clonePal(p) { return { c0: p.c0.slice(), c1: p.c1.slice(), c2: p.c2.slice(), c3: p.c3.slice() }; }
  var urlMode = (function () { try { return new URLSearchParams(location.search).get('mode'); } catch (e) { return null; } })();
  var startMode = (urlMode === 'night' || urlMode === 'day')
    ? urlMode
    : ((document.documentElement.getAttribute('data-mode') === 'night') ? 'night' : 'day');
  var cur = clonePal(PALETTES[startMode]);
  var target = clonePal(PALETTES[startMode]);

  function lerpInto(a, b, k) {
    ['c0', 'c1', 'c2', 'c3'].forEach(function (key) {
      for (var i = 0; i < 3; i++) a[key][i] += (b[key][i] - a[key][i]) * k;
    });
  }

  function resize() {
    var w = Math.max(1, Math.round(window.innerWidth * renderScale));
    var h = Math.max(1, Math.round(window.innerHeight * renderScale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    gl.uniform2f(uRes, w, h);
  }
  window.addEventListener('resize', resize);
  resize();

  function pushColors() {
    gl.uniform3fv(uC[0], cur.c0);
    gl.uniform3fv(uC[1], cur.c1);
    gl.uniform3fv(uC[2], cur.c2);
    gl.uniform3fv(uC[3], cur.c3);
  }

  var t0 = 0, running = true;
  function frame(ms) {
    if (!running) return;
    if (!t0) t0 = ms;
    var t = (ms - t0) / 1000;
    lerpInto(cur, target, 0.045);
    gl.uniform1f(uTime, t);
    pushColors();
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(frame);
  }

  /* 标签页隐藏时暂停（省电），回来再续 */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { running = false; }
    else if (!reduced) { running = true; t0 = 0; requestAnimationFrame(frame); }
  });

  window.__ink = {
    setMode: function (mode) {
      target = clonePal(PALETTES[mode === 'night' ? 'night' : 'day']);
      if (reduced) { cur = clonePal(target); gl.uniform1f(uTime, 0); pushColors(); gl.drawArrays(gl.TRIANGLES, 0, 3); }
    }
  };

  if (reduced) {
    gl.uniform1f(uTime, 6.0);
    pushColors();
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  } else {
    requestAnimationFrame(frame);
  }
})();
