const TIMEOUT_MS = 10000;

/**
 * Київське табло. Поки що безпечно повертає null,
 * якщо фіди міста не відповіли за 10 секунд.
 * Бот тоді каже: «сідай у перший міський транспорт».
 */
export async function nextDeparture(_lat, _lon) {
  try {
    return await Promise.race([
      lookupKyiv(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    console.error("transit", err.message);
    return null;
  }
}

async function lookupKyiv() {
  // Друга черга: GTFS Київпастрансу.
  // Static: http://193.23.225.211:8002/export-gtfs-static
  // RT:     http://193.23.225.214:732/api/realtime
  return null;
}
