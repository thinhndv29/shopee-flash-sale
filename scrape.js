import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const SHOPEE_URL = 'https://shopee.vn/';
const OUTPUT_FILE = 'products.json';
const DEBUG_FILE = 'debug-responses.json';
const RAW_DAILY_FILE = 'daily_discover.json';
const RAW_FLASH_FILE = 'flash_sale.json';

const MAX_PRODUCTS = Number(process.env.MAX_PRODUCTS || 60);
const RESPONSE_WAIT_MS = Number(process.env.RESPONSE_WAIT_MS || 25000);

const CASHBACK_BASE =
  process.env.CASHBACK_BASE ||
  'https://hoantien360.com/?url_hoan_tien=';

const collectedProducts = new Map();
const debugResponses = [];

let dailyDiscoverSaved = false;
let flashSaleSaved = false;

function first(...values) {
  return values.find(
    (value) =>
      value !== undefined &&
      value !== null &&
      value !== ''
  );
}

function toNumber(value) {
  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return 0;
  }

  if (Array.isArray(value)) {
    return toNumber(value[0]);
  }

  if (typeof value === 'object') {
    return toNumber(
      first(
        value.value,
        value.amount,
        value.price,
        value.min
      )
    );
  }

  const normalized = String(value)
    .replace(/[^\d.-]/g, '')
    .trim();

  const number = Number(normalized);

  return Number.isFinite(number) ? number : 0;
}

function normalizeShopeePrice(value) {
  let number = toNumber(value);

  if (!number) return 0;

  /*
   * Shopee API thường trả giá theo đơn vị x100000.
   * Ví dụ: 12900000000 => 129000đ.
   */
  if (number >= 10000000) {
    number /= 100000;
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

  if (/^https?:\/\//i.test(image)) {
    return image;
  }

  return (
    'https://down-vn.img.susercontent.com/file/' +
    image.replace(/^\/+/, '')
  );
}

function createProductUrl(shopId, itemId) {
  return `https://shopee.vn/product/${shopId}/${itemId}`;
}

function extractRatingCount(node) {
  const direct = toNumber(
    first(
      node.rating_count,
      node.review_count,
      node.cmt_count,
      node.comment_count
    )
  );

  if (direct) return direct;

  const itemRating = first(
    node.item_rating,
    node.rating,
    node.rating_info
  );

  if (itemRating && typeof itemRating === 'object') {
    return toNumber(
      first(
        itemRating.rating_count,
        itemRating.review_count,
        itemRating.rating_star,
        itemRating.count
      )
    );
  }

  return 0;
}

function calculateDiscount(originalPrice, salePrice, rawDiscount) {
  const discount = toNumber(rawDiscount);

  if (discount > 0 && discount <= 100) {
    return Math.round(discount);
  }

  if (
    originalPrice > 0 &&
    salePrice > 0 &&
    originalPrice > salePrice
  ) {
    return Math.round(
      ((originalPrice - salePrice) / originalPrice) * 100
    );
  }

  return 0;
}

function productScore(product) {
  return [
    product.sale_price,
    product.original_price,
    product.discount,
    product.sold,
    product.reviews,
    product.rating
  ].filter(Boolean).length;
}

function addProductCandidate(node, source) {
  if (
    !node ||
    typeof node !== 'object' ||
    Array.isArray(node)
  ) {
    return;
  }

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
      node.cover_image,
      node.image_info
    )
  );

  if (!itemId || !shopId || !name || !image) {
    return;
  }

  const salePrice = normalizeShopeePrice(
    first(
      node.flash_sale_price,
      node.price,
      node.price_min,
      node.current_price,
      node.sale_price,
      node.promo_price,
      node.price_info?.current_price
    )
  );

  const originalPrice = normalizeShopeePrice(
    first(
      node.price_before_discount,
      node.price_min_before_discount,
      node.original_price,
      node.price_original,
      node.price_info?.original_price
    )
  );

  const discountValue = calculateDiscount(
    originalPrice,
    salePrice,
    first(
      node.raw_discount,
      node.show_discount,
      node.discount,
      node.discount_percent,
      node.discount_percentage
    )
  );

  const sold = toNumber(
    first(
      node.historical_sold,
      node.sold,
      node.sold_count,
      node.items_sold,
      node.global_sold_count
    )
  );

  const reviews = extractRatingCount(node);

  const rating = toNumber(
    first(
      node.rating_star,
      node.rating,
      node.item_rating?.rating_star,
      node.rating_info?.rating_star
    )
  );

  const productUrl = createProductUrl(shopId, itemId);

  const product = {
    position: 0,
    item_id: itemId,
    shop_id: shopId,
    name,
    original_price: originalPrice || '',
    sale_price: salePrice || '',
    discount: discountValue
      ? `${discountValue}%`
      : '',
    sold: sold || '',
    reviews: reviews || '',
    rating: rating || '',
    image,
    product_url: productUrl,
    cashback_url:
      CASHBACK_BASE + encodeURIComponent(productUrl),
    source,
    updated_at: new Date().toISOString()
  };

  const current = collectedProducts.get(productUrl);

  if (
    !current ||
    productScore(product) > productScore(current)
  ) {
    collectedProducts.set(productUrl, product);
  }
}

function walkJson(value, source, depth = 0) {
  if (
    value === null ||
    value === undefined ||
    depth > 50
  ) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      walkJson(item, source, depth + 1);
    }

    return;
  }

  if (typeof value === 'object') {
    addProductCandidate(value, source);

    for (const child of Object.values(value)) {
      walkJson(child, source, depth + 1);
    }
  }
}

async function saveJson(file, data) {
  await fs.writeFile(
    file,
    JSON.stringify(data, null, 2),
    'utf8'
  );
}

async function loadOldProducts() {
  try {
    const raw = await fs.readFile(OUTPUT_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed.products)) {
      return parsed.products;
    }
  } catch {
    // Chưa có file cũ hoặc file cũ không hợp lệ.
  }

  return [];
}

async function main() {
  const oldProducts = await loadOldProducts();

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
    viewport: {
      width: 1440,
      height: 1200
    },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/131.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language':
        'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });

  const page = await context.newPage();

  page.on('response', async (response) => {
    const url = response.url();

    if (!url.includes('shopee.vn/api/')) {
      return;
    }

    const contentType =
      response.headers()['content-type'] || '';

    if (!contentType.includes('application/json')) {
      return;
    }

    const interesting =
      url.includes('/homepage/get_daily_discover') ||
      url.includes('/recommend/recommend') ||
      url.includes('/flash_sale/flash_sale_get_items') ||
      url.includes('/homepage/campaign_modules') ||
      url.includes('/homepage/mall_shops');

    if (!interesting) {
      return;
    }

    try {
      const json = await response.json();

      debugResponses.push({
        status: response.status(),
        url,
        captured_at: new Date().toISOString()
      });

      let source = 'shopee_homepage_api';

      if (url.includes('/homepage/get_daily_discover')) {
        source = 'daily_discover';

        if (!dailyDiscoverSaved) {
          dailyDiscoverSaved = true;
          await saveJson(RAW_DAILY_FILE, json);
        }
      }

      if (url.includes('/flash_sale/flash_sale_get_items')) {
        source = 'flash_sale';

        if (!flashSaleSaved) {
          flashSaleSaved = true;
          await saveJson(RAW_FLASH_FILE, json);
        }
      }

      if (url.includes('/recommend/recommend')) {
        source = 'top_products_homepage';
      }

      walkJson(json, source);

      console.log(
        `Đã bắt ${source}: hiện có ${collectedProducts.size} sản phẩm`
      );
    } catch (error) {
      console.warn(
        `Không đọc được JSON từ ${url}: ${error.message}`
      );
    }
  });

  try {
    const navigation = await page.goto(SHOPEE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    console.log(
      `Trang chủ trả HTTP ${navigation?.status() || 'không rõ'}`
    );

    /*
     * Chờ API trang chủ tự chạy.
     * Không cần đăng nhập, không cần scrape giao diện.
     */
    const startedAt = Date.now();

    while (
      Date.now() - startedAt < RESPONSE_WAIT_MS &&
      collectedProducts.size < MAX_PRODUCTS
    ) {
      await page.waitForTimeout(1000);

      console.log(
        `Đang chờ API: ${collectedProducts.size}/${MAX_PRODUCTS} sản phẩm`
      );
    }
  } finally {
    await saveJson(DEBUG_FILE, debugResponses);
    await browser.close();
  }

  const products = [...collectedProducts.values()]
    .sort((a, b) => {
      const soldDifference =
        toNumber(b.sold) - toNumber(a.sold);

      if (soldDifference !== 0) {
        return soldDifference;
      }

      return productScore(b) - productScore(a);
    })
    .slice(0, MAX_PRODUCTS)
    .map((product, index) => ({
      ...product,
      position: index + 1
    }));

  if (!products.length) {
    console.error(
      'Không lấy được sản phẩm mới. Giữ nguyên products.json cũ.'
    );

    if (!oldProducts.length) {
      throw new Error(
        'Không lấy được dữ liệu và chưa có products.json cũ. ' +
        'Hãy tải artifact debug để kiểm tra daily_discover.json.'
      );
    }

    return;
  }

  const output = {
    success: true,
    source: SHOPEE_URL,
    source_type: 'shopee_homepage_api',
    count: products.length,
    updated_at: new Date().toISOString(),
    products
  };

  await saveJson(OUTPUT_FILE, output);

  console.log(
    `Hoàn tất: đã lưu ${products.length} sản phẩm vào ${OUTPUT_FILE}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
