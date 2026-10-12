// Babel config used by webpack (and by ts type checking through the same sources).
// JSX runtime is intentionally "classic" so the emitted code calls React.createElement, which is
// available on every Mattermost server version that ships webapp plugins (React 16 through 19).

const config = {
    presets: [
        [
            '@babel/preset-env',
            {
                targets: {
                    chrome: '66',
                    firefox: '60',
                    edge: '79',
                    safari: '12',
                },
                modules: false,
                useBuiltIns: false,
            },
        ],
        [
            '@babel/preset-react',
            {
                runtime: 'classic',
                useBuiltIns: true,
            },
        ],
        '@babel/preset-typescript',
    ],
};

module.exports = config;
