// إعدادات PM2 للبوت - عشان autorestart/restart_delay/max_memory_restart تتضبط مرة واحدة بدل
// ما تعتمد على إعدادات افتراضية أو أوامر "pm2 start" يدوية بيسهل ننساها. الاستخدام على السيرفر:
//   pm2 delete agriculture-bot   (لو العملية الحالية اتعملها start يدوي من غير الملف ده)
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2 startup   (مرة واحدة بس - يسجّل PM2 يشتغل تلقائيًا مع تشغيل الويندوز)
module.exports = {
  apps: [
    {
      name: "agriculture-bot",
      script: "index.js",
      cwd: __dirname,
      autorestart: true,
      restart_delay: 10000, // 10 ثواني - وقت كافي لـChrome يقفل تمامًا قبل محاولة فتحه تاني
      max_memory_restart: "500M", // Chrome عالق/تسريب ذاكرة بياخد وقت طويل ما يبانش غير كده
      max_restarts: 20, // حماية من restart loop سريع جدًا (لو مشكلة بنيوية مش هتتحل بإعادة التشغيل)
      min_uptime: 30000, // لازم يفضل شغّال 30 ثانية على الأقل عشان تتحسب "تشغيلة ناجحة" لعداد max_restarts
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
