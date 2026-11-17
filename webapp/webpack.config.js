// Webpack config for the Telegram Web UI plugin webapp bundle.
//
// The Mattermost web app exposes React, ReactDOM, Redux, ReactRedux, ... on the global window
// object (see webapp/channels/src/plugins/export.ts upstream) so plugin bundles must externalize
// them instead of shipping their own copy. This guarantees the plugin always runs against the
// same React instance the host app uses (React 19 on Mattermost v12, React 18 on v11).

const path = require('path');
const fs = require('fs');
const webpack = require('webpack');

require('../scripts/prepare-pdfjs')();
// Clean only generated lazy assets; the output root also contains repository sources.
fs.rmSync(path.join(__dirname, '..', 'public', 'webapp'), {recursive: true, force: true});

const PLUGIN_ID = require('../plugin.json').id;
const PLUGIN_VERSION = require('../plugin.json').version;
const NPM_TARGET = process.env.npm_lifecycle_event; // eslint-disable-line no-process-env
const isDev = NPM_TARGET === 'debug' || NPM_TARGET === 'debug:watch';

const config = {
    entry: ['./src/index.tsx'],
    plugins: [{apply(compiler) {
        compiler.hooks.thisCompilation.tap('PluginAssets', (compilation) => {
            compilation.hooks.processAssets.tap({name: 'PluginAssets', stage: webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT}, () => {
                const files = compilation.getAssets().map((asset) => asset.name).filter((name) => name.startsWith('public/webapp/')).sort();
                compilation.emitAsset('public/webapp/manifest.json', new webpack.sources.RawSource(JSON.stringify({files}, null, 2)));
            });
        });
    }}],
    resolve: {
        modules: ['src', 'node_modules'],
        extensions: ['*', '.js', '.jsx', '.ts', '.tsx'],
    },
    module: {
        rules: [
            {
                test: /\.(js|jsx|ts|tsx)$/,
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                    options: {cacheDirectory: true},
                },
            },
            {
                test: /\.(css)$/,
                use: ['style-loader', 'css-loader'],
            },
            {
                // Fonts are fetched and cached independently when the Telegram UI uses them.
                test: /\.woff2$/,
                type: 'asset/resource',
                generator: {filename: 'public/webapp/fonts/[name].[contenthash:12][ext]'},
            },
        ],
    },
    externals: {
        react: 'React',
        'react-dom': 'ReactDOM',
        'react/jsx-runtime': 'ReactJSXRuntime',
        'react/jsx-dev-runtime': 'ReactJSXDevRuntime',
        redux: 'Redux',
        'react-redux': 'ReactRedux',
        'prop-types': 'PropTypes',
        'react-bootstrap': 'ReactBootstrap',
        'react-router-dom': 'ReactRouterDom',
        luxon: 'Luxon',
    },
    output: {
        devtoolNamespace: PLUGIN_ID,
        path: path.join(__dirname, '..'),
        clean: false,
        uniqueName: `${PLUGIN_ID}-${PLUGIN_VERSION}`,
        chunkLoadingGlobal: `webpackChunkTelegramWebUI_${PLUGIN_VERSION.replace(/[^a-zA-Z0-9]/g, '_')}`,
        chunkFilename: 'public/webapp/[name].[contenthash:12].js',
        publicPath: '/',
        filename: 'webapp/dist/main.js',
    },
    mode: isDev ? 'development' : 'production',
    devtool: isDev ? 'eval-source-map' : false,
};

module.exports = config;
