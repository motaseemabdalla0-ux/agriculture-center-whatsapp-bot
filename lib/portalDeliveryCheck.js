const store = require("./deliveryStore");

// مطابقة طلبات التوصيل المفتوحة (NEW) أو اللي اتسجّل لها تعذّر (FAILED_DELIVERY) مع تاب "Delivered"
// في صفحة إصدار البطاقات بالمنصة - لو البطاقة ظاهرة هناك يبقى اتسلّمت فعلًا (حتى لو موظف التوصيل
// ماكتبش "تم" في المجموعة). المطابقة بالجوال أولًا، وبرقم نموذج المنصة (Form Number) كمطابقة ثانية.
// دوال نقية (بتاخد الصفوف كمُدخل) عشان تتختبر من غير متصفح ولا واتساب
function normPhone(p) {
  return String(p || "").replace(/[^\d]/g, "").replace(/^00/, "").replace(/^0?5/, "9665");
}

function matchDelivered(requests, deliveredRows, platformNumberOf = () => null) {
  const byPhone = new Map();
  const byForm = new Map();
  deliveredRows.forEach((row) => {
    if (row.phone) byPhone.set(normPhone(row.phone), row);
    const form = String(row.formNumber || "").trim();
    if (/^\d+$/.test(form)) byForm.set(form, row);
  });

  const matches = [];
  requests.forEach((request) => {
    if (request.status !== "NEW" && request.status !== "FAILED_DELIVERY") return;
    const phoneHit = byPhone.get(normPhone(request.phone));
    if (phoneHit) {
      matches.push({ request, row: phoneHit, by: "phone" });
      return;
    }
    const platformNo = String(request.platformRequestNumber || platformNumberOf(request.phone) || "").trim();
    const formHit = /^\d+$/.test(platformNo) ? byForm.get(platformNo) : null;
    if (formHit) matches.push({ request, row: formHit, by: "form" });
  });
  return matches;
}

// بيطبّق المطابقة فعليًا على الـstore (markDelivered بمصدر "portal") ويرجّع الطلبات اللي اتحدّثت
function applyDeliveredFromPortal(deliveredRows, platformNumberOf) {
  const matches = matchDelivered(store.getAllRequests(), deliveredRows, platformNumberOf);
  const updated = [];
  matches.forEach(({ request, by }) => {
    const done = store.markDelivered(request.id, "portal");
    if (done) updated.push({ id: done.id, name: done.name, phone: done.phone, regionKey: done.regionKey, by });
  });
  return updated;
}

module.exports = { matchDelivered, applyDeliveredFromPortal, normPhone };
