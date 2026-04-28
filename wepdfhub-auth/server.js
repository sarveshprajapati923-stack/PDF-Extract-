require("dotenv").config();
const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");

const app = express();

app.use(express.json());
app.use(cors({ origin: true, credentials: true }));
app.use(helmet());
app.use(cookieParser());
app.use(express.static("public"));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use(limiter);

const client = new MongoClient(process.env.MONGO_URI);

let users, tokens;

async function connectDB() {
  try {
    await client.connect();
    const db = client.db("wepdfhub");
    users = db.collection("users");
    tokens = db.collection("tokens");
    console.log("✅ Mongo Connected");
  } catch (err) {
    console.log("❌ Mongo Error:", err.message);
  }
}

function generateToken(user) {
  return jwt.sign(
    { id: user._id, email: user.email },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: "15m" }
  );
}

function generateRefresh(user) {
  return jwt.sign(
    { id: user._id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: "7d" }
  );
}

function auth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ message: "No token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
}

// ---------------- ROUTES ----------------

// Home
app.get("/", (req, res) => {
  res.send("🚀 SaaS Auth Running");
});

// Register
app.post("/register", async (req, res) => {
  const { email, password } = req.body;

  const exist = await users.findOne({ email });
  if (exist) return res.json({ message: "User exists" });

  const hash = await bcrypt.hash(password, 10);

  await users.insertOne({
    email,
    password: hash,
    createdAt: new Date()
  });

  res.json({ message: "Registered" });
});

// Login
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await users.findOne({ email });
  if (!user) return res.status(401).json({ message: "User not found" });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ message: "Wrong password" });

  const accessToken = generateToken(user);
  const refreshToken = generateRefresh(user);

  await tokens.insertOne({
    userId: user._id,
    token: refreshToken
  });

  res.json({ accessToken, refreshToken });
});

// Refresh
app.post("/refresh", async (req, res) => {
  const { token } = req.body;

  if (!token) return res.status(401).json({ message: "No token" });

  const stored = await tokens.findOne({ token });
  if (!stored) return res.status(403).json({ message: "Invalid" });

  const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);

  const accessToken = jwt.sign(
    { id: decoded.id },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: "15m" }
  );

  res.json({ accessToken });
});

// Logout
app.post("/logout", async (req, res) => {
  const { token } = req.body;

  await tokens.deleteOne({ token });
  res.json({ message: "Logged out" });
});

// Protected
app.get("/dashboard", auth, (req, res) => {
  res.json({ message: "Welcome", user: req.user });
});

app.listen(process.env.PORT, () => {
  console.log("🚀 Server running on port " + process.env.PORT);
});
