// tsx 4.x only supports --import tsx/esm (not module.register / --loader).
// We therefore do NOT use the `loader` key here — instead the caller must
// set NODE_OPTIONS='--import tsx/esm' (see the `cucumber` script in package.json).
// Cucumber's `import` key performs dynamic import() on the resolved file paths,
// which tsx intercepts once it is pre-registered via NODE_OPTIONS.
module.exports = {
  default: {
    import: ['features/step_definitions/**/*.ts', 'features/support/**/*.ts'],
    format: ['progress-bar', 'html:reports/cucumber-report.html'],
    formatOptions: { snippetInterface: 'async-await' },
    publishQuiet: true,
  },
};
