import os
import json
import urllib.parse
import urllib.request
import urllib.error
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
from telegram.ext import ApplicationBuilder, CommandHandler, PreCheckoutQueryHandler, MessageHandler, ContextTypes, filters

BOT_TOKEN  = os.environ.get("BOT_TOKEN", "")
WEBAPP_URL = os.environ.get("WEBAPP_URL", "")
DB_URL     = os.environ.get("DB_URL", "https://spin.ikinciel.az/stars_payment.php")

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    args = context.args
    ref  = args[0] if args else ""
    user = update.effective_user
    if not user:
        return

    sep  = "&" if "?" in WEBAPP_URL else "?"
    name = urllib.parse.quote((user.first_name or "") + " " + (user.last_name or ""))
    url  = WEBAPP_URL + sep + "tg_id=" + str(user.id) + "&tg_name=" + name
    if ref:
        url += "&tg_ref=" + urllib.parse.quote(ref)

    keyboard = [[InlineKeyboardButton("🍾 Oyunu Aç", web_app=WebAppInfo(url=url))]]
    fn = user.first_name or user.username or "Oyuncu"
    await update.message.reply_text(
        f"🍾 *Spin The Bottle*\n\nSalam {fn}\\! Aşağıdakı düyməyə basaraq oyunu açın\\.",
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode="MarkdownV2"
    )

# Ödeme onayı — her zaman kabul et
async def pre_checkout(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.pre_checkout_query
    await query.answer(ok=True)

# Başarılı ödeme — PHP'ye bildir
async def successful_payment(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg     = update.message
    payment = msg.successful_payment
    payload = {}
    try:
        payload = json.loads(payment.invoice_payload)
    except Exception:
        pass

    user_id  = payload.get("user_id", 0)
    hearts   = payload.get("hearts", 0)
    stars    = payload.get("stars", 0)
    charge_id = payment.telegram_payment_charge_id

    if user_id and hearts:
        try:
            data = json.dumps({
                "action": "payment_done",
                "user_id": user_id,
                "hearts": hearts,
                "stars": stars,
                "charge_id": charge_id
            }).encode()
            req = urllib.request.Request(DB_URL, data=data,
                headers={"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(req, timeout=5)
        except Exception as e:
            print("Payment notify error:", e)

    # Kullanıcıya tebrik mesajı
    await msg.reply_text(f"✅ {hearts} ürək hesabınıza əlavə edildi\\! ❤️", parse_mode="MarkdownV2")

if __name__ == "__main__":
    app = ApplicationBuilder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(PreCheckoutQueryHandler(pre_checkout))
    app.add_handler(MessageHandler(filters.SUCCESSFUL_PAYMENT, successful_payment))
    print("Bot işləyir...")
    app.run_polling()
