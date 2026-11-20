import { useMemo, useRef, useState } from 'react';
import { AutomationForm } from './components/AutomationForm';
import { ResultsTable } from './components/ResultsTable';
import {
  parseAndDeduplicatePhones,
  validateTargetUrl,
  type AttemptRecord,
  type AutomationStreamEvent,
} from './utils/phoneQueue';

export default function App() {
  const [url, setUrl] = useState('');
  const [phonesText, setPhonesText] = useState('');
  const [attempts, setAttempts] = useState<AttemptRecord[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Track numbers already processed per normalized target URL to prevent re-processing the same number
  const processedByUrlRef = useRef<Map<string, Set<string>>>(new Map());
  const abortControllerRef = useRef<AbortController | null>(null);

  const normalizedUrlForLookup = useMemo(() => {
    const check = validateTargetUrl(url);
    return check.valid && check.normalizedUrl ? check.normalizedUrl : '';
  }, [url]);

  const parsedPreview = useMemo(() => {
    const existingSet = normalizedUrlForLookup
      ? processedByUrlRef.current.get(normalizedUrlForLookup) ?? new Set<string>()
      : new Set<string>();
    return parseAndDeduplicatePhones(phonesText, existingSet);
  }, [phonesText, normalizedUrlForLookup, attempts]);

  const handleStop = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsRunning(false);
    setAttempts((prev) =>
      prev.map((row) =>
        row.status === 'processing' || row.status === 'pending'
          ? {
              ...row,
              status: 'failed',
              details: 'تم إيقاف التشغيل يدويًا قبل اكتمال هذه المحاولة.',
            }
          : row,
      ),
    );
  };

  const handleStart = async () => {
    setValidationError(null);

    const urlCheck = validateTargetUrl(url);
    if (!urlCheck.valid || !urlCheck.normalizedUrl) {
      setValidationError(urlCheck.error || 'الرابط غير صالح.');
      return;
    }

    const targetUrl = urlCheck.normalizedUrl;
    const processedSet = processedByUrlRef.current.get(targetUrl) ?? new Set<string>();
    const parsed = parseAndDeduplicatePhones(phonesText, processedSet);

    if (parsed.queue.length === 0) {
      setValidationError(
        parsed.skippedAlreadyProcessed > 0
          ? 'جميع الأرقام المُدخلة تمت معالجتها مسبقًا لهذا الرابط.'
          : 'يرجى لصق رقم هاتف واحد على الأقل قبل بدء الإرسال.',
      );
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsRunning(true);

    const initialRows: AttemptRecord[] = parsed.queue.map((item, idx) => ({
      id: `${targetUrl}-${item.normalizedKey}-${Date.now()}-${idx}`,
      index: idx + 1,
      phone: item.phone,
      normalizedKey: item.normalizedKey,
      status: 'pending',
      details: 'في انتظار المعالجة',
      timestamp: '',
    }));
    setAttempts(initialRows);

    try {
      const response = await fetch('/api/automate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          url: targetUrl,
          phones: phonesText,
          alreadyProcessedKeys: Array.from(processedSet),
        }),
      });

      if (!response.ok || !response.body) {
        const errorBody = await response.json().catch(() => null);
        throw new Error(errorBody?.error || 'تعذر بدء تشغيل الأتمتة على الخادم.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          let event: AutomationStreamEvent;
          try {
            event = JSON.parse(trimmed) as AutomationStreamEvent;
          } catch {
            continue;
          }

          if (event.type === 'processing' || event.type === 'result') {
            if (event.type === 'result' && event.normalizedKey) {
              const setForUrl = processedByUrlRef.current.get(targetUrl) ?? new Set<string>();
              setForUrl.add(event.normalizedKey);
              processedByUrlRef.current.set(targetUrl, setForUrl);
            }

            setAttempts((prev) =>
              prev.map((row) =>
                row.index === event.index
                  ? {
                      ...row,
                      status: event.status ?? row.status,
                      details: event.details ?? row.details,
                      timestamp: event.timestamp ?? row.timestamp,
                    }
                  : row,
              ),
            );
          } else if (event.type === 'error') {
            setValidationError(event.message || 'حدث خطأ أثناء المعالجة.');
          }
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      const message =
        error instanceof Error ? error.message : 'تعذر الاتصال بخدمة الأتمتة.';
      setValidationError(message);
      setAttempts((prev) =>
        prev.map((row) =>
          row.status === 'pending' || row.status === 'processing'
            ? { ...row, status: 'failed', details: message }
            : row,
        ),
      );
    } finally {
      abortControllerRef.current = null;
      setIsRunning(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between gap-8">
          <h1 className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            أتمتة إرسال أرقام الهواتف
          </h1>
          <p className="text-sm text-slate-600 hidden sm:block truncate">
            أتمتة النماذج المصرح باستخدامها عبر Playwright بالتتابع
          </p>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          <div className="lg:col-span-4">
            <AutomationForm
              url={url}
              phonesText={phonesText}
              isRunning={isRunning}
              uniquePendingCount={parsedPreview.queue.length}
              skippedDuplicates={parsedPreview.skippedDuplicates}
              skippedAlreadyProcessed={parsedPreview.skippedAlreadyProcessed}
              validationError={validationError}
              onUrlChange={(value) => {
                setUrl(value);
                if (validationError) setValidationError(null);
              }}
              onPhonesChange={(value) => {
                setPhonesText(value);
                if (validationError) setValidationError(null);
              }}
              onStart={handleStart}
              onStop={handleStop}
            />
          </div>

          <div className="lg:col-span-8">
            <ResultsTable attempts={attempts} isRunning={isRunning} />
          </div>
        </div>
      </main>
    </div>
  );
}
