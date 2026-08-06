import { describe, expect, it } from 'bun:test';
import {
  buildAssociations,
  buildProperties,
  formatAssociation,
  formatCompany,
  formatContact,
  formatConversation,
  formatConversationMessage,
  formatDeal,
  formatEngagement,
  formatList,
  formatPipeline,
  formatTask,
  formatTicket,
} from '../../src/lib';

describe('HubSpot formatters', () => {
  describe('formatContact', () => {
    it('formats a contact with all properties', () => {
      const contact = {
        id: '123',
        properties: {
          email: { value: 'test@example.com' },
          firstname: { value: 'John' },
          lastname: { value: 'Doe' },
          phone: { value: '+1234567890' },
          company: { value: 'Acme' },
          jobtitle: { value: 'Engineer' },
          website: { value: 'https://example.com' },
          lifecyclestage: { value: 'customer' },
          hs_lead_status: { value: 'OPEN' },
          createdate: { value: '1672531200000' },
          lastmodifieddate: { value: '1672617600000' },
        },
      };
      const result = formatContact(contact);
      expect(result.id).toBe('123');
      expect(result.email).toBe('test@example.com');
      expect(result.firstName).toBe('John');
      expect(result.lastName).toBe('Doe');
      expect(result.lifecycleStage).toBe('customer');
      expect(result.createdAt).toBe('2023-01-01T00:00:00.000Z');
    });

    it('handles missing properties gracefully', () => {
      const contact = { id: '456', properties: {} };
      const result = formatContact(contact);
      expect(result.id).toBe('456');
      expect(result.email).toBeNull();
      expect(result.firstName).toBeNull();
    });
  });

  describe('formatCompany', () => {
    it('formats a company', () => {
      const company = {
        id: '789',
        properties: {
          name: { value: 'Acme Inc' },
          domain: { value: 'acme.com' },
          industry: { value: 'Software' },
          numberofemployees: { value: '100' },
          annualrevenue: { value: '1000000' },
          createdate: { value: '1672531200000' },
          hs_lastmodifieddate: { value: '1672617600000' },
        },
      };
      const result = formatCompany(company);
      expect(result.name).toBe('Acme Inc');
      expect(result.domain).toBe('acme.com');
      expect(result.numberOfEmployees).toBe('100');
      expect(result.annualRevenue).toBe('1000000');
    });
  });

  describe('formatDeal', () => {
    it('formats a deal with amount', () => {
      const deal = {
        id: '101',
        properties: {
          dealname: { value: 'Big Deal' },
          amount: { value: '50000' },
          dealstage: { value: 'closedwon' },
          pipeline: { value: 'default' },
          createdate: { value: '1672531200000' },
          hs_lastmodifieddate: { value: '1672617600000' },
        },
      };
      const result = formatDeal(deal);
      expect(result.name).toBe('Big Deal');
      expect(result.amount).toBe(50000);
      expect(result.stage).toBe('closedwon');
    });
  });

  describe('formatTicket', () => {
    it('formats a ticket', () => {
      const ticket = {
        id: '202',
        properties: {
          subject: { value: 'Support request' },
          content: { value: 'Need help with login' },
          hs_ticket_priority: { value: 'HIGH' },
          createdate: { value: '1672531200000' },
        },
      };
      const result = formatTicket(ticket);
      expect(result.subject).toBe('Support request');
      expect(result.status).toBe('HIGH');
    });
  });

  describe('formatEngagement', () => {
    it('formats an email engagement', () => {
      const engagement = {
        id: '303',
        properties: {
          hs_email_subject: { value: 'Welcome email' },
          hs_email_text: { value: 'Hello there' },
          hs_email_status: { value: 'SENT' },
          hs_createdate: { value: '1672531200000' },
        },
      };
      const result = formatEngagement(engagement);
      expect(result.subject).toBe('Welcome email');
      expect(result.body).toBe('Hello there');
      expect(result.status).toBe('SENT');
    });
  });

  describe('formatPipeline', () => {
    it('formats a pipeline with stages', () => {
      const pipeline = {
        id: 'pipeline-1',
        label: 'Sales Pipeline',
        displayOrder: 0,
        active: true,
        stages: [
          { id: 'stage-1', label: 'New', displayOrder: 0, metadata: {} },
          { id: 'stage-2', label: 'Qualified', displayOrder: 1, metadata: {} },
        ],
      };
      const result = formatPipeline(pipeline);
      expect(result.id).toBe('pipeline-1');
      expect(result.label).toBe('Sales Pipeline');
      expect(result.stages).toHaveLength(2);
    });
  });

  describe('formatList', () => {
    it('formats a list from /search (size in additionalProperties, DYNAMIC)', () => {
      const list = {
        listId: '1001',
        name: 'VIP Contacts',
        processingType: 'DYNAMIC',
        objectTypeId: '0-1',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z',
        additionalProperties: { hs_list_size: '42' },
      };
      const result = formatList(list);
      expect(result.id).toBe('1001'); // listId is a string in v3
      expect(result.name).toBe('VIP Contacts');
      expect(result.processingType).toBe('DYNAMIC');
      expect(result.dynamic).toBe(true);
      expect(result.objectTypeId).toBe('0-1');
      expect(result.memberCount).toBe(42); // coerced from the string hs_list_size
    });

    it('formats a list from get-by-id (size top-level, STATIC alias → not dynamic)', () => {
      const list = {
        listId: '2002',
        name: 'Static segment',
        processingType: 'STATIC',
        size: 7,
      };
      const result = formatList(list);
      expect(result.id).toBe('2002');
      expect(result.processingType).toBe('STATIC');
      expect(result.dynamic).toBe(false);
      expect(result.memberCount).toBe(7);
    });
  });

  describe('formatAssociation', () => {
    it('formats an association', () => {
      const assoc = {
        id: 'assoc-1',
        fromObjectType: 'contacts',
        fromObjectId: '123',
        toObjectType: 'companies',
        toObjectId: '789',
        associationType: 'contact_to_company',
        associationCategory: 'HUBSPOT_DEFINED',
        associationTypeId: 1,
      };
      const result = formatAssociation(assoc);
      expect(result.fromObjectType).toBe('contacts');
      expect(result.toObjectType).toBe('companies');
    });
  });

  describe('formatConversation', () => {
    it('formats a conversation', () => {
      const conv = {
        id: 'conv-1',
        status: 'OPEN',
        channelId: 'channel-1',
        channelAccountId: 'account-1',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z',
        latestMessageTimestamp: '2023-01-02T00:00:00Z',
      };
      const result = formatConversation(conv);
      expect(result.id).toBe('conv-1');
      expect(result.status).toBe('OPEN');
    });
  });

  describe('formatConversationMessage', () => {
    it('formats a conversation message', () => {
      const msg = {
        id: 'msg-1',
        type: 'MESSAGE',
        text: 'Hello!',
        sender: { actorId: 'user-1', actorType: 'CONTACT', name: 'John', email: 'john@example.com' },
        recipients: [],
        createdAt: '2023-01-01T00:00:00Z',
        attachments: [],
      };
      const result = formatConversationMessage(msg);
      expect(result.text).toBe('Hello!');
      expect(result.sender?.name).toBe('John');
    });
  });

});

describe('HubSpot builders', () => {
  describe('buildProperties', () => {
    it('builds properties payload filtering undefined/null', () => {
      const payload = {
        email: 'test@example.com',
        firstname: 'John',
        lastname: undefined,
        phone: null,
        company: 'Acme',
      };
      const result = buildProperties(payload);
      expect(result.properties).toEqual({
        email: 'test@example.com',
        firstname: 'John',
        company: 'Acme',
      });
    });

    it('converts numbers to strings', () => {
      const payload = { amount: 50000, count: 0 };
      const result = buildProperties(payload);
      expect(result.properties).toEqual({ amount: '50000', count: '0' });
    });
  });

  describe('buildAssociations', () => {
    it('builds associations payload', () => {
      const result = buildAssociations('companies', ['789', '101']);
      expect(result.associations).toHaveLength(2);
      expect(result.associations[0].to.id).toBe('789');
      expect(result.associations[0].types[0].associationCategory).toBe('HUBSPOT_DEFINED');
    });

    it('uses custom association type when provided', () => {
      const result = buildAssociations('contacts', ['123'], 'contact_to_company');
      expect(result.associations[0].types[0].associationTypeId).toBe('contact_to_company');
    });
  });
});
