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

export interface ParsedCountryPhone {
  countryCode: string | null;
  dialDigits: string | null;
  nationalNumber: string;
  preferredCountryName?: string;
}

// Standard ITU-T E.164 prefix-free calling codes (longest-first lookup)
const E164_CALLING_CODES = new Set([
  // 1-digit
  '1', '7',
  // 2-digit
  '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44',
  '45', '46', '47', '48', '49', '51', '52', '53', '54', '55', '56', '57', '58',
  '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86', '90', '91',
  '92', '93', '94', '95', '98',
  // 3-digit
  '211', '212', '213', '216', '218', '220', '221', '222', '223', '224', '225',
  '226', '227', '228', '229', '230', '231', '232', '233', '234', '235', '236',
  '237', '238', '239', '240', '241', '242', '243', '244', '245', '246', '247',
  '248', '249', '250', '251', '252', '253', '254', '255', '256', '257', '258',
  '260', '261', '262', '263', '264', '265', '266', '267', '268', '269', '290',
  '291', '297', '298', '299', '350', '351', '352', '353', '354', '355', '356',
  '357', '358', '359', '370', '371', '372', '373', '374', '375', '376', '377',
  '378', '379', '380', '381', '382', '383', '385', '386', '387', '389', '420',
  '421', '423', '500', '501', '502', '503', '504', '505', '506', '507', '508',
  '509', '590', '591', '592', '593', '594', '595', '596', '597', '598', '599',
  '670', '672', '673', '674', '675', '676', '677', '678', '679', '680', '681',
  '682', '683', '685', '686', '687', '688', '689', '690', '691', '692', '850',
  '852', '853', '855', '856', '880', '886', '960', '961', '962', '963', '964',
  '965', '966', '967', '968', '970', '971', '972', '973', '974', '975', '976',
  '977', '992', '993', '994', '995', '996', '998',
]);

const PREFERRED_COUNTRY_BY_DIAL: Record<string, string> = {
  '1': 'United States',
  '7': 'Russia',
  '44': 'United Kingdom',
  '47': 'Norway',
  '61': 'Australia',
  '212': 'Morocco',
  '262': 'Réunion',
  '358': 'Finland',
};

/**
 * Splits an international phone number (starting with + or 00) into its E.164
 * country code and national subscriber number. Returns null countryCode if the
 * input does not specify an international prefix.
 */
export function splitPhoneCountryCode(rawPhone: string): ParsedCountryPhone {
  const compact = rawPhone.trim().replace(/[\s\-().]/g, '');
  let digitsAfterPrefix: string | null = null;

  if (compact.startsWith('+')) {
    digitsAfterPrefix = compact.slice(1);
  } else if (compact.startsWith('00') && compact.length > 4) {
    digitsAfterPrefix = compact.slice(2);
  }

  if (!digitsAfterPrefix || !/^\d+$/.test(digitsAfterPrefix)) {
    return {
      countryCode: null,
      dialDigits: null,
      nationalNumber: rawPhone.trim(),
    };
  }

  for (const len of [3, 2, 1]) {
    if (digitsAfterPrefix.length > len) {
      const candidate = digitsAfterPrefix.slice(0, len);
      if (E164_CALLING_CODES.has(candidate)) {
        return {
          countryCode: `+${candidate}`,
          dialDigits: candidate,
          nationalNumber: digitsAfterPrefix.slice(len),
          preferredCountryName: PREFERRED_COUNTRY_BY_DIAL[candidate],
        };
      }
    }
  }

  return {
    countryCode: null,
    dialDigits: null,
    nationalNumber: rawPhone.trim(),
  };
}

