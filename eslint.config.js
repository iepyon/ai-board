import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'examples/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      // src 配下（サーバ・web・テスト）をまとめて解析させる
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
    files: ['src/**/__tests__/**/*.ts'],
    rules: { 'max-lines-per-function': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  }
);
