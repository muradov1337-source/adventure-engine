import { Telegraf, Markup } from "telegraf";
import fs from "node:fs";
import path from "node:path";
import { getStore, updateStore } from "./store.js";
import { bindTicket, ticketForUser, spendTicket } from "./tickets.js";
import { planPlaces, formatPlaceLine, mapsSearchLink, fallbackMapsQuery } from "./places.js";

const adventure = JSON.parse(
  fs.readFileSync(path.resolve("adventures/soft-return.json"), "utf8")
);

export function createBot(token) {
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const telegramId = ctx.from.id;
    const payload = (ctx.startPayload || "").trim();

    if (payload) {
      const bound = bindTicket(payload, telegramId);
      if (!bound.ok && bound.reason === "not_found") {
        await ctx.reply("Цей код доступу не знайдено. Перевір посилання з сайту.");
        return;
      }
      if (!bound.ok && bound.reason === "used") {
        await ctx.reply("Цей квиток уже активував хтось інший.");
        return;
      }
      if (!bound.ok && bound.reason === "spent") {
        await ctx.reply("Цей квиток уже використано. Потрібна нова пригода.");
        return;
      }
    }

    const ticket = ticketForUser(telegramId, adventure.id);
    if (!ticket) {
      const site = process.env.PUBLIC_URL || "";
      await ctx.reply(
        "Це бот пригоди «М’яке повернення».\n\nБез квитка кроки не відкриваються.\nОплати на сайті — і повернись сюди з посилання після оплати.",
        site
          ? Markup.inlineKeyboard([[Markup.button.url("Відкрити сайт", site)]])
          : undefined
      );
      return;
    }

    await ctx.reply(
      "Квиток є.\n\n«М’яке повернення» — близько години. Це не екскурсія. Місто підставить декорації під тебе.\n\nПеред стартом надішли локацію ОДИН раз. Далі бот більше її не проситиме.\nКраще «трансляція геопозиції» на 1 годину — тоді маршрут точніший. Звичайна точка теж підійде.",
      Markup.keyboard([[Markup.button.locationRequest("Надіслати, де я")]])
        .resize()
        .oneTime()
    );
  });

  bot.on("location", async (ctx) => {
    const telegramId = ctx.from.id;
    const ticket = ticketForUser(telegramId, adventure.id);
    if (!ticket) {
      await ctx.reply("Спочатку потрібен квиток з сайту.");
      return;
    }

    const loc = ctx.message.location;
    const start = { lat: loc.latitude, lon: loc.longitude };

    updateStore((s) => {
      s.sessions[telegramId] = {
        adventureId: adventure.id,
        step: 0,
        start,
        places: {},
        answers: [],
        startedAt: Date.now(),
      };
    });

    await ctx.reply("Ок, старт зафіксовано. Шукаю точки поруч — якщо не встигну, дам карту.", Markup.removeKeyboard());

    let places = {};
    try {
      places = await planPlaces(start, adventure.places_needed || []);
    } catch (err) {
      console.error(err);
    }

    updateStore((s) => {
      if (s.sessions[telegramId]) s.sessions[telegramId].places = places;
    });

    const found = Object.values(places).filter(Boolean).length;
    if (found) {
      await ctx.reply(`Знайшов ${found} точк${found === 1 ? "у" : "и"} поруч.`);
    } else {
      await ctx.reply("Конкретну адресу зараз не знайшов. На кроках з місцем буде кнопка карти.");
    }

    await sendStep(ctx, telegramId);
  });

  bot.on("text", async (ctx) => {
    const telegramId = ctx.from.id;
    const session = getStore().sessions[telegramId];
    if (!session) return;
    const step = adventure.steps[session.step];
    if (!step) return;
    if (step.type === "INPUT") {
      updateStore((s) => {
        s.sessions[telegramId].answers.push({
          step: step.id,
          text: ctx.message.text,
        });
      });
      await advance(ctx, telegramId);
    }
  });

  bot.action("next", async (ctx) => {
    await ctx.answerCbQuery();
    await advance(ctx, ctx.from.id);
  });

  bot.action("here", async (ctx) => {
    await ctx.answerCbQuery();
    await advance(ctx, ctx.from.id);
  });

  bot.command("pause", async (ctx) => {
    await ctx.reply("Сеанс стоїть. Напиши /continue коли будеш готовий.");
  });

  bot.command("continue", async (ctx) => {
    const session = getStore().sessions[ctx.from.id];
    if (!session) {
      await ctx.reply("Немає незавершеної пригоди. Натисни /start");
      return;
    }
    await sendStep(ctx, ctx.from.id);
  });

  return bot;
}

async function advance(ctx, telegramId) {
  const session = getStore().sessions[telegramId];
  if (!session) {
    await ctx.reply("Сеанс загубився. Натисни /start");
    return;
  }

  const current = adventure.steps[session.step];
  if (current?.type === "END") {
    spendTicket(telegramId, adventure.id);
    updateStore((s) => {
      s.sessions[telegramId].finishedAt = Date.now();
    });
    await ctx.reply("Квиток на цю пригоду закрито. Дякую, що вийшла.");
    return;
  }

  updateStore((s) => {
    s.sessions[telegramId].step += 1;
  });
  await sendStep(ctx, telegramId);
}

async function sendStep(ctx, telegramId) {
  const session = getStore().sessions[telegramId];
  const step = adventure.steps[session.step];
  if (!step) {
    await ctx.reply("Кроки закінчились.");
    return;
  }

  let text = step.text;
  if (step.place_key) {
    const place = session.places?.[step.place_key];
    const line = place
      ? formatPlaceLine(place)
      : step.fallback || "Знайди місце сам. Є кнопка пошуку на карті.";
    text = text.replace("{place_line}", line);
  }

  const buttons = [];
  if (step.type === "LOCATION") {
    const place = session.places?.[step.place_key];
    const origin = session.start;
    if (place?.maps) {
      buttons.push([Markup.button.url("Відкрити шлях", place.maps)]);
    } else {
      const q = fallbackMapsQuery(step.place_key);
      buttons.push([Markup.button.url("Знайти на карті", mapsSearchLink(q, origin))]);
    }
    buttons.push([Markup.button.callback(step.button || "Я тут", "here")]);
  } else if (step.type === "INPUT") {
    buttons.push([Markup.button.callback(step.button || "Далі", "next")]);
  } else {
    buttons.push([Markup.button.callback(step.button || "Далі", "next")]);
  }

  await ctx.reply(text, Markup.inlineKeyboard(buttons));
}
