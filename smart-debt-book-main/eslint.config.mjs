// Money rule (docs/API_CONTRACT.md rule A): no float conversions where agorot live.
import tseslint from 'typescript-eslint';

const noFloatMoney = [
  { selector: "CallExpression[callee.name='Number']", message: 'Money is bigint agorot: no Number(). Use BigInt or src/money.ts.' },
  { selector: "CallExpression[callee.name=/^parse(Float|Int)$/]", message: 'Money is bigint agorot: no parseFloat/parseInt. Use src/money.ts.' },
  { selector: "CallExpression[callee.object.name='Number'][callee.property.name=/^parse/]", message: 'Money is bigint agorot: no Number.parse*.' },
  { selector: "UnaryExpression[operator='+']", message: 'Unary + converts to a float number. Use BigInt.' },
  { selector: "MemberExpression[object.name='Math']", message: 'Math.* works on floats. Money is bigint agorot.' },
  { selector: "CallExpression[callee.property.name='toFixed']", message: 'toFixed is float formatting. Use formatAgorot().' },
];

export default tseslint.config(
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
  ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }] } },
  {
    files: ['src/money.ts', 'src/ledger/**/*.ts', 'src/api/**/*.ts', 'app/api/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...noFloatMoney] },
  },
  {
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
