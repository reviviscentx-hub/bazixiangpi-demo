// 离线/镜像核心：拦截外域请求、API 转发本地、禁用 RSC 客户端导航（强制整页跳转）
// 静态版（GH Pages）：window.__SS_DEMO 存在时，/tw/ API 全部用预置数据应答（无后端）
(function () {
  var API_ORIGIN = 'https://j87uy6dryj.execute-api.ap-northeast-2.amazonaws.com';
  var LOCAL = '';
  var DEMO = window.__SS_DEMO || null;
  // 子路径部署（GH Pages 项目页）时由 demo-data.js 提供前缀，如 '/bazixiangpi-demo'
  var BASE = window.__SS_BASE || '';

  function demoSlug() {
    var m = location.pathname.match(/^\/([a-z]+)\//);
    var s = (m && DEMO.slug[m[1]]) ? m[1] : 'hwajeong';
    return s;
  }
  function demoUser() {
    var n = '';
    try { n = sessionStorage.getItem('ss_demo_name') || ''; } catch (e) {}
    return n || DEMO.demoName;
  }
  function demoJson(obj) {
    // 把预置数据里的示例名（含 AI plan 内嵌的旧订单名）替换为用户在表单里输入的名字
    try {
      var names = [DEMO.demoName];
      var d = DEMO.slug[demoSlug()];
      if (d) { if (d.plan && d.plan.name) names.push(d.plan.name); if (d.teaser && d.teaser.name) names.push(d.teaser.name); }
      var u = demoUser();
      var s = JSON.stringify(obj);
      names.forEach(function (n) { if (n && n !== u) s = s.split(n).join(u); });
      return JSON.parse(s);
    } catch (e) { return obj; }
  }
  // 原站 teaser 页直接读 sessionStorage/localStorage 缓存渲染（key 因产品而异，已从 chunk 解混淆）：
  //   hwajeong: tw_hwajeong_teaser_data / tw_hwajeong_teaser_id / tw_hwajeong_preview_saju
  //   foxdoryeong: fox_teaser_data / fox_teaser_id / fox_preview_saju
  //   sinseon: sinseon_teaser_data / sinseon_teaser_id / sinseon_teaser_sid / sinseon_teaser_at
  function saveDemoStorage(slug, d) {
    var tid = 'DEMO-' + slug.toUpperCase();
    var teaser = demoJson(d.teaser);
    var saju = demoJson(d.sajuData);
    var set = function (k, v, session) { try { (session ? sessionStorage : localStorage).setItem(k, v); } catch (e) {} };
    try {
      set(slug === 'hwajeong' ? 'tw_hwajeong_teaser_data' : slug === 'foxdoryeong' ? 'fox_teaser_data' : 'sinseon_teaser_data', JSON.stringify(teaser), true);
      set(slug === 'hwajeong' ? 'tw_hwajeong_teaser_data' : slug === 'foxdoryeong' ? 'fox_teaser_data' : 'sinseon_teaser_data', JSON.stringify(teaser), false);
      set(slug === 'hwajeong' ? 'tw_hwajeong_teaser_id' : slug === 'foxdoryeong' ? 'fox_teaser_id' : 'sinseon_teaser_id', tid, false);
      set('sinseon_teaser_sid', tid, true);
      set('sinseon_teaser_at', String(Date.now()), false);
      set(slug === 'hwajeong' ? 'tw_hwajeong_preview_saju' : slug === 'foxdoryeong' ? 'fox_preview_saju' : 'sinseon_base', JSON.stringify(saju), true);
      set(slug === 'hwajeong' ? 'tw_hwajeong_preview_saju' : slug === 'foxdoryeong' ? 'fox_preview_saju' : 'sinseon_base', JSON.stringify(saju), false);
    } catch (e) {}
  }

  function demoResponse(p, body) {
    var slug = demoSlug();
    var d = DEMO.slug[slug] || DEMO.slug['hwajeong'];
    var data = null;
    if (/\/tw\/order\/preview$/.test(p)) {
      // 记录用户输入的名字（preview body 里 name 字段）
      try {
        var b = JSON.parse(body || '{}');
        if (b && b.name) sessionStorage.setItem('ss_demo_name', b.name);
      } catch (e) {}
      data = { sajuData: demoJson(d.sajuData) };
      saveDemoStorage(slug, d);
    } else if (/\/tw\/order\/teaser$/.test(p)) {
      var tid = 'DEMO-' + slug.toUpperCase();
      data = { ok: true, teaserId: tid, teaser: demoJson(d.teaser) };
      try { sessionStorage.setItem('_ssOrderId', tid); } catch (e) {}
      saveDemoStorage(slug, d);
    } else if (/\/tw\/order\/pay$/.test(p)) {
      data = { ok: true };
    } else if (/\/tw\/order\/book$/.test(p)) {
      data = { ok: true, status: 'done', plan: demoJson(d.plan), orderId: 'DEMO-' + slug.toUpperCase() };
    } else if (/\/tw\/order$/.test(p)) {
      // teaser/loading 页轮询订单状态
      data = { orderId: 'DEMO-' + slug.toUpperCase(), status: 'done', teaser: demoJson(d.teaser) };
    } else if (/\/tw\/order\/upload$/.test(p)) {
      data = { uploadUrl: '#' };
    } else if (/\/tw\/order$/.test(p) || /\/user_count/.test(p)) {
      data = { count: 18743 + (new Date().getHours() * 7) };
    }
    if (data === null) return null;
    return Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
  }

  // 1) fetch 劫持：execute-api → 本地 /api 等价路径；RSC/.txt → 失败（触发整页导航）
  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var u = typeof input === 'string' ? input : (input && input.url) || '';
      if (u.indexOf(API_ORIGIN) === 0) {
        var p = u.slice(API_ORIGIN.length) || '/';
        if (DEMO) {
          var dr = demoResponse(p.split('?')[0], init && typeof init.body === 'string' ? init.body : '');
          if (dr) return dr;
        }
        var pr = _fetch.call(window, LOCAL + p, init);
        if (/\/tw\/order\/teaser/.test(p)) {
          pr.then(function (r) {
            r.clone().json().then(function (j) {
              if (j && j.teaserId) { try { sessionStorage.setItem('_ssOrderId', j.teaserId); } catch (e) {} }
            }).catch(function () {});
          }).catch(function () {});
        }
        return pr;
      }
      if (DEMO && (u.indexOf((BASE || '') + '/tw/') === 0 || u.indexOf('/tw/') === 0 || (u.indexOf(location.origin) === 0 && /\/tw\//.test(u)))) {
        var dpath = u.split('?')[0].replace(location.origin, '');
        if (BASE && dpath.indexOf(BASE) === 0) dpath = dpath.slice(BASE.length);
        var dp = demoResponse(dpath, init && typeof init.body === 'string' ? init.body : '');
        if (dp) return dp;
      }
      if (/_rsc=|__next\.[\w.]+\.txt/.test(u)) {
        return Promise.reject(new Error('rsc-disabled'));
      }
      if (/^https?:\/\/(?!localhost|127\.0\.0\.1)/.test(u) && u.indexOf(location.origin) !== 0) {
        return Promise.reject(new Error('external-blocked'));
      }
    } catch (e) {}
    return _fetch.apply(window, arguments);
  };

  // 2) XHR 劫持（Next 老式调用）
  var XO = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    try {
      if (typeof u === 'string' && u.indexOf(API_ORIGIN) === 0) arguments[1] = LOCAL + u.slice(API_ORIGIN.length);
      else if (typeof u === 'string' && /_rsc=|__next\.[\w.]+\.txt/.test(u)) { this.__blocked = true; }
    } catch (e) {}
    return XO.apply(this, arguments);
  };
  var XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (b) {
    if (this.__blocked) { try { this.abort(); } catch (e) {} return; }
    return XS.apply(this, arguments);
  };

  // 3) 拦截外域导航与 form 提交目标
  var _open = window.open;
  window.open = function (u) {
    if (typeof u === 'string' && /^https?:\/\//.test(u) && u.indexOf(location.origin) !== 0) return null;
    return _open.apply(window, arguments);
  };

  // 4) 强制整页导航（绕开 Next App Router 客户端路由）
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#' || /^(javascript|mailto|tel):/.test(href)) return;
    if (a.target === '_blank') return;
    if (/^https?:\/\//.test(href) && href.indexOf(location.origin) !== 0) { e.preventDefault(); return; }
    e.preventDefault();
    e.stopPropagation();
    var abs = new URL(href, location.href);
    var pn = abs.pathname;
    // 子路径部署：站内绝对路径拼 BASE 前缀（BASE 不含尾斜杠）
    if (BASE && pn.indexOf(BASE + '/') !== 0) pn = BASE + pn;
    location.href = pn + abs.search;
  }, true);

  // 4b) teaser 页的付费 CTA：原站走 Stripe（无法镜像），拦截后跳自研支付确认页
  if (/\/teaser\/?$/.test(location.pathname)) {
    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('button,[role="button"]') : null;
      if (!b) return;
      var t = (b.innerText || b.textContent || '').trim();
      if (!/命書|解鎖|看完整|查看完整|繼續看/.test(t)) return;
      e.preventDefault();
      e.stopPropagation();
      var oid = '';
      try { oid = sessionStorage.getItem('_ssOrderId') || ''; } catch (e2) {}
      var slug = (location.pathname.replace(BASE, '').match(/^\/([a-z]+)\//) || ['', 'hwajeong'])[1];
      location.href = BASE + '/pay/?o=' + encodeURIComponent(oid) + '&p=' + encodeURIComponent(slug);
    }, true);
  }

  // 5) 屏蔽 GA/GTM 全局调用（避免脚本剥离后报错）
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () {};
  window.fbq = window.fbq || function () {};

  // 6) 品牌脱敏兜底：React 水合后会把服务端替换掉的文案冲回原文，这里持续纠正文本节点
  var BRAND_MAP = [
    [/道士\s*DAOSHI/g, '順順 命理館'],
    [/道士/g, '順順'],
    [/DAOSHI/g, 'SHUNSHUN'],
    [/GKUER[,\s]*LLC/gi, '順順科技'],
    [/花情/g, '暖陽'],
    [/狐仙公子/g, '墨狐'],
    [/掌仙/g, '觀手'],
  ];
  function brandFix(node) {
    if (!node || node.nodeType !== 3) return;
    var t = node.nodeValue;
    if (!t || t.length < 2) return;
    var nt = t;
    for (var i = 0; i < BRAND_MAP.length; i++) nt = nt.replace(BRAND_MAP[i][0], BRAND_MAP[i][1]);
    if (nt !== t) node.nodeValue = nt;
  }
  function brandScan(root) {
    if (!root) return;
    if (root.nodeType === 3) { brandFix(root); return; }
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = w.nextNode())) brandFix(n);
    // 属性里的品牌名（alt/title/aria-label）
    if (root.querySelectorAll) {
      Array.prototype.forEach.call(root.querySelectorAll('[alt],[title],[aria-label],[placeholder]'), function (el) {
        ['alt', 'title', 'aria-label', 'placeholder'].forEach(function (a) {
          var v = el.getAttribute(a);
          if (!v) return;
          var nv = v;
          for (var i = 0; i < BRAND_MAP.length; i++) nv = nv.replace(BRAND_MAP[i][0], BRAND_MAP[i][1]);
          if (nv !== v) el.setAttribute(a, nv);
        });
      });
    }
  }
  function startBrandFix() {
    // 必须等 React 水合完成后再改 DOM，否则触发 hydration mismatch（#418）导致表单事件全部失效。
    // 用定时扫描兜底 React 后续重渲染（不用 MutationObserver：全树遍历会卡主线程）。
    // demo 模式（无后端延迟）React 渲染更早，加密扫描频次。
    var times = DEMO ? [150, 400, 800, 1500, 2500, 4000, 6000, 9000] : [200, 1000, 2500, 4500, 7000];
    times.forEach(function (ms) {
      setTimeout(function () { try { brandScan(document.body); } catch (e) {} }, ms);
    });
  }
  if (document.readyState === 'complete') startBrandFix();
  else window.addEventListener('load', startBrandFix);

  // 7) 记录页面标识 + demo 模式预置三产品 teaser 缓存（teaser 页直接读缓存渲染，任何入口可达）
  window.__MIRROR = { page: window.__PAGE || location.pathname, offline: true };
  if (DEMO) {
    try { ['hwajeong', 'foxdoryeong', 'sinseon'].forEach(function (s) { saveDemoStorage(s, DEMO.slug[s]); }); } catch (e) {}
  }
})();
