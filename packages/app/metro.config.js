const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

// Find the project and workspace directories
const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Watch all files within the monorepo
config.watchFolders = [monorepoRoot];

// 2. Let Metro know where to resolve packages and in what order
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// 2b. Keep the file watcher (and HMR) out of the monorepo's log directories.
//
// watchFolders covers the whole monorepo, which includes packages/backend/logs
// (~400MB of PM2 + ws-*.ndjson logs, rewritten every second). Nothing there is
// importable, but every write fired a contentless HMR update broadcast to ALL
// connected tabs every ~30s, and the constant churn fed Metro's memory growth
// until its V8 heap OOM (raw-os autorefresh investigation, 2026-10-24).
// resolver.blockList feeds metro-file-map's ignorePattern, which filters both
// the initial crawl and the watch — blocked files are never watched.
config.resolver.blockList = [
  // Preserve Expo's defaults (/\.expo\/types\// and /__tests__\/.*/).
  ...(Array.isArray(config.resolver.blockList)
    ? config.resolver.blockList
    : config.resolver.blockList
      ? [config.resolver.blockList]
      : []),
  // PM2/backend log dirs inside the monorepo.
  /packages[\\/](?:backend|app|e2e)[\\/]logs[\\/]/,
  // Monorepo root logs (legacy ws-*.ndjson, logs/mcas) — matches a server
  // checkout (<root>/logs) and sandbox copies (teros-<suffix>/logs).
  /(?:^|[\\/])teros(?:-[a-z]+)?[\\/]logs[\\/]/,
];

// 3. Force zustand ESM builds to their CJS equivalents.
//
// Both zustand@5 (app) and zustand@4 (@xyflow/react's nested dep) publish
// dual ESM/CJS packages. Their ESM builds use `import.meta.env` to detect
// production mode — Metro/Expo Web does not support `import.meta` natively,
// so the bundle compiles but the browser fails at runtime with:
//
//     SyntaxError: Cannot use 'import.meta' outside a module
//
// We alias each affected subpath to its CJS counterpart, which is
// functionally identical (drops the import.meta prod-detection code path).
//
// zustand@5 (top-level): middleware
// zustand@4 (nested under @xyflow/react): traditional, shallow, vanilla,
//   context, index, middleware
const ZUSTAND_V5_ROOT = path.resolve(monorepoRoot, 'node_modules/zustand');
const ZUSTAND_V4_ROOT = path.resolve(
  monorepoRoot,
  'node_modules/@xyflow/react/node_modules/zustand'
);

// Map of zustand subpath → CJS file (relative to the zustand package root).
// The empty string key represents the package root import ('zustand').
const ZUSTAND_CJS_MAP = {
  '': 'index.js',
  'middleware': 'middleware.js',
  'traditional': 'traditional.js',
  'shallow': 'shallow.js',
  'vanilla': 'vanilla.js',
  'context': 'context.js',
};

// 4. Force `@qdrant/js-client-rest` to its browser (fetch-based) build on
// every platform. `@teros/shared`'s memory module imports it, and on native
// Metro picks the Node build, which drags in `undici` → `node:buffer` and
// fails to bundle. The browser build relies on `fetch`, which React Native
// provides. Web already resolved to it via the package's `browser` field.
const QDRANT_BROWSER_BUILD = path.resolve(
  monorepoRoot,
  'node_modules/@qdrant/js-client-rest/dist/browser/index.js',
);

// 5. Force `uuid` to its CJS entry point.
//
// uuid v11 publishes an ESM wrapper (`wrapper.mjs`) that does a default import
// from the CJS `dist/index.js` and then re-exports named properties:
//
//     import uuid from './dist/index.js';
//     export const v1 = uuid.v1;
//
// Metro's import/default interop doesn't resolve this correctly — the default
// import comes back as `undefined`, so `uuid.v1` throws at runtime:
//
//     TypeError: Cannot read properties of undefined (reading 'v1')
//
// This only manifests during `expo export --platform web` (static rendering),
// not during dev. Pointing directly to the CJS entry avoids the wrapper.
//
// The entry is looked up, not hard-coded: where yarn puts `uuid` depends on
// which workspaces are installed (the frontend image installs only some), and
// the CJS file moved from `dist/index.js` (v9) to `dist/cjs-browser/index.js`
// (v11). `@teros/shared` is the package that asks for it, so its copy wins.
const UUID_CJS_ENTRY = (() => {
  const fs = require('fs');
  for (const dir of [
    path.resolve(monorepoRoot, 'packages/shared/node_modules/uuid'),
    path.resolve(monorepoRoot, 'node_modules/uuid'),
  ]) {
    for (const file of ['dist/cjs-browser/index.js', 'dist/index.js']) {
      const candidate = path.join(dir, file);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('metro.config.js: no CJS entry of `uuid` found under node_modules');
})();

// 6. Per-icon Lucide imports resolve to the ESM files on web (LOADP-REQ-1).
//
// scripts/babel-plugin-icon-deep-imports.js rewrites `import { X } from
// "@tamagui/lucide-icons"` to `@tamagui/lucide-icons/icons/X`. Through that
// package's `exports` map Metro picks the `require` (CJS) file, whose
// `@tamagui/helpers-icon` → `@tamagui/web` are the CJS copies: a SECOND Tamagui
// with its own React contexts, so a `themed()` icon rendered under our
// TamaguiProvider throws "Missing theme". Resolve straight to the ESM file, the
// same one the barrel used.
const LUCIDE_ICONS_DIR = path.join(
  path.dirname(require.resolve('@tamagui/lucide-icons/package.json')),
  'dist/esm/icons',
);
const LUCIDE_ICON_REQUEST = /^@tamagui\/lucide-icons\/icons\/([A-Za-z0-9]+)$/;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web') {
    const icon = LUCIDE_ICON_REQUEST.exec(moduleName);
    if (icon) {
      return { filePath: path.join(LUCIDE_ICONS_DIR, `${icon[1]}.mjs`), type: 'sourceFile' };
    }
  }

  // zustand@5 (top-level) — resolve 'zustand' and 'zustand/middleware' to CJS
  if (moduleName === 'zustand') {
    return { filePath: path.join(ZUSTAND_V5_ROOT, 'index.js'), type: 'sourceFile' };
  }
  if (moduleName === 'zustand/middleware') {
    return { filePath: path.join(ZUSTAND_V5_ROOT, 'middleware.js'), type: 'sourceFile' };
  }

  // zustand@4 (nested under @xyflow/react) — resolve all subpaths to CJS
  // These come in as 'zustand', 'zustand/traditional', 'zustand/shallow', etc.
  // but Metro resolves them to the nested copy because @xyflow/react depends
  // on zustand@4. We need to intercept and point to the CJS files.
  if (moduleName === 'zustand/traditional') {
    return { filePath: path.join(ZUSTAND_V4_ROOT, 'traditional.js'), type: 'sourceFile' };
  }
  if (moduleName === 'zustand/shallow') {
    return { filePath: path.join(ZUSTAND_V4_ROOT, 'shallow.js'), type: 'sourceFile' };
  }
  if (moduleName === 'zustand/vanilla') {
    return { filePath: path.join(ZUSTAND_V4_ROOT, 'vanilla.js'), type: 'sourceFile' };
  }
  if (moduleName === 'zustand/context') {
    return { filePath: path.join(ZUSTAND_V4_ROOT, 'context.js'), type: 'sourceFile' };
  }

  if (moduleName === '@qdrant/js-client-rest') {
    return { filePath: QDRANT_BROWSER_BUILD, type: 'sourceFile' };
  }

  // uuid — resolve to CJS entry to avoid ESM wrapper.mjs default-import issue
  if (moduleName === 'uuid') {
    return { filePath: UUID_CJS_ENTRY, type: 'sourceFile' };
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
