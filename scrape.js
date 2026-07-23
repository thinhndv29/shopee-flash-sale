import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const PAGE_URL = 'https://shopee.vn/flash_sale';
const OUTPUT_FILE = 'products.json';
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

  // API Shopee thường lưu giá theo đơn vị 1/100000 đồng.
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

  if (/^https?:\/\//i.test(image)) return image;

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

function addCandidate(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;

  const itemId = numberValue(
    first(node.itemid, node.item_id, node.itemId, node.product_id)
  );

  const shopId = numberValue(
    first(node.shopid, node.shop_id, node.shopId, node.seller_id)
  );

  const name = String(
    first(node.name, node.title, node.item_name, node.product_name) || ''
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

  const productUrl = `https://shopee.vn/product/${shopId}/${itemId}`;

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
    discount: discountNumber ? `${Math.round(discountNumber)}%` : '',
    sold: sold || '',
    reviews: reviews || '',
    image,
    product_url: productUrl,
    cashback_url:
      CASHBACK_BASE + encodeURIComponent(productUrl),
    updated_at: new Date().toISOString()
  };

  const existing = products.get(productUrl);

  // Ưu tiên object chứa nhiều dữ liệu hơn.
  const score = (item) =>
    [
      item.sale_price,
      item.original_price,
      item.discount,
      item.sold,
      item.reviews
    ].filter(Boolean).length;

  if (!existing || score(product) > score(existing)) {
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

  page.on('response', async (response) => {
    const url = response.url();

    if (
      !/shopee\.vn/i.test(url) ||
      !/(flash_sale|batch_get_items|recommend|item)/i.test(url)
    ) {
      return;
    }

    const contentType =
      response.headers()['content-type'] || '';

    if (!contentType.includes('application/json')) return;

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
      `Trang chính trả HTTP ${response?.status() || 'không rõ'}`
    );

    await page.waitForTimeout(10000);

    // Cuộn để kích hoạt các danh sách lazy-load.
    for (let i = 0; i < 8; i += 1) {
      await page.mouse.wheel(0, 1100);
      await page.waitForTimeout(1300);
    }

    // Fallback: lấy các link sản phẩm có sẵn trong DOM.
    const domProducts = await page.evaluate(() => {
      const results = [];

      for (const anchor of document.querySelectorAll('a[href]')) {
        const href = anchor.href || '';
        const match = href.match(
          /(?:\/product\/(\d+)\/(\d+)|-i\.(\d+)\.(\d+))/
        );

        if (!match) continue;

        const shopId = match[1] || match[3];
        const itemId = match[2] || match[4];
        const image = anchor.querySelector('img');
        const name =
          image?.alt ||
          anchor.getAttribute('aria-label') ||
          anchor.textContent?.trim() ||
          '';

        if (!shopId || !itemId || !image?.src || !name) continue;

        results.push({
          itemid: Number(itemId),
          shopid: Number(shopId),
          name: name.slice(0, 300),
          image_url: image.src
        });
      }

      return results;
    });

    domProducts.forEach(addCandidate);

    await page.screenshot({
      path: 'debug-shopee.png',
      fullPage: false
    });
  } finally {
    await browser.close();
  }

  let finalProducts = [...products.values()]
    .slice(0, MAX_PRODUCTS)
    .map((product, index) => ({
      ...product,
      position: index + 1
    }));

  // Không ghi đè file đang hoạt động bằng danh sách rỗng.
  if (!finalProducts.length) {
    console.error(
      'Không lấy được sản phẩm mới. Giữ nguyên products.json cũ.'
    );

    await fs.writeFile(
      'debug-responses.json',
      JSON.stringify(debugResponses, null, 2),
      'utf8'
    );

    if (!oldProducts.length) {
      throw new Error(
        'Lần chạy đầu không lấy được sản phẩm. ' +
        'Mở artifact debug-shopee để xem Shopee có chặn hay không.'
      );
    }

    return;
  }

  const output = {
    success: true,
    source: PAGE_URL,
    count: finalProducts.length,
    updated_at: new Date().toISOString(),
    products: finalProducts
  };

  await fs.writeFile(
    OUTPUT_FILE,
    JSON.stringify(output, null, 2),
    'utf8'
  );

  await fs.writeFile(
    'debug-responses.json',
    JSON.stringify(debugResponses, null, 2),
    'utf8'
  );

  console.log(`Đã lưu ${finalProducts.length} sản phẩm.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
