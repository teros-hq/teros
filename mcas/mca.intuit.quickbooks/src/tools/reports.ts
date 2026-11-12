import type { ToolConfig } from '@teros/mca-sdk';
import { quickbooksRequest } from '../lib/client';
import { formatReport, extractPLSummary, extractAgingBuckets } from '../lib/formatters';

export const reportProfitLoss: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Generate a QuickBooks Online Profit & Loss (Income Statement) report for a date range. Returns the full report (Header, Columns, Rows) plus a simplified summary with total income, total expenses, and net income. Supports cash or accrual accounting method.',
  parameters: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'Start date for the report period (ISO format, e.g. "2026-01-01").' },
      endDate: { type: 'string', description: 'End date for the report period (ISO format, e.g. "2026-09-30").' },
      accountingMethod: {
        type: 'string',
        enum: ['cash', 'accrual'],
        description: 'Accounting method: "cash" or "accrual". Default: "accrual".',
      },
    },
    required: ['startDate', 'endDate'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const startDate = a.startDate as string;
    const endDate = a.endDate as string;
    const method = (a.accountingMethod ?? 'accrual') as string;

    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
      accounting_method: method.charAt(0).toUpperCase() + method.slice(1),
    });

    const data = (await quickbooksRequest(
      `reports/ProfitAndLoss?${params.toString()}`,
      context,
      'GET',
    )) as any;

    return {
      ...formatReport(data),
      summary: extractPLSummary(data),
    };
  },
};

export const reportBalanceSheet: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Generate a QuickBooks Online Balance Sheet report as of a specific date. Shows assets, liabilities, and equity. Supports cash or accrual accounting method.',
  parameters: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'As-of date for the report (ISO format, e.g. "2026-09-30").' },
      accountingMethod: {
        type: 'string',
        enum: ['cash', 'accrual'],
        description: 'Accounting method: "cash" or "accrual". Default: "accrual".',
      },
    },
    required: ['date'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const date = a.date as string;
    const method = (a.accountingMethod ?? 'accrual') as string;

    const params = new URLSearchParams({
      date,
      accounting_method: method.charAt(0).toUpperCase() + method.slice(1),
    });

    const data = (await quickbooksRequest(
      `reports/BalanceSheet?${params.toString()}`,
      context,
      'GET',
    )) as any;

    return formatReport(data);
  },
};

export const reportCashFlow: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Generate a QuickBooks Online Cash Flow report for a date range. Shows operating, investing, and financing activities and the net change in cash.',
  parameters: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'Start date for the report period (ISO format, e.g. "2026-01-01").' },
      endDate: { type: 'string', description: 'End date for the report period (ISO format, e.g. "2026-09-30").' },
    },
    required: ['startDate', 'endDate'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const params = new URLSearchParams({
      start_date: a.startDate,
      end_date: a.endDate,
    });

    const data = (await quickbooksRequest(
      `reports/CashFlow?${params.toString()}`,
      context,
      'GET',
    )) as any;

    return formatReport(data);
  },
};

export const reportAgedReceivables: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Generate a QuickBooks Online Aged Receivables report as of a specific date. Shows outstanding customer balances grouped by aging buckets (Current, 1-30, 31-60, 61-90, 91+ days). Returns the full report plus a simplified aging summary with bucket totals.',
  parameters: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'As-of date for the report (ISO format, e.g. "2026-09-30").' },
    },
    required: ['date'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const params = new URLSearchParams({ date: a.date });

    const data = (await quickbooksRequest(
      `reports/AgedReceivables?${params.toString()}`,
      context,
      'GET',
    )) as any;

    return {
      ...formatReport(data),
      aging: extractAgingBuckets(data),
    };
  },
};

export const reportAgedPayables: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Generate a QuickBooks Online Aged Payables report as of a specific date. Shows outstanding vendor balances grouped by aging buckets (Current, 1-30, 31-60, 61-90, 91+ days). Returns the full report plus a simplified aging summary with bucket totals.',
  parameters: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'As-of date for the report (ISO format, e.g. "2026-09-30").' },
    },
    required: ['date'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const params = new URLSearchParams({ date: a.date });

    const data = (await quickbooksRequest(
      `reports/AgedPayables?${params.toString()}`,
      context,
      'GET',
    )) as any;

    return {
      ...formatReport(data),
      aging: extractAgingBuckets(data),
    };
  },
};

export const reportTrialBalance: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Generate a QuickBooks Online Trial Balance report for a date range. Lists all accounts with their debit and credit balances, showing that total debits equal total credits.',
  parameters: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'Start date for the report period (ISO format, e.g. "2026-01-01").' },
      endDate: { type: 'string', description: 'End date for the report period (ISO format, e.g. "2026-09-30").' },
    },
    required: ['startDate', 'endDate'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const params = new URLSearchParams({
      start_date: a.startDate,
      end_date: a.endDate,
    });

    const data = (await quickbooksRequest(
      `reports/TrialBalance?${params.toString()}`,
      context,
      'GET',
    )) as any;

    return formatReport(data);
  },
};

export const reportGeneralLedger: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Generate a QuickBooks Online General Ledger report for a date range. Shows all transactions posted to each account, with debit and credit amounts. Optionally filter by account type.',
  parameters: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'Start date for the report period (ISO format, e.g. "2026-01-01").' },
      endDate: { type: 'string', description: 'End date for the report period (ISO format, e.g. "2026-09-30").' },
      accountType: {
        type: 'string',
        enum: ['Bank', 'AccountsReceivable', 'OtherCurrentAsset', 'FixedAsset', 'OtherAsset', 'AccountsPayable', 'CreditCard', 'OtherCurrentLiability', 'LongTermLiability', 'Equity', 'Income', 'CostOfGoodsSold', 'Expense', 'OtherIncome', 'OtherExpense', 'NonPosting'],
        description: 'Optional account type filter. Valid values: Bank, AccountsReceivable, OtherCurrentAsset, FixedAsset, OtherAsset, AccountsPayable, CreditCard, OtherCurrentLiability, LongTermLiability, Equity, Income, CostOfGoodsSold, Expense, OtherIncome, OtherExpense, NonPosting.',
      },
    },
    required: ['startDate', 'endDate'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const params = new URLSearchParams({
      start_date: a.startDate,
      end_date: a.endDate,
    });

    if (a.accountType) {
      params.append('account_type', a.accountType);
    }

    const data = (await quickbooksRequest(
      `reports/GeneralLedger?${params.toString()}`,
      context,
      'GET',
    )) as any;

    return formatReport(data);
  },
};

export const reportCustomerBalance: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Generate a QuickBooks Online Customer Balance report for a date range. Shows outstanding balances for each customer, including total amount owed and aging information.',
  parameters: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'Start date for the report period (ISO format, e.g. "2026-01-01").' },
      endDate: { type: 'string', description: 'End date for the report period (ISO format, e.g. "2026-09-30").' },
    },
    required: ['startDate', 'endDate'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const params = new URLSearchParams({
      start_date: a.startDate,
      end_date: a.endDate,
    });

    const data = (await quickbooksRequest(
      `reports/CustomerBalance?${params.toString()}`,
      context,
      'GET',
    )) as any;

    return formatReport(data);
  },
};

export const reportSalesByCustomer: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Generate a QuickBooks Online Sales by Customer report for a date range. Shows total sales revenue broken down by customer, with subtotals and grand total.',
  parameters: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'Start date for the report period (ISO format, e.g. "2026-01-01").' },
      endDate: { type: 'string', description: 'End date for the report period (ISO format, e.g. "2026-09-30").' },
    },
    required: ['startDate', 'endDate'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const params = new URLSearchParams({
      start_date: a.startDate,
      end_date: a.endDate,
    });

    const data = (await quickbooksRequest(
      `reports/CustomerSales?${params.toString()}`,
      context,
      'GET',
    )) as any;

    return formatReport(data);
  },
};
