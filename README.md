# Restaurant WhatsApp Bot

API на Express для WhatsApp-бота ресторана (Twilio).

## Быстрый старт

1. Установка:

```bash
npm install
```

2. Настройте окружение:

Скопируйте файл примера и заполните значения:

```bash
cp .env.example .env
```

Минимум:

- `TWILIO_ACCOUNT_SID` — SID аккаунта Twilio
- `TWILIO_AUTH_TOKEN` — Auth Token
- `TWILIO_WHATSAPP_FROM` — номер отправителя в формате `whatsapp:+1...`
- `RESTAURANT_WHATSAPP_TO` — номер ресторана для уведомлений
- `PORT` — порт API (по умолчанию 3001)
- `PUBLIC_WEBHOOK_URL` — публичный URL вебхука (ngrok), нужен для проверки подписи

3. Запуск dev-сервера:

```bash
npm run dev
```

Сервер поднимется на `http://localhost:3001/`.

## Туннелирование через ngrok

В проекте уже подключён `ngrok`. Откройте туннель к локальному порту 3001:

```bash
npm run tunnel
```

Скопируйте HTTPS-URL из вывода ngrok (например: `https://<domain>.ngrok-free.app`) и укажите его как `PUBLIC_WEBHOOK_URL` c путём `/webhook`, например:

```
PUBLIC_WEBHOOK_URL=https://<domain>.ngrok-free.app/webhook
```

Далее настройте URL вебхука в консоли Twilio (WhatsApp) на этот адрес.

## Маршруты

- `GET /` — проверка доступности
- `POST /webhook` — входящие сообщения из WhatsApp (Twilio). Включена проверка подписи Twilio, если задан `TWILIO_AUTH_TOKEN`.

## Команды бота

- Меню: `menü/menue/menu/меню`
- Бронь: `reservierung/reservation/reserve/бронь/бронирование`
- Заказ: `bestellen/order/заказ`
  - Можно добавлять несколько блюд и их количество, например: `2x Margherita Pizza`, `Tiramisu`, `3 Caesar Salat`
  - Завершение заказа: `Fertig` (также распознаются `nein/ready/готово/готов`)

## Замечания

- Состояния пользователей и ожидания оплаты хранятся в памяти процесса и теряются при перезапуске. Для продакшна используйте внешнее хранилище.
- Креденшелы не должны храниться в репозитории. Используйте `.env`.

