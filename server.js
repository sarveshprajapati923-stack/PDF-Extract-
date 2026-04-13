const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");

const app = express();
app.use(cors());
app.use(fileUpload());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// Upload + Process
app.post("/upload", async (req, res) => {
  if (!req.files || !req.files.file) {
    return res.json({ success: false });
  }

  const file = req.files.file;
  const uploadPath = path.join(__dirname, "uploads", file.name);

  await file.mv(uploadPath);

  res.json({
    success: true,
    file: "/files/" + file.name
  });
});

// ZIP convert
app.post("/zip", async (req, res) => {
  if (!req.files || !req.files.file) {
    return res.json({ success: false });
  }

  const file = req.files.file;
  const zipName = file.name + ".zip";
  const zipPath = path.join(__dirname, "files", zipName);

  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip");

  archive.pipe(output);
  archive.append(file.data, { name: file.name });
  await archive.finalize();

  res.json({
    success: true,
    file: "/files/" + zipName
  });
});

app.use("/files", express.static("files"));

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
