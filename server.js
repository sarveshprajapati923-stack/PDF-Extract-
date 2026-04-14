const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const util = require("util");
const { execFile } = require("child_process");

const archiver = require("archiver");
const pdfParse = require("pdf-parse");
const Tesseract = require("tesseract.js");

const { PDFDocument, StandardFonts, rgb, degrees } = require("pdf-lib");
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require("docx");
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
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^\w.\-]+/g, "_");
      cb(null, `${Date.now()}_${safe}`);
    }
  }),
  limits: { fileSize: 100 * 1024 * 1024 }
});

function workDir() {
  return fs.mkdtempSync(path.join(TMP_DIR, "job-"));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function baseName(name) {
  return path.parse(name || "file.pdf").name.replace(/[^\w\-]+/g, "_");
}

function parsePages(input, maxPages) {
  if (!input || !String(input).trim()) {
    return Array.from({ length: maxPages }, (_, i) => i + 1);
  }
  const out = new Set();
  for (const raw of String(input).split(",").map(s => s.trim()).filter(Boolean)) {
    if (raw.includes("-")) {
      const [a0, b0] = raw.split("-").map(s => s.trim());
      const a = Number(a0), b = Number(b0);
      if (Number.isInteger(a) && Number.isInteger(b) && a > 0 && b >= a) {
        for (let i = a; i <= b; i++) out.add(i);
      }
    } else {
      const n = Number(raw);
      if (Number.isInteger(n) && n > 0) out.add(n);
    }
  }
  return [...out].filter(n => n >= 1 && n <= maxPages).sort((a,b) => a-b);
}

async function savePdf(pdf, outPath) {
  const bytes = await pdf.save({ useObjectStreams: true });
  await fsp.writeFile(outPath, bytes);
}

async function zipFiles(files, outPath) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    for (const file of files) archive.file(file.path, { name: file.name });
    archive.finalize();
  });
}

async function hasBinary(bin) {
  try {
    await execFileAsync(bin, ["--version"], { maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function runBinary(bin, args) {
  return execFileAsync(bin, args, { maxBuffer: 1024 * 1024 * 20 });
}

function download(res, filePath, name, dir) {
  res.download(filePath, name, () => cleanup(dir));
}

async function textFromPdf(filePath) {
  const buffer = await fsp.readFile(filePath);
  const data = await pdfParse(buffer);
  return (data.text || "").trim();
}

async function pdfToImages(filePath, dir, format = "png") {
  const prefix = path.join(dir, "page");
  const args = format === "jpg" || format === "jpeg"
    ? ["-jpeg", filePath, prefix]
    : ["-png", filePath, prefix];
  await runBinary("pdftoppm", args);
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith("page-") && /\.(png|jpg|jpeg)$/i.test(f))
    .sort((a,b) => {
      const na = Number(a.match(/page-(\d+)/)?.[1] || 0);
      const nb = Number(b.match(/page-(\d+)/)?.[1] || 0);
      return na - nb;
    });
  return files.map(f => ({ path: path.join(dir, f), name: f }));
}

async function docxBuffer(title, text) {
  const lines = String(text || "").split(/\r?\n/);
  const children = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    new Paragraph(" ")
  ];
  for (const line of lines) {
    if (!line.trim()) {
      children.push(new Paragraph(" "));
    } else {
      children.push(new Paragraph({ children: [new TextRun(line)] }));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

async function xlsxFile(outPath, title, text) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Extracted Text");
  ws.columns = [
    { header: "#", key: "n", width: 8 },
    { header: "Text", key: "text", width: 120 }
  ];
  ws.addRow({ n: 1, text: title });
  let n = 2;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    ws.addRow({ n, text: line });
    n++;
  }
  await wb.xlsx.writeFile(outPath);
}

async function pptxFile(outPath, title, text) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  const lines = String(text || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const chunkSize = 12;
  const chunks = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += chunkSize) {
    chunks.push(lines.slice(i, i + chunkSize));
  }
  if (!chunks.length) chunks.push(["No extractable text found."]);
  for (let i = 0; i < chunks.length; i++) {
    const slide = pptx.addSlide();
    slide.background = { color: "0B1220" };
    slide.addText(title, {
      x: 0.45, y: 0.25, w: 12.3, h: 0.5,
      fontFace: "Arial", fontSize: 22, bold: true, color: "FFFFFF"
    });
    slide.addText(i === 0 ? "Converted from PDF" : `Part ${i+1}`, {
      x: 0.45, y: 0.8, w: 12.3, h: 0.3, fontSize: 11, color: "94A3B8"
    });
    slide.addText(chunks[i].join("\n"), {
      x: 0.6, y: 1.2, w: 12, h: 5.8, fontSize: 16,
      color: "E2E8F0", fit: "shrink", breakLine: true, margin: 0.12
    });
  }
  await pptx.writeFile({ fileName: outPath });
}

app.get("/health", (_req, res) => res.json({ ok: true, name: "pdf-tools-pro" }));

/* 1) Merge PDF */
app.post("/api/merge", upload.array("files", 50), async (req, res) => {
  const dir = workDir();
  try {
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({ error: "At least 2 PDF files are required." });
    }
    const merged = await PDFDocument.create();
    for (const file of req.files) {
      const pdf = await PDFDocument.load(await fsp.readFile(file.path));
      const pages = await merged.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }
    const out = path.join(dir, "merged.pdf");
    await savePdf(merged, out);
    download(res, out, "merged.pdf", dir);
  } catch (e) {
    cleanup(dir);
    res.status(500).json({ error: e.message || "Merge failed." });
  }
});

/* 2) Split PDF */
app.post("/api/split", upload.single("file"), async (req, res) => {
  const dir = workDir();
  const splitDir = path.join(dir, "split");
  fs.mkdirSync(splitDir, { recursive: true });
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    const src = await PDFDocument.load(await fsp.readFile(req.file.path));
    const pages = parsePages(req.body.pages, src.getPageCount());
    const items = [];
    for (const pageNum of pages) {
      const doc = await PDFDocument.create();
      const [page] = await doc.copyPages(src, [pageNum - 1]);
      doc.addPage(page);
      const out = path.join(splitDir, `page-${pageNum}.pdf`);
      await savePdf(doc, out);
      items.push({ path: out, name: `page-${pageNum}.pdf` });
    }
    const zip = path.join(dir, "split-pages.zip");
    await zipFiles(items, zip);
    download(res, zip, "split-pages.zip", dir);
  } catch (e) {
    cleanup(dir);
    res.status(500).json({ error: e.message || "Split failed." });
  }
});

/* 3) Compress PDF */
app.post("/api/compress", upload.single("file"), async (req, res) => {
  const dir = workDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    const pdf = await PDFDocument.load(await fsp.readFile(req.file.path));
    const out = path.join(dir, "compressed.pdf");
    await savePdf(pdf, out);
    download(res, out, "compressed.pdf", dir);
  } catch (e) {
    cleanup(dir);
    res.status(500).json({ error: e.message || "Compress failed." });
  }
});

/* 4) PDF to JPG / PNG */
async function convertPdfToImages(req, res, fmt) {
  const dir = workDir();
  const imgDir = path.join(dir, "images");
  fs.mkdirSync(imgDir, { recursive: true });
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    const ok = await hasBinary("pdftoppm");
    if (!ok) {
      return res.status(500).json({ error: "pdftoppm is not installed on the server." });
    }
    const images = await pdfToImages(req.file.path, imgDir, fmt);
    if (!images.length) return res.status(500).json({ error: "No images were generated." });
    const zip = path.join(dir, `pdf-to-${fmt}.zip`);
    await zipFiles(images, zip);
    download(res, zip, `pdf-to-${fmt}.zip`, dir);
  } catch (e) {
    cleanup(dir);
    res.status(500).json({ error: e.message || "Conversion failed." });
  }
}
app.post("/api/pdf-to-jpg", upload.single("file"), (req, res) => convertPdfToImages(req, res, "jpg"));
app.post("/api/pdf-to-png", upload.single("file"), (req, res) => convertPdfToImages(req, res, "png"));

/* 5) JPG to PDF */
app.post("/api/jpg-to-pdf", upload.array("files", 50), async (req, res) => {
  const dir = workDir();
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ error: "Image files are required." });
    const pdf = await PDFDocument.create();
    for (const file of req.files) {
      const raw = await fsp.readFile(file.path);
      const ext = path.extname(file.originalname).toLowerCase();
      const image = ext === ".png" ? await pdf.embedPng(raw) : await pdf.embedJpg(raw);
      const page = pdf.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    }
    const out = path.join(dir, "images.pdf");
    await savePdf(pdf, out);
    download(res, out, "images.pdf", dir);
  } catch (e) {
    cleanup(dir);
    res.status(500).json({ error: e.message || "JPG to PDF failed." });
  }
});

/* 6) PDF to Word */
app.post("/api/pdf-to-docx", upload.single("file"), async (req, res) => {
  const dir = workDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    const text = await textFromPdf(req.file.path);
    const out = path.join(dir, `${baseName(req.file.originalname)}.docx`);
    await fsp.writeFile(out, await docxBuffer(baseName(req.file.originalname).replace(/_/g, " "), text || "No extractable text found."));
    download(res, out, path.basename(out), dir);
  } catch (e) {
    cleanup(dir);
    res.status(500).json({ error: e.message || "PDF to Word failed." });
  }
});

/* 7) PDF to Excel */
app.post("/api/pdf-to-xlsx", upload.single("file"), async (req, res) => {
  const dir = workDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    const text = await textFromPdf(req.file.path);
    const out = path.join(dir, `${baseName(req.file.originalname)}.xlsx`);
    await xlsxFile(out, baseName(req.file.originalname).replace(/_/g, " "), text || "No extractable text found.");
    download(res, out, path.basename(out), dir);
  } catch (e) {
    cleanup(dir);
    res.status(500).json({ error: e.message || "PDF to Excel failed." });
  }
});

/* 8) PDF to PPT */
app.post("/api/pdf-to-pptx", upload.single("file"), async (req, res) => {
  const dir = workDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    const text = await textFromPdf(req.file.path);
    const out = path.join(dir, `${baseName(req.file.originalname)}.pptx`);
    await pptxFile(out, baseName(req.file.originalname).replace(/_/g, " "), text || "No extractable text found.");
    download(res, out, path.basename(out), dir);
  } catch (e) {
    cleanup(dir);
    res.status(500).json({ error: e.message || "PDF to PPT failed." });
  }
});

/* 9) PDF to Text */
app.post("/api/pdf-to-txt", upload.single("file"), async (req, res) => {
  const dir = workDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    const text = await textFromPdf(req.file.path);
    const out = path.join(dir, `${baseName(req.file.originalname)}.txt`);
    await fsp.writeFile(out, text || "No extractable text found.", "utf8");
    download(res, out, path.basename(out), dir);
  } catch (e) {
    cleanup(dir);
    res.status(500).json({ error: e.message || "PDF to Text failed." });
  }
});

/* 10) Rotate */
app.post("/api/rotate", upload.single("file"), async (req, res) => {
  const dir = workDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    const pdf = await PDFDocument.load(await fsp.readFile(req.file.path));
    const angle = Number(req.body.degrees || 90);
    const pages = parsePages(req.body.pages, pdf.getPageCount());
    for (const n of pages) pdf.getPage(n - 1).setRotation(degrees(angle));
    const out = path.join(dir, "rotated.pdf");
    await savePdf(pdf, out);
    download(res, out, "rotated.pdf", dir);
  } catch (e) {
    cleanup(dir);
    res.status(500).json({ error: e.message || "Rotate failed." });
  }
});

/* 11) Delete pages */
app.post("/api/delete-pages", upload.single("file"), async (req, res) => {
  const dir = workDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    const src = await PDFDocument.load(await fsp.readFile(req.file.path));
    const del = new Set(parsePages(req.body.pages, src.getPageCount()));
    const outPdf = await PDFDocument.create();
    const pages = src.getPageIndices().filter(i => !del.has(i + 1));
    const copied = await outPdf.copyPages(src, pages);
    copied.forEach(p => outPdf.addPage(p));
    const out = path.join(dir, "pages-deleted.pdf");
    await savePdf(outPdf, out);
    download(res, out, "pages-deleted.pdf", dir);
  } catch (e) {
    cleanup(dir);
    res.status(500).json({ error: e.message || "Delete pages failed." });
  }
});

/* 12) Reorder pages */
app.post("/api/reorder", upload.single("file"), async (req, res) => {
  const dir = workDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    const src = await PDFDocument.load(await fsp.readFile(req.file.path));
    const order = parsePages(req.body.order, src.getPageCount());
    if (order.length !== src.getPageCount()) {
      return res.status(400).json({ error: `Order must include all ${src.getPageCount()} pages exactly once.` });
    }
    const outPdf = await PDFDocument.create();
    const copied = await outPdf.copyPages(src, order.map(n => n - 1));
    copied.forEach(p => outPdf.addPage(p));
    const out = path.join(dir, "reordered.pdf");
    await savePdf(outPdf, out);
    download(res, out, "reordered.pdf", dir);
  } catch (e) {
    cleanup(dir);
    res.status(500).json({ error: e.message || "Reorder failed." });
  }
});

/* 13) Watermark */
app.post("/api/watermark", upload.single("file"), async (req, res) => {
  const dir = workDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    const pdf = await PDFDocument.load(await fsp.readFile(req.file.path));
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const wm = String(req.body.text || "CONFIDENTIAL");
    for (const page of pdf.getPages()) {
      const { width, height } = page.getSize();
      page.drawText(wm, {
        x: width * 0.18,
        y: height * 0.5,
        size: 42,
        font,
        rotate: degrees(32),
        color: rgb(0.72, 0.72, 0.72),
        opacity: 0.22
      });
    }
    const out = path.join(dir, "watermarked.pdf");
    await savePdf(pdf, out);
    download(res, out, "watermarked.pdf", dir);
  } catch (e) {
    cleanup(dir);
    res.status(500).json({ error: e.message || "Watermark failed." });
  }
});

/* 14) Page numbers */
app.post("/api/page-numbers", upload.single("file"), async (req, res) => {
  const dir = workDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    const pdf = await PDFDocument.load(await fsp.readFile(req.file.path));
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const total = pdf.getPageCount();
    pdf.getPages().forEach((page, idx) => {
      const { width } = page.getSize();
      const txt = `${idx + 1} / ${total}`;
      const w = font.widthOfTextAtSize(txt, 10);
      page.drawText(txt, { x: width - w - 24, y: 18, size: 10, font, color: rgb(0.4, 0.4, 0.4) });
    });
    const out = path.join(dir, "page-numbered.pdf");
    await savePdf(pdf, out);
    download(res, out, "page-numbered.pdf", dir);
  } catch (e) {
    cleanup(dir);
    res.status(500).json({ error: e.message || "Page numbers failed." });
  }
});

/* 15) Protect */
app.post("/api/protect", upload.single("file"), async (req, res) => {
  const dir = workDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    const password = String(req.body.password || "");
    if (!password) return res.status(400).json({ error: "Password is required." });
    const qpdf = await hasBinary("qpdf");
    if (!qpdf) return res.status(500).json({ error: "qpdf is not installed on the server." });
    const out = path.join(dir, "protected.pdf");
    await runBinary("qpdf", ["--encrypt", password, password, "256", "--", req.file.path, out]);
    download(res, out, "protected.pdf", dir);
  } catch (e) {
    cleanup(dir);
    res.status(500).json({ error: e.message || "Protect failed." });
  }
});

/* 16) Unlock */
app.post("/api/unlock", upload.single("file"), async (req, res) => {
  const dir = workDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    const password = String(req.body.password || "");
    if (!password) return res.status(400).json({ error: "Password is required." });
    const qpdf = await hasBinary("qpdf");
    if (!qpdf) return res.status(500).json({ error: "qpdf is not installed on the server." });
    const out = path.join(dir, "unlocked.pdf");
    await runBinary("qpdf", [`--password=${password}`, "--decrypt", req.file.path, out]);
    download(res, out, "unlocked.pdf", dir);
  } catch (e) {
    cleanup(dir);
    res.status(500).json({ error: e.message || "Unlock failed." });
  }
});

/* Bonus OCR */
app.post("/api/ocr", upload.single("file"), async (req, res) => {
  const dir = workDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    const maxPages = Math.max(1, Math.min(50, Number(req.body.maxPages || 4)));
    const ok = await hasBinary("pdftoppm");
    if (!ok) return res.status(500).json({ error: "pdftoppm is not installed on the server." });
    const imgDir = path.join(dir, "ocr");
    fs.mkdirSync(imgDir, { recursive: true });
    const images = await pdfToImages(req.file.path, imgDir, "png");
    const selected = images.slice(0, maxPages);
    let finalText = "";
    for (let i = 0; i < selected.length; i++) {
      const result = await Tesseract.recognize(selected[i].path, "eng");
      finalText += `\n\n--- Page ${i + 1} ---\n`;
      finalText += (result.data.text || "").trim();
    }
    const out = path.join(dir, "ocr.txt");
    await fsp.writeFile(out, finalText.trim() || "No OCR text found.", "utf8");
    download(res, out, "ocr.txt", dir);
  } catch (e) {
    cleanup(dir);
    res.status(500).json({ error: e.message || "OCR failed." });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`PDF Tools Pro running on port ${PORT}`);
});
