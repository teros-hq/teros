/**
 * QuickBooks Online response formatters.
 *
 * Transforms raw QuickBooks API responses into clean, curated shapes.
 * Extracted from src/index.ts for unit testing.
 */

// =============================================================================
// COMPANY INFO
// =============================================================================

export function formatCompanyInfo(data: any): Record<string, unknown> {
  const info = data?.QueryResponse?.CompanyInfo?.[0] ?? data?.CompanyInfo ?? data;

  const addr = info?.CompanyAddr;
  const legalAddr = info?.LegalAddr;

  return {
    id: info?.Id ?? null,
    name: info?.CompanyName ?? null,
    legalName: info?.LegalName ?? null,
    country: info?.Country ?? null,
    currency: info?.Currency?.value ?? null,
    fiscalYearStartMonth: info?.FiscalYearStartMonth ?? null,
    fiscalYearStartDay: info?.FiscalYearStartDay ?? null,
    taxFormName: info?.TaxFormName ?? null,
    taxFormType: info?.TaxFormType ?? null,
    address: addr
      ? {
          line1: addr?.Line1 ?? null,
          city: addr?.City ?? null,
          state: addr?.CountrySubDivisionCode ?? null,
          postalCode: addr?.PostalCode ?? null,
          country: addr?.Country ?? null,
        }
      : null,
    legalAddress: legalAddr
      ? {
          line1: legalAddr?.Line1 ?? null,
          city: legalAddr?.City ?? null,
          state: legalAddr?.CountrySubDivisionCode ?? null,
          postalCode: legalAddr?.PostalCode ?? null,
          country: legalAddr?.Country ?? null,
        }
      : null,
    email: info?.Email?.Address ?? null,
    phone: info?.PrimaryPhone?.FreeFormNumber ?? null,
    webAddr: info?.WebAddr?.URI ?? null,
    syncEnabled: info?.SyncEnabled ?? null,
    domain: info?.Domain ?? null,
    subscriptionStatus: info?.SubscriptionStatus ?? null,
  };
}

// =============================================================================
// CUSTOMER & VENDOR
// =============================================================================

export function formatCustomer(c: any): Record<string, unknown> {
  return {
    id: c?.Id ?? null,
    syncToken: c?.SyncToken ?? null,
    displayName: c?.DisplayName ?? null,
    companyName: c?.CompanyName ?? null,
    givenName: c?.GivenName ?? null,
    familyName: c?.FamilyName ?? null,
    active: c?.Active ?? null,
    fullyQualifiedName: c?.FullyQualifiedName ?? null,
    primaryEmail: c?.PrimaryEmailAddr?.Address ?? null,
    primaryPhone: c?.PrimaryPhone?.FreeFormNumber ?? c?.Phone ?? null,
    balance: c?.Balance ?? null,
    balanceWithJobs: c?.BalanceWithJobs ?? null,
    totalRevenue: c?.TotalRevenue ?? null,
    totalExpense: c?.TotalExpense ?? null,
    billAddr: c?.BillAddr
      ? {
          line1: c?.BillAddr?.Line1 ?? null,
          city: c?.BillAddr?.City ?? null,
          state: c?.BillAddr?.CountrySubDivisionCode ?? null,
          postalCode: c?.BillAddr?.PostalCode ?? null,
          country: c?.BillAddr?.Country ?? null,
        }
      : null,
    notes: c?.Notes ?? null,
    taxIdentifier: c?.TaxIdentifier ?? null,
    currency: c?.CurrencyRef?.value ?? null,
  };
}

export function formatVendor(v: any): Record<string, unknown> {
  return {
    id: v?.Id ?? null,
    syncToken: v?.SyncToken ?? null,
    displayName: v?.DisplayName ?? null,
    companyName: v?.CompanyName ?? null,
    givenName: v?.GivenName ?? null,
    familyName: v?.FamilyName ?? null,
    active: v?.Active ?? null,
    primaryEmail: v?.PrimaryEmailAddr?.Address ?? null,
    primaryPhone: v?.PrimaryPhone?.FreeFormNumber ?? v?.Phone ?? null,
    balance: v?.Balance ?? null,
    vendor1099: v?.Vendor1099 ?? null,
    billAddr: v?.BillAddr
      ? {
          line1: v?.BillAddr?.Line1 ?? null,
          city: v?.BillAddr?.City ?? null,
          state: v?.BillAddr?.CountrySubDivisionCode ?? null,
          postalCode: v?.BillAddr?.PostalCode ?? null,
          country: v?.BillAddr?.Country ?? null,
        }
      : null,
    webAddr: v?.WebAddr?.URI ?? null,
    notes: v?.Notes ?? null,
    currency: v?.CurrencyRef?.value ?? null,
  };
}

// =============================================================================
// QUERY HELPER
// =============================================================================

export function extractQueryResults(data: any, entityKey: string): any[] {
  const entities = data?.QueryResponse?.[entityKey];
  if (!entities) return [];
  return Array.isArray(entities) ? entities : [entities];
}

// =============================================================================
// INVOICE & PAYMENT
// =============================================================================

export function formatInvoiceLine(line: any): Record<string, unknown> {
  const salesDetail = line?.SalesItemLineDetail;
  return {
    id: line?.Id ?? null,
    amount: line?.Amount ?? null,
    detailType: line?.DetailType ?? null,
    description: line?.Description ?? null,
    ...(salesDetail
      ? {
          itemId: salesDetail?.ItemRef?.value ?? null,
          itemName: salesDetail?.ItemRef?.name ?? null,
          quantity: salesDetail?.Qty ?? null,
          unitPrice: salesDetail?.UnitPrice ?? null,
          taxCodeRef: salesDetail?.TaxCodeRef?.value ?? null,
        }
      : {}),
  };
}

export function formatInvoice(inv: any): Record<string, unknown> {
  const lines = Array.isArray(inv?.Line) ? inv.Line.map(formatInvoiceLine) : [];
  return {
    id: inv?.Id ?? null,
    syncToken: inv?.SyncToken ?? null,
    docNumber: inv?.DocNumber ?? null,
    txnDate: inv?.TxnDate ?? null,
    dueDate: inv?.DueDate ?? null,
    customerRef: inv?.CustomerRef
      ? {
          value: inv?.CustomerRef?.value ?? null,
          name: inv?.CustomerRef?.name ?? null,
        }
      : null,
    customerMemo: inv?.CustomerMemo?.value ?? null,
    billEmail: inv?.BillEmail?.Address ?? null,
    totalAmt: inv?.TotalAmt ?? null,
    balance: inv?.Balance ?? null,
    deposit: inv?.Deposit ?? null,
    applyTaxAfterDiscount: inv?.ApplyTaxAfterDiscount ?? null,
    printStatus: inv?.PrintStatus ?? null,
    emailStatus: inv?.EmailStatus ?? null,
    billAddr: inv?.BillAddr
      ? {
          line1: inv?.BillAddr?.Line1 ?? null,
          city: inv?.BillAddr?.City ?? null,
          state: inv?.BillAddr?.CountrySubDivisionCode ?? null,
          postalCode: inv?.BillAddr?.PostalCode ?? null,
          country: inv?.BillAddr?.Country ?? null,
        }
      : null,
    shipAddr: inv?.ShipAddr
      ? {
          line1: inv?.ShipAddr?.Line1 ?? null,
          city: inv?.ShipAddr?.City ?? null,
          state: inv?.ShipAddr?.CountrySubDivisionCode ?? null,
          postalCode: inv?.ShipAddr?.PostalCode ?? null,
          country: inv?.ShipAddr?.Country ?? null,
        }
      : null,
    salesTermRef: inv?.SalesTermRef?.value ?? null,
    currencyRef: inv?.CurrencyRef?.value ?? null,
    exchangeRate: inv?.ExchangeRate ?? null,
    privateNote: inv?.PrivateNote ?? null,
    lineItems: lines,
  };
}

export function formatPaymentLine(line: any): Record<string, unknown> {
  const linkedTxns = Array.isArray(line?.LinkedTxn) ? line.LinkedTxn : [];
  return {
    amount: line?.Amount ?? null,
    linkedTxns: linkedTxns.map((lt: any) => ({
      txnId: lt?.TxnId ?? null,
      txnType: lt?.TxnType ?? null,
    })),
  };
}

export function formatPayment(pmt: any): Record<string, unknown> {
  const lines = Array.isArray(pmt?.Line) ? pmt.Line.map(formatPaymentLine) : [];
  return {
    id: pmt?.Id ?? null,
    syncToken: pmt?.SyncToken ?? null,
    txnDate: pmt?.TxnDate ?? null,
    customerRef: pmt?.CustomerRef
      ? {
          value: pmt?.CustomerRef?.value ?? null,
          name: pmt?.CustomerRef?.name ?? null,
        }
      : null,
    totalAmt: pmt?.TotalAmt ?? null,
    unappliedAmt: pmt?.UnappliedAmt ?? null,
    paymentMethodRef: pmt?.PaymentMethodRef?.value ?? null,
    paymentMethodName: pmt?.PaymentMethodRef?.name ?? null,
    depositToAccountRef: pmt?.DepositToAccountRef?.value ?? null,
    currencyRef: pmt?.CurrencyRef?.value ?? null,
    exchangeRate: pmt?.ExchangeRate ?? null,
    privateNote: pmt?.PrivateNote ?? null,
    lineItems: lines,
  };
}

// =============================================================================
// BILL
// =============================================================================

export function formatBillLine(line: any): Record<string, unknown> {
  const expenseDetail = line?.AccountBasedExpenseLineDetail;
  return {
    id: line?.Id ?? null,
    amount: line?.Amount ?? null,
    detailType: line?.DetailType ?? null,
    description: line?.Description ?? null,
    ...(expenseDetail
      ? {
          accountId: expenseDetail?.AccountRef?.value ?? null,
          accountName: expenseDetail?.AccountRef?.name ?? null,
          taxCodeRef: expenseDetail?.TaxCodeRef?.value ?? null,
          billableStatus: expenseDetail?.BillableStatus ?? null,
          customerRef: expenseDetail?.CustomerRef?.value ?? null,
        }
      : {}),
  };
}

export function formatBill(bill: any): Record<string, unknown> {
  const lines = Array.isArray(bill?.Line) ? bill.Line.map(formatBillLine) : [];
  return {
    id: bill?.Id ?? null,
    syncToken: bill?.SyncToken ?? null,
    txnDate: bill?.TxnDate ?? null,
    dueDate: bill?.DueDate ?? null,
    vendorRef: bill?.VendorRef
      ? {
          value: bill?.VendorRef?.value ?? null,
          name: bill?.VendorRef?.name ?? null,
        }
      : null,
    totalAmt: bill?.TotalAmt ?? null,
    balance: bill?.Balance ?? null,
    payableAccountRef: bill?.APAccountRef?.value ?? null,
    currencyRef: bill?.CurrencyRef?.value ?? null,
    exchangeRate: bill?.ExchangeRate ?? null,
    privateNote: bill?.PrivateNote ?? null,
    docNumber: bill?.DocNumber ?? null,
    lineItems: lines,
  };
}

// =============================================================================
// ACCOUNT
// =============================================================================

export function formatAccount(acct: any): Record<string, unknown> {
  return {
    id: acct?.Id ?? null,
    syncToken: acct?.SyncToken ?? null,
    name: acct?.Name ?? null,
    fullyQualifiedName: acct?.FullyQualifiedName ?? null,
    accountType: acct?.AccountType ?? null,
    accountSubType: acct?.AccountSubType ?? null,
    classification: acct?.Classification ?? null,
    active: acct?.Active ?? null,
    currentBalance: acct?.CurrentBalance ?? null,
    currentBalanceWithSubAccounts: acct?.CurrentBalanceWithSubAccounts ?? null,
    currencyRef: acct?.CurrencyRef?.value ?? null,
    description: acct?.Description ?? null,
    subAccount: acct?.SubAccount ?? null,
    parentRef: acct?.ParentRef?.value ?? null,
    taxAccountRef: acct?.TaxAccountRef?.value ?? null,
    accountNumber: acct?.AcctNum ?? null,
    bankNumber: acct?.BankNum ?? null,
  };
}

// =============================================================================
// ITEM
// =============================================================================

export function formatItem(item: any): Record<string, unknown> {
  return {
    id: item?.Id ?? null,
    syncToken: item?.SyncToken ?? null,
    name: item?.Name ?? null,
    fullyQualifiedName: item?.FullyQualifiedName ?? null,
    type: item?.Type ?? null,
    active: item?.Active ?? null,
    subItem: item?.SubItem ?? null,
    parentRef: item?.ParentRef?.value ?? null,
    level: item?.Level ?? null,
    unitPrice: item?.UnitPrice ?? null,
    purchaseCost: item?.PurchaseCost ?? null,
    taxable: item?.Taxable ?? null,
    salesTaxCodeRef: item?.SalesTaxCodeRef?.value ?? null,
    purchaseTaxCodeRef: item?.PurchaseTaxCodeRef?.value ?? null,
    incomeAccountRef: item?.IncomeAccountRef?.value ?? null,
    incomeAccountName: item?.IncomeAccountRef?.name ?? null,
    expenseAccountRef: item?.ExpenseAccountRef?.value ?? null,
    expenseAccountName: item?.ExpenseAccountRef?.name ?? null,
    assetAccountRef: item?.AssetAccountRef?.value ?? null,
    description: item?.Description ?? null,
    purchaseDescription: item?.PurchaseDesc ?? null,
    trackQtyOnHand: item?.TrackQtyOnHand ?? null,
    qtyOnHand: item?.QtyOnHand ?? null,
    invStartDate: item?.InvStartDate ?? null,
    currencyRef: item?.CurrencyRef?.value ?? null,
    sku: item?.Sku ?? null,
  };
}

// =============================================================================
// REPORTS
// =============================================================================

export function formatReportHeader(header: any): Record<string, unknown> {
  return {
    reportName: header?.ReportName ?? null,
    time: header?.Time ?? null,
    startPeriod: header?.StartPeriod ?? null,
    endPeriod: header?.EndPeriod ?? null,
    currency: header?.Currency ?? null,
    option: header?.Option ?? null,
  };
}

export function formatReportColumns(columns: any): any[] {
  const cols = columns?.Column;
  if (!Array.isArray(cols)) return [];
  return cols.map((col: any) => ({
    title: col?.ColTitle ?? null,
    type: col?.ColType ?? null,
  }));
}

export function formatReportRows(rows: any): any[] {
  const rowArr = rows?.Row;
  if (!Array.isArray(rowArr)) return [];
  return rowArr.map((row: any) => {
    const result: Record<string, unknown> = {
      type: row?.type ?? null,
    };

    if (row?.Header?.ColData) {
      result.header = row.Header.ColData.map((cd: any) => ({
        value: cd?.value ?? null,
        id: cd?.id ?? null,
      }));
    }

    if (row?.ColData) {
      result.colData = row.ColData.map((cd: any) => ({
        value: cd?.value ?? null,
        id: cd?.id ?? null,
      }));
    }

    if (row?.Rows) {
      result.rows = formatReportRows(row.Rows);
    }

    if (row?.Summary?.ColData) {
      result.summary = row.Summary.ColData.map((cd: any) => ({
        value: cd?.value ?? null,
        id: cd?.id ?? null,
      }));
    }

    return result;
  });
}

export function formatReport(data: any): Record<string, unknown> {
  return {
    header: formatReportHeader(data?.Header),
    columns: formatReportColumns(data?.Columns),
    rows: formatReportRows(data?.Rows),
  };
}

export function extractPLSummary(data: any): Record<string, unknown> {
  const topRows = data?.Rows?.Row ?? [];
  let totalIncome: number | null = null;
  let totalExpenses: number | null = null;
  let netIncome: number | null = null;

  for (const row of topRows) {
    const colData = row?.Summary?.ColData ?? row?.Header?.ColData ?? [];
    const label = String(colData[0]?.value ?? '').toLowerCase();
    const amountStr = colData[1]?.value;
    const amount = amountStr != null ? parseFloat(amountStr) : null;

    if (/net\s*income/.test(label)) {
      netIncome = amount;
    } else if (/total\s*income/.test(label)) {
      totalIncome = amount;
    } else if (/total\s*cost\s*of\s*goods/.test(label)) {
      if (totalExpenses == null) totalExpenses = 0;
      if (amount != null) totalExpenses += amount;
    } else if (/total\s*expense/.test(label)) {
      if (totalExpenses == null) totalExpenses = 0;
      if (amount != null) totalExpenses += amount;
    }
  }

  return {
    totalIncome,
    totalExpenses,
    netIncome,
  };
}

export function extractAgingBuckets(data: any): Record<string, unknown> {
  const columns = data?.Columns?.Column ?? [];
  const summaryColData = data?.Rows?.Summary?.ColData ?? [];

  const buckets: Record<string, number | null> = {};

  for (let i = 1; i < columns.length; i++) {
    const label = String(columns[i]?.ColTitle ?? `column_${i}`).trim();
    const amountStr = summaryColData[i]?.value;
    const amount = amountStr != null ? parseFloat(amountStr) : null;
    buckets[label] = amount;
  }

  return {
    buckets,
  };
}
