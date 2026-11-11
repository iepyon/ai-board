import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'examples/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      // src 配下（本体・テスト）をまとめて解析させる
      parserOptions: { project: './tsconfig.eslint.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // console はローカル CLI の出力手段なので warn 系だけ許す
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      complexity: ['error', 12],
      'max-lines-per-function': ['error', { max: 120, skipComments: true, skipBlankLines: true }],
    },
  },
  {
    // cli/ は引数・使い方・終了コード・出力だけを持ち、人に読ませる文言は presenters が持つ。
    // cli/ の外から cli/ を引くと、戻す HTTP の入口が CLI に依存するので止める。入口（src/cli.ts / src/cli-main.ts）と cli/ の中だけが引いてよい。
    // コアの no-restricted-imports は src/shared/ の設定が上書きするので、別の規則（@typescript-eslint の方）に載せて重ならないようにする
    files: ['src/**/*.ts'],
    ignores: ['src/**/cli/**', 'src/cli.ts', 'src/cli-main.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/cli/**'],
              message:
                'cli/ の外から cli/ を import しない。人に読ませる文言は presenters（src/board/presenters/ など）に置く',
            },
          ],
        },
      ],
    },
  },
  {
    // src/shared/ はブラウザでも動く値と型だけを置く（ADR 0018）。テストは Node で動き画面のビルドに入らないので除く
    files: ['src/shared/**/*.ts'],
    ignores: ['src/shared/**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'fs/*', 'path', 'os', 'child_process', 'url', 'crypto'],
              message: 'src/shared/ はブラウザでも動く値と型だけを置く（ADR 0018）。Node の API は使わない',
            },
            {
              group: ['**/board/**', '**/cards/**', '**/infrastructure/**'],
              message:
                'src/shared/ はブラウザでも動く値と型だけを置く（ADR 0018）。コンテキストと infrastructure を import しない',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/__tests__/**/*.ts'],
    rules: { 'max-lines-per-function': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  }
);
