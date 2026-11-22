import fs from 'node:fs';
import path from 'node:path';
import { extractLamixPayload, mergePhonesIntoList } from '../src/utils/lamixParser.ts';
import { normalizePhoneKey } from '../src/utils/phoneQueue.ts';

interface AuthStrategy {
  name: string;
  buildRequest: (baseUrl: string, token: string) => { url: string; headers: Record<string, string> };
}

const AUTH_STRATEGIES: AuthStrategy[] = [
  {
    name: 'bearer',
    buildRequest: (baseUrl, token) => ({
      url: baseUrl,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    }),
  },
  {
    name: 'x-api-key',
    buildRequest: (baseUrl, token) => ({
      url: baseUrl,
      headers: {
        Accept: 'application/json',
        'X-API-Key': token,
      },
    }),
  },
  {
    name: 'raw-authorization',
    buildRequest: (baseUrl, token) => ({
      url: baseUrl,
      headers: {
        Accept: 'application/json',
        Authorization: token,
      },
    }),
  },
  {
    name: 'query-token',
    buildRequest: (baseUrl, token) => {
      const parsed = new URL(baseUrl);
      parsed.searchParams.set('token', token);
      return {
        url: parsed.toString(),
        headers: { Accept: 'application/json' },
      };
    },
  },
  {
    name: 'query-api-key',
    buildRequest: (baseUrl, token) => {
      const parsed = new URL(baseUrl);
      parsed.searchParams.set('api_key', token);
      return {
        url: parsed.toString(),
        headers: { Accept: 'application/json' },
      };
    },
  },
];

function sanitizeUrlForLog(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    for (const key of ['token', 'api_key', 'apikey', 'key']) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, '***');
      }
    }
    return parsed.toString();
  } catch {
    return 'https://panel.lamix.org/api/v1/messages';
  }
}

async function fetchJsonPage(
  pageUrl: string,
  token: string,
  lockedStrategy: AuthStrategy | null,
): Promise<{ payload: unknown; strategy: AuthStrategy }> {
  const strategies = lockedStrategy ? [lockedStrategy] : AUTH_STRATEGIES;
  let lastError = 'Unknown error';

  for (const strategy of strategies) {
    const { url, headers } = strategy.buildRequest(pageUrl, token);
    const response = await fetch(url, { headers });

    if (response.ok) {
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json') && !contentType.includes('+json')) {
        const textSample = (await response.text()).slice(0, 120);
        throw new Error(
          `Expected JSON from ${sanitizeUrlForLog(pageUrl)} but received "${contentType}" (${textSample})`,
        );
      }
      const payload = await response.json();
      return { payload, strategy };
    }

    const bodySnippet = (await response.text().catch(() => '')).slice(0, 160);
    lastError = `HTTP ${response.status} via ${strategy.name}: ${bodySnippet}`;

    // Retry with next auth header/query strategy only on authentication failures
    if (response.status !== 401 && response.status !== 403) {
      throw new Error(`Lamix API request failed (${lastError})`);
    }
  }

  throw new Error(`Lamix API authentication failed (${lastError})`);
}

function buildPageUrl(baseUrl: string, pageNumber: number, limit: number): string {
  const parsed = new URL(baseUrl);
  if (pageNumber > 1) {
    parsed.searchParams.set('page', String(pageNumber));
  }
  if (!parsed.searchParams.has('limit') && !parsed.searchParams.has('per_page')) {
    parsed.searchParams.set('limit', String(limit));
  }
  return parsed.toString();
}

async function main() {
  const token = (process.env.LAMIX || process.env.LAMIX_API_KEY || '').trim();
  if (!token) {
    if (process.env.REQUIRE_LAMIX === 'true') {
      console.error('LAMIX secret is missing.');
      process.exit(1);
    }
    console.log('LAMIX secret not configured; skipping API fetch.');
    return;
  }

  const baseUrl = (process.env.LAMIX_API_URL || 'https://panel.lamix.org/api/v1/messages').trim();
  const phonesFilePath = path.resolve(process.cwd(), process.env.PHONES_FILE || 'phones.txt');
  const fetchAll = process.env.LAMIX_FETCH_ALL === 'true';
  const maxPages = Math.max(1, Number(process.env.LAMIX_MAX_PAGES || 100) || 100);
  const pageLimit = Math.max(10, Number(process.env.LAMIX_PAGE_LIMIT || 100) || 100);

  const existingContent = fs.existsSync(phonesFilePath)
    ? fs.readFileSync(phonesFilePath, 'utf8')
    : '';

  const initialMerge = mergePhonesIntoList(existingContent, []);
  const existingKeys = new Set(initialMerge.mergedPhones.map((p) => normalizePhoneKey(p)));

  let lockedStrategy: AuthStrategy | null = null;
  let nextUrl: string | null = buildPageUrl(baseUrl, 1, pageLimit);
  let pageIndex = 1;
  const allFetchedPhones: string[] = [];
  const seenThisSync = new Set<string>();

  while (nextUrl && pageIndex <= maxPages) {
    const { payload, strategy } = await fetchJsonPage(nextUrl, token, lockedStrategy);
    lockedStrategy = strategy;

    const extracted = extractLamixPayload(payload);
    let newOnThisPage = 0;
    let uniqueAddedThisPage = 0;

    for (const phone of extracted.phones) {
      const key = normalizePhoneKey(phone);
      if (!seenThisSync.has(key)) {
        seenThisSync.add(key);
        allFetchedPhones.push(phone);
        uniqueAddedThisPage += 1;
      }
      if (!existingKeys.has(key)) {
        newOnThisPage += 1;
      }
    }

    console.log(
      `Page ${pageIndex} (${strategy.name}): raw=${extracted.rawItemCount}, phones=${extracted.phones.length}, new=${newOnThisPage}, hasMore=${extracted.hasMore}, page=${extracted.currentPage ?? '?'}/${extracted.lastPage ?? '?'}, total=${extracted.totalCount ?? '?'}, perPage=${extracted.perPage ?? '?'}.`,
    );

    if (extracted.rawItemCount === 0 && extracted.phones.length === 0) {
      if (pageIndex === 1 && payload && typeof payload === 'object') {
        const rootObj = Array.isArray(payload) ? payload[0] : payload;
        const topKeys = rootObj && typeof rootObj === 'object' ? Object.keys(rootObj) : [];
        console.log(`Schema hint (keys only): ${JSON.stringify(topKeys)}`);
      }
      break;
    }

    if (pageIndex > 1 && uniqueAddedThisPage === 0) {
      console.log(`Stopping pagination: page ${pageIndex} yielded no new unique entries.`);
      break;
    }

    // Stop early when incremental sync reaches a page with only already-stored numbers
    if (!fetchAll && existingKeys.size > 0 && newOnThisPage === 0) {
      console.log(`Incremental stop: page ${pageIndex} contains only existing numbers.`);
      break;
    }

    if (extracted.nextUrl) {
      nextUrl = new URL(extracted.nextUrl, baseUrl).toString();
    } else if (extracted.hasMore || extracted.rawItemCount >= pageLimit) {
      nextUrl = buildPageUrl(baseUrl, pageIndex + 1, pageLimit);
    } else if (fetchAll && extracted.rawItemCount > 0 && !extracted.lastPage && !extracted.totalCount) {
      // Probe next page when API omits pagination metadata during full sync (stops on empty or repeated page)
      nextUrl = buildPageUrl(baseUrl, pageIndex + 1, pageLimit);
    } else {
      nextUrl = null;
    }

    pageIndex += 1;
  }

  const result = mergePhonesIntoList(existingContent, allFetchedPhones, { newestFirst: true });

  if (result.updatedContent !== existingContent) {
    fs.writeFileSync(phonesFilePath, result.updatedContent, 'utf8');
  }

  console.log(
    `Lamix sync complete | Extracted: ${allFetchedPhones.length} | Newly added: ${result.addedPhones.length} | Total unique in ${path.basename(phonesFilePath)}: ${result.mergedPhones.length}`,
  );
}

main().catch((error) => {
  console.error('Lamix sync error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
