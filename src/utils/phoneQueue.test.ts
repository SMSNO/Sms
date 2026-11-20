import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REQUEST_INTERVAL_MS,
  detectVerificationGate,
  normalizePhoneKey,
  parseAndDeduplicatePhones,
  splitPhoneCountryCode,
  validateTargetUrl,
  waitWithAbort,
} from './phoneQueue.ts';

test('validateTargetUrl accepts valid http and https URLs', () => {
  const httpsRes = validateTargetUrl('  https://example.com/submit?lang=ar  ');
  assert.equal(httpsRes.valid, true);
  assert.equal(httpsRes.normalizedUrl, 'https://example.com/submit?lang=ar');

  const httpRes = validateTargetUrl('http://localhost:3000/test-form');
  assert.equal(httpRes.valid, true);
  assert.equal(httpRes.normalizedUrl, 'http://localhost:3000/test-form');
});

test('validateTargetUrl rejects empty, malformed, and non-http URLs', () => {
  assert.equal(validateTargetUrl('').valid, false);
  assert.equal(validateTargetUrl('   ').valid, false);
  assert.equal(validateTargetUrl('not-a-url').valid, false);
  assert.equal(validateTargetUrl('javascript:alert(1)').valid, false);
  assert.equal(validateTargetUrl('ftp://example.com/file').valid, false);
});

test('normalizePhoneKey strips separators while preserving leading +', () => {
  assert.equal(normalizePhoneKey(' +966 50-123 (4567) '), '+966501234567');
  assert.equal(normalizePhoneKey('050 123 4567'), '0501234567');
  assert.equal(normalizePhoneKey('   '), '');
});

test('parseAndDeduplicatePhones preserves order and removes duplicates within batch', () => {
  const input = `
    +966 50 111 2222
    +966501112222
    055-333-4444, 0553334444
    0598887777; +966501112222
  `;

  const parsed = parseAndDeduplicatePhones(input);
  assert.deepEqual(
    parsed.queue.map((item) => item.normalizedKey),
    ['+966501112222', '0553334444', '0598887777'],
  );
  assert.equal(parsed.skippedDuplicates, 3);
  assert.equal(parsed.skippedAlreadyProcessed, 0);
  assert.equal(parsed.totalInputTokens, 6);
});

test('parseAndDeduplicatePhones excludes previously processed numbers', () => {
  const alreadyProcessed = new Set(['0501234567', '+966559998888']);
  const input = '050 123 4567\n+966559998888\n0540001111';

  const parsed = parseAndDeduplicatePhones(input, alreadyProcessed);
  assert.deepEqual(
    parsed.queue.map((item) => item.normalizedKey),
    ['0540001111'],
  );
  assert.equal(parsed.skippedAlreadyProcessed, 2);
  assert.equal(parsed.skippedDuplicates, 0);
});

test('parseAndDeduplicatePhones splits flattened + and space-separated full numbers and ignores comments', () => {
  const input = [
    '# تعليق تجريبي',
    '+201208546652+201012345678 +966501234567',
    '01208546652 01122334455',
    '+20 120 854 6652',
  ].join('\n');

  const parsed = parseAndDeduplicatePhones(input);
  assert.deepEqual(
    parsed.queue.map((item) => item.normalizedKey),
    ['+201208546652', '+201012345678', '+966501234567', '01208546652', '01122334455'],
  );
  assert.equal(parsed.skippedDuplicates, 1);
});

test('parseAndDeduplicatePhones supports batches exceeding 300 phone numbers', () => {
  const lines = Array.from({ length: 350 }, (_, i) => `+20120${String(100000 + i)}`);
  const parsed = parseAndDeduplicatePhones(lines.join('\n'));
  assert.equal(parsed.queue.length, 350);
  assert.equal(parsed.queue[0].phone, '+20120100000');
  assert.equal(parsed.queue[349].phone, '+20120100349');
});

test('detectVerificationGate flags captcha widgets or verification text', () => {
  assert.equal(detectVerificationGate('Enter your phone number', false), false);
  assert.equal(detectVerificationGate('Enter your phone number', true), true);
  assert.equal(detectVerificationGate('Please verify you are human to continue', false), true);
  assert.equal(detectVerificationGate('Checking your browser before accessing', false), true);
});

test('splitPhoneCountryCode parses + and 00 international prefixes accurately', () => {
  assert.deepEqual(splitPhoneCountryCode('+201223189009'), {
    countryCode: '+20',
    dialDigits: '20',
    nationalNumber: '1223189009',
    preferredCountryName: undefined,
  });

  assert.deepEqual(splitPhoneCountryCode('00966 50 123 4567'), {
    countryCode: '+966',
    dialDigits: '966',
    nationalNumber: '501234567',
    preferredCountryName: undefined,
  });

  assert.deepEqual(splitPhoneCountryCode('+1 (415) 555-0199'), {
    countryCode: '+1',
    dialDigits: '1',
    nationalNumber: '4155550199',
    preferredCountryName: 'United States',
  });

  assert.deepEqual(splitPhoneCountryCode('01223189009'), {
    countryCode: null,
    dialDigits: null,
    nationalNumber: '01223189009',
  });
});

test('waitWithAbort defaults to 15s interval and resolves cleanly on completion or abort', async () => {
  assert.equal(DEFAULT_REQUEST_INTERVAL_MS, 15_000);

  const normalController = new AbortController();
  const completed = await waitWithAbort(20, normalController.signal);
  assert.equal(completed, true);

  const abortController = new AbortController();
  setTimeout(() => abortController.abort(), 15);
  const aborted = await waitWithAbort(5000, abortController.signal);
  assert.equal(aborted, false);
});
