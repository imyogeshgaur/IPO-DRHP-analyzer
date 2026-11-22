import { Text } from 'react-native';
import type {
  ReactTestInstance,
  ReactTestRenderer,
} from 'react-test-renderer';
import type { ChartPalette } from '../src/components/SvgCharts';
import type {
  Citation,
  DocumentInsightResponse,
  DocumentRecord,
  FinancialsInsightData,
  IpoInsightData,
  OverviewInsightData,
  QueryResponse,
  RisksInsightData,
} from '../src/types';

export const mockPalette: ChartPalette = {
  background: '#071126',
  surface: '#0D1A35',
  surfaceRaised: '#122242',
  text: '#F4F7FF',
  secondary: '#B7C3DD',
  muted: '#8190B0',
  border: '#243657',
  blue: '#2185FF',
  blueSoft: '#132F5A',
  green: '#38D69A',
  red: '#FF777B',
  input: '#101E3B',
};

export const sampleDocuments: DocumentRecord[] = [
  {
    documentId: '550e8400-e29b-41d4-a716-446655440001',
    filename: 'Lenskart-Solutions-DRHP.pdf',
    mediaType: 'application/pdf',
    status: 'ready',
    createdAt: '2026-11-10T10:00:00.000Z',
    updatedAt: '2026-11-10T10:05:00.000Z',
  },
  {
    documentId: '550e8400-e29b-41d4-a716-446655440002',
    filename: 'Acme_Tech_DRHP.pdf',
    mediaType: 'application/pdf',
    status: 'processing',
    createdAt: '2026-11-12T10:00:00.000Z',
    updatedAt: '2026-11-12T10:02:00.000Z',
  },
  {
    documentId: '550e8400-e29b-41d4-a716-446655440003',
    filename: 'Queued_Filing.pdf',
    mediaType: 'application/pdf',
    status: 'queued',
    createdAt: '2026-11-14T10:00:00.000Z',
    updatedAt: '2026-11-14T10:00:00.000Z',
  },
  {
    documentId: '550e8400-e29b-41d4-a716-446655440004',
    filename: 'Scanned_Copy.pdf',
    mediaType: 'application/pdf',
    status: 'failed',
    createdAt: '2026-11-15T10:00:00.000Z',
    updatedAt: '2026-11-15T10:01:00.000Z',
    error: {
      code: 'DRHP_OCR_REQUIRED',
      message: 'Document requires OCR before indexing.',
    },
  },
];

export const sampleCitations: Citation[] = [
  {
    chunkId: 'chunk-1',
    page: 42,
    text: 'Restated consolidated revenue from operations increased to 6,652.52 crore in FY25.',
    score: 0.91,
  },
  {
    chunkId: 'chunk-2',
    text: 'General prospectus disclosure without a specific physical page reference.',
    score: 0.78,
  },
];

export const sampleQueryResponse: QueryResponse = {
  question: 'What was FY25 revenue?',
  answer: 'Revenue from operations in FY25 was ₹6,652.52 crore.',
  citations: sampleCitations,
  ground_truth: null,
};

export const sampleOverviewData: OverviewInsightData = {
  companyName: 'Lenskart Solutions Limited',
  sector: 'Omnichannel Eyewear Retail',
  summary: 'Vertically integrated eyewear retailer operating across India and international markets.',
  keyMetrics: [
    { label: 'Retail Stores', value: '2,500+', delta: '+18% YoY', trend: 'up', page: 12 },
    { label: 'Countries', value: '5', delta: 'N/A', trend: 'flat' },
  ],
  businessHighlights: [
    { text: 'In-house lens manufacturing facility in Bhiwadi.', page: 18 },
    { text: 'Direct-to-consumer mobile and web storefront.' },
  ],
  strengths: [
    { text: 'Centralized automated supply chain reduces turnaround time.', page: 24 },
  ],
};

export const sampleFinancialsData: FinancialsInsightData = {
  currency: 'INR',
  unit: 'Million',
  basis: 'Restated Consolidated',
  summary: 'Strong revenue expansion with improving operating margins across FY23 to FY25.',
  kpis: [
    { label: 'FY25 Revenue', value: '₹66,525 Cr', delta: '+22.6%', trend: 'up', page: 294 },
    { label: 'FY25 PAT', value: '₹2,970 Mn', delta: '-4.2%', trend: 'down', page: 295 },
  ],
  series: [
    {
      period: 'FY23',
      revenue: 37880,
      ebitda: 2650,
      pat: -637,
      ebitdaMarginPct: 7.0,
      patMarginPct: -1.7,
      page: 294,
    },
    {
      period: 'FY24',
      revenue: 54277,
      ebitda: 6720,
      pat: -101,
      ebitdaMarginPct: 12.4,
      patMarginPct: -0.2,
      page: 294,
    },
    {
      period: 'FY25',
      revenue: 66525,
      ebitda: 9710,
      pat: 2970,
      ebitdaMarginPct: 14.6,
      patMarginPct: 4.5,
      page: 295,
    },
  ],
  highlights: [
    { text: 'EBITDA margin expanded by 760 bps over two fiscal years.', page: 294 },
  ],
};

export const sampleRisksData: RisksInsightData = {
  summary: 'Primary risks center on lease obligations, supplier concentration, and regulatory compliance.',
  severityCounts: { high: 2, medium: 1, low: 1 },
  categoryCounts: [
    { category: 'Operational', count: 2 },
    { category: 'Regulatory', count: 1 },
    { category: 'Financial', count: 1 },
  ],
  items: [
    {
      title: 'Store lease renewals',
      category: 'Operational',
      severity: 'high',
      impact: 'Higher rentals could compress store-level profitability.',
      page: 31,
    },
    {
      title: 'Manufacturing disruption',
      category: 'Operational',
      severity: 'medium',
      impact: 'Downtime at automated plants may delay order fulfillment.',
      page: 34,
    },
    {
      title: 'Medical device licensing',
      category: 'Regulatory',
      severity: 'high',
      impact: 'Changes in optical product norms may increase compliance costs.',
      page: 38,
    },
    {
      title: 'Foreign exchange volatility',
      category: 'Financial',
      severity: 'low',
      impact: 'Currency movements affect imported frame costs.',
      page: 45,
    },
  ],
};

export const sampleIpoData: IpoInsightData = {
  summary: 'Book-built issue comprising a fresh equity issue and an offer for sale.',
  currency: 'INR',
  unit: 'Crore',
  issueSize: '₹7,278 Cr',
  freshIssueAmount: '₹2,150 Cr',
  ofsAmount: '₹5,128 Cr',
  freshIssuePct: 29.5,
  ofsPct: 70.5,
  priceBand: '₹382 - ₹402',
  faceValue: '₹2',
  listingExchanges: ['NSE', 'BSE'],
  useOfProceeds: [
    { purpose: 'New CoCo stores setup', amount: 650, percentage: 30.2, page: 88 },
    { purpose: 'Technology & cloud infrastructure', amountLabel: '₹420 Cr', percentage: 19.5, page: 89 },
    { purpose: 'General corporate purposes', page: 91 },
  ],
};

export function makeInsightResponse(
  section: DocumentInsightResponse['section'],
  overrides: Partial<DocumentInsightResponse> = {},
): DocumentInsightResponse {
  const base = {
    documentId: sampleDocuments[0].documentId,
    status: 'ready' as const,
    generatedAt: '2026-11-10T10:10:00.000Z',
    citations: sampleCitations,
  };
  if (section === 'financials') {
    return { ...base, section, data: sampleFinancialsData, ...overrides } as DocumentInsightResponse;
  }
  if (section === 'risks') {
    return { ...base, section, data: sampleRisksData, ...overrides } as DocumentInsightResponse;
  }
  if (section === 'overview') {
    return { ...base, section, data: sampleOverviewData, ...overrides } as DocumentInsightResponse;
  }
  return { ...base, section: 'ipo', data: sampleIpoData, ...overrides } as DocumentInsightResponse;
}

export function extractNodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : extractNodeText(child)))
    .join('');
}

export function getAllText(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map((node) => extractNodeText(node));
}

export function findPressables(
  renderer: ReactTestRenderer,
): ReactTestInstance[] {
  return renderer.root.findAll(
    (node) =>
      typeof node.props.onPress === 'function' &&
      typeof node.type !== 'string',
  );
}

export function findPressableWithText(
  renderer: ReactTestRenderer,
  matcher: string | RegExp,
): ReactTestInstance {
  const matches = renderer.root.findAll((node) => {
    if (typeof node.props.onPress !== 'function') return false;
    const text = extractNodeText(node);
    return typeof matcher === 'string'
      ? text.includes(matcher)
      : matcher.test(text);
  });
  if (matches.length === 0) {
    throw new Error(`No pressable found matching ${String(matcher)}`);
  }
  // Return the innermost matching pressable so outer wrapper containers are not selected.
  return matches[matches.length - 1];
}

export function findPressableByLabel(
  renderer: ReactTestRenderer,
  accessibilityLabel: string,
): ReactTestInstance {
  const matches = renderer.root.findAll(
    (node) =>
      node.props.accessibilityLabel === accessibilityLabel &&
      typeof node.props.onPress === 'function',
  );
  if (matches.length === 0) {
    throw new Error(`No pressable found with label "${accessibilityLabel}"`);
  }
  return matches[matches.length - 1];
}
