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
          // 双模式：有 bazi-inline（静态版）→ 浏览器本地排盘；否则走服务端 API（实时版）
          let j;
          if (window.__baziLocal) {
            try { const d = window.__baziLocal.computeBazi(payload.answers); j = { ok: true, preview: window.__baziLocal.buildPreview(d), plan: window.__baziLocal.buildFinalPlan(d) }; }
            catch (e) { j = { ok: false, error: e.message }; }
          } else {
            const r = await fetch('api/bazi', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload.answers) });
            j = await r.json();
          }
          if (!j.ok) throw { code: 500, message: j.error || 'compute failed' };
          session = { answers: payload.answers, preview: j.preview, plan: j.plan };
          respond({
            submit: { caseId, moduleRunId: caseId, slug: 'mzmudang-fate', answersHash: payload.answersHash || '', status: 'summary_ready', replay: false },
            preview: session.preview,
          });
          break;
        }
        case 'unlock': respond({ completed: true, orderId: 'demo-' + caseId }); break;
        case 'checkEntitlement': respond({ unlocked: true, product: 'final_plan' }); break;
        case 'getResult': respond(session && session.plan ? session.plan : { finalPlan: session && session.plan }); break;
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
