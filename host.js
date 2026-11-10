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
        case 'track': respond({}); break;
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
