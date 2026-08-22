// Store landing page served from backend (required for App Store metadata URLs)
// GET / → Branded landing for Esmail ElGazar platform
import { Router, Request, Response } from 'express';
import path from 'path';

const router = Router();

// Serve static assets (logo, screenshots, etc.)
router.use('/assets', (req: Request, res: Response, next) => {
  // Cache for 7 days — store assets don't change often
  res.setHeader('Cache-Control', 'public, max-age=604800');
  next();
});

// Main landing page
router.get('/', (req: Request, res: Response) => {
  const host = `${req.protocol}://${req.get('host')}`;
  res.send(`
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Esmail ElGazar — منصة التعليم الرقمية</title>
  <style>
    :root{--gold:#E6C27A;--bg:#0A0F1A;--surface:#141C2B;--text:#F3F4F6;--muted:#9CA3AF}
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.7}
    main{max-width:800px;margin:0 auto;padding:2rem 1.5rem}
    header{text-align:center;margin-bottom:3rem;padding:3rem 1rem;background:linear-gradient(135deg,#1a2235,#0A0F1A);border-radius:16px;border:1px solid var(--surface)}
    .logo{font-size:3rem;font-weight:800;color:var(--gold);margin-bottom:.5rem;text-shadow:0 2px 20px rgba(230,194,122,.3)}
    .tagline{color:var(--muted);font-size:1.1rem}
    .cta{display:inline-block;margin-top:1.5rem;padding:.9rem 2rem;background:var(--gold);color:#0A0F1A;font-weight:700;border-radius:10px;text-decoration:none;transition:transform .2s}
    .cta:hover{transform:translateY(-2px)}
    h2{color:var(--gold);margin:2rem 0 1rem;font-size:1.4rem}
    ul{list-style:none;padding:0}
    li{padding:.8rem 1rem;margin-bottom:.5rem;background:var(--surface);border-right:3px solid var(--gold);border-radius:8px}
    footer{margin-top:4rem;padding-top:2rem;border-top:1px solid var(--surface);text-align:center;color:var(--muted);font-size:.85rem}
    footer a{color:var(--gold);text-decoration:none}
    @media(max-width:640px){.logo{font-size:2rem}}
  </style>
</head>
<body>
  <main>
    <header>
      <div class="logo">Esmail ElGazar</div>
      <p class="tagline">تعليم متكامل — فيديوهات تفاعلية، اختبارات، ومتابعة لأولياء الأمور</p>
      <a href="#features" class="cta">اكتشف المميزات ↓</a>
    </header>

    <h2>🎯 ليه تختار منصتنا؟</h2>
    <ul>
      <li><strong>فيديوهات عالية الجودة</strong> — بث مباشر بدون تقطيع عبر Bunny CDN</li>
      <li><strong>اختبارات فورية</strong> — نتائج لحظية مع تحليل نقاط القوة والضعف</li>
      <li><strong>لمتابعة أولياء الأمور</strong> — تقارير أسبوعية عن تقدم الأبناء</li>
      <li><strong>حضور بالـ QR</strong> — تسجيل دخول سريع وآمن للطلاب</li>
      <li><strong>دفع مستضاف</strong> — تتم بيانات الدفع داخل Paymob، والتفعيل بعد Webhook موثّق</li>
    </ul>

    <h2>📱 حمّل التطبيق</h2>
    <p>متاح قريباً على Google Play و App Store — سجّل حسابك دلوقتي وهتوصلك إشعار بالإطلاق.</p>

    <h2>🔒 الخصوصية والأمان</h2>
    <p>نعتمد HTTPS وكلمات مرور مجزأة، وتتم بيانات البطاقة داخل صفحة Paymob المستضافة ولا تمر عبر خادم المنصة.</p>

    <footer>
      <p>
        <a href="${host}/privacy-policy.html">سياسة الخصوصية</a> ·
        <a href="${host}/terms.html">شروط الاستخدام</a> ·
        <a href="mailto:support@elgazar.edu">الدعم الفني</a>
      </p>
      <p style="margin-top:.5rem;">© 2026 Esmail ElGazar. جميع الحقوق محفوظة.</p>
    </footer>
  </main>
</body>
</html>`);
});

// Privacy Policy page (required for store listing)
router.get('/privacy-policy.html', (req: Request, res: Response) => {
  res.send(`
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>سياسة الخصوصية — Esmail ElGazar</title>
  <style>
    body{font-family:'Segoe UI',sans-serif;max-width:800px;margin:0 auto;padding:2rem;line-height:1.8;background:#f8f9fa;color:#1a1a2e}
    h1{color:#B8860B;font-size:1.6rem;margin-bottom:1rem}
    h2{color:#0A0F1A;font-size:1.1rem;margin-top:2rem;margin-bottom:.5rem}
    p{margin-bottom:.6rem}
  </style>
</head>
<body>
  <h1>سياسة الخصوصية لمنصة Esmail ElGazarالتعليمية</h1>
  <p><strong>آخر تحديث:</strong> 11 أغسطس 2026</p>
  
  <h2>1. البيانات التي نجمعها</h2>
  <p>نجمع: الاسم، رقم الهاتف، البريد الإلكتروني، معلومات الدفع (لا تُخزن محلياً)، سجل الحضور، درجات الاختبارات.</p>
  
  <h2>2. كيفية استخدام البيانات</h2>
  <p>نستخدم بياناتك فقط لتقديم الخدمة: تتبع التقدم الدراسي، إرسال تقارير لأولياء الأمور، معالجة الاشتراكات.</p>
  
  <h2>3. مشاركة البيانات</h2>
  <p>لا نبيع بياناتك. قد نعالج الحد الأدنى اللازم عبر Paymob للدفع، Railway للاستضافة، Bunny للفيديو، Sentry للأعطال، وخدمات الإشعارات والبريد عند تفعيلها.</p>
  
  <h2>4. حقوقك</h2>
  <p>يمكنك طلب حذف حسابك وبياناتك في أي وقت بمراسلة: privacy@elgazar.edu — سنحذفها خلال 30 يوم.</p>
  
  <h2>5. الأمان</h2>
  <p>نستخدم JWT موقّعًا للتحقق من الجلسات، وHTTPS للطلبات، ولا نخزّن كلمات المرور أو أكواد الاستعادة كنص صريح.</p>
  
  <p style="margin-top:2rem;font-size:.85rem;color:#666">
    للاستفسارات: support@elgazar.edu — Cairo, Egypt
  </p>
</body>
</html>`);
});

// Terms of Service page (linked from the landing footer)
router.get('/terms.html', (req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'public', 'terms.html'));
});

router.get('/privacy', (_req, res) => res.redirect(302, '/privacy-policy.html'));
router.get('/terms', (_req, res) => res.redirect(302, '/terms.html'));

// Paymob browser return is informational only. Entitlement activation happens
// exclusively after the verified webhook updates the payment order.
router.get('/payment/return', (req, res) => {
  const orderId = String(req.query.orderId ?? '');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>جارٍ تأكيد الدفع</title><style>body{margin:0;background:#0c0b0a;color:#f7f1e9;font-family:Arial,sans-serif;min-height:100vh;display:grid;place-items:center}.box{width:min(520px,calc(100% - 40px));padding:32px;border:1px solid #453e38;border-radius:24px;background:#171411}.dot{width:12px;height:12px;border-radius:50%;background:#ff806e;display:inline-block;margin-left:8px}h1{font-size:28px}p{color:#b8aea5;line-height:1.8}.ref{font-family:monospace;color:#d5b98a;word-break:break-all}</style></head><body><main class="box"><h1><span class="dot"></span>جارٍ تأكيد الدفع</h1><p>الرجوع من صفحة الدفع لا يفعّل الكورس وحده. افتح التطبيق واضغط «تحديث حالة الدفع» بعد لحظات.</p>${orderId ? `<p class="ref">${orderId.replace(/[^a-zA-Z0-9-]/g, '')}</p>` : ''}<p>يمكنك إغلاق هذه الصفحة بأمان.</p></main></body></html>`);
});

export default router;
