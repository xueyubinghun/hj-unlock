// ==UserScript==
// @name         海角解锁器 (hj-unlock)
// @namespace    hj-unlock
// @version      4.7.0
// @description  海角帖子/短视频付费视频：解密播放 / 完整下载 / 12并发预取 / 长按2倍速
// @author       -
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ================= 配置 ================= */
  var RESOURCE_ID_DEFAULT = '693715';
  var RID_KEY = 'hj_unlock_resource_id';
  var TABLE = 'mongodb://admin:S3cUr3_P4ss_2026@6.90.10.19:27017/auth';
  var ORIGIN = location.origin;
  var API = ORIGIN + '/api';
  var CDN_BASE = 'https://ts10.hj260302818.top/';
  var HLS_CDNS = [
    'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.js',
    'https://unpkg.com/hls.js@1.5.17/dist/hls.js',
    'https://fastly.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.js'
  ];
  var CONC = 12;
  var CACHE_MAX = 400;
  var LONG_MIN = 20 * 60;
  var LEAD_FACTOR = 12;
  var SHORT_PRELOAD_SEGS = 40;
  var POS_KEY = 'hj_unlock_orb_pos';

  var TOKEN = null, UID = null;
  var lastVideoId = null;
  var lastM3u8 = null;

  function getResourceId() {
    try {
      var v = localStorage.getItem(RID_KEY);
      if (v && /^\d+$/.test(v)) return v;
    } catch (e) {}
    return RESOURCE_ID_DEFAULT;
  }
  function setResourceId(v) {
    try { localStorage.setItem(RID_KEY, v); } catch (e) {}
  }

  /* ================= 抓 token / url（不解析响应体） ================= */
  try {
    var _open = XMLHttpRequest.prototype.open;
    var _setH = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (m, u) {
      try {
        var s = String(u || '');
        var m3 = s.match(/^(https?:\/\/[^?#\s]+\.m3u8)/i);
        if (m3) lastM3u8 = m3[1];
        var mv = s.match(/\/api\/video\/(\d+)/) || s.match(/\/api\/video_center\/(\d+)/);
        if (mv) lastVideoId = mv[1];
      } catch (e) {}
      return _open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try {
        var kl = String(k).toLowerCase();
        if (kl === 'x-user-token') TOKEN = v;
        if (kl === 'x-user-id') UID = v;
      } catch (e) {}
      return _setH.apply(this, arguments);
    };
  } catch (e) {}

  if (window.fetch) {
    var _fetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        var u = typeof input === 'string' ? input : (input && input.url) || '';
        var m3 = String(u).match(/^(https?:\/\/[^?#\s]+\.m3u8)/i);
        if (m3) lastM3u8 = m3[1];
        var mv = String(u).match(/\/api\/video\/(\d+)/) || String(u).match(/\/api\/video_center\/(\d+)/);
        if (mv) lastVideoId = mv[1];

        var h = (init && init.headers) || (input && input.headers) || null;
        if (h) {
          var get = function (n) {
            if (typeof h.get === 'function') return h.get(n);
            for (var k in h) if (String(k).toLowerCase() === n) return h[k];
            return null;
          };
          var t = get('x-user-token'); if (t) TOKEN = t;
          var i2 = get('x-user-id'); if (i2) UID = i2;
        }
      } catch (e) {}
      return _fetch.apply(this, arguments);
    };
  }

  /* ================= 工具 ================= */
  function b64x3(s) {
    var t = s;
    for (var i = 0; i < 3; i++) {
      var bin = atob(t), bytes = new Uint8Array(bin.length);
      for (var j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
      t = new TextDecoder().decode(bytes);
    }
    return t;
  }

  function api(path, method, body) {
    var headers = { 'pcVer': '2', 'Accept': 'application/json' };
    if (TOKEN) headers['X-User-Token'] = TOKEN;
    if (UID) headers['X-User-Id'] = UID;
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(API + path, {
      method: method || 'GET', headers: headers,
      body: body ? JSON.stringify(body) : undefined, credentials: 'include'
    }).then(function (r) { return r.json(); }).then(function (j) {
      return (j && j.isEncrypted) ? JSON.parse(b64x3(j.data)) : j;
    });
  }

  function getTopicId() {
    try {
      var q = new URLSearchParams(location.search);
      var p = q.get('pid') || q.get('topicId');
      if (p && /^\d+$/.test(p)) return p;
      var m = location.pathname.match(/\/(?:post\/details|details)\/(\d+)/);
      if (m) return m[1];
    } catch (e) {}
    return null;
  }

  function getVideoId() {
    try {
      var q = new URLSearchParams(location.search);
      var v = q.get('videoid') || q.get('videoId') || q.get('vid');
      if (v && /^\d+$/.test(v)) return v;
      var m = location.pathname.match(/\/video\/(\d+)/) || location.pathname.match(/\/short\/(\d+)/);
      if (m) return m[1];
    } catch (e) {}
    return lastVideoId;
  }

  function toCdn(u) {
    if (!u) return u;
    if (/^https?:/i.test(u)) return u;
    if (u.indexOf('/api/address/') === 0) return CDN_BASE + u.slice('/api/address/'.length);
    if (u.charAt(0) === '/') return ORIGIN + u;
    return u;
  }

  /* ================= 播放列表 ================= */
  function fetchPlaylist(m3u8Url) {
    var clean = m3u8Url.replace(/[?#].*$/, '');
    var baseDir = clean.slice(0, clean.lastIndexOf('/') + 1);
    return fetch(m3u8Url, { credentials: 'omit', mode: 'cors' })
      .then(function (r) { if (!r.ok) throw new Error('m3u8 HTTP ' + r.status); return r.text(); })
      .then(function (txt) {
        if (txt.indexOf('#EXTM3U') < 0) throw new Error('不是 m3u8');
        var km = txt.match(/URI="([^"]+)"/);
        var ivM = txt.match(/IV=0x([0-9a-fA-F]+)/);
        var keyP = Promise.resolve(null);
        if (km) {
          var keyUrl = new URL(km[1], clean).href;
          keyP = fetch(keyUrl, { credentials: 'omit', mode: 'cors' })
            .then(function (r) { return r.arrayBuffer(); })
            .then(function (ab) {
              var kb = new Uint8Array(ab), tb = new TextEncoder().encode(TABLE);
              var real = new Uint8Array(kb.length);
              for (var i = 0; i < kb.length; i++) real[i] = kb[i] ^ tb[i % tb.length];
              return real;
            });
        }
        return keyP.then(function (keyBytes) {
          var segs = [], dur = 0;
          txt.split('\n').forEach(function (line) {
            var t = line.trim();
            var m = t.match(/#EXTINF:([\d.]+)/);
            if (m) dur += parseFloat(m[1]);
            if (t && t.charAt(0) !== '#' && /\.(ts|m4s)(\?|$)/i.test(t)) {
              segs.push(/^https?:/i.test(t) ? t : baseDir + t);
            }
          });
          return { text: txt, baseDir: baseDir, segs: segs, key: keyBytes, iv: ivM ? ivM[1] : null, dur: dur };
        });
      });
  }

  /* ================= 预取缓存 ================= */
  var segCache = new Map();
  var prefetchAc = null;

  function stopPrefetch() {
    if (prefetchAc) { try { prefetchAc.abort(); } catch (e) {} prefetchAc = null; }
  }

  function putCache(url, ab) {
    segCache.set(url, ab);
    if (segCache.size > CACHE_MAX) segCache.delete(segCache.keys().next().value);
  }

  function startPrefetch(segs, startIdx) {
    stopPrefetch();
    var ac = new AbortController();
    prefetchAc = ac;
    var idx = startIdx || 0;
    function worker() {
      if (ac.signal.aborted || idx >= segs.length) return Promise.resolve();
      var u = segs[idx++];
      if (segCache.has(u)) return worker();
      return fetch(u, { credentials: 'omit', mode: 'cors', signal: ac.signal })
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (ab) { putCache(u, ab); return worker(); })
        .catch(function () { return worker(); });
    }
    for (var i = 0; i < CONC; i++) worker();
  }

  function preloadRange(pl, from, to, onProgress) {
    var total = to - from, done = 0, bytes = 0, idx = from;
    var t0 = Date.now();
    function worker() {
      if (idx >= to) return Promise.resolve();
      var my = idx++;
      var u = pl.segs[my];
      if (segCache.has(u)) {
        done++; bytes += segCache.get(u).byteLength;
        onProgress(done, total, 0, bytes / 1024);
        return worker();
      }
      return fetch(u, { credentials: 'omit', mode: 'cors' })
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (ab) {
          putCache(u, ab);
          done++; bytes += ab.byteLength;
          var sec = (Date.now() - t0) / 1000;
          onProgress(done, total, (bytes / 1024) / Math.max(sec, 0.1), bytes / 1024);
          return worker();
        })
        .catch(function () { done++; onProgress(done, total, 0, bytes / 1024); return worker(); });
    }
    var ws = [];
    for (var i = 0; i < CONC; i++) ws.push(worker());
    return Promise.all(ws);
  }

  function makeCachedLoader(Hls) {
    var Base = Hls.DefaultConfig.loader;
    function L(cfg) { Base.call(this, cfg); }
    L.prototype = Object.create(Base.prototype);
    L.prototype.constructor = L;
    L.prototype.load = function (context, config, callbacks) {
      var self = this, url = context.url;
      if (segCache.has(url)) {
        var data = segCache.get(url);
        setTimeout(function () {
          if (callbacks.onSuccess) {
            callbacks.onSuccess(
              { url: url, data: data },
              { loaded: data.byteLength, total: data.byteLength, trequest: performance.now(), tfirst: performance.now(), tload: performance.now() },
              context, null
            );
          }
        }, 0);
        return;
      }
      return Base.prototype.load.call(self, context, config, callbacks);
    };
    return L;
  }

  /* ================= 解密 / 下载 ================= */
  function decryptSeg(buf, key, ivHex) {
    if (!key) return Promise.resolve(new Uint8Array(buf));
    var iv = new Uint8Array(16);
    if (ivHex) for (var i = 0; i < 16; i++) iv[i] = parseInt(ivHex.substr(i * 2, 2), 16);
    return crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt'])
      .then(function (k) { return crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, k, buf); })
      .then(function (o) { return new Uint8Array(o); })
      .catch(function () { return new Uint8Array(buf); });
  }

  var dlAc = null;

  function downloadAll(pl, onProgress) {
    var total = pl.segs.length, parts = new Array(total);
    var done = 0, bytes = 0, idx = 0, t0 = Date.now();
    var ac = new AbortController();
    dlAc = ac;
    function worker() {
      if (ac.signal.aborted || idx >= total) return Promise.resolve();
      var my = idx++;
      return fetch(pl.segs[my], { credentials: 'omit', mode: 'cors', signal: ac.signal })
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (ab) { return decryptSeg(ab, pl.key, pl.iv); })
        .then(function (u8) {
          parts[my] = u8; done++; bytes += u8.length;
          var sec = (Date.now() - t0) / 1000;
          onProgress(done, total, (bytes / 1024) / Math.max(sec, 0.1), bytes / 1024);
          return worker();
        })
        .catch(function () {
          if (ac.signal.aborted) return Promise.resolve();
          done++; onProgress(done, total, 0, bytes / 1024);
          return worker();
        });
    }
    var ws = [];
    for (var i = 0; i < CONC; i++) ws.push(worker());
    return Promise.all(ws).then(function () {
      if (ac.signal.aborted) throw new Error('已取消');
      return new Blob(parts, { type: 'video/mp2t' });
    });
  }

  function loadHls() {
    return new Promise(function (resolve, reject) {
      if (window.Hls) return resolve(window.Hls);
      var i = 0;
      (function next() {
        if (i >= HLS_CDNS.length) return reject(new Error('hls.js 加载失败'));
        var s = document.createElement('script');
        s.src = HLS_CDNS[i++];
        s.onload = function () { window.Hls ? resolve(window.Hls) : next(); };
        s.onerror = next;
        document.head.appendChild(s);
      })();
    });
  }

  /* ================= 样式 ================= */
  var STYLE_ID = 'hj-unlock-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '@keyframes hj-spin-a{to{transform:rotate(360deg)}}',
      '@keyframes hj-spin-b{to{transform:rotate(-360deg)}}',
      '@keyframes hj-halo{0%,100%{opacity:.30;transform:scale(.94)}50%{opacity:.66;transform:scale(1.08)}}',
      '@keyframes hj-twinkle{0%,100%{opacity:.15}50%{opacity:.85}}',
      '@keyframes hj-rise{from{opacity:0;transform:translateY(12px) scale(.94)}to{opacity:1;transform:translateY(0) scale(1)}}',
      '@keyframes hj-char{0%,100%{filter:drop-shadow(0 0 5px rgba(170,190,255,.55))}50%{filter:drop-shadow(0 0 12px rgba(200,215,255,.95))}}',

      '#hj-orb{position:fixed;right:16px;bottom:96px;width:60px;height:60px;border-radius:50%;',
      'display:flex;align-items:center;justify-content:center;z-index:2147483600;',
      'touch-action:none;user-select:none;-webkit-user-select:none;cursor:pointer;',
      'background:radial-gradient(circle at 32% 26%,rgba(178,193,255,.34),rgba(14,19,38,.96) 62%,rgba(9,12,26,.99) 100%);',
      'border:1px solid rgba(178,193,255,.42);',
      'box-shadow:0 8px 26px rgba(0,0,0,.5),0 0 18px rgba(150,170,255,.20),inset 0 1px 0 rgba(220,230,255,.22);}',
      '#hj-orb:active{transform:scale(.94);}',

      '#hj-orb::before{content:"";position:absolute;inset:-6px;border-radius:50%;',
      'background:conic-gradient(from 0deg,rgba(178,193,255,0) 0% 46%,rgba(200,214,255,.75) 52%,rgba(255,214,232,.55) 56%,rgba(178,193,255,0) 62% 100%);',
      'animation:hj-spin-a 11s linear infinite;',
      '-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 2.5px),#000 calc(100% - 1.5px));',
      'mask:radial-gradient(farthest-side,transparent calc(100% - 2.5px),#000 calc(100% - 1.5px));}',

      '#hj-orb::after{content:"";position:absolute;inset:-13px;border-radius:50%;',
      'background:conic-gradient(from 180deg,rgba(255,214,232,0) 0% 40%,rgba(255,214,232,.42) 50%,rgba(255,214,232,0) 60% 100%);',
      'animation:hj-spin-b 17s linear infinite;opacity:.75;',
      '-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 1.5px),#000 calc(100% - 1px));',
      'mask:radial-gradient(farthest-side,transparent calc(100% - 1.5px),#000 calc(100% - 1px));}',

      '#hj-orb .hj-halo{position:absolute;inset:-9px;border-radius:50%;pointer-events:none;',
      'background:radial-gradient(circle,rgba(160,180,255,.20),rgba(255,200,225,.10) 45%,transparent 70%);',
      'animation:hj-halo 4.4s ease-in-out infinite;}',

      '#hj-orb .hj-star{position:absolute;width:2.5px;height:2.5px;border-radius:50%;background:#e8eeff;pointer-events:none;animation:hj-twinkle 3s ease-in-out infinite;}',
      '#hj-orb .hj-star.s1{top:11%;left:22%;animation-delay:0s;}',
      '#hj-orb .hj-star.s2{top:26%;right:15%;animation-delay:.9s;background:#ffd9e8;}',
      '#hj-orb .hj-star.s3{bottom:18%;left:17%;animation-delay:1.7s;}',
      '#hj-orb .hj-star.s4{bottom:26%;right:21%;animation-delay:2.3s;}',

      '#hj-orb .hj-char{position:relative;z-index:3;',
      'font:400 26px/1 "Songti SC","STSong","SimSun","Songti TC",serif;',
      'background:linear-gradient(175deg,#ffffff 6%,#dfe6ff 42%,#aebbff 74%,#8fa2e6 100%);',
      '-webkit-background-clip:text;background-clip:text;color:transparent;',
      'animation:hj-char 4.4s ease-in-out infinite;}',

      '#hj-sheet{position:fixed;width:172px;padding:11px;border-radius:20px;z-index:2147483600;',
      'background:linear-gradient(165deg,rgba(22,30,54,.90),rgba(11,15,30,.96));',
      'backdrop-filter:blur(18px) saturate(1.1);-webkit-backdrop-filter:blur(18px) saturate(1.1);',
      'border:1px solid rgba(178,193,255,.26);',
      'box-shadow:0 14px 40px rgba(0,0,0,.55),0 0 26px rgba(150,170,255,.14),inset 0 1px 0 rgba(220,230,255,.14);',
      'animation:hj-rise .2s cubic-bezier(.2,.9,.3,1.2) both;}',

      '#hj-sheet .hj-top{display:flex;align-items:center;gap:7px;padding:2px 4px 9px;}',
      '#hj-sheet .hj-top .hj-dot{width:6px;height:6px;border-radius:50%;background:#b9c6ff;box-shadow:0 0 8px rgba(185,198,255,.9);}',
      '#hj-sheet .hj-top .hj-title{font:600 12px/1 -apple-system,"PingFang SC",sans-serif;color:#cdd6ff;letter-spacing:.5px;opacity:.9;}',
      '#hj-sheet .hj-line{height:1px;margin:0 2px 8px;background:linear-gradient(90deg,transparent,rgba(178,193,255,.45),rgba(255,214,232,.35),transparent);}',

      '#hj-sheet button{display:flex;align-items:center;gap:9px;width:100%;margin:5px 0;padding:9px 11px;',
      'border:1px solid rgba(178,193,255,.13);border-radius:12px;cursor:pointer;',
      'font:600 13px/1.2 -apple-system,"PingFang SC",sans-serif;',
      'color:#dfe5ff;background:rgba(178,193,255,.055);transition:all .16s ease;}',
      '#hj-sheet button:active{background:rgba(178,193,255,.20);border-color:rgba(200,214,255,.5);transform:scale(.985);}',
      '#hj-sheet button.hj-dim{color:#9aa6d4;background:rgba(255,255,255,.028);}',
      '#hj-sheet button .hj-ico{width:16px;text-align:center;font-size:14px;opacity:.92;}',

      '#hj-status{margin-top:8px;padding-top:8px;border-top:1px solid rgba(178,193,255,.12);',
      'color:#a9b6e8;font:11px/1.55 -apple-system,sans-serif;white-space:pre-wrap;word-break:break-all;',
      'max-height:200px;overflow:auto;}',
      '#hj-status:empty{display:none;}',

      '#hj-player-tools{position:absolute;right:10px;top:10px;display:flex;gap:8px;z-index:5;}',
      '#hj-player-tools .hj-fbtn{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;',
      'color:#dfe5ff;font-size:15px;background:rgba(14,19,38,.62);backdrop-filter:blur(10px);',
      '-webkit-backdrop-filter:blur(10px);border:1px solid rgba(178,193,255,.34);cursor:pointer;}',
      '#hj-player-tools .hj-fbtn:active{background:rgba(178,193,255,.26);}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }

  /* ================= UI ================= */
  var orb = null, sheet = null, statusEl = null, open = false;
  var playerWrap = null, videoEl = null, bigMode = false;

  function buildUI() {
    if (orb) return;
    injectStyle();

    orb = document.createElement('div');
    orb.id = 'hj-orb';

    var halo = document.createElement('div'); halo.className = 'hj-halo'; orb.appendChild(halo);
    for (var i = 1; i <= 4; i++) {
      var st = document.createElement('div');
      st.className = 'hj-star s' + i;
      orb.appendChild(st);
    }
    var ch = document.createElement('span');
    ch.className = 'hj-char';
    ch.textContent = '希';
    orb.appendChild(ch);
    document.body.appendChild(orb);

    sheet = document.createElement('div');
    sheet.id = 'hj-sheet';
    sheet.style.display = 'none';

    var top = document.createElement('div');
    top.className = 'hj-top';
    var dot = document.createElement('div'); dot.className = 'hj-dot';
    var tt = document.createElement('div'); tt.className = 'hj-title'; tt.textContent = 'HJ UNLOCK';
    top.appendChild(dot); top.appendChild(tt);
    sheet.appendChild(top);

    var line = document.createElement('div'); line.className = 'hj-line';
    sheet.appendChild(line);

    sheet.appendChild(mkItem('▶', '播放'));
    sheet.appendChild(mkItem('⬇', '下载'));
    sheet.appendChild(mkItem('⤢', '放大'));
    sheet.appendChild(mkItem('⚙', '凭证'));
    sheet.appendChild(mkItem('✕', '收起', 'hj-dim'));

    statusEl = document.createElement('div');
    statusEl.id = 'hj-status';
    sheet.appendChild(statusEl);

    document.body.appendChild(sheet);
    bindOrb();
    applyPos();
  }

  function mkItem(icon, text, cls) {
    var b = document.createElement('button');
    if (cls) b.className = cls;
    var i = document.createElement('span'); i.className = 'hj-ico'; i.textContent = icon;
    b.appendChild(i);
    b.appendChild(document.createTextNode(text));
    b.onclick = function (ev) {
      ev.stopPropagation(); ev.preventDefault();
      if (text === '播放') onClickPlay();
      else if (text === '下载') onClickDownload();
      else if (text === '放大') onClickBig();
      else if (text === '凭证') onClickCredential();
      else closeSheet();
    };
    return b;
  }

  var lastToggleAt = 0;
  function safeToggle() {
    var now = Date.now();
    if (now - lastToggleAt < 350) return;
    lastToggleAt = now;
    toggleSheet();
  }

  function toggleSheet() {
    if (open) { closeSheet(); return; }
    open = true;
    sheet.style.display = 'block';
    positionSheet();
  }
  function closeSheet() { open = false; sheet.style.display = 'none'; }

  function positionSheet() {
    if (!orb || !sheet) return;
    var r = orb.getBoundingClientRect();
    var w = sheet.offsetWidth || 172;
    var h = sheet.offsetHeight || 240;
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    var top = r.top - h - 10;
    if (top < 8) top = Math.min(window.innerHeight - h - 8, r.bottom + 10);
    sheet.style.left = left + 'px';
    sheet.style.top = top + 'px';
  }

  function setStatus(t) {
    if (!statusEl) return;
    statusEl.textContent = t || '';
    if (open) positionSheet();
  }

  function bindOrb() {
    var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;

    function down(e) {
      var t = e.touches ? e.touches[0] : e;
      dragging = true; moved = false;
      sx = t.clientX; sy = t.clientY;
    }
    function move(e) {
      if (!dragging) return;
      var t = e.touches ? e.touches[0] : e;
      var dx = t.clientX - sx, dy = t.clientY - sy;
      if (!moved) {
        if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
        moved = true;
        var r = orb.getBoundingClientRect();
        ox = r.left; oy = r.top;
        orb.style.left = ox + 'px'; orb.style.top = oy + 'px';
        orb.style.right = 'auto'; orb.style.bottom = 'auto';
      }
      orb.style.left = Math.max(0, Math.min(window.innerWidth - orb.offsetWidth, ox + dx)) + 'px';
      orb.style.top = Math.max(0, Math.min(window.innerHeight - orb.offsetHeight, oy + dy)) + 'px';
      if (open) positionSheet();
      if (e.cancelable) e.preventDefault();
    }
    function up() {
      if (!dragging) return;
      var wasMoved = moved;
      dragging = false; moved = false;
      if (wasMoved) {
        var r = orb.getBoundingClientRect();
        try { localStorage.setItem(POS_KEY, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) })); } catch (e) {}
        if (open) positionSheet();
      } else {
        safeToggle();
      }
    }

    orb.addEventListener('touchstart', down, { passive: true });
    orb.addEventListener('touchmove', move, { passive: false });
    orb.addEventListener('touchend', up);
    orb.addEventListener('touchcancel', function () { dragging = false; moved = false; });

    orb.addEventListener('pointerup', function (e) {
      if (e.pointerType === 'mouse') return;
      if (moved) return;
      safeToggle();
    });
    orb.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      safeToggle();
    });

    orb.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      down(e);
      function mm(ev) { move(ev); }
      function mu() { up(); document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); }
      document.addEventListener('mousemove', mm);
      document.addEventListener('mouseup', mu);
    });
  }

  function applyPos() {
    try {
      var p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (p && typeof p.left === 'number') {
        orb.style.left = p.left + 'px';
        orb.style.top = p.top + 'px';
        orb.style.right = 'auto';
        orb.style.bottom = 'auto';
      }
    } catch (e) {}
  }

  /* ================= 播放器 ================= */
  function showPlayer() {
    if (playerWrap) { try { playerWrap.remove(); } catch (e) {} }
    playerWrap = document.createElement('div');
    playerWrap.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483500;background:#000;';

    videoEl = document.createElement('video');
    videoEl.controls = true;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    applySize();

    var tools = document.createElement('div');
    tools.id = 'hj-player-tools';
    tools.appendChild(mkFloat('⤢', toggleBig));
    tools.appendChild(mkFloat('✕', function () {
      try { videoEl.pause(); } catch (e) {}
      try { playerWrap.remove(); } catch (e) {}
      playerWrap = null; videoEl = null;
    }));

    playerWrap.appendChild(videoEl);
    playerWrap.appendChild(hotzone('left'));
    playerWrap.appendChild(hotzone('right'));
    playerWrap.appendChild(tools);
    document.body.appendChild(playerWrap);
    return videoEl;
  }

  function mkFloat(text, fn) {
    var b = document.createElement('div');
    b.className = 'hj-fbtn';
    b.textContent = text;
    b.onclick = function (ev) { ev.stopPropagation(); fn(); };
    return b;
  }

  function applySize() {
    if (!videoEl) return;
    if (bigMode) {
      videoEl.style.cssText = 'width:100vw;height:100vh;max-height:100vh;display:block;background:#000;object-fit:contain;';
    } else {
      videoEl.style.cssText = 'width:100%;max-height:64vh;display:block;background:#000;';
    }
  }

  function toggleBig() {
    bigMode = !bigMode;
    applySize();
    if (bigMode) {
      if (videoEl && videoEl.requestFullscreen) { try { videoEl.requestFullscreen(); } catch (e) {} }
    } else {
      if (document.fullscreenElement && document.exitFullscreen) { try { document.exitFullscreen(); } catch (e) {} }
    }
  }

  function onClickBig() {
    if (!videoEl) { setStatus('先点「播放」再放大'); return; }
    toggleBig();
  }

  function onClickCredential() {
    var cur = getResourceId();
    var v = prompt(
      '购买凭证（已购帖子 id）\n\n' +
      '找一个你花 1 金币买过的帖子，\n' +
      '把它的 id 填这里。\n\n' +
      '帖子 id 在哪看：\n' +
      '打开帖子详情页，地址栏 ?pid= 后面那串数字就是。\n\n' +
      '当前：' + cur,
      cur
    );
    if (v === null) return;
    v = String(v).trim();
    if (!/^\d+$/.test(v)) { setStatus('id 必须是纯数字'); return; }
    setResourceId(v);
    setStatus('凭证已更新为 ' + v);
  }

  function hotzone(side) {
    var z = document.createElement('div');
    z.style.cssText = 'position:absolute;top:0;bottom:0;width:28%;' + (side === 'left' ? 'left:0;' : 'right:0;') + 'z-index:4;';
    var timer = null, active = false;
    var tip = document.createElement('div');
    tip.style.cssText = 'position:absolute;top:12px;left:50%;transform:translateX(-50%);background:rgba(14,19,38,.75);color:#dfe5ff;padding:4px 10px;border-radius:6px;font-size:12px;display:none;white-space:nowrap;';
    z.appendChild(tip);

    function start() {
      if (!videoEl) return;
      active = true;
      timer = setTimeout(function () {
        if (!active || !videoEl) return;
        videoEl.playbackRate = 2;
        tip.style.display = 'block';
        tip.textContent = '2×';
      }, 380);
    }
    function end() {
      active = false;
      if (timer) { clearTimeout(timer); timer = null; }
      if (videoEl && videoEl.playbackRate !== 1) videoEl.playbackRate = 1;
      tip.style.display = 'none';
    }
    z.addEventListener('touchstart', start, { passive: true });
    z.addEventListener('touchend', end);
    z.addEventListener('touchcancel', end);
    z.addEventListener('mousedown', start);
    z.addEventListener('mouseup', end);
    z.addEventListener('mouseleave', end);
    return z;
  }

  /* ================= 取地址 ================= */
  function resolveMediaUrl() {
    var tid = getTopicId();
    if (tid) {
      return api('/topic/' + tid).then(function (topic) {
        var vids = ((topic && topic.attachments) || []).filter(function (a) { return a && a.category === 'video'; });
        if (!vids.length) throw new Error('本贴无视频附件');
        return api('/attachment', 'POST', {
          id: vids[0].id, resource_id: Number(getResourceId()), resource_type: 'topic', line: ''
        }).then(function (res) {
          if (!res || !res.remoteUrl) {
            throw new Error(
              '凭证无效（当前账号未购买 ' + getResourceId() + '）\n\n' +
              '解决办法：\n' +
              '1. 每天签到领 20 金币\n' +
              '2. 花 1 金币买任意一个帖子\n' +
              '3. 点「⚙ 凭证」填入那个帖子的 id\n' +
              '4. 打开帖子详情页，地址栏 ?pid= 后面那串数字就是 id'
            );
          }
          return res.remoteUrl;
        });
      });
    }

    var vid = getVideoId();
    if (vid) {
      return api('/video/' + vid).then(function (v) {
        var att = v && v.attachment;
        if (!att || !att.remoteUrl) throw new Error('该短视频无播放地址');
        return toCdn(att.remoteUrl);
      });
    }

    if (lastM3u8) return Promise.resolve(lastM3u8);

    return Promise.reject(new Error('当前页不是帖子也不是短视频'));
  }

  function buildStreamUrl(pl) {
    var keyBlobUrl = pl.key ? URL.createObjectURL(new Blob([pl.key], { type: 'application/octet-stream' })) : null;
    var out = pl.text.split('\n').map(function (line) {
      var t = line.trim();
      if (!t) return '';
      if (t.charAt(0) === '#') {
        if (keyBlobUrl && t.indexOf('URI="') >= 0) return t.replace(/URI="[^"]+"/, 'URI="' + keyBlobUrl + '"');
        return t;
      }
      if (/^https?:/i.test(t)) return t;
      return pl.baseDir + t;
    }).join('\n');
    return URL.createObjectURL(new Blob([out], { type: 'application/vnd.apple.mpegurl' }));
  }

  /* ================= 播放 ================= */
  var busy = false;
  var busyTimer = null;

  function setBusy(v) {
    busy = v;
    if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
    if (v) {
      busyTimer = setTimeout(function () {
        setBusy(false);
        busyTimer = null;
        setStatus('超时 45 秒，已重置，可重试');
      }, 45000);
    }
  }

  function startPlayback(pl) {
    var streamUrl = buildStreamUrl(pl);
    loadHls().then(function (Hls) {
      var v = showPlayer();
      if (Hls && Hls.isSupported()) {
        var Cached = makeCachedLoader(Hls);
        var h = new Hls({
          maxBufferLength: 120,
          maxMaxBufferLength: 600,
          maxBufferSize: 180 * 1000 * 1000,
          fragLoadingMaxRetry: 20,
          fragLoadingRetryDelay: 400,
          manifestLoadingMaxRetry: 8,
          levelLoadingMaxRetry: 8,
          abrEwmaDefaultEstimate: 160000,
          enableWorker: false,
          backBufferLength: 30,
          startLevel: -1,
          fLoader: Cached
        });
        h.loadSource(streamUrl);
        h.attachMedia(v);
        h.on(Hls.Events.MANIFEST_PARSED, function () {
          setStatus('播放中 · 缓存 ' + segCache.size + ' 段');
        });
        h.on(Hls.Events.ERROR, function (_e, d) {
          if (!d || !d.fatal) return;
          setStatus('播放错误 [' + d.details + ']');
        });
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = streamUrl;
        setStatus('系统 HLS 播放');
      } else {
        setStatus('设备不支持 HLS');
      }
    }).catch(function (e) { setStatus('hls.js 失败: ' + e.message); });
  }

  function onClickPlay() {
    if (busy) { setStatus('任务进行中…'); return; }
    setBusy(true);
    setStatus('解析…');
    stopPrefetch();
    segCache.clear();
    bigMode = false;

    resolveMediaUrl()
      .then(function (url) { return fetchPlaylist(url); })
      .then(function (pl) {
        var isLong = pl.dur > LONG_MIN;

        if (isLong) {
          var leadSec = Math.max(30, pl.dur / LEAD_FACTOR);
          var need = Math.min(pl.segs.length, Math.ceil(pl.segs.length * (leadSec / pl.dur)));
          setStatus('长视频 ' + (pl.dur / 60).toFixed(1) + ' 分钟\n预缓存 ' + Math.round(leadSec) + ' 秒\n可切页浏览，好了自动播');

          return preloadRange(pl, 0, need, function (done, total, kbps, kb) {
            if (done % 5 !== 0 && done !== total) return;
            var eta = kbps > 0 ? ((total - done) * 175 / kbps).toFixed(0) : '?';
            setStatus('后台缓存 ' + (done / total * 100).toFixed(0) + '%\n' + done + '/' + total +
                      '\n' + (kb / 1024).toFixed(1) + ' MB · ' + kbps.toFixed(0) + ' KB/s\n剩余 ' + eta + ' 秒');
          }).then(function () {
            setStatus('缓存完成，自动播放');
            startPlayback(pl);
            startPrefetch(pl.segs, need);
            setBusy(false);
          });
        }

        var needShort = Math.min(SHORT_PRELOAD_SEGS, Math.max(10, Math.ceil(pl.segs.length * 0.4)));
        setStatus('短视频，缓冲中…');
        startPrefetch(pl.segs, 0);
        var ticks = 0;
        var wait = setInterval(function () {
          ticks++;
          if (segCache.size >= needShort || ticks > 40) {
            clearInterval(wait);
            setStatus('开播（缓存 ' + segCache.size + ' 段）');
            startPlayback(pl);
            setBusy(false);
          } else {
            setStatus('缓冲 ' + segCache.size + '/' + needShort + ' 段…');
          }
        }, 250);
      })
      .catch(function (e) {
        setStatus('出错: ' + e.message);
        setBusy(false);
      });
  }

  /* ================= 下载 ================= */
  function onClickDownload() {
    if (dlAc) {
      try { dlAc.abort(); } catch (e) {}
      dlAc = null;
      setStatus('已取消');
      return;
    }
    setStatus('解析…');
    stopPrefetch();

    resolveMediaUrl()
      .then(function (url) { return fetchPlaylist(url); })
      .then(function (pl) {
        var guessKB = pl.segs.length * 175;
        setStatus('下载 ' + pl.segs.length + ' 段');
        return downloadAll(pl, function (done, total, kbps, kb) {
          if (done % 10 !== 0 && done !== total) return;
          var eta = kbps > 0 ? Math.max(0, (guessKB - kb) / kbps).toFixed(0) : '?';
          setStatus('下载 ' + (done / total * 100).toFixed(0) + '%\n' +
                    (kb / 1024).toFixed(1) + ' MB · ' + kbps.toFixed(0) + ' KB/s\n剩余 ' + eta + ' 秒\n（再点取消）');
        }).then(function (blob) {
          dlAc = null;
          var sizeMB = (blob.size / 1024 / 1024).toFixed(1);
          setStatus('完成 ' + sizeMB + ' MB，保存中…');
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'hj_' + (getTopicId() || getVideoId() || Date.now()) + '.ts';
          document.body.appendChild(a);
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 120000);
        });
      })
      .catch(function (e) {
        dlAc = null;
        if (e.message !== '已取消') setStatus('下载失败: ' + e.message);
      });
  }

  /* ================= 激活验证 ================= */
  var AUTH_KEY = 'hj_unlock_auth_v1';
  var PASS_HASHES = [
    'c36d3d48ab4a6b0a4837e39d681d9c28e8a5a1951d211dc022ce049de5a5080f',
    '1fb247029725ace4007756942d2913e9236819d76dc9dac425fd0a2424e94788',
    '14e1b31813711157286949812754af572de64d6bd28c88f050c46f49dbf06142',
    '34f0db73f63af3d4450ff72803af1ca56cb4a985070048e5e33063a749010809',
    '851af240be975ee6aae57007fe0891f39c46eed00de3fa62062fe5194cd61feb',
    'fc041ef9c1ad7d73850ed867a7b06fd7cc6652862b22ba3690ef482cdea2e419',
    '7d5b3832bee2da0c405ac335dd892aedafbadd1755ba100d84157aa804904570'
  ];

  function sha256hex(s) {
    if (!window.crypto || !crypto.subtle || !crypto.subtle.digest) {
      return Promise.resolve('raw:' + s);
    }
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then(function (b) {
      var a = new Uint8Array(b), out = '';
      for (var i = 0; i < a.length; i++) out += ('0' + a[i].toString(16)).slice(-2);
      return out;
    });
  }

  // 改这个数字会让所有已激活设备全部失效（下次打开需重新输入）
  var AUTH_VERSION = 1;

  function readAuth() {
    try {
      var raw = localStorage.getItem(AUTH_KEY);
      if (!raw) return null;
      if (raw.charAt(0) === '{') {
        var o = JSON.parse(raw);
        if (o && o.v === AUTH_VERSION && typeof o.h === 'string') return o.h;
        return null;
      }
      // 旧格式（纯哈希、无版本号）视为失效
      return null;
    } catch (e) { return null; }
  }

  function writeAuth(h) {
    try { localStorage.setItem(AUTH_KEY, JSON.stringify({ v: AUTH_VERSION, h: h })); } catch (e) {}
  }

  function checkAuth() {
    var saved = readAuth();
    if (saved && PASS_HASHES.indexOf(saved) >= 0) return Promise.resolve(true);

    var input = prompt('海角解锁器 · 首次使用\n\n请输入激活码：');
    if (input === null || input === '') return Promise.resolve(false);

    return sha256hex(String(input).trim()).then(function (h) {
      if (PASS_HASHES.indexOf(h) >= 0) {
        writeAuth(h);
        return true;
      }
      alert('激活码无效');
      return false;
    });
  }

  /* ================= 站点识别 ================= */
  function looksHaijiao() {
    var score = 0;
    try {
      var h = (location.hostname || '').toLowerCase();
      if (/haijiao/.test(h)) score += 3;
      if (/^hj\d+\./.test(h)) score += 3;
      // 随机 hex 域名（如 fc3e3b16424ccc.top）——海角镜像站规律
      if (/^[0-9a-f]{8,}\.(top|xyz|cc|vip|club|site|online|io|me|tv)$/i.test(h)) score += 3;
      // 任意短域名 + 海角外壳也能过

      var t = document.title || '';
      if (t.indexOf('海角') >= 0) score += 2;

      var kw = document.querySelector('meta[name="keywords"]');
      if (kw && (kw.getAttribute('content') || '').indexOf('海角') >= 0) score += 2;

      if (document.getElementById('fixed_bg')) score += 1;

      // 海角 SPA 外壳：/js/app.<hash>.js
      var ss = document.querySelectorAll('script[src]');
      for (var i = 0; i < ss.length; i++) {
        if (/\/js\/app\.[0-9a-f]{6,12}\.js/i.test(ss[i].src)) { score += 2; break; }
      }

      // 已经是帖子/视频页（有 pid 参数）
      if (/[?&]pid=\d+/.test(location.search)) score += 2;
    } catch (e) {}
    return score >= 2;
  }

  /* ================= 启动 ================= */
  var started = false;
  var tries = 0;

  function boot() {
    if (started) return;
    tries++;

    if (!document.body) {
      if (tries < 40) return setTimeout(boot, 300);
      return;
    }
    if (!looksHaijiao()) {
      // DOM 可能还没解析完，再等几轮
      if (tries < 12) return setTimeout(boot, 800);
      return;
    }

    started = true;
    checkAuth().then(function (ok) {
      if (ok) buildUI();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
