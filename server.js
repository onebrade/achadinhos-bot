const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL;

// Verifica se o servidor está funcionando
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Achadinhos Bot"
  });
});

// Envia uma mensagem para o Telegram
app.post("/send", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: "Mensagem não fornecida."
      });
    }

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL) {
      return res.status(500).json({
        success: false,
        error: "Telegram não configurado no servidor."
      });
    }

    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHANNEL,
          text: message
        })
      }
    );

   if (!data.ok) {
  console.error("ERRO TELEGRAM:", data);

  return res.status(500).json({
    success: false,
    error: data.description
  });
}

    return res.json({
      success: true,
      message: "Mensagem enviada com sucesso!"
    });

 } catch (error) {
  console.error("ERRO INTERNO:", error);

  return res.status(500).json({
    success: false,
    error: error.message
  });
}
});

app.listen(PORT, () => {
  console.log(`Achadinhos Bot rodando na porta ${PORT}`);
});
