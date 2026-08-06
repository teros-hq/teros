module.exports = {
  default: {
    import: [
      'features/step_definitions/ui/login.steps.ts',
      'features/support/world.ui.ts',
      'features/support/hooks.ui.ts',
    ],
    paths: ['features/ui/**/*.feature'],
    format: ['progress-bar', 'html:reports/cucumber-ui-report.html'],
    formatOptions: { snippetInterface: 'async-await' },
    publishQuiet: true,
    tags: '@ui',
  },
};
