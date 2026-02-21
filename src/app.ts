import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import { menu } from './menu';
import { state, loadStateSync, saveStateSync } from './storage';

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));


app.get('/', (req, res) => {
    res.send('Restaurant Bot API läuft 🍽️');
});


const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromWhatsApp = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
const restaurantWhatsAppTo = process.env.RESTAURANT_WHATSAPP_TO;

let client: any = null;
if (accountSid && authToken) {
    client = twilio(accountSid, authToken);
} else {
    console.warn('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN are not set. Twilio messaging is disabled.');
}

loadStateSync();

const userStates = state.userStates;
const pendingPayments = state.pendingPayments;
const orderHistory = state.orderHistory;

const TABLE_COUNT = Number(process.env.TABLE_COUNT || '10');
const TABLE_SEATS = Number(process.env.TABLE_SEATS || '4');
const OPEN_HOUR = Number(process.env.OPEN_HOUR || '16');
const CLOSE_HOUR = Number(process.env.CLOSE_HOUR || '22');

const reservationTimers: { [phone: string]: NodeJS.Timeout[] } = {};
const tempReschedules: { [phone: string]: { index?: number; newDate?: string; newTime?: string } } = {};
const pendingCancellations: { [phone: string]: { index: number } } = {};

function clearReservationTimers(phone: string) {
    const arr = reservationTimers[phone];
    if (arr) {
        for (const t of arr) clearTimeout(t);
    }
    reservationTimers[phone] = [];
}

function rebuildReservationTimersForUser(phone: string) {
    clearReservationTimers(phone);
    const u = userStates[phone];
    if (!u || !client) return;
    const timers: NodeJS.Timeout[] = [];
    (u.reservations || []).forEach((r) => {
        if (!r.date || !r.time) return;
        const iso = `${r.date}T${r.time}:00`;
        const dt = new Date(iso);
        if (isNaN(dt.getTime())) return;
        const offsets = [24 * 60 * 60 * 1000, 60 * 60 * 1000];
        offsets.forEach(offset => {
            const when = dt.getTime() - offset;
            if (when > Date.now()) {
                const delay = when - Date.now();
                const t = setTimeout(() => {
                    const text = offset === 24 * 60 * 60 * 1000
                        ? `Erinnerung: Deine Reservierung am ${r.date} um ${r.time} ist in 24 Stunden.`
                        : `Erinnerung: Deine Reservierung am ${r.date} um ${r.time} ist in 60 Minuten.`;
                    client!.messages.create({
                        from: fromWhatsApp,
                        to: phone,
                        body: text
                    }).catch((err: any) => console.error(err));
                }, delay);
                timers.push(t);
            }
        });
    });
    reservationTimers[phone] = timers;
}

// Восстановить таймеры при старте
for (const phone of Object.keys(userStates)) {
    rebuildReservationTimersForUser(phone);
}

function getReservationsAt(date: string, time: string) {
    const out: { phone: string; reservation: { date?: string; time?: string; table?: number } }[] = [];
    for (const phone of Object.keys(userStates)) {
        const u = userStates[phone];
        (u.reservations || []).forEach((r) => {
            if (r.date === date && r.time === time) {
                out.push({ phone, reservation: r });
            }
        });
    }
    return out;
}

function getUsedTables(date: string, time: string): number[] {
    const used: number[] = [];
    for (const x of getReservationsAt(date, time)) {
        const r: any = x.reservation;
        if (Array.isArray(r.tables)) {
            for (const t of r.tables) if (typeof t === 'number') used.push(t);
        } else if (typeof r.table === 'number') {
            used.push(r.table);
        }
    }
    return Array.from(new Set(used)).sort((a, b) => a - b);
}

function firstFreeTable(used: number[]): number | null {
    for (let t = 1; t <= TABLE_COUNT; t++) {
        if (!used.includes(t)) return t;
    }
    return null;
}

function findNextAvailableSlotSameDay(dateStr: string, timeStr: string): { date: string; time: string } | null {
    const base = new Date(`${dateStr}T${timeStr}:00`);
    if (isNaN(base.getTime())) return null;
    const open = new Date(`${dateStr}T${String(OPEN_HOUR).padStart(2, '0')}:00:00`);
    const close = new Date(`${dateStr}T${String(CLOSE_HOUR).padStart(2, '0')}:00:00`);
    const start = new Date(Math.max(base.getTime() + 30 * 60 * 1000, open.getTime()));
    const end = close;
    for (let t = new Date(start); t <= end; t = new Date(t.getTime() + 30 * 60 * 1000)) {
        const d = t.toISOString().slice(0, 10);
        if (d !== dateStr) break;
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        const time = `${hh}:${mm}`;
        const count = getReservationsAt(d, time).length;
        if (count < TABLE_COUNT) {
            return { date: d, time };
        }
    }
    return null;
}

function timeWithinBusinessHours(dateStr: string, timeStr: string): boolean {
    const t = new Date(`${dateStr}T${timeStr}:00`);
    if (isNaN(t.getTime())) return false;
    const h = t.getHours() + t.getMinutes() / 60;
    return h >= OPEN_HOUR && h <= CLOSE_HOUR;
}

function allocateTables(date: string, time: string, guests: number): number[] | null {
    const used = getUsedTables(date, time);
    const seatsPerTable = Math.max(1, Math.floor(TABLE_SEATS));
    const need = Math.max(1, Math.ceil(Math.max(guests, 1) / seatsPerTable));
    const out: number[] = [];
    for (let t = 1; t <= TABLE_COUNT; t++) {
        if (!used.includes(t)) {
            out.push(t);
            if (out.length >= need) break;
        }
    }
    if (out.length < need) return null;
    return out;
}

function calculateOrderTotal(items: { name: string; quantity: number }[]) {
    return items.reduce((sum, i) => {
        const menuItem = menu.find(m => m.name === i.name);
        return sum + (menuItem?.price || 0) * i.quantity;
    }, 0);
}

function finalizeOrder(from: string, items: { name: string; quantity: number; notes?: string }[]): string {
    if (!items || !items.length) {
        return 'Deine Bestellung ist leer. Bitte füge zuerst Gerichte hinzu.';
    }
    const orderSummary = items
        .map(i => `${i.quantity}x ${i.name}${i.notes ? ' (' + i.notes + ')' : ''}`)
        .join('\n');
    const totalAmount = calculateOrderTotal(items);
    if (client && restaurantWhatsAppTo) {
        client.messages.create({
            from: fromWhatsApp,
            to: restaurantWhatsAppTo,
            body: `Neue Bestellung von ${from}:\n${orderSummary}\nGesamt: €${totalAmount}`
        }).catch((err: any) => console.error(err));
    } else {
        console.warn('Admin notification skipped: Twilio client or RESTAURANT_WHATSAPP_TO not configured.');
    }
    const paymentLink = `https://meinezahlungsseite.com/pay?amount=${totalAmount}&user=${encodeURIComponent(from)}`;
    const itemsForStore = items.map(i => ({ name: i.name, quantity: i.quantity, notes: i.notes }));
    pendingPayments[from] = { amount: totalAmount, items: itemsForStore };
    orderHistory.push({ phone: from, items: itemsForStore, amount: totalAmount, createdAt: new Date().toISOString() });
    pendingPayments[from].timeoutId = setTimeout(() => {
        if (client) {
            client.messages.create({
                from: fromWhatsApp,
                to: from,
                body: `Hallo! Wir haben gesehen, dass die Zahlung von €${totalAmount} für deine Bestellung noch aussteht. Hier ist der Link erneut: ${paymentLink}`
            }).catch((err: any) => console.error(err));
        } else {
            console.warn('Payment reminder skipped: Twilio client not configured.');
        }
    }, 15 * 60 * 1000);
    return `Alles klar! Deine Bestellung wurde aufgenommen 🍽️\nBitte bezahle hier: ${paymentLink}`;
}

function normalizeText(s?: string) {
    if (!s) return '';
    const t = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return t.replace(/ü/g, 'u').replace(/ё/g, 'е');
}

function findMenuItemByName(name: string) {
    const n = name.trim().toLowerCase();
    const exact = menu.find(m => m.name.toLowerCase() === n);
    if (exact) return exact;
    const incl = menu.find(m => m.name.toLowerCase().includes(n) || n.includes(m.name.toLowerCase()));
    return incl || null;
}

function parseOrderLine(line: string): { name: string; quantity: number } {
    const t = line.trim();
    const re1 = /^(\d+)\s*x\s*(.+)$/i;
    const re2 = /^(.+?)\s*x\s*(\d+)$/i;
    const re3 = /^(\d+)\s+(.+)$/i;
    let m;
    if ((m = t.match(re1))) return { quantity: parseInt(m[1], 10), name: m[2].trim() };
    if ((m = t.match(re2))) return { quantity: parseInt(m[2], 10), name: m[1].trim() };
    if ((m = t.match(re3))) return { quantity: parseInt(m[1], 10), name: m[2].trim() };
    return { name: t, quantity: 1 };
}

function validateTwilioSignature(req: express.Request, res: express.Response, next: express.NextFunction) {
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!token) {
        console.warn('Missing TWILIO_AUTH_TOKEN; skipping Twilio signature validation.');
        return next();
    }
    const signature = req.get('x-twilio-signature');
    if (!signature) {
        return res.status(401).send('Missing Twilio signature');
    }
    const url = process.env.PUBLIC_WEBHOOK_URL || `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const isValid = twilio.validateRequest(token, signature, url, req.body || {});
    if (!isValid) {
        return res.status(403).send('Invalid Twilio signature');
    }
    next();
}

app.post('/webhook', validateTwilioSignature, (req, res) => {
    const incomingMsg = req.body.Body?.trim();
    const from = req.body.From;
    const profileName = (req.body.ProfileName || req.body.profileName || '').trim();

    console.log('Nachricht empfangen:', incomingMsg, 'von', from);

    if (!userStates[from]) {
        userStates[from] = { step: 0, reservation: {}, order: { items: [] } };
    }

    const state = userStates[from];

    if (!state.reservation) state.reservation = {};
    if (!state.order) state.order = { items: [] };

    let reply = '';

    const cmd = normalizeText(incomingMsg);

    if (['menu', 'menue', 'menü'].includes(cmd)) {
        let menuText = 'Unsere Speisekarte 🍽️\n\n';
        menu.forEach(item => {
            menuText += `${item.name} – €${item.price}\n`;
        });
        reply = `${menuText}\nBestelle einfach mit Text wie:\n"2x Margherita Pizza" oder "Tiramisu".`;
    }

    else if ((['reservierung'].includes(cmd)) && state.step === 0) {
        reply = 'Für welches Datum möchtest du reservieren? (z.B. 2026-02-10)';
        state.step = 1;
    } else if (state.step === 1) {
        state.reservation.date = incomingMsg;
        reply = 'Um welche Uhrzeit? (z.B. 19:30)';
        state.step = 2;
    } else if (state.step === 2) {
        state.reservation.time = incomingMsg;
        if (!timeWithinBusinessHours(state.reservation.date || '', state.reservation.time || '')) {
            reply = `Uhrzeit nur zwischen ${String(OPEN_HOUR).padStart(2,'0')}:00 und ${String(CLOSE_HOUR).padStart(2,'0')}:00 möglich. Bitte neue Uhrzeit senden.`;
            state.step = 2;
        } else {
            reply = 'Wie viele Personen? (z.B. 2)';
            state.step = 3;
        }
    } else if (state.step === 3) {
        const guests = Math.max(1, parseInt((incomingMsg || '').trim(), 10) || 1);
        if (!state.reservations) state.reservations = [];
        const date = state.reservation.date || '';
        const time = state.reservation.time || '';
        const tables = allocateTables(date, time, guests);
        if (tables) {
            const reservation: any = { date, time, guests };
            if (tables.length === 1) reservation.table = tables[0];
            else reservation.tables = tables;
            state.reservations.push(reservation);
            const tText = tables.length === 1 ? `an Tisch ${tables[0]}` : `an Tischen ${tables.join(', ')}`;
            reply = `Reservierung ist gespeichert: ${date}, ${time}, ${tText}, ${guests} ${guests===1?'Person':'Personen'} 🍽️\n\nTipps:\n- "Reservierungen" – alle Reservierungen\n- "Reservierungen heute" – nur heute\n- "Diese Woche" – nächste 7 Tage`;
            state.step = 0;
            state.reservation = {};
            rebuildReservationTimersForUser(from);
        } else {
            const suggestion = findNextAvailableSlotSameDay(date, time);
            if (!suggestion) {
                reply = `An ${date} zwischen ${String(OPEN_HOUR).padStart(2,'0')}:00 und ${String(CLOSE_HOUR).padStart(2,'0')}:00 ist alles voll.\nBitte andere Uhrzeit oder anderes Datum wählen.`;
                state.step = 2;
            } else {
                const alt = allocateTables(suggestion.date, suggestion.time, guests);
                if (alt) {
                    const reservation: any = { date: suggestion.date, time: suggestion.time, guests };
                    if (alt.length === 1) reservation.table = alt[0];
                    else reservation.tables = alt;
                    state.reservations.push(reservation);
                    const tText = alt.length === 1 ? `Tisch ${alt[0]}` : `Tische ${alt.join(', ')}`;
                    reply = `Für ${date} um ${time} sind nicht genug Plätze frei.\nIch habe für dich reserviert:\n${reservation.date} um ${reservation.time}, ${tText}, ${guests} ${guests===1?'Person':'Personen'} 🍽️`;
                    state.step = 0;
                    state.reservation = {};
                    rebuildReservationTimersForUser(from);
                } else {
                    reply = 'Es sind aktuell keine passenden Plätze frei. Bitte andere Uhrzeit oder anderes Datum wählen.';
                    state.step = 2;
                }
            }
        }
    }

    else if ((['reservierungen heute', 'heute reservierungen', 'heute'].includes(cmd))) {
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const today = `${yyyy}-${mm}-${dd}`;
        const todays = (state.reservations || []).filter(r => r.date === today);
        if (!todays.length) {
            reply = 'Heute hast du keine Reservierungen.';
        } else {
            const list = todays
                .map((r, idx) => `${idx + 1}. ${r.date || ''} ${r.time || ''}`.trim())
                .join('\n');
            reply = `Deine Reservierungen heute:\n${list}\n\nZum Ändern: "Stornieren" oder "Verschieben".`;
        }
    }
    else if ((['reservierungen diese woche', 'diese woche', 'woche'].includes(cmd))) {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
        const upcoming = (state.reservations || []).filter(r => {
            if (!r.date) return false;
            const d = new Date(`${r.date}T00:00:00`);
            if (isNaN(d.getTime())) return false;
            return d >= start && d < end;
        });
        if (!upcoming.length) {
            reply = 'In den nächsten 7 Tagen hast du keine Reservierungen.';
        } else {
            const list = upcoming
                .map((r, idx) => `${idx + 1}. ${r.date || ''} ${r.time || ''}`.trim())
                .join('\n');
            reply = `Deine Reservierungen in den nächsten 7 Tagen:\n${list}\n\nZum Ändern: "Stornieren" oder "Verschieben".`;
        }
    }
    else if ((['reservierungen', 'meine reservierungen', 'reservations'].includes(cmd))) {
        const list = (state.reservations && state.reservations.length)
            ? state.reservations.map((r, idx) => `${idx + 1}. ${r.date || ''} ${r.time || ''}`.trim()).join('\n')
            : 'Noch keine Reservierungen.';
        reply = `Deine Reservierungen:\n${list}\n\nBeispiele:\n- "Reservierungen heute"\n- "Diese Woche"\n- "Stornieren 1"\n- "Verschieben 2026-03-10 19:30"`;
    }
    else if (cmd.startsWith('stornieren')) {
        const full = (incomingMsg || '').trim();
        const parts = full.split(/\s+/);
        if (!state.reservations || state.reservations.length === 0) {
            reply = 'Keine Reservierungen zum Stornieren.';
        } else {
            let idx = NaN;
            if (parts.length > 1) {
                const maybeNumber = parseInt(parts[1], 10);
                if (!Number.isNaN(maybeNumber)) {
                    idx = maybeNumber - 1;
                } else {
                    const query = parts.slice(1).join(' ').toLowerCase();
                    const foundIndex = state.reservations.findIndex(r => {
                        const s = `${r.date || ''} ${r.time || ''}`.trim().toLowerCase();
                        return s === query;
                    });
                    if (foundIndex >= 0) idx = foundIndex;
                }
            }
            if (Number.isNaN(idx) || idx < 0 || idx >= state.reservations.length) {
                reply = 'Bitte Nummer oder "Datum Uhrzeit" angeben, z.B.: "Stornieren 1" oder "Stornieren 2026-03-10 19:30".';
            } else {
                pendingCancellations[from] = { index: idx };
                const r = state.reservations[idx];
                reply = `Reservierung für ${r.date || ''} ${r.time || ''} stornieren? Antworte mit "Ja" oder "Nein".`;
                state.step = 24;
            }
        }
    }
    else if (['alle reservierungen stornieren', 'reservierungen löschen', 'alle reservierungen löschen'].includes(cmd)) {
        if (!state.reservations || state.reservations.length === 0) {
            reply = 'Du hast keine Reservierungen.';
        } else {
            pendingCancellations[from] = { index: -1 };
            reply = `Alle ${state.reservations.length} Reservierungen löschen? Antworte mit "Ja" oder "Nein".`;
            state.step = 24;
        }
    }
    else if ((cmd.startsWith('verschieben') || cmd.startsWith('umbuchen')) && state.step === 0) {
        const list = (state.reservations && state.reservations.length)
            ? state.reservations.map((r, idx) => `${idx + 1}. ${r.date || ''} ${r.time || ''}`.trim()).join('\n')
            : '';
        if (!state.reservations || state.reservations.length === 0) {
            reply = 'Keine Reservierungen zum Verschieben.';
        } else {
            const full = (incomingMsg || '').trim();
            const parts = full.split(/\s+/);
            let idx = NaN;
            if (parts.length > 1) {
                const query = parts.slice(1).join(' ').toLowerCase();
                const foundIndex = state.reservations.findIndex(r => {
                    const s = `${r.date || ''} ${r.time || ''}`.trim().toLowerCase();
                    return s === query;
                });
                if (foundIndex >= 0) idx = foundIndex;
            }
            if (!Number.isNaN(idx) && idx >= 0 && idx < state.reservations.length) {
                tempReschedules[from] = { index: idx };
                reply = 'Neues Datum? (z.B. 2026-03-15)';
                state.step = 22;
            } else {
                reply = `Welche Nummer möchtest du verschieben?\n${list}\nBeispiel: "Verschieben 2" oder "Verschieben 2026-03-10 19:30".`;
                state.step = 21;
                tempReschedules[from] = {};
            }
        }
    } else if (state.step === 21) {
        const n = parseInt((incomingMsg || '').trim(), 10);
        if (!state.reservations || Number.isNaN(n) || n < 1 || n > state.reservations.length) {
            reply = 'Bitte eine gültige Nummer senden.';
        } else {
            tempReschedules[from] = { index: n - 1 };
            reply = 'Neues Datum? (z.B. 2026-03-15)';
            state.step = 22;
        }
    } else if (state.step === 22) {
        if (!tempReschedules[from] || tempReschedules[from].index === undefined) {
            reply = 'Vorgang abgebrochen.';
            state.step = 0;
        } else {
            tempReschedules[from].newDate = incomingMsg || '';
            reply = 'Neue Uhrzeit? (z.B. 18:30)';
            state.step = 23;
        }
    } else if (state.step === 23) {
        if (!tempReschedules[from] || tempReschedules[from].index === undefined) {
            reply = 'Vorgang abgebrochen.';
            state.step = 0;
        } else {
            tempReschedules[from].newTime = incomingMsg || '';
            const idx = tempReschedules[from].index!;
            const current = state.reservations && state.reservations[idx];
            const newDate = tempReschedules[from].newDate || '';
            const newTime = tempReschedules[from].newTime || '';
            if (!current) {
                reply = 'Vorgang abgebrochen.';
                state.step = 0;
                delete tempReschedules[from];
            } else {
                if (!timeWithinBusinessHours(newDate, newTime)) {
                    reply = `Uhrzeit nur zwischen ${String(OPEN_HOUR).padStart(2,'0')}:00 und ${String(CLOSE_HOUR).padStart(2,'0')}:00 möglich. Bitte neue Uhrzeit senden.`;
                    state.step = 22;
                } else {
                    reply = `Reservierung #${idx + 1} von ${current.date || ''} ${current.time || ''} auf ${newDate} ${newTime} verschieben? Antworte mit "Ja" oder "Nein".`;
                    state.step = 25;
                }
            }
        }
    } else if (state.step === 24) {
        const yes = ['ja'];
        const no = ['nein'];
        if (yes.includes(cmd)) {
            const pending = pendingCancellations[from];
            if (!pending || !state.reservations) {
                reply = 'Vorgang abgebrochen.';
            } else if (pending.index < 0) {
                const count = state.reservations.length;
                state.reservations = [];
                reply = count ? `Alle ${count} Reservierungen wurden storniert.` : 'Du hast keine Reservierungen.';
                rebuildReservationTimersForUser(from);
            } else if (pending.index >= state.reservations.length) {
                reply = 'Vorgang abgebrochen.';
            } else {
                const removed = state.reservations.splice(pending.index, 1)[0];
                reply = `Reservierung für ${removed.date || ''} ${removed.time || ''} ist storniert.`;
                rebuildReservationTimersForUser(from);
            }
            delete pendingCancellations[from];
            state.step = 0;
        } else if (no.includes(cmd)) {
            delete pendingCancellations[from];
            reply = 'Stornierung abgebrochen.';
            state.step = 0;
        } else {
            reply = 'Bitte mit "Ja" oder "Nein" antworten.';
        }
    } else if (state.step === 25) {
        const yes = ['ja'];
        const no = ['nein'];
        if (yes.includes(cmd)) {
            const data = tempReschedules[from];
            if (!data || data.index === undefined || !state.reservations || data.index < 0 || data.index >= state.reservations.length) {
                reply = 'Vorgang abgebrochen.';
            } else {
                const newDate = data.newDate || '';
                const newTime = data.newTime || '';
                const current = state.reservations[data.index] as any;
                const guests = current?.guests || 1;
                const tables = allocateTables(newDate, newTime, guests);
                if (!tables) {
                    reply = 'Für diese Uhrzeit sind nicht genug Plätze frei. Bitte wähle eine andere Zeit.';
                } else {
                    const updated: any = { date: newDate, time: newTime, guests };
                    if (tables.length === 1) updated.table = tables[0]; else updated.tables = tables;
                    state.reservations[data.index] = updated;
                    reply = `Reservierung #${data.index + 1} verschoben auf ${newDate} um ${newTime}.`;
                    rebuildReservationTimersForUser(from);
                }
            }
            delete tempReschedules[from];
            state.step = 0;
            state.reservation = {};
        } else if (no.includes(cmd)) {
            delete tempReschedules[from];
            reply = 'Verschiebung abgebrochen.';
            state.step = 0;
            state.reservation = {};
        } else {
            reply = 'Bitte mit "Ja" oder "Nein" antworten.';
        }
    }

    else if ((['bestellen'].includes(cmd)) && state.step === 0) {
        state.order = { items: [] };
        reply = 'Gerne! Sende Gerichte wie:\n"2x Margherita Pizza" oder "Tiramisu".\nSchreibe "Fertig", wenn du fertig bist.';
        state.step = 10;
    } else if (state.step >= 10 && !['fertig', 'nein'].includes(cmd)) {
        const parsed = parseOrderLine(incomingMsg!);
        const found = findMenuItemByName(parsed.name);
        if (!found) {
            reply = 'Gericht nicht gefunden. Schreibe "Menü" für die Liste.';
        } else {
            state.order.items.push({ name: found.name, quantity: Math.max(1, parsed.quantity) });
            let upsell = '';
            const drinks = ['Cola 0,33l', 'Wasser still 0,5l', 'Hauswein (Glas)'];
            const desserts = ['Tiramisu'];
            const isDrink = drinks.some(n => n.toLowerCase() === found.name.toLowerCase());
            const isDessert = desserts.some(n => n.toLowerCase() === found.name.toLowerCase());
            if (!isDrink) {
                const suggestDrinks = drinks.join(', ');
                upsell += `\nPassendes Getränk: ${suggestDrinks}.`;
            }
            if (!isDessert) {
                const suggestDesserts = desserts.join(', ');
                upsell += `\nDessert-Vorschlag: ${suggestDesserts}.`;
            }
            reply = `Hinzugefügt: ${Math.max(1, parsed.quantity)}x ${found.name}.${upsell}\nNoch etwas? Sonst "Fertig" schreiben.`;
        }
        state.step = 10;
    } else if (state.step >= 10 && ['fertig', 'nein'].includes(cmd)) {
        reply = finalizeOrder(from, state.order.items);
        state.step = 0;
        state.order = { items: [] };
    }

    else if (cmd === 'bestellungen' || cmd === 'meine bestellungen' || cmd === 'bestellhistorie') {
        const userOrders = (orderHistory || []).filter(o => o.phone === from).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        if (!userOrders.length) {
            reply = 'Du hast noch keine Bestellungen.';
        } else {
            const list = userOrders.slice(0, 5).map((o, idx) => {
                const itemsText = (o.items || []).map(i => `${Math.max(1, i.quantity || 0)}x ${i.name}`).join(', ');
                return `${idx + 1}. ${itemsText} – €${o.amount.toFixed(2)}`;
            }).join('\n');
            reply = `Deine letzten Bestellungen:\n${list}\n\nZum Wiederholen: "Wiederholen 1", "Wiederholen 2" usw.`;
        }
    }
    else if (cmd.startsWith('wiederholen') && state.step === 0) {
        const full = (incomingMsg || '').trim();
        const parts = full.split(/\s+/);
        const userOrders = (orderHistory || []).filter(o => o.phone === from).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        if (!userOrders.length) {
            reply = 'Du hast noch keine Bestellungen zum Wiederholen.';
        } else {
            let idx = NaN;
            if (parts.length > 1) {
                const maybeNumber = parseInt(parts[1], 10);
                if (!Number.isNaN(maybeNumber)) idx = maybeNumber - 1;
            }
            if (Number.isNaN(idx) || idx < 0 || idx >= userOrders.length) {
                const list = userOrders.slice(0, 5).map((o, i) => {
                    const itemsText = (o.items || []).map(it => `${Math.max(1, it.quantity || 0)}x ${it.name}`).join(', ');
                    return `${i + 1}. ${itemsText} – €${o.amount.toFixed(2)}`;
                }).join('\n');
                reply = `Bitte eine Nummer aus der Liste wählen.\nDeine letzten Bestellungen:\n${list}\n\nBeispiel: "Wiederholen 1".`;
            } else {
                const chosen = userOrders[idx];
                const r = finalizeOrder(from, chosen.items || []);
                reply = `Bestellung wiederholt.\n${r}`;
                state.step = 0;
                state.order = { items: [] };
            }
        }
    }

    else if (cmd.startsWith('feedback') || cmd.startsWith('bewertung') || cmd.startsWith('rezension')) {
        reply = 'Danke für dein Feedback! Wir schauen es uns an.';
        if (client && restaurantWhatsAppTo && incomingMsg) {
            client.messages.create({
                from: fromWhatsApp,
                to: restaurantWhatsAppTo,
                body: `Feedback von ${from} (${profileName || 'ohne Profilname'}):\n${incomingMsg}`
            }).catch((err: any) => console.error(err));
        }
    }

    else {
        const who = profileName || from;
        reply = `Hallo ${who} 🌸\nich bin Liubov.\nWas möchtest du machen?\n- "Reservierung" – Tisch reservieren\n- "Bestellen" – Essen bestellen\n- "Stornieren" – Reservierung stornieren\n- "Verschieben" – Reservierung verschieben\n- "Bestellungen" – frühere Bestellungen\n- "Menü" – Speisekarte`;
    }


    if (client) {
        client.messages
            .create({
                from: fromWhatsApp,
                to: from,
                body: reply
            })
            .then((message: any) => console.log('Antwort gesendet, SID:', message.sid))
            .catch((err: any) => console.error(err));
    } else {
        console.warn('Reply not sent via Twilio: client not configured. Reply would be:', reply);
    }

    saveStateSync();
    res.sendStatus(200);
});

function adminAuthorized(req: express.Request) {
    const t = process.env.ADMIN_TOKEN;
    if (!t) return true;
    const h = req.get('authorization') || '';
    if (h.startsWith('Bearer ') && h.slice(7) === t) return true;
    const q = (req.query.token as string) || '';
    if (q && q === t) return true;
    return false;
}

app.get('/admin/api/state', (req, res) => {
    if (!adminAuthorized(req)) return res.status(401).send('Unauthorized');
    const users = Object.keys(userStates).map(phone => {
        const u = userStates[phone];
        return { phone, step: u.step, reservation: u.reservation || {}, reservations: u.reservations || [], order: u.order || { items: [] } };
    });
    const payments = Object.keys(pendingPayments).map(phone => {
        return { phone, amount: pendingPayments[phone].amount };
    });
    res.json({ users, payments });
});

app.get('/admin', (req, res) => {
    if (!adminAuthorized(req)) return res.status(401).send('Unauthorized');
    const users = Object.keys(userStates);
    const statsOrders = orderHistory || [];
    const dishMap: { [name: string]: { name: string; quantity: number; revenue: number } } = {};
    const customerMap: { [phone: string]: { phone: string; orders: number; items: number; amount: number; lastItems?: string; lastAt?: string } } = {};
    let totalOrders = 0;
    let totalRevenue = 0;
    for (const o of statsOrders) {
        totalOrders++;
        totalRevenue += o.amount || 0;
        const items = o.items || [];
        let itemCount = 0;
        for (const it of items) {
            const q = Math.max(1, it.quantity || 0);
            itemCount += q;
            if (!dishMap[it.name]) {
                dishMap[it.name] = { name: it.name, quantity: 0, revenue: 0 };
            }
            dishMap[it.name].quantity += q;
            const price = menu.find(m => m.name === it.name)?.price || 0;
            dishMap[it.name].revenue += price * q;
        }
        if (!customerMap[o.phone]) {
            customerMap[o.phone] = { phone: o.phone, orders: 0, items: 0, amount: 0, lastItems: undefined, lastAt: undefined };
        }
        customerMap[o.phone].orders += 1;
        customerMap[o.phone].items += itemCount;
        customerMap[o.phone].amount += o.amount || 0;
        const createdAt = o.createdAt || '';
        const itemsSummary = items.map(it => `${Math.max(1, it.quantity || 0)}x ${it.name}`).join(', ');
        if (!customerMap[o.phone].lastAt || (createdAt && createdAt > (customerMap[o.phone].lastAt || ''))) {
            customerMap[o.phone].lastAt = createdAt;
            customerMap[o.phone].lastItems = itemsSummary;
        }
    }
    const dishStats = Object.values(dishMap).sort((a, b) => b.quantity - a.quantity).slice(0, 50);
    const customerStats = Object.values(customerMap).sort((a, b) => b.amount - a.amount);
    let html = '<!doctype html><html><head><meta charset="utf-8"><title>Admin</title><style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;background:#020617;color:#e5e7eb}a{color:#38bdf8}h1{font-size:24px;margin:0 0 12px}h2{font-size:18px;margin:0 0 12px}table{border-collapse:collapse;width:100%;margin-bottom:12px;font-size:13px;background:#020617}th,td{border:1px solid #1f2937;padding:6px 8px;vertical-align:top}th{background:#0f172a;text-align:left;font-weight:600;position:sticky;top:0;z-index:1}tr:nth-child(even){background:#020617}tr:nth-child(odd){background:#020617}input,button,select{margin-right:8px;padding:6px 8px;border-radius:6px;border:1px solid #1f2937;background:#020617;color:#e5e7eb}input::placeholder{color:#6b7280}button{background:#22c55e;border-color:#16a34a;cursor:pointer;font-weight:500}button:hover{background:#16a34a}label{margin-left:12px;font-size:13px;color:#9ca3af}.row{margin:12px 0;display:flex;flex-wrap:wrap;align-items:center;gap:8px}.container{max-width:1200px;margin:0 auto;padding:24px}.tag{display:inline-block;padding:2px 8px;border-radius:999px;background:#0f172a;border:1px solid #1f2937;font-size:11px;color:#9ca3af;margin-left:8px}.card{background:#020617;border-radius:12px;border:1px solid #1f2937;padding:16px 18px;margin-bottom:20px;box-shadow:0 10px 25px rgba(15,23,42,0.5)}.subtle{font-size:13px;color:#9ca3af;margin-bottom:4px}.pill{display:inline-block;padding:2px 10px;border-radius:999px;background:#0f172a;border:1px solid #1f2937;font-size:11px;margin-right:6px}</style></head><body><div class="container">';
    html += '<h1>Restaurant Bot Admin<span class="tag">Live</span></h1>';
    html += `<p class="subtle">Aktive Nutzer: ${users.length}</p>`;
    html += '<div class="card"><div class="row"><input id="filter" placeholder="Filter by phone"><button id="refresh">Refresh</button><label><input type="checkbox" id="auto"> Auto refresh</label><span class="pill">CSV: <a href="/admin/export/users.csv">Users</a> · <a href="/admin/export/payments.csv">Payments</a> · <a href="/admin/export/orders.csv">Orders</a> · <a href="/admin/export/order-items.csv">Order Items</a></span></div>';
    html += '<div class="row"><input id="settle-phone" placeholder="whatsapp:+491234..."><input id="amount" type="number" step="0.01" placeholder="Betrag"><button id="btn-update-amount">Betrag ändern</button><button id="btn-notify-restaurant">Restaurant benachrichtigen</button><button id="btn-settle">Zahlung schließen</button><button id="btn-remind">Zahlung erinnern</button><button id="btn-reset">Benutzer zurücksetzen</button><button id="btn-clear">Zustand löschen</button></div></div>';
    html += '<div class="card"><h2>User States</h2>';
    html += '<table id="users"><tr><th>Phone</th><th>VIP</th><th>Step</th><th>Reservations</th><th>Letzte Bestellung</th><th>Bestellungen</th><th>Umsatz</th></tr>';
    for (const phone of users) {
        const u = userStates[phone];
        const rs = (u.reservations || []).map((r:any, i:number) => {
            const t = Array.isArray(r.tables) && r.tables.length ? ` (Tische ${r.tables.join(', ')})` : (r.table ? ' (Tisch '+r.table+')' : '');
            const g = r.guests ? ` für ${r.guests}` : '';
            return `${i+1}. ${(r.date||'')} ${(r.time||'')}${t}${g}`.trim();
        }).join('<br>');
        const currentItems = (u.order?.items || []).map(i => `${i.quantity}x ${i.name}`).join(', ');
        const stats = customerMap[phone];
        const lastItems = stats && stats.lastItems ? stats.lastItems : currentItems;
        const ordersCount = stats ? stats.orders : 0;
        const ordersAmount = stats ? stats.amount : 0;
        const vipChecked = u.vip ? ' checked' : '';
        html += `<tr><td class="phone">${phone}</td><td><input type="checkbox" class="vip-toggle"${vipChecked} data-phone="${phone}"></td><td>${u.step}</td><td>${rs || '-'}</td><td>${lastItems || '-'}</td><td>${ordersCount}</td><td>€${ordersAmount.toFixed(2)}</td></tr>`;
    }
    html += '</table></div>';
    html += '<div class="card"><h2>Pending Payments</h2>';
    html += '<table id="payments"><tr><th>Phone</th><th>Amount</th></tr>';
    for (const phone of Object.keys(pendingPayments)) {
        const p = pendingPayments[phone];
        html += `<tr><td>${phone}</td><td>${p.amount}</td></tr>`;
    }
    html += '</table></div>';
    html += '<div class="card"><h2>Bestell-Reports</h2>';
    html += `<p class="subtle">Gesamtbestellungen: ${totalOrders}, Gesamtumsatz: €${totalRevenue.toFixed(2)}</p>`;
    html += '<h2>Beliebteste Gerichte</h2>';
    html += '<table><tr><th>Gericht</th><th>Anzahl</th><th>Umsatz</th></tr>';
    if (dishStats.length) {
        for (const d of dishStats) {
            html += `<tr><td>${d.name}</td><td>${d.quantity}</td><td>€${d.revenue.toFixed(2)}</td></tr>`;
        }
    } else {
        html += '<tr><td colspan="3">Noch keine Bestellungen.</td></tr>';
    }
    html += '</table>';
    html += '<h2>Kunden</h2>';
    html += '<table><tr><th>Kunde</th><th>Bestellungen</th><th>Artikel</th><th>Umsatz</th></tr>';
    if (customerStats.length) {
        for (const c of customerStats) {
            html += `<tr><td>${c.phone}</td><td>${c.orders}</td><td>${c.items}</td><td>€${c.amount.toFixed(2)}</td></tr>`;
        }
    } else {
        html += '<tr><td colspan="4">Noch keine Bestellungen.</td></tr>';
    }
    html += '</table></div>';
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const today = `${yyyy}-${mm}-${dd}`;
    html += '<div class="card"><h2>Tables heute</h2>';
    html += '<table id="tables"><tr><th>Table</th><th>Reservierungen heute</th></tr>';
    for (let t = 1; t <= TABLE_COUNT; t++) {
        const entries: string[] = [];
        for (const phone of Object.keys(userStates)) {
            const u = userStates[phone];
            (u.reservations || []).forEach((r:any) => {
                const has = Array.isArray(r.tables) ? r.tables.includes(t) : r.table === t;
                if (r.date === today && has) {
                    const g = r.guests ? ` (${r.guests})` : '';
                    entries.push(`${r.time || ''}${g} – ${phone}`);
                }
            });
        }
        const cell = entries.length ? entries.join('<br>') : '-';
        html += `<tr><td>${t}</td><td>${cell}</td></tr>`;
    }
    html += '</table></div>';
    html += '<div class="card"><h2>Tables: Slot auswählen</h2>';
    html += '<div class="row"><input id="slot-date" type="date"><input id="slot-time" type="time" step="1800"><button id="btn-slot">Belegung anzeigen</button></div>';
    html += '<table id="tables-slot"><tr><th>Table</th><th>Belegung</th></tr></table></div>';
    html += '<p class="subtle">API: <a href="/admin/api/state">/admin/api/state</a></p>';
    html += '<script>const f=document.getElementById("filter");const t=()=>{const v=(f.value||"").toLowerCase();for(const r of document.querySelectorAll("#users tr")){const c=r.querySelector(".phone");if(!c) continue;const m=c.textContent.toLowerCase().includes(v);r.style.display=m?"":"none";}};f.addEventListener("input",t);document.getElementById("refresh").addEventListener("click",()=>location.reload());const a=document.getElementById("auto");let iv=null;a.addEventListener("change",()=>{if(a.checked){iv=setInterval(()=>location.reload(),5000);}else{if(iv) clearInterval(iv);iv=null;}});const qs=new URLSearchParams(location.search);const tok=qs.get(\"token\");function api(u,opt){const url=new URL(u,location.origin);if(tok) url.searchParams.set(\"token\",tok);return fetch(url.toString(),Object.assign({method:\"POST\"},opt||{}));}function val(){const p=document.getElementById(\"settle-phone\").value.trim();if(!p){alert(\"Bitte Telefonnummer im Format whatsapp:+... eingeben\");return null;}return p;}document.getElementById(\"btn-clear\").addEventListener(\"click\",()=>{if(!confirm(\"Alle Zustände und Zahlungen wirklich löschen?\")) return;api(\"/admin/api/clear-state\").then(()=>location.reload()).catch(()=>alert(\"Fehler\"));});document.getElementById(\"btn-settle\").addEventListener(\"click\",()=>{const p=val();if(!p) return;api(\"/admin/api/payments/settle?phone=\"+encodeURIComponent(p)).then(()=>location.reload()).catch(()=>alert(\"Fehler\"));});document.getElementById(\"btn-reset\").addEventListener(\"click\",()=>{const p=val();if(!p) return;if(!confirm(\"Benutzer wirklich zurücksetzen?\")) return;api(\"/admin/api/users/reset?phone=\"+encodeURIComponent(p)).then(()=>location.reload()).catch(()=>alert(\"Fehler\"));});document.getElementById(\"btn-remind\").addEventListener(\"click\",()=>{const p=val();if(!p) return;api(\"/admin/api/payments/remind?phone=\"+encodeURIComponent(p)).then(()=>alert(\"Erinnerung gesendet (falls Twilio konfiguriert ist)\"))});document.getElementById(\"btn-update-amount\").addEventListener(\"click\",()=>{const p=val();if(!p) return;const amt=document.getElementById(\"amount\").value;api(\"/admin/api/payments/update?phone=\"+encodeURIComponent(p)+\"&amount=\"+encodeURIComponent(amt)).then(()=>location.reload()).catch(()=>alert(\"Fehler\"));});document.getElementById(\"btn-notify-restaurant\").addEventListener(\"click\",()=>{const p=val();if(!p) return;api(\"/admin/api/restaurant/notify?phone=\"+encodeURIComponent(p)).then(()=>alert(\"Benachrichtigung gesendet (falls Twilio und Restaurantnummer konfiguriert sind)\"));});</script>';
    html += '<script>(function(){var btn=document.getElementById(\"btn-slot\");if(!btn)return;btn.addEventListener(\"click\",function(){var d=document.getElementById(\"slot-date\").value;var tm=document.getElementById(\"slot-time\").value;if(!d||!tm){alert(\"Bitte Datum und Uhrzeit auswählen\");return;}var url=new URL(\"/admin/api/tables\",location.origin);var qs=new URLSearchParams(location.search);var tok=qs.get(\"token\");if(tok) url.searchParams.set(\"token\",tok);url.searchParams.set(\"date\",d);url.searchParams.set(\"time\",tm);fetch(url.toString()).then(function(r){return r.json()}).then(function(data){var tbl=document.getElementById(\"tables-slot\");tbl.innerHTML=\"<tr><th>Table</th><th>Belegung</th></tr>\";for(var t=1;t<=data.tableCount;t++){var arr=(data.entries&&data.entries[t])||[];var entries=arr.map(function(e){return (e.time||\"\")+(e.guests?\" (\"+e.guests+\")\":\"\")+\" – \"+e.phone;}).join(\"<br>\")||\"-\";var tr=document.createElement(\"tr\");tr.innerHTML=\"<td>\"+t+\"</td><td>\"+entries+\"</td>\";tbl.appendChild(tr);}}).catch(function(){alert(\"Fehler beim Laden\")});});})();</script>';
    html += '<script>(function(){var els=document.querySelectorAll(\".vip-toggle\");for(var i=0;i<els.length;i++){(function(el){el.addEventListener(\"change\",function(){var phone=el.getAttribute(\"data-phone\");if(!phone)return;var vip=el.checked?\"true\":\"false\";var url=\"/admin/api/users/vip?phone=\"+encodeURIComponent(phone)+\"&vip=\"+vip;fetch(url,{method:\"POST\"}).then(function(r){if(!r.ok)throw new Error();}).catch(function(){alert(\"Fehler beim Speichern\");el.checked=!el.checked;});});})(els[i]);}})();</script>';
    html += '</body></html>';
    res.type('html').send(html);
});

app.get('/admin/api/tables', (req, res) => {
    if (!adminAuthorized(req)) return res.status(401).send('Unauthorized');
    const date = String(req.query.date || '').trim();
    const time = String(req.query.time || '').trim();
    if (!date || !time) return res.status(400).json({ error: 'date and time required' });
    const entries: { [k: number]: Array<{ phone: string; time: string; guests?: number }> } = {};
    for (let t = 1; t <= TABLE_COUNT; t++) entries[t] = [];
    for (const phone of Object.keys(userStates)) {
        const u = userStates[phone];
        (u.reservations || []).forEach((r: any) => {
            if (r.date === date && r.time === time) {
                if (Array.isArray(r.tables) && r.tables.length) {
                    for (const t of r.tables) {
                        if (!entries[t]) entries[t] = [];
                        entries[t].push({ phone, time: r.time, guests: r.guests });
                    }
                } else if (typeof r.table === 'number') {
                    const t = r.table;
                    if (!entries[t]) entries[t] = [];
                    entries[t].push({ phone, time: r.time, guests: r.guests });
                }
            }
        });
    }
    res.json({ tableCount: TABLE_COUNT, entries });
});

app.post('/admin/api/clear-state', (req, res) => {
    if (!adminAuthorized(req)) return res.status(401).send('Unauthorized');
    for (const k of Object.keys(pendingPayments)) {
        const t = pendingPayments[k].timeoutId;
        if (t) clearTimeout(t);
    }
    for (const k of Object.keys(userStates)) {
        delete userStates[k];
    }
    for (const k of Object.keys(pendingPayments)) {
        delete pendingPayments[k];
    }
    saveStateSync();
    res.json({ ok: true });
});

app.post('/admin/api/payments/settle', (req, res) => {
    if (!adminAuthorized(req)) return res.status(401).send('Unauthorized');
    const phone = String(req.query.phone || '').trim();
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const entry = pendingPayments[phone];
    if (entry?.timeoutId) clearTimeout(entry.timeoutId);
    if (pendingPayments[phone]) delete pendingPayments[phone];
    saveStateSync();
    res.json({ ok: true });
});

app.post('/admin/api/users/reset', (req, res) => {
    if (!adminAuthorized(req)) return res.status(401).send('Unauthorized');
    const phone = String(req.query.phone || '').trim();
    if (!phone) return res.status(400).json({ error: 'phone required' });
    if (userStates[phone]) delete userStates[phone];
    if (pendingPayments[phone]) {
        const t = pendingPayments[phone].timeoutId;
        if (t) clearTimeout(t);
        delete pendingPayments[phone];
    }
    saveStateSync();
    res.json({ ok: true });
});

app.post('/admin/api/users/vip', (req, res) => {
    if (!adminAuthorized(req)) return res.status(401).send('Unauthorized');
    const phone = String(req.query.phone || '').trim();
    const vipStr = String(req.query.vip || '').trim().toLowerCase();
    if (!phone) return res.status(400).json({ error: 'phone required' });
    if (!userStates[phone]) {
        userStates[phone] = { step: 0, reservation: {}, order: { items: [] } };
    }
    const val = vipStr === 'true' || vipStr === '1' || vipStr === 'yes';
    (userStates as any)[phone].vip = val;
    saveStateSync();
    res.json({ ok: true, vip: val });
});

app.post('/admin/api/payments/remind', async (req, res) => {
    if (!adminAuthorized(req)) return res.status(401).send('Unauthorized');
    const phone = String(req.query.phone || '').trim();
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const pp = pendingPayments[phone];
    if (!pp) return res.status(404).json({ error: 'no pending payment' });
    const amount = pp.amount;
    const paymentLink = `https://meinezahlungsseite.com/pay?amount=${amount}&user=${encodeURIComponent(phone)}`;
    if (!client) {
        console.warn('Manual payment reminder skipped: Twilio client not configured.');
        return res.json({ ok: false, message: 'twilio not configured', paymentLink });
    }
    try {
        const r = await client.messages.create({
            from: fromWhatsApp,
            to: phone,
            body: `Erinnerung: Zahlung von €${amount} steht noch aus. Link: ${paymentLink}`
        });
        res.json({ ok: true, sid: r.sid });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'send failed' });
    }
});

app.post('/admin/api/payments/update', (req, res) => {
    if (!adminAuthorized(req)) return res.status(401).send('Unauthorized');
    const phone = String(req.query.phone || '').trim();
    const amountStr = String(req.query.amount || '').trim();
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const pp = pendingPayments[phone];
    if (!pp) return res.status(404).json({ error: 'no pending payment' });
    const val = Number(amountStr);
    if (!isFinite(val)) return res.status(400).json({ error: 'invalid amount' });
    pp.amount = Math.max(0, Math.round(val * 100) / 100);
    saveStateSync();
    res.json({ ok: true, amount: pp.amount });
});

app.post('/admin/api/restaurant/notify', async (req, res) => {
    if (!adminAuthorized(req)) return res.status(401).send('Unauthorized');
    const phone = String(req.query.phone || '').trim();
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const pp = pendingPayments[phone];
    if (!pp) return res.status(404).json({ error: 'no pending payment' });
    if (!client || !restaurantWhatsAppTo) {
        console.warn('Restaurant notify skipped: client or restaurant number not configured.');
        return res.json({ ok: false, message: 'not configured' });
    }
    const items = pp.items || [];
    const orderSummary = items.map(i => `${i.quantity}x ${i.name}`).join('\n');
    try {
        const r = await client.messages.create({
            from: fromWhatsApp,
            to: restaurantWhatsAppTo,
            body: `Erneute Benachrichtigung von ${phone}:\n${orderSummary}\nGesamt: €${pp.amount}`
        });
        res.json({ ok: true, sid: r.sid });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'send failed' });
    }
});
app.get('/admin/export/orders.csv', (req, res) => {
    if (!adminAuthorized(req)) return res.status(401).send('Unauthorized');
    const rows = ['phone,created_at,amount,items'];
    for (const o of orderHistory) {
        const items = (o.items || []).map(i => `${i.quantity}x ${i.name}`).join('; ');
        const esc = (s: any) => (`"${String(s || '').replace(/"/g, '""')}"`);
        rows.push([esc(o.phone), esc(o.createdAt), o.amount, esc(items)].join(','));
    }
    res.type('text/csv').send(rows.join('\n'));
});

app.get('/admin/export/order-items.csv', (req, res) => {
    if (!adminAuthorized(req)) return res.status(401).send('Unauthorized');
    const rows = ['phone,created_at,item,quantity,amount'];
    for (const o of orderHistory) {
        const esc = (s: any) => (`"${String(s || '').replace(/"/g, '""')}"`);
        const items = o.items || [];
        for (const it of items) {
            const q = Math.max(1, it.quantity || 0);
            const lineAmount = (menu.find(m => m.name === it.name)?.price || 0) * q;
            rows.push([esc(o.phone), esc(o.createdAt), esc(it.name), q, lineAmount].join(','));
        }
    }
    res.type('text/csv').send(rows.join('\n'));
});
app.get('/admin/export/users.csv', (req, res) => {
    if (!adminAuthorized(req)) return res.status(401).send('Unauthorized');
    const rows = ['phone,step,reservations,items'];
    for (const phone of Object.keys(userStates)) {
        const u = userStates[phone];
        const rs = (u.reservations || []).map((r:any,i:number)=>`${i+1}. ${(r.date||'')} ${(r.time||'')}${(Array.isArray(r.tables)&&r.tables.length)?' (Tische '+r.tables.join(', ')+')':(r.table?' (Tisch '+r.table+')':'')}${r.guests?' für '+r.guests:''}`.trim()).join(' | ');
        const items = (u.order?.items || []).map((i:any) => `${i.quantity}x ${i.name}`).join('; ');
        const esc = (s: any) => (`"${String(s||'').replace(/"/g,'""')}"`);
        rows.push([esc(phone), u.step, esc(rs), esc(items)].join(','));
    }
    res.type('text/csv').send(rows.join('\n'));
});

app.get('/admin/export/payments.csv', (req, res) => {
    if (!adminAuthorized(req)) return res.status(401).send('Unauthorized');
    const rows = ['phone,amount'];
    for (const phone of Object.keys(pendingPayments)) {
        const p = pendingPayments[phone];
        const esc = (s: any) => (`"${String(s||'').replace(/"/g,'""')}"`);
        rows.push([esc(phone), p.amount].join(','));
    }
    res.type('text/csv').send(rows.join('\n'));
});
export default app;
