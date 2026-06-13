/* ─────────────────────────────────────────────
   Lindaly.cn · 「昼夜 Two Skies」 v1.0
   ───────────────────────────────────────────── */
(function () {
  'use strict';

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var _now = new Date();
  var dateSeed = _now.getFullYear() * 372 + (_now.getMonth() + 1) * 31 + _now.getDate();
  var DAY_SKY = ['motes', 'petals', 'goldleaf', 'willow'][dateSeed % 4];

  /* ══ 数据层 ══════════════════════════════════ */

  var PROJECTS = [
    {
      glyph: '晨',
      name: 'FreshMe',
      zh: '新省吾身',
      desc: '极简晨间练习播放器：点一下 Start，按当天日期生成一套古琴、道家、静心音乐的早晨流（50–90 分钟），每天配一张不重样的封面。',
      en: 'A one-tap morning practice player — a daily, date-seeded flow of guqin and quiet-cultivation music.',
      url: 'https://lindalyx-lee.github.io/freshme/'
    },
    {
      glyph: '恒',
      name: 'Arete',
      zh: '每日修炼清单',
      desc: '每天自动生成一份专属的健身 + 冥想清单，打开就能跟着今天的节奏练，它会慢慢学会你的偏好。',
      en: 'A daily fitness + meditation planner that slowly learns what you like.',
      url: 'https://lindalyx-lee.github.io/Arete/'
    },
    {
      glyph: '词',
      name: 'Word Battle',
      zh: '单词大作战',
      desc: '给孩子做的英语背单词小游戏，把枯燥的单词表变成闯关打怪。iPad 触屏友好，小朋友亲测上头。',
      en: 'A word-battle game built for a kid — vocabulary lists turned into boss fights.',
      url: 'https://lindalyx-lee.github.io/Play-English/'
    },
    {
      glyph: '墨',
      name: 'EastInk',
      zh: '東墨 · 道生一',
      desc: '一张会生生不息的水墨画布。每次打开新开一卷，颜色、落点、流向不可复现——点墨、拖墨，看不同的墨在水里相遇、洇染、消融。日境宣纸，夜境深水，墨入夜化光。静心内察，随机宿命感。',
      en: 'An ever-renewing ink-wash canvas — each visit opens a new scroll, its colors, landings and currents never the same twice. Tap and drag the ink; watch it meet, bleed and dissolve. Paper by day, deep water by night, ink turning to light — a still space of chance and fate.',
      url: '/eastink.html'
    },
    {
      glyph: '酿',
      name: 'Next…',
      zh: '下一个小东西',
      desc: '正在和我的 AI 伙伴们一起酿。做好了会先放在这里。',
      en: 'Brewing with my AI companions. New toys land here first.',
      url: '',
      coming: true
    }
  ];

  var PAIRS = [
    {
      east: { text: '知人者智，自知者明。', src: '老子 · 道德经' },
      west: { text: 'Know thyself.', src: 'Socrates · 德尔斐神谕' }
    },
    {
      east: { text: '上善若水。水善利万物而不争。', src: '老子 · 道德经' },
      west: { text: 'Be water, my friend.', src: 'Bruce Lee 李小龙' }
    },
    {
      east: { text: '穷则变，变则通，通则久。', src: '易经 · 系辞' },
      west: { text: 'There is nothing permanent except change.', src: 'Heraclitus 赫拉克利特' }
    },
    {
      east: { text: '知行合一。', src: '王阳明' },
      west: { text: 'We are what we repeatedly do.', src: 'Will Durant 杜兰特 · 释亚里士多德' }
    },
    {
      east: { text: '天地与我并生，而万物与我为一。', src: '庄子 · 齐物论' },
      west: { text: 'I am large, I contain multitudes.', src: 'Walt Whitman 惠特曼' }
    },
    {
      east: { text: '回首向来萧瑟处，归去，也无风雨也无晴。', src: '苏轼 · 定风波' },
      west: { text: 'You have power over your mind — not outside events.', src: 'Marcus Aurelius 马可·奥勒留' }
    },
    {
      east: { text: '苟日新，日日新，又日新。', src: '大学 · 汤之盘铭' },
      west: { text: 'Make it new.', src: 'Ezra Pound 庞德 — 译自此句' }
    },
    {
      east: { text: '君子和而不同。', src: '孔子 · 论语' },
      west: { text: 'I disapprove of what you say, but I will defend to the death your right to say it.', src: 'Evelyn B. Hall · 论伏尔泰' }
    },
    {
      east: { text: '问君何能尔，心远地自偏。', src: '陶渊明 · 饮酒' },
      west: { text: 'I went to the woods because I wished to live deliberately.', src: 'Thoreau 梭罗 · 瓦尔登湖' }
    },
    {
      east: { text: '应无所住，而生其心。', src: '金刚经' },
      west: { text: 'The only way to make sense out of change is to plunge into it, move with it, and join the dance.', src: 'Alan Watts 阿伦·瓦兹' }
    },
    {
      east: { text: '上工治未病，不治已病。', src: '黄帝内经' },
      west: { text: 'An ounce of prevention is worth a pound of cure.', src: 'Benjamin Franklin 富兰克林' }
    },
    {
      east: { text: '千里之行，始于足下。', src: '老子 · 道德经' },
      west: { text: 'Caminante, no hay camino: se hace camino al andar. — 行者啊，本没有路，路是走出来的。', src: 'Antonio Machado 马查多' }
    }
  ];

  var NOTES = [
    {
      kind: '书 · BOOK',
      title: '《我看见的世界》· 李飞飞',
      why: '在英伟达 GTC 听完她的对谈，如沐春风，立刻开车回斯坦福买了她的自传——她对技术、社会、人类的深度思考让我佩服赞叹。',
      en: 'Fei-Fei Li\u2019s memoir — heard her speak at GTC, drove straight back to Stanford to buy it.'
    },
    {
      kind: '书 · BOOK',
      title: '《创业的国度》· Start-up Nation',
      why: '「管理 5 个以色列人，比管理 50 个其他国家的人还费劲。」从小爱提问、挑战一切理所当然——这正是创新的底层。',
      en: 'Start-up Nation — question everything; that\u2019s where innovation begins.'
    },
    {
      kind: '播客 · PODCAST',
      title: 'Becoming You · Suzy Welch',
      why: '先搞明白「我是谁」，再搞明白「我要做什么」。她那句 "It\'s better to be the author of your life than the editor." 我一直记着。',
      en: 'Suzy Welch\u2019s Becoming You — be the author of your life, not the editor.'
    }
  ];

  var SOCIALS = [
    { name: '', url: 'https://www.xiaohongshu.com/user/profile/573dd4a16a6a69332cded880', icon: '<b class="xhs-badge">小红书</b>' },
    { name: '@LindalyX', url: 'https://x.com/LindalyX', icon: '𝕏' }
  ];

  /* ══ 昼夜模式 ════════════════════════════════ */

  var root = document.documentElement;
  var orbCap = document.getElementById('orbCap');
  var ORB_CAPS = {
    day: '阳中有阴——点那弯小月，入夜 ☾',
    night: '阴中有阳——点那轮小日，破晓 ☀'
  };

  function applyMode(mode) {
    root.setAttribute('data-mode', mode);
    if (orbCap) orbCap.textContent = ORB_CAPS[mode];
    var tc = document.getElementById('themeColor');
    if (tc) tc.setAttribute('content', mode === 'night' ? '#0b0f1e' : '#faf7f0');
    try { localStorage.setItem('lindaly-mode', mode); } catch (e) {}
    if (sky) sky.setMode(mode);
    if (window.__ink) window.__ink.setMode(mode);
  }

  function currentMode() {
    return root.getAttribute('data-mode') === 'night' ? 'night' : 'day';
  }

  /* 日月交换：阳中之阴放大成月，阴中之阳缩回日——CSS 过渡完成天体互换 */
  var celestBusy = false;
  function toggleMode() {
    if (celestBusy) return;
    celestBusy = true;
    applyMode(currentMode() === 'day' ? 'night' : 'day');
    setTimeout(function () { celestBusy = false; }, reducedMotion ? 50 : 1150);
  }

  /* 质检用：?noanim=1 关闭所有动画与渐现，便于截图回归 */
  if (new URLSearchParams(location.search).get('noanim')) {
    root.classList.add('noanim');
    reducedMotion = true;
  }

  /* 初始：URL 参数 > 记住的选择 > 跟着访客的真实时间走（晚上来看到夜） */
  var initMode = new URLSearchParams(location.search).get('mode');
  if (initMode !== 'day' && initMode !== 'night') {
    try { initMode = localStorage.getItem('lindaly-mode'); } catch (e) {}
  }
  if (initMode !== 'day' && initMode !== 'night') {
    var h = new Date().getHours();
    initMode = (h >= 19 || h < 6) ? 'night' : 'day';
  }

  /* ══ 天空画布：昼有光斑，夜有星河 ══════════════ */

  /* 同一片星空，两套命名——东西双名星座 */
  var CONSTELLATIONS = [
    {
      label: '北斗 · Big Dipper',
      box: [0.07, 0.10, 0.24, 0.22],
      pts: [[0.02, 0.25], [0.20, 0.38], [0.38, 0.35], [0.55, 0.48], [0.80, 0.42], [0.85, 0.72], [0.58, 0.78]],
      lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 3]]
    },
    {
      label: '参宿 · Orion',
      box: [0.68, 0.12, 0.20, 0.34],
      pts: [[0.25, 0.08], [0.75, 0.10], [0.40, 0.46], [0.50, 0.50], [0.60, 0.54], [0.78, 0.92], [0.25, 0.90]],
      lines: [[0, 2], [1, 4], [2, 3], [3, 4], [4, 5], [2, 6]]
    },
    {
      label: '心宿 · Scorpius',
      box: [0.13, 0.55, 0.18, 0.26],
      pts: [[0.10, 0.05], [0.30, 0.16], [0.45, 0.32], [0.50, 0.52], [0.56, 0.72], [0.70, 0.86], [0.90, 0.80]],
      lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]
    }
  ];

  function Sky(canvas) {
    var ctx = canvas.getContext('2d');
    var W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
    var mode = 'day';
    var motes = [], stars = [], shooting = null, shootTimer = 0;
    var constIdx = dateSeed % CONSTELLATIONS.length, constT = 0;
    var CONST_FADE = 100, CONST_HOLD = 320, CONST_GAP = 50;
    var CONST_TOTAL = CONST_FADE * 2 + CONST_HOLD + CONST_GAP;

    function resize() {
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    }

    function seed() {
      motes = []; stars = [];
      var i, n;
      n = Math.round(Math.min(54, W / 26));
      for (i = 0; i < n; i++) {
        motes.push({
          x: Math.random() * W, y: Math.random() * H,
          r: 1.2 + Math.random() * 3.4,
          vy: (DAY_SKY === 'petals' || DAY_SKY === 'goldleaf')
            ? 0.25 + Math.random() * 0.5
            : 0.08 + Math.random() * 0.22,
          sway: Math.random() * Math.PI * 2,
          swaySpeed: 0.003 + Math.random() * 0.006,
          a: 0.25 + Math.random() * 0.5,
          tw: Math.random() * Math.PI * 2,
          rot: Math.random() * Math.PI * 2,
          rotSpeed: (Math.random() - 0.5) * 0.02,
          hue: Math.random()
        });
      }
      n = Math.round(Math.min(170, W / 8));
      for (i = 0; i < n; i++) {
        stars.push({
          x: Math.random() * W, y: Math.random() * H * 0.92,
          r: 0.4 + Math.random() * 1.4,
          tw: Math.random() * Math.PI * 2,
          twSpeed: 0.008 + Math.random() * 0.025,
          a: 0.3 + Math.random() * 0.7
        });
      }
    }

    function moteColor(hue, a) {
      if (DAY_SKY === 'petals') {
        if (hue < 0.5) return 'rgba(224,156,146,' + a + ')'; /* 桃瓣粉 */
        if (hue < 0.8) return 'rgba(231,180,120,' + a + ')';
        return 'rgba(240,205,196,' + a + ')';
      }
      if (DAY_SKY === 'goldleaf') {
        return hue < 0.5 ? 'rgba(195,140,45,' + a + ')' : 'rgba(222,170,80,' + a + ')';
      }
      if (DAY_SKY === 'willow') {
        return hue < 0.3 ? 'rgba(227,170,63,' + a + ')' : 'rgba(250,247,238,' + a + ')';
      }
      if (hue < 0.55) return 'rgba(227,170,63,' + a + ')';   /* 阳光金 */
      if (hue < 0.8) return 'rgba(94,143,118,' + a + ')';    /* 森林绿 */
      return 'rgba(255,250,235,' + a + ')';                   /* 晨光白 */
    }

    function drawDay() {
      var i, m, a;
      var falling = (DAY_SKY === 'petals' || DAY_SKY === 'goldleaf');
      for (i = 0; i < motes.length; i++) {
        m = motes[i];
        m.sway += m.swaySpeed; m.tw += 0.012;
        if (falling) {
          m.y += m.vy; m.x += Math.sin(m.sway) * 0.45; m.rot += m.rotSpeed;
          if (m.y > H + 10) { m.y = -10; m.x = Math.random() * W; }
        } else {
          m.y -= m.vy; m.x += Math.sin(m.sway) * 0.3;
          if (m.y < -8) { m.y = H + 8; m.x = Math.random() * W; }
        }
        a = m.a * (0.55 + 0.45 * Math.sin(m.tw));
        if (falling) {
          ctx.save();
          ctx.translate(m.x, m.y);
          ctx.rotate(m.rot);
          ctx.fillStyle = moteColor(m.hue, a);
          ctx.beginPath();
          ctx.ellipse(0, 0, m.r * 2, m.r * 0.95, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else {
          var g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r * 3);
          g.addColorStop(0, moteColor(m.hue, a));
          g.addColorStop(1, moteColor(m.hue, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(m.x, m.y, m.r * 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    function drawNight() {
      var i, s, a;
      for (i = 0; i < stars.length; i++) {
        s = stars[i];
        s.tw += s.twSpeed;
        a = s.a * (0.45 + 0.55 * Math.abs(Math.sin(s.tw)));
        ctx.fillStyle = 'rgba(238,233,210,' + a + ')';
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      /* 星座：东西双名，轮流亮起 */
      constT++;
      if (constT >= CONST_TOTAL) {
        constT = 0;
        constIdx = (constIdx + 1) % CONSTELLATIONS.length;
      }
      var cAlpha = 0;
      if (constT < CONST_FADE) cAlpha = constT / CONST_FADE;
      else if (constT < CONST_FADE + CONST_HOLD) cAlpha = 1;
      else if (constT < CONST_FADE * 2 + CONST_HOLD) cAlpha = 1 - (constT - CONST_FADE - CONST_HOLD) / CONST_FADE;
      if (cAlpha > 0) {
        var c = CONSTELLATIONS[constIdx];
        var bx = c.box[0] * W, by = c.box[1] * H, bw = c.box[2] * W, bh = c.box[3] * H;
        var px = function (p) { return [bx + p[0] * bw, by + p[1] * bh]; };
        ctx.strokeStyle = 'rgba(212,171,88,' + (0.38 * cAlpha) + ')';
        ctx.lineWidth = 1;
        var li, p1, p2;
        for (li = 0; li < c.lines.length; li++) {
          p1 = px(c.pts[c.lines[li][0]]); p2 = px(c.pts[c.lines[li][1]]);
          ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke();
        }
        for (li = 0; li < c.pts.length; li++) {
          p1 = px(c.pts[li]);
          ctx.fillStyle = 'rgba(245,238,215,' + (0.9 * cAlpha) + ')';
          ctx.beginPath(); ctx.arc(p1[0], p1[1], 2.1, 0, Math.PI * 2); ctx.fill();
        }
        ctx.font = '13px "MSZ Brush", "Kaiti SC", serif';
        ctx.fillStyle = 'rgba(234,230,218,' + (0.75 * cAlpha) + ')';
        ctx.fillText(c.label, bx + bw * 0.1, by + bh + 22);
      }

      /* 流星：偶尔划一道 */
      shootTimer--;
      if (!shooting && shootTimer <= 0) {
        shooting = {
          x: W * (0.15 + Math.random() * 0.7), y: H * Math.random() * 0.3,
          vx: 7 + Math.random() * 5, vy: 3 + Math.random() * 2.4,
          life: 1
        };
        shootTimer = 420 + Math.random() * 600; /* 下一颗 7~17 秒后 */
      }
      if (shooting) {
        var sh = shooting;
        sh.x += sh.vx; sh.y += sh.vy; sh.life -= 0.022;
        if (sh.life <= 0 || sh.x > W + 60) { shooting = null; }
        else {
          var grad = ctx.createLinearGradient(sh.x - sh.vx * 9, sh.y - sh.vy * 9, sh.x, sh.y);
          grad.addColorStop(0, 'rgba(236,193,104,0)');
          grad.addColorStop(1, 'rgba(250,242,215,' + (0.85 * sh.life) + ')');
          ctx.strokeStyle = grad;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(sh.x - sh.vx * 9, sh.y - sh.vy * 9);
          ctx.lineTo(sh.x, sh.y);
          ctx.stroke();
        }
      }
    }

    function frame() {
      ctx.clearRect(0, 0, W, H);
      if (mode === 'day') drawDay(); else drawNight();
      if (!reducedMotion) requestAnimationFrame(frame);
    }

    this.setMode = function (m) { mode = m; };
    window.addEventListener('resize', resize);
    resize();
    if (reducedMotion) { frame(); } else { requestAnimationFrame(frame); }
  }

  var skyCanvas = document.getElementById('sky');
  var sky = skyCanvas ? new Sky(skyCanvas) : null;

  applyMode(initMode);

  var discBtn = document.getElementById('disc');
  var navToggleBtn = document.getElementById('navToggle');
  if (discBtn) discBtn.addEventListener('click', toggleMode);
  if (navToggleBtn) navToggleBtn.addEventListener('click', toggleMode);

  /* ══ 作品卡片 ════════════════════════════════ */

  var cardsEl = document.getElementById('projectCards');
  PROJECTS.forEach(function (p) {
    var el = document.createElement('article');
    el.className = 'card reveal' + (p.coming ? ' coming' : '');
    el.innerHTML =
      '<div class="card-glyph" aria-hidden="true">' + p.glyph + '</div>' +
      '<h3>' + p.name + '<small>' + p.zh + '</small></h3>' +
      '<p>' + p.desc + '</p>' +
      (p.en ? '<p class="card-en">' + p.en + '</p>' : '') +
      (p.coming
        ? '<span class="card-cta">酿造中…</span>'
        : '<a class="card-cta" href="' + p.url + '" target="_blank" rel="noopener">试用 → </a>');
    cardsEl.appendChild(el);
  });

  /* ══ 东西相照 ════════════════════════════════ */

  var eastQuote = document.getElementById('eastQuote');
  var eastSrc = document.getElementById('eastSrc');
  var westQuote = document.getElementById('westQuote');
  var westSrc = document.getElementById('westSrc');
  var mirrorCard = document.getElementById('mirrorCard');
  var mirrorNote = document.getElementById('mirrorNote');
  var pairIdx;

  function renderPair(i, animate) {
    pairIdx = i;
    var fill = function () {
      var p = PAIRS[i];
      eastQuote.textContent = p.east.text;
      eastSrc.textContent = '—— ' + p.east.src;
      westQuote.textContent = '“' + p.west.text + '”';
      westSrc.textContent = '— ' + p.west.src;
      mirrorNote.textContent = animate
        ? '第 ' + (i + 1) + ' / ' + PAIRS.length + ' 对 · 抽到喜欢的，截图带走'
        : '第 ' + (i + 1) + ' / ' + PAIRS.length + ' 对 · 今天开门的这一对，由日期决定';
    };
    if (animate && !reducedMotion) {
      mirrorCard.classList.add('swap');
      setTimeout(function () { fill(); mirrorCard.classList.remove('swap'); }, 360);
    } else { fill(); }
  }

  /* 今日开门一对：由日期决定（知性的小彩蛋） */
  var redrawBtn = document.getElementById('redraw');
  if (mirrorCard && eastQuote && westQuote && redrawBtn) {
    renderPair(dateSeed % PAIRS.length, false);

    redrawBtn.addEventListener('click', function () {
      var next = Math.floor(Math.random() * (PAIRS.length - 1));
      if (next >= pairIdx) next++;
      renderPair(next, true);
    });
  }

  /* ══ 路上遇到的好东西 ═════════════════════════ */

  var notesSec = document.getElementById('notes');
  var notesList = document.getElementById('notesList');
  if (NOTES.length) {
    NOTES.forEach(function (n) {
      var el = document.createElement('article');
      el.className = 'note reveal';
      el.innerHTML =
        '<div class="note-kind">' + n.kind + '</div>' +
        '<h3>' + n.title + '</h3>' +
        '<p>' + n.why + '</p>' +
        (n.en ? '<p class="note-en">' + n.en + '</p>' : '');
      notesList.appendChild(el);
    });
    notesSec.hidden = false;
  }

  /* ══ 社交入口（首屏） ═════════════════════════ */

  var socialsEl = document.getElementById('heroSocials');
  if (socialsEl) SOCIALS.forEach(function (s) {
    var el;
    if (s.soon) {
      el = document.createElement('span');
      el.className = 'social-link social-soon';
      el.innerHTML = '<i aria-hidden="true">' + s.icon + '</i>' + s.name + ' · 即将点亮';
      el.title = '马上就来';
    } else {
      el = document.createElement('a');
      el.className = 'social-link';
      el.href = s.url;
      el.target = '_blank';
      el.rel = 'noopener';
      el.innerHTML = '<i aria-hidden="true">' + s.icon + '</i>' + s.name;
    }
    socialsEl.appendChild(el);
  });

  /* ══ 今日宜：黄历彩蛋，每天换一条 ══════════════ */

  var DAILY = [
    { zh: '把一个小想法做成 demo', en: 'Ship one tiny idea', jie: '想法不值钱，做出来的那一刻才开始升值。' },
    { zh: '问一个不好意思问的问题', en: 'Ask the awkward question', jie: '脸皮厚一秒，认知厚一层。' },
    { zh: '出门晒十分钟太阳', en: 'Ten minutes of real sun', jie: '人是光合动物，别骗自己不是。' },
    { zh: '给爸妈打个电话', en: 'Call your folks', jie: '他们不需要你成功，只需要你出声。' },
    { zh: '删掉一个用不上的 App', en: 'Delete one unused app', jie: '注意力是块田，杂草要拔。' },
    { zh: '早睡一小时', en: 'Sleep an hour earlier', jie: '最便宜的进化，是睡够。' },
    { zh: '学一个 AI 新玩法', en: 'Try one new AI trick', jie: 'AI 在进化，你也别闲着。' },
    { zh: '往下抽一对「东西相照」', en: 'Draw a pair below', jie: '两千年前的人早把答案写好了，就在这页下面。' },
    { zh: '走一条没走过的路', en: 'Take a road you haven\u2019t', jie: '导航关掉，惊喜打开。' },
    { zh: '把谢谢说出口', en: 'Say the thank-you out loud', jie: '心里想的不算数，说出口才作数。' },
    { zh: '少刷十分钟手机', en: 'Scroll ten minutes less', jie: '刷到的都是别人的人生，省下来的才是你的。' },
    { zh: '喝够八杯水', en: 'Drink your water', jie: '上工治未病，先从这杯开始。' },
    { zh: '给自己泡一壶好茶', en: 'Brew yourself proper tea', jie: '快不了的事，就让它慢得值得。' },
    { zh: '夸一个朋友的作品', en: 'Praise a friend\u2019s work', jie: '你随口一句好，是别人撑下去的一周。' }
  ];

  var qianTube = document.getElementById('qianTube');
  var qianCard = document.getElementById('qianCard');
  var qianText = document.getElementById('qianText');
  var qianJie = document.getElementById('qianJie');
  var qianAgain = document.getElementById('qianAgain');
  var qianIdx = -1;
  var qianBusy = false;

  function fillQian(i) {
    qianIdx = i;
    var d = DAILY[i];
    qianText.innerHTML = d.zh + '<span class="daily-en">' + d.en + '</span>';
    qianJie.textContent = '解：' + d.jie;
  }

  if (qianTube && qianCard) {
    qianTube.addEventListener('click', function () {
      if (qianBusy) return;
      qianBusy = true;
      if (reducedMotion) {
        fillQian(dateSeed % DAILY.length);
        qianTube.hidden = true;
        qianCard.hidden = false;
        qianBusy = false;
        return;
      }
      qianTube.classList.add('shaking');
      setTimeout(function () {
        qianTube.classList.remove('shaking');
        fillQian(dateSeed % DAILY.length);
        qianTube.hidden = true;
        qianCard.hidden = false;
        qianBusy = false;
      }, 950);
    });
  }
  if (qianAgain) {
    qianAgain.addEventListener('click', function () {
      if (qianBusy) return;
      qianBusy = true;
      var next = Math.floor(Math.random() * (DAILY.length - 1));
      if (next >= qianIdx) next++;
      if (reducedMotion) { fillQian(next); qianBusy = false; return; }
      qianCard.classList.add('swap');
      setTimeout(function () {
        fillQian(next);
        qianCard.classList.remove('swap');
        qianBusy = false;
      }, 320);
    });
  }

  /* ══ 滚动渐现 ════════════════════════════════ */

  var revealTargets = document.querySelectorAll('.sec-head, .mirror-card, .mirror-actions, .note');
  revealTargets.forEach(function (el) { el.classList.add('reveal'); });

  function revealAll() {
    document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('in'); });
  }

  if ('IntersectionObserver' in window) {
    try {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
        });
      }, { threshold: 0.12 });
      document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });
    } catch (e) { revealAll(); }
  } else {
    revealAll();
  }

  /* ══ 炫酷交互：3D 倾斜 + 光晕追鼠标 + 磁吸 + 远山视差 ══ */

  var canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  if (canHover && !reducedMotion) {
    var addTilt = function (el, depth) {
      el.addEventListener('mousemove', function (e) {
        var r = el.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width;
        var py = (e.clientY - r.top) / r.height;
        el.style.setProperty('--mx', (px * 100) + '%');
        el.style.setProperty('--my', (py * 100) + '%');
        el.style.transform = 'perspective(900px) rotateY(' + ((px - 0.5) * depth).toFixed(2) +
          'deg) rotateX(' + ((0.5 - py) * depth).toFixed(2) + 'deg) translateY(-6px)';
      });
      el.addEventListener('mouseleave', function () { el.style.transform = ''; });
    };
    document.querySelectorAll('.card').forEach(function (el) { addTilt(el, 9); });

    var magnet = function (el, pull) {
      el.addEventListener('mousemove', function (e) {
        var r = el.getBoundingClientRect();
        el.style.transform = 'translate(' + ((e.clientX - r.left - r.width / 2) * pull).toFixed(1) +
          'px,' + ((e.clientY - r.top - r.height / 2) * pull).toFixed(1) + 'px)';
      });
      el.addEventListener('mouseleave', function () { el.style.transform = ''; });
    };
    document.querySelectorAll('.btn-draw, .card-cta, .nav-toggle, .social-link').forEach(function (el) { magnet(el, 0.28); });
  }

  /* 远山视差：滚动时山往下沉一点，像人往前走 */
  var mtns = document.getElementById('mountains');
  if (mtns && !reducedMotion) {
    window.addEventListener('scroll', function () {
      mtns.style.transform = 'translateY(' + Math.min(window.scrollY * 0.06, 80).toFixed(1) + 'px)';
    }, { passive: true });
  }

})();
