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
