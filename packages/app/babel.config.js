module.exports = function (api) {
  // Web-only plugin: keyed on the caller's platform (Babel caches per result).
  const isWeb = api.caller((caller) => caller?.platform === 'web');
  return {
    // unstable_transformImportMeta: pdf.js (To Do file previews) references
    // `import.meta` in Node-only branches; without the polyfill Metro's bundle
    // fails to evaluate it on web.
    presets: [['babel-preset-expo', { unstable_transformImportMeta: true }]],
    plugins: [
      // Icon barrels → one import per icon (LOADP-REQ-1). Web only.
      ...(isWeb ? [require('./scripts/babel-plugin-icon-deep-imports')] : []),
      // Reanimated plugin must be listed last
      'react-native-reanimated/plugin',
    ],
  };
};
