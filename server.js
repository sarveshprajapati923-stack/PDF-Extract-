const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const cors = require("cors");
const compression = require("compression");
const helmet = require("helmet");
const multer = require("multer");
const JSZip = require("jszip");
const { PDFDocument, StandardFonts, rgb, degrees } = require("pdf-lib");
const pdfParse = require("pdf-parse");
const { Document, Packer, Paragraph, TextRun } = require("docx");
const { createCanvas } = require("canvas");
const { createWorker } = require("tesseract.js");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || "https://wepdfhub.click";

app.use(cors());
app.use(compression());
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"]
      }
    }
  })
);
app.use(express.static(path.join(__dirname, "public")));

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use((req, res, next) => {
  res.downloadBuffer = (buffer, filename) => {
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`
    });
    res.send(buffer);
  };
  next();
});

const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 20
  }
});

/* ================= HOME ROUTE FIX ================= */
// public/index.html serve hoga
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.post("/api/protect-pdf", upload.single("file"), async (req, res) => {
  let filePath = null;
  let outputPath = null;

  try {
    if (!req.file) return res.status(400).send("No file");

    const password = req.body.password;
    if (!password || password.length < 4) {
      return res.status(400).send("Weak password");
    }

    filePath = req.file.path;

    const pdfBytes = fs.readFileSync(filePath);
    const pdfDoc = await PDFDocument.load(pdfBytes);

    const protectedBytes = await pdfDoc.save({
      userPassword: password,
      ownerPassword: password
    });

    outputPath = path.join(uploadDir, "protected-" + Date.now() + ".pdf");
    fs.writeFileSync(outputPath, protectedBytes);

    res.download(outputPath, "protected.pdf", () => {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    });

  } catch (err) {
    res.status(500).send("Error");
  }
});

const { exec } = require("child_process");

app.post("/api/unlock-pdf", upload.single("file"), async (req, res) => {
  let input = null;
  let output = null;

  try {
    if (!req.file) return res.status(400).send("No file");

    const password = req.body.password || "";
    input = req.file.path;
    output = path.join(uploadDir, "unlocked-" + Date.now() + ".pdf");

    const cmd = `qpdf --password="${password}" --decrypt "${input}" "${output}"`;

    exec(cmd, (err) => {
      if (err) {
        return res.status(400).send("Wrong password or unlock failed");
      }

      res.download(output, "unlocked.pdf", () => {
        if (fs.existsSync(input)) fs.unlinkSync(input);
        if (fs.existsSync(output)) fs.unlinkSync(output);
      });
    });

  } catch (err) {
    res.status(500).send("Error");
  }
});

app.post("/api/pdf-to-excel", upload.single("file"), async (req, res) => {
  const file = req.file;
  let worker;

  try {
    if (!file) return res.status(400).json({ error: "Upload PDF file" });

    const XLSX = require("xlsx");
    const bytes = await fsp.readFile(file.path);

    // ===== 1. TEXT EXTRACT =====
    let parsed = await pdfParse(bytes);
    let text = parsed.text.trim();

    // ===== 2. OCR FALLBACK =====
    if (!text || text.length < 50) {
      const images = await renderPdfToImages(bytes, 2);

      worker = await createWorker();
      await worker.loadLanguage("eng");
      await worker.initialize("eng");

      let ocrText = "";
      for (const img of images) {
        const { data } = await worker.recognize(img.buffer);
        ocrText += "\n" + data.text;
      }

      await worker.terminate();
      worker = null;

      text = ocrText;
    }

    // ===== 3. LINE CLEAN =====
    let lines = text
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 1);

    // ===== 4. HEADER DETECT =====
    let header = null;
    let rows = [];
    let maxCols = 0;

    lines.forEach((line, i) => {
      let cols = line.split(/\s{2,}|\t|\|/).filter(Boolean);

      // fallback
      if (cols.length <= 1) {
        cols = line.split(/\s+/);
      }

      // detect header (first row with many columns)
      if (!header && cols.length >= 3) {
        header = cols;
      }

      maxCols = Math.max(maxCols, cols.length);
      rows.push(cols);
    });

    // ===== 5. NORMALIZE =====
    rows = rows.map(r => {
      while (r.length < maxCols) r.push("");
      return r;
    });

    // ===== 6. ADD HEADER IF FOUND =====
    if (header) {
      while (header.length < maxCols) header.push("");
      rows.unshift(header);
    }

    // ===== 7. CREATE EXCEL =====
    const ws = XLSX.utils.aoa_to_sheet(rows);

    // column width auto
    ws["!cols"] = Array(maxCols).fill({ wch: 22 });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");

    const buffer = XLSX.write(wb, {
      type: "buffer",
      bookType: "xlsx"
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=ultra-pdf-to-excel.xlsx");
    res.setHeader("X-Filename", "ultra-pdf-to-excel.xlsx");

    res.send(buffer);

  } catch (err) {
    if (worker) {
      try { await worker.terminate(); } catch {}
    }
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});

app.post("/api/split-pdf-bookmarks", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Upload PDF file." });

    const action = String(req.body.action || "preview"); // preview | split
    const selected = new Set(
      String(req.body.selected || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
    );

    const bytes = await fsp.readFile(req.file.path);

    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdfjsDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
    const pdfDoc = await PDFDocument.load(bytes);

    async function resolvePageIndex(dest) {
      try {
        if (!dest) return null;
        const resolved = typeof dest === "string" ? await pdfjsDoc.getDestination(dest) : dest;
        if (!resolved || !resolved.length) return null;

        const target = resolved[0];
        if (target && typeof target === "object" && ("num" in target || "ref" in target)) {
          return await pdfjsDoc.getPageIndex(target);
        }
        return typeof target === "number" ? target : null;
      } catch {
        return null;
      }
    }

    async function flattenOutline(items, level = 0, out = []) {
      for (const item of items || []) {
        const pageIndex = await resolvePageIndex(item.dest);
        out.push({
          title: item.title || "Untitled",
          level,
          pageIndex
        });
        if (item.items?.length) {
          await flattenOutline(item.items, level + 1, out);
        }
      }
      return out;
    }

    const outline = await pdfjsDoc.getOutline();
    const sections = (await flattenOutline(outline || []))
      .filter(s => Number.isInteger(s.pageIndex))
      .sort((a, b) => a.pageIndex - b.pageIndex);

    if (!sections.length) {
      return res.status(400).json({ error: "No bookmarks found in this PDF." });
    }

    if (action === "preview") {
      return res.json({ sections });
    }

    const picked = selected.size
      ? sections.filter((_, i) => selected.has(String(i)))
      : sections;

    if (!picked.length) {
      return res.status(400).json({ error: "Select at least one bookmark." });
    }

    const sorted = [...picked].sort((a, b) => a.pageIndex - b.pageIndex);
    const zip = new JSZip();

    for (let i = 0; i < sorted.length; i++) {
      const start = sorted[i].pageIndex;
      const end = i < sorted.length - 1
        ? Math.max(start, sorted[i + 1].pageIndex - 1)
        : pdfDoc.getPageCount() - 1;

      const outDoc = await PDFDocument.create();
      const pageIndexes = [];
      for (let p = start; p <= end; p++) pageIndexes.push(p);

      const copied = await outDoc.copyPages(pdfDoc, pageIndexes);
      copied.forEach(page => outDoc.addPage(page));

      const buf = await outDoc.save();
      const safeName = sorted[i].title.replace(/[^a-z0-9]+/gi, "_").toLowerCase() || `section_${i + 1}`;
      zip.file(`${safeName}.pdf`, buf);
    }

    const zipBuf = await zip.generateAsync({ type: "nodebuffer" });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="bookmark_split.zip"');
    res.setHeader("X-Filename", "bookmark_split.zip");
    res.send(zipBuf);

  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});
app.post("/api/split-pdf-odd-pages", upload.single("file"), async (req, res) => {
  const file = req.file;

  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });

    const pdf = await readPdf(file);
    const total = pdf.getPageCount();

    const oddPages = [];
    for (let i = 0; i < total; i++) {
      if ((i + 1) % 2 === 1) oddPages.push(i);
    }

    if (!oddPages.length) {
      return res.status(400).json({ error: "No odd pages found." });
    }

    const outDoc = await PDFDocument.create();
    const copied = await outDoc.copyPages(pdf, oddPages);
    copied.forEach(page => outDoc.addPage(page));

    const out = await outDoc.save();
    sendPdf(res, out, "odd_pages.pdf");
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});
app.post("/api/split-pdf-even-pages", upload.single("file"), async (req, res) => {
  const file = req.file;

  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });

    const pdf = await readPdf(file);
    const total = pdf.getPageCount();

    const evenPages = [];
    for (let i = 0; i < total; i++) {
      if ((i + 1) % 2 === 0) evenPages.push(i);
    }

    if (!evenPages.length) {
      return res.status(400).json({ error: "No even pages found." });
    }

    const outDoc = await PDFDocument.create();
    const copied = await outDoc.copyPages(pdf, evenPages);
    copied.forEach(page => outDoc.addPage(page));

    const out = await outDoc.save();
    sendPdf(res, out, "even_pages.pdf");

  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});
// Extract First Page
app.post("/extract-first-page", upload.single("file"), async (req,res)=>{
  const pdf = await PDFDocument.load(req.file.buffer);
  const newPdf = await PDFDocument.create();
  const [page] = await newPdf.copyPages(pdf,[0]);
  newPdf.addPage(page);
  const bytes = await newPdf.save();
  res.downloadBuffer(bytes,"first_page.pdf");
});

// Extract Last Page
app.post("/extract-last-page", upload.single("file"), async (req,res)=>{
  const pdf = await PDFDocument.load(req.file.buffer);
  const total = pdf.getPageCount();
  const newPdf = await PDFDocument.create();
  const [page] = await newPdf.copyPages(pdf,[total-1]);
  newPdf.addPage(page);
  const bytes = await newPdf.save();
  res.downloadBuffer(bytes,"last_page.pdf");
});

// Delete Odd Pages
app.post("/delete-odd-pages", upload.single("file"), async (req,res)=>{
  const pdf = await PDFDocument.load(req.file.buffer);
  const newPdf = await PDFDocument.create();
  const pages = pdf.getPages();
  for(let i=0;i<pages.length;i++){
    if((i+1)%2===0){
      const [p] = await newPdf.copyPages(pdf,[i]);
      newPdf.addPage(p);
    }
  }
  const bytes = await newPdf.save();
  res.downloadBuffer(bytes,"no_odd_pages.pdf");
});

// Delete Even Pages
app.post("/delete-even-pages", upload.single("file"), async (req,res)=>{
  const pdf = await PDFDocument.load(req.file.buffer);
  const newPdf = await PDFDocument.create();
  const pages = pdf.getPages();
  for(let i=0;i<pages.length;i++){
    if((i+1)%2!==0){
      const [p] = await newPdf.copyPages(pdf,[i]);
      newPdf.addPage(p);
    }
  }
  const bytes = await newPdf.save();
  res.downloadBuffer(bytes,"no_even_pages.pdf");
});

// Shuffle Pages
app.post("/shuffle-pages", upload.single("file"), async (req,res)=>{
  const pdf = await PDFDocument.load(req.file.buffer);
  const newPdf = await PDFDocument.create();
  let indexes = pdf.getPages().map((_,i)=>i);

  indexes.sort(()=>Math.random()-0.5);

  for(let i of indexes){
    const [p] = await newPdf.copyPages(pdf,[i]);
    newPdf.addPage(p);
  }

  const bytes = await newPdf.save();
  res.downloadBuffer(bytes,"shuffled.pdf");
});

// Sort Pages Ascending (default reset)
app.post("/sort-pages", upload.single("file"), async (req,res)=>{
  const pdf = await PDFDocument.load(req.file.buffer);
  const newPdf = await PDFDocument.create();

  for(let i=0;i<pdf.getPageCount();i++){
    const [p] = await newPdf.copyPages(pdf,[i]);
    newPdf.addPage(p);
  }

  const bytes = await newPdf.save();
  res.downloadBuffer(bytes,"sorted.pdf");
});
// ================= BACKEND: Sort Pages Descending =================
app.post("/api/sort-pages-desc", upload.single("file"), async (req, res) => {
  try {
    const pdf = await readPdf(req.file);
    const total = pdf.getPageCount();

    const order = [...Array(total).keys()].reverse();

    const outDoc = await PDFDocument.create();
    const pages = await outDoc.copyPages(pdf, order);
    pages.forEach(p => outDoc.addPage(p));

    const out = await outDoc.save();
    sendPdf(res, out, "sorted-desc.pdf");
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});
app.get("/sitemap.xml", (req, res) => {
  res.setHeader("Content-Type", "application/xml");

  const base = "https://wepdfhub.click";

  const urls = [
    "/",
    "/merge-pdf",
    "/split-pdf",
    "/compress-pdf",
    "/about",
    "/contact",
    "/privacy-policy",
    "/terms",
    "/rules"
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `
<url>
  <loc>${base + u}</loc>
</url>`).join("")}
</urlset>`;

  res.send(xml);
});
app.get("/tool/:name", (req, res) => {
  const name = req.params.name;

  res.send(`
  <html>
  <head>
    <title>${name} - Free PDF Tool</title>
    <meta name="description" content="Use ${name} online free PDF tool">
  </head>

  <body>
    <h1>${name} Tool</h1>
    <p>Best free tool for ${name}</p>
  </body>
  </html>
  `);
});

// ================= BACKEND: Add Cover Page =================
app.post("/api/add-cover-page", upload.single("file"), async (req, res) => {
  try {
    const text = req.body.text || "COVER PAGE";

    const pdf = await readPdf(req);
    const newPdf = await PDFDocument.create();

    const font = await newPdf.embedFont(StandardFonts.HelveticaBold);

    const cover = newPdf.addPage([600, 800]);
    cover.drawText(text, {
      x: 200,
      y: 400,
      size: 28,
      font,
      color: rgb(0, 0, 0)
    });

    const copied = await newPdf.copyPages(pdf, pdf.getPageIndices());
    copied.forEach(p => newPdf.addPage(p));

    const out = await newPdf.save();
    sendPdf(res, out, "cover-added.pdf");
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});
// ================= BACKEND: Separator Page =================
app.post("/api/add-separator-pages", upload.single("file"), async (req, res) => {
  try {
    const pdf = await readPdf(req);
    const newPdf = await PDFDocument.create();

    const pages = pdf.getPages();

    for (let i = 0; i < pages.length; i++) {
      const [copied] = await newPdf.copyPages(pdf, [i]);
      newPdf.addPage(copied);

      if (i !== pages.length - 1) {
        newPdf.addPage([600, 800]); // blank separator page
      }
    }

    const out = await newPdf.save();
    sendPdf(res, out, "separator.pdf");
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});
// ================= BACKEND: Add Header =================
app.post("/api/add-header", upload.single("file"), async (req, res) => {
  try {
    const text = req.body.text || "HEADER";

    const pdf = await readPdf(req);
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);

    pdf.getPages().forEach(page => {
      const { width, height } = page.getSize();
      page.drawText(text, {
        x: 40,
        y: height - 30,
        size: 12,
        font,
        color: rgb(0, 0, 0)
      });
    });

    const out = await pdf.save();
    sendPdf(res, out, "header.pdf");
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});
// ================= BACKEND: Add Footer =================
app.post("/api/add-footer", upload.single("file"), async (req, res) => {
  try {
    const text = req.body.text || "FOOTER";

    const pdf = await readPdf(req);
    const font = await pdf.embedFont(StandardFonts.Helvetica);

    pdf.getPages().forEach(page => {
      const { width } = page.getSize();
      page.drawText(text, {
        x: 40,
        y: 20,
        size: 10,
        font,
        color: rgb(0.3, 0.3, 0.3)
      });
    });

    const out = await pdf.save();
    sendPdf(res, out, "footer.pdf");
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});
// ================= BACKEND: Logo Stamp =================
const uploadImg = multer({ dest: uploadDir });

app.post("/api/logo-stamp", upload.fields([
  { name: "file", maxCount: 1 },
  { name: "logo", maxCount: 1 }
]), async (req, res) => {
  try {
    const pdf = await readPdf(req.files.file[0]);
    const logoBytes = await fsp.readFile(req.files.logo[0].path);

    const logo = await pdf.embedPng(logoBytes);

    pdf.getPages().forEach(page => {
      const { width } = page.getSize();
      page.drawImage(logo, {
        x: width - 100,
        y: 30,
        width: 60,
        height: 60,
        opacity: 0.6
      });
    });

    const out = await pdf.save();
    sendPdf(res, out, "logo-stamped.pdf");
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await cleanupFiles(req.files?.file || []);
    await cleanupFiles(req.files?.logo || []);
  }
});
// ================= BACKEND: Signature Image =================
app.post("/api/add-signature", upload.fields([
  { name: "file", maxCount: 1 },
  { name: "signature", maxCount: 1 }
]), async (req, res) => {
  try {
    const pdf = await readPdf(req.files.file[0]);
    const sigBytes = await fsp.readFile(req.files.signature[0].path);

    const sig = await pdf.embedPng(sigBytes);

    pdf.getPages().forEach(page => {
      page.drawImage(sig, {
        x: 50,
        y: 50,
        width: 120,
        height: 60
      });
    });

    const out = await pdf.save();
    sendPdf(res, out, "signed.pdf");
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await cleanupFiles(req.files?.file || []);
    await cleanupFiles(req.files?.signature || []);
  }
});
// ================= STATIC PAGES ROUTES =================

app.get("/about", (req, res) => {
  res.sendFile(__dirname + "/about.html");
});

app.get("/contact", (req, res) => {
  res.sendFile(__dirname + "/contact.html");
});

app.get("/privacy-policy", (req, res) => {
  res.sendFile(__dirname + "/privacy-policy.html");
});

app.get("/terms", (req, res) => {
  res.sendFile(__dirname + "/terms.html");
});

app.get("/rules", (req, res) => {
  res.sendFile(__dirname + "/rules.html");
});
app.get("/robots.txt", (req, res) => {
  res.type("text/plain");
  res.send(`
User-agent: *
Allow: /
Disallow:

Sitemap: https://wepdfhub.click/sitemap.xml
  `);
});

/* ================= TOOLS PAGE ROUTES (same as before) ================= */
const tools = [
  { slug: "merge-pdf", title: "Merge PDF", description: "Combine multiple PDF files into one.", files: "multi" },
  { slug: "split-pdf", title: "Split PDF", description: "Split selected pages into separate PDF files.", files: "single" },
  { slug: "compress-pdf", title: "Compress PDF", description: "Reduce PDF file size.", files: "single" },
  { slug: "rotate-pdf", title: "Rotate PDF", description: "Rotate all pages left or right.", files: "single" },
  { slug: "watermark-pdf", title: "Watermark PDF", description: "Add a text watermark to every page.", files: "single" },
  { slug: "extract-text", title: "Extract Text", description: "Extract text from a PDF file.", files: "single" },
  { slug: "delete-pages", title: "Delete Pages", description: "Remove selected pages from a PDF.", files: "single" },
  { slug: "extract-pages", title: "Extract Pages", description: "Keep only selected pages from a PDF.", files: "single" },
  { slug: "image-to-pdf", title: "Image to PDF", description: "Convert JPG or PNG images into PDF.", files: "multi" },
  { slug: "page-number", title: "Page Number", description: "Add page numbers to each page.", files: "single" },
  { slug: "reorder-pages", title: "Reorder Pages", description: "Change the page order of a PDF.", files: "single" },
  { slug: "reverse-pages", title: "Reverse Pages", description: "Reverse the order of all pages.", files: "single" },
  { slug: "duplicate-pages", title: "Duplicate Pages", description: "Duplicate selected pages inside the PDF.", files: "single" },
  { slug: "add-blank-pages", title: "Add Blank Pages", description: "Append blank pages to the end of the PDF.", files: "single" },
  { slug: "crop-pdf", title: "Crop PDF", description: "Crop page area from a PDF.", files: "single" },
  { slug: "metadata-pdf", title: "PDF Metadata", description: "Edit title, author, subject, and keywords.", files: "single" },
  { slug: "pdf-info", title: "PDF Info", description: "View PDF page count and basic metadata.", files: "single" },
  { slug: "pdf-to-word", title: "PDF to Word", description: "Convert PDF to DOCX.", files: "single" },
  { slug: "pdf-to-jpg", title: "PDF to JPG", description: "Convert PDF pages to JPG images.", files: "single" },
  { slug: "ocr-pdf", title: "OCR PDF", description: "Extract text from scanned PDFs.", files: "single" },
  { slug: "protect-pdf", title: "Protect PDF", description: "Add password to secure PDF.", files: "single" },
  { slug: "unlock-pdf", title: "Unlock PDF", description: "Remove password protection from a PDF.", files: "single" },
  { slug: "pdf-to-excel", title: "PDF to Excel", description: "Convert PDF tables to Excel.", files: "single" },
  { slug: "split-pdf-bookmarks", title: "Split PDF by Bookmarks", description: "Split one PDF into separate PDFs using bookmarks.", files: "single" },
  { slug: "split-pdf-odd-pages", title: "Split PDF by Odd Pages", description: "Keep only odd pages from a PDF.", files: "single" },
  {slug:"split-pdf-even-pages", title:"Split PDF by Even Pages", description:"Keep only even pages from a PDF."},
  { slug: "extract-first-page", title: "Extract First Page", description: "Extract only the first page from a PDF.", files: "single" },
  { slug: "extract-last-page", title: "Extract Last Page", description: "Extract only the last page from a PDF.", files: "single" },
  { slug: "delete-odd-pages", title: "Delete Odd Pages", description: "Remove all odd pages from a PDF.", files: "single" },
  { slug: "delete-even-pages", title: "Delete Even Pages", description: "Remove all even pages from a PDF.", files: "single" },
  { slug: "shuffle-pages", title: "Shuffle Pages", description: "Randomly shuffle all pages in a PDF.", files: "single" },
  { slug: "sort-pages", title: "Sort Pages Ascending", description: "Arrange pages in ascending order.", files: "single" },
  { slug: "sort-pages-desc", title: "Sort Pages Descending", files: "single" },
  { slug: "add-cover-page", title: "Add Cover Page", files: "single" },
  { slug: "add-separator-pages", title: "Separator Pages", files: "single" },
  { slug: "add-header", title: "Add Header", files: "single" },
  { slug: "add-footer", title: "Add Footer", files: "single" },
  { slug: "logo-stamp", title: "Logo Stamp", files: "multi" },
  { slug: "add-signature", title: "Add Signature", files: "multi" }
];

const toolMap = new Map(tools.map(t => [t.slug, t]));

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fullUrl(slug = "") {
  return slug ? `${BASE_URL}/${slug}` : BASE_URL;
}

function cleanupFiles(files = []) {
  return Promise.all(
    files
      .filter(Boolean)
      .map(async file => {
        try {
          await fsp.unlink(file.path);
        } catch {}
      })
  );
}

function parsePageSpec(spec, totalPages) {
  if (!spec || !String(spec).trim()) return [];
  const pages = new Set();

  String(spec)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(token => {
      if (token.includes("-")) {
        const [aRaw, bRaw] = token.split("-");
        const a = parseInt(aRaw.trim(), 10);
        const b = parseInt(bRaw.trim(), 10);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return;
        const start = Math.max(1, Math.min(a, b));
        const end = Math.min(totalPages, Math.max(a, b));
        for (let i = start; i <= end; i++) pages.add(i - 1);
      } else {
        const n = parseInt(token, 10);
        if (Number.isFinite(n) && n >= 1 && n <= totalPages) pages.add(n - 1);
      }
    });

  return [...pages].sort((x, y) => x - y);
}

function parsePageOrder(spec, totalPages) {
  const list = parsePageSpec(spec, totalPages);
  return list.length ? list : [...Array(totalPages).keys()];
}

function pageBg() {
  return `
  :root{
    --bg:#f7f9ff; --bg2:#eef4ff; --panel:#fff; --line:#d8e2f0; --text:#0f172a; --muted:#64748b;
    --primary:#2563eb; --primary2:#0ea5e9; --success:#16a34a; --danger:#dc2626;
    --shadow:0 18px 50px rgba(15,23,42,.08); --radius:24px;
  }
  *{box-sizing:border-box}
  html,body{margin:0;min-height:100%;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:linear-gradient(180deg,var(--bg),var(--bg2));color:var(--text)}
  a{text-decoration:none;color:inherit}
  .wrap{max-width:1180px;margin:0 auto;padding:18px}
  .top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}
  .brand{font-weight:800;font-size:1.2rem}
  .back,.btn,.chip,.download{
    border:1px solid var(--line);background:#fff;color:var(--text);padding:12px 14px;border-radius:14px;
    cursor:pointer;transition:.18s ease;display:inline-flex;align-items:center;justify-content:center
  }
  .back:hover,.btn:hover,.chip:hover,.download:hover{transform:translateY(-1px);border-color:rgba(37,99,235,.35)}
  .solid{background:linear-gradient(135deg,var(--primary),var(--primary2));color:#fff;border-color:transparent;font-weight:700}
  .hero,.card{border-radius:var(--radius);border:1px solid var(--line);background:var(--panel);box-shadow:var(--shadow)}
  .hero{padding:24px}
  h1{margin:0 0 10px;font-size:clamp(1.8rem,4vw,3rem);line-height:1.02;letter-spacing:-.04em}
  p{margin:0;color:var(--muted);line-height:1.7}
  .grid{display:grid;grid-template-columns:1.2fr .8fr;gap:16px;margin-top:16px}
  .panel{padding:18px}
  .upload{border:1.5px dashed rgba(37,99,235,.22);border-radius:22px;padding:18px;background:linear-gradient(180deg,#fff,#f8fbff)}
  .field{margin-top:12px}
  label{display:block;margin:0 0 8px;font-size:.92rem;color:var(--muted)}
  input[type=file],input[type=text]{
    width:100%;padding:12px 14px;border-radius:14px;border:1px solid var(--line);background:#fff;outline:none
  }
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
  .status{margin-top:12px;font-size:.95rem}
  .result{
    margin-top:12px;min-height:160px;border-radius:18px;border:1px solid var(--line);background:#fff;padding:14px;
    white-space:pre-wrap;overflow:auto
  }
  .download-box{display:none;margin-top:14px;padding:16px;border-radius:18px;border:1px solid rgba(22,163,74,.18);background:rgba(22,163,74,.06)}
  .download-box.show{display:block}
  .download{background:linear-gradient(135deg,var(--success),#22c55e);color:#fff;border-color:transparent;font-weight:800}
  .chip-wrap{display:flex;gap:10px;flex-wrap:wrap}
  .chip{padding:10px 12px}
  .mini{font-size:.92rem;color:var(--muted)}
  .note{margin-top:10px;padding:12px 14px;border-radius:16px;border:1px solid rgba(37,99,235,.18);background:rgba(37,99,235,.06);color:#1d4ed8}
  .warn{border-color:rgba(245,158,11,.25);background:rgba(245,158,11,.08);color:#92400e}
  .error{color:var(--danger);font-weight:700}
  .progress{
    width:100%;height:12px;background:#e8eef8;border-radius:999px;overflow:hidden;margin-top:14px;border:1px solid #d6e2f2
  }
  .progress > div{
    width:0%;height:100%;
    background:linear-gradient(90deg,var(--primary),var(--primary2));
    transition:width .15s ease
  }
  .dropzone.drag{
    border-color:rgba(22,163,74,.45)!important;
    background:rgba(22,163,74,.06)!important;
  }
  @media (max-width:900px){.grid,.row{grid-template-columns:1fr}}
  `;
}

function buildStaticPage(title, heading, content, req) {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)} | WePDFHub</title>

<meta name="description" content="Use ${escapeHtml(title)} tool online free. Fast, secure and no login required.">

<link rel="canonical" href="${BASE_URL + req.path}" />

<meta name="robots" content="index, follow">

<meta property="og:title" content="${escapeHtml(title)} - WePDFHub">
<meta property="og:description" content="Free online ${escapeHtml(title)} tool. No login required.">
<meta property="og:type" content="website">
    <link rel="canonical" href="${BASE_URL}" />
    <style>${pageBg()}</style>
  </head>
  <body>
    <div class="wrap">
      <div class="top">
        <div class="brand">WePDFHub</div>
        <a class="back" href="/">← Home</a>
      </div>
      <section class="hero">
        <h1>${escapeHtml(heading)}</h1>
        ${content}
      </section>
      <div style="margin-top:16px" class="mini">
        <a href="/about.html">About</a> · 
<a href="/contact.html">Contact</a> · 
<a href="/privacy-policy.html">Privacy</a> · 
<a href="/terms.html">Terms</a> · 
<a href="/rules.html">Rules</a>
      </div>
    </div>
  </body>
  </html>`;
}
app.get("/about", (req, res) => {
  res.send(buildStaticPage(
    "About Us",
    "About WePDFHub",
    `<p>WePDFHub is a fast PDF tools website built for simple, secure, mobile-friendly document tasks.</p>
     <p>Each tool has its own dedicated URL, making the site easier to browse and better for SEO.</p>`,
    req
  ));
});

app.get("/contact", (req, res) => {
  res.send(buildStaticPage(
    "Contact",
    "Contact WePDFHub",
    `<p>Email: <a href="mailto:support@wepdfhub.click">support@wepdfhub.click</a></p>
     <p>Use this email for tool issues, partnership queries, and website support.</p>`,
    req
  ));
});

app.get("/privacy", (req, res) => {
  res.send(buildStaticPage(
    "Privacy Policy",
    "Privacy Policy",
    `<p>WePDFHub processes uploaded files only for the selected action.</p>
     <ul>
       <li>Temporary files are deleted after processing.</li>
       <li>Files are not stored long-term.</li>
       <li>No user data is sold or shared.</li>
     </ul>`,
    req
  ));
});

app.get("/terms", (req, res) => {
  res.send(buildStaticPage(
    "Terms of Service",
    "Terms of Service",
    `<p>By using WePDFHub, you agree to use the service responsibly.</p>
     <ul>
       <li>No illegal or harmful content allowed.</li>
       <li>No spam or abuse of system resources.</li>
       <li>Limits may apply for stability.</li>
     </ul>`,
    req
  ));
});

app.get("/rules", (req, res) => {
  res.send(buildStaticPage(
    "Rules",
    "WePDFHub Rules",
    `<p>Follow these rules to keep platform safe and fast.</p>
     <ul>
       <li>Use supported file types only.</li>
       <li>Do not upload harmful content.</li>
       <li>Respect copyright laws.</li>
     </ul>`,
    req
  ));
});

function renderToolPage(tool) {
  const related = tools
    .filter(t => t.slug !== tool.slug)
    .slice(0, 10)
    .map(t => `<a class="chip" href="/${t.slug}">${escapeHtml(t.title)}</a>`)
    .join("");

  const fieldPages =
    ["split-pdf", "delete-pages", "extract-pages", "duplicate-pages", "reorder-pages"].includes(tool.slug)
      ? `<div class="field"><label>Pages</label><input id="pages" type="text" placeholder="1,3-5" /></div>`
      : "";

  const fieldDegrees = tool.slug === "rotate-pdf" ? `<div class="field"><label>Degrees</label><input id="degrees" type="text" value="90" /></div>` : "";
  const fieldText = tool.slug === "watermark-pdf" ? `<div class="field"><label>Watermark text</label><input id="text" type="text" value="CONFIDENTIAL" /></div>` : "";
  const fieldCount = tool.slug === "add-blank-pages" ? `<div class="field"><label>Blank pages count</label><input id="count" type="text" value="1" /></div>` : "";
  const fieldCrop = tool.slug === "crop-pdf"
    ? `
    <div class="row">
      <div class="field"><label>X</label><input id="cropX" type="text" value="0" /></div>
      <div class="field"><label>Y</label><input id="cropY" type="text" value="0" /></div>
    </div>
    <div class="row">
      <div class="field"><label>Width</label><input id="cropW" type="text" value="400" /></div>
      <div class="field"><label>Height</label><input id="cropH" type="text" value="600" /></div>
    </div>`
    : "";

  const fieldMeta = tool.slug === "metadata-pdf"
    ? `
    <div class="field"><label>Title</label><input id="titleMeta" type="text" value="WePDF Document" /></div>
    <div class="field"><label>Author</label><input id="authorMeta" type="text" value="WePDF" /></div>
    <div class="field"><label>Subject</label><input id="subjectMeta" type="text" value="PDF Tools" /></div>
    <div class="field"><label>Keywords</label><input id="keywordsMeta" type="text" value="pdf, tools, wepdf" /></div>`
    : "";

  const startPageField = tool.slug === "page-number"
    ? `<div class="field"><label>Start page</label><input id="startPage" type="text" value="1" /></div>`
    : "";
  const bookmarkSplitUI = tool.slug === "split-pdf-bookmarks"
  ? `
  <div class="note">This splits one PDF into separate files based on bookmarks. First load bookmarks, then select the ones you want.</div>

  <div class="field">
    <label>Split mode</label>
    <select id="splitMode" style="width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:14px;background:#fff;">
      <option value="preview">Preview bookmarks</option>
      <option value="split">Split selected bookmarks</option>
    </select>
  </div>

  <div class="actions">
    <button class="btn" id="loadBookmarksBtn" type="button">Load Bookmarks</button>
  </div>

  <div id="bookmarkPanel" class="bookmark-panel"></div>
  `
  : "";
const note =
  tool.slug === "pdf-to-word"
    ? `<div class="note">This converts extracted PDF text to DOCX. Best for text-based PDFs.</div>`
    : tool.slug === "pdf-to-jpg"
    ? `<div class="note">This exports each page as an image and downloads a ZIP.</div>`
    : tool.slug === "ocr-pdf"
    ? `<div class="note">This runs OCR on page images and returns extracted text.</div>`
    : tool.slug === "split-pdf-bookmarks"
    ? `<div class="note">This splits one PDF into separate files based on bookmarks.</div>`
    : "";

  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="google-site-verification" content="SM3evf3tuRLP23syjV822eZnRKIDL09kfOwthVj3Res" />
    <!-- Robots SEO -->
  <meta name="robots" content="index, follow">
    <title>${escapeHtml(tool.title)} | WePDFHub</title>
    <meta name="description" content="${escapeHtml(tool.description)}" />
    <link rel="canonical" href="${fullUrl(tool.slug)}" />
    <meta property="og:title" content="${escapeHtml(tool.title)} | WePDFHub" />
    <meta property="og:description" content="${escapeHtml(tool.description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${fullUrl(tool.slug)}" />
    <style>${pageBg()}</style>
  </head>
  <body>
    <div class="wrap">
      <div class="top">
        <div class="brand">WePDFHub</div>
        <a class="back" href="/">← Home</a>
      </div>

      <section class="hero">
        <span class="badge" style="display:inline-flex;gap:8px;align-items:center;padding:8px 12px;border-radius:999px;border:1px solid rgba(37,99,235,.18);background:rgba(37,99,235,.06);color:#1d4ed8;font-size:.9rem">Dedicated tool page</span>
        <h1>${escapeHtml(tool.title)}</h1>
        <p>${escapeHtml(tool.description)}</p>
        <p class="mini" style="margin-top:10px">Dedicated URL: /${escapeHtml(tool.slug)}</p>
        ${note}
      </section>

      <section class="grid">
        <div class="card panel">
          <h2 style="margin-top:0">Upload & process</h2>
          <div class="upload dropzone" id="dropzone">
  <div style="text-align:center;padding:30px">
    <div style="font-size:50px">📂</div>
    <div style="font-weight:700;margin-top:10px">
      Drag & Drop Files Here
    </div>
    <div class="mini">or click to upload</div>
  </div>
            <div class="field">
              <label>Files</label>
              <input id="fileInput" type="file" multiple accept="application/pdf,image/png,image/jpeg" />
              <div id="previewLabel" style="display:none;font-size:12px;margin-top:8px;color:#64748b">
  Preview:
</div>
              <canvas id="previewCanvas" style="width:100%;margin-top:10px;border-radius:12px;border:1px solid #ddd;display:none;"></canvas>
            </div>

            ${fieldPages}
            ${fieldDegrees}
            ${fieldText}
            ${fieldCount}
            ${fieldCrop}
            ${fieldMeta}
            ${startPageField}
            ${bookmarkSplitUI}

            <div id="progressWrap" class="progress" aria-hidden="true"><div id="progressBar"></div></div>

            <div class="actions">
              <button class="btn solid" id="runBtn" type="button">Run ${escapeHtml(tool.title)}</button>
              <button class="btn" id="resetBtn" type="button">Reset</button>
            </div>

            <div class="mini" style="margin-top:10px">Drag and drop works on this box too.</div>
          </div>

          <div id="downloadBox" class="download-box">
  <div style="font-size:40px">✅</div>

  <div style="font-weight:800;margin:10px 0">
    File Ready
  </div>

  <button id="downloadBtn" class="download" type="button">
    ⬇ Download
  </button>

  <button onclick="location.reload()" 
    class="btn" 
    style="margin-top:10px">
    Reset
  </button>
</div>

          <div id="status" class="status mini">Waiting for action...</div>
          <div id="result" class="result">No output yet.</div>
        </div>

        <div class="card panel">
          <h2 style="margin-top:0">Related tools</h2>
          <div class="chip-wrap">${related}</div>
          <div style="margin-top:18px">
            <h3>SEO structure</h3>
            <p class="mini">Each tool has its own URL, title, and description, just like competitor PDF sites.</p>
          </div>
        </div>
      </section>

      <div style="margin-top:16px" class="mini">
        <a href="/about">About</a> · <a href="/contact">Contact</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/rules">Rules</a>
      </div>
    </div>

    <script>
      const toolSlug = ${JSON.stringify(tool.slug)};
      const fileInput = document.getElementById("fileInput");
      const runBtn = document.getElementById("runBtn");
      const resetBtn = document.getElementById("resetBtn");
      const statusEl = document.getElementById("status");
      const resultEl = document.getElementById("result");
      const downloadBox = document.getElementById("downloadBox");
      const downloadBtn = document.getElementById("downloadBtn");
      const progressBar = document.getElementById("progressBar");
      const progressWrap = document.getElementById("progressWrap");
      const uploadArea = document.querySelector(".upload");
      let downloadUrl = "";
      let downloadName =
  toolSlug === "split-pdf-odd-pages" ? "odd_pages.pdf" :
  toolSlug === "split-pdf-even-pages" ? "even_pages.pdf" :
  toolSlug === "extract-first-page" ? "first_page.pdf" :
  toolSlug === "extract-last-page" ? "last_page.pdf" :
  toolSlug === "delete-odd-pages" ? "no_odd_pages.pdf" :
  toolSlug === "delete-even-pages" ? "no_even_pages.pdf" :
  toolSlug === "shuffle-pages" ? "shuffled.pdf" :
  toolSlug === "sort-pages" ? "sorted.pdf" :
  "output.pdf";

      function setStatus(title, text, isError = false) {
        statusEl.innerHTML = isError
          ? '<span class="error">' + title + '</span> — ' + text
          : title + ' — ' + text;
      }

      function resetDownload() {
        downloadBox.classList.remove("show");
        if (downloadUrl) URL.revokeObjectURL(downloadUrl);
        downloadUrl = "";
        downloadName = "output.pdf";
      }

      function setProgress(p) {
        progressBar.style.width = Math.max(0, Math.min(100, p)) + "%";
      }

      function inferName() {
        const map = {
          "merge-pdf": "merged.pdf",
          "split-pdf": "split_pages.zip",
          "compress-pdf": "compressed.pdf",
          "rotate-pdf": "rotated.pdf",
          "watermark-pdf": "watermarked.pdf",
          "extract-text": "extracted.txt",
          "delete-pages": "pages_deleted.pdf",
          "extract-pages": "extracted_pages.pdf",
          "image-to-pdf": "images_to_pdf.pdf",
          "page-number": "numbered.pdf",
          "reorder-pages": "reordered.pdf",
          "reverse-pages": "reversed.pdf",
          "duplicate-pages": "duplicated.pdf",
          "add-blank-pages": "blank_pages_added.pdf",
          "crop-pdf": "cropped.pdf",
          "metadata-pdf": "metadata_updated.pdf",
          "pdf-info": "info.json",
          "pdf-to-word": "converted.docx",
          "pdf-to-jpg": "pages.zip",
          "ocr-pdf": "ocr.txt",
          "pdf-to-excel": "ultra-pdf-to-excel.xlsx"
        };
        return map[toolSlug] || "output.pdf";
      }

      function collectFormData() {
        const fd = new FormData();
        const files = Array.from(fileInput.files || []);
        if (toolSlug === "merge-pdf" || toolSlug === "image-to-pdf") {
          files.forEach(f => fd.append("files", f));
        } else {
          fd.append("file", files[0]);
        }

        const get = id => {
          const el = document.getElementById(id);
          return el ? el.value : "";
        };

        fd.append("pages", get("pages"));
        fd.append("degrees", get("degrees"));
        fd.append("text", get("text"));
        fd.append("count", get("count"));
        fd.append("cropX", get("cropX"));
        fd.append("cropY", get("cropY"));
        fd.append("cropW", get("cropW"));
        fd.append("cropH", get("cropH"));
        fd.append("titleMeta", get("titleMeta"));
        fd.append("authorMeta", get("authorMeta"));
        fd.append("subjectMeta", get("subjectMeta"));
        fd.append("keywordsMeta", get("keywordsMeta"));
        fd.append("startPage", get("startPage"));
        return fd;
      }

      downloadBtn.addEventListener("click", () => {
        if (!downloadUrl) return;
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = downloadName;
        document.body.appendChild(a);
        a.click();
        a.remove();
      });

      resetBtn.addEventListener("click", () => {
        fileInput.value = "";
        ["pages","degrees","text","count","cropX","cropY","cropW","cropH","titleMeta","authorMeta","subjectMeta","keywordsMeta","startPage"].forEach(id => {
          const el = document.getElementById(id);
          if (!el) return;
          if (id === "degrees") el.value = "90";
          else if (id === "text") el.value = "CONFIDENTIAL";
          else if (id === "count") el.value = "1";
          else if (id === "cropX" || id === "cropY") el.value = "0";
          else if (id === "cropW") el.value = "400";
          else if (id === "cropH") el.value = "600";
          else if (id === "titleMeta") el.value = "WePDF Document";
          else if (id === "authorMeta") el.value = "WePDF";
          else if (id === "subjectMeta") el.value = "PDF Tools";
          else if (id === "keywordsMeta") el.value = "pdf, tools, wepdf";
          else if (id === "startPage") el.value = "1";
          else el.value = "";
        });
        setStatus("Reset", "Ready again.");
        resultEl.textContent = "No output yet.";
        setProgress(0);
        resetDownload();
      });

      function bindDropZone(el) {
        ["dragenter", "dragover"].forEach(evt => el.addEventListener(evt, e => {
          e.preventDefault();
          e.stopPropagation();
          el.classList.add("drag");
        }));

        ["dragleave", "drop"].forEach(evt => el.addEventListener(evt, e => {
          e.preventDefault();
          e.stopPropagation();
          el.classList.remove("drag");
        }));

        el.addEventListener("drop", ev => {
          const files = ev.dataTransfer.files;
          if (files && files.length) {
            fileInput.files = files;
            setStatus("Files ready", files.length + " file(s) selected.");
            resultEl.textContent = "Files selected. Run a tool to generate output.";
          }
        });
      }

      bindDropZone(uploadArea);

      fileInput.addEventListener("change", () => {
        setStatus("Files ready", (fileInput.files || []).length + " file(s) selected.");
        resultEl.textContent = "Files selected. Run a tool to generate output.";
        resetDownload();
      });

      async function runTool() {
        try {
          const files = Array.from(fileInput.files || []);
          if (!files.length) {
            setStatus("Error", "Upload files first.", true);
            resultEl.textContent = "Choose at least one file before running the tool.";
            return;
          }

          const fd = collectFormData();
          setStatus("Processing", toolSlug + " is running...");
          resultEl.textContent = "Processing your file. Please wait...";
          setProgress(5);
          resetDownload();

          const xhr = new XMLHttpRequest();
          xhr.open("POST", "/api/" + toolSlug, true);
          xhr.responseType = "blob";

          xhr.upload.onprogress = function (e) {
            if (e.lengthComputable) {
              const p = 5 + (e.loaded / e.total) * 55;
              setProgress(p);
            }
          };

          xhr.onprogress = function () {
            if (xhr.readyState === 3) setProgress(70);
          };

          xhr.onload = function () {
            try {
              const ct = xhr.getResponseHeader("content-type") || "";
              if (xhr.status >= 400) {
                if (ct.includes("application/json")) {
                  const reader = new FileReader();
                  reader.onload = function () {
                    try {
                      const data = JSON.parse(reader.result);
                      throw new Error(data.error || "Request failed");
                    } catch (err) {
                      setStatus("Error", err.message, true);
                      resultEl.innerHTML = '<span class="error">' + err.message + "</span>";
                      setProgress(0);
                    }
                  };
                  reader.readAsText(xhr.response);
                  return;
                }
                setStatus("Error", "Request failed", true);
                resultEl.innerHTML = '<span class="error">Request failed</span>';
                setProgress(0);
                return;
              }

              if (ct.includes("application/json")) {
                const reader = new FileReader();
                reader.onload = function () {
                  const data = JSON.parse(reader.result);
                  setStatus("Done", "Completed successfully.");
                  resultEl.textContent = JSON.stringify(data, null, 2);
                  setProgress(100);
                };
                reader.readAsText(xhr.response);
                return;
              }

              const blob = xhr.response;
              downloadUrl = URL.createObjectURL(blob);
              downloadName = xhr.getResponseHeader("x-filename") || inferName();
              downloadBox.classList.add("show");
              setStatus("Done", "Completed successfully.");
              resultEl.textContent = "File is ready. Click download.";
              setProgress(100);
            } catch (err) {
              setStatus("Error", err.message, true);
              resultEl.innerHTML = '<span class="error">' + err.message + "</span>";
              setProgress(0);
            }
          };

          xhr.onerror = function () {
            setStatus("Error", "Network error.", true);
            resultEl.innerHTML = '<span class="error">Network error.</span>';
            setProgress(0);
          };

          xhr.send(fd);
        } catch (err) {
          setStatus("Error", err.message, true);
          resultEl.innerHTML = '<span class="error">' + err.message + "</span>";
          setProgress(0);
        }
      }

      runBtn.addEventListener("click", runTool);
    </script>
  </body>
  </html>`;
}

async function readPdf(file) {
  const bytes = await fsp.readFile(file.path);
  return PDFDocument.load(bytes);
}

function sendPdf(res, buffer, filename) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("X-Filename", filename);
  return res.send(Buffer.from(buffer));
}

function sendZip(res, buffer, filename) {
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("X-Filename", filename);
  return res.send(Buffer.from(buffer));
}

function sendDocx(res, buffer, filename) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("X-Filename", filename);
  return res.send(Buffer.from(buffer));
}

function sendText(res, text, filename) {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("X-Filename", filename);
  return res.send(text);
}

function sendJson(res, data) {
  return res.json(data);
}

app.get("/robots.txt", (req, res) => {
  res.type("text/plain");
  res.send(`User-agent: *
Allow: /

Sitemap: ${fullUrl("sitemap.xml")}`);
});

app.get("/sitemap.xml", (req, res) => {

  const lastmod = new Date().toISOString();
  const urls = [
    "",
    "about",
    "contact",
    "privacy",
    "terms",
    "rules",
    ...tools.map(t => t.slug)
  ];

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(u => {
        const loc = u ? fullUrl(u) : BASE_URL;
        const priority = u === "" ? "1.0" : "0.8";
        return `  <url>
  <loc>${loc}</loc>
  <lastmod>${lastmod}</lastmod>
  <changefreq>weekly</changefreq>
  <priority>${priority}</priority>
</url>`;
      })
      .join("\n") +
    `\n</urlset>`;

  res.header("Content-Type", "application/xml");
  res.send(xml);
});

app.get("/about", (req, res) => {
  res.send(
    buildStaticPage(
      "About Us",
      "About WePDFHub",
      `<p>WePDFHub is a fast PDF tools website built for simple, secure, mobile-friendly document tasks.</p>
       <p>Each tool has its own dedicated URL, making the site easier to browse and better for SEO.</p>`
    )
  );
});

app.get("/contact", (req, res) => {
  res.send(
    buildStaticPage(
      "Contact",
      "Contact WePDFHub",
      `<p>Email: <a href="mailto:support@wepdfhub.click">support@wepdfhub.click</a></p>
       <p>Use this email for tool issues, partnership queries, and website support.</p>`
    )
  );
});

app.get("/privacy", (req, res) => {
  res.send(
    buildStaticPage(
      "Privacy Policy",
      "Privacy Policy",
      `<p>WePDFHub processes uploaded files only for the selected action.</p>
       <ul>
         <li>Temporary files are deleted after processing.</li>
         <li>Files are not stored long-term by design.</li>
         <li>We do not sell user files or personal data.</li>
       </ul>`
    )
  );
});

app.get("/terms", (req, res) => {
  res.send(
    buildStaticPage(
      "Terms of Service",
      "Terms of Service",
      `<p>By using WePDFHub, you agree to use the site legally and responsibly.</p>
       <ul>
         <li>Do not upload illegal, harmful, or unauthorized content.</li>
         <li>Do not abuse the service with spam or malicious traffic.</li>
         <li>File size and usage limits may apply to keep the platform stable.</li>
       </ul>`
    )
  );
});

app.get("/rules", (req, res) => {
  res.send(
    buildStaticPage(
      "Rules",
      "WePDFHub Rules",
      `<p>These rules keep the platform safe, fast, and useful.</p>
       <ul>
         <li>Use supported file types only.</li>
         <li>Keep files within the allowed size.</li>
         <li>Do not upload harmful content.</li>
         <li>Respect copyright and privacy laws.</li>
       </ul>`
    )
  );
});

app.get("/:slug", (req, res, next) => {
  const tool = toolMap.get(req.params.slug);
  if (!tool) return next();
  res.send(renderToolPage(tool));
});

function getSingleFile(req) {
  return req.file ? [req.file] : [];
}

async function pagesToPdfBuffer(inputPdfBytes, pageIndexes, rotateDeg = 0, watermarkText = "", crop = null) {
  const pdf = await PDFDocument.load(inputPdfBytes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(pdf, pageIndexes);
  const font = watermarkText ? await out.embedFont(StandardFonts.HelveticaBold) : null;

  pages.forEach((page, idx) => {
    if (rotateDeg) page.setRotation(degrees(rotateDeg));
    if (crop) page.setCropBox(crop.x, crop.y, crop.w, crop.h);
    if (watermarkText) {
      const { width, height } = page.getSize();
      page.drawText(watermarkText, {
        x: width * 0.16,
        y: height * 0.5,
        size: Math.max(24, Math.min(width, height) / 12),
        font,
        color: rgb(0.75, 0.08, 0.08),
        opacity: 0.16,
        rotate: degrees(30)
      });
    }
    out.addPage(page);
  });

  return out.save();
}

async function renderPdfToImages(pdfBytes, scale = 2) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
  const pdf = await loadingTask.promise;
  const images = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");

    await page.render({
      canvasContext: ctx,
      viewport
    }).promise;

    images.push({
      page: pageNum,
      buffer: canvas.toBuffer("image/jpeg", { quality: 0.92 })
    });
  }

  return images;
}

app.post("/api/merge-pdf", upload.array("files", 20), async (req, res) => {
  const files = req.files || [];
  try {
    if (files.length < 2) return res.status(400).json({ error: "Upload at least 2 PDF files." });
    
    const merged = await PDFDocument.create();
    for (const file of files) {
      const bytes = await fsp.readFile(file.path);
      const pdf = await PDFDocument.load(bytes);
      const copied = await merged.copyPages(pdf, pdf.getPageIndices());
      copied.forEach(page => merged.addPage(page));
    }

    const out = await merged.save();
    sendPdf(res, out, "merged.pdf");
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(files);
  }
});

app.post("/api/split-pdf", upload.single("file"), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });
    const pdf = await readPdf(file);
    const total = pdf.getPageCount();
    const pages = parsePageSpec(req.body.pages, total);
    if (!pages.length) return res.status(400).json({ error: "Enter valid pages like 1,3-5" });

    const zip = new JSZip();
    for (const idx of pages) {
      const outDoc = await PDFDocument.create();
      const copied = await outDoc.copyPages(pdf, [idx]);
      copied.forEach(page => outDoc.addPage(page));
      const buf = await outDoc.save();
      zip.file(`page-${idx + 1}.pdf`, buf);
    }

    const zipBuf = await zip.generateAsync({ type: "nodebuffer" });
    sendZip(res, zipBuf, "split_pages.zip");
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});

app.post("/api/compress-pdf", upload.single("file"), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });
    const pdf = await readPdf(file);
    const out = await pdf.save({ useObjectStreams: true });
    sendPdf(res, out, "compressed.pdf");
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});

app.post("/api/rotate-pdf", upload.single("file"), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });
    const degreesValue = parseInt(req.body.degrees || "90", 10);
    const pdf = await readPdf(file);
    pdf.getPages().forEach(page => page.setRotation(degrees(degreesValue)));
    const out = await pdf.save();
    sendPdf(res, out, "rotated.pdf");
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});

app.post("/api/watermark-pdf", upload.single("file"), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });
    const text = String(req.body.text || "CONFIDENTIAL");
    const pdf = await readPdf(file);
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);

    pdf.getPages().forEach(page => {
      const { width, height } = page.getSize();
      page.drawText(text, {
        x: width * 0.14,
        y: height * 0.5,
        size: Math.max(24, Math.min(width, height) / 12),
        font,
        color: rgb(0.8, 0.1, 0.1),
        opacity: 0.18,
        rotate: degrees(30)
      });
    });

    const out = await pdf.save();
    sendPdf(res, out, "watermarked.pdf");
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});

app.post("/api/extract-text", upload.single("file"), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });
    const bytes = await fsp.readFile(file.path);
    const parsed = await pdfParse(bytes);
    sendJson(res, { pages: parsed.numpages || 0, text: parsed.text || "" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});

app.post("/api/delete-pages", upload.single("file"), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });
    const pdf = await readPdf(file);
    const total = pdf.getPageCount();
    const removePages = parsePageSpec(req.body.pages, total);
    if (!removePages.length) return res.status(400).json({ error: "Enter valid pages like 2,4-6" });

    const keep = [];
    for (let i = 0; i < total; i++) if (!removePages.includes(i)) keep.push(i);

    const outDoc = await PDFDocument.create();
    const copied = await outDoc.copyPages(pdf, keep);
    copied.forEach(page => outDoc.addPage(page));
    const out = await outDoc.save();
    sendPdf(res, out, "pages_deleted.pdf");
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});

app.post("/api/extract-pages", upload.single("file"), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });
    const pdf = await readPdf(file);
    const total = pdf.getPageCount();
    const keepPages = parsePageSpec(req.body.pages, total);
    if (!keepPages.length) return res.status(400).json({ error: "Enter valid pages like 1,3-5" });

    const outDoc = await PDFDocument.create();
    const copied = await outDoc.copyPages(pdf, keepPages);
    copied.forEach(page => outDoc.addPage(page));
    const out = await outDoc.save();
    sendPdf(res, out, "extracted_pages.pdf");
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});

app.post("/api/image-to-pdf", upload.array("files", 20), async (req, res) => {
  const files = req.files || [];
  try {
    if (!files.length) return res.status(400).json({ error: "Upload JPG or PNG files." });

    const outDoc = await PDFDocument.create();
    for (const file of files) {
      const bytes = await fsp.readFile(file.path);
      let img;
      if (file.mimetype === "image/png") img = await outDoc.embedPng(bytes);
      else if (file.mimetype === "image/jpeg" || file.mimetype === "image/jpg") img = await outDoc.embedJpg(bytes);
      else throw new Error("Only JPG and PNG supported.");
      const page = outDoc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }

    const out = await outDoc.save();
    sendPdf(res, out, "images_to_pdf.pdf");
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(files);
  }
});

app.post("/api/page-number", upload.single("file"), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });
    const start = parseInt(req.body.startPage || "1", 10);
    const pdf = await readPdf(file);
    const font = await pdf.embedFont(StandardFonts.Helvetica);

    pdf.getPages().forEach((page, index) => {
      const { width } = page.getSize();
      page.drawText(String(start + index), {
        x: width / 2 - 6,
        y: 18,
        size: 10,
        font,
        color: rgb(0.1, 0.1, 0.1)
      });
    });

    const out = await pdf.save();
    sendPdf(res, out, "numbered.pdf");
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});

app.post("/api/reorder-pages", upload.single("file"), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });
    const pdf = await readPdf(file);
    const total = pdf.getPageCount();
    const order = parsePageOrder(req.body.pages, total);

    const outDoc = await PDFDocument.create();
    const copied = await outDoc.copyPages(pdf, order);
    copied.forEach(page => outDoc.addPage(page));
    const out = await outDoc.save();
    sendPdf(res, out, "reordered.pdf");
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});

app.post("/api/reverse-pages", upload.single("file"), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });
    const pdf = await readPdf(file);
    const order = [...Array(pdf.getPageCount()).keys()].reverse();

    const outDoc = await PDFDocument.create();
    const copied = await outDoc.copyPages(pdf, order);
    copied.forEach(page => outDoc.addPage(page));
    const out = await outDoc.save();
    sendPdf(res, out, "reversed.pdf");
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});

app.post("/api/duplicate-pages", upload.single("file"), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });
    const pdf = await readPdf(file);
    const total = pdf.getPageCount();
    const pages = parsePageSpec(req.body.pages, total);
    if (!pages.length) return res.status(400).json({ error: "Enter valid pages like 1,3-5" });

    const outDoc = await PDFDocument.create();
    const copiedOriginal = await outDoc.copyPages(pdf, [...Array(total).keys()]);
    copiedOriginal.forEach(page => outDoc.addPage(page));

    const copiedExtra = await outDoc.copyPages(pdf, pages);
    copiedExtra.forEach(page => outDoc.addPage(page));

    const out = await outDoc.save();
    sendPdf(res, out, "duplicated.pdf");
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});

app.post("/api/add-blank-pages", upload.single("file"), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });
    const count = Math.max(1, parseInt(req.body.count || "1", 10));
    const pdf = await readPdf(file);
    const firstPage = pdf.getPages()[0];
    const size = firstPage ? firstPage.getSize() : { width: 595, height: 842 };

    for (let i = 0; i < count; i++) pdf.addPage([size.width, size.height]);

    const out = await pdf.save();
    sendPdf(res, out, "blank_pages_added.pdf");
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});

app.post("/api/crop-pdf", upload.single("file"), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });

    const crop = {
      x: parseFloat(req.body.cropX || "0"),
      y: parseFloat(req.body.cropY || "0"),
      w: parseFloat(req.body.cropW || "400"),
      h: parseFloat(req.body.cropH || "600")
    };

    const pdf = await readPdf(file);
    pdf.getPages().forEach(page => {
      if (typeof page.setCropBox === "function") page.setCropBox(crop.x, crop.y, crop.w, crop.h);
    });

    const out = await pdf.save();
    sendPdf(res, out, "cropped.pdf");
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});

app.post("/api/metadata-pdf", upload.single("file"), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });
    const pdf = await readPdf(file);

    pdf.setTitle(String(req.body.titleMeta || "WePDF Document"));
    pdf.setAuthor(String(req.body.authorMeta || "WePDF"));
    pdf.setSubject(String(req.body.subjectMeta || "PDF Tools"));
    pdf.setKeywords(
      String(req.body.keywordsMeta || "pdf, tools, wepdf")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
    );

    const out = await pdf.save();
    sendPdf(res, out, "metadata_updated.pdf");
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});

app.post("/api/pdf-info", upload.single("file"), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });
    const bytes = await fsp.readFile(file.path);
    const parsed = await pdfParse(bytes);
    const pdf = await PDFDocument.load(bytes);

    sendJson(res, {
      pageCount: pdf.getPageCount(),
      info: parsed.info || {},
      metadata: parsed.metadata || {}
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});

app.post("/api/pdf-to-word", upload.single("file"), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });

    const bytes = await fsp.readFile(file.path);
    const parsed = await pdfParse(bytes);
    const lines = String(parsed.text || "")
      .split(/\n+/)
      .map(s => s.trim())
      .filter(Boolean);

    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ children: [new TextRun({ text: "WePDFHub PDF to Word", bold: true })] }),
            ...lines.map(line => new Paragraph(line))
          ]
        }
      ]
    });

    const buffer = await Packer.toBuffer(doc);
    sendDocx(res, buffer, "converted.docx");
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});

app.post("/api/pdf-to-jpg", upload.single("file"), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });

    const bytes = await fsp.readFile(file.path);
    const images = await renderPdfToImages(bytes, 2);
    if (images.length > 10) {
  throw new Error("Max 10 pages allowed for this tool.");
}
    
    const zip = new JSZip();

    for (const img of images) {
      zip.file(`page-${img.page}.jpg`, img.buffer);
    }

    const zipBuf = await zip.generateAsync({ type: "nodebuffer" });
    sendZip(res, zipBuf, "pdf_pages_jpg.zip");
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});

app.post("/api/ocr-pdf", upload.single("file"), async (req, res) => {
  const file = req.file;
  let worker;
  try {
    if (!file) return res.status(400).json({ error: "Upload one PDF file." });

    const bytes = await fsp.readFile(file.path);
    const images = await renderPdfToImages(bytes, 2);
    
    if (images.length > 10) {
  throw new Error("Max 10 pages allowed for this tool.");
    }
    
    worker = await createWorker({
  logger: m => console.log(m)
});

await worker.loadLanguage("eng");
await worker.initialize("eng");

    const results = [];
    for (const img of images) {
      const { data } = await worker.recognize(img.buffer);
      if (data && data.text && data.text.trim()) {
        results.push(`--- Page ${img.page} ---\n${data.text.trim()}`);
      }
    }

    await worker.terminate();
    worker = null;

    sendText(res, results.join("\n\n") || "No OCR text found.", "ocr-output.txt");
  } catch (err) {
    try {
      if (worker) await worker.terminate();
    } catch {}
    res.status(500).json({ error: err.message });
  } finally {
    await cleanupFiles(getSingleFile(req));
  }
});

app.get("/:slug", (req, res, next) => {
  const tool = toolMap.get(req.params.slug);
  if (!tool) return next();
  res.send(renderToolPage(tool));
});

app.use((req, res) => {
  res.status(404).send("Not Found");
});

app.listen(PORT, () => {
  console.log(`WePDFHub running on port ${PORT}`);
});
