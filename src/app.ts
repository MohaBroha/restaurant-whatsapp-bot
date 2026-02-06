import express from 'express';
import twilio from 'twilio';
import { menu } from './menu';

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));


app.get('/', (req, res) => {
    res.send('Restaurant Bot API läuft 🍽️');
});


const accountSid = 'AC1bccfa131112f3c92ee4178e99242e31';
const authToken = 'eb2a7e001b187e7fffc35c64f009dd85';
const client = twilio(accountSid, authToken);


const userStates: {
    [phone: string]: {
        step: number,
        reservation?: { date?: string; time?: string },
        order?: { items: { name: string; quantity: number; notes?: string }[] }
    }
} = {};

const pendingPayments: {
    [phone: string]: { amount: number; timeoutId?: NodeJS.Timeout }
} = {};


function calculateOrderTotal(items: { name: string; quantity: number }[]) {
    return items.reduce((sum, i) => {
        const menuItem = menu.find(m => m.name === i.name);
        return sum + (menuItem?.price || 0) * i.quantity;
    }, 0);
}

app.post('/webhook', (req, res) => {
    const incomingMsg = req.body.Body?.trim();
    const from = req.body.From;

    console.log('Nachricht empfangen:', incomingMsg, 'von', from);

    if (!userStates[from]) {
        userStates[from] = { step: 0, reservation: {}, order: { items: [] } };
    }

    const state = userStates[from];

    if (!state.reservation) state.reservation = {};
    if (!state.order) state.order = { items: [] };

    let reply = '';


    if (incomingMsg?.toLowerCase() === 'menü') {
        let menuText = 'Hier ist unser Menü 🍽️:\n\n';
        menu.forEach(item => {
            menuText += `${item.name} – €${item.price}\n`;
        });
        reply = menuText;
    }

    else if (incomingMsg?.toLowerCase() === 'reservierung' && state.step === 0) {
        reply = 'Super! Für welches Datum möchtest du reservieren? (z.B. 2026-02-10)';
        state.step = 1;
    } else if (state.step === 1) {
        state.reservation.date = incomingMsg;
        reply = `Perfekt! Um welche Uhrzeit? (z.B. 19:30)`;
        state.step = 2;
    } else if (state.step === 2) {
        state.reservation.time = incomingMsg;
        reply = `Alles klar! Deine Reservierung für ${state.reservation.date} um ${state.reservation.time} wurde notiert 🍽️`;
        state.step = 0;
        state.reservation = {};
    }

    else if (incomingMsg?.toLowerCase() === 'bestellen' && state.step === 0) {
        reply = 'Super! Schreibe den Namen des Gerichts, das du bestellen möchtest.';
        state.step = 10; // Bestellungsstart
    } else if (state.step >= 10 && state.step <= 12) {
        // Bestellung aufnehmen
        state.order.items.push({ name: incomingMsg!, quantity: 1 });
        reply = `Gericht "${incomingMsg}" hinzugefügt. Möchtest du noch etwas bestellen? Schreibe "Fertig" wenn du fertig bist.`;
        state.step = 13; // Warte auf Fertig
    } else if (state.step === 13 && (incomingMsg?.toLowerCase() === 'fertig' || incomingMsg?.toLowerCase() === 'nein')) {
        const orderSummary = state.order.items
            .map(i => `${i.quantity}x ${i.name}${i.notes ? ' (' + i.notes + ')' : ''}`)
            .join('\n');

        const totalAmount = calculateOrderTotal(state.order.items);

        client.messages.create({
            from: 'whatsapp:+14155238886',
            to: 'whatsapp:+49XXXXXXX',
            body: `Neue Bestellung von ${from}:\n${orderSummary}\nGesamt: €${totalAmount}`
        });

        const paymentLink = `https://meinezahlungsseite.com/pay?amount=${totalAmount}&user=${encodeURIComponent(from)}`;

        reply = `Alles klar! Deine Bestellung wurde aufgenommen 🍽️\nBitte bezahle hier: ${paymentLink}`;

        pendingPayments[from] = { amount: totalAmount };
        pendingPayments[from].timeoutId = setTimeout(() => {
            client.messages.create({
                from: 'whatsapp:+14155238886',
                to: from,
                body: `Hallo! Wir haben gesehen, dass die Zahlung von €${totalAmount} für deine Bestellung noch aussteht. Hier ist der Link erneut: ${paymentLink}`
            });
        }, 15 * 60 * 1000); // 15 Minuten

        state.step = 0;
        state.order = { items: [] };
    }

    else {
        reply = 'Hallo, Ich Bin Liubov, deine Ansprechpartnerin! Schreibe "Reservierung" für einen Tisch oder "Bestellen", um zu bestellen. Schreibe "Menü" für unsere Gerichte.';
    }


    client.messages
        .create({
            from: 'whatsapp:+14155238886',
            to: from,
            body: reply
        })
        .then(message => console.log('Antwort gesendet, SID:', message.sid))
        .catch(err => console.error(err));

    res.sendStatus(200);
});

export default app;
