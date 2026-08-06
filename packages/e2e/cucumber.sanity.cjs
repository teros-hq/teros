module.exports = {
  default: {
    import: [
      'features/step_definitions/sanity.steps.ts',
      'features/step_definitions/common.steps.ts',
      'features/step_definitions/smoke.steps.ts',
      'features/support/world.ts',
      'features/support/real-server.ts',
      'features/support/hooks.sanity.ts',
    ],
    paths: ['features/sanity.feature'],
    format: ['progress-bar', 'html:reports/cucumber-sanity-report.html'],
    formatOptions: { snippetInterface: 'async-await' },
    publishQuiet: true,
    tags: '@sanity',
  },
};
