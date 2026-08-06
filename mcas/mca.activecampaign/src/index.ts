#!/usr/bin/env npx tsx
/**
 * ActiveCampaign MCA v1.0.0
 *
 * Integrates ActiveCampaign CRM + email marketing via the v3 REST API.
 * Authenticates per-user with BASE_URL + API_TOKEN (header `Api-Token`).
 *
 * Tools:
 * - Contacts: list / get / create / update / delete
 * - Lists:    list / subscribe-contact-to-list
 * - Campaigns: list / get
 * - Deals:    list / get / create
 * - Tags:     list / add-tag-to-contact
 * Plus -health-check.
 */

import { McaServer } from '@teros/mca-sdk';
import {
  addTagToContact,
  createContact,
  createDeal,
  deleteContact,
  getCampaign,
  getContact,
  getDeal,
  healthCheck,
  listCampaigns,
  listContacts,
  listDeals,
  listLists,
  listTags,
  subscribeContactToList,
  updateContact,
} from './tools/index.js';

export function createActiveCampaignServer(): McaServer {
  const server = new McaServer({
    id: 'mca.activecampaign',
    name: 'ActiveCampaign',
    version: '1.0.0',
  });

  server.tool('-health-check', healthCheck);

  // Contacts
  server.tool('list-contacts', listContacts);
  server.tool('get-contact', getContact);
  server.tool('create-contact', createContact);
  server.tool('update-contact', updateContact);
  server.tool('delete-contact', deleteContact);

  // Lists
  server.tool('list-lists', listLists);
  server.tool('subscribe-contact-to-list', subscribeContactToList);

  // Campaigns
  server.tool('list-campaigns', listCampaigns);
  server.tool('get-campaign', getCampaign);

  // Deals
  server.tool('list-deals', listDeals);
  server.tool('get-deal', getDeal);
  server.tool('create-deal', createDeal);

  // Tags
  server.tool('list-tags', listTags);
  server.tool('add-tag-to-contact', addTagToContact);

  return server;
}

const isDirectEntry = import.meta.url === `file://${process.argv[1]}`;
if (isDirectEntry) {
  const server = createActiveCampaignServer();
  server
    .start()
    .then(() => {
      console.error('🟢 ActiveCampaign MCA running');
    })
    .catch((err) => {
      console.error('Failed to start ActiveCampaign MCA:', err);
      process.exit(1);
    });
}
