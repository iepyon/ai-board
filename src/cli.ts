#!/usr/bin/env node

// ============================================================
// ai-board CLI の入口
// ============================================================

/**
 * node:sqlite は Node 24 でも実験的扱いで、読み込むと ExperimentalWarning を出す。
 * エージェントが CLI の出力を読むので、この 1 件だけ黙らせる。
 *
 * 警告は node:sqlite をリンクした時点で出るため、静的 import より前に
 * 差し替えなければ間に合わない。本体は差し替えの後に動的 import する。
 */
function suppressSqliteWarning(): void {
  const listeners = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && warning.message.startsWith('SQLite')) return;
    for (const listener of listeners) listener(warning);
  });
}

suppressSqliteWarning();

await import('./cli-main.js');
