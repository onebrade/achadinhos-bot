const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL;

// ==========================
// FUNÇÕES AUXILIARES
// ==========================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function carregarProdutos() {
  const caminho = path.join(__dirname, "produto.json");

  if (!fs.existsSync(caminho)) {
    throw new Error("Arquivo produto.json não encontrado.");
  }

  const conteudo = fs.readFileSync(caminho, "utf8");
  return JSON.parse(conteudo);
}

async function enviarTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN não configurado.");
  }

  if (!TELEGRAM_CHANNEL) {
    throw new Error("TELEGRAM_CHANNEL não configurado.");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHANNEL,
        text: message,
        disable_web_page_preview: false,
      }),
    }
  );

  const data = await response.json();

  if (!data.ok) {
    console.error("ERRO TELEGRAM:", data);
    throw new Error(data.description || "Erro ao enviar mensagem.");
  }

  return data;
}

// ==========================
// ROTAS
// ==========================

// Verifica se o serviço está online
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Achadinhos Bot",
  });
});

// Envio manual de mensagem
app.post("/send", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: "Mensagem não fornecida.",
      });
    }

    await enviarTelegram(message);

    return res.json({
      success: true,
      message: "Mensagem enviada com sucesso!",
    });
  } catch (error) {
    console.error("ERRO INTERNO:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Testa apenas o primeiro produto
app.post("/test-product", async (req, res) => {
  try {
    const produtos = carregarProdutos();

    if (!produtos.length) {
      return res.status(400).json({
        success: false,
        error: "Nenhum produto encontrado em produto.json.",
      });
    }

    const produto = produtos[0];

    const mensagem =
`🔥 ACHADINHO DO MERCADO LIVRE

🛒 ${produto.titulo}

👉 Ver oferta:
${produto.link}

#publi #afiliado`;

    await enviarTelegram(mensagem);

    return res.json({
      success: true,
      produto: produto.titulo,
      message: "Produto de teste enviado com sucesso!",
    });
  } catch (error) {
    console.error("ERRO TEST PRODUCT:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Publica todos os produtos da lista
app.post("/publish-products", async (req, res) => {
  try {
    const produtos = carregarProdutos();

    if (!produtos.length) {
      return res.status(400).json({
        success: false,
        error: "Nenhum produto encontrado em produto.json.",
      });
    }

    // Responde imediatamente para não deixar a conexão aberta
    res.json({
      success: true,
      message: `Publicação iniciada. ${produtos.length} produtos serão enviados.`,
      intervalo: "3 minutos",
    });

    // Publica em segundo plano
    for (let i = 0; i < produtos.length; i++) {
      const produto = produtos[i];

      const mensagem =
`🔥 ACHADINHO DO MERCADO LIVRE

🛒 ${produto.titulo}

👉 Ver oferta:
${produto.link}

#publi #afiliado`;

      try {
        await enviarTelegram(mensagem);

        console.log(
          `Produto ${i + 1}/${produtos.length} enviado: ${produto.titulo}`
        );
      } catch (error) {
        console.error(
          `Erro ao publicar produto ${i + 1}:`,
          error.message
        );
      }

      // Espera 3 minutos antes do próximo produto
      if (i < produtos.length - 1) {
        await sleep(3 * 60 * 1000);
      }
    }

    console.log("Todos os produtos foram processados.");
  } catch (error) {
    console.error("ERRO PUBLISH PRODUCTS:", error);

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
});

// ==========================
// INICIAR SERVIDOR
// ==========================

app.listen(PORT, () => {
  console.log(`Achadinhos Bot rodando na porta ${PORT}`);
});
