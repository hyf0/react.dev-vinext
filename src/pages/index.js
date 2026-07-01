/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/*
 * Homepage ('/') route.
 *
 * Upstream react.dev served the root from the OPTIONAL catch-all
 * `[[...markdownPath]]` with empty params. vinext does not serve the optional
 * catch-all's empty-params root (it 404s), so the catch-all was converted to a
 * REQUIRED catch-all `[...markdownPath]` (which no longer matches '/') and the
 * root is served explicitly here.
 *
 * The catch-all's getStaticProps already maps empty/undefined params to the
 * 'index' content file (`(context.params.markdownPath || []).join('/') ||
 * 'index'`), so re-exporting it renders src/content/index.md as the homepage.
 * This shape (required catch-all + index) is valid in both Next.js and vinext.
 */
export {default, getStaticProps} from './[...markdownPath]';
