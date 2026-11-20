export type AttemptStatus = 'pending' | 'processing' | 'success' | 'failed';

export interface AttemptRecord {
  id: string;
  index: number;
  phone: string;
  normalizedKey: string;
  status: AttemptStatus;
  details: string;
  timestamp: string;
}

export interface UrlValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  error?: string;
}

export interface ParsedPhoneQueue {
  queue: Array<{ phone: string; normalizedKey: string }>;
  skippedDuplicates: number;
  skippedAlreadyProcessed: number;
  totalInputTokens: number;
}

export interface AutomationStreamEvent {
  type: 'init' | 'processing' | 'result' | 'done' | 'error';
  index?: number;
  phone?: string;
  normalizedKey?: string;
  status?: AttemptStatus;
  details?: string;
  timestamp?: string;
  message?: string;
  queue?: Array<{ index: number; phone: string; normalizedKey: string }>;
  skippedDuplicates?: number;
  skippedAlreadyProcessed?: number;
}

/**
 * Validates that the user-supplied target page URL is a well-formed HTTP or HTTPS URL.
 */
export function validateTargetUrl(rawUrl: string): UrlValidationResult {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return {
      valid: false,
      error: 'يرجى إدخال رابط الصفحة المستهدفة.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      error: 'الرابط المُدخل غير صالح. تأكد من كتابة الرابط كاملاً مثل https://example.com/form',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      valid: false,
      error: 'يجب أن يبدأ الرابط ببروتوكول http:// أو https:// فقط.',
    };
  }

  return {
    valid: true,
    normalizedUrl: parsed.toString(),
  };
}

/**
 * Normalizes a phone number string into a canonical comparison key
 * so formatting differences like spaces or dashes do not cause re-processing.
 */
export function normalizePhoneKey(rawPhone: string): string {
  const trimmed = rawPhone.trim();
  // Keep leading + if present, strip spaces, dashes, parentheses, and dots
  const hasPlus = trimmed.startsWith('+');
  const cleaned = trimmed.replace(/[\s\-().]/g, '');
  if (!cleaned) {
    return '';
  }
  return hasPlus && !cleaned.startsWith('+') ? `+${cleaned}` : cleaned;
}

/**
 * Parses pasted phone numbers (newline, comma, or semicolon separated),
 * preserves original order, deduplicates within the list, and excludes any
 * number present in alreadyProcessedKeys.
 */
export function parseAndDeduplicatePhones(
  rawInput: string,
  alreadyProcessedKeys: ReadonlySet<string> = new Set(),
): ParsedPhoneQueue {
  const tokens = rawInput
    .split(/[\r\n,;]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const seenInBatch = new Set<string>();
  const queue: Array<{ phone: string; normalizedKey: string }> = [];
  let skippedDuplicates = 0;
  let skippedAlreadyProcessed = 0;

  for (const token of tokens) {
    const normalizedKey = normalizePhoneKey(token);
    if (!normalizedKey) {
      continue;
    }

    if (seenInBatch.has(normalizedKey)) {
      skippedDuplicates += 1;
      continue;
    }

    if (alreadyProcessedKeys.has(normalizedKey)) {
      skippedAlreadyProcessed += 1;
      continue;
    }

    seenInBatch.add(normalizedKey);
    queue.push({
      phone: token,
      normalizedKey,
    });
  }

  return {
    queue,
    skippedDuplicates,
    skippedAlreadyProcessed,
    totalInputTokens: tokens.length,
  };
}

/**
 * Detects whether a target page presents a CAPTCHA or automated access gate.
 * The system strictly refuses to bypass security or verification challenges.
 */
export function detectVerificationGate(pageText: string, hasCaptchaWidget: boolean): boolean {
  if (hasCaptchaWidget) {
    return true;
  }

  const normalized = pageText.toLowerCase();
  const verificationPatterns = [
    'i am not a robot',
    "i'm not a robot",
    'verify you are human',
    'checking your browser',
    'g-recaptcha',
    'hcaptcha',
    'cf-turnstile',
    'أثبت أنك لست روبوت',
    'التحقق الأمني',
  ];

  return verificationPatterns.some((pattern) => normalized.includes(pattern));
}
