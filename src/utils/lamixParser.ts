import { normalizePhoneKey } from './phoneQueue.ts';

export interface LamixExtractedPage {
  phones: string[];
  rawItemCount: number;
  nextUrl: string | null;
  nextCursor: string | null;
  currentPage: number | null;
  lastPage: number | null;
  totalCount: number | null;
  perPage: number | null;
  hasMore: boolean;
}

export interface MergePhonesResult {
  addedPhones: string[];
  mergedPhones: string[];
  updatedContent: string;
  existingCount: number;
  skippedDuplicates: number;
}

/**
 * Ensures a phone value is normalized with a leading '+' and contains 7..16 digits.
 * Returns null for non-phone strings (such as alphanumeric sender IDs or short codes).
 */
export function ensurePlusPhone(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return null;
  }

  const trimmed = String(raw).trim();
  if (!trimmed) {
    return null;
  }

  let compact = trimmed.replace(/[\s\-().]/g, '');
  if (!compact) {
    return null;
  }

  if (compact.startsWith('00') && compact.length > 4) {
    compact = `+${compact.slice(2)}`;
  } else if (!compact.startsWith('+')) {
    compact = `+${compact}`;
  }

  if (!/^\+\d{7,16}$/.test(compact)) {
    return null;
  }

  return compact;
}

const PHONE_FIELD_PRIORITY = [
  'recipient',
  'recipient_number',
  'to',
  'to_number',
  'phone',
  'phone_number',
  'phone_no',
  'phonenumber',
  'msisdn',
  'number',
  'did',
  'receiver',
  'destination',
  'dst',
  'mobile',
  'tel',
  'target',
  'caller',
  'from',
];

export function extractPhoneFromLamixItem(item: unknown): string | null {
  if (typeof item === 'string' || typeof item === 'number') {
    return ensurePlusPhone(item);
  }

  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return null;
  }

  const record = item as Record<string, unknown>;
  for (const key of PHONE_FIELD_PRIORITY) {
    const val = record[key];
    if (val === undefined || val === null) {
      continue;
    }

    if (typeof val === 'string' || typeof val === 'number') {
      const normalized = ensurePlusPhone(val);
      if (normalized) {
        return normalized;
      }
    } else if (typeof val === 'object' && !Array.isArray(val)) {
      const nested = extractPhoneFromLamixItem(val);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

function asPositiveInt(val: unknown): number | null {
  if (typeof val === 'number' && Number.isInteger(val) && val > 0) {
    return val;
  }
  if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
    const parsed = Number(val.trim());
    return parsed > 0 ? parsed : null;
  }
  return null;
}

export function extractLamixPayload(payload: unknown): LamixExtractedPage {
  let rawItems: unknown[] = [];
  let nextUrl: string | null = null;
  let nextCursor: string | null = null;
  let currentPage: number | null = null;
  let lastPage: number | null = null;
  let totalCount: number | null = null;
  let perPage: number | null = null;
  let hasMore = false;

  if (Array.isArray(payload)) {
    rawItems = payload;
  } else if (payload && typeof payload === 'object') {
    const root = payload as Record<string, unknown>;

    // Check common container keys including nested Laravel pagination (data.data)
    const nestedData =
      root.data && typeof root.data === 'object' && !Array.isArray(root.data)
        ? (root.data as Record<string, unknown>)
        : null;

    const candidates = [
      root.messages,
      root.data,
      nestedData?.data,
      nestedData?.messages,
      root.items,
      root.results,
      root.records,
      root.numbers,
    ];

    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        rawItems = candidate;
        break;
      }
    }

    const metaSources: Array<Record<string, unknown>> = [
      root,
      ...(nestedData ? [nestedData] : []),
      ...(root.meta && typeof root.meta === 'object' ? [root.meta as Record<string, unknown>] : []),
      ...(root.pagination && typeof root.pagination === 'object'
        ? [root.pagination as Record<string, unknown>]
        : []),
      ...(root.links && typeof root.links === 'object' ? [root.links as Record<string, unknown>] : []),
    ];

    for (const src of metaSources) {
      if (!nextUrl && typeof src.next_page_url === 'string' && src.next_page_url) {
        nextUrl = src.next_page_url;
      }
      if (!nextUrl && typeof src.next === 'string' && src.next) {
        nextUrl = src.next;
      }
      if (!nextUrl && typeof src.next_page === 'string' && /^https?:|^\/|\?/.test(src.next_page)) {
        nextUrl = src.next_page;
      }
      if (!currentPage) {
        currentPage = asPositiveInt(src.current_page ?? src.page ?? src.currentPage);
      }
      if (!lastPage) {
        lastPage = asPositiveInt(src.last_page ?? src.total_pages ?? src.totalPages ?? src.pages);
      }
      if (!totalCount) {
        totalCount = asPositiveInt(src.total ?? src.total_items ?? src.totalItems ?? src.total_count ?? src.totalCount);
      }
      if (!perPage) {
        perPage = asPositiveInt(src.per_page ?? src.perPage ?? src.page_size ?? src.pageSize ?? src.limit);
      }
      const rawCursor = src.nextCursor ?? src.next_cursor;
      if (!nextCursor && (typeof rawCursor === 'string' || typeof rawCursor === 'number')) {
        const cursorStr = String(rawCursor).trim();
        if (cursorStr) {
          nextCursor = cursorStr;
        }
      }
      if (
        (typeof src.has_more === 'boolean' && src.has_more) ||
        (typeof src.hasMore === 'boolean' && src.hasMore) ||
        (typeof src.has_next === 'boolean' && src.has_next) ||
        (typeof src.hasNext === 'boolean' && src.hasNext) ||
        (typeof src.has_next_page === 'boolean' && src.has_next_page) ||
        (typeof src.hasNextPage === 'boolean' && src.hasNextPage)
      ) {
        hasMore = true;
      }
    }

    if (nextUrl || nextCursor) {
      hasMore = true;
    } else if (currentPage && lastPage && currentPage < lastPage) {
      hasMore = true;
    } else if (totalCount && perPage && (currentPage ?? 1) * perPage < totalCount) {
      hasMore = true;
    }
  }

  const phones: string[] = [];
  for (const item of rawItems) {
    const phone = extractPhoneFromLamixItem(item);
    if (phone) {
      phones.push(phone);
    }
  }

  return {
    phones,
    rawItemCount: rawItems.length,
    nextUrl,
    nextCursor,
    currentPage,
    lastPage,
    totalCount,
    perPage,
    hasMore,
  };
}

/**
 * Merges newly fetched numbers with existing phones.txt lines without duplicating any number.
 * Ensures all numbers carry a leading '+' prefix and places newly added numbers first by default.
 */
export function mergePhonesIntoList(
  existingContent: string,
  fetchedPhones: string[],
  options: { newestFirst?: boolean } = {},
): MergePhonesResult {
  const { newestFirst = true } = options;
  const seenKeys = new Set<string>();
  const existingPhones: string[] = [];

  for (const rawLine of existingContent.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const normalized = ensurePlusPhone(trimmed) || normalizePhoneKey(trimmed);
    const key = normalizePhoneKey(normalized);
    if (!key || seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    existingPhones.push(normalized);
  }

  const addedPhones: string[] = [];
  let skippedDuplicates = 0;

  for (const candidate of fetchedPhones) {
    const normalized = ensurePlusPhone(candidate);
    if (!normalized) {
      continue;
    }
    const key = normalizePhoneKey(normalized);
    if (seenKeys.has(key)) {
      skippedDuplicates += 1;
      continue;
    }
    seenKeys.add(key);
    addedPhones.push(normalized);
  }

  const mergedPhones = newestFirst
    ? [...addedPhones, ...existingPhones]
    : [...existingPhones, ...addedPhones];

  const updatedContent = mergedPhones.length > 0 ? `${mergedPhones.join('\n')}\n` : '';

  return {
    addedPhones,
    mergedPhones,
    updatedContent,
    existingCount: existingPhones.length,
    skippedDuplicates,
  };
}
