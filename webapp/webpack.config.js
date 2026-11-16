// Webpack config for the Telegram Web UI plugin webapp bundle.
//
// The Mattermost web app exposes React, ReactDOM, Redux, ReactRedux, ... on the global window
// object (see webapp/channels/src/plugins/export.ts upstream) so plugin bundles must externalize
// them instead of shipping their own copy. This guarantees the plugin always runs against the
// same React instance the host app uses (React 19 on Mattermost v12, React 18 on v11).

const path = require('path');
const webpack = require('webpack');

require('../scripts/prepare-pdfjs')();

const PLUGIN_ID = require('../plugin.json').id;
const NPM_TARGET = process.env.npm_lifecycle_event; // eslint-disable-line no-process-env
const isDev = NPM_TARGET === 'debug' || NPM_TARGET === 'debug:watch';

const config = {
    // Mermaid imports diagram renderers dynamically. Ship them inside the installable
    // main.js, since the plugin host does not serve webpack chunks from its root URL.
    plugins: [new webpack.optimize.LimitChunkCountPlugin({maxChunks: 1})],
    entry: ['./src/index.tsx'],
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
                // Fonts referenced from styles.css are inlined as data URIs so the shipped
                // artifact stays a single dist/main.js (no extra runtime file to serve).
                test: /\.woff2$/,
                type: 'asset/inline',
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
        path: path.join(__dirname, 'dist'),
        publicPath: '/',
        filename: 'main.js',
    },
    mode: isDev ? 'development' : 'production',
    devtool: isDev ? 'eval-source-map' : false,
};

module.exports = config;
