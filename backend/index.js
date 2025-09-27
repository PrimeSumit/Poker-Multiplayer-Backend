import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";

import { createServer } from "http";
import { Server } from "socket.io";
import connectDB from "./src/config/db.js"; //DB config file
import { initSockets } from "./src/websocket/socket.js";
import { startRoomExpiryWatcher } from "./src/websocket/roomManager.js";
import authRoutes from "./src/routes/authRoutes.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
//env variables
dotenv.config();
const app = express();

// Middleware
app.use(express.json());
app.use(cors());

app.use("/avatars", express.static(path.join(__dirname, "assets/avatar")));

app.use("/api/auth", authRoutes);
// Connect DB
connectDB();

// Test Route

app.get("/", (req, res) => {
  res.send("✅ API is running...");
});

// Server Listen
const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => {
//   console.log(`🚀 Server running on http://localhost:${PORT}`);
// });
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  methods: ["GET", "POST"],
});
initSockets(io);
startRoomExpiryWatcher(30 * 60 * 1000);
server.listen(PORT, () => {
  console.log(`server running on http://localhost:${PORT}`);
});
