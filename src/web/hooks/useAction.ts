import { useCallback, useState } from 'react';

// ============================================================
// 保存処理の実行状態
// ============================================================

export type RunAction = (action: () => Promise<unknown>) => Promise<void>;

interface UseActionResult {
  saving: boolean;
  error: string | null;
  run: RunAction;
  clearError: () => void;
}

/**
 * 保存処理を包む。実行中は `saving`、失敗したら `error` に理由を持ち、
 * 成功したら `onChanged` でボードを取り直させる。
 *
 * 詳細パネルと判断待ちの区画の両方が、同じレビューの部品をこれで動かす。
 */
export function useAction(onChanged: () => void): UseActionResult {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback<RunAction>(
    async (action) => {
      setSaving(true);
      setError(null);
      try {
        await action();
        onChanged();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSaving(false);
      }
    },
    [onChanged]
  );

  const clearError = useCallback(() => setError(null), []);

  return { saving, error, run, clearError };
}
