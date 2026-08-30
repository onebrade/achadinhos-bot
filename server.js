const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ==========================
// VARIÁVEIS DE AMBIENTE
// ==========================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL;

const ML_CLIENT_ID = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const ML_REDIRECT_URI = process.env.ML_REDIRECT_URI;

// Tokens temporários do Mercado Livre
// Depois vamos salvar isso de forma persistente.
let mlAccessToken = null;
let mlRefreshToken = null;

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

    throw new Error(
      data.description || "Erro ao enviar mensagem para o Telegram."
    );
  }

  return data;
}

// ==========================
// MERCADO LIVRE - OAUTH
// ==========================

// Inicia a autorização do Mercado Livre
app.get("/ml/login", (req, res) => {
  if (!ML_CLIENT_ID) {
    return res.status(500).json({
      success: false,
      error: "ML_CLIENT_ID não configurado no Render.",
    });
  }

  if (!ML_REDIRECT_URI) {
    return res.status(500).json({
      success: false,
      error: "ML_REDIRECT_URI não configurado no Render.",
    });
  }

  const authUrl =
    `https://auth.mercadolivre.com.br/authorization` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(ML_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(ML_REDIRECT_URI)}`;

  return res.redirect(authUrl);
});

// Recebe o retorno do Mercado Livre
app.get("/callback", async (req, res) => {
  try {
    const { code, error, error_description } = req.query;

    if (error) {
      console.error("AUTORIZAÇÃO ML NEGADA:", {
        error,
        error_description,
      });

      return res.status(400).send(`
        <h1>❌ Autorização não concluída</h1>
        <p>${error_description || error}</p>
      `);
    }

    if (!code) {
      return res.status(400).send(`
        <h1>❌ Erro</h1>
        <p>Código de autorização não recebido.</p>
      `);
    }

    if (!ML_CLIENT_ID || !ML_CLIENT_SECRET || !ML_REDIRECT_URI) {
      return res.status(500).json({
        success: false,
        error:
          "As credenciais do Mercado Livre não estão completamente configuradas.",
      });
    }

    const response = await fetch(
      "https://api.mercadolibre.com/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: ML_CLIENT_ID,
          client_secret: ML_CLIENT_SECRET,
          code: code,
          redirect_uri: ML_REDIRECT_URI,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("ERRO OAUTH MERCADO LIVRE:", data);

      return res.status(response.status).json({
        success: false,
        error: "Erro ao obter token do Mercado Livre.",
        details: data,
      });
    }

    mlAccessToken = data.access_token;
    mlRefreshToken = data.refresh_token;

    console.log("✅ Mercado Livre autenticado com sucesso.");

    if (data.user_id) {
      console.log(`Usuário Mercado Livre: ${data.user_id}`);
    }

    return res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
        <head>
          <meta charset="UTF-8">
          <title>Achadinhos Bot</title>
        </head>

        <body
          style="
            background:#111;
            color:#fff;
            font-family:Arial,sans-serif;
            text-align:center;
            padding-top:80px;
          "
        >
          <h1>✅ Mercado Livre conectado!</h1>

          <p>
            O Achadinhos Bot foi autorizado com sucesso.
          </p>

          <p>
            Agora podemos começar a consultar a API do Mercado Livre.
          </p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("ERRO CALLBACK ML:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Verifica se o Mercado Livre está autenticado
app.get("/ml/status", (req, res) => {
  return res.json({
    success: true,
    authenticated: Boolean(mlAccessToken),
    hasRefreshToken: Boolean(mlRefreshToken),
  });
});

// ==========================
// ROTAS GERAIS
// ==========================

// Verifica se o serviço está online
app.get("/health", (req, res) => {
  return res.json({
    status: "ok",
    service: "Achadinhos Bot",
    mercadoLivreConfigured: Boolean(
      ML_CLIENT_ID &&
      ML_CLIENT_SECRET &&
      ML_REDIRECT_URI
    ),
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

// ==========================
// TESTE DE PRODUTO
// ==========================

// Testa apenas o primeiro produto
app.post("/test-product", async (req, res) => {
  try {
    const produtos = carregarProdutos();

    if (!Array.isArray(produtos) || !produtos.length) {
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

// ==========================
// PUBLICAÇÃO DOS PRODUTOS
// ==========================

// Publica todos os produtos da lista
app.post("/publish-products", async (req, res) => {
  try {
    const produtos = carregarProdutos();

    if (!Array.isArray(produtos) || !produtos.length) {
      return res.status(400).json({
        success: false,
        error: "Nenhum produto encontrado em produto.json.",
      });
    }

    res.json({
      success: true,
      message: `Publicação iniciada. ${produtos.length} produtos serão enviados.`,
      intervalo: "3 minutos",
    });

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
          `✅ Produto ${i + 1}/${produtos.length} enviado: ${produto.titulo}`
        );
      } catch (error) {
        console.error(
          `❌ Erro ao publicar produto ${i + 1}:`,
          error.message
        );
      }

      if (i < produtos.length - 1) {
        await sleep(3 * 60 * 1000);
      }
    }

    console.log("✅ Todos os produtos foram processados.");
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
// ROTA INICIAL
// ==========================

app.get("/", (req, res) => {
  return res.json({
    service: "Achadinhos Bot",
    status: "online",
    routes: {
      health: "/health",
      mercadoLivreLogin: "/ml/login",
      mercadoLivreStatus: "/ml/status",
    },
  });
});

// ==========================
// INICIAR SERVIDOR
// ==========================

app.listen(PORT, () => {
  console.log(`🚀 Achadinhos Bot rodando na porta ${PORT}`);
});
