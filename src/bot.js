import { Telegraf, Markup } from "telegraf";
import fs from "node:fs";
import path from "node:path";
import { getStore, updateStore } from "./store.js";
import { bindTicket, ticketForUser, spendTicket } from "./tickets.js";
import { planPlaces, formatPlaceLine, mapsSearchLink, fallbackMapsQuery } from "./places.js";

const adventure = JSON.parse(
  fs.readFileSync(path.resolve("adventures/soft-return.json"), "utf8")
);

const LIVE_STALE_MS = 10 * 60 * 1000;

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
      "Квиток є.\n\nНайкраще зараз увімкнути трансляцію гео на 1 годину:\nскріпка → Геопозиція → Транслювати геопозицію → 1 година.\n\nБот не вестиме за тобою в чаті. Просто запам’ятає, де ти є, і на кроці з кафе знайде заклад від тієї точки.\n\nЯкщо трансляцію не хочеш — натисни кнопку нижче. Тоді на кафе можу ще раз попросити «де ти».",
      Markup.keyboard([[Markup.button.locationRequest("Надіслати одну точку")]])
        .resize()
        .oneTime()
    );
  });

  bot.on("location", async (ctx) => {
    await handleIncomingLocation(ctx, ctx.message.location, ctx.message);
  });

  bot.on("edited_message", async (ctx) => {
    const loc = ctx.editedMessage?.location;
    if (!loc) return;
    const telegramId = ctx.from.id;
    const session = getStore().sessions[telegramId];
    if (!session || session.finishedAt) return;
    saveGeo(telegramId, loc);
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

function readGeo(loc) {
  return { lat: loc.latitude, lon: loc.longitude };
}

function saveGeo(telegramId, loc) {
  const geo = readGeo(loc);
  const liveUntil = loc.live_period
    ? Date.now() + Number(loc.live_period) * 1000
    : null;
  updateStore((s) => {
    const session = s.sessions[telegramId];
    if (!session) return;
    session.current = geo;
    session.geoAt = Date.now();
    if (liveUntil) session.liveUntil = liveUntil;
  });
}

function geoIsFresh(session) {
  if (!session?.current) return false;
  if (session.liveUntil && session.liveUntil > Date.now()) return true;
  if (session.geoAt && Date.now() - session.geoAt < LIVE_STALE_MS) return true;
  return false;
}

async function handleIncomingLocation(ctx, loc, rawMessage) {
  const telegramId = ctx.from.id;
  const ticket = ticketForUser(telegramId, adventure.id);
  if (!ticket) {
    await ctx.reply("Спочатку потрібен квиток з сайту.");
    return;
  }

  const geo = readGeo(loc);
  const existing = getStore().sessions[telegramId];

  if (existing && !existing.finishedAt && existing.awaitingPlace) {
    saveGeo(telegramId, loc);
    updateStore((s) => {
      s.sessions[telegramId].awaitingPlace = null;
    });
    await ctx.reply("Є свіжа точка. Шукаю місце поруч…", Markup.removeKeyboard());
    await sendStep(ctx, telegramId);
    return;
  }

  if (existing && !existing.finishedAt) {
    saveGeo(telegramId, loc);
    return;
  }

  const liveUntil = loc.live_period
    ? Date.now() + Number(loc.live_period) * 1000
    : null;

  updateStore((s) => {
    s.sessions[telegramId] = {
      adventureId: adventure.id,
      step: 0,
      start: geo,
      current: geo,
      geoAt: Date.now(),
      liveUntil,
      places: {},
      answers: [],
      startedAt: Date.now(),
    };
  });

  if (liveUntil) {
    await ctx.reply(
      "Трансляцію бачу. Далі кроки підуть текстом. Кафе підставлю вже від того місця, де ти будеш на тому кроці.",
      Markup.removeKeyboard()
    );
  } else {
    await ctx.reply(
      "Точку прийняв. Якщо пройдеш далеко, на кроці кафе попрошу гео ще раз.",
      Markup.removeKeyboard()
    );
  }

  await sendStep(ctx, telegramId);
}

async function resolvePlaceForStep(session, step) {
  if (!step?.place_key) return session.places || {};
  const origin = session.current || session.start;
  if (!origin) return session.places || {};
  const need = (adventure.places_needed || []).find((p) => p.key === step.place_key) || {
    key: step.place_key,
    category: step.place_key,
    radius_m: 1600,
  };
  try {
    const found = await planPlaces(origin, [need]);
    return { ...(session.places || {}), ...found };
  } catch (err) {
    console.error(err);
    return session.places || {};
  }
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

  if (step.type === "LOCATION" && step.place_key && !geoIsFresh(session)) {
    updateStore((s) => {
      s.sessions[telegramId].awaitingPlace = step.place_key;
    });
    await ctx.reply(
      "Щоб дати кафе від тебе зараз, надішли гео ще раз.\nАбо увімкни трансляцію на годину: скріпка → Геопозиція → Транслювати.",
      Markup.keyboard([[Markup.button.locationRequest("Я тут зараз")]])
        .resize()
        .oneTime()
    );
    return;
  }

  if (step.type === "LOCATION" && step.place_key) {
    await ctx.reply("Шукаю найближче місце від тебе зараз…");
    const places = await resolvePlaceForStep(session, step);
    updateStore((s) => {
      if (s.sessions[telegramId]) s.sessions[telegramId].places = places;
    });
  }

  const fresh = getStore().sessions[telegramId];
  let text = step.text;
  const cafe = fresh.places?.cafe;
  const water = fresh.places?.water;
  text = text
    .replace("{cafe_name}", cafe?.name || "найближче кафе")
    .replace("{water_name}", water?.name || "найближча вода")
    .replace("{cafe_min}", cafe ? String(cafe.minutes) : "?")
    .replace("{water_min}", water ? String(water.minutes) : "?");
  if (step.place_key) {
    const place = fresh.places?.[step.place_key];
    const line = place
      ? formatPlaceLine(place)
      : step.fallback || "Знайди місце сам. Є кнопка пошуку на карті.";
    text = text.replace("{place_line}", line);
  }

  const buttons = [];
  if (step.type === "LOCATION") {
    const place = fresh.places?.[step.place_key];
    const origin = fresh.current || fresh.start;
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
