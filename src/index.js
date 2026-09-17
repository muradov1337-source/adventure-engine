import "dotenv/config";
import { createBot } from "./bot.js";
import { createWeb } from "./web.js";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("Немає BOT_TOKEN у .env");
  process.exit(1);
}

const app = createWeb();
const bot = createBot(token);
const port = Number(process.env.PORT || 3000);

if (process.env.WEBHOOK_URL) {
  app.post("/telegram-webhook", bot.webhookCallback("/telegram-webhook"));
}

app.listen(port, async () => {
  console.log(`Сайт: http://localhost:${port}`);
  if (process.env.WEBHOOK_URL) {
    await bot.telegram.setWebhook(process.env.WEBHOOK_URL);
    console.log("Бот: webhook", process.env.WEBHOOK_URL);
  } else {
    await bot.launch();
    console.log("Бот: polling");
  }
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
