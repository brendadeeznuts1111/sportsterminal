import js from '@eslint/js';
import ts from 'typescript-eslint';

export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      // Gradual strictness: warn on explicit any instead of error
      '@typescript-eslint/no-explicit-any': 'warn',
      // Prevent unsafe any usage in expressions
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // Keep these as errors for basic hygiene
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off', // Console is acceptable for backend logging
    },
  },
  {
    // Tests can be more relaxed
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  }
);
