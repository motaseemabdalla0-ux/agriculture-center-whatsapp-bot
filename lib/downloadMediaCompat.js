// Wrapper محلي (مش تعديل على node_modules) لإصلاح مشكلة معروفة وموثّقة في whatsapp-web.js
// 1.34.7 (أحدث نسخة منشورة على npm وقت كتابة هذا الكود - مفيش نسخة أحدث تحل المشكلة دي):
// مع رسائل من محادثات @lid، واتساب ويب (نسخة 2.3000.10437xx فما فوق، بعد تحديث LID Migration
// منتصف يوليو 2026) بقى بيعرض قيمة الـSerialized Message ID تحت اسم مختلف ($1) بدل
// الاسم القديم (_serialized) اللي المكتبة النشورة لسه بتعتمد عليه. فيه Pull Request مفتوح
// على مستودع المكتبة (unmerged وقت كتابة هذا الكود) بعنوان "$1 vs _serialized rename" بيعالج
// بالظبط نفس المشكلة دي - إحنا بنطبّق نفس الفكرة هنا كـWrapper مستقل، من غير أي تعديل دائم
// على node_modules (يعني آمن تمامًا مع أي npm install مستقبلي، ومفيش خطر نكسر أي حاجة تانية).
//
// المصدر: node_modules/whatsapp-web.js/src/structures/Message.js (downloadMedia, أسطر ~513-597)
// - نفس المنطق بالظبط، الفرق الوحيد: بنستخدم $1 بدل _serialized لو الأخيرة مفقودة.
//
// TODO (توثيق للإزالة لاحقًا): لو نسخة whatsapp-web.js تتحدّث مستقبلًا وتحل المشكلة دي رسميًا
// (تابع: https://github.com/pedroslopez/whatsapp-web.js/issues/201844)، احذف هذا الملف
// والاستخدام بتاعه في index.js، وارجع لـ msg.downloadMedia() العادية مباشرة.

const { MessageMedia } = require("whatsapp-web.js");

function resolveSerializedId(msg) {
  const idObj = msg.id;
  if (!idObj || typeof idObj !== "object") return null;
  // _serialized العادية لو موجودة (أغلب الرسائل العادية - مفيش داعي للـWorkaround أصلًا هنا)
  if (idObj._serialized) return idObj._serialized;
  // الحالة اللي بنعالجها: @lid rename - $1 هي القيمة الصحيحة الفعلية حسب الدليل الحقيقي من
  // اللوج (msg.id keys: fromMe/remote/id/self/$1، و_serialized مفقودة) - مش تخمين
  if (idObj.$1) return idObj.$1;
  return null;
}

// نفس منطق Message.prototype.downloadMedia بالظبط (نسخة 1.34.7) - الفرق الوحيد: بيستخدم
// resolveSerializedId(msg) بدل msg.id._serialized مباشرة
async function downloadMediaCompat(client, msg) {
  if (!msg.hasMedia) return undefined;

  const msgId = resolveSerializedId(msg);
  if (!msgId) return undefined; // مفيش أي معرّف صالح نقدر نستخدمه خالص - نفشل بأمان بدل ما نخمّن

  const result = await client.pupPage.evaluate(async (msgId) => {
    const msg =
      window.require("WAWebCollections").Msg.get(msgId) ||
      (await window.require("WAWebCollections").Msg.getMessagesById([msgId]))?.messages?.[0];

    if (!msg || !msg.mediaData || msg.mediaData.mediaStage === "REUPLOADING") {
      return null;
    }
    if (msg.mediaData.mediaStage != "RESOLVED") {
      await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
    }
    if (msg.mediaData.mediaStage.includes("ERROR") || msg.mediaData.mediaStage === "FETCHING") {
      return undefined;
    }

    try {
      const mockQpl = {
        addAnnotations: function () {
          return this;
        },
        addPoint: function () {
          return this;
        },
      };
      const decryptedMedia = await window.require("WAWebDownloadManager").downloadManager.downloadAndMaybeDecrypt({
        directPath: msg.directPath,
        encFilehash: msg.encFilehash,
        filehash: msg.filehash,
        mediaKey: msg.mediaKey,
        mediaKeyTimestamp: msg.mediaKeyTimestamp,
        type: msg.type,
        signal: new AbortController().signal,
        downloadQpl: mockQpl,
      });
      const data = await window.WWebJS.arrayBufferToBase64Async(decryptedMedia);
      return { data, mimetype: msg.mimetype, filename: msg.filename, filesize: msg.size };
    } catch (e) {
      if (e.status && e.status === 404) return undefined;
      throw e;
    }
  }, msgId);

  if (!result) return undefined;
  return new MessageMedia(result.mimetype, result.data, result.filename, result.filesize);
}

module.exports = { downloadMediaCompat, resolveSerializedId };
