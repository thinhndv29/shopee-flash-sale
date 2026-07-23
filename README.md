# Shopee Flash Sale → products.json

## Cài nhanh

1. Tạo repository GitHub Public.
2. Upload toàn bộ file và giữ đúng thư mục `.github/workflows/update.yml`.
3. Mở tab Actions.
4. Chọn `Cập nhật Shopee Flash Sale`.
5. Chọn `Run workflow`.
6. Chờ chạy xong rồi kiểm tra file `products.json`.

## Bật GitHub Pages

Vào:

Settings → Pages → Build and deployment

Chọn:

- Source: Deploy from a branch
- Branch: main
- Folder: /(root)

URL JSON:

https://TEN-GITHUB.github.io/TEN-REPOSITORY/products.json

## Tần suất

Workflow dùng:

17 */2 * * *

Nghĩa là khoảng phút 17, cách 2 tiếng chạy một lần theo UTC.
GitHub có thể chạy trễ vài phút khi hệ thống đông.

## Khi lỗi

Mở:

Actions → lần chạy bị lỗi → Artifacts → shopee-debug

Trong đó có:

- debug-shopee.png
- debug-responses.json

Nếu ảnh là CAPTCHA, Access Denied hoặc trang xác minh thì IP GitHub Actions đã bị Shopee chặn.
