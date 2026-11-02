import { useMemo } from 'react';
import {
  describeAction,
  describeResult,
  formatDurationMs,
  formatTokens,
  newestFirst,
} from '../../../shared/loop-activity.js';
import { formatDateTime } from '../../format.js';
import type { LoopStep } from '../../types.js';

// ============================================================
// ループの手 — このカードに渡された 1 手の記録の一覧
// ============================================================

/**
 * カードに渡されたループの手を、新しい順に表で出す。手が無ければ欄ごと出さない。
 *
 * 時間とトークンは監視役が完了の通知から写したもので、写せなかったものは「—」と出す。
 * 書式は `src/shared/loop-activity.ts` の純関数に寄せる（`src/web/` はテストの対象外のため）。
 */
export function LoopSteps({ steps }: { steps: readonly LoopStep[] }) {
  const rows = useMemo(() => newestFirst(steps), [steps]);
  if (rows.length === 0) return null;

  return (
    <>
      <h3>ループの手</h3>
      <div className="loop-steps-wrap">
        <table className="loop-steps">
          <thead>
            <tr>
              <th>開始</th>
              <th>手</th>
              <th>作業者</th>
              <th>時間</th>
              <th>トークン</th>
              <th>結果</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((step) => (
              <tr key={`${step.loop}-${step.startedAt}`}>
                <td>
                  <time dateTime={step.startedAt}>{formatDateTime(step.startedAt)}</time>
                </td>
                <td className="mono">{describeAction(step)}</td>
                <td className="mono">{step.agent ?? '—'}</td>
                <td>{formatDurationMs(step.durationMs)}</td>
                <td>{formatTokens(step.tokens)}</td>
                <td className={`loop-result result-${step.result ?? 'running'}`}>
                  {describeResult(step)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
