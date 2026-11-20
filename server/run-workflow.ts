import fs from 'node:fs';
import path from 'node:path';
import { runSequentialAutomation, type AutomationUpdate } from './automation.ts';
import { parseAndDeduplicatePhones, validateTargetUrl } from '../src/utils/phoneQueue.ts';

function statusLabel(status: AutomationUpdate['status']): string {
  switch (status) {
    case 'success':
      return 'نجح (Success)';
    case 'failed':
      return 'فشل (Failed)';
    case 'processing':
      return 'جاري الإرسال';
    default:
      return 'قيد الانتظار';
  }
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

async function main() {
  const rawUrl = (process.env.TARGET_URL || '').trim();
  let rawPhones = (process.env.PHONE_NUMBERS || '').trim();
  let phoneSource = 'workflow input';

  if (!rawPhones) {
    const phonesFilePath = path.resolve(process.cwd(), process.env.PHONES_FILE || 'phones.txt');
    if (fs.existsSync(phonesFilePath)) {
      rawPhones = fs.readFileSync(phonesFilePath, 'utf8').trim();
      phoneSource = path.basename(phonesFilePath);
    }
  }

  const urlCheck = validateTargetUrl(rawUrl);
  if (!urlCheck.valid || !urlCheck.normalizedUrl) {
    console.error(`Invalid TARGET_URL: ${urlCheck.error}`);
    process.exit(1);
  }

  const parsed = parseAndDeduplicatePhones(rawPhones);
  if (parsed.queue.length === 0) {
    console.error(
      'No phone numbers provided. Enter numbers in phone_numbers or add them line-by-line to phones.txt.',
    );
    process.exit(1);
  }

  const rawDelaySeconds = process.env.DELAY_SECONDS;
  const parsedDelaySeconds = rawDelaySeconds !== undefined ? Number(rawDelaySeconds) : 60;
  const delaySeconds =
    Number.isFinite(parsedDelaySeconds) && parsedDelaySeconds >= 0 ? parsedDelaySeconds : 60;
  const delayMs = delaySeconds * 1000;

  console.log(`Target URL: ${urlCheck.normalizedUrl}`);
  console.log(
    `Source: ${phoneSource} | Processing ${parsed.queue.length} unique numbers (skipped duplicates: ${parsed.skippedDuplicates}) | Interval: ${delaySeconds}s`,
  );

  const items = parsed.queue.map((item, idx) => ({
    index: idx + 1,
    phone: item.phone,
    normalizedKey: item.normalizedKey,
  }));

  const results = new Map<number, AutomationUpdate>();
  const abortController = new AbortController();

  try {
    await runSequentialAutomation({
      targetUrl: urlCheck.normalizedUrl,
      items,
      signal: abortController.signal,
      delayBetweenRequestsMs: delayMs,
      onUpdate: (update) => {
        if (update.status === 'processing' && update.details.includes('الفاصل الزمني')) {
          console.log(
            `[${update.index}/${items.length}] ${update.phone} -> Waiting ${delaySeconds}s before next request (${update.timestamp})`,
          );
          return;
        }
        if (update.status === 'success' || update.status === 'failed') {
          results.set(update.index, update);
          console.log(
            `[${update.index}/${items.length}] ${update.phone} -> ${statusLabel(update.status)} | ${update.details} (${update.timestamp})`,
          );
        }
      },
    });
  } finally {
    const rows = items.map((item) => {
      const res = results.get(item.index);
      return {
        index: item.index,
        phone: item.phone,
        status: res ? statusLabel(res.status) : 'فشل (Failed)',
        details: res?.details || 'لم تكتمل المحاولة',
        timestamp: res?.timestamp || '-',
      };
    });

    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
      const successCount = Array.from(results.values()).filter((r) => r.status === 'success').length;
      const failedCount = rows.length - successCount;

      const markdownLines = [
        '## نتائج أتمتة إرسال أرقام الهواتف',
        '',
        `- **الرابط:** ${urlCheck.normalizedUrl}`,
        `- **المصدر:** ${phoneSource}`,
        `- **الإجمالي:** ${rows.length} | **نجح:** ${successCount} | **فشل:** ${failedCount} | **مكررة مستبعدة:** ${parsed.skippedDuplicates}`,
        '',
        '| # | رقم الهاتف | الحالة | التفاصيل | الوقت |',
        '| --- | --- | --- | --- | --- |',
        ...rows.map(
          (r) =>
            `| ${r.index} | \`${escapeMarkdownCell(r.phone)}\` | ${escapeMarkdownCell(r.status)} | ${escapeMarkdownCell(r.details)} | ${escapeMarkdownCell(r.timestamp)} |`,
        ),
        '',
      ];

      fs.appendFileSync(summaryPath, markdownLines.join('\n'), 'utf8');
    }
  }
}

main().catch((err) => {
  console.error('Workflow automation error:', err);
  process.exit(1);
});
