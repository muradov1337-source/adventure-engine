import express from "express";
import path from "node:path";
import { createTicket } from "./tickets.js";

export function createWeb() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(express.static(path.resolve("public")));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.post("/api/ticket", (req, res) => {
    const secret = req.body.secret || req.headers["x-admin-secret"];
    if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
      res.status(403).json({ error: "Невірний секрет" });
      return;
    }
    const code = createTicket({
      adventureId: "soft-return",
      note: req.body.note || "",
    });
    const bot = process.env.BOT_USERNAME || "";
    const link = bot ? `https://t.me/${bot}?start=${code}` : code;
    res.json({ code, link });
  });

  return app;
}
