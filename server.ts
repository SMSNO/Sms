import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSequentialAutomation } from './server/automation.ts';
import {
  parseAndDeduplicatePhones,
  validateTargetUrl,
  type AutomationStreamEvent,
} from './src/utils/phoneQueue.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Built-in authorized test form endpoint used for verifying Playwright automation & CI checks
app.get('/test-form', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>نموذج اختبار مصرح به</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #f8fafc; color: #0f172a; padding: 2rem; }
      main { max-width: 420px; margin: 2rem auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.5rem; }
      label { display: block; font-weight: 600; margin-bottom: 0.5rem; }
      input { width: 100%; padding: 0.65rem; border: 1px solid #cbd5e1; border-radius: 6px; margin-bottom: 1rem; box-sizing: border-box; direction: ltr; }
      button { width: 100%; padding: 0.7rem; background: #0f172a; color: #fff; border: 0; border-radius: 6px; font-weight: 600; cursor: pointer; }
      .msg { margin-top: 1rem; font-size: 0.9rem; }
      .ok { color: #15803d; }
      .err { color: #b91c1c; }
    </style>
  </head>
  <body>
    <main>
      <h1>نموذج استقبال الأرقام</h1>
      <form id="phone-form">
        <label for="phone-input">رقم الهاتف</label>
        <input id="phone-input" name="phone" type="tel" placeholder="+966501234567" required />
        <button type="submit">إرسال</button>
      </form>
      <div id="feedback" class="msg"></div>
    </main>
    <script>
      const form = document.getElementById('phone-form');
      const input = document.getElementById('phone-input');
      const feedback = document.getElementById('feedback');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        feedback.textContent = '';
        feedback.removeAttribute('data-status');
        feedback.removeAttribute('role');
        const res = await fetch('/api/test-form-submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: input.value }),
        });
        const data = await res.json();
        if (res.ok) {
          feedback.setAttribute('role', 'status');
          feedback.setAttribute('data-status', 'success');
          feedback.className = 'msg ok success-message';
          feedback.textContent = data.message;
        } else {
          feedback.setAttribute('role', 'alert');
          feedback.setAttribute('data-status', 'error');
          feedback.className = 'msg err error-message';
          feedback.textContent = data.message;
        }
      });
    </script>
  </body>
</html>`);
});

app.post('/api/test-form-submit', (req, res) => {
  const rawPhone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length < 7 || rawPhone.toLowerCase().includes('fail')) {
    res.status(400).json({ ok: false, message: `رفض النموذج الرقم (${rawPhone || 'فارغ'}) لعدم مطابقة الشروط.` });
    return;
  }
  res.json({ ok: true, message: `تم استلام الرقم ${rawPhone} بنجاح.` });
});

app.get('/test-form-country', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="UTF-8" />
    <title>نموذج اختبار مع كود الدولة</title>
  </head>
  <body>
    <div role="dialog">
      <h2>What's your number?</h2>
      <div id="phone-view">
        <button id="country-btn" type="button" aria-label="Select your phone country code">GB +44</button>
        <input id="phone-input" name="phone_number" type="text" />
        <button id="next-btn" type="button" disabled>Next</button>
      </div>
      <div id="country-list" style="display:none;">
        <button type="button" data-code="+44">United Kingdom +44</button>
        <button type="button" data-code="+20">Egypt +20</button>
        <button type="button" data-code="+966">Saudi Arabia +966</button>
        <button type="button" data-code="+1">United States +1</button>
      </div>
      <div id="feedback"></div>
    </div>
    <script>
      let selectedCode = '+44';
      const countryBtn = document.getElementById('country-btn');
      const phoneView = document.getElementById('phone-view');
      const countryList = document.getElementById('country-list');
      const input = document.getElementById('phone-input');
      const nextBtn = document.getElementById('next-btn');
      const feedback = document.getElementById('feedback');

      countryBtn.addEventListener('click', () => {
        phoneView.style.display = 'none';
        countryList.style.display = 'block';
      });

      countryList.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', () => {
          selectedCode = btn.getAttribute('data-code');
          countryBtn.textContent = selectedCode;
          countryList.style.display = 'none';
          phoneView.style.display = 'block';
        });
      });

      input.addEventListener('input', () => {
        nextBtn.disabled = input.value.trim().length < 5;
      });

      nextBtn.addEventListener('click', () => {
        feedback.setAttribute('role', 'status');
        feedback.setAttribute('data-status', 'success');
        feedback.textContent = 'تم الإرسال بالكود ' + selectedCode + ' والرقم ' + input.value.trim();
      });
    </script>
  </body>
</html>`);
});

app.post('/api/automate', async (req, res) => {
  const rawUrl = typeof req.body?.url === 'string' ? req.body.url : '';
  const rawPhones = typeof req.body?.phones === 'string' ? req.body.phones : '';
  const alreadyProcessedArray = Array.isArray(req.body?.alreadyProcessedKeys)
    ? req.body.alreadyProcessedKeys.filter((item: unknown): item is string => typeof item === 'string')
    : [];

  const urlCheck = validateTargetUrl(rawUrl);
  if (!urlCheck.valid || !urlCheck.normalizedUrl) {
    res.status(400).json({ error: urlCheck.error || 'الرابط غير صالح.' });
    return;
  }

  const parsed = parseAndDeduplicatePhones(rawPhones, new Set(alreadyProcessedArray));
  if (parsed.queue.length === 0) {
    res.status(400).json({
      error:
        parsed.skippedAlreadyProcessed > 0
          ? 'تمت معالجة جميع الأرقام المُدخلة مسبقًا.'
          : 'يرجى إدخال رقم هاتف واحد على الأقل.',
    });
    return;
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (event: AutomationStreamEvent) => {
    if (!res.writableEnded) {
      res.write(`${JSON.stringify(event)}\n`);
    }
  };

  const abortController = new AbortController();
  res.on('close', () => {
    abortController.abort();
  });

  const indexedItems = parsed.queue.map((item, idx) => ({
    index: idx + 1,
    phone: item.phone,
    normalizedKey: item.normalizedKey,
  }));

  sendEvent({
    type: 'init',
    queue: indexedItems,
    skippedDuplicates: parsed.skippedDuplicates,
    skippedAlreadyProcessed: parsed.skippedAlreadyProcessed,
  });

  const parsedEnvDelay = Number(process.env.DELAY_SECONDS);
  const envDefaultDelayMs =
    Number.isFinite(parsedEnvDelay) && parsedEnvDelay >= 0 ? parsedEnvDelay * 1000 : undefined;
  const bodyDelayMs =
    typeof req.body?.delayMs === 'number' && Number.isFinite(req.body.delayMs) && req.body.delayMs >= 0
      ? req.body.delayMs
      : undefined;
  const delayBetweenRequestsMs = bodyDelayMs ?? envDefaultDelayMs;

  try {
    await runSequentialAutomation({
      targetUrl: urlCheck.normalizedUrl,
      items: indexedItems,
      signal: abortController.signal,
      delayBetweenRequestsMs,
      onUpdate: (update) => {
        sendEvent({
          type: update.status === 'processing' ? 'processing' : 'result',
          index: update.index,
          phone: update.phone,
          normalizedKey: update.normalizedKey,
          status: update.status,
          details: update.details,
          timestamp: update.timestamp,
        });
      },
    });
    sendEvent({ type: 'done' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'حدث خطأ أثناء تشغيل الأتمتة.';
    sendEvent({ type: 'error', message });
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }
});

async function startServer() {
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

startServer();
