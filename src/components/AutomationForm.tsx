import type { FormEvent } from 'react';
import { Play, Square } from 'lucide-react';

interface AutomationFormProps {
  url: string;
  phonesText: string;
  isRunning: boolean;
  uniquePendingCount: number;
  skippedDuplicates: number;
  skippedAlreadyProcessed: number;
  validationError: string | null;
  onUrlChange: (value: string) => void;
  onPhonesChange: (value: string) => void;
  onStart: () => void;
  onStop: () => void;
}

export function AutomationForm({
  url,
  phonesText,
  isRunning,
  uniquePendingCount,
  skippedDuplicates,
  skippedAlreadyProcessed,
  validationError,
  onUrlChange,
  onPhonesChange,
  onStart,
  onStop,
}: AutomationFormProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isRunning) {
      onStart();
    }
  };

  return (
    <section
      aria-labelledby="form-section-title"
      className="bg-white border border-slate-200 rounded-lg p-6"
    >
      <div className="mb-5">
        <h2 id="form-section-title" className="text-lg font-semibold text-slate-900">
          إعدادات الإرسال
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          أدخل رابط صفحة النموذج المصرح به وقائمة أرقام الهواتف للمعالجة بالتتابع.
        </p>
      </div>

      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        <div>
          <label
            htmlFor="target-url-input"
            className="block text-sm font-medium text-slate-800 mb-1.5"
          >
            رابط الصفحة
          </label>
          <input
            id="target-url-input"
            name="targetUrl"
            type="url"
            dir="ltr"
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            disabled={isRunning}
            placeholder="https://example.com/form"
            className="w-full rounded-md border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-mono text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/15 disabled:bg-slate-50 disabled:text-slate-500"
          />
        </div>

        <div>
          <label
            htmlFor="phone-list-input"
            className="block text-sm font-medium text-slate-800 mb-1.5"
          >
            قائمة أرقام الهواتف
          </label>
          <textarea
            id="phone-list-input"
            name="phoneList"
            rows={13}
            dir="ltr"
            value={phonesText}
            onChange={(e) => onPhonesChange(e.target.value)}
            disabled={isRunning}
            placeholder={'+966501234567\n+966559876543\n0541112233'}
            className="w-full min-h-[280px] rounded-md border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-mono text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/15 disabled:bg-slate-50 disabled:text-slate-500 resize-y"
          />
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600 tabular-nums">
            <span>أرقام جاهزة للمعالجة: {uniquePendingCount}</span>
            {skippedDuplicates > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>مكررة مستبعدة: {skippedDuplicates}</span>
              </>
            )}
            {skippedAlreadyProcessed > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>مُعالجة سابقًا: {skippedAlreadyProcessed}</span>
              </>
            )}
          </div>
        </div>

        {validationError && (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-800"
          >
            {validationError}
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            disabled={isRunning}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Play className="w-4 h-4" aria-hidden="true" />
            <span>{isRunning ? 'جاري المعالجة...' : 'بدء الإرسال'}</span>
          </button>

          {isRunning && (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Square className="w-4 h-4" aria-hidden="true" />
              <span>إيقاف</span>
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
