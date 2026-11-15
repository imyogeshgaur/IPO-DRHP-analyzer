import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkDrhpPages,
  detectDrhpSectionHeading,
  detectPrintedPageNumber,
  isLikelyDrhp,
} from "./drhp.js";
import { AppError } from "../shared/errors.js";

test("DRHP classification requires distinctive prospectus language", () => {
  assert.equal(
    isLikelyDrhp("Draft Red Herring Prospectus for an initial public offering"),
    true,
  );
  assert.equal(
    isLikelyDrhp("Red Herring Prospectus for an initial public offering"),
    true,
  );
  assert.equal(isLikelyDrhp("Draft annual financial statements"), false);
  assert.equal(isLikelyDrhp("A company prospectus for a training course"), false);
});

test("printed page detection accepts explicit footer formats only", () => {
  assert.equal(detectPrintedPageNumber("Offer details\nPage 12 of 120"), "12");
  assert.equal(detectPrintedPageNumber("Financial information\nF-12"), "F-12");
  assert.equal(detectPrintedPageNumber("Financial information\n12"), "12");
  assert.equal(detectPrintedPageNumber("The amount is 12"), undefined);
  assert.equal(detectPrintedPageNumber("The amount is 12\n"), undefined);
});

test("DRHP section heading detection handles named and numbered headings", () => {
  assert.equal(detectDrhpSectionHeading("RISK FACTORS"), "RISK FACTORS");
  assert.equal(
    detectDrhpSectionHeading("SECTION V - FINANCIAL INFORMATION"),
    "FINANCIAL INFORMATION",
  );
  assert.equal(
    detectDrhpSectionHeading(
      "OTHER REGULATORY AND STATUTORY DISCLOSURES .................... 640",
    ),
    "OTHER REGULATORY AND STATUTORY DISCLOSURES",
  );
  assert.equal(
    detectDrhpSectionHeading("The offer comprises a Fresh Issue of shares."),
    undefined,
  );
  assert.equal(
    detectDrhpSectionHeading("General Information Document for investors"),
    undefined,
  );
  assert.equal(
    detectDrhpSectionHeading(
      "our Business – Manufacturing Facilities on page 282, are based on estimates",
    ),
    undefined,
  );
  assert.equal(
    detectDrhpSectionHeading(
      "Financial Information (“Unaudited Proforma Financial Information”). The applicable criteria are described below.",
    ),
    undefined,
  );
  assert.equal(
    detectDrhpSectionHeading("I. FID FDI 305, LLC"),
    undefined,
  );
  assert.equal(
    detectDrhpSectionHeading("The company reported revenue of ₹100 million."),
    undefined,
  );
});

test("DRHP chunks retain PDF and printed-page attribution", () => {
  const chunks = chunkDrhpPages([
    {
      pdfPageIndex: 4,
      printedPageNumber: "F-2",
      text: "The issuer reported revenue of 100.",
      needsOcr: false,
    },
    {
      pdfPageIndex: 5,
      text: "The issue size is 500 shares.",
      needsOcr: false,
    },
  ]);

  assert.deepEqual(
    chunks.map(({ pdfPageIndex, printedPageNumber }) => ({
      pdfPageIndex,
      printedPageNumber,
    })),
    [
      { pdfPageIndex: 4, printedPageNumber: "F-2" },
      { pdfPageIndex: 5, printedPageNumber: undefined },
    ],
  );
  assert.deepEqual(chunks.map(({ chunkIndex }) => chunkIndex), [0, 1]);
});

test("DRHP chunks carry section metadata across page boundaries", () => {
  const chunks = chunkDrhpPages([
    {
      pdfPageIndex: 0,
      printedPageNumber: "12",
      text: "SECTION IV - OUR BUSINESS\nThe company sells eyewear.",
      needsOcr: false,
    },
    {
      pdfPageIndex: 1,
      printedPageNumber: "13",
      text: "The company operates retail stores.",
      needsOcr: false,
    },
    {
      pdfPageIndex: 2,
      printedPageNumber: "14",
      text: "SECTION V - FINANCIAL INFORMATION\nRevenue was ₹100 million.",
      needsOcr: false,
    },
  ]);

  assert.deepEqual(
    chunks.map(({ pdfPageIndex, printedPageNumber, section }) => ({
      pdfPageIndex,
      printedPageNumber,
      section,
    })),
    [
      { pdfPageIndex: 0, printedPageNumber: "12", section: "OUR BUSINESS" },
      { pdfPageIndex: 1, printedPageNumber: "13", section: "OUR BUSINESS" },
      {
        pdfPageIndex: 2,
        printedPageNumber: "14",
        section: "FINANCIAL INFORMATION",
      },
    ],
  );
});

test("DRHP table-of-contents entries do not leak into later section metadata", () => {
  const chunks = chunkDrhpPages([
    {
      pdfPageIndex: 0,
      text: [
        "TABLE OF CONTENTS",
        "SECTION I - GENERAL ........................................ 1",
        "OBJECTS OF THE OFFER ...................................... 167",
        "FINANCIAL INFORMATION ...................................... 210",
      ].join("\n"),
      needsOcr: false,
    },
    {
      pdfPageIndex: 1,
      text: "LENSKART SOLUTIONS LIMITED\nRegistered Office details.",
      needsOcr: false,
    },
    {
      pdfPageIndex: 2,
      text: "SUMMARY OF RESTATED CONSOLIDATED PROFIT AND LOSS\nRevenue from operations.",
      needsOcr: false,
    },
  ]);

  assert.equal(chunks[0]?.section, undefined);
  assert.equal(chunks[1]?.section, undefined);
  assert.equal(
    chunks[2]?.section,
    "SUMMARY OF RESTATED CONSOLIDATED PROFIT AND LOSS",
  );
});

test("DRHP extraction does not silently index pages that require OCR", () => {
  assert.throws(
    () =>
      chunkDrhpPages([
        {
          pdfPageIndex: 8,
          text: "",
          needsOcr: true,
        },
      ]),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "DRHP_OCR_REQUIRED" &&
      error.message.includes("8"),
  );
});
