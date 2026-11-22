import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  Rect,
  Stop,
  Text as SvgText,
} from "react-native-svg";

export type ChartPalette = {
  background: string;
  surface: string;
  surfaceRaised: string;
  text: string;
  secondary: string;
  muted: string;
  border: string;
  blue: string;
  blueSoft: string;
  green: string;
  red: string;
  input: string;
};

export type GroupedBarDatum = {
  period: string;
  revenue?: number;
  ebitda?: number;
  pat?: number;
  page?: number;
};

const SERIES_COLORS = {
  revenue: "#3B82F6",
  ebitda: "#14B8A6",
  pat: "#F59E0B",
  negative: "#F87171",
};

function formatCompact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(2)}K`;
  if (Number.isInteger(abs)) return `${sign}${abs}`;
  return `${sign}${abs.toFixed(1)}`;
}

function formatFull(value: number): string {
  return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

export function GroupedBarChart(props: {
  data: GroupedBarDatum[];
  unitLabel: string;
  colors: ChartPalette;
}) {
  const [chartWidth, setChartWidth] = useState(310);
  const [selectedIndex, setSelectedIndex] = useState(
    Math.max(0, props.data.length - 1),
  );

  const activeSeries = useMemo(() => {
    const keys: Array<{ key: "revenue" | "ebitda" | "pat"; label: string; color: string }> = [];
    if (props.data.some((d) => d.revenue !== undefined)) {
      keys.push({ key: "revenue", label: "Revenue", color: SERIES_COLORS.revenue });
    }
    if (props.data.some((d) => d.ebitda !== undefined)) {
      keys.push({ key: "ebitda", label: "EBITDA", color: SERIES_COLORS.ebitda });
    }
    if (props.data.some((d) => d.pat !== undefined)) {
      keys.push({ key: "pat", label: "PAT", color: SERIES_COLORS.pat });
    }
    return keys;
  }, [props.data]);

  const safeIndex = Math.min(selectedIndex, Math.max(0, props.data.length - 1));
  const selected = props.data[safeIndex];

  if (props.data.length === 0 || activeSeries.length === 0) {
    return null;
  }

  const allValues = props.data.flatMap((d) =>
    activeSeries
      .map((s) => d[s.key])
      .filter((v): v is number => v !== undefined && Number.isFinite(v)),
  );
  const rawMax = Math.max(0, ...allValues);
  const rawMin = Math.min(0, ...allValues);
  const span = Math.max(1, rawMax - rawMin);
  const paddedMax = rawMax > 0 ? rawMax + span * 0.14 : 0;
  const paddedMin = rawMin < 0 ? rawMin - span * 0.14 : 0;
  const totalRange = Math.max(1, paddedMax - paddedMin);

  const chartHeight = 196;
  const padLeft = 44;
  const padRight = 12;
  const padTop = 16;
  const padBottom = 30;
  const plotW = Math.max(180, chartWidth - padLeft - padRight);
  const plotH = chartHeight - padTop - padBottom;

  const yForValue = (val: number) =>
    padTop + ((paddedMax - val) / totalRange) * plotH;
  const zeroY = yForValue(0);

  const gridCount = 4;
  const gridTicks = Array.from({ length: gridCount + 1 }, (_, idx) => {
    const value = paddedMin + (totalRange * idx) / gridCount;
    return { value, y: yForValue(value) };
  });

  const groupWidth = plotW / props.data.length;
  const barGap = 4;
  const maxBarWidth = 22;
  const barWidth = Math.min(
    maxBarWidth,
    Math.max(
      7,
      (groupWidth - 18 - barGap * (activeSeries.length - 1)) /
        activeSeries.length,
    ),
  );
  const groupBarsWidth =
    activeSeries.length * barWidth + (activeSeries.length - 1) * barGap;

  return (
    <View
      onLayout={(event) => {
        const w = Math.floor(event.nativeEvent.layout.width);
        if (w > 120 && Math.abs(w - chartWidth) > 2) setChartWidth(w);
      }}
    >
      <View style={styles.legendRow}>
        {activeSeries.map((series) => (
          <View key={series.key} style={styles.legendItem}>
            <View
              style={[styles.legendDot, { backgroundColor: series.color }]}
            />
            <Text style={[styles.legendText, { color: props.colors.secondary }]}>
              {series.label}
            </Text>
          </View>
        ))}
        <Text style={[styles.unitBadge, { color: props.colors.muted }]}>
          {props.unitLabel}
        </Text>
      </View>

      <Svg width={chartWidth} height={chartHeight}>
        {gridTicks.map((tick, idx) => (
          <G key={idx}>
            <Line
              x1={padLeft}
              y1={tick.y}
              x2={chartWidth - padRight}
              y2={tick.y}
              stroke={props.colors.border}
              strokeWidth={1}
              strokeDasharray="3,4"
              opacity={0.7}
            />
            <SvgText
              x={padLeft - 6}
              y={tick.y + 4}
              fontSize={10}
              fill={props.colors.muted}
              textAnchor="end"
            >
              {formatCompact(tick.value)}
            </SvgText>
          </G>
        ))}

        <Line
          x1={padLeft}
          y1={zeroY}
          x2={chartWidth - padRight}
          y2={zeroY}
          stroke={props.colors.muted}
          strokeWidth={1}
          opacity={0.55}
        />

        {props.data.map((datum, groupIdx) => {
          const groupCenterX = padLeft + groupWidth * (groupIdx + 0.5);
          const startX = groupCenterX - groupBarsWidth / 2;
          const isSelected = groupIdx === safeIndex;

          return (
            <G key={`${datum.period}-${groupIdx}`}>
              {isSelected ? (
                <Rect
                  x={padLeft + groupWidth * groupIdx + 3}
                  y={padTop - 4}
                  width={Math.max(0, groupWidth - 6)}
                  height={plotH + 8}
                  rx={10}
                  fill={props.colors.blueSoft}
                  opacity={0.35}
                />
              ) : null}

              {activeSeries.map((series, seriesIdx) => {
                const val = datum[series.key];
                if (val === undefined) return null;
                const valY = yForValue(val);
                const topY = Math.min(valY, zeroY);
                const barHeight = Math.max(3, Math.abs(zeroY - valY));
                const x = startX + seriesIdx * (barWidth + barGap);
                const fill =
                  val < 0 ? SERIES_COLORS.negative : series.color;
                return (
                  <Rect
                    key={series.key}
                    x={x}
                    y={topY}
                    width={barWidth}
                    height={barHeight}
                    rx={4}
                    fill={fill}
                    opacity={isSelected ? 1 : 0.78}
                  />
                );
              })}

              <SvgText
                x={groupCenterX}
                y={chartHeight - 9}
                fontSize={11}
                fontWeight={isSelected ? "700" : "500"}
                fill={isSelected ? props.colors.text : props.colors.secondary}
                textAnchor="middle"
              >
                {datum.period}
              </SvgText>
            </G>
          );
        })}
      </Svg>

      <View style={styles.periodPickerRow}>
        {props.data.map((datum, idx) => {
          const active = idx === safeIndex;
          return (
            <Pressable
              key={`${datum.period}-${idx}`}
              onPress={() => setSelectedIndex(idx)}
              style={[
                styles.periodChip,
                {
                  backgroundColor: active
                    ? props.colors.blueSoft
                    : props.colors.surfaceRaised,
                  borderColor: active
                    ? props.colors.blue
                    : props.colors.border,
                },
              ]}
            >
              <Text
                style={[
                  styles.periodChipText,
                  {
                    color: active ? props.colors.blue : props.colors.secondary,
                  },
                ]}
              >
                {datum.period}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {selected ? (
        <View
          style={[
            styles.selectedStrip,
            {
              backgroundColor: props.colors.surfaceRaised,
              borderColor: props.colors.border,
            },
          ]}
        >
          <View style={styles.selectedHeaderRow}>
            <Text style={[styles.selectedPeriod, { color: props.colors.text }]}>
              {selected.period}
            </Text>
            {selected.page ? (
              <Text style={[styles.selectedPage, { color: props.colors.blue }]}>
                Page {selected.page}
              </Text>
            ) : null}
          </View>
          <View style={styles.selectedMetricsRow}>
            {activeSeries.map((series) => {
              const val = selected[series.key];
              if (val === undefined) return null;
              return (
                <View key={series.key} style={styles.selectedMetricCell}>
                  <Text
                    style={[
                      styles.selectedMetricLabel,
                      { color: props.colors.muted },
                    ]}
                  >
                    {series.label}
                  </Text>
                  <Text
                    style={[
                      styles.selectedMetricValue,
                      {
                        color:
                          val < 0 ? SERIES_COLORS.negative : props.colors.text,
                      },
                    ]}
                  >
                    {formatFull(val)}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      ) : null}
    </View>
  );
}

export type MarginPoint = {
  period: string;
  ebitdaMarginPct?: number;
  patMarginPct?: number;
};

export function TrendLineChart(props: {
  data: MarginPoint[];
  colors: ChartPalette;
}) {
  const [chartWidth, setChartWidth] = useState(310);

  const hasEbitda = props.data.filter((d) => d.ebitdaMarginPct !== undefined).length >= 2;
  const hasPat = props.data.filter((d) => d.patMarginPct !== undefined).length >= 2;

  if (props.data.length < 2 || (!hasEbitda && !hasPat)) {
    return null;
  }

  const values = props.data.flatMap((d) =>
    [d.ebitdaMarginPct, d.patMarginPct].filter(
      (v): v is number => v !== undefined && Number.isFinite(v),
    ),
  );
  const minVal = Math.min(0, ...values);
  const maxVal = Math.max(10, ...values);
  const span = Math.max(10, maxVal - minVal);
  const paddedMax = maxVal + span * 0.18;
  const paddedMin = minVal < 0 ? minVal - span * 0.15 : 0;
  const range = Math.max(1, paddedMax - paddedMin);

  const chartHeight = 168;
  const padLeft = 42;
  const padRight = 22;
  const padTop = 18;
  const padBottom = 28;
  const plotW = Math.max(180, chartWidth - padLeft - padRight);
  const plotH = chartHeight - padTop - padBottom;

  const xFor = (idx: number) =>
    props.data.length === 1
      ? padLeft + plotW / 2
      : padLeft + (idx / (props.data.length - 1)) * plotW;
  const yFor = (val: number) => padTop + ((paddedMax - val) / range) * plotH;

  const buildPath = (key: "ebitdaMarginPct" | "patMarginPct") => {
    const pts = props.data
      .map((d, idx) => {
        const val = d[key];
        return val === undefined ? null : { x: xFor(idx), y: yFor(val), val };
      })
      .filter((p): p is { x: number; y: number; val: number } => p !== null);
    if (pts.length < 2) return null;
    const linePath = pts
      .map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(" ");
    const baselineY = yFor(Math.max(0, paddedMin));
    const areaPath = `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${baselineY.toFixed(1)} L ${pts[0].x.toFixed(1)} ${baselineY.toFixed(1)} Z`;
    return { pts, linePath, areaPath };
  };

  const ebitdaLine = hasEbitda ? buildPath("ebitdaMarginPct") : null;
  const patLine = hasPat ? buildPath("patMarginPct") : null;

  const ticks = [0, 0.5, 1].map((ratio) => {
    const val = paddedMin + range * ratio;
    return { val, y: yFor(val) };
  });

  return (
    <View
      onLayout={(event) => {
        const w = Math.floor(event.nativeEvent.layout.width);
        if (w > 120 && Math.abs(w - chartWidth) > 2) setChartWidth(w);
      }}
    >
      <View style={styles.legendRow}>
        {ebitdaLine ? (
          <View style={styles.legendItem}>
            <View
              style={[
                styles.legendDot,
                { backgroundColor: SERIES_COLORS.ebitda },
              ]}
            />
            <Text style={[styles.legendText, { color: props.colors.secondary }]}>
              EBITDA Margin %
            </Text>
          </View>
        ) : null}
        {patLine ? (
          <View style={styles.legendItem}>
            <View
              style={[styles.legendDot, { backgroundColor: SERIES_COLORS.pat }]}
            />
            <Text style={[styles.legendText, { color: props.colors.secondary }]}>
              PAT Margin %
            </Text>
          </View>
        ) : null}
      </View>

      <Svg width={chartWidth} height={chartHeight}>
        <Defs>
          <LinearGradient id="ebitdaGrad" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={SERIES_COLORS.ebitda} stopOpacity="0.28" />
            <Stop offset="1" stopColor={SERIES_COLORS.ebitda} stopOpacity="0.02" />
          </LinearGradient>
          <LinearGradient id="patGrad" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={SERIES_COLORS.pat} stopOpacity="0.24" />
            <Stop offset="1" stopColor={SERIES_COLORS.pat} stopOpacity="0.02" />
          </LinearGradient>
        </Defs>

        {ticks.map((tick, idx) => (
          <G key={idx}>
            <Line
              x1={padLeft}
              y1={tick.y}
              x2={chartWidth - padRight}
              y2={tick.y}
              stroke={props.colors.border}
              strokeWidth={1}
              strokeDasharray="3,4"
              opacity={0.7}
            />
            <SvgText
              x={padLeft - 6}
              y={tick.y + 4}
              fontSize={10}
              fill={props.colors.muted}
              textAnchor="end"
            >
              {`${Math.round(tick.val)}%`}
            </SvgText>
          </G>
        ))}

        {ebitdaLine ? (
          <G>
            <Path d={ebitdaLine.areaPath} fill="url(#ebitdaGrad)" />
            <Path
              d={ebitdaLine.linePath}
              stroke={SERIES_COLORS.ebitda}
              strokeWidth={2.5}
              fill="none"
            />
            {ebitdaLine.pts.map((p, idx) => (
              <G key={`eb-${idx}`}>
                <Circle
                  cx={p.x}
                  cy={p.y}
                  r={4}
                  fill={SERIES_COLORS.ebitda}
                  stroke={props.colors.surface}
                  strokeWidth={1.5}
                />
                <SvgText
                  x={p.x}
                  y={p.y - 8}
                  fontSize={10}
                  fontWeight="600"
                  fill={SERIES_COLORS.ebitda}
                  textAnchor="middle"
                >
                  {`${p.val.toFixed(1)}%`}
                </SvgText>
              </G>
            ))}
          </G>
        ) : null}

        {patLine ? (
          <G>
            <Path d={patLine.areaPath} fill="url(#patGrad)" />
            <Path
              d={patLine.linePath}
              stroke={SERIES_COLORS.pat}
              strokeWidth={2.5}
              fill="none"
            />
            {patLine.pts.map((p, idx) => (
              <G key={`pat-${idx}`}>
                <Circle
                  cx={p.x}
                  cy={p.y}
                  r={4}
                  fill={SERIES_COLORS.pat}
                  stroke={props.colors.surface}
                  strokeWidth={1.5}
                />
                <SvgText
                  x={p.x}
                  y={p.y + 15}
                  fontSize={10}
                  fontWeight="600"
                  fill={SERIES_COLORS.pat}
                  textAnchor="middle"
                >
                  {`${p.val.toFixed(1)}%`}
                </SvgText>
              </G>
            ))}
          </G>
        ) : null}

        {props.data.map((d, idx) => (
          <SvgText
            key={`${d.period}-${idx}`}
            x={xFor(idx)}
            y={chartHeight - 8}
            fontSize={11}
            fill={props.colors.secondary}
            textAnchor="middle"
          >
            {d.period}
          </SvgText>
        ))}
      </Svg>
    </View>
  );
}

export type DonutSlice = {
  label: string;
  value: number;
  color: string;
};

export function DonutChart(props: {
  slices: DonutSlice[];
  centerValue: string;
  centerLabel: string;
  colors: ChartPalette;
}) {
  const total = props.slices.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) return null;

  const size = 126;
  const strokeWidth = 15;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const cx = size / 2;
  const cy = size / 2;

  let cumulative = 0;

  return (
    <View style={styles.donutContainer}>
      <View style={styles.donutSvgBox}>
        <Svg width={size} height={size}>
          <Circle
            cx={cx}
            cy={cy}
            r={radius}
            stroke={props.colors.border}
            strokeWidth={strokeWidth}
            fill="none"
            opacity={0.35}
          />
          {props.slices.map((slice) => {
            if (slice.value <= 0) return null;
            const fraction = slice.value / total;
            const dashLength = Math.max(0, fraction * circumference - 2);
            const rotation = -90 + (cumulative / total) * 360;
            cumulative += slice.value;

            return (
              <Circle
                key={slice.label}
                cx={cx}
                cy={cy}
                r={radius}
                stroke={slice.color}
                strokeWidth={strokeWidth}
                strokeDasharray={`${dashLength} ${circumference}`}
                strokeLinecap="round"
                fill="none"
                origin={`${cx}, ${cy}`}
                rotation={rotation}
              />
            );
          })}
        </Svg>
        <View style={styles.donutCenter}>
          <Text style={[styles.donutCenterValue, { color: props.colors.text }]}>
            {props.centerValue}
          </Text>
          <Text
            style={[styles.donutCenterLabel, { color: props.colors.muted }]}
          >
            {props.centerLabel}
          </Text>
        </View>
      </View>

      <View style={styles.donutLegend}>
        {props.slices.map((slice) => {
          const pct = Math.round((slice.value / total) * 100);
          return (
            <View key={slice.label} style={styles.donutLegendRow}>
              <View
                style={[styles.legendDot, { backgroundColor: slice.color }]}
              />
              <Text
                style={[
                  styles.donutLegendName,
                  { color: props.colors.secondary },
                ]}
              >
                {slice.label}
              </Text>
              <Text
                style={[
                  styles.donutLegendCount,
                  { color: props.colors.text },
                ]}
              >
                {slice.value}
              </Text>
              <Text
                style={[
                  styles.donutLegendPct,
                  { color: props.colors.muted },
                ]}
              >
                {pct}%
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

export type BreakdownBarItem = {
  id: string;
  label: string;
  value: number;
  valueLabel: string;
  sublabel?: string;
  color?: string;
};

export function HorizontalBreakdownBars(props: {
  items: BreakdownBarItem[];
  colors: ChartPalette;
  selectedId?: string;
  onSelect?: (id: string) => void;
}) {
  if (props.items.length === 0) return null;
  const maxVal = Math.max(1, ...props.items.map((item) => item.value));

  return (
    <View style={styles.barsStack}>
      {props.items.map((item) => {
        const widthPct = Math.max(6, Math.min(100, (item.value / maxVal) * 100));
        const active = props.selectedId === item.id;
        const barColor = item.color ?? props.colors.blue;
        const Wrapper = props.onSelect ? Pressable : View;

        return (
          <Wrapper
            key={item.id}
            onPress={props.onSelect ? () => props.onSelect?.(item.id) : undefined}
            style={[
              styles.barRow,
              active && styles.barRowActive,
              active && { backgroundColor: props.colors.blueSoft },
            ]}
          >
            <View style={styles.barHeaderRow}>
              <Text
                numberOfLines={2}
                style={[styles.barLabel, { color: props.colors.text }]}
              >
                {item.label}
              </Text>
              <View style={styles.barValueGroup}>
                <Text
                  style={[styles.barValueText, { color: props.colors.text }]}
                >
                  {item.valueLabel}
                </Text>
                {item.sublabel ? (
                  <Text
                    style={[
                      styles.barSublabel,
                      { color: props.colors.muted },
                    ]}
                  >
                    {item.sublabel}
                  </Text>
                ) : null}
              </View>
            </View>
            <View
              style={[
                styles.barTrack,
                { backgroundColor: props.colors.surfaceRaised },
              ]}
            >
              <View
                style={[
                  styles.barFill,
                  {
                    width: `${widthPct}%`,
                    backgroundColor: barColor,
                  },
                ]}
              />
            </View>
          </Wrapper>
        );
      })}
    </View>
  );
}

export function SplitProgressBar(props: {
  leftLabel: string;
  leftValueLabel?: string;
  leftPct: number;
  rightLabel: string;
  rightValueLabel?: string;
  rightPct: number;
  colors: ChartPalette;
}) {
  const total = Math.max(1, props.leftPct + props.rightPct);
  const leftWidth = (props.leftPct / total) * 100;
  const rightWidth = (props.rightPct / total) * 100;

  return (
    <View style={styles.splitContainer}>
      <View
        style={[
          styles.splitTrack,
          { backgroundColor: props.colors.surfaceRaised },
        ]}
      >
        <View
          style={[
            styles.splitSegment,
            styles.splitSegmentLeft,
            { width: `${leftWidth}%` },
          ]}
        />
        <View
          style={[
            styles.splitSegment,
            styles.splitSegmentRight,
            { width: `${rightWidth}%` },
          ]}
        />
      </View>
      <View style={styles.splitLegendRow}>
        <View style={styles.splitLegendCol}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, styles.splitSegmentLeft]} />
            <Text style={[styles.legendText, { color: props.colors.secondary }]}>
              {props.leftLabel} ({props.leftPct.toFixed(1)}%)
            </Text>
          </View>
          {props.leftValueLabel ? (
            <Text style={[styles.splitValue, { color: props.colors.text }]}>
              {props.leftValueLabel}
            </Text>
          ) : null}
        </View>
        <View style={[styles.splitLegendCol, styles.splitRightAlign]}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, styles.splitSegmentRight]} />
            <Text style={[styles.legendText, { color: props.colors.secondary }]}>
              {props.rightLabel} ({props.rightPct.toFixed(1)}%)
            </Text>
          </View>
          {props.rightValueLabel ? (
            <Text style={[styles.splitValue, { color: props.colors.text }]}>
              {props.rightValueLabel}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  legendRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 12,
    marginBottom: 8,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    fontSize: 12,
    fontWeight: "600",
  },
  unitBadge: {
    marginLeft: "auto",
    fontSize: 11,
    fontWeight: "600",
  },
  periodPickerRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 8,
  },
  periodChip: {
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 5,
  },
  periodChipText: {
    fontSize: 12,
    fontWeight: "600",
  },
  selectedStrip: {
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    gap: 8,
  },
  selectedHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  selectedPeriod: {
    fontSize: 13,
    fontWeight: "700",
  },
  selectedPage: {
    fontSize: 12,
    fontWeight: "600",
  },
  selectedMetricsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
  },
  selectedMetricCell: {
    flex: 1,
    gap: 2,
  },
  selectedMetricLabel: {
    fontSize: 11,
    fontWeight: "500",
  },
  selectedMetricValue: {
    fontSize: 14,
    fontWeight: "700",
  },
  donutContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 18,
  },
  donutSvgBox: {
    width: 126,
    height: 126,
    alignItems: "center",
    justifyContent: "center",
  },
  donutCenter: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
  },
  donutCenterValue: {
    fontSize: 24,
    fontWeight: "800",
  },
  donutCenterLabel: {
    fontSize: 11,
    fontWeight: "600",
  },
  donutLegend: {
    flex: 1,
    gap: 10,
  },
  donutLegendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  donutLegendName: {
    flex: 1,
    fontSize: 13,
    fontWeight: "600",
  },
  donutLegendCount: {
    fontSize: 14,
    fontWeight: "700",
    minWidth: 20,
    textAlign: "right",
  },
  donutLegendPct: {
    fontSize: 12,
    minWidth: 34,
    textAlign: "right",
  },
  barsStack: {
    gap: 12,
  },
  barRow: {
    gap: 6,
  },
  barRowActive: {
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginHorizontal: -8,
  },
  barHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },
  barLabel: {
    flex: 1,
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 18,
  },
  barValueGroup: {
    alignItems: "flex-end",
  },
  barValueText: {
    fontSize: 13,
    fontWeight: "700",
  },
  barSublabel: {
    fontSize: 11,
  },
  barTrack: {
    height: 8,
    borderRadius: 4,
    overflow: "hidden",
  },
  barFill: {
    height: 8,
    borderRadius: 4,
  },
  splitContainer: {
    gap: 10,
  },
  splitTrack: {
    height: 12,
    borderRadius: 6,
    overflow: "hidden",
    flexDirection: "row",
    gap: 2,
  },
  splitSegment: {
    height: 12,
  },
  splitSegmentLeft: {
    backgroundColor: "#3B82F6",
  },
  splitSegmentRight: {
    backgroundColor: "#F59E0B",
  },
  splitLegendRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  splitLegendCol: {
    flex: 1,
    gap: 2,
  },
  splitRightAlign: {
    alignItems: "flex-end",
  },
  splitValue: {
    fontSize: 13,
    fontWeight: "700",
  },
});
