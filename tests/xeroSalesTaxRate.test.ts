// Choosing the 20% VAT rate for SALES invoice lines. Field shapes follow Xero's OpenAPI TaxRate schema (no field is required, so
// any may be absent) and Xero's own example response: built-in purchase rate INPUT2 / ReportTaxType INPUT / CanApplyToRevenue
// false; built-in sales rate OUTPUT2 / ReportTaxType OUTPUT / CanApplyToRevenue true; custom rates get TaxTypes like TAX001.
//
// The case that prompted this: Luke's organisation has "20% (VAT on Expenses)", "20% (VAT on Income)" and a custom
// "JOBBER-1011369 VAT" (20%), and the old matcher reported "2 active 20% sales tax rates" and refused to invoice.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILT_IN_UK_SALES_TAX_TYPE,
  classifyTaxRate,
  describeTaxRateProblem,
  find20PercentSalesTaxRate,
  isCustomTaxType,
  type XeroTaxRate,
} from '../supabase/functions/_shared/xeroClient';

const VAT_ON_INCOME: XeroTaxRate = { Name: '20% (VAT on Income)', TaxType: 'OUTPUT2', ReportTaxType: 'OUTPUT', CanApplyToRevenue: true, DisplayTaxRate: 20, Status: 'ACTIVE' };
const VAT_ON_EXPENSES: XeroTaxRate = { Name: '20% (VAT on Expenses)', TaxType: 'INPUT2', ReportTaxType: 'INPUT', CanApplyToRevenue: false, DisplayTaxRate: 20, Status: 'ACTIVE' };
const JOBBER: XeroTaxRate = { Name: 'JOBBER-1011369 VAT', TaxType: 'TAX001', ReportTaxType: 'OUTPUT', CanApplyToRevenue: true, DisplayTaxRate: 20, Status: 'ACTIVE' };
const OTHER_CUSTOM: XeroTaxRate = { Name: 'Other app VAT', TaxType: 'TAX002', ReportTaxType: 'OUTPUT', CanApplyToRevenue: true, DisplayTaxRate: 20, Status: 'ACTIVE' };
const LUKE = [VAT_ON_EXPENSES, VAT_ON_INCOME, JOBBER];

const chosen = (rates: XeroTaxRate[]) => {
  const r = find20PercentSalesTaxRate(rates);
  return r.outcome === 'found' ? r.taxRate.taxType : r.outcome;
};

test("LUKE'S CASE: VAT on Income is chosen alongside JOBBER-1011369 VAT and VAT on Expenses", () => {
  const r = find20PercentSalesTaxRate(LUKE);
  assert.equal(r.outcome, 'found');
  assert.deepEqual(r.outcome === 'found' && r.taxRate, { taxType: 'OUTPUT2', name: '20% (VAT on Income)', displayTaxRate: 20, status: 'ACTIVE' });
  assert.equal(chosen([JOBBER, VAT_ON_INCOME]), 'OUTPUT2', 'order does not matter');
  assert.equal(BUILT_IN_UK_SALES_TAX_TYPE, 'OUTPUT2');
});

test('PURCHASE-ONLY rates are never sales candidates: CanApplyToRevenue false, or any INPUT report type', () => {
  assert.equal(classifyTaxRate(VAT_ON_EXPENSES), 'purchase');
  assert.equal(classifyTaxRate({ ...VAT_ON_EXPENSES, CanApplyToRevenue: undefined }), 'purchase', 'ReportTaxType INPUT alone is enough');
  assert.equal(classifyTaxRate({ ...VAT_ON_EXPENSES, ReportTaxType: undefined }), 'purchase', 'CanApplyToRevenue false alone is enough');
  assert.equal(classifyTaxRate({ ...VAT_ON_INCOME, ReportTaxType: 'ECINPUT' }), 'purchase');
  assert.equal(chosen([VAT_ON_EXPENSES]), 'not_found');
  assert.equal(chosen([VAT_ON_EXPENSES, { ...VAT_ON_EXPENSES, Name: 'Another purchase', TaxType: 'TAX009' }, VAT_ON_INCOME]), 'OUTPUT2');
});

test('MISSING CLASSIFICATION: a missing CanApplyToRevenue or ReportTaxType never counts as sales', () => {
  assert.equal(classifyTaxRate({ ...VAT_ON_INCOME, CanApplyToRevenue: undefined }), 'unclassified');
  assert.equal(classifyTaxRate({ ...VAT_ON_INCOME, ReportTaxType: undefined }), 'unclassified');
  assert.equal(classifyTaxRate({ ...VAT_ON_INCOME, ReportTaxType: '  ' }), 'unclassified');
  // The built-in rate itself, without its classification: refused, with the reason - not chosen on its TaxType alone.
  const r = find20PercentSalesTaxRate([{ ...VAT_ON_INCOME, ReportTaxType: undefined }, VAT_ON_EXPENSES]);
  assert.equal(r.outcome, 'ambiguous');
  assert.match(r.outcome === 'ambiguous' ? r.reason : '', /built-in 20% sales rate \(OUTPUT2\) did not come back classified as a sales rate/);
  // A confirmed built-in rate is still chosen when ANOTHER rate is unclassified.
  assert.equal(chosen([VAT_ON_INCOME, { ...JOBBER, ReportTaxType: undefined, CanApplyToRevenue: undefined }]), 'OUTPUT2');
});

test('CUSTOM rates are never chosen automatically - alone, or several of them - because they are active or unused', () => {
  const alone = find20PercentSalesTaxRate([JOBBER, VAT_ON_EXPENSES]);
  assert.equal(alone.outcome, 'ambiguous');
  assert.match(alone.outcome === 'ambiguous' ? alone.reason : '', /built-in 20% sales rate \(OUTPUT2\) was not found, and a custom rate is never chosen automatically/);
  assert.equal(chosen([JOBBER, OTHER_CUSTOM]), 'ambiguous');
  assert.equal(isCustomTaxType('TAX001'), true);
  assert.equal(isCustomTaxType('OUTPUT2'), false);
});

test('a single NON-custom sales rate is accepted when there is no OUTPUT2 and nothing else is unclear (other regions\' built-ins)', () => {
  const other = { Name: 'Sales tax 20%', TaxType: 'OUTPUT', ReportTaxType: 'OUTPUT', CanApplyToRevenue: true, DisplayTaxRate: 20, Status: 'ACTIVE' };
  assert.equal(chosen([other, VAT_ON_EXPENSES]), 'OUTPUT');
  assert.equal(chosen([other, OTHER_CUSTOM]), 'ambiguous', 'but not when another rate could also apply');
  assert.equal(chosen([other, { ...JOBBER, ReportTaxType: undefined }]), 'ambiguous', 'or when another rate is unclassified');
});

test('only ACTIVE rates at 20% are considered; a duplicate built-in rate is refused', () => {
  assert.equal(chosen([{ ...VAT_ON_INCOME, Status: 'ARCHIVED' }, JOBBER]), 'ambiguous', 'an archived built-in rate does not count');
  assert.equal(chosen([{ ...JOBBER, Status: 'DELETED' }, VAT_ON_INCOME]), 'OUTPUT2');
  assert.equal(chosen([{ ...VAT_ON_INCOME, DisplayTaxRate: 5 }]), 'not_found');
  assert.equal(chosen([{ ...VAT_ON_INCOME, DisplayTaxRate: undefined }]), 'not_found');
  assert.equal(chosen([VAT_ON_INCOME, { ...VAT_ON_INCOME, Name: 'Copy' }]), 'ambiguous');
  assert.equal(chosen([]), 'not_found');
});

test('DIAGNOSTIC: lists every active 20% rate with TaxType, ReportTaxType and CanApplyToRevenue; says nothing was created', () => {
  const r = find20PercentSalesTaxRate([JOBBER, OTHER_CUSTOM, { ...VAT_ON_EXPENSES, ReportTaxType: undefined }]);
  assert.equal(r.outcome, 'ambiguous');
  const message = describeTaxRateProblem(r as Exclude<typeof r, { outcome: 'found' }>);
  assert.match(message, /^The 20% sales VAT rate could not be chosen safely, so nothing was created or changed in Xero\./);
  assert.match(message, /JOBBER-1011369 VAT \(TaxType TAX001, ReportTaxType OUTPUT, CanApplyToRevenue true\)/);
  assert.match(message, /Other app VAT \(TaxType TAX002, ReportTaxType OUTPUT, CanApplyToRevenue true\)/);
  assert.match(message, /20% \(VAT on Expenses\) \(TaxType INPUT2, ReportTaxType not provided, CanApplyToRevenue false\)/);
  const none = find20PercentSalesTaxRate([VAT_ON_EXPENSES]);
  assert.match(describeTaxRateProblem(none as Exclude<typeof none, { outcome: 'found' }>), /^No active 20% sales VAT rate found in this Xero organisation, so nothing was created or changed in Xero\. Active 20% rates in Xero: 20% \(VAT on Expenses\)/);
  const empty = find20PercentSalesTaxRate([]);
  assert.match(describeTaxRateProblem(empty as Exclude<typeof empty, { outcome: 'found' }>), /Xero returned no active 20% rates\./);
});

test('DIAGNOSTIC: only names and codes - the result carries nothing else from the rate', () => {
  const r = find20PercentSalesTaxRate([JOBBER, OTHER_CUSTOM]);
  for (const c of r.candidates) assert.deepEqual(Object.keys(c).sort(), ['canApplyToRevenue', 'classification', 'name', 'reportTaxType', 'taxType']);
});
