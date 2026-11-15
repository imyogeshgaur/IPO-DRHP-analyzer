import { readFile } from "node:fs/promises";
import { load } from "cheerio";
import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import { AppError } from "../shared/errors.js";

export type ParsedDocument = {
  text: string;
  mediaType: string;
};

type Parser = (filePath: string) => Promise<ParsedDocument>;

const textParser = async (
  filePath: string,
  mediaType: string,
): Promise<ParsedDocument> => ({
  text: await readFile(filePath, "utf8"),
  mediaType,
});

const parsers: Record<string, Parser> = {
  ".txt": (filePath) => textParser(filePath, "text/plain"),
  ".md": (filePath) => textParser(filePath, "text/markdown"),
  ".markdown": (filePath) => textParser(filePath, "text/markdown"),
  ".js": (filePath) => textParser(filePath, "text/javascript"),
  ".jsx": (filePath) => textParser(filePath, "text/javascript"),
  ".ts": (filePath) => textParser(filePath, "text/typescript"),
  ".tsx": (filePath) => textParser(filePath, "text/typescript"),
  ".mjs": (filePath) => textParser(filePath, "text/javascript"),
  ".cjs": (filePath) => textParser(filePath, "text/javascript"),
  ".py": (filePath) => textParser(filePath, "text/x-python"),
  ".java": (filePath) => textParser(filePath, "text/x-java"),
  ".go": (filePath) => textParser(filePath, "text/x-go"),
  ".rs": (filePath) => textParser(filePath, "text/x-rust"),
  ".json": async (filePath) => {
    const raw = await readFile(filePath, "utf8");
    try {
      return {
        text: JSON.stringify(JSON.parse(raw), null, 2),
        mediaType: "application/json",
      };
    } catch {
      throw new AppError("INVALID_DOCUMENT", "The JSON document is invalid", 422);
    }
  },
  ".csv": async (filePath) => {
    const rows = parseCsv(await readFile(filePath, "utf8"), {
      skip_empty_lines: true,
      relax_column_count: true,
    }) as string[][];
    const [headers = [], ...records] = rows;
    const text = records.length
      ? records
          .map((row) =>
            row
              .map((value, index) =>
                headers[index]
                  ? `${headers[index]}: ${value}`
                  : value,
              )
              .join(" | "),
          )
          .join("\n\n")
      : headers.join(" | ");
    return {
      text,
      mediaType: "text/csv",
    };
  },
  ".xlsx": async (filePath) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheets: string[] = [];

    workbook.eachSheet((worksheet) => {
      const rows: string[][] = [];
      worksheet.eachRow((row) => {
        rows.push(
          Array.from({ length: row.cellCount }, (_, index) =>
            row.getCell(index + 1).text.trim(),
          ),
        );
      });

      const [headers = [], ...records] = rows;
      const formattedRows = records.length
        ? records.map((row) =>
            row
              .map((value, index) =>
                headers[index] ? `${headers[index]}: ${value}` : value,
              )
              .join(" | "),
          )
        : headers.length > 0
          ? [headers.join(" | ")]
          : [];
      if (formattedRows.length > 0) {
        sheets.push(`Sheet: ${worksheet.name}\n${formattedRows.join("\n\n")}`);
      }
    });

    return { text: sheets.join("\n\n"), mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  },
  ".html": async (filePath) => {
    const $ = load(await readFile(filePath, "utf8"));
    $("script, style, noscript").remove();
    return { text: $("body").text().replace(/\s+/g, " ").trim(), mediaType: "text/html" };
  },
  ".htm": async (filePath) => {
    const $ = load(await readFile(filePath, "utf8"));
    $("script, style, noscript").remove();
    return { text: $("body").text().replace(/\s+/g, " ").trim(), mediaType: "text/html" };
  },
  ".pdf": async (filePath) => {
    const parsed = await pdfParse(await readFile(filePath));
    return { text: parsed.text, mediaType: "application/pdf" };
  },
  ".docx": async (filePath) => {
    const parsed = await mammoth.extractRawText({ path: filePath });
    return { text: parsed.value, mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  },
};

export function supportedExtensions(): string[] {
  return Object.keys(parsers);
}

export async function parseDocument(
  filePath: string,
  extension: string,
): Promise<ParsedDocument> {
  const parser = parsers[extension.toLowerCase()];
  if (!parser) {
    throw new AppError(
      "UNSUPPORTED_FILE_TYPE",
      `Unsupported file extension: ${extension || "(none)"}`,
      415,
    );
  }
  const document = await parser(filePath);
  if (!document.text.trim()) {
    throw new AppError(
      "EMPTY_DOCUMENT",
      "No readable text could be extracted from the document",
      422,
    );
  }
  return document;
}

export function splitIntoChunks(
  text: string,
  maxCharacters = 1200,
  overlapCharacters = 200,
): Array<{ text: string; section?: string }> {
  const normalized = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks: Array<{ text: string; section?: string }> = [];
  let section: string | undefined;
  let current = "";

  const flush = (): void => {
    const value = current.trim();
    if (value) chunks.push(section ? { text: value, section } : { text: value });
    current = "";
  };

  for (const paragraph of paragraphs) {
    const heading = paragraph.match(/^(#{1,6})\s+(.+)$/);
    if (heading) section = heading[2]?.trim();

    if (paragraph.length > maxCharacters) {
      flush();
      let start = 0;
      while (start < paragraph.length) {
        const end = Math.min(start + maxCharacters, paragraph.length);
        const value = paragraph.slice(start, end).trim();
        if (value) chunks.push(section ? { text: value, section } : { text: value });
        if (end === paragraph.length) break;
        start = Math.max(end - overlapCharacters, start + 1);
      }
      continue;
    }

    if (current.length > 0 && current.length + paragraph.length + 2 > maxCharacters) {
      const previous = current;
      flush();
      current =
        overlapCharacters > 0
          ? previous.slice(-overlapCharacters).trim()
          : "";
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }

  flush();
  return chunks;
}
