import fs from 'fs';
import path from 'path';

type Reservation = { date?: string; time?: string; table?: number; tables?: number[]; guests?: number };
type OrderItem = { name: string; quantity: number; notes?: string };
type OrderRecord = { phone: string; items: OrderItem[]; amount: number; createdAt: string };
type UserState = {
  step: number;
  reservation?: Reservation;
  reservations?: Reservation[];
  order?: { items: OrderItem[] };
  vip?: boolean;
};

export type AppState = {
  userStates: { [phone: string]: UserState };
  pendingPayments: { [phone: string]: { amount: number; items?: OrderItem[]; timeoutId?: NodeJS.Timeout } };
  orderHistory: OrderRecord[];
};

const defaultState: AppState = {
  userStates: {},
  pendingPayments: {},
  orderHistory: [],
};

export const state: AppState = defaultState;

function getStorePath() {
  const p = process.env.STATE_FILE || path.resolve(process.cwd(), 'data', 'state.json');
  return p;
}

export function loadStateSync() {
  const file = getStorePath();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw) as { userStates?: any; pendingPayments?: any; orderHistory?: any };
      if (data.userStates && typeof data.userStates === 'object') {
        state.userStates = data.userStates;
      }
      if (data.pendingPayments && typeof data.pendingPayments === 'object') {
        state.pendingPayments = data.pendingPayments;
      }
      if (Array.isArray(data.orderHistory)) {
        state.orderHistory = data.orderHistory;
      }
    } else {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    }
  } catch (_) {
  }
}

export function saveStateSync() {
  const file = getStorePath();
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const toSave = { userStates: state.userStates, pendingPayments: mapTimeouts(state.pendingPayments), orderHistory: state.orderHistory };
    fs.writeFileSync(file, JSON.stringify(toSave, null, 2), 'utf8');
  } catch (_) {
  }
}

function mapTimeouts(src: AppState['pendingPayments']) {
  const out: { [k: string]: { amount: number; items?: OrderItem[] } } = {};
  for (const k of Object.keys(src)) {
    out[k] = { amount: src[k].amount, items: src[k].items };
  }
  return out;
}
