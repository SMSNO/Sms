import fs from 'node:fs';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import {
  DEFAULT_REQUEST_INTERVAL_MS,
  detectVerificationGate,
  splitPhoneCountryCode,
  waitWithAbort,
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

const NON_PHONE_INPUT_PATTERN =
  /search|query|keyword|filter|email|mail|user\s*name|password|passcode|otp|pin|captcha|coupon|promo|بحث|بريد|كلمة\s*المرور|رمز\s*التحقق/i;

async function isPlausibleGenericPhoneInput(locator: Locator): Promise<boolean> {
  return locator
    .evaluate((el, patternSource) => {
      const re = new RegExp(patternSource, 'i');
      if (el.closest('[role="search"], form[role="search"]')) return false;
      const attrs = [
        el.getAttribute('name') || '',
        el.getAttribute('id') || '',
        el.getAttribute('placeholder') || '',
        el.getAttribute('aria-label') || '',
        el.getAttribute('autocomplete') || '',
        el.getAttribute('data-testid') || '',
      ].join(' ');
      return !re.test(attrs);
    }, NON_PHONE_INPUT_PATTERN.source)
    .catch(() => true);
}

async function locatePhoneInput(page: Page, strictOnly = false): Promise<Locator | null> {
  const strictCandidates: Locator[] = [
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
  ];

  const strictMatch = await findFirstVisibleLocator(strictCandidates, 'INPUT');
  if (strictMatch || strictOnly) {
    return strictMatch;
  }

  const genericCandidates: Locator[] = [
    page.locator('form input[type="text"], form input:not([type])'),
    page.locator('input[type="text"], input:not([type])'),
  ];

  for (const candidate of genericCandidates) {
    const count = await candidate.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const nth = candidate.nth(i);
      const visible = await nth.isVisible().catch(() => false);
      const enabled = await nth.isEnabled().catch(() => false);
      if (!visible || !enabled) continue;
      if (await isPlausibleGenericPhoneInput(nth)) {
        return nth;
      }
    }
  }

  return null;
}

async function isActionElementUsable(locator: Locator): Promise<boolean> {
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) return false;
  const enabled = await locator.isEnabled().catch(() => false);
  if (!enabled) return false;

  return locator
    .evaluate((el) => {
      if (el.getAttribute('aria-disabled') === 'true') return false;
      if (el.hasAttribute('disabled')) return false;
      const style = window.getComputedStyle(el);
      if (style.pointerEvents === 'none' || style.visibility === 'hidden') return false;
      return true;
    })
    .catch(() => false);
}

const NON_SUBMIT_BUTTON_PATTERN =
  /^(close|back|cancel|clear|reset|skip|dismiss|decline|reject|accept all|menu|help|forgot|reset password|إغلاق|اغلاق|رجوع|عودة|إلغاء|الغاء|مسح|تخطي|رفض|قبول الكل|نسيت)$/i;

const EXCLUDED_ACTION_CONTEXT_PATTERN =
  /country|dial|calling\s*code|cookie|privacy|terms|policy|google|facebook|apple|twitter|microsoft|github|kakao|wechat|line\b|qr\s*code|passkey|forgot\s*password|use\s*email|use\s*username|الدولة|رمز الدولة|الخصوصية|ملفات تعريف|جوجل|فيسبوك|أبل|نسيت كلمة|بريد إلكتروني|اسم المستخدم/i;

const COUNTRY_CODE_TEXT_PATTERN = /^(?:[A-Z]{2}\s*)?\+\d{1,4}$/;

async function isExcludedNonSubmitButton(locator: Locator): Promise<boolean> {
  const meta = await locator
    .evaluate((el) => {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();
      const title = (el.getAttribute('title') || '').trim();
      const dataE2e = (el.getAttribute('data-e2e') || '').trim();
      const type = (el.getAttribute('type') || '').toLowerCase();
      return { text, aria, title, dataE2e, type };
    })
    .catch(() => ({ text: '', aria: '', title: '', dataE2e: '', type: '' }));

  if (meta.type === 'reset') return true;
  if (meta.text && COUNTRY_CODE_TEXT_PATTERN.test(meta.text)) return true;

  const combined = `${meta.text} ${meta.aria} ${meta.title} ${meta.dataE2e}`.trim();
  if (meta.text && NON_SUBMIT_BUTTON_PATTERN.test(meta.text)) return true;
  if (meta.aria && NON_SUBMIT_BUTTON_PATTERN.test(meta.aria)) return true;
  if (combined && EXCLUDED_ACTION_CONTEXT_PATTERN.test(combined)) return true;

  return false;
}

const ACTION_BUTTON_NAME_PATTERN =
  /submit|send(\s*code)?|get\s*code|request\s*code|resend|verify|otp|continue|next|proceed|confirm|save|done|ok|go|start|log\s*in|login|sign\s*in|signin|sign\s*up|signup|register|إرسال(\s*الرمز)?|ارسال(\s*الرمز)?|أرسل(\s*الرمز)?|ارسل(\s*الرمز)?|طلب الرمز|الحصول على الرمز|متابعة|المتابعة|مواصلة|المواصلة|التالي|التالى|تأكيد|حفظ|تسجيل\s*الدخول|تسجيل|دخول|استمرار|موافق|ابدأ|تحقق/i;

async function findFirstActionButtonInScope(
  scope: Page | Locator,
  phoneInputBox: { y: number } | null,
): Promise<Locator | null> {
  const prioritizedCandidates: Locator[] = [
    scope.locator('button[type="submit"], input[type="submit"]'),
    scope.getByRole('button', { name: ACTION_BUTTON_NAME_PATTERN }),
    scope
      .locator('button, [role="button"], input[type="button"], a[role="button"]')
      .filter({ hasText: ACTION_BUTTON_NAME_PATTERN }),
  ];

  for (const candidate of prioritizedCandidates) {
    const count = await candidate.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const nth = candidate.nth(i);
      if (!(await isActionElementUsable(nth))) continue;
      if (await isExcludedNonSubmitButton(nth)) continue;
      return nth;
    }
  }

  // Fallback: pick any usable button/role="button" (preferring buttons positioned at or below the phone input)
  const anyButtons = scope.locator(
    'button, [role="button"], input[type="button"], input[type="submit"], a[role="button"]',
  );
  const total = await anyButtons.count().catch(() => 0);
  const belowOrInline: Locator[] = [];
  const above: Locator[] = [];

  for (let i = 0; i < total; i += 1) {
    const nth = anyButtons.nth(i);
    if (!(await isActionElementUsable(nth))) continue;
    if (await isExcludedNonSubmitButton(nth)) continue;

    if (phoneInputBox) {
      const box = await nth.boundingBox().catch(() => null);
      if (box && box.y >= phoneInputBox.y - 16) {
        belowOrInline.push(nth);
      } else {
        above.push(nth);
      }
    } else {
      belowOrInline.push(nth);
    }
  }

  return belowOrInline[0] ?? above[0] ?? null;
}

async function locateSubmitButton(page: Page, phoneInput: Locator): Promise<Locator | null> {
  const parentForm = phoneInput.locator('xpath=ancestor::form[1]');
  const hasParentForm = (await parentForm.count().catch(() => 0)) > 0;
  const parentDialog = phoneInput.locator('xpath=ancestor::*[@role="dialog"][1]');
  const hasParentDialog = (await parentDialog.count().catch(() => 0)) > 0;
  const phoneInputBox = await phoneInput.boundingBox().catch(() => null);

  const scopes: Array<Page | Locator> = [];
  if (hasParentForm) scopes.push(parentForm);
  if (hasParentDialog) scopes.push(parentDialog);
  scopes.push(page);

  for (const scope of scopes) {
    const found = await findFirstActionButtonInScope(scope, phoneInputBox);
    if (found) {
      return found;
    }
  }

  return null;
}

async function waitForPhoneInput(
  page: Page,
  timeoutMs = 6000,
  strictOnly = false,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const input = await locatePhoneInput(page, strictOnly);
    if (input) {
      return input;
    }
    await page.waitForTimeout(300);
  }
  return locatePhoneInput(page, strictOnly);
}

async function waitForSubmitButton(
  page: Page,
  phoneInput: Locator,
  timeoutMs = 3500,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const button = await locateSubmitButton(page, phoneInput);
    if (button) {
      return button;
    }
    await page.waitForTimeout(250);
  }
  return locateSubmitButton(page, phoneInput);
}

const LOGIN_ENTRY_PATTERN =
  /^(log\s*in|login|sign\s*in|signin|log\s*in\s*\/\s*sign\s*up|sign\s*in\s*\/\s*sign\s*up|تسجيل\s*(ال)?دخول|دخول|تسجيل|حسابي|get\s*started|continue\s*with\s*phone|use\s*phone(\s*number)?|phone\s*login)$/i;

const PHONE_LOGIN_HINT_PATTERN =
  /(phone|mobile|sms|otp|هاتف|جوال|موبايل)/i;

const LOGIN_TEXT_FALLBACK_PATTERN =
  /(log\s*in|sign\s*in|تسجيل\s*(ال)?دخول|برقم\s*الهاتف|رقم\s*الهاتف)/i;

const LOGIN_EXCLUDE_PATTERN =
  /log\s*out|sign\s*out|تسجيل\s*الخروج|خروج|google|facebook|apple|twitter|microsoft|github|email|mail|بريد|cookie|privacy|سياسة|خصوصية|forgot|نسيت/i;

async function findLoginTrigger(
  page: Page,
  allowFallbackText = false,
  skipSignatures?: ReadonlySet<string>,
): Promise<{ locator: Locator; signature: string } | null> {
  const candidates = page.locator(
    'a, button, [role="button"], input[type="button"], input[type="submit"]',
  );
  const count = await candidates.count().catch(() => 0);

  let exactMatch: { locator: Locator; signature: string } | null = null;
  let fallbackMatch: { locator: Locator; signature: string } | null = null;

  for (let i = 0; i < count; i += 1) {
    const nth = candidates.nth(i);
    if (!(await isActionElementUsable(nth))) continue;

    const meta = await nth
      .evaluate((el) => {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const aria = (el.getAttribute('aria-label') || '').trim();
        const title = (el.getAttribute('title') || '').trim();
        const href = (el.getAttribute('href') || '').trim();
        return { text, aria, title, href };
      })
      .catch(() => ({ text: '', aria: '', title: '', href: '' }));

    const combined = `${meta.text} ${meta.aria} ${meta.title}`.trim();
    if (!combined && !meta.href) continue;
    if (LOGIN_EXCLUDE_PATTERN.test(combined) && !PHONE_LOGIN_HINT_PATTERN.test(combined)) continue;

    const signature = `${meta.text}|${meta.aria}|${meta.href}`;
    if (skipSignatures?.has(signature)) continue;

    const isExactLogin =
      (meta.text && LOGIN_ENTRY_PATTERN.test(meta.text)) ||
      (meta.aria && LOGIN_ENTRY_PATTERN.test(meta.aria));

    if (isExactLogin) {
      if (PHONE_LOGIN_HINT_PATTERN.test(combined)) {
        return { locator: nth, signature };
      }
      if (!exactMatch) {
        exactMatch = { locator: nth, signature };
      }
      continue;
    }

    if (
      !fallbackMatch &&
      allowFallbackText &&
      (LOGIN_TEXT_FALLBACK_PATTERN.test(combined) || /\/(login|signin|auth)\b/i.test(meta.href))
    ) {
      fallbackMatch = { locator: nth, signature };
    }
  }

  return exactMatch ?? fallbackMatch;
}

async function openLoginEntryIfNeeded(page: Page): Promise<boolean> {
  let clickedAny = false;
  const clickedSignatures = new Set<string>();

  for (let step = 0; step < 2; step += 1) {
    const triggerMatch =
      (await findLoginTrigger(page, false, clickedSignatures)) ??
      (await findLoginTrigger(page, true, clickedSignatures));
    if (!triggerMatch) {
      break;
    }

    clickedSignatures.add(triggerMatch.signature);
    await triggerMatch.locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await triggerMatch.locator.click({ timeout: 5000 }).catch(() => undefined);
    clickedAny = true;

    await page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => undefined);
    await page.waitForTimeout(450);

    const inputAfterClick = await waitForPhoneInput(page, 2500);
    if (inputAfterClick) {
      return true;
    }
  }

  return clickedAny;
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

  const candidateScopes: Array<Page | Locator> = [];
  if (hasParentForm) candidateScopes.push(parentForm);
  if (hasParentDialog) candidateScopes.push(parentDialog);
  candidateScopes.push(page);

  const exactDialRegex = new RegExp(`(?:^|\\D)\\+${dialDigits}(?:\\D|$)`);

  // 1) Native <select> country-code dropdown across scopes
  for (const scope of candidateScopes) {
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
  }

  // 2) intl-tel-input flag dropdown (.iti__selected-flag / .iti__selected-country)
  for (const scope of candidateScopes) {
    const itiButton = scope
      .locator('.iti__selected-country, .iti__selected-flag, .iti__flag-container button')
      .first();
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
  }

  // 3) Custom country-code picker button / combobox
  let countryBtn: Locator | null = null;
  for (const scope of candidateScopes) {
    const countryBtnCandidates: Locator[] = [
      scope.locator(
        'button[aria-label*="country" i], button[aria-label*="dial" i], button[aria-label*="code" i], button[aria-label*="الدولة"], [role="button"][aria-label*="country" i], [role="button"][aria-label*="dial" i], [role="combobox"][aria-label*="country" i], button[data-testid*="country" i], [role="button"][data-testid*="country" i], [role="combobox"][data-testid*="country" i]',
      ),
      scope.locator('button, [role="button"], [role="combobox"]').filter({ hasText: /\+\d{1,3}\b/ }),
      scope.locator('div[class*="country" i], div[class*="dial" i], span[class*="country" i], span[class*="dial" i]').filter({
        hasText: /^\s*(?:[A-Z]{2}\s*)?\+\d{1,4}\s*$/,
      }),
    ];

    for (const candidate of countryBtnCandidates) {
      const count = await candidate.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const nth = candidate.nth(i);
        if (!(await nth.isVisible().catch(() => false)) || !(await nth.isEnabled().catch(() => false))) {
          continue;
        }
        const labelAndText = `${await nth.getAttribute('aria-label').catch(() => '') || ''} ${await nth.innerText().catch(() => '')}`.trim();
        if (/^(close|back|next|submit|send|إغلاق|رجوع|التالي|إرسال)$/i.test(labelAndText)) {
          continue;
        }
        countryBtn = nth;
        break;
      }
      if (countryBtn) break;
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
    const attrOptions = root.locator(
      `[data-dial-code="${dialDigits}"], [data-code="+${dialDigits}"], [data-country-code="${dialDigits}"]`,
    );
    const attrCount = await attrOptions.count().catch(() => 0);
    let attrFallback: Locator | null = null;
    for (let i = 0; i < attrCount; i += 1) {
      const opt = attrOptions.nth(i);
      if (!(await opt.isVisible().catch(() => false))) continue;
      const text = (await opt.innerText().catch(() => '')).trim();
      if (preferredCountryName && text.toLowerCase().includes(preferredCountryName.toLowerCase())) {
        return opt;
      }
      if (!attrFallback) {
        attrFallback = opt;
      }
    }
    if (attrFallback) {
      return attrFallback;
    }

    for (const selector of [
      'button, [role="option"], [role="menuitem"]',
      'li',
      'div[class*="country" i], div[class*="option" i]',
    ]) {
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
    const searchQueries = preferredCountryName
      ? [preferredCountryName, countryCode]
      : [countryCode];

    for (const query of searchQueries) {
      for (const root of searchScopes) {
        const searchInput = root
          .locator(
            'input[type="search"], input[name*="search" i], input[placeholder*="search" i], input[aria-label*="search" i], input[placeholder*="بحث"]',
          )
          .first();
        if ((await searchInput.count().catch(() => 0)) > 0 && (await searchInput.isVisible().catch(() => false))) {
          await searchInput.fill(query, { timeout: 2000 }).catch(() => undefined);
          await page.waitForTimeout(250);
          matchedOption = await findCountryOption();
          if (matchedOption) break;
        }
      }
      if (matchedOption) break;
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

    let phoneInput = await waitForPhoneInput(page, 2500, true);
    if (!phoneInput) {
      const navigatedLogin = await openLoginEntryIfNeeded(page);
      if (navigatedLogin) {
        if (await checkPageForVerificationGate(page)) {
          return {
            status: 'failed',
            details: 'تحتوي الصفحة على نظام تحقق أمني؛ لا يقوم النظام بتجاوز قيود المواقع.',
          };
        }
        phoneInput = await waitForPhoneInput(page, 4000, false);
      } else {
        phoneInput = await waitForPhoneInput(page, 1000, false);
      }
    }

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

    let submitButton = await waitForSubmitButton(page, activePhoneInput, 1200);
    if (!submitButton) {
      // Some React/SPA masked inputs only enable the action button on real key events
      await activePhoneInput.fill('', { timeout: 3000 }).catch(() => undefined);
      await activePhoneInput.pressSequentially(valueToFill, { delay: 30 }).catch(() => undefined);
      submitButton = await waitForSubmitButton(page, activePhoneInput, 2500);
    }

    if (!submitButton) {
      return {
        status: 'failed',
        details: 'تعذر العثور على زر إجراء مفعّل بعد إدخال الرقم (قد يرفض النموذج صيغة الرقم أو يتطلب اختيار رمز الدولة أو إكمال خطوة إضافية).',
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
  delayBetweenRequestsMs?: number;
  onUpdate: (update: AutomationUpdate) => void;
}): Promise<void> {
  const {
    targetUrl,
    items,
    signal,
    delayBetweenRequestsMs = DEFAULT_REQUEST_INTERVAL_MS,
    onUpdate,
  } = options;
  const processedInRun = new Set<string>();
  let browser: Browser | null = null;
  let hasAttemptedPrevious = false;

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

      if (hasAttemptedPrevious && delayBetweenRequestsMs > 0) {
        const delaySeconds = Math.round(delayBetweenRequestsMs / 1000);
        onUpdate({
          index: item.index,
          phone: item.phone,
          normalizedKey: item.normalizedKey,
          status: 'processing',
          details: `في انتظار الفاصل الزمني (${delaySeconds} ثانية) قبل الإرسال...`,
          timestamp: formatTimestamp(),
        });

        const completedWait = await waitWithAbort(delayBetweenRequestsMs, signal);
        if (!completedWait || signal.aborted) {
          break;
        }
      }

      hasAttemptedPrevious = true;

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
