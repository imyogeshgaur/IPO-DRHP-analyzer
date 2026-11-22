import React from 'react';
import { View } from 'react-native';
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
  DonutChart,
  GroupedBarChart,
  HorizontalBreakdownBars,
  SplitProgressBar,
  TrendLineChart,
} from '../src/components/SvgCharts';
import {
  findPressables,
  findPressableWithText,
  getAllText,
  mockPalette,
  sampleFinancialsData,
} from './testUtils';

describe('SvgCharts components', () => {
  describe('GroupedBarChart', () => {
    test('returns null when data is empty or has no active numeric series', async () => {
      let emptyRenderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        emptyRenderer = ReactTestRenderer.create(
          <GroupedBarChart data={[]} unitLabel="₹ Cr" colors={mockPalette} />,
        );
      });
      expect(emptyRenderer.toJSON()).toBeNull();

      let noSeriesRenderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        noSeriesRenderer = ReactTestRenderer.create(
          <GroupedBarChart
            data={[{ period: 'FY25' }]}
            unitLabel="₹ Cr"
            colors={mockPalette}
          />,
        );
      });
      expect(noSeriesRenderer.toJSON()).toBeNull();
    });

    test('renders legend, unit label, SVG bars, and switches selected fiscal year on chip press', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <GroupedBarChart
            data={sampleFinancialsData.series}
            unitLabel="₹ Million"
            colors={mockPalette}
          />,
        );
      });

      const initialTexts = getAllText(renderer);
      expect(initialTexts).toContain('Revenue');
      expect(initialTexts).toContain('EBITDA');
      expect(initialTexts).toContain('PAT');
      expect(initialTexts).toContain('₹ Million');
      // Defaults to the latest fiscal period (FY25)
      expect(initialTexts).toContain('Page 295');
      expect(initialTexts).toContain('66,525');

      // Negative PAT values in FY23/FY24 should use negative red fill
      const rects = renderer.root.findAllByType('Rect' as never);
      expect(rects.some((rect) => rect.props.fill === '#F87171')).toBe(true);

      // Select FY23 period chip and verify the selected summary strip updates
      const fy23Chip = findPressableWithText(renderer, 'FY23');
      await ReactTestRenderer.act(() => {
        fy23Chip.props.onPress();
      });

      const updatedTexts = getAllText(renderer);
      expect(updatedTexts).toContain('Page 294');
      expect(updatedTexts).toContain('37,880');
      expect(updatedTexts).toContain('-637');
    });

    test('updates SVG width when container layout changes', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <GroupedBarChart
            data={sampleFinancialsData.series}
            unitLabel="₹ Million"
            colors={mockPalette}
          />,
        );
      });

      const rootView = renderer.root.findAllByType(View)[0];
      await ReactTestRenderer.act(() => {
        rootView.props.onLayout({ nativeEvent: { layout: { width: 380 } } });
      });

      const svg = renderer.root.findByType('Svg' as never);
      expect(svg.props.width).toBe(380);
    });
  });

  describe('TrendLineChart', () => {
    test('returns null when fewer than 2 points exist or neither margin series has 2+ values', async () => {
      let shortRenderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        shortRenderer = ReactTestRenderer.create(
          <TrendLineChart
            data={[{ period: 'FY25', ebitdaMarginPct: 14.6 }]}
            colors={mockPalette}
          />,
        );
      });
      expect(shortRenderer.toJSON()).toBeNull();

      let sparseRenderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        sparseRenderer = ReactTestRenderer.create(
          <TrendLineChart
            data={[
              { period: 'FY24', ebitdaMarginPct: 12.4 },
              { period: 'FY25', patMarginPct: 4.5 },
            ]}
            colors={mockPalette}
          />,
        );
      });
      expect(sparseRenderer.toJSON()).toBeNull();
    });

    test('renders EBITDA and PAT margin curves, data points, and legend items', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <TrendLineChart
            data={sampleFinancialsData.series}
            colors={mockPalette}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('EBITDA Margin %');
      expect(texts).toContain('PAT Margin %');

      // 2 paths per series (area + stroke) = 4 Path elements
      const paths = renderer.root.findAllByType('Path' as never);
      expect(paths).toHaveLength(4);
      // 3 data points * 2 series = 6 Circle markers
      const circles = renderer.root.findAllByType('Circle' as never);
      expect(circles).toHaveLength(6);
    });

    test('renders only the series that has at least 2 data points', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <TrendLineChart
            data={[
              { period: 'FY24', ebitdaMarginPct: 10.5 },
              { period: 'FY25', ebitdaMarginPct: 15.2, patMarginPct: 5.0 },
            ]}
            colors={mockPalette}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('EBITDA Margin %');
      expect(texts).not.toContain('PAT Margin %');
      expect(renderer.root.findAllByType('Path' as never)).toHaveLength(2);
    });
  });

  describe('DonutChart', () => {
    test('returns null when total slice value is zero or negative', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <DonutChart
            slices={[{ label: 'High', value: 0, color: '#EF4444' }]}
            centerValue="0"
            centerLabel="Risks"
            colors={mockPalette}
          />,
        );
      });
      expect(renderer.toJSON()).toBeNull();
    });

    test('renders center metric, active arcs, and percentage legend while skipping zero slices', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <DonutChart
            slices={[
              { label: 'High', value: 3, color: '#EF4444' },
              { label: 'Medium', value: 1, color: '#F59E0B' },
              { label: 'Low', value: 0, color: '#3B82F6' },
            ]}
            centerValue="4"
            centerLabel="Risks"
            colors={mockPalette}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('4');
      expect(texts).toContain('Risks');
      expect(texts).toContain('High');
      expect(texts).toContain('75%');
      expect(texts).toContain('25%');
      expect(texts).toContain('0%');

      // 1 background track Circle + 2 non-zero slice Circles = 3
      const circles = renderer.root.findAllByType('Circle' as never);
      expect(circles).toHaveLength(3);
    });
  });

  describe('HorizontalBreakdownBars', () => {
    test('returns null when items array is empty', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <HorizontalBreakdownBars items={[]} colors={mockPalette} />,
        );
      });
      expect(renderer.toJSON()).toBeNull();
    });

    test('renders labels, values, sublabels, and calls onSelect when interactive', async () => {
      const onSelect = jest.fn();
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <HorizontalBreakdownBars
            items={[
              {
                id: 'ops',
                label: 'Operational',
                value: 4,
                valueLabel: '4',
                sublabel: '50%',
                color: '#3B82F6',
              },
              {
                id: 'reg',
                label: 'Regulatory',
                value: 2,
                valueLabel: '2',
              },
            ]}
            selectedId="ops"
            onSelect={onSelect}
            colors={mockPalette}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('Operational');
      expect(texts).toContain('4');
      expect(texts).toContain('50%');
      expect(texts).toContain('Regulatory');

      const regRow = findPressableWithText(renderer, 'Regulatory');
      await ReactTestRenderer.act(() => {
        regRow.props.onPress();
      });
      expect(onSelect).toHaveBeenCalledWith('reg');
    });

    test('renders non-pressable rows when onSelect is omitted', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <HorizontalBreakdownBars
            items={[
              { id: 'store', label: 'New Stores', value: 100, valueLabel: '₹100 Cr' },
            ]}
            colors={mockPalette}
          />,
        );
      });

      expect(findPressables(renderer)).toHaveLength(0);
      expect(getAllText(renderer)).toContain('New Stores');
      expect(getAllText(renderer)).toContain('₹100 Cr');
    });
  });

  describe('SplitProgressBar', () => {
    test('renders left and right labels, percentages, and optional value labels', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <SplitProgressBar
            leftLabel="Fresh Issue"
            leftValueLabel="₹2,150 Cr"
            leftPct={30}
            rightLabel="Offer for Sale"
            rightValueLabel="₹5,128 Cr"
            rightPct={70}
            colors={mockPalette}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('Fresh Issue (30.0%)');
      expect(texts).toContain('₹2,150 Cr');
      expect(texts).toContain('Offer for Sale (70.0%)');
      expect(texts).toContain('₹5,128 Cr');
    });
  });
});
