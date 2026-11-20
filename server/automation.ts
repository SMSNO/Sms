import fs from 'node:fs';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import {
  detectVerificationGate,
  type AttemptStatus,
} from '../src/utils/phoneQueue.ts';

export interface AutomationItem {
  index: number;
  phone: string;
  normalizedKey: string;
}

export interface AutomationUpdate {
  index: number;
  phone: string;
  normalizedKey: string;
  status: AttemptStatus;
  details: string;
  timestamp: string;
}

const CONTAINER_CHROMIUM_PATH =
  '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell';

function formatTimestamp(): string {
  const now = new Date();
  return now.toLocaleTimeString('en-GB', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

async function launchBrowser(): Promise<Browser> {
  const hasContainerBinary = fs.existsSync(CONTAINER_CHROMIUM_PATH);
  return chromium.launch({
    headless: true,
    ...(hasContainerBinary ? { executablePath: CONTAINER_CHROMIUM_PATH } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  });
}

async function findFirstVisibleLocator(
  candidates: Locator[],
  requiredTag?: 'INPUT' | 'BUTTON',
): Promise<Locator | null> {
  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const nth = candidate.nth(i);
      const visible = await nth.isVisible().catch(() => false);
      const enabled = await nth.isEnabled().catch(() => false);
      if (!visible || !enabled) {
        continue;
      }
      if (requiredTag) {
        const tagMatches = await nth
          .evaluate((el, tag) => {
            if (el.tagName !== tag) return false;
            if (tag === 'INPUT') {
              const t = (el as HTMLInputElement).type.toLowerCase();
              return !['hidden', 'submit', 'button', 'reset', 'checkbox', 'radio', 'file'].includes(t);
            }
            return true;
          }, requiredTag)
          .catch(() => false);
        if (!tagMatches) {
          continue;
        }
      }
      return nth;
    }
  }
  return null;
}

async function locatePhoneInput(page: Page): Promise<Locator | null> {
  const candidates: Locator[] = [
    page.locator('input[type="tel"]'),
    page.locator('input[autocomplete="tel"], input[autocomplete="tel-national"]'),
    page.locator(
      'input[name*="phone" i], input[name*="mobile" i], input[name*="tel" i], input[name*="msisdn" i]',
    ),
    page.locator('input[id*="phone" i], input[id*="mobile" i], input[id*="tel" i]'),
    page.locator(
      'input[placeholder*="phone" i], input[placeholder*="mobile" i], input[placeholder*="هاتف"], input[placeholder*="جوال"], input[placeholder*="موبايل"], input[placeholder*="رقم"]',
    ),
    page.getByRole('textbox', {
      name: /phone|mobile|tel|هاتف|جوال|موبايل|رقم/i,
    }),
    page.locator('form input[type="text"], form input:not([type])'),
    page.locator('input[type="text"], input:not([type])'),
  ];

  return findFirstVisibleLocator(candidates, 'INPUT');
}

async function locateSubmitButton(page: Page, phoneInput: Locator): Promise<Locator | null> {
  const parentForm = phoneInput.locator('xpath=ancestor::form[1]');
  const hasParentForm = (await parentForm.count().catch(() => 0)) > 0;
  const parentDialog = phoneInput.locator('xpath=ancestor::*[@role="dialog"][1]');
  const hasParentDialog = (await parentDialog.count().catch(() => 0)) > 0;

  const scope: Page | Locator = hasParentForm
    ? parentForm
    : hasParentDialog
      ? parentDialog
      : page;

  const candidates: Locator[] = [
    scope.locator('button[type="submit"], input[type="submit"]'),
    scope.getByRole('button', {
      name: /submit|send|continue|next|confirm|إرسال|ارسال|متابعة|تأكيد|حفظ/i,
    }),
    scope.locator('button:not([type="button"]):not([type="reset"])'),
    scope.locator('button'),
  ];

  const foundInScope = await findFirstVisibleLocator(candidates);
  if (foundInScope) {
    return foundInScope;
  }

  if (hasParentForm || hasParentDialog) {
    return findFirstVisibleLocator([
      page.locator('button[type="submit"], input[type="submit"]'),
      page.getByRole('button', {
        name: /submit|send|continue|next|confirm|إرسال|ارسال|متابعة|تأكيد/i,
      }),
    ]);
  }

  return null;
}

async function waitForPhoneInput(page: Page, timeoutMs = 6000): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const input = await locatePhoneInput(page);
    if (input) {
      return input;
    }
    await page.waitForTimeout(300);
  }
  return locatePhoneInput(page);
}

async function waitForSubmitButton(
  page: Page,
  phoneInput: Locator,
  timeoutMs = 2000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const button = await locateSubmitButton(page, phoneInput);
    if (button) {
      return button;
    }
    await page.waitForTimeout(200);
  }
  return locateSubmitButton(page, phoneInput);
}

async function checkPageForVerificationGate(page: Page): Promise<boolean> {
  const captchaSelectors = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="challenges.cloudflare.com"]',
    '.g-recaptcha',
    '.h-captcha',
    '.cf-turnstile',
  ].join(', ');

  const hasWidget = (await page.locator(captchaSelectors).count().catch(() => 0)) > 0;
  const bodyText = await page
    .locator('body')
    .innerText()
    .catch(() => '');

  return detectVerificationGate(bodyText, hasWidget);
}

async function processSingleNumber(
  page: Page,
  targetUrl: string,
  phone: string,
): Promise<{ status: 'success' | 'failed'; details: string }> {
  const httpErrors: Array<{ status: number; host: string }> = [];

  const ignoredTrackerHosts = [
    'google-analytics.com',
    'googletagmanager.com',
    'doubleclick.net',
    'facebook.net',
    'connect.facebook.net',
    'sentry.io',
    'datadoghq.com',
    'amplitude.com',
    'segment.io',
    'branch.io',
    'appsflyer.com',
  ];

  const responseListener = (response: { url: () => string; status: () => number; request: () => { method: () => string } }) => {
    const status = response.status();
    const method = response.request().method();
    if (status >= 400 && (method === 'POST' || method === 'PUT' || response.url() === targetUrl)) {
      let host = '';
      try {
        host = new URL(response.url()).hostname;
      } catch {
        host = '';
      }
      if (host && ignoredTrackerHosts.some((ignored) => host.endsWith(ignored))) {
        return;
      }
      httpErrors.push({ status, host });
    }
  };

  page.on('response', responseListener);

  try {
    const navResponse = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    if (navResponse && navResponse.status() >= 400) {
      return {
        status: 'failed',
        details: `تعذر فتح الصفحة (رمز الاستجابة ${navResponse.status()})`,
      };
    }

    // Wait for client-rendered SPA forms to hydrate before checking
    await page.waitForLoadState('networkidle', { timeout: 3500 }).catch(() => undefined);

    if (await checkPageForVerificationGate(page)) {
      return {
        status: 'failed',
        details: 'تحتوي الصفحة على نظام تحقق أمني؛ لا يقوم النظام بتجاوز قيود المواقع.',
      };
    }

    const phoneInput = await waitForPhoneInput(page, 6000);
    if (!phoneInput) {
      return {
        status: 'failed',
        details: 'تعذر العثور على خانة إدخال رقم الهاتف داخل الصفحة.',
      };
    }

    await phoneInput.click({ timeout: 5000 });
    await phoneInput.fill(phone, { timeout: 5000 });

    const submitButton = await waitForSubmitButton(page, phoneInput, 2000);
    if (!submitButton) {
      return {
        status: 'failed',
        details: 'تعذر العثور على زر إرسال مفعّل بعد إدخال الرقم (قد يرفض النموذج صيغة الرقم أو يتطلب اختيار رمز الدولة).',
      };
    }

    httpErrors.length = 0;
    const submitResponsePromise = page
      .waitForResponse(
        (response) =>
          response.request().method() !== 'GET' ||
          response.url() !== targetUrl,
        { timeout: 3500 },
      )
      .catch(() => null);

    await submitButton.click({ timeout: 5000 });

    // Wait for form submission response or client-side validation settle
    await Promise.race([submitResponsePromise, page.waitForTimeout(1500)]);
    await page.waitForTimeout(350);
    await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => undefined);

    // Check native HTML5 validation state if form stayed on page
    const isInputInvalid = await phoneInput
      .evaluate((el) => {
        if (el instanceof HTMLInputElement) {
          return !el.checkValidity();
        }
        return false;
      })
      .catch(() => false);

    if (isInputInvalid) {
      const validationMsg = await phoneInput
        .evaluate((el) => (el instanceof HTMLInputElement ? el.validationMessage : ''))
        .catch(() => '');
      return {
        status: 'failed',
        details: validationMsg
          ? `رفض النموذج صيغة الرقم: ${validationMsg}`
          : 'رفض النموذج صيغة رقم الهاتف.',
      };
    }

    // Inspect explicit alert / error feedback on the page before HTTP fallback
    const errorLocator = page
      .locator('[role="alert"]:not([aria-label*="Privacy" i]):not([aria-label*="Cookie" i]), .error-message, .form-error, [aria-invalid="true"]')
      .first();
    if ((await errorLocator.count().catch(() => 0)) > 0) {
      const visible = await errorLocator.isVisible().catch(() => false);
      if (visible) {
        const errorText = (await errorLocator.innerText().catch(() => '')).trim();
        if (errorText) {
          return {
            status: 'failed',
            details: errorText.slice(0, 180),
          };
        }
      }
    }

    const lastErr = httpErrors.at(-1);
    if (lastErr) {
      return {
        status: 'failed',
        details: lastErr.host
          ? `رفض الخادم الطلب (رمز ${lastErr.status} - ${lastErr.host}).`
          : `فشل إرسال الطلب من الخادم (رمز ${lastErr.status}).`,
      };
    }

    if (await checkPageForVerificationGate(page)) {
      return {
        status: 'failed',
        details: 'ظهر نظام تحقق أمني بعد الإرسال؛ توقفت المحاولة دون تجاوز.',
      };
    }

    const successLocator = page
      .locator('[data-status="success"], .success-message, [role="status"]')
      .first();
    if ((await successLocator.count().catch(() => 0)) > 0) {
      const visible = await successLocator.isVisible().catch(() => false);
      if (visible) {
        const successText = (await successLocator.innerText().catch(() => '')).trim();
        if (successText) {
          return {
            status: 'success',
            details: successText.slice(0, 180),
          };
        }
      }
    }

    return {
      status: 'success',
      details: 'تم إدخال الرقم والضغط على زر الإرسال بنجاح.',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'خطأ غير متوقع أثناء التشغيل';
    return {
      status: 'failed',
      details: `تعذر إتمام المحاولة: ${message.slice(0, 160)}`,
    };
  } finally {
    page.off('response', responseListener);
  }
}

export async function runSequentialAutomation(options: {
  targetUrl: string;
  items: AutomationItem[];
  signal: AbortSignal;
  onUpdate: (update: AutomationUpdate) => void;
}): Promise<void> {
  const { targetUrl, items, signal, onUpdate } = options;
  const processedInRun = new Set<string>();
  let browser: Browser | null = null;

  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    for (const item of items) {
      if (signal.aborted) {
        break;
      }

      if (processedInRun.has(item.normalizedKey)) {
        continue;
      }
      processedInRun.add(item.normalizedKey);

      onUpdate({
        index: item.index,
        phone: item.phone,
        normalizedKey: item.normalizedKey,
        status: 'processing',
        details: 'جاري فتح الصفحة وإرسال الرقم...',
        timestamp: formatTimestamp(),
      });

      const outcome = await processSingleNumber(page, targetUrl, item.phone);

      if (signal.aborted) {
        break;
      }

      onUpdate({
        index: item.index,
        phone: item.phone,
        normalizedKey: item.normalizedKey,
        status: outcome.status,
        details: outcome.details,
        timestamp: formatTimestamp(),
      });
    }

    await context.close().catch(() => undefined);
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}
