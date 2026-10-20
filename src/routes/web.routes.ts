// Store landing page served from backend (required for App Store metadata URLs)
// GET / → Branded landing for Esmail ElGazar platform
import { Router, Request, Response } from 'express';
import path from 'path';
import { APP_DOMAIN, SUPPORT_EMAIL } from '../utils/env';

const router = Router();

// Serve static assets (logo, screenshots, etc.)
router.use('/assets', (req: Request, res: Response, next) => {
  // Cache for 7 days — store assets don't change often
  res.setHeader('Cache-Control', 'public, max-age=604800');
  next();
});

// Main landing page
router.get('/', (req: Request, res: Response) => {
  const host = `${req.protocol}://${req.get('host') || APP_DOMAIN}`;
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
        <a href="mailto:${SUPPORT_EMAIL}">الدعم الفني</a>
      </p>
      <p style="margin-top:.5rem;">© 2026 Esmail ElGazar. جميع الحقوق محفوظة.</p>
    </footer>
  </main>
</body>
</html>`);
});

  // Privacy Policy (required for store listing).
  //
  // Served from the file, not from a copy embedded in this route. There were two
  // sources of truth: this route served an inline document with five sections
  // while public/privacy-policy.html held nine. Editing one shipped a different
  // policy than editing the other, and the inline copy won in production because
  // this route never read the file at all. The file is also the one linked from the
  // landing footer, so it is the maintained copy.
  router.get('/privacy-policy.html', (req: Request, res: Response) => {
    res.sendFile(path.join(process.cwd(), 'public', 'privacy-policy.html'));
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
