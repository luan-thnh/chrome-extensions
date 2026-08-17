# Zalo Audio ZIP Exporter

Chrome Extension Manifest V3 dùng để quét các URL dạng
`blob:https://chat.zalo.me/...` trong tab Zalo Web, nghe thử từng đoạn ghi âm,
chọn file cần tải và đóng gói thành một file ZIP.

## Tính năng

- Quét audio blob đang được Zalo render.
- Nghe preview ngay trong bảng nổi.
- Tick chọn hoặc bỏ chọn từng audio.
- Chọn tất cả và bỏ chọn tất cả.
- ZIP chỉ chứa các audio đã được chọn.
- Không dùng MutationObserver và không tải mã JavaScript từ CDN.

## Cài đặt

1. Giải nén thư mục extension.
2. Mở `chrome://extensions/`.
3. Bật **Chế độ dành cho nhà phát triển / Developer mode**.
4. Chọn **Tải tiện ích đã giải nén / Load unpacked**.
5. Chọn thư mục `zalo-audio-zip-extension`.

Nếu đã cài bản cũ, bấm **Reload** ở thẻ extension và tải lại tab Zalo một lần.

## Sử dụng

1. Mở `https://chat.zalo.me/` và vào đúng cuộc trò chuyện.
2. Cuộn qua các tin nhắn thoại cần tải. Có thể bấm phát một lần nếu blob chưa được Zalo tạo.
3. Bấm biểu tượng extension rồi chọn **Mở bảng tải audio**.
4. Bấm **Quét audio**. Tiếp tục cuộn và quét lại để thu thập thêm.
5. Bấm nút **▶** cạnh audio để nghe thử.
6. Tick các file cần tải hoặc dùng **Chọn tất cả / Bỏ chọn**.
7. Bấm **Tải ZIP**.

## Lưu ý

- Zalo có thể chỉ giữ các tin nhắn gần vùng hiển thị trong DOM, nên cần cuộn và quét nhiều lần.
- URL `blob:` chỉ có hiệu lực trong tab và phiên hiện tại. Nếu tải lại trang, cần quét lại.
- Extension không gửi audio ra máy chủ khác.
- Chỉ sử dụng với nội dung bạn sở hữu hoặc được phép tải xuống.
