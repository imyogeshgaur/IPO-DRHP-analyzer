import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

jest.mock('react-native-svg', () => {
  const MockSvg = 'Svg';
  return {
    __esModule: true,
    default: MockSvg,
    Svg: MockSvg,
    Circle: 'Circle',
    Defs: 'Defs',
    G: 'G',
    Line: 'Line',
    LinearGradient: 'LinearGradient',
    Path: 'Path',
    Rect: 'Rect',
    Stop: 'Stop',
    Text: 'SvgText',
  };
});

import {
  CitedBulletCard,
  CollapsibleSources,
  FinancialsView,
  IpoView,
  KpiGrid,
  OverviewView,
  ReportInsightView,
  RisksView,
} from '../src/components/ReportVisuals';
import {
  findPressableWithText,
  getAllText,
  makeInsightResponse,
  mockPalette,
  sampleCitations,
  sampleFinancialsData,
  sampleIpoData,
  sampleOverviewData,
  sampleRisksData,
} from './testUtils';

describe('ReportVisuals components', () => {
  describe('ReportInsightView', () => {
    test('routes to overview, financials, risks, and ipo views with verified sources', async () => {
      const sections = ['overview', 'financials', 'risks', 'ipo'] as const;
      const expectedMarkers = {
        overview: 'Lenskart Solutions Limited',
        financials: 'Revenue & Profitability',
        risks: 'Risk Severity Breakdown',
        ipo: 'Offer Structure (Fresh Issue vs. OFS)',
      };

      for (const section of sections) {
        let renderer!: ReactTestRenderer.ReactTestRenderer;
        await ReactTestRenderer.act(() => {
          renderer = ReactTestRenderer.create(
            <ReportInsightView
              insight={makeInsightResponse(section)}
              colors={mockPalette}
              onRetry={jest.fn()}
            />,
          );
        });
        const texts = getAllText(renderer);
        expect(texts).toContain(expectedMarkers[section]);
        expect(texts).toContain('Verified Source Pages (2)');
      }
    });

    test('renders notice banner and retry button only when status is unavailable', async () => {
      const onRetry = jest.fn();
      let unavailableRenderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        unavailableRenderer = ReactTestRenderer.create(
          <ReportInsightView
            insight={makeInsightResponse('financials', {
              status: 'unavailable',
              notice: 'Financial tables could not be parsed cleanly.',
            })}
            colors={mockPalette}
            onRetry={onRetry}
          />,
        );
      });

      expect(getAllText(unavailableRenderer)).toContain(
        'Financial tables could not be parsed cleanly.',
      );
      const retryButton = findPressableWithText(
        unavailableRenderer,
        'Retry extraction',
      );
      await ReactTestRenderer.act(() => {
        retryButton.props.onPress();
      });
      expect(onRetry).toHaveBeenCalledTimes(1);

      let partialRenderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        partialRenderer = ReactTestRenderer.create(
          <ReportInsightView
            insight={makeInsightResponse('overview', {
              status: 'partial',
              notice: 'Partial overview extracted.',
            })}
            colors={mockPalette}
            onRetry={jest.fn()}
          />,
        );
      });
      expect(getAllText(partialRenderer)).toContain('Partial overview extracted.');
      expect(getAllText(partialRenderer)).not.toContain('Retry extraction');
    });
  });

  describe('FinancialsView', () => {
    test('renders basis, normalizes Cr KPIs to Mn when unit is Million, and renders charts and takeaways', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <FinancialsView data={sampleFinancialsData} colors={mockPalette} />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('Restated Consolidated');
      expect(texts).toContain('₹ Million');
      // '₹66,525 Cr' normalized to '₹66,525 Mn' because unit is Million
      expect(texts).toContain('₹66,525 Mn');
      expect(texts).toContain('Revenue & Profitability');
      expect(texts).toContain('Margin Trajectory');
      expect(texts).toContain('Key Financial Takeaways');
    });

    test('hides Margin Trajectory card when fewer than 2 margin points exist', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <FinancialsView
            data={{
              ...sampleFinancialsData,
              currency: 'USD',
              unit: 'Thousand',
              basis: undefined,
              series: [{ period: 'FY25', revenue: 100 }],
              highlights: [],
              kpis: [],
            }}
            colors={mockPalette}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('USD Thousand');
      expect(texts).toContain('Revenue & Profitability');
      expect(texts).not.toContain('Margin Trajectory');
      expect(texts).not.toContain('Key Financial Takeaways');
    });
  });

  describe('RisksView', () => {
    test('filters risks by severity chip and category bar, and clears category filter', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <RisksView data={sampleRisksData} colors={mockPalette} />,
        );
      });

      const initialTexts = getAllText(renderer);
      expect(initialTexts).toContain('Risk Severity Breakdown');
      expect(initialTexts).toContain('Exposure by Category');
      expect(initialTexts).toContain('Store lease renewals');
      expect(initialTexts).toContain('Foreign exchange volatility');

      // Filter by High severity
      const highChip = findPressableWithText(renderer, 'High (2)');
      await ReactTestRenderer.act(() => {
        highChip.props.onPress();
      });

      let texts = getAllText(renderer);
      expect(texts).toContain('Store lease renewals');
      expect(texts).toContain('Medical device licensing');
      expect(texts).not.toContain('Manufacturing disruption');
      expect(texts).not.toContain('Foreign exchange volatility');

      // Combine with Operational category filter
      const operationalBar = findPressableWithText(renderer, 'Operational');
      await ReactTestRenderer.act(() => {
        operationalBar.props.onPress();
      });

      texts = getAllText(renderer);
      expect(texts).toContain('Store lease renewals');
      expect(texts).not.toContain('Medical device licensing');
      expect(texts).toContain('Clear filter');

      // Clear category filter
      const clearLink = findPressableWithText(renderer, 'Clear filter');
      await ReactTestRenderer.act(() => {
        clearLink.props.onPress();
      });

      texts = getAllText(renderer);
      expect(texts).toContain('Medical device licensing');
      expect(texts).toContain('Tap to filter');
    });
  });

  describe('OverviewView', () => {
    test('renders company name, sector badge, KPIs, highlights, and strengths', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <OverviewView data={sampleOverviewData} colors={mockPalette} />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('Lenskart Solutions Limited');
      expect(texts).toContain('Omnichannel Eyewear Retail');
      expect(texts).toContain('Retail Stores');
      expect(texts).toContain('Business Model & Highlights');
      expect(texts).toContain('Competitive Strengths');
    });
  });

  describe('IpoView', () => {
    test('renders IPO snapshot, split progress bar, and Use of Proceeds breakdown', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <IpoView data={sampleIpoData} colors={mockPalette} />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('₹7,278 Cr');
      expect(texts).toContain('₹382 - ₹402');
      expect(texts).toContain('NSE · BSE');
      expect(texts).toContain('Fresh Issue (29.5%)');
      expect(texts).toContain('Offer for Sale (70.5%)');
      expect(texts).toContain('Objects of the Offer / Use of Proceeds');
      expect(texts).toContain('₹650 Crore');
      expect(texts).toContain('₹420 Cr');
      expect(texts).toContain('Disclosed');
    });

    test('renders fallback disclosure labels and fallback Fresh Issue / OFS boxes when percentages are absent', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <IpoView
            data={{
              summary: 'Issue details pending RHP.',
              freshIssueAmount: '₹1,000 Cr',
              listingExchanges: [],
              useOfProceeds: [],
            }}
            colors={mockPalette}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('Not disclosed in DRHP');
      expect(texts).toContain('To be decided (RHP)');
      expect(texts).toContain('₹1,000 Cr');
      expect(texts).toContain('Offer for Sale (OFS)');
      expect(texts).not.toContain('Objects of the Offer / Use of Proceeds');
    });
  });

  describe('KpiGrid', () => {
    test('renders page citations and hides placeholder deltas like N/A or --', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <KpiGrid
            items={[
              { label: 'Revenue', value: '₹100 Cr', delta: '+15%', trend: 'up', page: 10 },
              { label: 'Debt', value: '₹10 Cr', delta: '-5%', trend: 'down' },
              { label: 'Stores', value: '50', delta: 'N/A', trend: 'flat' },
              { label: 'Staff', value: '120', delta: '--' },
            ]}
            colors={mockPalette}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('p.10');
      expect(texts).toContain('+15%');
      expect(texts).toContain('-5%');
      expect(texts).not.toContain('N/A');
      expect(texts).not.toContain('--');
    });
  });

  describe('CitedBulletCard', () => {
    test('renders title, bullet items, and optional page citations', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <CitedBulletCard
            title="Key Highlights"
            items={[
              { text: 'First insight', page: 14 },
              { text: 'Second insight without page' },
            ]}
            accentColor={mockPalette.blue}
            colors={mockPalette}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('Key Highlights');
      expect(texts).toContain('First insight');
      expect(texts).toContain('Page 14');
      expect(texts).toContain('Second insight without page');
    });
  });

  describe('CollapsibleSources', () => {
    test('returns null when citations list is empty', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <CollapsibleSources citations={[]} colors={mockPalette} />,
        );
      });
      expect(renderer.toJSON()).toBeNull();
    });

    test('toggles expanded state to show and hide citation excerpts', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <CollapsibleSources citations={sampleCitations} colors={mockPalette} />,
        );
      });

      expect(getAllText(renderer)).toContain('Verified Source Pages (2)');
      expect(getAllText(renderer)).toContain('p.42');
      expect(getAllText(renderer)).toContain('Show');
      expect(getAllText(renderer)).not.toContain('Source excerpt');

      const toggleBtn = findPressableWithText(renderer, 'Show');
      await ReactTestRenderer.act(() => {
        toggleBtn.props.onPress();
      });

      const expandedTexts = getAllText(renderer);
      expect(expandedTexts).toContain('Hide');
      expect(expandedTexts).toContain('Page 42');
      expect(expandedTexts).toContain('Source excerpt');
      expect(expandedTexts).toContain(sampleCitations[0].text);

      const hideBtn = findPressableWithText(renderer, 'Hide');
      await ReactTestRenderer.act(() => {
        hideBtn.props.onPress();
      });
      expect(getAllText(renderer)).toContain('Show');
    });
  });
});
