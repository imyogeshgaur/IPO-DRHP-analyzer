import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type {
  Citation,
  CitedTextItem,
  DocumentInsightResponse,
  FinancialsInsightData,
  IpoInsightData,
  KpiMetric,
  OverviewInsightData,
  RiskCategory,
  RiskSeverity,
  RisksInsightData,
} from "../types";
import {
  DonutChart,
  GroupedBarChart,
  HorizontalBreakdownBars,
  SplitProgressBar,
  TrendLineChart,
  type ChartPalette,
} from "./SvgCharts";

const SEVERITY_COLORS: Record<RiskSeverity, string> = {
  high: "#EF4444",
  medium: "#F59E0B",
  low: "#3B82F6",
};

const CATEGORY_COLORS: Record<RiskCategory, string> = {
  Regulatory: "#EF4444",
  Financial: "#F59E0B",
  Operational: "#3B82F6",
  Litigation: "#EC4899",
  Market: "#8B5CF6",
  Technology: "#14B8A6",
  Governance: "#6366F1",
};

export function ReportInsightView(props: {
  insight: DocumentInsightResponse;
  colors: ChartPalette;
  onRetry: () => void;
}) {
  const { insight, colors, onRetry } = props;

  return (
    <View style={styles.root}>
      {insight.notice ? (
        <View
          style={[
            styles.noticeBanner,
            {
              backgroundColor: colors.surfaceRaised,
              borderColor: colors.border,
            },
          ]}
        >
          <Text style={[styles.noticeText, { color: colors.secondary }]}>
            {insight.notice}
          </Text>
          {insight.status === "unavailable" ? (
            <Pressable
              onPress={onRetry}
              style={[
                styles.retryPill,
                { backgroundColor: colors.blueSoft, borderColor: colors.blue },
              ]}
            >
              <Text style={[styles.retryPillText, { color: colors.blue }]}>
                Retry extraction
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {insight.section === "financials" ? (
        <FinancialsView data={insight.data} colors={colors} />
      ) : insight.section === "risks" ? (
        <RisksView data={insight.data} colors={colors} />
      ) : insight.section === "overview" ? (
        <OverviewView data={insight.data} colors={colors} />
      ) : (
        <IpoView data={insight.data} colors={colors} />
      )}

      <CollapsibleSources citations={insight.citations} colors={colors} />
    </View>
  );
}

export function FinancialsView(props: {
  data: FinancialsInsightData;
  colors: ChartPalette;
}) {
  const { data, colors } = props;
  const unitLabel = `${data.currency === "INR" ? "₹" : data.currency} ${data.unit}`;
  const normalizedKpis = useMemo(
    () =>
      data.kpis.map((kpi) => {
        const lowerUnit = data.unit.toLocaleLowerCase();
        if (
          lowerUnit.includes("million") &&
          /\b(?:cr|crores?)\b/i.test(kpi.value)
        ) {
          return {
            ...kpi,
            value: kpi.value.replace(/\b(?:cr|crores?)\b/gi, "Mn"),
          };
        }
        return kpi;
      }),
    [data.kpis, data.unit],
  );
  const hasMargins =
    data.series.filter(
      (p) => p.ebitdaMarginPct !== undefined || p.patMarginPct !== undefined,
    ).length >= 2;

  return (
    <View style={styles.sectionStack}>
      <View
        style={[
          styles.card,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <View style={styles.metaRow}>
          {data.basis ? (
            <View
              style={[styles.metaChip, { backgroundColor: colors.blueSoft }]}
            >
              <Text style={[styles.metaChipText, { color: colors.blue }]}>
                {data.basis}
              </Text>
            </View>
          ) : null}
          <View
            style={[styles.metaChip, { backgroundColor: colors.surfaceRaised }]}
          >
            <Text style={[styles.metaChipText, { color: colors.secondary }]}>
              {unitLabel}
            </Text>
          </View>
        </View>
        <Text style={[styles.summaryText, { color: colors.text }]}>
          {data.summary}
        </Text>
      </View>

      {normalizedKpis.length > 0 ? (
        <KpiGrid items={normalizedKpis} colors={colors} />
      ) : null}

      {data.series.length > 0 ? (
        <View
          style={[
            styles.card,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.cardTitle, { color: colors.text }]}>
            Revenue & Profitability
          </Text>
          <Text style={[styles.cardSubtitle, { color: colors.muted }]}>
            Tap any fiscal year below to inspect exact reported figures
          </Text>
          <GroupedBarChart
            data={data.series}
            unitLabel={unitLabel}
            colors={colors}
          />
        </View>
      ) : null}

      {hasMargins ? (
        <View
          style={[
            styles.card,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.cardTitle, { color: colors.text }]}>
            Margin Trajectory
          </Text>
          <Text style={[styles.cardSubtitle, { color: colors.muted }]}>
            EBITDA and Net Profit margins over reported periods
          </Text>
          <TrendLineChart data={data.series} colors={colors} />
        </View>
      ) : null}

      {data.highlights.length > 0 ? (
        <CitedBulletCard
          title="Key Financial Takeaways"
          items={data.highlights}
          accentColor={colors.blue}
          colors={colors}
        />
      ) : null}
    </View>
  );
}

export function RisksView(props: { data: RisksInsightData; colors: ChartPalette }) {
  const { data, colors } = props;
  const [severityFilter, setSeverityFilter] = useState<RiskSeverity | "all">(
    "all",
  );
  const [categoryFilter, setCategoryFilter] = useState<string | undefined>();

  const totalRisks =
    data.severityCounts.high +
    data.severityCounts.medium +
    data.severityCounts.low;

  const filteredItems = useMemo(
    () =>
      data.items.filter((item) => {
        if (severityFilter !== "all" && item.severity !== severityFilter) {
          return false;
        }
        if (categoryFilter && item.category !== categoryFilter) {
          return false;
        }
        return true;
      }),
    [categoryFilter, data.items, severityFilter],
  );

  return (
    <View style={styles.sectionStack}>
      <View
        style={[
          styles.card,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <Text style={[styles.summaryText, { color: colors.text }]}>
          {data.summary}
        </Text>
      </View>

      {totalRisks > 0 ? (
        <View
          style={[
            styles.card,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.cardTitle, { color: colors.text }]}>
            Risk Severity Breakdown
          </Text>
          <DonutChart
            slices={[
              {
                label: "High",
                value: data.severityCounts.high,
                color: SEVERITY_COLORS.high,
              },
              {
                label: "Medium",
                value: data.severityCounts.medium,
                color: SEVERITY_COLORS.medium,
              },
              {
                label: "Low",
                value: data.severityCounts.low,
                color: SEVERITY_COLORS.low,
              },
            ]}
            centerValue={String(totalRisks)}
            centerLabel="Risks"
            colors={colors}
          />
        </View>
      ) : null}

      {data.categoryCounts.length > 0 ? (
        <View
          style={[
            styles.card,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <View style={styles.cardHeaderRow}>
            <Text style={[styles.cardTitle, { color: colors.text }]}>
              Exposure by Category
            </Text>
            {categoryFilter ? (
              <Pressable onPress={() => setCategoryFilter(undefined)}>
                <Text style={[styles.clearLink, { color: colors.blue }]}>
                  Clear filter
                </Text>
              </Pressable>
            ) : (
              <Text style={[styles.hintText, { color: colors.muted }]}>
                Tap to filter
              </Text>
            )}
          </View>
          <HorizontalBreakdownBars
            items={data.categoryCounts.map((entry) => ({
              id: entry.category,
              label: entry.category,
              value: entry.count,
              valueLabel: `${entry.count}`,
              color: CATEGORY_COLORS[entry.category],
            }))}
            selectedId={categoryFilter}
            onSelect={(id) =>
              setCategoryFilter((current) => (current === id ? undefined : id))
            }
            colors={colors}
          />
        </View>
      ) : null}

      {data.items.length > 0 ? (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterRow}
          >
            {(["all", "high", "medium", "low"] as const).map((level) => {
              const active = severityFilter === level;
              const label =
                level === "all"
                  ? `All (${data.items.length})`
                  : `${level[0].toUpperCase()}${level.slice(1)} (${data.severityCounts[level]})`;
              return (
                <Pressable
                  key={level}
                  onPress={() => setSeverityFilter(level)}
                  style={[
                    styles.filterChip,
                    {
                      backgroundColor: active
                        ? colors.blueSoft
                        : colors.surface,
                      borderColor: active ? colors.blue : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.filterChipText,
                      { color: active ? colors.blue : colors.secondary },
                    ]}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          <View style={styles.riskList}>
            {filteredItems.map((item, idx) => {
              const sevColor = SEVERITY_COLORS[item.severity];
              const catColor = CATEGORY_COLORS[item.category];
              return (
                <View
                  key={`${item.title}-${idx}`}
                  style={[
                    styles.riskCard,
                    {
                      backgroundColor: colors.surface,
                      borderColor: colors.border,
                      borderLeftColor: sevColor,
                    },
                  ]}
                >
                  <View style={styles.riskBadgeRow}>
                    <View
                      style={[
                        styles.severityBadge,
                        { backgroundColor: `${sevColor}22` },
                      ]}
                    >
                      <View
                        style={[
                          styles.severityDot,
                          { backgroundColor: sevColor },
                        ]}
                      />
                      <Text
                        style={[styles.severityBadgeText, { color: sevColor }]}
                      >
                        {item.severity.toUpperCase()}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.categoryBadge,
                        { backgroundColor: `${catColor}22` },
                      ]}
                    >
                      <Text
                        style={[styles.categoryBadgeText, { color: catColor }]}
                      >
                        {item.category}
                      </Text>
                    </View>
                    <View style={styles.pageSpacer} />
                    <View
                      style={[
                        styles.pageChip,
                        { backgroundColor: colors.blueSoft },
                      ]}
                    >
                      <Text
                        style={[styles.pageChipText, { color: colors.blue }]}
                      >
                        Page {item.page}
                      </Text>
                    </View>
                  </View>

                  <Text style={[styles.riskTitle, { color: colors.text }]}>
                    {item.title}
                  </Text>
                  <Text
                    style={[styles.riskImpact, { color: colors.secondary }]}
                  >
                    {item.impact}
                  </Text>
                </View>
              );
            })}
          </View>
        </>
      ) : null}
    </View>
  );
}

export function OverviewView(props: {
  data: OverviewInsightData;
  colors: ChartPalette;
}) {
  const { data, colors } = props;
  return (
    <View style={styles.sectionStack}>
      <View
        style={[
          styles.card,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <View style={styles.overviewHeader}>
          <Text style={[styles.overviewTitle, { color: colors.text }]}>
            {data.companyName}
          </Text>
          {data.sector ? (
            <View
              style={[styles.metaChip, { backgroundColor: colors.blueSoft }]}
            >
              <Text style={[styles.metaChipText, { color: colors.blue }]}>
                {data.sector}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={[styles.summaryText, { color: colors.text }]}>
          {data.summary}
        </Text>
      </View>

      {data.keyMetrics.length > 0 ? (
        <KpiGrid items={data.keyMetrics} colors={colors} />
      ) : null}

      {data.businessHighlights.length > 0 ? (
        <CitedBulletCard
          title="Business Model & Highlights"
          items={data.businessHighlights}
          accentColor={colors.blue}
          colors={colors}
        />
      ) : null}

      {data.strengths.length > 0 ? (
        <CitedBulletCard
          title="Competitive Strengths"
          items={data.strengths}
          accentColor={colors.green}
          colors={colors}
        />
      ) : null}
    </View>
  );
}

export function IpoView(props: { data: IpoInsightData; colors: ChartPalette }) {
  const { data, colors } = props;
  const snapshotCards: KpiMetric[] = [
    {
      label: "Total Issue Size",
      value: data.issueSize ?? "Not disclosed in DRHP",
    },
    {
      label: "Price Band",
      value: data.priceBand ?? "To be decided (RHP)",
    },
    {
      label: "Face Value",
      value: data.faceValue ?? "Not disclosed",
    },
    {
      label: "Listing Exchanges",
      value:
        data.listingExchanges.length > 0
          ? data.listingExchanges.join(" · ")
          : "Not disclosed",
    },
  ];

  const hasSplit =
    data.freshIssuePct !== undefined && data.ofsPct !== undefined;
  const hasProceedsBars = data.useOfProceeds.length > 0;
  const proceedsColors = [
    "#3B82F6",
    "#14B8A6",
    "#F59E0B",
    "#8B5CF6",
    "#EC4899",
    "#6366F1",
  ];

  return (
    <View style={styles.sectionStack}>
      <View
        style={[
          styles.card,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <Text style={[styles.summaryText, { color: colors.text }]}>
          {data.summary}
        </Text>
      </View>

      <KpiGrid items={snapshotCards} colors={colors} />

      {hasSplit || data.freshIssueAmount || data.ofsAmount ? (
        <View
          style={[
            styles.card,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.cardTitle, { color: colors.text }]}>
            Offer Structure (Fresh Issue vs. OFS)
          </Text>
          {hasSplit ? (
            <SplitProgressBar
              leftLabel="Fresh Issue"
              leftValueLabel={data.freshIssueAmount}
              leftPct={data.freshIssuePct ?? 0}
              rightLabel="Offer for Sale"
              rightValueLabel={data.ofsAmount}
              rightPct={data.ofsPct ?? 0}
              colors={colors}
            />
          ) : (
            <View style={styles.splitFallbackRow}>
              <View
                style={[
                  styles.splitFallbackBox,
                  {
                    backgroundColor: colors.surfaceRaised,
                    borderColor: colors.border,
                  },
                ]}
              >
                <Text
                  style={[styles.kpiLabel, { color: colors.muted }]}
                >
                  Fresh Issue
                </Text>
                <Text style={[styles.kpiValue, { color: colors.text }]}>
                  {data.freshIssueAmount ?? "Not disclosed"}
                </Text>
              </View>
              <View
                style={[
                  styles.splitFallbackBox,
                  {
                    backgroundColor: colors.surfaceRaised,
                    borderColor: colors.border,
                  },
                ]}
              >
                <Text
                  style={[styles.kpiLabel, { color: colors.muted }]}
                >
                  Offer for Sale (OFS)
                </Text>
                <Text style={[styles.kpiValue, { color: colors.text }]}>
                  {data.ofsAmount ?? "Not disclosed"}
                </Text>
              </View>
            </View>
          )}
        </View>
      ) : null}

      {hasProceedsBars ? (
        <View
          style={[
            styles.card,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.cardTitle, { color: colors.text }]}>
            Objects of the Offer / Use of Proceeds
          </Text>
          <HorizontalBreakdownBars
            items={data.useOfProceeds.map((item, idx) => ({
              id: `${item.purpose}-${idx}`,
              label: item.purpose,
              value: item.percentage ?? item.amount ?? 1,
              valueLabel:
                item.amountLabel ??
                (item.amount !== undefined
                  ? `${data.currency === "INR" ? "₹" : ""}${item.amount.toLocaleString("en-IN")} ${data.unit ?? ""}`.trim()
                  : item.percentage !== undefined
                    ? `${item.percentage}%`
                    : "Disclosed"),
              sublabel: [
                item.percentage !== undefined ? `${item.percentage}%` : null,
                item.page ? `p.${item.page}` : null,
              ]
                .filter(Boolean)
                .join(" · "),
              color: proceedsColors[idx % proceedsColors.length],
            }))}
            colors={colors}
          />
        </View>
      ) : null}
    </View>
  );
}

export function KpiGrid(props: { items: KpiMetric[]; colors: ChartPalette }) {
  const { items, colors } = props;
  return (
    <View style={styles.kpiGrid}>
      {items.map((item, idx) => {
        const trendColor =
          item.trend === "up"
            ? colors.green
            : item.trend === "down"
              ? colors.red
              : colors.secondary;
        return (
          <View
            key={`${item.label}-${idx}`}
            style={[
              styles.kpiCard,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            <View style={styles.kpiHeaderRow}>
              <Text
                numberOfLines={2}
                style={[styles.kpiLabel, { color: colors.muted }]}
              >
                {item.label}
              </Text>
              {item.page ? (
                <Text style={[styles.kpiPage, { color: colors.blue }]}>
                  p.{item.page}
                </Text>
              ) : null}
            </View>
            <Text
              numberOfLines={2}
              style={[styles.kpiValue, { color: colors.text }]}
            >
              {item.value}
            </Text>
            {item.delta && !/^(?:n\/?a|none|null|-+)$/i.test(item.delta.trim()) ? (
              <Text
                numberOfLines={1}
                style={[styles.kpiDelta, { color: trendColor }]}
              >
                {item.delta}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

export function CitedBulletCard(props: {
  title: string;
  items: CitedTextItem[];
  accentColor: string;
  colors: ChartPalette;
}) {
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: props.colors.surface,
          borderColor: props.colors.border,
        },
      ]}
    >
      <Text style={[styles.cardTitle, { color: props.colors.text }]}>
        {props.title}
      </Text>
      <View style={styles.bulletStack}>
        {props.items.map((item, idx) => (
          <View key={idx} style={styles.bulletRow}>
            <View
              style={[
                styles.bulletDot,
                { backgroundColor: props.accentColor },
              ]}
            />
            <View style={styles.bulletBody}>
              <Text style={[styles.bulletText, { color: props.colors.text }]}>
                {item.text}
              </Text>
              {item.page ? (
                <Text
                  style={[styles.inlinePage, { color: props.colors.blue }]}
                >
                  Page {item.page}
                </Text>
              ) : null}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

export function CollapsibleSources(props: {
  citations: Citation[];
  colors: ChartPalette;
}) {
  const [expanded, setExpanded] = useState(false);
  if (props.citations.length === 0) return null;

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: props.colors.surface,
          borderColor: props.colors.border,
        },
      ]}
    >
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        style={styles.sourcesHeader}
      >
        <View style={styles.sourcesTitleGroup}>
          <Text style={[styles.cardTitle, { color: props.colors.text }]}>
            Verified Source Pages ({props.citations.length})
          </Text>
          <Text style={[styles.cardSubtitle, { color: props.colors.muted }]}>
            {props.citations
              .map((c) => (c.page ? `p.${c.page}` : null))
              .filter(Boolean)
              .join(", ")}
          </Text>
        </View>
        <Text style={[styles.expandLabel, { color: props.colors.blue }]}>
          {expanded ? "Hide" : "Show"}
        </Text>
      </Pressable>

      {expanded ? (
        <View style={styles.citationsStack}>
          {props.citations.map((citation, idx) => (
            <View
              key={`${citation.chunkId}-${idx}`}
              style={[
                styles.citationItem,
                {
                  backgroundColor: props.colors.surfaceRaised,
                  borderColor: props.colors.border,
                },
              ]}
            >
              <Text
                style={[styles.citationPage, { color: props.colors.blue }]}
              >
                {citation.page ? `Page ${citation.page}` : "Source excerpt"}
              </Text>
              <Text
                numberOfLines={4}
                style={[styles.citationText, { color: props.colors.secondary }]}
              >
                {citation.text}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: 14,
  },
  sectionStack: {
    gap: 14,
  },
  noticeBanner: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    gap: 8,
  },
  noticeText: {
    fontSize: 13,
    lineHeight: 19,
  },
  retryPill: {
    alignSelf: "flex-start",
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  retryPillText: {
    fontSize: 12,
    fontWeight: "700",
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: "700",
  },
  cardSubtitle: {
    fontSize: 12,
    marginTop: -4,
  },
  clearLink: {
    fontSize: 12,
    fontWeight: "700",
  },
  hintText: {
    fontSize: 11,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  metaChip: {
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  metaChipText: {
    fontSize: 11,
    fontWeight: "700",
  },
  summaryText: {
    fontSize: 14,
    lineHeight: 21,
  },
  overviewHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
  },
  overviewTitle: {
    fontSize: 17,
    fontWeight: "800",
    flexShrink: 1,
  },
  kpiGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  kpiCard: {
    width: "48.3%",
    flexGrow: 1,
    borderRadius: 14,
    borderWidth: 1,
    padding: 13,
    gap: 5,
  },
  kpiHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
  },
  kpiLabel: {
    fontSize: 11,
    fontWeight: "600",
    flex: 1,
  },
  kpiPage: {
    fontSize: 11,
    fontWeight: "700",
  },
  kpiValue: {
    fontSize: 16,
    fontWeight: "800",
    lineHeight: 21,
  },
  kpiDelta: {
    fontSize: 12,
    fontWeight: "700",
  },
  filterRow: {
    flexDirection: "row",
    gap: 8,
    paddingVertical: 2,
  },
  filterChip: {
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: "700",
  },
  riskList: {
    gap: 10,
  },
  riskCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderLeftWidth: 4,
    padding: 14,
    gap: 8,
  },
  riskBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  severityBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  severityDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  severityBadgeText: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  categoryBadge: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  categoryBadgeText: {
    fontSize: 11,
    fontWeight: "700",
  },
  pageSpacer: {
    flex: 1,
  },
  pageChip: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  pageChipText: {
    fontSize: 11,
    fontWeight: "700",
  },
  riskTitle: {
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 20,
  },
  riskImpact: {
    fontSize: 13,
    lineHeight: 19,
  },
  splitFallbackRow: {
    flexDirection: "row",
    gap: 10,
  },
  splitFallbackBox: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    gap: 4,
  },
  bulletStack: {
    gap: 10,
  },
  bulletRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  bulletDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    marginTop: 7,
  },
  bulletBody: {
    flex: 1,
    gap: 3,
  },
  bulletText: {
    fontSize: 13.5,
    lineHeight: 20,
  },
  inlinePage: {
    fontSize: 11,
    fontWeight: "700",
  },
  sourcesHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  sourcesTitleGroup: {
    flex: 1,
    gap: 4,
  },
  expandLabel: {
    fontSize: 13,
    fontWeight: "700",
  },
  citationsStack: {
    gap: 8,
    marginTop: 4,
  },
  citationItem: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    gap: 4,
  },
  citationPage: {
    fontSize: 12,
    fontWeight: "700",
  },
  citationText: {
    fontSize: 12,
    lineHeight: 17,
  },
});
