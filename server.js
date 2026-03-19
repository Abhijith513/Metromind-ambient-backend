/**
 * server.js  –  Entry point
 *
 * Mount the psychiatric transcription router and apply the
 * security / body-parsing middleware your production app needs.
 *
 * npm install express helmet cors dotenv @google/genai multer uuid
 */

import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import transcribeRouter from "./transcribeAudio.js";

const app = express();

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());

// ── CORS – restrict to your frontend origin in production ────────────────────
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
    methods: ["POST"],
  })
);

// ── Transcription route ───────────────────────────────────────────────────────
// Note: do NOT add express.json() / urlencoded before this route –
// multer handles its own body parsing for multipart requests.
app.use("/api", transcribeRouter);

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 4000;
app.listen(PORT, () => console.log(`Psych API listening on :${PORT}`));
