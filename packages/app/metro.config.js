const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

// Find the project and workspace directories
const projectRoot = __dirname;
// This can be replaced with `find-yarn-workspace-root`
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Watch all files within the monorepo
config.watchFolders = [monorepoRoot];

// 2. Let Metro know where to resolve packages and in what order
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// 3. Force `zustand/middleware` to resolve to its CJS build.
//
// zustand@5 publishes a dual ESM/CJS package. Its ESM build
// (`esm/middleware.mjs`) uses `import.meta.env` on lines 62 and 124 to
// detect production mode — a pattern that Vite/Rollup/webpack 5 transform
// at build time, but Metro/Expo Web does not support natively. The bundle
// compiles fine but the browser fails at runtime with:
//
//     Uncaught SyntaxError: Cannot use 'import.meta' outside a module
//
// Discussed publicly in zustand and Metro issue trackers; the canonical
// workaround is to alias to the CJS build, which is functionally
// identical (drops the prod-detection code path that Metro can't handle).
//
// The blanket `config.resolver.unstable_enablePackageExports = false`
// (Expo's documented escape hatch) was attempted first but breaks other
// dependencies that DO require the modern ESM resolution for subpath
// exports (e.g. `react-syntax-highlighter` → `refractor/bash`). A
// targeted resolver for the single offender is the lesser evil.
//
// Remove this when zustand drops `import.meta.env` from its build, or
// when Metro/Expo Web supports `import.meta` natively (whichever first).
const ZUSTAND_MIDDLEWARE_CJS = path.resolve(
  monorepoRoot,
  'node_modules/zustand/middleware.js',
);
// 4. Force `@qdrant/js-client-rest` to its browser (fetch-based) build on
// every platform. `@teros/shared`'s memory module imports it, and on native
// Metro picks the Node build, which drags in `undici` → `node:buffer` and
// fails to bundle. The browser build relies on `fetch`, which React Native
// provides. Web already resolved to it via the package's `browser` field.
const QDRANT_BROWSER_BUILD = path.resolve(
  monorepoRoot,
  'node_modules/@qdrant/js-client-rest/dist/browser/index.js',
);
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'zustand/middleware') {
    return { filePath: ZUSTAND_MIDDLEWARE_CJS, type: 'sourceFile' };
  }
  if (moduleName === '@qdrant/js-client-rest') {
    return { filePath: QDRANT_BROWSER_BUILD, type: 'sourceFile' };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
