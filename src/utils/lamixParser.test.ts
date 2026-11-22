import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensurePlusPhone,
  extractLamixPayload,
  extractPhoneFromLamixItem,
  mergePhonesIntoList,
} from './lamixParser.ts';

test('ensurePlusPhone normalizes numbers with leading + and rejects non-phone strings', () => {
  assert.equal(ensurePlusPhone('59161356379'), '+59161356379');
  assert.equal(ensurePlusPhone('+20 120-854 (6652)'), '+201208546652');
  assert.equal(ensurePlusPhone('00966501234567'), '+966501234567');
  assert.equal(ensurePlusPhone('TikTok'), null);
  assert.equal(ensurePlusPhone('12345'), null);
});

test('extractPhoneFromLamixItem prioritizes recipient/phone fields over sender names', () => {
  assert.equal(
    extractPhoneFromLamixItem({
      id: 1,
      from: 'ServiceOTP',
      recipient: '201208546652',
      message: 'Your code is 123456',
    }),
    '+201208546652',
  );

  assert.equal(
    extractPhoneFromLamixItem({
      number: '59161356379',
      sender: 'Info',
    }),
    '+59161356379',
  );
});

test('extractLamixPayload supports flat arrays, nested data, and pagination metadata', () => {
  const flat = extractLamixPayload([
    { phone: '59161356379' },
    { to: '+201012345678' },
    { sender: 'BrandName' },
  ]);
  assert.deepEqual(flat.phones, ['+59161356379', '+201012345678']);
  assert.equal(flat.hasMore, false);

  const paginated = extractLamixPayload({
    data: {
      current_page: 1,
      last_page: 3,
      next_page_url: 'https://panel.lamix.org/api/v1/messages?page=2',
      data: [{ msisdn: '966501234567' }],
    },
  });
  assert.deepEqual(paginated.phones, ['+966501234567']);
  assert.equal(paginated.currentPage, 1);
  assert.equal(paginated.lastPage, 3);
  assert.equal(paginated.hasMore, true);
  assert.equal(paginated.nextUrl, 'https://panel.lamix.org/api/v1/messages?page=2');
});

test('mergePhonesIntoList adds only new unique numbers with + prefix and preserves existing entries', () => {
  const existing = '+59161356379\n59161356593\n';
  const fetched = ['59161356379', '+201208546652', '201208546652', '966501234567'];

  const merged = mergePhonesIntoList(existing, fetched);
  assert.deepEqual(merged.addedPhones, ['+201208546652', '+966501234567']);
  assert.deepEqual(merged.mergedPhones, [
    '+201208546652',
    '+966501234567',
    '+59161356379',
    '+59161356593',
  ]);
  assert.equal(merged.skippedDuplicates, 2);
  assert.equal(
    merged.updatedContent,
    '+201208546652\n+966501234567\n+59161356379\n+59161356593\n',
  );
});
