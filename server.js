const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const pdfParse = require('pdf-parse');
const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 20
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX = 40;
const rateStore = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const hits = rateStore.get(ip) || [];
  const fresh = hits.filter(ts => now - ts < RATE_WINDOW_MS);

  if (fresh.length >= RATE_MAX) {
    return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });
  }

  fresh.push(now);
  rateStore.set(ip, fresh);
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of rateStore.entries()) {
    const fresh = hits.filter(ts => now - ts < RATE_WINDOW_MS);
    if (fresh.length) rateStore.set(ip, fresh);
    else rateStore.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

app.use(rateLimit);

function badRequest(res, msg) {
  return res.status(400).json({ ok: false, error: msg });
}

function sanitizeName(name) {
  return String(name || 'file')
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function uniqByHash(files) {
  const seen = new Set();
  const out = [];
  for (const file of files) {
    const hash = sha256(file.buffer);
    if (!seen.has(hash)) {
      seen.add(hash);
      out.push(file);
    }
  }
  return out;
}

function isPdf(file) {
  return file?.mimetype === 'application/pdf' || String(file?.originalname || '').toLowerCase().endsWith('.pdf');
}

function isImage(file) {
  return ['image/png', 'image/jpeg', 'image/jpg'].includes(file?.mimetype);
}

function parsePages(input, maxPages) {
  const text = String(input || '').trim();
  if (!text) return [];
  const out = new Set();

  for (const part of text.split(',')) {
    const p = part.trim();
    if (!p) continue;

    if (p.includes('-')) {
      const [aRaw, bRaw] = p.split('-');
      const a = Number(aRaw);
      const b = Number(bRaw);
      if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
      const start = Math.max(1, Math.min(a, b));
      const end = Math.min(maxPages, Math.max(a, b));
      for (let i = start; i <= end; i++) out.add(i);
    } else {
      const n = Number(p);
      if (Number.isInteger(n) && n >= 1 && n <= maxPages) out.add(n);
    }
  }

  return [...out].sort((a, b) => a - b);
}

async function bytesToPdf(bytes) {
  return PDFDocument.load(bytes, { ignoreEncryption: false });
}

async function makePdfFromSinglePage(sourcePdf, pageIndex) {
  const out = await PDFDocument.create();
  const [page] = await out.copyPages(sourcePdf, [pageIndex]);
  out.addPage(page);
  return out.save();
}

async function zipDirectory(sourceDir, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

function sendPdf(res, bytes, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('x-filename', filename);
  return res.send(Buffer.from(bytes));
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function renderDocPage(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
  <style>
    :root{
      --bg:#f8fafc;
      --bg2:#eef5ff;
      --panel:#ffffff;
      --line:#dbe3ef;
      --text:#0f172a;
      --muted:#64748b;
      --a:#2563eb;
      --shadow:0 18px 50px rgba(15,23,42,.08);
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family:system-ui,-apple-system,Segoe UI,sans-serif;
      background:linear-gradient(180deg,var(--bg),var(--bg2));
      color:var(--text);
      line-height:1.7;
    }
    main{max-width:920px;margin:0 auto;padding:24px}
    a{color:var(--a);text-decoration:none}
    a:hover{text-decoration:underline}
    .card{
      background:var(--panel);
      border:1px solid var(--line);
      border-radius:22px;
      padding:22px;
      box-shadow:var(--shadow);
    }
    h1,h2{line-height:1.15;margin-top:0}
    .muted{color:var(--muted)}
  </style>
</head>
<body>
<main>
  <p><a href="/">← Back to home</a></p>
  <div class="card">
    ${bodyHtml}
  </div>
</main>
</body>
</html>`;
}

app.get('/health', (req, res) => {
  res.json({ ok: true, name: 'WePDF', rules: 'enabled' });
});

app.get('/api/rules', (req, res) => {
  res.json({
    ok: true,
    maxUploadSizeMB: 25,
    maxFilesPerRequest: 20,
    rateLimit: `${RATE_MAX} requests / ${Math.round(RATE_WINDOW_MS / 60000)} min`,
    allowedPdfTools: ['merge', 'split', 'rotate', 'watermark', 'extract-text', 'delete-pages', 'extract-pages', 'page-number', 'compress'],
    allowedImageTools: ['image-to-pdf'],
    rules: [
      'Only PDF files for PDF tools.',
      'PNG/JPG only for image-to-pdf.',
      'Max upload size 25MB per file.',
      'Up to 20 files per request.',
      'Duplicate PDFs are ignored in merge.',
      'Valid page syntax: 1,3-5',
      'Rotate only accepts 0, 90, 180, 270 degrees.'
    ]
  });
});

app.get('/privacy', (req, res) => {
  res.type('html').send(renderDocPage(
    'Privacy Policy',
    `
      <h1>Privacy Policy</h1>
      <p class="muted">Last updated: today</p>
      <p>Files are processed temporarily to complete the selected PDF tool request. Uploaded files are not intended for permanent storage.</p>
      <p>We do not sell personal data. Logs may include basic technical information such as time, IP address, and request status for security and abuse prevention.</p>
      <p>Processed files are deleted after the task finishes, except when a browser download is created during the request.</p>
    `
  ));
});

app.get('/terms', (req, res) => {
  res.type('html').send(renderDocPage(
    'Terms of Service',
    `
      <h1>Terms of Service</h1>
      <p class="muted">Last updated: today</p>
      <p>Use this service only for lawful files that you have the right to upload and process.</p>
      <p>Do not upload malware, copyrighted files you do not own, or content that violates any law or third-party rights.</p>
      <p>Service availability, speed, and file limits may change without notice.</p>
      <p>We may block abusive traffic, oversized files, duplicate spam, or invalid requests.</p>
    `
  ));
});

app.post('/api/merge', upload.array('files', 20), async (req, res) => {
  try {
    let files = (req.files || []).filter(isPdf);
    files = uniqByHash(files);

    if (files.length < 2) return badRequest(res, 'Upload at least 2 unique PDF files.');

    const out = await PDFDocument.create();

    for (const file of files) {
      const pdf = await bytesToPdf(file.buffer);
      const pages = await out.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(page => out.addPage(page));
    }

    const bytes = await out.save({ useObjectStreams: true });
    return sendPdf(res, bytes, 'merged.pdf');
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Merge failed' });
  }
});

app.post('/api/split', upload.single('file'), async (req, res) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-split-'));
  const zipPath = path.join(tempDir, 'split_pages.zip');

  try {
    const file = req.file;
    if (!file || !isPdf(file)) return badRequest(res, 'Upload one valid PDF file.');

    const pdf = await bytesToPdf(file.buffer);
    const maxPages = pdf.getPageCount();
    const wanted = parsePages(req.body.pages, maxPages);
    const selected = wanted.length ? wanted : pdf.getPageIndices().map(i => i + 1);

    if (!selected.length) return badRequest(res, 'No valid pages found.');
    if (selected.length > 200) return badRequest(res, 'Too many pages requested.');

    for (const pageNumber of selected) {
      const single = await makePdfFromSinglePage(pdf, pageNumber - 1);
      const base = sanitizeName(path.parse(file.originalname || 'page.pdf').name);
      const outPath = path.join(tempDir, `${base}_page_${pageNumber}.pdf`);
      fs.writeFileSync(outPath, Buffer.from(single));
    }

    await zipDirectory(tempDir, zipPath);
    return res.download(zipPath, 'split_pages.zip', () => cleanupDir(tempDir));
  } catch (err) {
    cleanupDir(tempDir);
    return res.status(500).json({ ok: false, error: err.message || 'Split failed' });
  }
});

app.post('/api/rotate', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file || !isPdf(file)) return badRequest(res, 'Upload one valid PDF file.');

    const degreesValue = Number(req.body.degrees);
    const allowed = new Set([0, 90, 180, 270]);
    const rotation = allowed.has(degreesValue) ? degreesValue : 90;

    const pdf = await bytesToPdf(file.buffer);
    pdf.getPages().forEach(page => page.setRotation(degrees(rotation)));

    const bytes = await pdf.save({ useObjectStreams: true });
    return sendPdf(res, bytes, 'rotated.pdf');
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Rotate failed' });
  }
});

app.post('/api/watermark', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file || !isPdf(file)) return badRequest(res, 'Upload one valid PDF file.');

    const text = String(req.body.text || 'CONFIDENTIAL').trim().slice(0, 60) || 'CONFIDENTIAL';
    const pdf = await bytesToPdf(file.buffer);
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);

    for (const page of pdf.getPages()) {
      const { width, height } = page.getSize();
      page.drawText(text, {
        x: width * 0.12,
        y: height * 0.5,
        size: Math.max(24, Math.min(width, height) / 10),
        font,
        color: rgb(0.15, 0.45, 0.95),
        rotate: degrees(30),
        opacity: 0.16
      });
    }

    const bytes = await pdf.save({ useObjectStreams: true });
    return sendPdf(res, bytes, 'watermarked.pdf');
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Watermark failed' });
  }
});

app.post('/api/extract-text', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file || !isPdf(file)) return badRequest(res, 'Upload one valid PDF file.');

    const data = await pdfParse(file.buffer);
    return res.json({
      ok: true,
      pages: data.numpages,
      text: (data.text || '').trim(),
      info: data.info || {}
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Text extraction failed' });
  }
});

app.post('/api/delete-pages', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file || !isPdf(file)) return badRequest(res, 'Upload one valid PDF file.');

    const pdf = await bytesToPdf(file.buffer);
    const maxPages = pdf.getPageCount();
    const toDelete = parsePages(req.body.pages, maxPages);

    if (!toDelete.length) return badRequest(res, 'Enter pages to delete like 2,4-6.');

    const keep = pdf.getPageIndices().map(i => i + 1).filter(n => !toDelete.includes(n));
    if (!keep.length) return badRequest(res, 'All pages cannot be deleted.');

    const out = await PDFDocument.create();
    for (const pageNumber of keep) {
      const [copied] = await out.copyPages(pdf, [pageNumber - 1]);
      out.addPage(copied);
    }

    const bytes = await out.save({ useObjectStreams: true });
    return sendPdf(res, bytes, 'pages_deleted.pdf');
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Delete pages failed' });
  }
});

app.post('/api/extract-pages', upload.single('file'), async (req, res) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-extract-'));
  const zipPath = path.join(tempDir, 'extracted_pages.zip');

  try {
    const file = req.file;
    if (!file || !isPdf(file)) return badRequest(res, 'Upload one valid PDF file.');

    const pdf = await bytesToPdf(file.buffer);
    const maxPages = pdf.getPageCount();
    const selected = parsePages(req.body.pages, maxPages);

    if (!selected.length) return badRequest(res, 'Enter pages like 1,3-5.');
    if (selected.length > 200) return badRequest(res, 'Too many pages requested.');

    for (const pageNumber of selected) {
      const single = await makePdfFromSinglePage(pdf, pageNumber - 1);
      const base = sanitizeName(path.parse(file.originalname || 'page.pdf').name);
      const outPath = path.join(tempDir, `${base}_page_${pageNumber}.pdf`);
      fs.writeFileSync(outPath, Buffer.from(single));
    }

    await zipDirectory(tempDir, zipPath);
    return res.download(zipPath, 'extracted_pages.zip', () => cleanupDir(tempDir));
  } catch (err) {
    cleanupDir(tempDir);
    return res.status(500).json({ ok: false, error: err.message || 'Extract pages failed' });
  }
});

app.post('/api/image-to-pdf', upload.array('files', 20), async (req, res) => {
  try {
    const files = (req.files || []).filter(isImage);
    if (!files.length) return badRequest(res, 'Upload PNG or JPG image files.');

    const out = await PDFDocument.create();

    for (const file of files) {
      const img = file.mimetype === 'image/png'
        ? await out.embedPng(file.buffer)
        : await out.embedJpg(file.buffer);

      const page = out.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }

    const bytes = await out.save({ useObjectStreams: true });
    return sendPdf(res, bytes, 'images_to_pdf.pdf');
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Image to PDF failed' });
  }
});

app.post('/api/page-number', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file || !isPdf(file)) return badRequest(res, 'Upload one valid PDF file.');

    const pdf = await bytesToPdf(file.buffer);
    const font = await pdf.embedFont(StandardFonts.Helvetica);

    pdf.getPages().forEach((page, i) => {
      const { width } = page.getSize();
      page.drawText(String(i + 1), {
        x: width - 40,
        y: 18,
        size: 10,
        font,
        color: rgb(0.25, 0.25, 0.25),
        opacity: 0.85
      });
    });

    const bytes = await pdf.save({ useObjectStreams: true });
    return sendPdf(res, bytes, 'numbered.pdf');
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Page number failed' });
  }
});

app.post('/api/compress', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file || !isPdf(file)) return badRequest(res, 'Upload one valid PDF file.');

    const pdf = await bytesToPdf(file.buffer);
    const bytes = await pdf.save({ useObjectStreams: true });
    return sendPdf(res, bytes, 'compressed.pdf');
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Compress failed' });
  }
});

app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, error: 'File too large. Max size is 25MB.' });
  }
  if (err?.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ ok: false, error: 'Too many files uploaded.' });
  }
  return next(err);
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Route not found' });
});

app.listen(PORT, () => {
  console.log(`WePDF running on http://localhost:${PORT}`);
});
