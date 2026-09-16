// قارئ/كاتب CSV بسيط بس بيحترم الاقتباسات (زي معيار RFC4180): بيدعم فاصلة أو سطر جديد
// جوه حقل متبع بعلامتي اقتباس، وعلامة اقتباس داخل الحقل نفسه بتتكرر مرتين ("").
// من غير كده (زي القارئ القديم اللي كان بيقسّم على الفاصلة والسطر الجديد مباشرة)، أي اسم أو
// رسالة فيها فاصلة كانت بتخلط ترتيب الأعمدة أو تقطع النص.

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  // آخر صف لو الملف مخلصش بسطر جديد
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

// بيحوّل قيمة لحقل CSV آمن: يحطها بين علامتي اقتباس لو فيها فاصلة أو اقتباس أو سطر جديد
function csvField(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

module.exports = { parseCsv, csvField };
