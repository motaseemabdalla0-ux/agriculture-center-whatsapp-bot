const inboxStore = require("./inboxStore");
const inboxEngine = require("./inboxEngine");
const rateLimiter = require("../lib/rateLimiter");

// استئناف تلقائي للحملات - بدون أي ضغط يدوي على "استئناف" كل يوم. الفكرة بسيطة عمدًا (مفيش
// Cron خارجي ولا Process تاني - نفس عملية Node الواحدة، Single Process زي المتفق عليه): كل
// فترة قصيرة (DEFAULT_TICK_MS) بنفحص هل فيه حملات APPROVED أو متوقفة بسبب حصة (PAUSED_HOURLY_
// LIMIT/PAUSED_DAILY_LIMIT)، ولو الحصة (rateLimiter) فاضية دلوقتي، بننادي sendApprovedCampaign
// تاني فيهم - وهي نفسها هتوقف تلقائي تاني على أول rate_limited جديد لو الحصة خلصت فورًا.
const DEFAULT_TICK_MS = 60 * 1000; // دقيقة - كافي جدًا (الحد الساعي بيتصفّر مع بداية الساعة، مش لحظي)

let isProcessing = false; // قفل بسيط يمنع تداخل نداءين لنفس الحملة لو Tick اتأخر لأي سبب

function resumableCampaigns() {
  const statuses = new Set(["APPROVED", ...inboxEngine.RATE_LIMIT_PAUSE_STATUSES]);
  return inboxStore.listCampaigns().filter((c) => statuses.has(c.status));
}

async function tick(client) {
  if (isProcessing) return { skipped: true, reason: "already_processing" };
  isProcessing = true;
  const processed = [];
  try {
    if (rateLimiter.isPaused()) return { skipped: true, reason: "rate_limiter_manually_paused" };

    const candidates = resumableCampaigns();
    for (const c of candidates) {
      const status = rateLimiter.getStatus();
      if (status.daily.remaining <= 0) break; // مفيش حصة يومية خالص - نوقف الجولة دي بالكامل
      if (status.hourly.remaining <= 0) continue; // الساعة دي خلصت بس اليوم لسه فيه حصة - نجرب حملة تانية أو ننتظر الساعة الجاية

      try {
        const updated = await inboxEngine.sendApprovedCampaign(c.campaignId, client);
        processed.push({ campaignId: c.campaignId, status: updated.status });
      } catch (err) {
        processed.push({ campaignId: c.campaignId, error: err.message });
      }
    }
  } finally {
    isProcessing = false;
  }
  return { skipped: false, processed };
}

function startScheduler(client, { intervalMs = DEFAULT_TICK_MS } = {}) {
  const timer = setInterval(() => {
    tick(client).catch((err) => console.log(`⚠️ [Campaign Scheduler] خطأ غير متوقع: ${err.message}`));
  }, intervalMs);
  if (timer.unref) timer.unref(); // ميمنعش عملية Node من الإغلاق الطبيعي لو محتاجين كده
  return timer;
}

module.exports = { startScheduler, tick, resumableCampaigns };
