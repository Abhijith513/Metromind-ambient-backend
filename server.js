import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import sessionRoutes from "./routes/sessionRoutes.js";

const app = express();

app.use(helmet());

app.use(cors({
  origin: "*", // tighten later
}));

app.use(express.json());

app.use("/api", sessionRoutes);

const PORT = process.env.PORT ?? 4000;
app.listen(PORT, () => {
  console.log(`Psych API listening on :${PORT}`);
});