import eslintConfig from '@pretendonetwork/eslint-config';

export default [
	...eslintConfig,
	{
		rules: {
			'@stylistic/no-multi-spaces': 'off',
			'@stylistic/key-spacing': 'off'
		}
	}
];