import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const PAGE_URL = 'https://shopee.vn/';
const OUTPUT_FILE = 'products.json';
const DEBUG_RESPONSES_FILE = 'debug-responses.json';
const DEBUG_SCREENSHOT_FILE = 'debug-shopee.png';

const MAX_PRODUCTS = Number(process.env.MAX_PRODUCTS || 60);
const CASHBACK_BASE =
  process.env.CASHBACK_BASE ||
  'https://hoantien360.com/?url_hoan_tien=';

const products = new Map();
const debugResponses = [];

function first(...values) {
  return values.find(
    (value) => value !== undefined && value !== null && value !== ''
  );
}

function numberValue(value) {
  if (value === undefined || value === null || value === '') return 0;

  if (Array.isArray(value)) {
    return numberValue(value[0]);
  }

  const number = Number(String(value).replace(/[^\d.-]/g, ''));

  return Number.isFinite(number) ? number : 0;
}

function normalizePrice(value) {
  let number = numberValue(value);

  if (!number) return 0;

  // API Shopee thường lưu giá x100000.
  if (number >= 100000) {
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
      value.image_id,
      value.image
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

function walk(value, callback, depth = 0) {
  if (depth > 40 || value === null || value === undefined) return;

  callback(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, callback, depth + 1);
    }

    return;
  }

  if (typeof value === 'object') {
    for (const child of Object.values(value)) {
      walk(child, callback, depth + 1);
    }
  }
}

function scoreProduct(item) {
  return [
    item.sale_price,
    item.original_price,
    item.discount,
    item.sold,
    item.reviews
  ].filter(Boolean).length;
}

function addCandidate(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;

  const itemId = numberValue(
    first(
      node.itemid,
      node.item_id,
      node.itemId,
      node.product_id
    )
  );

  const shopId = numberValue(
    first(
      node.shopid,
      node.shop_id,
      node.shopId,
      node.seller_id
    )
  );

  const name = String(
    first(
      node.name,
      node.title,
      node.item_name,
      node.product_name
    ) || ''
  ).trim();

  const image = normalizeImage(
    first(
      node.image,
      node.image_url,
      node.imageUrl,
      node.thumbnail,
      node.cover,
      node.image_info
    )
  );

  if (!itemId || !shopId || !name || !image) return;

  const productUrl =
    `https://shopee.vn/product/${shopId}/${itemId}`;

  const salePrice = normalizePrice(
    first(
      node.flash_sale_price,
      node.promo_price,
      node.price,
      node.price_min,
      node.current_price,
      node.sale_price
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

  const discountNumber = numberValue(
    first(
      node.raw_discount,
      node.show_discount,
      node.discount,
      node.discount_percent
    )
  );

  const sold = numberValue(
    first(
      node.historical_sold,
      node.sold,
      node.sold_count,
      node.items_sold
    )
  );

  let reviews = numberValue(
    first(
      node.rating_count,
      node.review_count,
      node.cmt_count
    )
  );

  if (!reviews && node.item_rating) {
    reviews = numberValue(
      first(
        node.item_rating.rating_count,
        node.item_rating.review_count
      )
    );
  }

  const product = {
    position: 0,
    name,
    original_price: originalPrice || '',
    sale_price: salePrice || '',
    discount: discountNumber
      ? `${Math.round(discountNumber)}%`
      : '',
    sold: sold || '',
    reviews: reviews || '',
    image,
    product_url: productUrl,
    cashback_url:
      CASHBACK_BASE + encodeURIComponent(productUrl),
    source: 'shopee_homepage',
    updated_at: new Date().toISOString()
  };

  const existing = products.get(productUrl);

  if (!existing || scoreProduct(product) > scoreProduct(existing)) {
    products.set(productUrl, product);
  }
}

async function readOldProducts() {
  try {
    const content = await fs.readFile(OUTPUT_FILE, 'utf8');
    const parsed = JSON.parse(content);

    return Array.isArray(parsed.products)
      ? parsed.products
      : [];
  } catch {
    return [];
  }
}

async function collectDomProducts(page) {
  const domProducts = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    const anchors = [
      ...document.querySelectorAll('a[href]')
    ];

    for (const anchor of anchors) {
      const href = anchor.href || '';

      const match = href.match(
        /(?:\/product\/(\d+)\/(\d+)|-i\.(\d+)\.(\d+))/
      );

      if (!match) continue;

      const shopId = match[1] || match[3];
      const itemId = match[2] || match[4];
      const key = `${shopId}:${itemId}`;

      if (seen.has(key)) continue;

      const image = anchor.querySelector('img');

      const textCandidates = [
        image?.alt,
        anchor.getAttribute('aria-label'),
        anchor.getAttribute('title'),
        anchor.textContent
      ]
        .filter(Boolean)
        .map((value) =>
          String(value).replace(/\s+/g, ' ').trim()
        )
        .filter(Boolean);

      const name =
        textCandidates.sort(
          (a, b) => b.length - a.length
        )[0] || '';

      const imageUrl =
        image?.src ||
        image?.getAttribute('data-src') ||
        image?.getAttribute('srcset')?.split(' ')[0] ||
        '';

      if (!shopId || !itemId || !name || !imageUrl) continue;

      seen.add(key);

      results.push({
        itemid: Number(itemId),
        shopid: Number(shopId),
        name: name.slice(0, 300),
        image_url: imageUrl
      });
    }

    return results;
  });

  domProducts.forEach(addCandidate);

  return domProducts.length;
}

async function main() {
  const oldProducts = await readOldProducts();

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
      height: 1400
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

    if (!/shopee\.vn/i.test(url)) return;

    const contentType =
      response.headers()['content-type'] || '';

    if (!contentType.includes('application/json')) return;

    if (
      !/(recommend|homepage|mall|item|search|flash_sale|daily_discover)/i.test(url)
    ) {
      return;
    }

    try {
      const json = await response.json();

      debugResponses.push({
        status: response.status(),
        url
      });

      walk(json, addCandidate);
    } catch {
      // Bỏ qua response không đọc được.
    }
  });

  try {
    const response = await page.goto(PAGE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    console.log(
      `Trang chủ trả HTTP ${response?.status() || 'không rõ'}`
    );

    await page.waitForTimeout(8000);

    // Đóng popup nếu có.
    const closeSelectors = [
      'button[aria-label="Close"]',
      'button[aria-label="Đóng"]',
      '[class*="close"]',
      'svg[data-testid="close"]'
    ];

    for (const selector of closeSelectors) {
      try {
        const element = page.locator(selector).first();

        if (await element.isVisible({ timeout: 800 })) {
          await element.click({ timeout: 1500 });
          break;
        }
      } catch {
        // Không có popup.
      }
    }

    await collectDomProducts(page);

    // Cuộn trang chủ nhiều lần để kích hoạt lazy-load.
    for (let i = 0; i < 18; i += 1) {
      await page.mouse.wheel(0, 1000);
      await page.waitForTimeout(1100);

      const count = await collectDomProducts(page);

      console.log(
        `Lần cuộn ${i + 1}: DOM thấy ${count} link sản phẩm, ` +
        `đã gom ${products.size} sản phẩm.`
      );

      if (products.size >= MAX_PRODUCTS) {
        break;
      }
    }

    await page.screenshot({
      path: DEBUG_SCREENSHOT_FILE,
      fullPage: false
    });
  } finally {
    await browser.close();
  }

  const finalProducts = [...products.values()]
    .filter((product) => product.name && product.image)
    .slice(0, MAX_PRODUCTS)
    .map((product, index) => ({
      ...product,
      position: index + 1
    }));

  await fs.writeFile(
    DEBUG_RESPONSES_FILE,
    JSON.stringify(debugResponses, null, 2),
    'utf8'
  );

  if (!finalProducts.length) {
    console.error(
      'Không lấy được sản phẩm mới từ trang chủ. ' +
      'Giữ nguyên products.json cũ.'
    );

    if (!oldProducts.length) {
      throw new Error(
        'Lần chạy đầu không lấy được sản phẩm. ' +
        'Tải artifact shopee-debug để xem trang chủ.'
      );
    }

    return;
  }

  const output = {
    success: true,
    source: PAGE_URL,
    source_type: 'homepage_products',
    count: finalProducts.length,
    updated_at: new Date().toISOString(),
    products: finalProducts
  };

  await fs.writeFile(
    OUTPUT_FILE,
    JSON.stringify(output, null, 2),
    'utf8'
  );

  console.log(
    `Đã lưu ${finalProducts.length} sản phẩm từ trang chủ Shopee.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
