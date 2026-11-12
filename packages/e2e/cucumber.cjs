// tsx 4.x only supports --import tsx/esm (not module.register / --loader).
// We therefore do NOT use the `loader` key here — instead the caller must
// set NODE_OPTIONS='--import tsx/esm' (see the `cucumber` script in package.json).
// Cucumber's `import` key performs dynamic import() on the resolved file paths,
// which tsx intercepts once it is pre-registered via NODE_OPTIONS.
//
// WS suites only (embedded TestServer). The UI and sanity suites have their own
// configs (cucumber.ui.cjs, cucumber.sanity.cjs): globbing features/support/**
// here loaded world.ui.ts (whose setWorldConstructor replaced CustomWorld) and
// hooks.ui.ts, which launched Chromium before every WS scenario and seeded UI
// users into E2E_MONGO_URI (default mongodb://localhost:27017).
module.exports = {
  default: {
    import: [
      'features/step_definitions/common.steps.ts',
      'features/step_definitions/smoke.steps.ts',
      'features/step_definitions/realtime.steps.ts',
      'features/support/world.ts',
      'features/support/hooks.ts',
    ],
    paths: [
      'features/smoke.feature',
      'features/authentication.feature',
      'features/channels.feature',
      'features/messaging.feature',
      'features/realtime.feature',
    ],
    format: ['progress-bar', 'html:reports/cucumber-report.html'],
    formatOptions: { snippetInterface: 'async-await' },
    publishQuiet: true,
  },
};
