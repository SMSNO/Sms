import fs from 'node:fs';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import {
  detectVerificationGate,
  splitPhoneCountryCode,
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

async function selectCountryCodeIfPresent(
  page: Page,
  phoneInput: Locator,
  countryCode: string,
  dialDigits: string,
  preferredCountryName?: string,
): Promise<boolean> {
  const parentForm = phoneInput.locator('xpath=ancestor::form[1]');
  const hasParentForm = (await parentForm.count().catch(() => 0)) > 0;
  const parentDialog = phoneInput.locator('xpath=ancestor::*[@role="dialog"][1]');
  const hasParentDialog = (await parentDialog.count().catch(() => 0)) > 0;
  const scope: Page | Locator = hasParentForm
    ? parentForm
    : hasParentDialog
      ? parentDialog
      : page;

  const exactDialRegex = new RegExp(`(?:^|\\D)\\+${dialDigits}(?:\\D|$)`);

  // 1) Native <select> country-code dropdown inside scope
  const selects = scope.locator('select');
  const selectCount = await selects.count().catch(() => 0);
  for (let i = 0; i < selectCount; i += 1) {
    const select = selects.nth(i);
    if (!(await select.isVisible().catch(() => false))) continue;

    const chosenValue = await select
      .evaluate(
        (el, args) => {
          const sel = el as HTMLSelectElement;
          const regex = new RegExp(`(?:^|\\D)\\+${args.dialDigits}(?:\\D|$)`);
          const matches: Array<{ value: string; text: string }> = [];
          for (const opt of Array.from(sel.options)) {
            const label = `${opt.textContent || ''} ${opt.value || ''}`;
            if (regex.test(label) || opt.value === `+${args.dialDigits}` || opt.value === args.dialDigits) {
              matches.push({ value: opt.value, text: opt.textContent || '' });
            }
          }
          if (matches.length === 0) return null;
          if (args.preferredName) {
            const pref = matches.find((m) =>
              m.text.toLowerCase().includes(args.preferredName!.toLowerCase()),
            );
            if (pref) return pref.value;
          }
          return matches[0].value;
        },
        { dialDigits, preferredName: preferredCountryName ?? null },
      )
      .catch(() => null);

    if (chosenValue !== null) {
      await select.selectOption(chosenValue).catch(() => undefined);
      return true;
    }
  }

  // 2) intl-tel-input flag dropdown (.iti__selected-flag)
  const itiButton = scope.locator('.iti__selected-flag, .iti__flag-container button').first();
  if ((await itiButton.count().catch(() => 0)) > 0 && (await itiButton.isVisible().catch(() => false))) {
    const currentText = (await itiButton.innerText().catch(() => '')).trim();
    if (exactDialRegex.test(currentText)) {
      return true;
    }
    await itiButton.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(200);
    const countryOption = page.locator(`.iti__country[data-dial-code="${dialDigits}"]`).first();
    if ((await countryOption.count().catch(() => 0)) > 0) {
      await countryOption.click({ timeout: 3000 }).catch(() => undefined);
      return true;
    }
  }

  // 3) Custom country-code picker button (e.g. button[aria-label*="country"] or button with +XX)
  const countryBtnCandidates: Locator[] = [
    scope.locator(
      'button[aria-label*="country" i], button[aria-label*="dial" i], button[aria-label*="code" i], button[aria-label*="الدولة"]',
    ),
    scope.locator('button').filter({ hasText: /\+\d{1,3}\b/ }),
  ];

  let countryBtn: Locator | null = null;
  for (const candidate of countryBtnCandidates) {
    const count = await candidate.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const nth = candidate.nth(i);
      if (!(await nth.isVisible().catch(() => false)) || !(await nth.isEnabled().catch(() => false))) {
        continue;
      }
      const labelAndText = `${await nth.getAttribute('aria-label').catch(() => '') || ''} ${await nth.innerText().catch(() => '')}`.trim();
      if (/^(close|back|next|submit|إغلاق|رجوع|التالي)$/i.test(labelAndText)) {
        continue;
      }
      countryBtn = nth;
      break;
    }
    if (countryBtn) break;
  }

  if (!countryBtn) {
    return false;
  }

  const currentBtnText = (await countryBtn.innerText().catch(() => '')).trim();
  if (exactDialRegex.test(currentBtnText)) {
    return true;
  }

  await countryBtn.click({ timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(300);

  // Do NOT anchor searchScope to phoneInput because opening the country list may unmount phoneInput.
  const activeDialog = page.locator('[role="dialog"]').last();
  const hasVisibleDialog =
    (await activeDialog.count().catch(() => 0)) > 0 &&
    (await activeDialog.isVisible().catch(() => false));
  const searchScopes: Array<Page | Locator> = hasVisibleDialog ? [activeDialog, page] : [page];

  const findCountryOptionIn = async (root: Page | Locator): Promise<Locator | null> => {
    for (const selector of ['button, [role="option"], [role="menuitem"]', 'li']) {
      const filtered = root.locator(selector).filter({ hasText: exactDialRegex });
      const optCount = await filtered.count().catch(() => 0);
      let fallbackMatch: Locator | null = null;

      for (let i = 0; i < optCount; i += 1) {
        const opt = filtered.nth(i);
        const visible = await opt.isVisible().catch(() => false);
        if (!visible) continue;
        const text = (await opt.innerText().catch(() => '')).trim();
        if (!text || !exactDialRegex.test(text)) continue;

        // Skip giant container nodes that bundle multiple country codes
        const codeMatches = text.match(/\+\d{1,3}/g);
        if (codeMatches && codeMatches.length > 2) continue;

        if (preferredCountryName && text.toLowerCase().includes(preferredCountryName.toLowerCase())) {
          return opt;
        }

        if (!fallbackMatch) {
          fallbackMatch = opt;
        }
      }

      if (fallbackMatch) {
        return fallbackMatch;
      }
    }
    return null;
  };

  const findCountryOption = async (): Promise<Locator | null> => {
    for (const root of searchScopes) {
      const found = await findCountryOptionIn(root);
      if (found) return found;
    }
    return null;
  };

  let matchedOption = await findCountryOption();

  if (!matchedOption) {
    for (const root of searchScopes) {
      const searchInput = root
        .locator(
          'input[type="search"], input[name*="search" i], input[placeholder*="search" i], input[aria-label*="search" i], input[placeholder*="بحث"]',
        )
        .first();
      if ((await searchInput.count().catch(() => 0)) > 0 && (await searchInput.isVisible().catch(() => false))) {
        const searchQuery = preferredCountryName || countryCode;
        await searchInput.fill(searchQuery, { timeout: 2000 }).catch(() => undefined);
        await page.waitForTimeout(250);
        matchedOption = await findCountryOption();
        if (matchedOption) break;
      }
    }
  }

  if (matchedOption) {
    await matchedOption.scrollIntoViewIfNeeded().catch(() => undefined);
    await matchedOption.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(300);
    return true;
  }

  return false;
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

    const parsedPhone = splitPhoneCountryCode(phone);
    let activePhoneInput = phoneInput;
    let valueToFill = phone;

    if (parsedPhone.countryCode && parsedPhone.dialDigits) {
      const countryHandled = await selectCountryCodeIfPresent(
        page,
        phoneInput,
        parsedPhone.countryCode,
        parsedPhone.dialDigits,
        parsedPhone.preferredCountryName,
      );
      if (countryHandled) {
        valueToFill = parsedPhone.nationalNumber;
        const refreshed = await waitForPhoneInput(page, 4000);
        if (!refreshed) {
          return {
            status: 'failed',
            details: `تم اختيار كود الدولة (${parsedPhone.countryCode}) لكن تعذر العودة إلى خانة إدخال رقم الهاتف.`,
          };
        }
        activePhoneInput = refreshed;
      } else if (!(await activePhoneInput.isVisible().catch(() => false))) {
        const refreshed = await waitForPhoneInput(page, 2000);
        if (!refreshed) {
          return {
            status: 'failed',
            details: `تعذر تحديد كود الدولة (${parsedPhone.countryCode}) في قائمة الصفحة.`,
          };
        }
        activePhoneInput = refreshed;
      }
    }

    await activePhoneInput.click({ timeout: 5000 });
    await activePhoneInput.fill(valueToFill, { timeout: 5000 });

    const submitButton = await waitForSubmitButton(page, activePhoneInput, 2000);
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
    const isInputInvalid = await activePhoneInput
      .evaluate((el) => {
        if (el instanceof HTMLInputElement) {
          return !el.checkValidity();
        }
        return false;
      })
      .catch(() => false);

    if (isInputInvalid) {
      const validationMsg = await activePhoneInput
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
      const hostSuffix = lastErr.host ? ` - ${lastErr.host}` : '';
      if (lastErr.status === 429) {
        return {
          status: 'failed',
          details: `رفض الخادم الطلب لتجاوز حد المحاولات المسموح به (رمز 429${hostSuffix}).`,
        };
      }
      if (lastErr.status === 403) {
        return {
          status: 'failed',
          details: `رفض الخادم الطلب لعدم توفر الصلاحية أو لقيود الحماية على الخادم (رمز 403${hostSuffix}).`,
        };
      }
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
        details: 'جاري فتح الصفحة في جلسة مستقلة وإرسال الرقم...',
        timestamp: formatTimestamp(),
      });

      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
      });
      let outcome: { status: 'success' | 'failed'; details: string };
      try {
        const page = await context.newPage();
        outcome = await processSingleNumber(page, targetUrl, item.phone);
      } finally {
        await context.close().catch(() => undefined);
      }

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
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}
