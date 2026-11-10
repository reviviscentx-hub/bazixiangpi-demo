// QuestionSdk host 端模拟：响应模块的全部 bridge 请求
// 协议逆向自真实 host（见 snap/sdk-host-responses.log 与 sdk-host-requests.log）
(function () {
  const frame = document.getElementById('mod');
  let caseId = 339300 + Math.floor(Math.random() * 900);
  let price = {
    currency: 'CNY',
    amounts: { final_plan: 98, final_plan_bundle: 60 },
    display: { final_plan: '¥98', final_plan_bundle: '¥60' },
  };
  let session = null; // { answers, preview, plan }

  // ── 續卷 SKU 與定價（照抄 TIGHT：主產品引流、專論加購、套餐貼主產品價）──
  const CATALOG = {
    money: { sku: 'money', tag: '賺錢路線', title: '財通寶鑑 · 財運專論', orig: 79, price: 39,
      bullets: ['你這一生能端多大的碗', '錢從哪三條路來', '你在漏哪三個洞'], bias: 'old' },
    love: { sku: 'love', tag: '真緣畫像', title: '姻緣全解 · 感情專論', orig: 79, price: 39,
      bullets: ['真緣長什麼樣、在哪遇到', '未來五年哪一年動', '你總栽在同一種人手裡'], bias: 'young' },
  };
  const PACK_TEXT = '兩卷同解 <b>¥108</b>（單買 ¥137，省 ¥29）｜ 三卷全解 <b>¥148</b>（省 ¥108）· 命書讀者專享價，7 天內有效';

  const LS = {
    get(k, dv) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : dv; } catch (e) { return dv; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  let orders = LS.get('ink_orders', []);      // [{ts, sku, amount, kind}]
  let coupons = LS.get('ink_coupons', []);    // [{id, amount, expire, used}]
  let reviewed = LS.get('ink_reviewed', false);

  function trackEvent(event, props) {
    try {
      if (!window.__STATIC_MODE) {
        fetch('api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, props: props || {}, ts: Date.now() }) }).catch(() => {});
      }
    } catch (e) {}
  }
  function recordOrder(sku, amount, kind) {
    orders.push({ ts: Date.now(), sku: sku, amount: amount, kind: kind });
    LS.set('ink_orders', orders);
    trackEvent('order', { sku: sku, amount: amount, kind: kind });
  }
  function ageFrom(birthDate) {
    if (!birthDate) return 30;
    const y = parseInt(String(birthDate).slice(0, 4), 10);
    if (!y) return 30;
    return new Date().getFullYear() - y;
  }
  function atLeastOneMain() { return orders.some(o => o.sku === 'main'); }
  function activeCoupon() {
    const now = Date.now();
    return coupons.filter(c => !c.used && c.expire > now).sort((a, b) => b.amount - a.amount)[0] || null;
  }


  const HANDSHAKE = 'hs-' + Math.random().toString(16).slice(2, 18);

  function replyToModule(msg) {
    try { frame.contentWindow.postMessage(msg, '*'); } catch (e) { console.warn('post to module failed', e); }
  }

  // AI 命书：把个性化文本字段 merge 进 session.plan（chart/templates 保留模板层，供图表渲染）
  // 双后端：静态版走 Cloudflare Worker 代理（window.__AI_PROXY）；实时版走 /api/ai-plan?hash=
  function fetchStaticAi() {
    if (!window.__AI_PROXY || !session || !session.baziData) return null;
    return fetch(window.__AI_PROXY.replace(/\/$/, '') + '/api/ai-plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: session.baziData }),
    }).then(r => r.json()).then(j => {
      if (j && j.ok && j.plan) {
        session.plan = Object.assign({}, session.plan, j.plan);
        session.aiApplied = true;
        console.log('[ai] personalized plan applied (worker)');
        refreshPaidIfOpen();
      }
    }).catch(() => { /* Worker 未部署/超时：静默保留模板版 */ });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function refreshPaidIfOpen() {
    try {
      var f = document.querySelector('iframe#mod') || document.querySelector('iframe');
      var w = f && f.contentWindow;
      if (!w || typeof w.__inkPushPlan !== 'function' || !session || !session.plan) return;
      w.__inkPushPlan(session.plan); // 已打开则立即替换，未打开则暂存
    } catch (e) {}
  }

  // unlock 后若 AI 尚未就绪：后台继续轮询，就绪后无缝替换（覆盖 Worker 长耗时场景）
  function scheduleAiRefresh(tries) {
    if (!session || session.aiApplied || tries <= 0) return;
    setTimeout(async () => {
      await applyAiPlan(6000);
      if (session && session.aiApplied) { refreshPaidIfOpen(); return; }
      scheduleAiRefresh(tries - 1);
    }, 4000);
  }
  async function applyAiPlan(timeoutMs) {
    if (!session || session.aiApplied) return;
    // 静态版：等待 submit 时发起的 Worker 请求（最多 timeoutMs，0=不等）
    if (window.__STATIC_MODE) {
      if (!session.aiPromise) session.aiPromise = fetchStaticAi();
      if (!session.aiPromise) return;
      await Promise.race([session.aiPromise, sleep(timeoutMs > 0 ? timeoutMs : 1)]);
      return;
    }
    // 实时版：按 hash 查服务端缓存（AI 后台生成）
    if (!session.aiHash) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs > 0 ? timeoutMs : 1500);
    try {
      const r = await fetch('api/ai-plan?hash=' + session.aiHash, { signal: ctrl.signal });
      const j = await r.json();
      if (!j || !j.ok || !j.plan) return; // 尚未生成 → 保留模板版，unlock/getResult 再试
      session.plan = Object.assign({}, session.plan, j.plan);
      session.aiApplied = true;
      console.log('[ai] personalized plan applied');
      refreshPaidIfOpen(); // 已进命书页则无缝替换为 AI 深度版
    } catch (e) { /* 超时：静默保留模板版 */ }
    finally { clearTimeout(timer); }
  }

  window.addEventListener('message', async (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;

    // 1) 握手：module 发 sdk.ready{handshakeId} → host 主动回 host.context（模块校验 handshakeId）
    if (d.type === 'sdk.ready') {
      replyToModule({
        type: 'host.context', handshakeId: d.handshakeId || HANDSHAKE,
        bridgeNonce: 'bn-' + Math.random().toString(16).slice(2, 18),
        protocolVersion: '1',
        context: {
          caseId, moduleRunId: caseId, locale: 'zh-CN', slug: 'mzmudang-fate',
          artifactVersion: '1.0.0', answerContractVersion: '1',
          price, nameHant: false,
          birthDst: { timezone: 'Asia/Shanghai', ranges: [] },
        },
      });
      return;
    }
    // 2) 业务请求：{requestId, type, payload, bridgeNonce}
    if (!d.requestId || !d.type) return;
    const { requestId, type, payload } = d;

    const respond = (data) => replyToModule({ type: 'ack', bridgeNonce: d.bridgeNonce, requestId, ackType: type, data });

    try {
      switch (type) {
        case 'getPricing': respond(null); break; // 无折抵 → null（模块注释：没有折抵时 host 回 null）
        case 'resize': respond({}); break;
        case 'track': trackEvent(d.payload && d.payload.event, d.payload && d.payload.props); respond({}); break;
        case 'getUpsell': {
          const age = session && session.answers ? ageFrom(session.answers.birthDate) : 30;
          const cards = Object.values(CATALOG).map(c => Object.assign({}, c));
          // 年齡分層推薦（TIGHT 实测策略：<29 推感情、≥30 推财运）
          cards.sort((a, b) => (a.bias === 'young' ? (age < 29 ? -1 : 1) : (age < 29 ? 1 : -1)));
          respond({
            cards: cards,
            owned: orders.map(o => o.sku),
            coupon: activeCoupon(),
            reviewed: reviewed,
            packText: PACK_TEXT,
          });
          break;
        }
        case 'purchase': {
          const sku = payload && payload.sku;
          const cat = CATALOG[sku];
          if (!cat) throw { code: 400, message: 'unknown sku' };
          let amount = cat.price;
          let used = null;
          if (payload.useCoupon) {
            const c = activeCoupon();
            if (c) { amount = Math.max(1, amount - c.amount); c.used = true; LS.set('ink_coupons', coupons); used = c; }
          }
          recordOrder(sku, amount, atLeastOneMain() ? 'repeat' : 'first');
          respond({ completed: true, orderId: 'upsell-' + Date.now(), sku: sku, amount: amount, couponUsed: !!used });
          break;
        }
        case 'getSpecialty': {
          const sku = payload && payload.sku;
          if (window.__STATIC_MODE && window.__AI_PROXY) {
            try {
              const r2 = await fetch(window.__AI_PROXY.replace(/\/$/, '') + '/api/specialty', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku: sku, data: session && session.baziData || null }) });
              const j2 = await r2.json();
              respond(j2 && j2.ok ? { plan: j2.plan, cached: !!j2.cached } : { plan: null, error: (j2 && j2.error) || 'gen failed' });
            } catch (e2) { respond({ plan: null, error: e2.message }); }
            break;
          }
          try {
            const r = await fetch('api/specialty', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku: sku, data: session && session.baziData || null, answers: session && session.answers || null }) });
            const j = await r.json();
            respond(j && j.ok ? { plan: j.plan, cached: !!j.cached } : { plan: null, error: (j && j.error) || 'gen failed' });
          } catch (e) { respond({ plan: null, error: e.message }); }
          break;
        }
        case 'submitReview': {
          reviewed = true; LS.set('ink_reviewed', true);
          const already = coupons.filter(c => c.amount === 10 && c.expire > Date.now() && !c.used).length;
          let c = coupons.filter(x => !x.used && x.expire > Date.now() && x.amount === 10)[0];
          if (!c) {
            c = { id: 'cp-' + Date.now(), amount: 10, expire: Date.now() + 7 * 864e5, used: false };
            coupons.push(c); LS.set('ink_coupons', coupons);
          }
          respond({ coupon: c, issued: !already });
          break;
        }
        case 'submitAnswers': {
          // 双模式：静态版（__STATIC_MODE + inline）→ 浏览器本地排盘；否则走服务端 API（实时版，含 AI 命书）
          let j;
          if (window.__STATIC_MODE && window.__baziLocal) {
            try { const d = window.__baziLocal.computeBazi(payload.answers); j = { ok: true, preview: window.__baziLocal.buildPreview(d), plan: window.__baziLocal.buildFinalPlan(d) }, window.__lastBaziData = d; }
            catch (e) { j = { ok: false, error: e.message }; }
          } else {
            const r = await fetch('api/bazi', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload.answers) });
            j = await r.json();
          }
          if (!j.ok) throw { code: 500, message: j.error || 'compute failed' };
          session = { answers: payload.answers, preview: j.preview, plan: j.plan, aiHash: j.aiHash || '', aiApplied: false };
          if (window.__STATIC_MODE) {
            // 静态版：立即发出 Worker 请求（后台进行，不阻塞免费页），unlock 时等待结果
            session.baziData = window.__lastBaziData || null;
            session.aiPromise = fetchStaticAi();
          } else {
            // 实时版：AI 已就绪（缓存命中）则立即采用
            applyAiPlan(0);
          }
          respond({
            submit: { caseId, moduleRunId: caseId, slug: 'mzmudang-fate', answersHash: payload.answersHash || '', status: 'summary_ready', replay: false },
            preview: session.preview,
          });
          break;
        }
        case 'unlock':
          // 解锁瞬间再给 AI 4 秒机会（用户读免费页的时间通常已足够生成）
          await applyAiPlan(8000);
          // 模块契约：unlock 可直接回 finalPlan（省一次 getResult）；无则模块再发 getResult
          if (!orders.some(o => o.sku === 'main')) recordOrder('main', price.amounts.final_plan, 'first');
          respond(Object.assign({ completed: true, orderId: 'demo-' + caseId }, session && session.plan ? { finalPlan: session.plan } : {}));
          scheduleAiRefresh(15); // AI 未就绪则后台轮询，就绪后无缝替换为深度版
          break;
        case 'checkEntitlement': respond({ unlocked: true, product: 'final_plan' }); break;
        case 'getResult':
          await applyAiPlan(3000);
          // 模块契约：res.finalPlan 才会进 renderPaid（裸 plan 会被当空渲染）
          respond(session && session.plan ? Object.assign({}, session.plan, { finalPlan: session.plan }) : { finalPlan: null });
          break;
        case 'getReviews': respond({ reviews: [], total: 0 }); break;
        case 'getNearTiming': respond({ timing: null }); break;
        case 'getCompat': respond({ compat: null }); break;
        case 'getCompatResult': respond({ compat: null }); break;
        case 'pickBirthPlace': respond(null); break;
        case 'openPaywall': case 'requestLogin': respond({ completed: false }); break;
        default: respond({});
      }
    } catch (err) {
      replyToModule({ type: 'ack', bridgeNonce: d.bridgeNonce, requestId, ackType: type, error: { code: err.code || 500, message: err.message || String(err) } });
    }
  });

  document.getElementById('start').addEventListener('click', () => {
    document.getElementById('gate').style.display = 'none';
    document.getElementById('app').classList.add('on');
  });
})();
