// Wrapper محلي (مش تعديل على node_modules) لإصلاح مشكلة معروفة وموثّقة في whatsapp-web.js
// 1.34.7 (أحدث نسخة منشورة على npm وقت كتابة هذا الكود - مفيش نسخة أحدث تحل المشكلة دي):
// مع رسائل من محادثات @lid، واتساب ويب (نسخة 2.3000.10437xx فما فوق، بعد تحديث LID Migration
// منتصف يوليو 2026) بقى بيعرض قيمة الـSerialized Message ID تحت اسم مختلف ($1) بدل
// الاسم القديم (_serialized) اللي المكتبة المنشورة لسه بتعتمد عليه. فيه Pull Request مفتوح
// على مستودع المكتبة (unmerged وقت كتابة هذا الكود) بعنوان "$1 vs _serialized rename" بيعالج
// بالظبط نفس المشكلة دي - إحنا بنطبّق نفس الفكرة هنا كـWrapper مستقل، من غير أي تعديل دائم
// على node_modules (يعني آمن تمامًا مع أي npm install مستقبلي، ومفيش خطر نكسر أي حاجة تانية).
//
// المصدر: node_modules/whatsapp-web.js/src/structures/Message.js (downloadMedia, أسطر ~513-597)
// - نفس المنطق بالظبط (نفس نداءات Msg.get/getMessagesById/downloadAndMaybeDecrypt جوّه صفحة
// المتصفح)، الفرق الوحيد: مصدر الـmsgId اللي بيتبعت لـpupPage.evaluate.
//
// ترتيب الأولوية لمصدر الـSerialized ID (موثّق صراحةً، مش تخمين):
//   1) msg.id._serialized  - القيمة العادية لو موجودة (أغلب الرسائل @c.us - مفيش مشكلة أصلًا هنا)
//   2) msg.id.$1           - القيمة الفعلية اللي واتساب ويب بيحسبها لرسائل @lid بعد تحديث LID
//                            Migration (مؤكدة من اللوج الحقيقي: msg.id keys تحتوي $1 و_serialized
//                            مفقودة) - أولوية أعلى من إعادة البناء اليدوي لأنها قيمة حقيقية جاهزة
//   3) إعادة بناء يدوي (fromMe_remote_id[_participant]) - خط دفاع أخير بس لو $1 مفقودة كمان،
//      بنفس الصيغة الموثّقة رسميًا لحساب _serialized في المكتبة نفسها
//
// TODO (توثيق للإزالة لاحقًا): لو نسخة whatsapp-web.js تتحدّث مستقبلًا وتحل المشكلة دي رسميًا
// (تابع: https://github.com/pedroslopez/whatsapp-web.js/issues/201844)، احذف هذا الملف
// والاستخدام بتاعه في index.js، وارجع لـ msg.downloadMedia() العادية مباشرة.

const { MessageMedia } = require("whatsapp-web.js");

// بيرجع { id, source } - source واحدة من "_serialized" | "$1" | "reconstructed" | null
function resolveSerializedId(msg) {
  const idObj = msg.id;
  if (!idObj || typeof idObj !== "object") return { id: null, source: null };

  if (idObj._serialized) return { id: idObj._serialized, source: "_serialized" };
  if (idObj.$1) return { id: idObj.$1, source: "$1" };
  if (idObj.id && idObj.remote !== undefined) {
    const reconstructed = `${idObj.fromMe}_${idObj.remote}_${idObj.id}${idObj.participant ? `_${idObj.participant}` : ""}`;
    return { id: reconstructed, source: "reconstructed" };
  }
  return { id: null, source: null };
}

function isLidRemote(msg) {
  return String((msg.id && msg.id.remote) || "").endsWith("@lid");
}

// نفس منطق Message.prototype.downloadMedia بالظبط (نسخة 1.34.7) - الفرق الوحيد: بيستخدم
// resolveSerializedId(msg) بدل msg.id._serialized مباشرة. بيرجع { media, source, remoteType }
// عشان التشخيص/التقرير يعرف بالظبط المصدر المستخدم من غير تخمين
async function downloadMediaCompat(client, msg) {
  const remoteType = isLidRemote(msg) ? "@lid" : "@c.us";
  if (!msg.hasMedia) return { media: undefined, source: null, remoteType };

  const { id: msgId, source } = resolveSerializedId(msg);
  if (!msgId) {
    console.log("🩺 [Diagnostic-Media] LID_MEDIA_LOOKUP_FAILED: مفيش أي معرّف صالح (_serialized/$1/reconstructed) نقدر نستخدمه خالص");
    return { media: undefined, source: null, remoteType };
  }

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

  if (!result) {
    // الـID كان موجود ووصل للمتصفح، بس Msg.get/getMessagesById فشلوا يلاقوا الرسالة فعليًا
    // جوّه Store واتساب ويب - ده تحديدًا سيناريو LID_MEDIA_LOOKUP_FAILED لو remote كان @lid
    if (remoteType === "@lid") {
      console.log(`🩺 [Diagnostic-Media] LID_MEDIA_LOOKUP_FAILED: الـID (مصدره: ${source}) وصل للمتصفح بس الرسالة مش موجودة في Store واتساب ويب`);
    }
    return { media: undefined, source, remoteType };
  }
  return {
    media: new MessageMedia(result.mimetype, result.data, result.filename, result.filesize),
    source,
    remoteType,
  };
}

module.exports = { downloadMediaCompat, resolveSerializedId, isLidRemote };
