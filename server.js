const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const util = require("util");
const archiver = require("archiver");
const pdfParse = require("pdf-parse");
const Tesseract = require("tesseract.js");

const {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees
} = require("pdf-lib");

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType
} = require("docx");

const ExcelJS = require("exceljs");
const PptxGenJS = require("pptxgenjs");

const execFileAsync = util.promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const TMP_DIR = path.join(ROOT, "tmp");

for (const dir of [UPLOAD_DIR, TMP_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }
});

function makeWorkDir() {
  const dir = fs.mkdtempSync(path.join(TMP_DIR, "job-"));
  return dir;
}

function cleanup(pathsToRemove = []) {
  for (const p of pathsToRemove) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch (_) {}
  }
}

function sendDownload(res, filePath, downloadName, cleanupPaths = []) {
  res.download(filePath, downloadName, (err) => {
    cleanup(cleanupPaths);
    if (err) {
      console.error(err);
    }
  });
}

function parsePageInput(input, maxPages) {
  if (!input || !String(input).trim()) {
    return [...Array(maxPages)].map((_, i) => i + 1);
  }

  const out = new Set();
  const parts = String(input)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of parts) {
    if (part.includes("-")) {
      const [aRaw, bRaw] = part.split("-").map((s) => s.trim());
      const a = Number(aRaw);
      const b = Number(bRaw);
      if (Number.isInteger(a) && Number.isInteger(b) && a > 0 && b >= a) {
        for (let i = a; i <= b; i++) out.add(i);
      }
    } else {
      const n = Number(part);
      if (Number.isInteger(n) && n > 0) out.add(n);
    }
  }

  return [...out].filter((n) => n >= 1 && n <= maxPages).sort((a, b) => a - b);
}

async function savePdf(pdfDoc, filePath) {
  const bytes = await pdfDoc.save({
    useObjectStreams: true
  });
  await fsp.writeFile(filePath, bytes);
}

async function zipFiles(files, zipPath) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", resolve);
    output.on("end", resolve);
    archive.on("error", reject);

    archive.pipe(output);
    for (const file of files) {
      archive.file(file.path, { name: file.name });
    }
    archive.finalize();
  });
}

async function runBinary(bin, args) {
  return execFileAsync(bin, args, { maxBuffer: 1024 * 1024 * 20 });
}

function makeOutputName(base, ext) {
  return `${base}.${ext}`;
}

function getBaseName(originalName) {
  return path.parse(originalName || "file.pdf").name.replace(/[^\w\-]+/g, "_");
}

async function ensureQpdf() {
  try {
    await runBinary("qpdf", ["--version"]);
    return true;
  } catch (_) {
    return false;
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "pdf-tools-pro" });
});

app.post("/api/merge", upload.array("files", 30), async (req, res) => {
  const workDir = makeWorkDir();
  try {
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({ error: "At least 2 PDF files are required." });
    }

    const merged = await PDFDocument.create();

    for (const file of req.files) {
      const bytes = await fsp.readFile(file.path);
      const pdf = await PDFDocument.load(bytes);
      const copiedPages = await merged.copyPages(pdf, pdf.getPageIndices());
      copiedPages.forEach((page) => merged.addPage(page));
    }

    const outPath = path.join(workDir, "merged.pdf");
    await savePdf(merged, outPath);
    sendDownload(res, outPath, "merged.pdf", [workDir]);
  } catch (err) {
    cleanup([workDir]);
    res.status(500).json({ error: err.message || "Merge failed." });
  }
});

app.post("/api/split", upload.single("file"), async (req, res) => {
  const workDir = makeWorkDir();
  const splitDir = path.join(workDir, "split");
  fs.mkdirSync(splitDir, { recursive: true });

  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });

    const bytes = await fsp.readFile(req.file.path);
    const pdf = await PDFDocument.load(bytes);
    const totalPages = pdf.getPageCount();
    const pages = parsePageInput(req.body.pages, totalPages);

    const zipFilesList = [];

    for (const pageNum of pages) {
      const doc = await PDFDocument.create();
      const [copied] = await doc.copyPages(pdf, [pageNum - 1]);
      doc.addPage(copied);

      const pagePath = path.join(splitDir, `page-${pageNum}.pdf`);
      await savePdf(doc, pagePath);
      zipFilesList.push({ path: pagePath, name: `page-${pageNum}.pdf` });
    }

    const zipPath = path.join(workDir, "split-pages.zip");
    await zipFiles(zipFilesList, zipPath);
    sendDownload(res, zipPath, "split-pages.zip", [workDir]);
  } catch (err) {
    cleanup([workDir]);
    res.status(500).json({ error: err.message || "Split failed." });
  }
});

app.post("/api/compress", upload.single("file"), async (req, res) => {
  const workDir = makeWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });

    const bytes = await fsp.readFile(req.file.path);
    const pdf = await PDFDocument.load(bytes);

    const outPath = path.join(workDir, "compressed.pdf");
    await savePdf(pdf, outPath);

    sendDownload(res, outPath, "compressed.pdf", [workDir]);
  } catch (err) {
    cleanup([workDir]);
    res.status(500).json({ error: err.message || "Compress failed." });
  }
});

app.post("/api/rotate", upload.single("file"), async (req, res) => {
  const workDir = makeWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });

    const degreesVal = Number(req.body.degrees || 90);
    const bytes = await fsp.readFile(req.file.path);
    const pdf = await PDFDocument.load(bytes);

    const pages = parsePageInput(req.body.pages, pdf.getPageCount());
    for (const pageNum of pages) {
      const page = pdf.getPage(pageNum - 1);
      page.setRotation(degrees(degreesVal));
    }

    const outPath = path.join(workDir, "rotated.pdf");
    await savePdf(pdf, outPath);
    sendDownload(res, outPath, "rotated.pdf", [workDir]);
  } catch (err) {
    cleanup([workDir]);
    res.status(500).json({ error: err.message || "Rotate failed." });
  }
});

app.post("/api/delete-pages", upload.single("file"), async (req, res) => {
  const workDir = makeWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });

    const bytes = await fsp.readFile(req.file.path);
    const src = await PDFDocument.load(bytes);
    const totalPages = src.getPageCount();
    const deleteSet = new Set(parsePageInput(req.body.pages, totalPages));

    const outPdf = await PDFDocument.create();
    const copied = await outPdf.copyPages(
      src,
      src.getPageIndices().filter((i) => !deleteSet.has(i + 1))
    );
    copied.forEach((page) => outPdf.addPage(page));

    const outPath = path.join(workDir, "cleaned.pdf");
    await savePdf(outPdf, outPath);
    sendDownload(res, outPath, "cleaned.pdf", [workDir]);
  } catch (err) {
    cleanup([workDir]);
    res.status(500).json({ error: err.message || "Delete pages failed." });
  }
});

app.post("/api/reorder", upload.single("file"), async (req, res) => {
  const workDir = makeWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });

    const bytes = await fsp.readFile(req.file.path);
    const src = await PDFDocument.load(bytes);
    const totalPages = src.getPageCount();
    const order = parsePageInput(req.body.order, totalPages);

    if (order.length !== totalPages) {
      return res.status(400).json({
        error: `Order must include all ${totalPages} pages exactly once.`
      });
    }

    const outPdf = await PDFDocument.create();
    const copied = await outPdf.copyPages(src, order.map((n) => n - 1));
    copied.forEach((page) => outPdf.addPage(page));

    const outPath = path.join(workDir, "reordered.pdf");
    await savePdf(outPdf, outPath);
    sendDownload(res, outPath, "reordered.pdf", [workDir]);
  } catch (err) {
    cleanup([workDir]);
    res.status(500).json({ error: err.message || "Reorder failed." });
  }
});

app.post("/api/watermark", upload.single("file"), async (req, res) => {
  const workDir = makeWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });

    const watermark = String(req.body.text || "CONFIDENTIAL");
    const bytes = await fsp.readFile(req.file.path);
    const pdf = await PDFDocument.load(bytes);

    const font = await pdf.embedFont(StandardFonts.HelveticaBold);

    for (const page of pdf.getPages()) {
      const { width, height } = page.getSize();
      page.drawText(watermark, {
        x: width * 0.18,
        y: height * 0.5,
        size: 42,
        font,
        rotate: degrees(30),
        color: rgb(0.7, 0.7, 0.7),
        opacity: 0.22
      });
    }

    const outPath = path.join(workDir, "watermarked.pdf");
    await savePdf(pdf, outPath);
    sendDownload(res, outPath, "watermarked.pdf", [workDir]);
  } catch (err) {
    cleanup([workDir]);
    res.status(500).json({ error: err.message || "Watermark failed." });
  }
});

app.post("/api/page-numbers", upload.single("file"), async (req, res) => {
  const workDir = makeWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });

    const bytes = await fsp.readFile(req.file.path);
    const pdf = await PDFDocument.load(bytes);
    const font = await pdf.embedFont(StandardFonts.Helvetica);

    const total = pdf.getPageCount();
    pdf.getPages().forEach((page, idx) => {
      const { width } = page.getSize();
      const text = `${idx + 1} / ${total}`;
      const textWidth = font.widthOfTextAtSize(text, 10);

      page.drawText(text, {
        x: width - textWidth - 24,
        y: 18,
        size: 10,
        font,
        color: rgb(0.4, 0.4, 0.4)
      });
    });

    const outPath = path.join(workDir, "numbered.pdf");
    await savePdf(pdf, outPath);
    sendDownload(res, outPath, "numbered.pdf", [workDir]);
  } catch (err) {
    cleanup([workDir]);
    res.status(500).json({ error: err.message || "Page numbers failed." });
  }
});

app.post("/api/protect", upload.single("file"), async (req, res) => {
  const workDir = makeWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    const password = String(req.body.password || "");
    if (!password) return res.status(400).json({ error: "Password is required." });

    const qpdfOk = await ensureQpdf();
    if (!qpdfOk) {
      return res.status(500).json({
        error: "qpdf is not installed on the server. Install qpdf to enable protect/unlock."
      });
    }

    const outPath = path.join(workDir, "protected.pdf");
    await runBinary("qpdf", [
      "--encrypt",
      password,
      password,
      "256",
      "--",
      req.file.path,
      outPath
    ]);

    sendDownload(res, outPath, "protected.pdf", [workDir]);
  } catch (err) {
    cleanup([workDir]);
    res.status(500).json({ error: err.message || "Protect failed." });
  }
});

app.post("/api/unlock", upload.single("file"), async (req, res) => {
  const workDir = makeWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    const password = String(req.body.password || "");
    if (!password) return res.status(400).json({ error: "Password is required." });

    const qpdfOk = await ensureQpdf();
    if (!qpdfOk) {
      return res.status(500).json({
        error: "qpdf is not installed on the server. Install qpdf to enable protect/unlock."
      });
    }

    const outPath = path.join(workDir, "unlocked.pdf");
    await runBinary("qpdf", [
      `--password=${password}`,
      "--decrypt",
      req.file.path,
      outPath
    ]);

    sendDownload(res, outPath, "unlocked.pdf", [workDir]);
  } catch (err) {
    cleanup([workDir]);
    res.status(500).json({ error: err.message || "Unlock failed." });
  }
});

async function extractText(filePath) {
  const buffer = await fsp.readFile(filePath);
  const data = await pdfParse(buffer);
  return (data.text || "").trim();
}

function makeDocxBuffer(title, text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trimEnd());

  const children = [
    new Paragraph({
      text: title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER
    }),
    new Paragraph({
      text: ""
    })
  ];

  for (const line of lines) {
    if (!line.trim()) {
      children.push(new Paragraph(" "));
    } else {
      children.push(
        new Paragraph({
          children: [new TextRun(line)]
        })
      );
    }
  }

  const doc = new Document({
    sections: [{ properties: {}, children }]
  });

  return Packer.toBuffer(doc);
}

async function makeXlsxFile(outPath, title, text) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Extracted Text");

  sheet.columns = [
    { header: "#", key: "n", width: 8 },
    { header: "Text", key: "text", width: 120 }
  ];

  const lines = String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trimEnd());

  sheet.addRow({ n: 1, text: title });
  let rowNo = 2;

  for (const line of lines) {
    if (!line.trim()) continue;
    sheet.addRow({ n: rowNo, text: line });
    rowNo++;
  }

  await workbook.xlsx.writeFile(outPath);
}

async function makePptxFile(outPath, title, text) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";

  const allLines = String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trimEnd())
    .filter(Boolean);

  const chunkSize = 14;
  const chunks = [];
  for (let i = 0; i < allLines.length; i += chunkSize) {
    chunks.push(allLines.slice(i, i + chunkSize));
  }

  if (!chunks.length) chunks.push(["No extractable text found."]);

  chunks.forEach((chunk, idx) => {
    const slide = pptx.addSlide();
    slide.background = { color: "0F172A" };
    slide.addText(title, {
      x: 0.45,
      y: 0.3,
      w: 12.3,
      h: 0.6,
      fontFace: "Arial",
      fontSize: 22,
      bold: true,
      color: "FFFFFF"
    });
    slide.addText(idx === 0 ? "Converted from PDF" : `Part ${idx + 1}`, {
      x: 0.45,
      y: 0.95,
      w: 12.3,
      h: 0.3,
      fontSize: 11,
      color: "94A3B8"
    });
    slide.addText(chunk.join("\n"), {
      x: 0.6,
      y: 1.35,
      w: 12,
      h: 5.5,
      fontSize: 16,
      color: "E2E8F0",
      breakLine: true,
      valign: "top",
      margin: 0.1,
      fit: "shrink"
    });
  });

  await pptx.writeFile({ fileName: outPath });
}

async function pdfToImages(filePath, outDir, format = "png") {
  const prefix = path.join(outDir, "page");
  const args = format === "jpg" || format === "jpeg"
    ? ["-jpeg", filePath, prefix]
    : ["-png", filePath, prefix];

  await runBinary("pdftoppm", args);

  const files = fs.readdirSync(outDir)
    .filter((f) => f.startsWith("page-") && (f.endsWith(".png") || f.endsWith(".jpg") || f.endsWith(".jpeg")))
    .sort((a, b) => {
      const na = Number(a.match(/page-(\d+)/)?.[1] || 0);
      const nb = Number(b.match(/page-(\d+)/)?.[1] || 0);
      return na - nb;
    });

  return files.map((name) => path.join(outDir, name));
}

app.post("/api/convert/:format", upload.single("file"), async (req, res) => {
  const workDir = makeWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });

    const format = String(req.params.format || "").toLowerCase();
    const base = getBaseName(req.file.originalname);
    const title = base.replace(/_/g, " ");

    const text = await extractText(req.file.path);

    if (format === "txt") {
      const outPath = path.join(workDir, `${base}.txt`);
      await fsp.writeFile(outPath, text || "No extractable text found.", "utf8");
      return sendDownload(res, outPath, `${base}.txt`, [workDir]);
    }

    if (format === "docx") {
      const outPath = path.join(workDir, `${base}.docx`);
      const buffer = await makeDocxBuffer(title, text || "No extractable text found.");
      await fsp.writeFile(outPath, buffer);
      return sendDownload(res, outPath, `${base}.docx`, [workDir]);
    }

    if (format === "xlsx") {
      const outPath = path.join(workDir, `${base}.xlsx`);
      await makeXlsxFile(outPath, title, text || "No extractable text found.");
      return sendDownload(res, outPath, `${base}.xlsx`, [workDir]);
    }

    if (format === "pptx") {
      const outPath = path.join(workDir, `${base}.pptx`);
      await makePptxFile(outPath, title, text || "No extractable text found.");
      return sendDownload(res, outPath, `${base}.pptx`, [workDir]);
    }

    if (format === "png" || format === "jpg" || format === "jpeg") {
      const imageDir = path.join(workDir, "images");
      fs.mkdirSync(imageDir, { recursive: true });

      const images = await pdfToImages(req.file.path, imageDir, format);
      if (!images.length) {
        return res.status(500).json({ error: "No pages converted to images." });
      }

      const zipPath = path.join(workDir, `${base}-${format}.zip`);
      await zipFiles(
        images.map((p) => ({ path: p, name: path.basename(p) })),
        zipPath
      );
      return sendDownload(res, zipPath, `${base}-${format}.zip`, [workDir]);
    }

    return res.status(400).json({
      error: "Unsupported format. Use docx, xlsx, pptx, txt, png, or jpg."
    });
  } catch (err) {
    cleanup([workDir]);
    res.status(500).json({ error: err.message || "Conversion failed." });
  }
});

app.post("/api/ocr", upload.single("file"), async (req, res) => {
  const workDir = makeWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });

    const maxPages = Math.max(1, Math.min(50, Number(req.body.maxPages || 5)));
    const imageDir = path.join(workDir, "ocr-images");
    fs.mkdirSync(imageDir, { recursive: true });

    const images = await pdfToImages(req.file.path, imageDir, "png");
    const selected = images.slice(0, maxPages);

    if (!selected.length) {
      return res.status(500).json({ error: "OCR images could not be generated." });
    }

    let finalText = "";

    for (let i = 0; i < selected.length; i++) {
      const img = selected[i];
      const result = await Tesseract.recognize(img, "eng");
      finalText += `\n\n--- Page ${i + 1} ---\n`;
      finalText += (result.data.text || "").trim();
    }

    const outPath = path.join(workDir, "ocr-text.txt");
    await fsp.writeFile(outPath, finalText.trim() || "No OCR text found.", "utf8");
    sendDownload(res, outPath, "ocr-text.txt", [workDir]);
  } catch (err) {
    cleanup([workDir]);
    res.status(500).json({ error: err.message || "OCR failed." });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`PDF Tools Pro running on http://localhost:${PORT}`);
});
