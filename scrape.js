import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const SHOPEE_URL = 'https://shopee.vn/';
const OUTPUT_FILE = 'products.json';
const DEBUG_URLS_FILE = 'debug-responses.json';
const DEBUG_BODIES_FILE = 'debug-api-bodies.json';

const MAX_PRODUCTS = Number(process.env.MAX_PRODUCTS || 60);
const WAIT_MS = Number(process.env.RESPONSE_WAIT_MS || 20000);

const CASHBACK_BASE =
  process.env.CASHBACK_BASE ||
  'https://hoantien360.com/?url_hoan_tien=';

const products = new Map();
const debugUrls = [];
const debugBodies = [];

function first(...values) {
  return values.find(
    (value) => value !== undefined && value !== null && value !== ''
  );
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return 0;

  if (Array.isArray(value)) return toNumber(value[0]);

  if (typeof value === 'object') {
    return toNumber(
      first(value.value, value.amount, value.price, value.min)
    );
  }

  const number = Number(String(value).replace(/[^\d.-]/g, ''));

  return Number.isFinite(number) ? number : 0;
}

function normalizePrice(value) {
  let number = toNumber(value);

  if (!number) return 0;

  if (number >= 10_000_000) {
    number /= 100_000;
  }

  return Math.round(number);
}

function normalizeImage(value) {
  if (!value) return '';

  if (typeof value === 'object') {
    value = first(
      value.url,
      value.image_url,
      value.image,
      value.image_id,
      value.thumbnail
    );
  }

  const image = String(value || '').trim();

  if (!image) return '';

  if (/^https?:\/\//i.test(image)) return image;

  return `https://down-vn.img.susercontent.com/file/${image.replace(/^\/+/, '')}`;
}

function addCandidate(node, source) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;

  const itemId = toNumber(
    first(
      node.itemid,
      node.item_id,
      node.itemId,
      node.product_id,
      node.productId
    )
  );

  const shopId = toNumber(
    first(
      node.shopid,
      node.shop_id,
      node.shopId,
      node.seller_id,
      node.sellerId
    )
  );

  const name = String(
    first(
      node.name,
      node.item_name,
      node.title,
      node.product_name,
      node.productName
    ) || ''
  )
    .replace(/\s+/g, ' ')
    .trim();

  const image = normalizeImage(
    first(
      node.image,
      node.image_url,
      node.imageUrl,
      node.thumbnail,
      node.cover,
      node.cover_image
    )
  );

  if (!itemId || !shopId || !name || !image) return;

  const salePrice = normalizePrice(
    first(
      node.flash_sale_price,
      node.price,
      node.price_min,
      node.current_price,
      node.sale_price,
      node.promo_price
    )
  );

  const originalPrice = normalizePrice(
    first(
      node.price_before_discount,
      node.price_min_before_discount,
      node.original_price,
      node.price_original
    )
  );

  let discount = toNumber(
    first(
      node.raw_discount,
      node.show_discount,
      node.discount,
      node.discount_percent
    )
  );

  if (
    !discount &&
    originalPrice > salePrice &&
    salePrice > 0
  ) {
    discount = Math.round(
      ((originalPrice - salePrice) / originalPrice) * 100
    );
  }

  const sold = toNumber(
    first(
      node.historical_sold,
      node.sold,
      node.sold_count,
      node.items_sold
    )
  );

  const reviews = toNumber(
    first(
      node.rating_count,
      node.review_count,
      node.cmt_count,
      node.item_rating?.rating_count
    )
  );

  const productUrl = `https://shopee.vn/product/${shopId}/${itemId}`;

  products.set(productUrl, {
    position: 0,
    item_id: itemId,
    shop_id: shopId,
    name,
    original_price: originalPrice || '',
    sale_price: salePrice || '',
    discount: discount ? `${Math.round(discount)}%` : '',
    sold: sold || '',
    reviews: reviews || '',
    image,
    product_url: productUrl,
    cashback_url: CASHBACK_BASE + encodeURIComponent(productUrl),
    source,
    updated_at: new Date().toISOString()
  });
}

function walk(value, source, depth = 0) {
  if (value === null || value === undefined || depth > 60) return;

  if (Array.isArray(value)) {
    for (const item of value) walk(item, source, depth + 1);
    return;
  }

  if (typeof value === 'object') {
    addCandidate(value, source);

    for (const child of Object.values(value)) {
      walk(child, source, depth + 1);
    }
  }
}

async function writeJson(path, value) {
  await fs.writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

async function loadOldProducts() {
  try {
    const parsed = JSON.parse(await fs.readFile(OUTPUT_FILE, 'utf8'));
    return Array.isArray(parsed.products) ? parsed.products : [];
  } catch {
    return [];
  }
}

async function main() {
  const oldProducts = await loadOldProducts();
  const pendingTasks = [];

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox'
    ]
  });

  const context = await browser.newContext({
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    viewport: { width: 1440, height: 1200 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/131.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });

  const page = await context.newPage();

  page.on('response', (response) => {
    const task = (async () => {
      const url = response.url();

      if (!url.includes('shopee.vn/api/')) return;

      const interesting =
        url.includes('/homepage/get_daily_discover') ||
        url.includes('/recommend/recommend') ||
        url.includes('/flash_sale/flash_sale_get_items') ||
        url.includes('/homepage/campaign_modules') ||
        url.includes('/homepage/mall_shops');

      if (!interesting) return;

      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('application/json')) return;

      try {
        const body = await response.json();

        let source = 'homepage_api';

        if (url.includes('get_daily_discover')) source = 'daily_discover';
        if (url.includes('flash_sale_get_items')) source = 'flash_sale';
        if (url.includes('recommend/recommend')) source = 'top_products';

        debugUrls.push({
          status: response.status(),
          url,
          source,
          captured_at: new Date().toISOString()
        });

        debugBodies.push({
          status: response.status(),
          url,
          source,
          body
        });

        walk(body, source);

        console.log(
          `Đã bắt ${source}: hiện có ${products.size} sản phẩm`
        );
      } catch (error) {
        debugUrls.push({
          status: response.status(),
          url,
          error: error.message,
          captured_at: new Date().toISOString()
        });
      }
    })();

    pendingTasks.push(task);
  });

  try {
    const navigation = await page.goto(SHOPEE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    console.log(`Trang chủ trả HTTP ${navigation?.status() || 'không rõ'}`);

    const startedAt = Date.now();

    while (
      Date.now() - startedAt < WAIT_MS &&
      products.size < MAX_PRODUCTS
    ) {
      await page.waitForTimeout(1000);
      console.log(`Đang chờ API: ${products.size}/${MAX_PRODUCTS} sản phẩm`);
    }

    // Chờ tất cả callback response xử lý xong rồi mới ghi file.
    await Promise.allSettled(pendingTasks);
  } finally {
    await Promise.allSettled(pendingTasks);

    await writeJson(DEBUG_URLS_FILE, debugUrls);
    await writeJson(DEBUG_BODIES_FILE, debugBodies);

    await browser.close();
  }

  const result = [...products.values()]
    .slice(0, MAX_PRODUCTS)
    .map((product, index) => ({
      ...product,
      position: index + 1
    }));

  if (!result.length) {
    console.error(
      `Không parse được sản phẩm. Đã lưu body API vào ${DEBUG_BODIES_FILE}.`
    );

    if (!oldProducts.length) {
      throw new Error(
        `Chưa có products.json cũ. Tải artifact và gửi ${DEBUG_BODIES_FILE}.`
      );
    }

    return;
  }

  await writeJson(OUTPUT_FILE, {
    success: true,
    source: SHOPEE_URL,
    source_type: 'shopee_homepage_api',
    count: result.length,
    updated_at: new Date().toISOString(),
    products: result
  });

  console.log(`Hoàn tất: đã lưu ${result.length} sản phẩm.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
