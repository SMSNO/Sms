import { AlertCircle, CheckCircle2, Clock, Loader2 } from 'lucide-react';
import type { AttemptRecord, AttemptStatus } from '../utils/phoneQueue';

interface ResultsTableProps {
  attempts: AttemptRecord[];
  isRunning: boolean;
}

function StatusCell({ status }: { status: AttemptStatus }) {
  switch (status) {
    case 'success':
      return (
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 whitespace-nowrap">
          <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>نجح</span>
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-red-700 whitespace-nowrap">
          <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>فشل</span>
        </span>
      );
    case 'processing':
      return (
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 whitespace-nowrap">
          <Loader2 className="w-4 h-4 shrink-0 animate-spin" aria-hidden="true" />
          <span>جاري الإرسال</span>
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 text-sm text-slate-500 whitespace-nowrap">
          <Clock className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>قيد الانتظار</span>
        </span>
      );
  }
}

export function ResultsTable({ attempts, isRunning }: ResultsTableProps) {
  const totalCount = attempts.length;
  const successCount = attempts.filter((item) => item.status === 'success').length;
  const failedCount = attempts.filter((item) => item.status === 'failed').length;

  return (
    <section
      aria-labelledby="results-section-title"
      className="bg-white border border-slate-200 rounded-lg overflow-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-4 border-b border-slate-200">
        <h2 id="results-section-title" className="text-lg font-semibold text-slate-900">
          جدول نتائج المحاولات
        </h2>
        <div className="flex items-center gap-2 text-xs text-slate-600 tabular-nums">
          <span>الإجمالي: {totalCount}</span>
          <span aria-hidden="true">·</span>
          <span className="text-emerald-700 font-medium">نجح: {successCount}</span>
          <span aria-hidden="true">·</span>
          <span className="text-red-700 font-medium">فشل: {failedCount}</span>
        </div>
      </div>

      {attempts.length === 0 ? (
        <div className="px-6 py-16 text-center">
          <p className="text-sm font-medium text-slate-700">
            {isRunning ? 'جاري تهيئة المتصفح وبدء المعالجة...' : 'لا توجد محاولات مسجلة حتى الآن'}
          </p>
          <p className="mt-1.5 text-sm text-slate-500">
            عند بدء الإرسال، ستظهر حالة كل رقم هاتفي ونتيجة المحاولة هنا بالتتابع.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-right border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <th scope="col" className="py-3 px-4 w-12 text-center">
                  #
                </th>
                <th scope="col" className="py-3 px-4 w-44">
                  رقم الهاتف
                </th>
                <th scope="col" className="py-3 px-4 w-28">
                  الحالة
                </th>
                <th scope="col" className="py-3 px-4 min-w-[220px]">
                  التفاصيل
                </th>
                <th scope="col" className="py-3 px-4 w-24">
                  الوقت
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {attempts.map((attempt) => (
                <tr
                  key={attempt.id}
                  className={
                    attempt.status === 'processing'
                      ? 'bg-blue-50/40'
                      : 'hover:bg-slate-50/80 transition-colors'
                  }
                >
                  <td className="py-3 px-4 text-center text-slate-500 font-mono tabular-nums">
                    {attempt.index}
                  </td>
                  <td
                    dir="ltr"
                    title={attempt.phone}
                    className="py-3 px-4 text-right font-mono tabular-nums text-slate-900 max-w-[176px] truncate whitespace-nowrap"
                  >
                    {attempt.phone}
                  </td>
                  <td className="py-3 px-4 whitespace-nowrap">
                    <StatusCell status={attempt.status} />
                  </td>
                  <td className="py-3 px-4 text-slate-700 leading-relaxed break-words">
                    {attempt.details || '—'}
                  </td>
                  <td
                    dir="ltr"
                    className="py-3 px-4 text-right font-mono tabular-nums text-xs text-slate-500 whitespace-nowrap"
                  >
                    {attempt.timestamp || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
