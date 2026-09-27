const districts = require("./deliveryRegionsData");

// خوارزمية Ray Casting القياسية لفحص "هل نقطة جوّه Polygon" - مفيش أي مكتبة خارجية أو اتصال
// إنترنت، كل الحساب محلي بالكامل من بيانات lib/deliveryRegionsData.js الثابتة
function pointInPolygon(lon, lat, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// بيرجع {zone, district} لو الإحداثيات وقعت جوّه أي من المناطق الـ14 المعروفة، وإلا null
// (يعني موقع المزارع برّه نطاق محافظة العلا الزراعي المعروف - محتاج اختيار يدوي بدل التخمين)
function classifyPoint(lat, lon) {
  for (const d of districts) {
    if (pointInPolygon(lon, lat, d.polygon)) return { zone: d.zone, district: d.name };
  }
  return null;
}

module.exports = { classifyPoint, pointInPolygon };
