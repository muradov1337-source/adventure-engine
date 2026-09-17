import "dotenv/config";
import { createTicket } from "./tickets.js";

const code = createTicket({
  adventureId: "soft-return",
  note: process.argv[2] || "cli",
});
const bot = process.env.BOT_USERNAME || "BOT";
console.log("Код:", code);
console.log("Посилання:", `https://t.me/${bot}?start=${code}`);
