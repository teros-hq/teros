import { McaServer } from '@teros/mca-sdk';
import { reportBug, reportSuggestion } from './tools';

// =============================================================================
// SERVER
// =============================================================================

const server = new McaServer({
  name: 'feedback',
  version: '1.1.0',
});

server.tool('report-bug', reportBug);
server.tool('report-suggestion', reportSuggestion);

server.start().catch(console.error);
