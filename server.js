const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");

const app = express();
app.use(cors());
app.use(fileUpload());

// ✅ folders auto create
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
if (!fs.existsSync("files")) fs.mkdirSync("files");

// ✅ static public folder
app.use(express.static(path.join(__dirname, "public")));

// ✅ ROOT route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ✅ Upload API
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

// ✅ ZIP API
app.post("/zip", async (req, res) => {
  if (!req.files || !req.files.file) {
    return res.json({ success: false });
  }

  const file = req.files.file;
  const zipName = Date.now() + "-" + file.name + ".zip";
  const zipPath = path.join(__dirname, "files", zipName);

  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip");

  archive.pipe(output);
  archive.append(file.data, { name: file.name });

  archive.finalize();

  output.on("close", () => {
    res.json({
      success: true,
      file: "/files/" + zipName
    });
  });
});

// ✅ files access
app.use("/files", express.static(path.join(__dirname, "files")));

// ✅ START SERVER (FIXED)
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
