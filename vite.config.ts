import vinext from 'vinext';
import {defineConfig} from 'vite';
import {cloudflare} from '@cloudflare/vite-plugin';
import path from 'node:path';

// `@cloudflare/vite-plugin` runs the app inside workerd. `vinext deploy` requires
// it — it statically greps THIS FILE for the "@cloudflare/vite-plugin" string and
// the plugin must be active during the deploy build — but it MUST NOT run for any
// other command:
//   • `vinext dev`   → workerd has no `fs`, so getStaticProps' fs reads throw and
//                      every route 404s (silently, content-length 0).
//   • `vinext build` → it rewrites the output to a worker bundle, after which the
//                      `--prerender-all` step fails with "No build output found in
//                      dist" (so a local prerendered preview is impossible).
// Enable it ONLY when the running command is `vinext deploy`. We auto-detect that
// from argv (deploy runs its Vite build in-process, so "deploy" is still in argv
// when this config is evaluated); `VINEXT_DEPLOY=1` is a manual override. The
// static-grep check still passes because the import above stays in the file.
const isCloudflareDeploy =
  process.argv.includes('deploy') || process.env.VINEXT_DEPLOY === '1';

// react.dev uses tsconfig `baseUrl: "src"` (bare imports like
// `components/Layout/Page`) with NO `paths`. Next/SWC resolves these; Vite has
// no baseUrl concept and its native `resolve.tsconfigPaths` does not cover
// baseUrl-only resolution in the SSR module runner. Map the three src roots
// that are bare-imported (components 58×, utils 5×, hooks 1×) explicitly. These
// segment names don't collide with any npm package the app imports.
const srcRoots = ['components', 'utils', 'hooks'];

// The in-browser ESLint engine (runESLint.tsx) pulls in eslint-scope, which
// calls Node's `assert()` during scope analysis. In a browser build Vite maps
// the `assert` builtin to its empty `__vite-browser-external` stub, so the call
// throws ("<x> is not a function") and the linter reports a fake "Parsing
// error" for ALL input. Next.js shimmed this via its webpack config, which
// vinext drops. A plain `resolve.alias` to a CJS file doesn't work: a `.cjs` is
// rejected by rolldown (vite-plugin-commonjs injects `export` into it) and a
// `.js` with `module.exports` is bundled as ESM, so eslint-scope's
// `require('assert')` gets a namespace, not the callable. Serve `assert` as a
// VIRTUAL CommonJS module instead — rolldown's native CJS detection on
// `module.exports` makes `require('assert')` return the function itself.
function assertPolyfillPlugin() {
  const VIRTUAL = '\0vinext-assert-polyfill';
  const CODE = `
function assert(value, message) {
  if (!value) {
    if (message instanceof Error) throw message;
    throw new Error(typeof message === 'string' ? message : 'Assertion failed');
  }
}
function AssertionError(opts) {
  this.name = 'AssertionError';
  this.message = (opts && opts.message) || 'AssertionError';
  if (opts) { this.actual = opts.actual; this.expected = opts.expected; }
}
AssertionError.prototype = Object.create(Error.prototype);
AssertionError.prototype.constructor = AssertionError;
assert.AssertionError = AssertionError;
assert.ok = assert;
assert.fail = function (m) { throw new AssertionError({message: typeof m === 'string' ? m : 'Failed'}); };
assert.equal = function (a, b, m) { if (a != b) throw new AssertionError({actual: a, expected: b, message: m}); };
assert.strictEqual = function (a, b, m) { if (a !== b) throw new AssertionError({actual: a, expected: b, message: m}); };
assert.notEqual = function (a, b, m) { if (a == b) throw new AssertionError({actual: a, expected: b, message: m}); };
assert.notStrictEqual = function (a, b, m) { if (a === b) throw new AssertionError({actual: a, expected: b, message: m}); };
assert.deepEqual = function () {};
assert.deepStrictEqual = function () {};
assert.notDeepEqual = function () {};
module.exports = assert;
`;
  return {
    name: 'vinext-assert-polyfill',
    enforce: 'pre' as const,
    resolveId(id: string) {
      if (
        id === 'assert' ||
        id === 'node:assert' ||
        id === 'assert/strict' ||
        id === 'node:assert/strict'
      ) {
        return VIRTUAL;
      }
      return null;
    },
    load(id: string) {
      if (id === VIRTUAL) return CODE;
      return null;
    },
  };
}

// react.dev's next.config `webpack` block used an IgnorePlugin to skip ESLint's
// built-in `eslint/lib/rules/*` files (the in-browser linter only enables the
// react-hooks rules). vinext drops that, so rolldown follows
// eslint/lib/rules/index.js's lazy rule map and bundles all ~284 core rules
// (~1.17 MB) into the lazy runESLint chunk. Stub those bare rule modules — they
// are never enabled, so this is correctness-neutral; it only shrinks the chunk.
// react-hooks rules come from eslint-plugin-react-hooks (a different importer)
// and are NOT matched here.
function trimEslintCoreRulesPlugin() {
  const PREFIX = '\0vinext-eslint-rule-stub:';
  return {
    name: 'vinext-trim-eslint-core-rules',
    enforce: 'pre' as const,
    resolveId(id: string, importer?: string) {
      if (
        importer &&
        importer.includes('/eslint/lib/rules/') &&
        /^\.\/[\w-]+(\.js)?$/.test(id) &&
        !/^\.\/(index|utils)\b/.test(id)
      ) {
        return PREFIX + id;
      }
      return null;
    },
    load(id: string) {
      if (id.startsWith(PREFIX)) return 'export default {}';
      return null;
    },
  };
}

// The `vinext dev` SSR module runner inlines node_modules through Vite's
// ESModulesEvaluator (vinext forces ssr.noExternal for the Workers target), and
// that evaluator runs code in a strict ESM scope with no `require`/`module`/
// `exports`. So pure-CJS/UMD deps throw `exports is not defined` etc. and CRASH
// the dev server (fatal), one at a time. react.dev's per-request MDX compile
// chain (getStaticProps -> compileMDX -> remark/retext/babel/metro-cache) plus a
// few client components pull in exactly these old CJS packages. Pre-bundling
// them (optimizeDeps) runs them through rolldown's CJS->ESM wrapping so the
// runner gets clean ESM. DEV-ONLY: optimizeDeps does not affect the build, so
// the Cloudflare deploy is unchanged. Upstream: cloudflare/vinext#585 (PR #665).
const devCjsDeps = [
  // per-request MDX compile chain (src/utils/compileMDX.ts + plugins/markdownToHtml.js)
  'metro-cache',
  '@babel/core',
  'gray-matter',
  'unist-util-visit',
  'mdast-util-to-string',
  'github-slugger',
  'remark',
  'remark-html',
  'remark-external-links',
  'remark-images',
  'remark-unwrap-images',
  'remark-gfm',
  'remark-frontmatter',
  'retext',
  'retext-smartypants',
  '@mdx-js/mdx',
  'rss', // generateRssFeed() runs in getStaticProps (src/utils/rss.js)
  // CJS/UMD deps used by components rendered during SSR
  'classnames',
  'debounce',
  'parse-numeric-range',
  // Leaf CJS utils pulled in (transitively) by @codesandbox/sandpack-react's
  // console/ANSI rendering. NOTE: only these leaf utils are listed — do NOT
  // pre-bundle @codesandbox/sandpack-react itself, as that bundles a second copy
  // of React and breaks SandpackProvider's hooks during SSR ("Invalid hook
  // call"). These two have no React dependency, so they're safe to pre-bundle.
  'anser',
  'escape-carriage',
  // config-time CJS pulled in when the module runner loads tailwind.config.mjs
  'tailwindcss/defaultTheme',
];

export default defineConfig({
  plugins: [
    vinext(),
    ...(isCloudflareDeploy ? [cloudflare()] : []),
    assertPolyfillPlugin(),
    trimEslintCoreRulesPlugin(),
  ],
  resolve: {
    alias: [
      ...srcRoots.map((root) => ({
        find: new RegExp(`^${root}/`),
        replacement: path.resolve(import.meta.dirname, 'src', root) + '/',
      })),
      // The in-browser ESLint engine's selector matching needs esquery's CJS
      // build: its `module` (ESM) entry exposes only a default namespace, so
      // `esquery.parse`/`.matches` come back undefined ("r.parse is not a
      // function"). Force the CJS build, like react.dev's dropped webpack alias.
      {find: /^esquery$/, replacement: 'esquery/dist/esquery.min.js'},
    ],
    // `vinext init` renamed tailwind.config.js / postcss.config.js to `.cjs`
    // (required under "type":"module"), but Themes.tsx does
    // `import tailwindConfig from '../../../../tailwind.config'` (extensionless)
    // and Vite's default resolve.extensions does NOT include `.cjs`. Add it
    // (after `.js` so real `.js` still wins) so the renamed config resolves.
    extensions: ['.mjs', '.js', '.cjs', '.mts', '.ts', '.jsx', '.tsx', '.json'],
  },
  // react.dev keeps JSX in `.js` files (404.js, [[...markdownPath]].js,
  // HomeContent.js, prepareMDX.js, ...). Next/SWC handles that; vinext's main
  // oxc transform handles it for SSR too, but the Vite 8 optimizeDeps dependency
  // SCANNER (rolldown) has JSX disabled for `.js`, so the scan fails, no deps
  // are pre-bundled, and UMD deps like `classnames` then crash under SSR
  // (`window is not defined`). Tell the scanner to treat `.js` as JSX.
  optimizeDeps: {
    rolldownOptions: {
      moduleTypes: {
        '.js': 'jsx',
      },
    },
    // Force-pre-bundle the pure-CJS/UMD deps the dev SSR module runner would
    // otherwise inline and crash on (see devCjsDeps above).
    include: devCjsDeps,
  },
  ssr: {
    // This is the one that actually matters: the crash happens in the dev SSR
    // module runner, so the SSR environment must pre-bundle the same CJS deps.
    optimizeDeps: {
      include: devCjsDeps,
    },
  },
});
