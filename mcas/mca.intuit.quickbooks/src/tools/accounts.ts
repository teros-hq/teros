import type { ToolConfig } from '@teros/mca-sdk';
import { quickbooksRequest } from '../lib/client';
import { formatAccount, extractQueryResults } from '../lib/formatters';

export const listAccounts: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List QuickBooks Online accounts (chart of accounts) with optional filters. Filter by account type (Bank, Accounts Receivable, Other Current Asset, Fixed Asset, Other Asset, Accounts Payable, Credit Card, Other Current Liability, Long Term Liability, Equity, Income, Cost of Goods Sold, Expense, Other Income, Other Expense, Non Posting) or by classification (Asset, Liability, Equity, Revenue, Expense) and active status. Returns key account fields (Id, Name, AccountType, AccountSubType, CurrentBalance).',
  parameters: {
    type: 'object',
    properties: {
      accountType: {
        type: 'string',
        enum: [
          'Bank',
          'Accounts Receivable',
          'Other Current Asset',
          'Fixed Asset',
          'Other Asset',
          'Accounts Payable',
          'Credit Card',
          'Other Current Liability',
          'Long Term Liability',
          'Equity',
          'Income',
          'Cost of Goods Sold',
          'Expense',
          'Other Income',
          'Other Expense',
          'Non Posting',
        ],
        description: 'Filter by account type. Valid values: Bank, Accounts Receivable, Other Current Asset, Fixed Asset, Other Asset, Accounts Payable, Credit Card, Other Current Liability, Long Term Liability, Equity, Income, Cost of Goods Sold, Expense, Other Income, Other Expense, Non Posting.',
      },
      classification: {
        type: 'string',
        enum: ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'],
        description: 'Filter by account classification (broad category). Useful when you want all asset, liability, or equity accounts regardless of specific type.',
      },
      active: {
        type: 'boolean',
        description: 'Filter by active status. true = active only, false = inactive only.',
      },
      limit: { type: 'number', description: 'Maximum number of results to return (default: 50, max: 100).', default: 50, minimum: 1, maximum: 100 },
      offset: { type: 'number', description: 'Starting position for pagination (1-based, default: 1).', default: 1, minimum: 1 },
    },
  },
  handler: async (args, context) => {
    const a = args as any;
    const accountType = a.accountType as string | undefined;
    const classification = a.classification as string | undefined;
    const active = a.active as boolean | undefined;
    const limit = Math.min(Math.max(a.limit ?? 50, 1), 100);
    const offset = Math.max(a.offset ?? 1, 1);

    const conditions: string[] = [];
    if (accountType) {
      conditions.push(`AccountType = '${accountType.replace(/'/g, "''")}'`);
    }
    if (classification) {
      conditions.push(`Classification = '${classification.replace(/'/g, "''")}'`);
    }
    if (active !== undefined) {
      conditions.push(`Active = ${active}`);
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM Account${whereClause} ORDERBY Name STARTPOSITION ${offset} MAXRESULTS ${limit}`;
    const encodedQuery = encodeURIComponent(sql);

    const data = (await quickbooksRequest(`query?query=${encodedQuery}`, context, 'GET')) as any;
    const accounts = extractQueryResults(data, 'Account');
    const maxResults = data?.QueryResponse?.maxResults ?? accounts.length;
    const startPosition = data?.QueryResponse?.startPosition ?? offset;
    const totalCount = data?.QueryResponse?.totalCount ?? undefined;

    return {
      accounts: accounts.map(formatAccount),
      count: accounts.length,
      startPosition,
      maxResults,
      ...(totalCount !== undefined ? { totalCount } : {}),
    };
  },
};

export const getAccount: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Retrieve a single QuickBooks Online account by ID. Returns the full account object with type, subtype, balance, and SyncToken.',
  parameters: {
    type: 'object',
    properties: {
      accountId: { type: 'string', description: 'The QuickBooks account ID.' },
    },
    required: ['accountId'],
  },
  handler: async (args, context) => {
    const accountId = (args as any).accountId as string;
    const data = (await quickbooksRequest(`account/${accountId}`, context, 'GET')) as any;
    const account = data?.Account ?? data;
    return formatAccount(account);
  },
};

export const createAccount: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new QuickBooks Online account in the chart of accounts. Requires a name and account type (Bank, Accounts Receivable, Other Current Asset, Fixed Asset, Other Asset, Accounts Payable, Credit Card, Other Current Liability, Long Term Liability, Equity, Income, Cost of Goods Sold, Expense, Other Income, Other Expense, Non Posting). Optionally specify an account subtype and currency. Returns the created account with Id.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The name of the account (e.g. "Office Supplies").' },
      accountType: {
        type: 'string',
        enum: [
          'Bank',
          'Accounts Receivable',
          'Other Current Asset',
          'Fixed Asset',
          'Other Asset',
          'Accounts Payable',
          'Credit Card',
          'Other Current Liability',
          'Long Term Liability',
          'Equity',
          'Income',
          'Cost of Goods Sold',
          'Expense',
          'Other Income',
          'Other Expense',
          'Non Posting',
        ],
        description: 'The type of account. Valid values: Bank, Accounts Receivable, Other Current Asset, Fixed Asset, Other Asset, Accounts Payable, Credit Card, Other Current Liability, Long Term Liability, Equity, Income, Cost of Goods Sold, Expense, Other Income, Other Expense, Non Posting.',
      },
      accountSubType: { type: 'string', description: 'The account subtype (e.g. "SuppliesMaterialsCogs", "AccountsPayable", "AccountsReceivable").' },
      currency: { type: 'string', description: 'Currency code for the account (e.g. "USD", "EUR"). Defaults to the company currency.' },
      description: { type: 'string', description: 'Optional description for the account.' },
    },
    required: ['name', 'accountType'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const account: any = {
      Name: a.name,
      AccountType: a.accountType,
    };

    if (a.accountSubType) account.AccountSubType = a.accountSubType;
    if (a.currency) account.CurrencyRef = { value: a.currency };
    if (a.description) account.Description = a.description;

    const data = (await quickbooksRequest('account', context, 'POST', account)) as any;
    const created = data?.Account ?? data;
    return formatAccount(created);
  },
};
