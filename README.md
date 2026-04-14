# PDF Tools Pro

## What works
- PDF to JPG
- JPG to PDF
- PDF to Word
- PDF to Excel
- PDF to PPT
- PDF to Text
- Merge PDF
- Split PDF
- Compress PDF
- Protect PDF
- Unlock PDF
- Rotate PDF
- Reorder pages
- Delete pages
- Add watermark
- Add page numbers
- Bonus OCR endpoint

## Install on server
```bash
npm install
sudo apt update
sudo apt install -y qpdf poppler-utils
npm start
```

## Notes
- `qpdf` is required for protect/unlock
- `pdftoppm` from `poppler-utils` is required for PDF to JPG/PNG and OCR
