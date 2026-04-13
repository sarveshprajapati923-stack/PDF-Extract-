const express = require("express");
const fileUpload = require("express-fileupload");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");

const app = express();
app.use(fileUpload());

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
if (!fs.existsSync("files")) fs.mkdirSync("files");

app.use(express.static(path.join(__dirname,"public")));

app.post("/upload",(req,res)=>{
 if(!req.files) return res.json({success:false});
 let file=req.files.file;
 let p=path.join(__dirname,"uploads",file.name);
 file.mv(p);
 res.json({success:true,file:"/files/"+file.name});
});

app.post("/zip",(req,res)=>{
 if(!req.files) return res.json({success:false});
 let file=req.files.file;
 let zipName=Date.now()+".zip";
 let zipPath=path.join(__dirname,"files",zipName);

 let output=fs.createWriteStream(zipPath);
 let archive=archiver("zip");
 archive.pipe(output);
 archive.append(file.data,{name:file.name});
 archive.finalize();

 output.on("close",()=>{
  res.json({success:true,file:"/files/"+zipName});
 });
});

app.use("/files",express.static(path.join(__dirname,"files")));

app.get("/",(req,res)=>{
 res.sendFile(path.join(__dirname,"public","index.html"));
});

app.listen(process.env.PORT||3000);
