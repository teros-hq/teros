module.exports = {
  default: {
    requireModule: ['tsx'],
    require: ['features/step_definitions/**/*.ts', 'features/support/**/*.ts'],
    format: ['progress-bar', 'html:reports/cucumber-report.html'],
    formatOptions: { snippetInterface: 'async-await' },
    publishQuiet: true,
  },
};
