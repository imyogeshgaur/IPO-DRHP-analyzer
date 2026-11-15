import { readFile } from "node:fs/promises";
import pdfParse from "pdf-parse";
import type { DocumentType } from "../contracts/contracts.js";
import { AppError } from "../shared/errors.js";
import { splitIntoChunks } from "./parsers.js";

export type DrhpPdfPage = {
  pdfPageIndex: number;
  printedPageNumber?: string;
  text: string;
  needsOcr: boolean;
};

export type DrhpChunk = {
  text: string;
  chunkIndex: number;
  pdfPageIndex: number;
  printedPageNumber?: string;
  section?: string;
};

type PdfTextItem = {
  str: string;
  x?: number;
  y?: number;
  width?: number;
};

type PdfPageProxy = {
  pageIndex?: number;
  getTextContent: (options: {
    normalizeWhitespace: boolean;
    disableCombineTextItems: boolean;
  }) => Promise<{ items: unknown[] }>;
};

export async function detectPdfDocumentType(
  filePath: string,
): Promise<DocumentType> {
  const parsed = await pdfParse(await readFile(filePath), { max: 3 });
  return isLikelyDrhp(parsed.text) ? "drhp" : "generic";
}

export function isLikelyDrhp(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").toLocaleLowerCase();
  if (/\bdraft\s+(?:red\s+)?herring\s+prospectus\b/.test(normalized)) {
    return true;
  }

  if (/\bdraft offer document\b/.test(normalized)) {
    return /\b(?:initial public offering|public issue|issue size|book[- ]built)\b/.test(
      normalized,
    );
  }

  return (
    /\bred herring prospectus\b/.test(normalized) &&
    /\b(?:initial public offering|public issue|issue size|book[- ]built)\b/.test(
      normalized,
    )
  );
}

export function detectPrintedPageNumber(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3);

  for (const [index, line] of [...lines].reverse().entries()) {
    const labeled = line.match(
      /^(?:page|pg\.?)\s*[:#-]?\s*((?:[A-Z]{1,3}-)?\d{1,4}|[ivxlcdm]{1,8})(?:\s+of\s+\d{1,4})?$/i,
    );
    if (labeled?.[1]) return labeled[1];

    const footer = line.match(/^(?:[A-Z]{1,3}-\d{1,4}|[-–—]\s*\d{1,4}\s*[-–—])$/i);
    if (footer?.[0]) {
      return /^[A-Z]{1,3}-\d{1,4}$/i.test(footer[0])
        ? footer[0]
        : footer[0].replace(/[-–—\s]/g, "");
    }

    if (index === 0 && /^\d{1,4}$/.test(line)) return line;
  }

  return undefined;
}

const knownDrhpHeadings = [
  "about our company",
  "basis for issue price",
  "capital structure",
  "definitions and abbreviations",
  "financial information",
  "general",
  "general information",
  "general risk factors",
  "general risks",
  "general terms",
  "government and other approvals",
  "industry overview",
  "introduction",
  "issue procedure",
  "legal and other information",
  "management's discussion and analysis",
  "managements discussion and analysis",
  "material contracts and documents for inspection",
  "objects of the issue",
  "objects of the offer",
  "other regulatory and statutory disclosures",
  "outstanding litigations and material developments",
  "our business",
  "our group companies",
  "our management",
  "our company",
  "our promoters and promoter group",
  "restated financial information",
  "risk factors",
  "summary financial information",
  "summary of financial information",
  "summary of the offer",
  "summary of the offer document",
  "summary of restated consolidated financial information",
  "summary of restated consolidated profit and loss",
  "summary of restated financial information",
  "summary of restated profit and loss",
  "the offer",
  "terms of the issue",
] as const;

export function detectDrhpSectionHeading(line: string): string | undefined {
  const normalizedLine = line.replace(/\s+/g, " ").trim();
  if (!normalizedLine || normalizedLine.length > 140) return undefined;

  const numberedHeading = normalizedLine.match(
    /^(?:(?:section|chapter|part)\s+(?:[ivxlcdm]+|\d+(?:\.\d+)*)(?:\s*[-–—:.)]\s*|\s+)|(?:\d+(?:\.\d+)*|[ivxlcdm]+)[.)]\s+)(.+)$/i,
  );
  const title = (numberedHeading?.[1] ?? normalizedLine)
    .replace(/\s*[.·…]{3,}\s*\d{1,4}\s*$/, "")
    .replace(/^[\d.)\s]+/, "")
    .replace(/\s*[.:;]+$/, "")
    .trim();
  const normalizedTitle = title.toLocaleLowerCase().replace(/\s+/g, " ");

  const knownHeading = knownDrhpHeadings.find(
    (heading) => {
      if (normalizedTitle === heading) return true;
      const hasShortQualifier =
        title.length <= heading.length + 36 && !/[.!?]/.test(title);
      return (
        hasShortQualifier &&
        (normalizedTitle.startsWith(`${heading} (`) ||
          normalizedTitle.startsWith(`${heading}:`))
      );
    },
  );
  if (knownHeading) return title;

  if (
    !numberedHeading ||
    !/^[A-Z][A-Z &-]{2,100}$/.test(title) ||
    title.split(/\s+/).length > 12 ||
    !/[A-Z]/.test(title) ||
    /[|:=]/.test(title)
  ) {
    return undefined;
  }

  return title;
}

export async function parseDrhpPdf(
  filePath: string,
): Promise<{ mediaType: "application/pdf"; pages: DrhpPdfPage[] }> {
  const pages = new Map<number, DrhpPdfPage>();
  const parsed = await pdfParse(await readFile(filePath), {
    pagerender: async (rawPage: unknown): Promise<string> => {
      if (!isPdfPageProxy(rawPage)) return "";
      const page = rawPage;

      const pageIndex =
        typeof page.pageIndex === "number" && Number.isInteger(page.pageIndex)
          ? page.pageIndex
          : pages.size;
      try {
        const content = await page.getTextContent({
          normalizeWhitespace: true,
          disableCombineTextItems: false,
        });
        const text = renderPageText(content.items);
        const printedPageNumber = detectPrintedPageNumber(text);
        pages.set(pageIndex, {
          pdfPageIndex: pageIndex,
          ...(printedPageNumber ? { printedPageNumber } : {}),
          text,
          needsOcr: text.trim().length === 0,
        });
      } catch {
        pages.set(pageIndex, {
          pdfPageIndex: pageIndex,
          text: "",
          needsOcr: true,
        });
      }

      return "";
    },
  });

  for (let pageIndex = 0; pageIndex < parsed.numpages; pageIndex += 1) {
    if (!pages.has(pageIndex)) {
      pages.set(pageIndex, {
        pdfPageIndex: pageIndex,
        text: "",
        needsOcr: true,
      });
    }
  }

  return {
    mediaType: "application/pdf",
    pages: [...pages.values()].sort(
      (left, right) => left.pdfPageIndex - right.pdfPageIndex,
    ),
  };
}

export function chunkDrhpPages(pages: DrhpPdfPage[]): DrhpChunk[] {
  const pagesNeedingOcr = pages
    .filter((page) => page.needsOcr)
    .map((page) => page.pdfPageIndex);
  if (pagesNeedingOcr.length > 0) {
    throw new AppError(
      "DRHP_OCR_REQUIRED",
      `PDF pages ${pagesNeedingOcr.join(", ")} have no extractable text. OCR is not configured, so the document was not partially indexed.`,
      422,
    );
  }

  let currentSection: string | undefined;
  const chunks: DrhpChunk[] = [];

  for (const page of pages) {
    let currentLines: string[] = [];
    const sections: Array<{ text: string; section?: string }> = [];
    const contentsPage = isDrhpContentsPage(page.text);
    const flush = (): void => {
      const text = currentLines.join("\n").trim();
      if (text) {
        sections.push({
          text,
          ...(currentSection ? { section: currentSection } : {}),
        });
      }
      currentLines = [];
    };

    for (const line of page.text.split(/\r?\n/)) {
      const heading = contentsPage
        ? undefined
        : detectDrhpSectionHeading(line);
      if (heading) {
        flush();
        currentSection = heading;
      }
      currentLines.push(line);
    }
    flush();

    for (const section of sections) {
      for (const chunk of splitIntoChunks(section.text)) {
        chunks.push({
          ...chunk,
          chunkIndex: chunks.length,
          ...(section.section ? { section: section.section } : {}),
          pdfPageIndex: page.pdfPageIndex,
          ...(page.printedPageNumber
            ? { printedPageNumber: page.printedPageNumber }
            : {}),
        });
      }
    }
  }

  return chunks;
}

function isDrhpContentsPage(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const hasContentsTitle = lines.some((line) =>
    /^(?:table\s+of\s+contents|contents)$/i.test(line),
  );
  const dottedEntries = lines.filter((line) =>
    /[.·…]{6,}\s*\d{1,4}\s*$/.test(line),
  ).length;
  return hasContentsTitle || dottedEntries >= 3;
}

function isPdfPageProxy(value: unknown): value is PdfPageProxy {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.getTextContent === "function";
}

function renderPageText(items: unknown[]): string {
  const parsedItems = items
    .map(asPdfTextItem)
    .filter((item): item is PdfTextItem => item !== undefined && item.str.trim().length > 0);

  if (parsedItems.length === 0) return "";
  if (parsedItems.some((item) => item.y === undefined || item.x === undefined)) {
    return parsedItems.map((item) => item.str).join(" ").trim();
  }

  const rows = new Map<number, PdfTextItem[]>();
  for (const item of parsedItems) {
    const y = item.y;
    if (y === undefined) continue;
    const rowKey = Math.round(y * 2) / 2;
    const row = rows.get(rowKey) ?? [];
    row.push(item);
    rows.set(rowKey, row);
  }

  return [...rows.entries()]
    .sort(([left], [right]) => right - left)
    .map(([, row]) => {
      const sorted = row.sort((left, right) => (left.x ?? 0) - (right.x ?? 0));
      let line = "";
      let previousEnd: number | undefined;
      for (const item of sorted) {
        const x = item.x ?? 0;
        if (previousEnd !== undefined && x - previousEnd > 2) line += " ";
        line += item.str;
        previousEnd = x + (item.width ?? item.str.length * 3);
      }
      return line.trim();
    })
    .filter(Boolean)
    .join("\n");
}

function asPdfTextItem(value: unknown): PdfTextItem | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.str !== "string") return undefined;

  const transform = Array.isArray(record.transform) ? record.transform : [];
  const x = transform[4];
  const y = transform[5];
  return {
    str: record.str,
    ...(typeof x === "number" ? { x } : {}),
    ...(typeof y === "number" ? { y } : {}),
    ...(typeof record.width === "number" ? { width: record.width } : {}),
  };
}
