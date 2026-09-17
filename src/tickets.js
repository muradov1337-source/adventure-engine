import { getStore, updateStore, makeCode } from "./store.js";

export function createTicket({ adventureId, note = "" }) {
  const code = makeCode("t");
  updateStore((data) => {
    data.tickets[code] = {
      code,
      adventureId,
      note,
      status: "unused",
      telegramId: null,
      createdAt: Date.now(),
    };
  });
  return code;
}

export function bindTicket(code, telegramId) {
  const data = getStore();
  const ticket = data.tickets[code];
  if (!ticket) return { ok: false, reason: "not_found" };
  if (ticket.status === "used" && ticket.telegramId !== telegramId) {
    return { ok: false, reason: "used" };
  }
  if (ticket.status === "spent") return { ok: false, reason: "spent" };

  updateStore((s) => {
    const t = s.tickets[code];
    t.status = "used";
    t.telegramId = telegramId;
    t.boundAt = Date.now();
  });
  return { ok: true, ticket: { ...ticket, telegramId, status: "used" } };
}

export function ticketForUser(telegramId, adventureId) {
  const data = getStore();
  return (
    Object.values(data.tickets).find(
      (t) => t.telegramId === telegramId && t.adventureId === adventureId && t.status !== "spent"
    ) || null
  );
}

export function spendTicket(telegramId, adventureId) {
  updateStore((s) => {
    const t = Object.values(s.tickets).find(
      (x) => x.telegramId === telegramId && x.adventureId === adventureId && x.status === "used"
    );
    if (t) t.status = "spent";
  });
}
