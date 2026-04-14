const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const util = require("util");
const archiver = require("archiver");
const pdfParse = require("pdf-parse");
const Tesseract = require("tesseract.js");
const { execFile } = require("child_process");

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

const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const TMP_DIR = path.join(os.tmpdir(), "fileforge-work");

for (const dir of [UPLOAD_DIR, TMP_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

const MAX_SINGLE_FILE = 10 * 1024 * 1024; // 10 MB
const MAX_MULTI_FILE = 10 * 1024 * 1024;  // per file
const MAX_FILES = 10;

const allowedMimeTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png"
]);

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: MAX_MULTI_FILE,
    files: MAX_FILES
  },
  fileFilter: (_req, file, cb) => {
    if (allowedMimeTypes.has(file.mimetype)) return cb(null, true);
    cb(new Error("Only PDF, JPG, JPEG, and PNG files are allowed."));
  }
});

function createWorkDir() {
  const dir = fs.mkdtempSync(path.join(TMP_DIR, "job-"));
  return dir;
}

function cleanupFiles(files = []) {
  for (const file of files) {
    if (!file || !file.path) continue;
    try {
      fs.unlinkSync(file.path);
    } catch (_) {}
  }
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

function sendDownload(res, filePath, downloadName, workDir, uploadedFiles = []) {
  res.download(filePath, downloadName, (err) => {
    cleanupFiles(uploadedFiles);
    cleanupDir(workDir);
    if (err) console.error(err);
  });
}

function isPdf(file) {
  return file && file.mimetype === "application/pdf";
}

function isImage(file) {
  return file && (file.mimetype === "image/jpeg" || file.mimetype === "image/png");
}

function safeBaseName(name) {
  return path.parse(name || "file").name.replace(/[^\w\-]+/g, "_");
}

function parsePageList(input, maxPages) {
  if (!input || !String(input).trim()) {
    return [];
  }

  const result = new Set();
  const parts = String(input)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  for (const part of parts) {
    if (part.includes("-")) {
      const [aRaw, bRaw] = part.split("-").map(s => s.trim());
      const a = Number(aRaw);
      const b = Number(bRaw);
      if (Number.isInteger(a) && Number.isInteger(b) && a > 0 && b >= a) {
        for (let i = a; i <= b; i++) result.add(i);
      }
    } else {
      const n = Number(part);
      if (Number.isInteger(n) && n > 0) result.add(n);
    }
  }

  return [...result]
    .filter(n => n >= 1 && n <= maxPages)
    .sort((a, b) => a - b);
}

function requireAtLeastOneFile(req, res) {
  if (!req.file && !(req.files && req.files.length)) {
    res.status(400).json({ error: "File is required." });
    return false;
  }
  return true;
}

async function fileExists(cmd) {
  try {
    await execFileAsync(cmd, ["--version"], { maxBuffer: 1024 * 1024 });
    return true;
  } catch (_) {
    return false;
  }
}

async function savePdf(pdfDoc, outPath) {
  const bytes = await pdfDoc.save({ useObjectStreams: true });
  await fsp.writeFile(outPath, bytes);
}

async function zipFiles(fileList, zipPath) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", resolve);
    output.on("end", resolve);
    archive.on("error", reject);

    archive.pipe(output);
    for (const item of fileList) {
      archive.file(item.path, { name: item.name });
    }
    archive.finalize();
  });
}

async function extractTextFromPdf(filePath) {
  const buffer = await fsp.readFile(filePath);
  const data = await pdfParse(buffer);
  return (data.text || "").trim();
}

async function makeDocx(title, text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(s => s.trimEnd());

  const children = [
    new Paragraph({
      text: title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER
    }),
    new Paragraph(" ")
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
    sections: [{ children }]
  });

  return Packer.toBuffer(doc);
}

async function makeXlsx(outPath, title, text) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Extracted Text");

  sheet.columns = [
    { header: "#", key: "n", width: 8 },
    { header: "Text", key: "text", width: 120 }
  ];

  const lines = String(text || "")
    .split(/\r?\n/)
    .map(s => s.trimEnd())
    .filter(Boolean);

  sheet.addRow({ n: 1, text: title });

  let rowNo = 2;
  for (const line of lines) {
    sheet.addRow({ n: rowNo, text: line });
    rowNo++;
  }

  await workbook.xlsx.writeFile(outPath);
}

async function makePptx(outPath, title, text) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";

  const lines = String(text || "")
    .split(/\r?\n/)
    .map(s => s.trimEnd())
    .filter(Boolean);

  const chunkSize = 14;
  const chunks = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    chunks.push(lines.slice(i, i + chunkSize));
  }
  if (!chunks.length) chunks.push(["No extractable text found."]);

  chunks.forEach((chunk, idx) => {
    const slide = pptx.addSlide();
    slide.background = { color: "0B1220" };
    slide.addText(title, {
      x: 0.5,
      y: 0.3,
      w: 12,
      h: 0.6,
      fontSize: 22,
      bold: true,
      color: "FFFFFF"
    });
    slide.addText(idx === 0 ? "Converted from PDF" : `Part ${idx + 1}`, {
      x: 0.5,
      y: 0.9,
      w: 12,
      h: 0.3,
      fontSize: 11,
      color: "94A3B8"
    });
    slide.addText(chunk.join("\n"), {
      x: 0.6,
      y: 1.3,
      w: 12,
      h: 5.4,
      fontSize: 16,
      color: "E2E8F0",
      margin: 0.08,
      fit: "shrink",
      valign: "top"
    });
  });

  await pptx.writeFile({ fileName: outPath });
}

async function pdfToImagesViaPdftoppm(pdfPath, outDir, format = "png") {
  const prefix = path.join(outDir, "page");
  const args = format === "jpg"
    ? ["-jpeg", pdfPath, prefix]
    : ["-png", pdfPath, prefix];

  await execFileAsync("pdftoppm", args, { maxBuffer: 1024 * 1024 * 20 });

  const files = fs
    .readdirSync(outDir)
    .filter(f => f.startsWith("page-") && (f.endsWith(".png") || f.endsWith(".jpg") || f.endsWith(".jpeg")))
    .sort((a, b) => {
      const na = Number(a.match(/page-(\d+)/)?.[1] || 0);
      const nb = Number(b.match(/page-(\d+)/)?.[1] || 0);
      return na - nb;
    });

  return files.map(name => path.join(outDir, name));
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, name: "FileForge" });
});

/* MERGE PDF */
app.post("/api/merge", upload.array("files", 10), async (req, res) => {
  const workDir = createWorkDir();
  try {
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({ error: "Upload at least 2 PDF files." });
    }

    for (const file of req.files) {
      if (!isPdf(file)) {
        return res.status(400).json({ error: "Merge accepts only PDF files." });
      }
    }

    const merged = await PDFDocument.create();

    for (const file of req.files) {
      const bytes = await fsp.readFile(file.path);
      const pdf = await PDFDocument.load(bytes);
      const pages = await merged.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }

    const outPath = path.join(workDir, "merged.pdf");
    await savePdf(merged, outPath);
    sendDownload(res, outPath, "merged.pdf", workDir, req.files);
  } catch (err) {
    cleanupFiles(req.files);
    cleanupDir(workDir);
    res.status(500).json({ error: err.message || "Merge failed." });
  }
});

/* SPLIT PDF */
app.post("/api/split", upload.single("file"), async (req, res) => {
  const workDir = createWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    if (!isPdf(req.file)) return res.status(400).json({ error: "Split accepts only PDF files." });

    const bytes = await fsp.readFile(req.file.path);
    const pdf = await PDFDocument.load(bytes);
    const totalPages = pdf.getPageCount();
    const selectedPages = parsePageList(req.body.pages, totalPages);

    const pagesToSplit = selectedPages.length ? selectedPages : [...Array(totalPages)].map((_, i) => i + 1);
    const pageFiles = [];

    for (const pageNum of pagesToSplit) {
      const doc = await PDFDocument.create();
      const [page] = await doc.copyPages(pdf, [pageNum - 1]);
      doc.addPage(page);

      const pagePath = path.join(workDir, `page-${pageNum}.pdf`);
      await savePdf(doc, pagePath);
      pageFiles.push({ path: pagePath, name: `page-${pageNum}.pdf` });
    }

    const zipPath = path.join(workDir, "split-pages.zip");
    await zipFiles(pageFiles, zipPath);
    sendDownload(res, zipPath, "split-pages.zip", workDir, [req.file]);
  } catch (err) {
    cleanupFiles([req.file]);
    cleanupDir(workDir);
    res.status(500).json({ error: err.message || "Split failed." });
  }
});

/* COMPRESS PDF */
app.post("/api/compress", upload.single("file"), async (req, res) => {
  const workDir = createWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    if (!isPdf(req.file)) return res.status(400).json({ error: "Compress accepts only PDF files." });

    const pdf = await PDFDocument.load(await fsp.readFile(req.file.path));
    const outPath = path.join(workDir, "compressed.pdf");
    await savePdf(pdf, outPath);

    sendDownload(res, outPath, "compressed.pdf", workDir, [req.file]);
  } catch (err) {
    cleanupFiles([req.file]);
    cleanupDir(workDir);
    res.status(500).json({ error: err.message || "Compress failed." });
  }
});

/* JPG/PNG → PDF */
app.post("/api/jpg-to-pdf", upload.array("files", 10), async (req, res) => {
  const workDir = createWorkDir();
  try {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: "Image files are required." });
    }

    for (const file of req.files) {
      if (!isImage(file)) {
        return res.status(400).json({ error: "JPG to PDF accepts only JPG, JPEG, or PNG images." });
      }
    }

    const pdf = await PDFDocument.create();
    for (const file of req.files) {
      const buffer = await fsp.readFile(file.path);
      let img;
      if (file.mimetype === "image/png") {
        img = await pdf.embedPng(buffer);
      } else {
        img = await pdf.embedJpg(buffer);
      }

      const page = pdf.addPage([img.width, img.height]);
      page.drawImage(img, {
        x: 0,
        y: 0,
        width: img.width,
        height: img.height
      });
    }

    const outPath = path.join(workDir, "images-to-pdf.pdf");
    await savePdf(pdf, outPath);
    sendDownload(res, outPath, "images-to-pdf.pdf", workDir, req.files);
  } catch (err) {
    cleanupFiles(req.files);
    cleanupDir(workDir);
    res.status(500).json({ error: err.message || "JPG to PDF failed." });
  }
});

/* ROTATE PDF */
app.post("/api/rotate", upload.single("file"), async (req, res) => {
  const workDir = createWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    if (!isPdf(req.file)) return res.status(400).json({ error: "Rotate accepts only PDF files." });

    const angle = Number(req.body.angle || 90);
    const validAngle = [90, 180, 270].includes(angle) ? angle : 90;
    const bytes = await fsp.readFile(req.file.path);
    const pdf = await PDFDocument.load(bytes);

    const pages = parsePageList(req.body.pages, pdf.getPageCount());
    const targets = pages.length ? pages : [...Array(pdf.getPageCount())].map((_, i) => i + 1);

    for (const pageNum of targets) {
      const page = pdf.getPage(pageNum - 1);
      page.setRotation(degrees(validAngle));
    }

    const outPath = path.join(workDir, "rotated.pdf");
    await savePdf(pdf, outPath);

    sendDownload(res, outPath, "rotated.pdf", workDir, [req.file]);
  } catch (err) {
    cleanupFiles([req.file]);
    cleanupDir(workDir);
    res.status(500).json({ error: err.message || "Rotate failed." });
  }
});

/* DELETE PAGES */
app.post("/api/delete-pages", upload.single("file"), async (req, res) => {
  const workDir = createWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    if (!isPdf(req.file)) return res.status(400).json({ error: "Delete Pages accepts only PDF files." });

    const bytes = await fsp.readFile(req.file.path);
    const src = await PDFDocument.load(bytes);
    const totalPages = src.getPageCount();
    const deletePages = parsePageList(req.body.pages, totalPages);

    if (!deletePages.length) {
      return res.status(400).json({ error: "Provide pages to delete like 2,4 or 1-3." });
    }

    const keepIndices = src.getPageIndices().filter(i => !deletePages.includes(i + 1));
    if (!keepIndices.length) {
      return res.status(400).json({ error: "You cannot delete all pages." });
    }

    const outPdf = await PDFDocument.create();
    const copied = await outPdf.copyPages(src, keepIndices);
    copied.forEach(page => outPdf.addPage(page));

    const outPath = path.join(workDir, "pages-deleted.pdf");
    await savePdf(outPdf, outPath);

    sendDownload(res, outPath, "pages-deleted.pdf", workDir, [req.file]);
  } catch (err) {
    cleanupFiles([req.file]);
    cleanupDir(workDir);
    res.status(500).json({ error: err.message || "Delete pages failed." });
  }
});

/* REORDER PAGES */
app.post("/api/reorder", upload.single("file"), async (req, res) => {
  const workDir = createWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    if (!isPdf(req.file)) return res.status(400).json({ error: "Reorder accepts only PDF files." });

    const bytes = await fsp.readFile(req.file.path);
    const src = await PDFDocument.load(bytes);
    const totalPages = src.getPageCount();
    const order = parsePageList(req.body.order, totalPages);

    if (order.length !== totalPages) {
      return res.status(400).json({
        error: `Order must include all ${totalPages} pages exactly once. Example: 3,1,2,4`
      });
    }

    const unique = new Set(order);
    if (unique.size !== totalPages) {
      return res.status(400).json({ error: "Order cannot contain duplicate page numbers." });
    }

    const outPdf = await PDFDocument.create();
    const copied = await outPdf.copyPages(src, order.map(n => n - 1));
    copied.forEach(page => outPdf.addPage(page));

    const outPath = path.join(workDir, "reordered.pdf");
    await savePdf(outPdf, outPath);

    sendDownload(res, outPath, "reordered.pdf", workDir, [req.file]);
  } catch (err) {
    cleanupFiles([req.file]);
    cleanupDir(workDir);
    res.status(500).json({ error: err.message || "Reorder failed." });
  }
});

/* WATERMARK */
app.post("/api/watermark", upload.single("file"), async (req, res) => {
  const workDir = createWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    if (!isPdf(req.file)) return res.status(400).json({ error: "Watermark accepts only PDF files." });

    const watermarkText = String(req.body.text || "CONFIDENTIAL").trim() || "CONFIDENTIAL";
    const bytes = await fsp.readFile(req.file.path);
    const pdf = await PDFDocument.load(bytes);
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);

    for (const page of pdf.getPages()) {
      const { width, height } = page.getSize();
      page.drawText(watermarkText, {
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

    sendDownload(res, outPath, "watermarked.pdf", workDir, [req.file]);
  } catch (err) {
    cleanupFiles([req.file]);
    cleanupDir(workDir);
    res.status(500).json({ error: err.message || "Watermark failed." });
  }
});

/* PAGE NUMBERS */
app.post("/api/page-numbers", upload.single("file"), async (req, res) => {
  const workDir = createWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    if (!isPdf(req.file)) return res.status(400).json({ error: "Page Numbers accepts only PDF files." });

    const bytes = await fsp.readFile(req.file.path);
    const pdf = await PDFDocument.load(bytes);
    const font = await pdf.embedFont(StandardFonts.Helvetica);

    const total = pdf.getPageCount();
    for (const [index, page] of pdf.getPages().entries()) {
      const { width } = page.getSize();
      const text = `${index + 1} / ${total}`;
      const textWidth = font.widthOfTextAtSize(text, 10);
      page.drawText(text, {
        x: width - textWidth - 24,
        y: 18,
        size: 10,
        font,
        color: rgb(0.4, 0.4, 0.4)
      });
    }

    const outPath = path.join(workDir, "numbered.pdf");
    await savePdf(pdf, outPath);

    sendDownload(res, outPath, "numbered.pdf", workDir, [req.file]);
  } catch (err) {
    cleanupFiles([req.file]);
    cleanupDir(workDir);
    res.status(500).json({ error: err.message || "Page numbers failed." });
  }
});

/* PROTECT PDF */
app.post("/api/protect", upload.single("file"), async (req, res) => {
  const workDir = createWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    if (!isPdf(req.file)) return res.status(400).json({ error: "Protect accepts only PDF files." });

    const password = String(req.body.password || "").trim();
    if (!password) return res.status(400).json({ error: "Password is required." });

    const qpdfExists = await fileExists("qpdf");
    if (!qpdfExists) {
      return res.status(500).json({ error: "qpdf is not installed on the server." });
    }

    const outPath = path.join(workDir, "protected.pdf");
    await execFileAsync("qpdf", [
      "--encrypt",
      password,
      password,
      "256",
      "--",
      req.file.path,
      outPath
    ]);

    sendDownload(res, outPath, "protected.pdf", workDir, [req.file]);
  } catch (err) {
    cleanupFiles([req.file]);
    cleanupDir(workDir);
    res.status(500).json({ error: err.message || "Protect failed." });
  }
});

/* UNLOCK PDF */
app.post("/api/unlock", upload.single("file"), async (req, res) => {
  const workDir = createWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    if (!isPdf(req.file)) return res.status(400).json({ error: "Unlock accepts only PDF files." });

    const password = String(req.body.password || "").trim();
    if (!password) return res.status(400).json({ error: "Password is required." });

    const qpdfExists = await fileExists("qpdf");
    if (!qpdfExists) {
      return res.status(500).json({ error: "qpdf is not installed on the server." });
    }

    const outPath = path.join(workDir, "unlocked.pdf");
    await execFileAsync("qpdf", [
      `--password=${password}`,
      "--decrypt",
      req.file.path,
      outPath
    ]);

    sendDownload(res, outPath, "unlocked.pdf", workDir, [req.file]);
  } catch (err) {
    cleanupFiles([req.file]);
    cleanupDir(workDir);
    res.status(500).json({ error: err.message || "Unlock failed." });
  }
});

/* PDF → DOCX / XLSX / PPTX / TXT / JPG / PNG */
app.post("/api/convert/:format", upload.single("file"), async (req, res) => {
  const workDir = createWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    if (!isPdf(req.file)) return res.status(400).json({ error: "PDF is required for conversion." });

    const format = String(req.params.format || "").toLowerCase();
    const base = safeBaseName(req.file.originalname);
    const text = await extractTextFromPdf(req.file.path);
    const title = base.replace(/_/g, " ");

    if (format === "txt") {
      const outPath = path.join(workDir, `${base}.txt`);
      await fsp.writeFile(outPath, text || "No extractable text found.", "utf8");
      return sendDownload(res, outPath, `${base}.txt`, workDir, [req.file]);
    }

    if (format === "docx") {
      const outPath = path.join(workDir, `${base}.docx`);
      const buffer = await makeDocx(title, text || "No extractable text found.");
      await fsp.writeFile(outPath, buffer);
      return sendDownload(res, outPath, `${base}.docx`, workDir, [req.file]);
    }

    if (format === "xlsx") {
      const outPath = path.join(workDir, `${base}.xlsx`);
      await makeXlsx(outPath, title, text || "No extractable text found.");
      return sendDownload(res, outPath, `${base}.xlsx`, workDir, [req.file]);
    }

    if (format === "pptx") {
      const outPath = path.join(workDir, `${base}.pptx`);
      await makePptx(outPath, title, text || "No extractable text found.");
      return sendDownload(res, outPath, `${base}.pptx`, workDir, [req.file]);
    }

    if (format === "png" || format === "jpg") {
      const pdftoppmExists = await fileExists("pdftoppm");
      if (!pdftoppmExists) {
        return res.status(500).json({ error: "pdftoppm is not installed on the server." });
      }

      const imagesDir = path.join(workDir, "images");
      fs.mkdirSync(imagesDir, { recursive: true });

      const images = await pdfToImagesViaPdftoppm(req.file.path, imagesDir, format);
      if (!images.length) {
        return res.status(500).json({ error: "No pages were converted to images." });
      }

      const zipPath = path.join(workDir, `${base}-${format}.zip`);
      await zipFiles(
        images.map(p => ({ path: p, name: path.basename(p) })),
        zipPath
      );

      return sendDownload(res, zipPath, `${base}-${format}.zip`, workDir, [req.file]);
    }

    return res.status(400).json({
      error: "Unsupported format. Use docx, xlsx, pptx, txt, png, or jpg."
    });
  } catch (err) {
    cleanupFiles([req.file]);
    cleanupDir(workDir);
    res.status(500).json({ error: err.message || "Conversion failed." });
  }
});

/* OCR */
app.post("/api/ocr", upload.single("file"), async (req, res) => {
  const workDir = createWorkDir();
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required." });
    if (!isPdf(req.file)) return res.status(400).json({ error: "OCR accepts only PDF files." });

    const pdftoppmExists = await fileExists("pdftoppm");
    if (!pdftoppmExists) {
      return res.status(500).json({ error: "pdftoppm is not installed on the server." });
    }

    const maxPages = Math.max(1, Math.min(10, Number(req.body.maxPages || 3)));
    const imagesDir = path.join(workDir, "ocr-images");
    fs.mkdirSync(imagesDir, { recursive: true });

    const images = await pdfToImagesViaPdftoppm(req.file.path, imagesDir, "png");
    const selected = images.slice(0, maxPages);

    let text = "";
    for (let i = 0; i < selected.length; i++) {
      const result = await Tesseract.recognize(selected[i], "eng");
      text += `\n\n--- Page ${i + 1} ---\n`;
      text += (result.data.text || "").trim();
    }

    const outPath = path.join(workDir, "ocr-text.txt");
    await fsp.writeFile(outPath, text.trim() || "No OCR text found.", "utf8");

    sendDownload(res, outPath, "ocr-text.txt", workDir, [req.file]);
  } catch (err) {
    cleanupFiles([req.file]);
    cleanupDir(workDir);
    res.status(500).json({ error: err.message || "OCR failed." });
  }
});

app.use((err, _req, res, _next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: "File too large. Maximum allowed size is 10 MB per file."
    });
  }
  if (err && err.message) {
    return res.status(400).json({ error: err.message });
  }
  return res.status(500).json({ error: "Unexpected server error." });
});

app.listen(PORT, () => {
  console.log(`FileForge running on port ${PORT}`);
});
