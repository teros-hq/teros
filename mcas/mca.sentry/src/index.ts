#!/usr/bin/env bun

/**
 * Sentry Error Monitoring MCA
 *
 * Monitor errors, issues, and performance in your applications using Sentry API.
 * List projects, view issues, and manage error states.
 */

import { McaServer } from '@teros/mca-sdk';
import {
  getEvent,
  getIssue,
  ignoreIssue,
  listEvents,
  listIssues,
  listOrganizations,
  listProjects,
  resolveIssue,
} from './tools/index.js';

const server = new McaServer({
  id: 'mca.sentry',
  name: 'Sentry',
  version: '1.0.0',
});

// Register tools
server.tool('sentry-list-organizations', listOrganizations);
server.tool('sentry-list-projects', listProjects);
server.tool('sentry-list-issues', listIssues);
server.tool('sentry-get-issue', getIssue);
server.tool('sentry-list-events', listEvents);
server.tool('sentry-get-event', getEvent);
server.tool('sentry-resolve-issue', resolveIssue);
server.tool('sentry-ignore-issue', ignoreIssue);

// Start server
server.start();
