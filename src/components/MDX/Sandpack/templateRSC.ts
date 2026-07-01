/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {SandpackFiles} from '@codesandbox/sandpack-react/unstyled';

// Load RSC infrastructure files as raw strings. The upstream code used webpack's
// inline `!raw-loader?esModule=false!` syntax; under Vite/vinext (no webpack) the
// equivalent is the `?raw` query, whose default export is the file's text.
// The two node_modules files keep their explicit relative paths to bypass the
// packages' `exports` maps (the deep CJS subpaths aren't publicly exported).
import webpackShimRaw from './sandpack-rsc/sandbox-code/src/webpack-shim.js?raw';
import rscClientRaw from './sandpack-rsc/sandbox-code/src/rsc-client.js?raw';
import reactRefreshInitRaw from './sandpack-rsc/sandbox-code/src/__react_refresh_init__.js?raw';
import workerBundleRaw from './sandpack-rsc/sandbox-code/src/worker-bundle.dist.js?raw';
// eslint-disable-next-line import/no-relative-packages
import rsdwClientRaw from '../../../../node_modules/react-server-dom-webpack/cjs/react-server-dom-webpack-client.browser.production.js?raw';
// eslint-disable-next-line import/no-relative-packages
import reactRefreshRuntimeRaw from '../../../../node_modules/next/dist/compiled/react-refresh/cjs/react-refresh-runtime.development.js?raw';

function hideFiles(files: SandpackFiles): SandpackFiles {
  return Object.fromEntries(
    Object.entries(files).map(([name, code]) => [
      name,
      typeof code === 'string' ? {code, hidden: true} : {...code, hidden: true},
    ])
  );
}

// --- RSC infrastructure files as raw strings (loaded via `?raw` imports above) ---
const RSC_SOURCE_FILES = {
  'webpack-shim': webpackShimRaw,
  'rsc-client': rscClientRaw,
  'react-refresh-init': reactRefreshInitRaw,
  'worker-bundle': `export default ${JSON.stringify(workerBundleRaw)};`,
  'rsdw-client': rsdwClientRaw,
};

// Load react-refresh runtime and strip the process.env.NODE_ENV guard
// so it works in Sandpack's bundler which may not replace process.env.
const reactRefreshRaw = reactRefreshRuntimeRaw;

// Wrap as a CJS module that Sandpack can require.
// Strip the `if (process.env.NODE_ENV !== "production")` guard so the
// runtime always executes inside the sandbox.
const reactRefreshModule = reactRefreshRaw.replace(
  /if \(process\.env\.NODE_ENV !== "production"\) \{/,
  '{'
);

// Entry point that bootstraps the RSC client pipeline.
// __react_refresh_init__ must be imported BEFORE rsc-client so the
// DevTools hook stub exists before React's renderer loads.
const indexEntry = `
import './styles.css';
import './__react_refresh_init__';
import { initClient } from './rsc-client.js';
initClient();
`.trim();

const indexHTML = `
<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Document</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`.trim();

export const templateRSC: SandpackFiles = {
  ...hideFiles({
    '/public/index.html': indexHTML,
    '/src/index.js': indexEntry,
    '/src/__react_refresh_init__.js': RSC_SOURCE_FILES['react-refresh-init'],
    '/src/rsc-client.js': RSC_SOURCE_FILES['rsc-client'],
    '/src/rsc-server.js': RSC_SOURCE_FILES['worker-bundle'],
    '/src/__webpack_shim__.js': RSC_SOURCE_FILES['webpack-shim'],
    // RSDW client as a Sandpack local dependency (bypasses Babel bundler)
    '/node_modules/react-server-dom-webpack/package.json':
      '{"name":"react-server-dom-webpack","main":"index.js"}',
    '/node_modules/react-server-dom-webpack/client.browser.js':
      RSC_SOURCE_FILES['rsdw-client'],
    // react-refresh runtime as a Sandpack local dependency
    '/node_modules/react-refresh/package.json':
      '{"name":"react-refresh","main":"runtime.js"}',
    '/node_modules/react-refresh/runtime.js': reactRefreshModule,
    '/package.json': JSON.stringify(
      {
        name: 'react.dev',
        version: '0.0.0',
        main: '/src/index.js',
        dependencies: {
          react: '19.2.4',
          'react-dom': '19.2.4',
        },
      },
      null,
      2
    ),
  }),
};
