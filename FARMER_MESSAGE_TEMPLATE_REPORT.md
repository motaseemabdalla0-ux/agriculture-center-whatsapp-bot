# تقرير: القالب الموحّد لرسائل المزارعين (اسم | رقم هاتف | رسالة)

## الملفات المعدّلة

| الملف | التعديل |
|---|---|
| `lib/fileIngest.js` | دالة جديدة `parseFarmerMessageRows(buffer)` - تدعم الأعمدة العربية الرسمية (اسم الشخص/رقم الهاتف/الرسالة) والبدائل الإنجليزية، وترجع `hasMessageColumn` لتمييز الملف الجديد عن القديم |
| `lib/campaignBuilder.js` | إضافة حالتين جديدتين `missing_name`/`missing_message`؛ التكرار داخل الملف بقى بمفتاح `phone+normalizedMessage` (مش `phone` لوحده) - نفس الشخص برسالة مختلفة بقى يعدي |
| `campaign-inbox/inboxEngine.js` | يستخدم `parseFarmerMessageRows` - لو فيه عمود رسالة، كل صف ياخد رسالته هو؛ لو مفيش، يرجع لسلوك القديم (رسالة حملة واحدة + `{name}`) |
| `index.js` | سطر واحد للحفاظ على التوافق: تجميع `invalid_phone + missing_name + missing_message` في نفس عداد "جوال غير صحيح/رسالة فاضية" القديم في معاينة الشات، عشان الرقم المعروض هناك يفضل صحيح زي الأول |
| `templates/farmer_messages_template.xlsx` (جديد) | القالب الرسمي: اسم الشخص \| رقم الهاتف \| الرسالة + مثال |
| `scripts/testFarmerMessageTemplate.js` (جديد) | 29 اختبار (1-12 المطلوبة بالكامل) |
| `scripts/testStateSafetyEngine.js` | تصحيح اختبار G القديم (كان يفترض "نفس الرقم = تكرار دومًا")؛ أُضيف G2 يثبت "نفس الرقم + رسالة مختلفة = يعدي" |

**لم تُمس**: `safeFarmerSend.js`, `farmerState.js`, `sendFingerprint.js`, `sentTracker.js`, `rateLimiter.js`, `campaignRunner.js`, `campaignStore.js` - كل رسالة (سواء من القالب الجديد أو القديم) بتمر بنفس المحرك بالضبط.

## نتائج الاختبارات

| المجموعة | نجح | فشل |
|---|---|---|
| A–N + G2 (Part A، بعد تصحيح G) | 33 | 0 |
| Part B | 60 | 0 |
| Part C | 24 | 0 |
| Updater + Campaign Inbox | 36 | 0 |
| **القالب الموحّد (جديد)** | **29** | **0** |
| **الإجمالي** | **182** | **0** |

صفر رسائل واتساب حقيقية (Fake Client في كل الاختبارات). `node --check` نجح على كل الملفات المعدّلة. بحث `client.sendMessage` أكّد: صفر مسار جديد - كل رسالة (قالب جديد أو قديم) تمر حصرًا عبر `safeFarmerSend`.

## مثال Preview حقيقي بالقالب العربي

ملف فيه 6 صفوف (اسم الشخص | رقم الهاتف | الرسالة)، شامل حالات مقصودة (رقم فاضي، اسم فاضي، رسالة فاضية، وتكرار):

```json
{
  "total": 6, "valid": 2, "invalid_phone": 1, "missing_name": 1,
  "missing_message": 1, "duplicate": 1, "already_received": 0,
  "excluded_active_application": 0, "excluded_card_issued": 0,
  "excluded_card_collected": 0, "stale_application": 0,
  "rows": [
    { "name": "أحمد محمد", "phone": "966512345678", "messagePreview": "السلام عليكم أستاذ أحمد، نأمل استكمال بياناتكم.", "decision": "READY_TO_SEND", "reason": null },
    { "name": "سالم علي", "phone": "966555555555", "messagePreview": "مرحبًا سالم، تذكير بموعد التسليم.", "decision": "READY_TO_SEND", "reason": null },
    { "name": "بدون رقم", "phone": "", "messagePreview": "رسالة بدون رقم", "decision": "INVALID_PHONE", "reason": null },
    { "name": "", "phone": "0512399999", "messagePreview": "رسالة بدون اسم", "decision": "MISSING_NAME", "reason": null },
    { "name": "مزارع بدون رسالة", "phone": "966512388888", "messagePreview": "", "decision": "MISSING_MESSAGE", "reason": null },
    { "name": "تكرار", "phone": "966512345678", "messagePreview": "السلام عليكم أستاذ أحمد، نأمل استكمال بياناتكم.", "decision": "DUPLICATE", "reason": null }
  ]
}
```
كل رسالة هنا لسه ما اتبعتش - الملف واقف عند `PREVIEW_READY`، ولازم يعدي على DRY RUN ثم Approval صريح قبل أي إرسال حقيقي، بالضبط زي التدفق الحالي بدون أي تغيير.
