import { Telegraf, Markup } from "telegraf";
import fs from "node:fs";
import path from "node:path";
import { getStore, updateStore } from "./store.js";
import { bindTicket, ticketForUser, spendTicket } from "./tickets.js";
import { planPlaces, formatPlaceLine, mapsSearchLink, fallbackMapsQuery, walkingDirectionsLink } from "./places.js";
import { nextDeparture } from "./transit.js";

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
        "Це бот пригоди.\n\nБез квитка кроки не відкриваються.\nОплати на сайті — і повернись сюди з посилання після оплати.",
        site
          ? Markup.inlineKeyboard([[Markup.button.url("Відкрити сайт", site)]])
          : undefined
      );
      return;
    }

    updateStore((s) => {
      s.sessions[telegramId] = {
        adventureId: adventure.id,
        step: 0,
        gender: null,
        start: null,
        current: null,
        geoAt: null,
        liveUntil: null,
        places: {},
        answers: [],
        transit: null,
        startedAt: Date.now(),
      };
    });

    await sendStep(ctx, telegramId);
  });

  bot.on("location", async (ctx) => {
    await handleIncomingLocation(ctx, ctx.message.location);
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
    if (!session || session.finishedAt) return;
    const step = adventure.steps[session.step];
    if (!step) return;
    if (step.type === "NOTE" || step.type === "INPUT") {
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

  bot.action("gender:female", async (ctx) => {
    await ctx.answerCbQuery();
    setGender(ctx.from.id, "female");
    await advance(ctx, ctx.from.id);
  });

  bot.action("gender:male", async (ctx) => {
    await ctx.answerCbQuery();
    setGender(ctx.from.id, "male");
    await advance(ctx, ctx.from.id);
  });

  bot.command("pause", async (ctx) => {
    await ctx.reply("Сеанс стоїть. Напиши /continue коли будеш готова або готовий.");
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

function setGender(telegramId, gender) {
  updateStore((s) => {
    if (s.sessions[telegramId]) s.sessions[telegramId].gender = gender;
  });
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
    if (!session.start) session.start = geo;
    if (liveUntil) session.liveUntil = liveUntil;
  });
}

function geoIsFresh(session) {
  if (!session?.current) return false;
  if (session.liveUntil && session.liveUntil > Date.now()) return true;
  if (session.geoAt && Date.now() - session.geoAt < LIVE_STALE_MS) return true;
  return false;
}

function stepText(step, gender) {
  if (gender === "female" && step.text_female) return step.text_female;
  return step.text;
}

function stepButton(step, gender) {
  if (gender === "female" && step.button_female) return step.button_female;
  return step.button || "Далі";
}

async function handleIncomingLocation(ctx, loc) {
  const telegramId = ctx.from.id;
  const ticket = ticketForUser(telegramId, adventure.id);
  if (!ticket) {
    await ctx.reply("Спочатку потрібен квиток з сайту.");
    return;
  }

  const session = getStore().sessions[telegramId];
  if (!session || session.finishedAt) {
    await ctx.reply("Натисни /start, щоб почати пригоду.");
    return;
  }

  saveGeo(telegramId, loc);

  if (session.awaitingPlace || adventure.steps[session.step]?.type === "GEO") {
    updateStore((s) => {
      if (s.sessions[telegramId]) s.sessions[telegramId].awaitingPlace = null;
    });
    await ctx.reply("Місце бачу.", Markup.removeKeyboard());
    if (adventure.steps[session.step]?.type === "GEO") {
      await advance(ctx, telegramId);
    } else {
      await sendStep(ctx, telegramId);
    }
  }
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
    return;
  }

  updateStore((s) => {
    const sess = s.sessions[telegramId];
    sess.step += 1;
    if (current?.refresh_geo_after && !(sess.liveUntil && sess.liveUntil > Date.now())) {
      sess.geoAt = 0;
    }
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

  const gender = session.gender;

  if (step.type === "END") {
    spendTicket(telegramId, adventure.id);
    updateStore((s) => {
      s.sessions[telegramId].finishedAt = Date.now();
    });
    await ctx.reply(stepText(step, gender));
    return;
  }

  if (step.type === "GEO") {
    await ctx.reply(
      stepText(step, gender),
      Markup.keyboard([[Markup.button.locationRequest("Поділитись")]])
        .resize()
        .oneTime()
    );
    return;
  }

  if ((step.type === "LOCATION" || step.refresh_geo_after) && step.place_key && !geoIsFresh(session)) {
    updateStore((s) => {
      s.sessions[telegramId].awaitingPlace = step.place_key || "now";
    });
    await ctx.reply(
      "Щоб вести далі, потрібне місце, де ти зараз. Поділись місцезнаходженням ще раз.\n\nАбо увімкни трансляцію на годину: скріпка → Геопозиція → Транслювати геопозицію → 1 година.",
      Markup.keyboard([[Markup.button.locationRequest("Поділитись")]])
        .resize()
        .oneTime()
    );
    return;
  }

  if (step.type === "LOCATION" && step.place_key) {
    const places = await resolvePlaceForStep(session, step);
    updateStore((s) => {
      if (s.sessions[telegramId]) s.sessions[telegramId].places = places;
    });
  }

  if (step.id === "ride") {
    const origin = session.current || session.start;
    let transit = null;
    if (origin) transit = await nextDeparture(origin.lat, origin.lon);
    updateStore((s) => {
      if (s.sessions[telegramId]) s.sessions[telegramId].transit = transit;
    });
  }

  const fresh = getStore().sessions[telegramId];
  let text = stepText(step, gender);
  if (step.id === "ride" && fresh.transit && step.text_gtfs) {
    text = step.text_gtfs
      .replace("{route_type}", fresh.transit.type || "маршрут")
      .replace("{route_no}", fresh.transit.no || "")
      .replace("{eta}", fresh.transit.eta || "");
  }

  const stop = fresh.places?.stop;
  const park = fresh.places?.park;
  const cafe = fresh.places?.cafe;
  text = text
    .replace("{stop_name}", stop?.name || "найближча зупинка")
    .replace("{stop_min}", stop ? `${stop.minutes} хв` : "кількох хвилинах")
    .replace("{park_name}", park?.name || "найближчий парк або сквер")
    .replace("{cafe_name}", cafe?.name || "найближче кафе")
    .replace("{cafe_min}", cafe ? String(cafe.minutes) : "?")
    .replace("{walk_min}", String(stop?.minutes || park?.minutes || cafe?.minutes || "?"));

  if (step.place_key) {
    const place = fresh.places?.[step.place_key];
    const line = place
      ? formatPlaceLine(place)
      : step.fallback || "Знайди місце сам. Є кнопка пошуку на карті.";
    text = text.replace("{place_line}", line);
  }

  if (step.type === "MEDIA") {
    await ctx.reply(text);
    await sendParkAudio(ctx);
    await ctx.reply("Коли файл скінчиться — тисни «Далі».", Markup.inlineKeyboard([
      [Markup.button.callback(stepButton(step, gender), "next")],
    ]));
    return;
  }

  if (step.type === "NOTE" || step.type === "INPUT") {
    await ctx.reply(text);
    return;
  }

  const buttons = [];
  if (step.type === "CHOOSE" && step.choices) {
    buttons.push(
      step.choices.map((c) => Markup.button.callback(c.label, `gender:${c.id}`))
    );
    await ctx.reply(text, Markup.inlineKeyboard(buttons));
    return;
  }

  if (step.type === "LOCATION") {
    const place = fresh.places?.[step.place_key];
    const origin = fresh.current || fresh.start;
    const walk = walkingDirectionsLink(origin, place);
    if (walk) {
      buttons.push([Markup.button.url("Дивитись на мапі", walk)]);
    } else {
      const q = fallbackMapsQuery(step.place_key);
      buttons.push([Markup.button.url("Дивитись на мапі", mapsSearchLink(q, origin))]);
    }
    buttons.push([Markup.button.callback(stepButton(step, gender), "here")]);
  } else {
    buttons.push([Markup.button.callback(stepButton(step, gender), "next")]);
  }

  await ctx.reply(text, Markup.inlineKeyboard(buttons));
}

async function sendParkAudio(ctx) {
  const fileId = process.env.PARK_AUDIO_FILE_ID;
  const local = path.resolve("media/park.ogg");
  try {
    if (fileId) {
      await ctx.replyWithVoice(fileId);
      return;
    }
    if (fs.existsSync(local)) {
      await ctx.replyWithVoice({ source: fs.createReadStream(local) });
    }
  } catch (err) {
    console.error("audio", err.message);
  }
}
