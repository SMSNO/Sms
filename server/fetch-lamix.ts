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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(response: Response, bodyText: string): number {
  const retryHeader = response.headers.get('retry-after');
  if (retryHeader && /^\d+(\.\d+)?$/.test(retryHeader.trim())) {
    return Math.min(15_000, Math.max(1_000, Math.ceil(Number(retryHeader.trim()) * 1000) + 300));
  }
  try {
    const parsed = JSON.parse(bodyText) as { retryAfterSeconds?: unknown; retry_after?: unknown };
    const secs = Number(parsed.retryAfterSeconds ?? parsed.retry_after);
    if (Number.isFinite(secs) && secs > 0) {
      return Math.min(15_000, Math.max(1_000, Math.ceil(secs * 1000) + 300));
    }
  } catch {
    // ignore JSON parse failure
  }
  return 1_500;
}

async function fetchJsonPage(
  pageUrl: string,
  token: string,
  lockedStrategy: AuthStrategy | null,
): Promise<{ payload: unknown; strategy: AuthStrategy }> {
  const strategies = lockedStrategy ? [lockedStrategy] : AUTH_STRATEGIES;
  let lastError = 'Unknown error';

  for (const strategy of strategies) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
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

      const bodyText = await response.text().catch(() => '');
      const bodySnippet = bodyText.slice(0, 160);
      lastError = `HTTP ${response.status} via ${strategy.name}: ${bodySnippet}`;

      if (response.status === 429 && attempt < 2) {
        const waitMs = parseRetryAfterMs(response, bodyText);
        console.log(`Lamix rate limit (429); waiting ${waitMs}ms as requested before retrying...`);
        await sleep(waitMs);
        continue;
      }

      // Retry with next auth header/query strategy only on authentication failures
      if (response.status !== 401 && response.status !== 403) {
        throw new Error(`Lamix API request failed (${lastError})`);
      }
      break;
    }
  }

  throw new Error(`Lamix API authentication failed (${lastError})`);
}

function buildPageUrl(baseUrl: string, pageNumber: number, limit: number, afterCursor?: string | null): string {
  const parsed = new URL(baseUrl);
  if (afterCursor) {
    parsed.searchParams.delete('page');
    parsed.searchParams.set('after', afterCursor);
  } else if (pageNumber > 1) {
    parsed.searchParams.set('page', String(pageNumber));
  }
  if (!parsed.searchParams.has('limit') && !parsed.searchParams.has('per_page')) {
    parsed.searchParams.set('limit', String(limit));
  }
  return parsed.toString();
}

async function fetchEndpointPhones(options: {
  endpointUrl: string;
  label: string;
  token: string;
  fetchAll: boolean;
  maxPages: number;
  pageLimit: number;
  existingKeys: ReadonlySet<string>;
  seenThisSync: Set<string>;
  allFetchedPhones: string[];
  lockedStrategy: AuthStrategy | null;
}): Promise<AuthStrategy | null> {
  const {
    endpointUrl,
    label,
    token,
    fetchAll,
    maxPages,
    pageLimit,
    existingKeys,
    seenThisSync,
    allFetchedPhones,
  } = options;
  let { lockedStrategy } = options;

  let nextUrl: string | null = buildPageUrl(endpointUrl, 1, pageLimit);
  let pageIndex = 1;
  let usedCursorPagination = false;
  const seenCursors = new Set<string>();

  while (nextUrl && pageIndex <= maxPages) {
    if (pageIndex > 1 || seenThisSync.size > 0) {
      await sleep(1_200);
    }
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
      `[${label}] Page ${pageIndex} (${strategy.name}): raw=${extracted.rawItemCount}, phones=${extracted.phones.length}, new=${newOnThisPage}, hasMore=${extracted.hasMore}, nextCursor=${extracted.nextCursor ?? 'none'}.`,
    );

    if (extracted.rawItemCount === 0 && extracted.phones.length === 0) {
      if (pageIndex === 1 && payload && typeof payload === 'object') {
        const rootObj = Array.isArray(payload) ? payload[0] : payload;
        const topKeys = rootObj && typeof rootObj === 'object' ? Object.keys(rootObj) : [];
        console.log(`[${label}] Schema hint (keys only): ${JSON.stringify(topKeys)}`);
      }
      break;
    }

    if (pageIndex > 1 && uniqueAddedThisPage === 0 && !extracted.nextCursor) {
      console.log(`[${label}] Stopping pagination: page ${pageIndex} yielded no new unique entries.`);
      break;
    }

    // Stop early on messages endpoint when incremental sync reaches already-stored numbers
    if (!fetchAll && !extracted.nextCursor && existingKeys.size > 0 && newOnThisPage === 0) {
      console.log(`[${label}] Incremental stop: page ${pageIndex} contains only existing numbers.`);
      break;
    }

    if (extracted.nextCursor) {
      usedCursorPagination = true;
      if (seenCursors.has(extracted.nextCursor)) {
        console.log(`[${label}] Stopping cursor pagination: cursor already visited.`);
        break;
      }
      seenCursors.add(extracted.nextCursor);
      nextUrl = buildPageUrl(endpointUrl, pageIndex + 1, pageLimit, extracted.nextCursor);
    } else if (usedCursorPagination) {
      nextUrl = null;
    } else if (extracted.nextUrl) {
      nextUrl = new URL(extracted.nextUrl, endpointUrl).toString();
    } else if (extracted.hasMore || extracted.rawItemCount >= pageLimit) {
      nextUrl = buildPageUrl(endpointUrl, pageIndex + 1, pageLimit);
    } else if (fetchAll && extracted.rawItemCount > 0 && !extracted.lastPage && !extracted.totalCount) {
      nextUrl = buildPageUrl(endpointUrl, pageIndex + 1, pageLimit);
    } else {
      nextUrl = null;
    }

    pageIndex += 1;
  }

  return lockedStrategy;
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

  const customApiUrl = (process.env.LAMIX_API_URL || '').trim();
  const phonesFilePath = path.resolve(process.cwd(), process.env.PHONES_FILE || 'phones.txt');
  const replaceMode = process.env.LAMIX_REPLACE === 'true';
  const fetchAll = process.env.LAMIX_FETCH_ALL === 'true' || replaceMode;
  const maxPages = Math.max(1, Number(process.env.LAMIX_MAX_PAGES || 100) || 100);
  const pageLimit = Math.max(10, Number(process.env.LAMIX_PAGE_LIMIT || 500) || 500);

  const existingContent = fs.existsSync(phonesFilePath)
    ? fs.readFileSync(phonesFilePath, 'utf8')
    : '';

  const baseContentForMerge = replaceMode ? '' : existingContent;
  const initialMerge = mergePhonesIntoList(baseContentForMerge, []);
  const existingKeys = new Set(initialMerge.mergedPhones.map((p) => normalizePhoneKey(p)));

  const endpoints = customApiUrl
    ? [{ url: customApiUrl, label: 'custom' }]
    : fetchAll
      ? [
          { url: 'https://panel.lamix.org/api/v1/messages', label: 'messages' },
          { url: 'https://panel.lamix.org/api/v1/numbers', label: 'numbers' },
        ]
      : [{ url: 'https://panel.lamix.org/api/v1/messages', label: 'messages' }];

  let lockedStrategy: AuthStrategy | null = null;
  const allFetchedPhones: string[] = [];
  const seenThisSync = new Set<string>();

  for (const endpoint of endpoints) {
    lockedStrategy = await fetchEndpointPhones({
      endpointUrl: endpoint.url,
      label: endpoint.label,
      token,
      fetchAll,
      maxPages,
      pageLimit,
      existingKeys,
      seenThisSync,
      allFetchedPhones,
      lockedStrategy,
    });
  }

  const result = mergePhonesIntoList(baseContentForMerge, allFetchedPhones, { newestFirst: true });

  if (result.updatedContent !== existingContent) {
    fs.writeFileSync(phonesFilePath, result.updatedContent, 'utf8');
  }

  console.log(
    `Lamix sync complete (${replaceMode ? 'replace' : 'merge'}) | Extracted: ${allFetchedPhones.length} | Newly added: ${result.addedPhones.length} | Total unique in ${path.basename(phonesFilePath)}: ${result.mergedPhones.length}`,
  );
}

main().catch((error) => {
  console.error('Lamix sync error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
