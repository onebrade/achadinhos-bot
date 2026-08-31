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

// ===============================
// MERCADO LIVRE - TOP 10 PRODUTOS
// 4 Eletrônicos + 3 Casa + 3 Beleza
// ===============================

function formatarPreco(valor) {
  if (valor === null || valor === undefined) return null;

  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(valor);
}

async function mlFetch(url) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${mlAccessToken}`
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Erro Mercado Livre ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}


// Descobre automaticamente uma categoria adequada
async function descobrirCategoria(termo) {
  const url =
    `https://api.mercadolibre.com/sites/MLB/domain_discovery/search` +
    `?limit=1&q=${encodeURIComponent(termo)}`;

  const resultado = await mlFetch(url);

  if (!Array.isArray(resultado) || resultado.length === 0) {
    throw new Error(`Categoria não encontrada para: ${termo}`);
  }

  return {
    id: resultado[0].category_id,
    nome: resultado[0].category_name
  };
}


// Busca ranking dos mais vendidos
async function buscarHighlights(categoryId) {
  const url =
    `https://api.mercadolibre.com/highlights/MLB/category/${categoryId}`;

  const resultado = await mlFetch(url);

  return resultado.content || [];
}


// Busca detalhes de um ITEM
async function buscarItem(itemId) {
  const item = await mlFetch(
    `https://api.mercadolibre.com/items/${itemId}`
  );

  let precoAtual = item.price;
  let precoAnterior = item.original_price;

  // Tenta consultar o endpoint atual de preços
  try {
    const precos = await mlFetch(
      `https://api.mercadolibre.com/items/${itemId}/prices`
    );

    const lista = precos.prices || [];

    const promocao = lista.find(
      p => p.type === "promotion"
    );

    const standard = lista.find(
      p => p.type === "standard"
    );

    if (promocao) {
      precoAtual = promocao.amount;

      if (promocao.regular_amount) {
        precoAnterior = promocao.regular_amount;
      } else if (standard) {
        precoAnterior = standard.amount;
      }
    } else if (standard) {
      precoAtual = standard.amount;
    }

  } catch (erro) {
    console.log(
      `Não consegui consultar /prices para ${itemId}. Usando preço do item.`
    );
  }

  let desconto = null;

  if (
    precoAnterior &&
    precoAtual &&
    precoAnterior > precoAtual
  ) {
    desconto = Math.round(
      ((precoAnterior - precoAtual) / precoAnterior) * 100
    );
  }

  return {
    id: item.id,
    titulo: item.title,
    preco: precoAtual,
    precoFormatado: formatarPreco(precoAtual),
    precoAnterior: precoAnterior,
    precoAnteriorFormatado:
      precoAnterior ? formatarPreco(precoAnterior) : null,
    desconto: desconto,
    link: item.permalink,
    tipo: "ITEM"
  };
}


// Tenta transformar resultado PRODUCT em um item comprável
async function buscarProdutoCatalogo(productId) {
  try {
    const produto = await mlFetch(
      `https://api.mercadolibre.com/products/${productId}`
    );

    // Algumas respostas de produto trazem referência de item
    const itemId =
      produto.buy_box_winner?.item_id ||
      produto.buy_box_winner?.id ||
      produto.item_id;

    if (itemId) {
      return await buscarItem(itemId);
    }

    return null;

  } catch (erro) {
    console.log(
      `Não consegui transformar PRODUCT ${productId} em ITEM.`
    );

    return null;
  }
}


// Tenta transformar USER_PRODUCT em um item do vendedor
async function buscarUserProduct(userProductId) {
  try {
    const userProduct = await mlFetch(
      `https://api.mercadolibre.com/user-products/${userProductId}`
    );

    // Nem todo User Product entrega um item diretamente.
    // Se não houver item, ignoramos neste primeiro teste.
    const itemId =
      userProduct.item_id ||
      userProduct.item?.id;

    if (itemId) {
      return await buscarItem(itemId);
    }

    return null;

  } catch (erro) {
    console.log(
      `Não consegui transformar USER_PRODUCT ${userProductId} em ITEM.`
    );

    return null;
  }
}


// Converte resultado do ranking em produto com preço/link
async function processarHighlight(highlight) {
  try {

    if (highlight.type === "ITEM") {
      return await buscarItem(highlight.id);
    }

    if (highlight.type === "PRODUCT") {
      return await buscarProdutoCatalogo(highlight.id);
    }

    if (highlight.type === "USER_PRODUCT") {
      return await buscarUserProduct(highlight.id);
    }

    return null;

  } catch (erro) {
    console.error(
      `Erro ao processar ${highlight.id}:`,
      erro.message
    );

    return null;
  }
}


// Busca 1 produto válido para cada termo
async function buscarUserProduct(userProductId) {
  try {
    // 1. Consulta o User Product
    const userProduct = await mlFetch(
      `https://api.mercadolibre.com/user-products/${userProductId}`
    );

    const sellerId = userProduct.user_id;

    if (!sellerId) {
      console.log(`USER_PRODUCT ${userProductId} sem user_id`);
      return null;
    }

    // 2. Busca os anúncios associados a esse User Product
    const busca = await mlFetch(
      `https://api.mercadolibre.com/users/${sellerId}/items/search?user_product_id=${userProductId}`
    );

    if (
      !busca.results ||
      !Array.isArray(busca.results) ||
      busca.results.length === 0
    ) {
      console.log(
        `Nenhum ITEM encontrado para USER_PRODUCT ${userProductId}`
      );
      return null;
    }

    // 3. Usa o primeiro anúncio associado
    const itemId = busca.results[0];

    return await buscarItem(itemId);

  } catch (erro) {
    console.log(
      `Erro ao transformar USER_PRODUCT ${userProductId}:`,
      erro.message
    );

    return null;
  }
}

async function buscarProdutoPorTermo(termo, grupo) {
  try {
    const categoria = await descobrirCategoria(termo);

    console.log(
      `Busca "${termo}" -> categoria ${categoria.nome} (${categoria.id})`
    );

    const ranking = await buscarHighlights(categoria.id);

    console.log(
      `Ranking "${termo}": ${ranking.length} resultados`
    );

    for (const highlight of ranking) {
      const produto = await processarHighlight(highlight);

      if (produto) {
        return {
          ...produto,
          grupo: grupo,
          busca: termo,
          categoria: categoria.nome,
          posicaoRanking: highlight.position
        };
      }
    }

    console.log(`Nenhum produto válido encontrado para "${termo}"`);
    return null;

  } catch (erro) {
    console.error(
      `Erro em buscarProdutoPorTermo("${termo}"):`,
      erro.message
    );

    throw erro;
  }
}

app.get("/ml/top10", async (req, res) => {

  try {

    if (!mlAccessToken) {
      return res.status(401).json({
        success: false,
        error:
          "Mercado Livre não está autenticado. Abra /ml/login novamente."
      });
    }


    const pesquisas = [

      // 4 ELETRÔNICOS
      {
        termo: "fone bluetooth",
        grupo: "Eletrônicos"
      },
      {
        termo: "smartphone",
        grupo: "Eletrônicos"
      },
      {
        termo: "smartwatch",
        grupo: "Eletrônicos"
      },
      {
        termo: "caixa de som bluetooth",
        grupo: "Eletrônicos"
      },


      // 3 CASA E COZINHA
      {
        termo: "air fryer",
        grupo: "Casa e Cozinha"
      },
      {
        termo: "jogo de panelas",
        grupo: "Casa e Cozinha"
      },
      {
        termo: "aspirador de pó",
        grupo: "Casa e Cozinha"
      },


      // 3 BELEZA
      {
        termo: "kit maquiagem",
        grupo: "Beleza"
      },
      {
        termo: "secador de cabelo",
        grupo: "Beleza"
      },
      {
        termo: "perfume feminino",
        grupo: "Beleza"
      }

    ];


    const produtos = [];

    const idsUsados = new Set();


    for (const pesquisa of pesquisas) {

      try {

        const produto = await buscarProdutoPorTermo(
          pesquisa.termo,
          pesquisa.grupo
        );

        if (
          produto &&
          !idsUsados.has(produto.id)
        ) {

          idsUsados.add(produto.id);

          produtos.push(produto);
        }

      } catch (erro) {

        console.error(
          `Erro na busca "${pesquisa.termo}":`,
          erro.message
        );
      }

      // pequeno intervalo para não disparar tudo de uma vez
      await sleep(250);
    }

    res.json({
      success: true,
      total: produtos.length,
      divisao: {
        eletronicos: 4,
        casaECozinha: 3,
        beleza: 3
      },
      aviso:
        "Os links abaixo são links normais do Mercado Livre. Ainda vamos adicionar a conversão para seu link de afiliado.",
      produtos: produtos.map((produto, index) => ({
        numero: index + 1,
        grupo: produto.grupo,
        categoria: produto.categoria,
        produto: produto.titulo,
        preco: produto.precoFormatado,
        precoAnterior:
          produto.precoAnteriorFormatado,
        desconto:
          produto.desconto !== null
            ? `${produto.desconto}%`
            : "Sem desconto identificado",
        link: produto.link,
        ranking:
          produto.posicaoRanking
      }))
    });


  } catch (erro) {

    console.error(
      "Erro no /ml/top10:",
      erro
    );

    res.status(500).json({
      success: false,
      error: erro.message
    });
  }
});

// TESTE DA CONEXÃO COM A API DO MERCADO LIVRE
app.get("/ml/test", async (req, res) => {
  try {
    if (!mlAccessToken) {
      return res.status(401).json({
        success: false,
        error: "Mercado Livre ainda não está autenticado."
      });
    }

    const response = await fetch(
      "https://api.mercadolibre.com/users/me",
      {
        headers: {
          Authorization: `Bearer ${mlAccessToken}`
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        mercadoLivre: data
      });
    }

    res.json({
      success: true,
      message: "API do Mercado Livre funcionando!",
      user: {
        id: data.id,
        nickname: data.nickname,
        country_id: data.country_id
      }
    });

  } catch (error) {
    console.error("Erro no teste Mercado Livre:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
