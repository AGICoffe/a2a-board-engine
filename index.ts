export interface Env {
  AI: any;
  VECTORIZE: VectorizeIndex;
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 1. 看板の投稿 (POST /api/board)
    if (request.method === "POST" && url.pathname === "/api/board") {
      return handlePostBoard(request, env);
    }

    // 2. マッチング照合 (POST /api/match)
    if (request.method === "POST" && url.pathname === "/api/match") {
      return handleMatchBoard(request, env);
    }

    return new Response("Not Found", { status: 404 });
  }
};

// --- 看板の登録処理 ---
async function handlePostBoard(request: Request, env: Env): Promise<Response> {
  const paymentHeader = request.headers.get("X-PAYMENT");
  
  // 0.15円 (402 Payment Required) チェック
  if (!paymentHeader) {
    return new Response(JSON.stringify({
      error: "Payment Required",
      amount_usdc: 0.001, // 約0.15円
      message: "0.15 yen 24h deposit required to post a board."
    }), {
      status: 402,
      headers: { "Content-Type": "application/json" }
    });
  }

  const data = await request.json() as any;
  const boardId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + (24 * 60 * 60); // 24時間後のTTL

  // A. ドメインと意図から「検索用プレーンテキスト」を合成
  const searchText = `[${data.domain}] ${data.identity} ${data.intent_space.target} Synonyms: ${data.intent_space.acceptable_synonyms?.join(" ")} NOT: ${data.intent_space.negative_keywords?.join(" ")}`;

  // B. Cloudflare Workers AI でベクトル化 (384次元)
  const embeddings = await env.AI.run("@cf/baai/bge-small-en-v1.5", {
    text: [searchText]
  });
  const vector = embeddings.data[0];

  // C. Vectorize DB にベクトルとメタデータを登録
  await env.VECTORIZE.insert([{
    id: boardId,
    values: vector,
    metadata: {
      domain: data.domain,
      price_min: data.intent_space.price_range_usdc[0],
      price_max: data.intent_space.price_range_usdc[1],
      expires_at: expiresAt
    }
  }]);

  // D. D1 に構造化データの本体を登録
  await env.DB.prepare(`
    INSERT INTO boards (id, domain, identity, price_min, price_max, raw_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    boardId,
    data.domain,
    data.identity,
    data.intent_space.price_range_usdc[0],
    data.intent_space.price_range_usdc[1],
    JSON.stringify(data),
    now,
    expiresAt
  ).run();

  return new Response(JSON.stringify({
    success: true,
    board_id: boardId,
    expires_at: expiresAt,
    status: "BOARD_ACTIVE_24H"
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// --- 高速ゼロトークン・マッチング照合処理 ---
async function handleMatchBoard(request: Request, env: Env): Promise<Response> {
  const myBoard = await request.json() as any;
  const now = Math.floor(Date.now() / 1000);

  // A. 照合元テキストからベクトルを生成
  const searchText = `[${myBoard.domain}] ${myBoard.identity} ${myBoard.intent_space.target}`;
  const embeddings = await env.AI.run("@cf/baai/bge-small-en-v1.5", {
    text: [searchText]
  });
  const myVector = embeddings.data[0];

  // B. Vectorize で類似度検索 (コサイン類似度 Top 10)
  const matches = await env.VECTORIZE.query(myVector, {
    topK: 10,
    returnMetadata: true
  });

  const myPriceMin = myBoard.intent_space.price_range_usdc[0];
  const myPriceMax = myBoard.intent_space.price_range_usdc[1];
  const threshold = myBoard.similarity_threshold || 0.75; // デフォルト類似度許容値

  // C. 類似度 ＋ 24時間有効期限 ＋ 価格帯交差 (Overlap) をフィルタリング
  const validCandidates = matches.matches.filter((m: any) => {
    const meta = m.metadata;
    const isSimilar = m.score >= threshold;
    const isNotExpired = meta.expires_at > now;
    const isDomainMatch = meta.domain === myBoard.domain;
    
    // 価格帯の交差判定 (Overlap = Max(MinA, MinB) <= Min(MaxA, MaxB))
    const priceOverlap = Math.max(myPriceMin, meta.price_min) <= Math.min(myPriceMax, meta.price_max);

    return isSimilar && isNotExpired && isDomainMatch && priceOverlap;
  });

  // 交差判定ゼロなら即時弾く（ゼロトークン拒絶）
  if (validCandidates.length === 0) {
    return new Response(JSON.stringify({
      status: "NO_MATCH",
      message: "No active board crossed the constraint space. 0 tokens wasted."
    }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  // D. 最も適合した1件を取得して D1 から看板詳細を取得
  const bestMatch = validCandidates[0];
  const targetBoard = await env.DB.prepare(`SELECT * FROM boards WHERE id = ?`).bind(bestMatch.id).first();

  return new Response(JSON.stringify({
    status: "MATCH_SUCCESS",
    similarity_score: bestMatch.score,
    target_board: JSON.parse(targetBoard.raw_json as string),
    handshake_signal: {
      action: "PROCEED_TO_A2A_FEP_CONSENSUS",
      endpoint: "https://your-mcp-server.com/a2a-fep-consensus"
    }
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}