module.exports = [
	...require('@vanilla-bean/components/eslint.app.config.cjs'),
	{
		// The client logs to the console on purpose, not only the server
		rules: {
			'no-console': 'off',
		},
	},
	...require('@vanilla-bean/components/eslint.usage.config.cjs'),
];
