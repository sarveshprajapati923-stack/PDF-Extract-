const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const { PDFDocument } = require("pdf-lib");

const app = express();
app.use(express.static("public"));
app.use(require("cors")());

/* 🔐 RULES */
const MAX_SIZE = 10 * 1024 * 1024; // 10MB limit

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: MAX_SIZE },
});

/* 🧹 AUTO DELETE FILE */
function cleanup(files) {
  if (!files) return;
  if (Array.isArray(files)) {
    files.forEach(f => fs.unlink(f.path, () => {}));
  } else {
    fs.unlink(files.path, () => {});
  }
}

/* ❌ ERROR HANDLER */
app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.send("❌ File too large (max 10MB)");
  }
  res.send("❌ Error occurred");
});

/* ✅ MERGE */
app.post("/merge", upload.array("files", 5), async (req, res) => {
  try {
    const merged = await PDFDocument.create();
    for (let f of req.files) {
      const pdf = await PDFDocument.load(fs.readFileSync(f.path));
      const pages = await merged.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }
    const bytes = await merged.save();
    fs.writeFileSync("out.pdf", bytes);
    res.download("out.pdf", () => cleanup(req.files));
  } catch {
    res.send("❌ Merge failed");
  }
});

/* ✅ SPLIT */
app.post("/split", upload.single("file"), async (req, res) => {
  try {
    const pdf = await PDFDocument.load(fs.readFileSync(req.file.path));
    const zip = archiver("zip");
    res.attachment("split.zip");
    zip.pipe(res);

    for (let i = 0; i < pdf.getPageCount(); i++) {
      const newPdf = await PDFDocument.create();
      const [page] = await newPdf.copyPages(pdf, [i]);
      newPdf.addPage(page);
      const bytes = await newPdf.save();
      zip.append(bytes, { name: `page-${i + 1}.pdf` });
    }

    zip.finalize();
    cleanup(req.file);
  } catch {
    res.send("❌ Split failed");
  }
});

/* ✅ COMPRESS */
app.post("/compress", upload.single("file"), async (req, res) => {
  try {
    const pdf = await PDFDocument.load(fs.readFileSync(req.file.path));
    const bytes = await pdf.save({ useObjectStreams: true });
    fs.writeFileSync("out.pdf", bytes);
    res.download("out.pdf", () => cleanup(req.file));
  } catch {
    res.send("❌ Compress failed");
  }
});

/* ✅ JPG → PDF */
app.post("/jpg-to-pdf", upload.array("files", 5), async (req, res) => {
  try {
    const pdf = await PDFDocument.create();
    for (let f of req.files) {
      const img = await pdf.embedJpg(fs.readFileSync(f.path));
      const page = pdf.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }
    const bytes = await pdf.save();
    fs.writeFileSync("out.pdf", bytes);
    res.download("out.pdf", () => cleanup(req.files));
  } catch {
    res.send("❌ JPG to PDF failed");
  }
});

/* ✅ ROTATE */
app.post("/rotate", upload.single("file"), async (req, res) => {
  try {
    const pdf = await PDFDocument.load(fs.readFileSync(req.file.path));
    pdf.getPages().forEach(p => p.setRotation({ angle: 90 }));
    const bytes = await pdf.save();
    fs.writeFileSync("out.pdf", bytes);
    res.download("out.pdf", () => cleanup(req.file));
  } catch {
    res.send("❌ Rotate failed");
  }
});

app.listen(process.env.PORT || 3000, () =>
  console.log("🚀 FileForge running")
);
