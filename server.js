const express = require("express");
const multer = require("multer");
const fs = require("fs");
const archiver = require("archiver");
const { PDFDocument } = require("pdf-lib");

const app = express();
app.use(express.static("public"));
app.use(require("cors")());

const upload = multer({ dest: "uploads/" });

/* MERGE */
app.post("/merge", upload.array("files"), async (req, res) => {
  const merged = await PDFDocument.create();
  for (let file of req.files) {
    const pdf = await PDFDocument.load(fs.readFileSync(file.path));
    const pages = await merged.copyPages(pdf, pdf.getPageIndices());
    pages.forEach(p => merged.addPage(p));
  }
  const bytes = await merged.save();
  fs.writeFileSync("merged.pdf", bytes);
  res.download("merged.pdf");
});

/* SPLIT ALL PAGES */
app.post("/split", upload.single("file"), async (req, res) => {
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
});

/* COMPRESS */
app.post("/compress", upload.single("file"), async (req, res) => {
  const pdf = await PDFDocument.load(fs.readFileSync(req.file.path));
  const bytes = await pdf.save({ useObjectStreams: true });
  fs.writeFileSync("compressed.pdf", bytes);
  res.download("compressed.pdf");
});

/* JPG → PDF */
app.post("/jpg-to-pdf", upload.array("files"), async (req, res) => {
  const pdf = await PDFDocument.create();

  for (let file of req.files) {
    const img = await pdf.embedJpg(fs.readFileSync(file.path));
    const page = pdf.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }

  const bytes = await pdf.save();
  fs.writeFileSync("image.pdf", bytes);
  res.download("image.pdf");
});

/* ROTATE */
app.post("/rotate", upload.single("file"), async (req, res) => {
  const pdf = await PDFDocument.load(fs.readFileSync(req.file.path));
  pdf.getPages().forEach(p => p.setRotation({ angle: 90 }));
  const bytes = await pdf.save();
  fs.writeFileSync("rotated.pdf", bytes);
  res.download("rotated.pdf");
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Server running 🚀")
);
