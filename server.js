const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ======================================================
// VARIÁVEIS DE AMBIENTE
// ======================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL;

const ML_CLIENT_ID = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const ML_REDIRECT_URI = process.env.ML_REDIRECT_URI;

// ======================================================
// TOKENS TEMPORÁRIOS DO MERCADO LIVRE
// ======================================================

// Por enquanto ficam na memória.
// Depois vamos implementar refresh token persistente.

let mlAccessToken = null;
let mlRefreshToken = null;

// ======================================================
// FUNÇÕES AUXILIARES
// ======================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatarPreco(valor) {
  if (valor === null || valor === undefined) {
    return null;
  }

  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(valor);
}

function carregarProdutos() {
  const caminho = path.join(__dirname, "produto.json");

  if (!fs.existsSync(caminho)) {
    throw new Error("Arquivo produto.json não encontrado.");
  }

  const conteudo = fs.readFileSync(caminho, "utf8");

  return JSON.parse(conteudo);
}

// ======================================================
// TELEGRAM
// ======================================================

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

// ======================================================
// MERCADO LIVRE - FUNÇÃO DE CONSULTA
// ======================================================

async function mlFetch(url) {
  if (!mlAccessToken) {
    throw new Error(
      "Mercado Livre não autenticado. Abra /ml/login primeiro."
    );
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${mlAccessToken}`,
      Accept: "application/json",
    },
  });

  let data;

  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(
      `Erro Mercado Livre ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

// ======================================================
// MERCADO LIVRE - CATEGORIAS
// ======================================================

async function descobrirCategoria(termo) {
  const url =
    `https://api.mercadolibre.com/sites/MLB/domain_discovery/search` +
    `?limit=1&q=${encodeURIComponent(termo)}`;

  const resultado = await mlFetch(url);

  if (!Array.isArray(resultado) || resultado.length === 0) {
    throw new Error(
      `Categoria não encontrada para "${termo}".`
    );
  }

  return {
    id: resultado[0].category_id,
    nome: resultado[0].category_name,
  };
}

// ======================================================
// MERCADO LIVRE - MAIS VENDIDOS
// ======================================================

async function buscarHighlights(categoryId) {
  const url =
    `https://api.mercadolibre.com/highlights/MLB/category/${categoryId}`;

  const resultado = await mlFetch(url);

  if (!resultado || !Array.isArray(resultado.content)) {
    return [];
  }

  return resultado.content;
}

// ======================================================
// MERCADO LIVRE - DETALHES DO ITEM
// ======================================================

async function buscarItem(itemId) {
  console.log(`Consultando ITEM: ${itemId}`);

  const item = await mlFetch(
    `https://api.mercadolibre.com/items/${itemId}`
  );

  let precoAtual = item.price ?? null;
  let precoAnterior = item.original_price ?? null;

  // ------------------------------------------------------
  // Tenta obter informações adicionais de preço
  // ------------------------------------------------------

  try {
    const precos = await mlFetch(
      `https://api.mercadolibre.com/items/${itemId}/prices`
    );

    const lista = Array.isArray(precos?.prices)
      ? precos.prices
      : [];

    const promocao = lista.find(
      (preco) => preco.type === "promotion"
    );

    const standard = lista.find(
      (preco) => preco.type === "standard"
    );

    if (promocao) {
      precoAtual = promocao.amount ?? precoAtual;

      if (promocao.regular_amount) {
        precoAnterior = promocao.regular_amount;
      } else if (standard?.amount) {
        precoAnterior = standard.amount;
      }
    } else if (standard?.amount) {
      precoAtual = standard.amount;
    }
  } catch (erro) {
    console.log(
      `Não consegui consultar /prices para ${itemId}. ` +
      `Usando os valores do próprio item.`
    );
  }

  // ------------------------------------------------------
  // Calcula desconto
  // ------------------------------------------------------

  let desconto = null;

  if (
    precoAnterior &&
    precoAtual &&
    Number(precoAnterior) > Number(precoAtual)
  ) {
    desconto = Math.round(
      ((Number(precoAnterior) - Number(precoAtual)) /
        Number(precoAnterior)) *
        100
    );
  }

  return {
    id: item.id,
    titulo: item.title || "Produto sem título",

    preco: precoAtual,
    precoFormatado: formatarPreco(precoAtual),

    precoAnterior: precoAnterior,

    precoAnteriorFormatado:
      precoAnterior !== null
        ? formatarPreco(precoAnterior)
        : null,

    desconto,

    link: item.permalink || null,

    tipo: "ITEM",
  };
}

// ======================================================
// MERCADO LIVRE - PRODUCT
// ======================================================

async function buscarProdutoCatalogo(productId) {
  try {
    console.log(`Consultando PRODUCT: ${productId}`);

    // 1. Consulta os detalhes do produto
    const produto = await mlFetch(
      `https://api.mercadolibre.com/products/${productId}`
    );

    // 2. Se houver ganhador da buy box, usa ele
    const itemVencedor =
      produto?.buy_box_winner?.item_id ||
      produto?.buy_box_winner?.id;

    if (itemVencedor) {
      console.log(
        `PRODUCT ${productId} possui BUY BOX ITEM: ${itemVencedor}`
      );

      return await buscarItem(itemVencedor);
    }

    // 3. Se não houver buy_box_winner,
    // busca as ofertas associadas ao produto
    console.log(
      `PRODUCT ${productId} sem buy_box_winner. Buscando /items...`
    );

    const ofertas = await mlFetch(
      `https://api.mercadolibre.com/products/${productId}/items`
    );

    let resultados = [];

    if (Array.isArray(ofertas)) {
      resultados = ofertas;
    } else if (Array.isArray(ofertas?.results)) {
      resultados = ofertas.results;
    }

    if (resultados.length === 0) {
      console.log(
        `PRODUCT ${productId} não possui ofertas disponíveis.`
      );

      return null;
    }

    // 4. Procura um item válido nas primeiras ofertas
    for (const oferta of resultados.slice(0, 10)) {
      const itemId =
        typeof oferta === "string"
          ? oferta
          : oferta?.item_id || oferta?.id;

      if (!itemId) {
        continue;
      }

      try {
        const item = await buscarItem(itemId);

        if (item?.id && item?.link) {
          console.log(
            `✅ PRODUCT ${productId} convertido em ITEM ${item.id}`
          );

          return item;
        }
      } catch (erroItem) {
        console.log(
          `Não consegui usar ITEM ${itemId}: ${erroItem.message}`
        );
      }
    }

    console.log(
      `PRODUCT ${productId} não teve nenhum ITEM válido.`
    );

    return null;

  } catch (erro) {
    console.log(
      `Erro ao transformar PRODUCT ${productId}:`,
      erro.message
    );

    return null;
  }
}

// ======================================================
// MERCADO LIVRE - USER PRODUCT
// ======================================================

async function buscarUserProduct(userProductId) {
  try {
    console.log(
      `Consultando USER_PRODUCT: ${userProductId}`
    );

    const userProduct = await mlFetch(
      `https://api.mercadolibre.com/user-products/${userProductId}`
    );

    // Algumas respostas podem trazer item diretamente.

    const itemDireto =
      userProduct?.item_id ||
      userProduct?.item?.id;

    if (itemDireto) {
      console.log(
        `USER_PRODUCT ${userProductId} possui ITEM direto: ${itemDireto}`
      );

      return await buscarItem(itemDireto);
    }

    // Caso contrário, tentamos descobrir o vendedor.

    const sellerId =
      userProduct?.user_id ||
      userProduct?.seller_id;

    if (!sellerId) {
      console.log(
        `USER_PRODUCT ${userProductId} sem user_id/seller_id.`
      );

      return null;
    }

    const busca = await mlFetch(
      `https://api.mercadolibre.com/users/${sellerId}/items/search` +
      `?user_product_id=${encodeURIComponent(userProductId)}`
    );

    if (
      !Array.isArray(busca?.results) ||
      busca.results.length === 0
    ) {
      console.log(
        `Nenhum ITEM encontrado para USER_PRODUCT ${userProductId}.`
      );

      return null;
    }

    const primeiroResultado = busca.results[0];

    const itemId =
      typeof primeiroResultado === "string"
        ? primeiroResultado
        : primeiroResultado?.id;

    if (!itemId) {
      console.log(
        `Resultado de USER_PRODUCT ${userProductId} sem item_id válido.`
      );

      return null;
    }

    console.log(
      `USER_PRODUCT ${userProductId} convertido em ITEM ${itemId}`
    );

    return await buscarItem(itemId);
  } catch (erro) {
    console.log(
      `Erro ao transformar USER_PRODUCT ${userProductId}:`,
      erro.message
    );

    return null;
  }
}

// ======================================================
// MERCADO LIVRE - PROCESSAR RESULTADO DO RANKING
// ======================================================

async function processarHighlight(highlight) {
  try {
    if (!highlight?.id || !highlight?.type) {
      console.log(
        "Highlight inválido:",
        highlight
      );

      return null;
    }

    console.log(
      `Processando ranking:`,
      highlight.type,
      highlight.id
    );

    if (highlight.type === "ITEM") {
      return await buscarItem(highlight.id);
    }

    if (highlight.type === "PRODUCT") {
      return await buscarProdutoCatalogo(highlight.id);
    }

   if (highlight.type === "USER_PRODUCT") {
  console.log(
    `Ignorando USER_PRODUCT ${highlight.id}: acesso restrito para outros vendedores.`
  );

  return null;
}

    console.log(
      `Tipo desconhecido no ranking: ${highlight.type}`
    );

    return null;
  } catch (erro) {
    console.error(
      `Erro ao processar ${highlight?.id}:`,
      erro.message
    );

    return null;
  }
}

// ======================================================
// MERCADO LIVRE - BUSCAR PRODUTO POR TERMO
// ======================================================

async function buscarProdutoPorTermo(termo, grupo) {
  try {
    console.log("");
    console.log("========================================");
    console.log(`BUSCA: ${termo}`);
    console.log("========================================");

    const categoria = await descobrirCategoria(termo);

    console.log(
      `Categoria encontrada: ${categoria.nome} (${categoria.id})`
    );

    const ranking = await buscarHighlights(
      categoria.id
    );

    console.log(
      `Ranking retornou ${ranking.length} resultados para "${termo}".`
    );

    if (!ranking.length) {
      return null;
    }

    for (const highlight of ranking) {
      const produto =
        await processarHighlight(highlight);

      if (produto?.id) {
        console.log(
          `✅ Produto encontrado para "${termo}": ${produto.titulo}`
        );

        return {
          ...produto,

          grupo,
          busca: termo,

          categoria: categoria.nome,

          posicaoRanking:
            highlight.position ?? null,
        };
      }
    }

    console.log(
      `❌ Nenhum produto válido encontrado para "${termo}".`
    );

    return null;
  } catch (erro) {
    console.error(
      `Erro em buscarProdutoPorTermo("${termo}"):`,
      erro.message
    );

    throw erro;
  }
}

// ======================================================
// ROTA INICIAL
// ======================================================

app.get("/", (req, res) => {
  return res.json({
    service: "Achadinhos Bot",
    status: "online",

    routes: {
      health: "/health",

      mercadoLivreLogin: "/ml/login",
      mercadoLivreStatus: "/ml/status",
      mercadoLivreTest: "/ml/test",
      mercadoLivreTop10: "/ml/top10",

      telegramSend: "/send",
      testProduct: "/test-product",
      publishProducts: "/publish-products",
    },
  });
});

// ======================================================
// HEALTH
// ======================================================

app.get("/health", (req, res) => {
  return res.json({
    status: "ok",

    service: "Achadinhos Bot",

    mercadoLivreConfigured: Boolean(
      ML_CLIENT_ID &&
      ML_CLIENT_SECRET &&
      ML_REDIRECT_URI
    ),

    telegramConfigured: Boolean(
      TELEGRAM_BOT_TOKEN &&
      TELEGRAM_CHANNEL
    ),
  });
});

// ======================================================
// MERCADO LIVRE - LOGIN / OAUTH
// ======================================================

app.get("/ml/login", (req, res) => {
  if (!ML_CLIENT_ID) {
    return res.status(500).json({
      success: false,
      error:
        "ML_CLIENT_ID não configurado no Render.",
    });
  }

  if (!ML_REDIRECT_URI) {
    return res.status(500).json({
      success: false,
      error:
        "ML_REDIRECT_URI não configurado no Render.",
    });
  }

  const authUrl =
    `https://auth.mercadolivre.com.br/authorization` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(ML_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(ML_REDIRECT_URI)}`;

  return res.redirect(authUrl);
});

// ======================================================
// MERCADO LIVRE - CALLBACK
// ======================================================

app.get("/callback", async (req, res) => {
  try {
    const {
      code,
      error,
      error_description,
    } = req.query;

    if (error) {
      console.error(
        "AUTORIZAÇÃO ML NEGADA:",
        error,
        error_description
      );

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

    if (
      !ML_CLIENT_ID ||
      !ML_CLIENT_SECRET ||
      !ML_REDIRECT_URI
    ) {
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
          "Content-Type":
            "application/x-www-form-urlencoded",

          Accept: "application/json",
        },

        body: new URLSearchParams({
          grant_type: "authorization_code",

          client_id: ML_CLIENT_ID,
          client_secret: ML_CLIENT_SECRET,

          code,

          redirect_uri: ML_REDIRECT_URI,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(
        "ERRO OAUTH MERCADO LIVRE:",
        data
      );

      return res.status(response.status).json({
        success: false,

        error:
          "Erro ao obter token do Mercado Livre.",

        details: data,
      });
    }

    mlAccessToken = data.access_token;
    mlRefreshToken = data.refresh_token;

    console.log(
      "✅ Mercado Livre autenticado com sucesso."
    );

    if (data.user_id) {
      console.log(
        `Usuário Mercado Livre: ${data.user_id}`
      );
    }

    return res.send(`
      <!DOCTYPE html>

      <html lang="pt-BR">

        <head>
          <meta charset="UTF-8">

          <title>
            Achadinhos Bot
          </title>
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

          <h1>
            ✅ Mercado Livre conectado!
          </h1>

          <p>
            O Achadinhos Bot foi autorizado com sucesso.
          </p>

          <p>
            Agora você pode testar
            <strong>/ml/test</strong>
            e
            <strong>/ml/top10</strong>.
          </p>

        </body>

      </html>
    `);
  } catch (erro) {
    console.error(
      "ERRO CALLBACK ML:",
      erro
    );

    return res.status(500).json({
      success: false,
      error: erro.message,
    });
  }
});

// ======================================================
// MERCADO LIVRE - STATUS
// ======================================================

app.get("/ml/status", (req, res) => {
  return res.json({
    success: true,

    authenticated:
      Boolean(mlAccessToken),

    hasRefreshToken:
      Boolean(mlRefreshToken),
  });
});

// ======================================================
// MERCADO LIVRE - TESTE DA API
// ======================================================

app.get("/ml/test", async (req, res) => {
  try {
    if (!mlAccessToken) {
      return res.status(401).json({
        success: false,

        error:
          "Mercado Livre ainda não está autenticado. Abra /ml/login.",
      });
    }

    const data = await mlFetch(
      "https://api.mercadolibre.com/users/me"
    );

    return res.json({
      success: true,

      message:
        "API do Mercado Livre funcionando!",

      user: {
        id: data.id,
        nickname: data.nickname,
        country_id: data.country_id,
      },
    });
  } catch (erro) {
    console.error(
      "ERRO /ml/test:",
      erro
    );

    return res.status(500).json({
      success: false,
      error: erro.message,
    });
  }
});

// ======================================================
// MERCADO LIVRE - TOP 10
// ======================================================

app.get("/ml/top10", async (req, res) => {
  try {
    if (!mlAccessToken) {
      return res.status(401).json({
        success: false,

        error:
          "Mercado Livre não está autenticado. Abra /ml/login novamente.",
      });
    }

    const pesquisas = [
      // ----------------------------------------------
      // 4 ELETRÔNICOS
      // ----------------------------------------------

      {
        termo: "fone bluetooth",
        grupo: "Eletrônicos",
      },

      {
        termo: "smartphone",
        grupo: "Eletrônicos",
      },

      {
        termo: "smartwatch",
        grupo: "Eletrônicos",
      },

      {
        termo: "caixa de som bluetooth",
        grupo: "Eletrônicos",
      },

      // ----------------------------------------------
      // 3 CASA E COZINHA
      // ----------------------------------------------

      {
        termo: "air fryer",
        grupo: "Casa e Cozinha",
      },

      {
        termo: "jogo de panelas",
        grupo: "Casa e Cozinha",
      },

      {
        termo: "aspirador de pó",
        grupo: "Casa e Cozinha",
      },

      // ----------------------------------------------
      // 3 BELEZA
      // ----------------------------------------------

      {
        termo: "kit maquiagem",
        grupo: "Beleza",
      },

      {
        termo: "secador de cabelo",
        grupo: "Beleza",
      },

      {
        termo: "perfume feminino",
        grupo: "Beleza",
      },
    ];

    const produtos = [];
    const idsUsados = new Set();

    for (const pesquisa of pesquisas) {
      try {
        const produto =
          await buscarProdutoPorTermo(
            pesquisa.termo,
            pesquisa.grupo
          );

        if (
          produto &&
          produto.id &&
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

      await sleep(250);
    }

    return res.json({
      success: true,

      total: produtos.length,

      divisaoDesejada: {
        eletronicos: 4,
        casaECozinha: 3,
        beleza: 3,
      },

      aviso:
        "Os links abaixo ainda são links normais do Mercado Livre. A integração do link de afiliado será feita na próxima etapa.",

      produtos: produtos.map(
        (produto, index) => ({
          numero: index + 1,

          grupo: produto.grupo,
          categoria: produto.categoria,

          produto: produto.titulo,

          preco:
            produto.precoFormatado,

          precoAnterior:
            produto.precoAnteriorFormatado,

          desconto:
            produto.desconto !== null
              ? `${produto.desconto}%`
              : "Sem desconto identificado",

          link: produto.link,

          ranking:
            produto.posicaoRanking,
        })
      ),
    });
  } catch (erro) {
    console.error(
      "ERRO /ml/top10:",
      erro
    );

    return res.status(500).json({
      success: false,
      error: erro.message,
    });
  }
});

// ======================================================
// TELEGRAM - ENVIO MANUAL
// ======================================================

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
      message:
        "Mensagem enviada com sucesso!",
    });
  } catch (erro) {
    console.error(
      "ERRO /send:",
      erro
    );

    return res.status(500).json({
      success: false,
      error: erro.message,
    });
  }
});

// ======================================================
// TELEGRAM - TESTAR PRIMEIRO PRODUTO DO JSON
// ======================================================

app.post("/test-product", async (req, res) => {
  try {
    const produtos = carregarProdutos();

    if (
      !Array.isArray(produtos) ||
      produtos.length === 0
    ) {
      return res.status(400).json({
        success: false,

        error:
          "Nenhum produto encontrado em produto.json.",
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

      produto:
        produto.titulo,

      message:
        "Produto de teste enviado com sucesso!",
    });
  } catch (erro) {
    console.error(
      "ERRO /test-product:",
      erro
    );

    return res.status(500).json({
      success: false,
      error: erro.message,
    });
  }
});

// ======================================================
// TELEGRAM - PUBLICAR PRODUTOS DO JSON
// ======================================================

app.post(
  "/publish-products",
  async (req, res) => {
    try {
      const produtos =
        carregarProdutos();

      if (
        !Array.isArray(produtos) ||
        produtos.length === 0
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Nenhum produto encontrado em produto.json.",
        });
      }

      res.json({
        success: true,

        message:
          `Publicação iniciada. ${produtos.length} produtos serão enviados.`,

        intervalo:
          "3 minutos",
      });

      for (
        let i = 0;
        i < produtos.length;
        i++
      ) {
        const produto =
          produtos[i];

        const mensagem =
`🔥 ACHADINHO DO MERCADO LIVRE

🛒 ${produto.titulo}

👉 Ver oferta:
${produto.link}

#publi #afiliado`;

        try {
          await enviarTelegram(
            mensagem
          );

          console.log(
            `✅ Produto ${i + 1}/${produtos.length} enviado: ${produto.titulo}`
          );
        } catch (erro) {
          console.error(
            `❌ Erro ao publicar produto ${i + 1}:`,
            erro.message
          );
        }

        if (
          i < produtos.length - 1
        ) {
          await sleep(
            3 * 60 * 1000
          );
        }
      }

      console.log(
        "✅ Todos os produtos foram processados."
      );
    } catch (erro) {
      console.error(
        "ERRO /publish-products:",
        erro
      );

      if (!res.headersSent) {
        return res
          .status(500)
          .json({
            success: false,
            error: erro.message,
          });
      }
    }
  }
);

// ======================================================
// INICIAR SERVIDOR
// TEM QUE SER A ÚLTIMA PARTE DO ARQUIVO
// ======================================================

app.get("/ml/test-item", async (req, res) => {
  try {
    if (!mlAccessToken) {
      return res.status(401).json({
        success: false,
        erro: "Faça login no Mercado Livre primeiro."
      });
    }

    const itemId = "MLB7420274282";

    const response = await fetch(
      `https://api.mercadolibre.com/items?ids=${itemId}&attributes=id,title,price,original_price,permalink,status`,
      {
        headers: {
          Authorization: `Bearer ${mlAccessToken}`,
          Accept: "application/json"
        }
      }
    );

    const data = await response.json();

    res.status(response.status).json({
      httpStatus: response.status,
      resultado: data
    });

  } catch (erro) {
    res.status(500).json({
      success: false,
      erro: erro.message
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `🚀 Achadinhos Bot rodando na porta ${PORT}`
  );
});
