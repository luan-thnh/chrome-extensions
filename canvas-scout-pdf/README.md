# CANVORA — Canvas to PDF Chrome Extension

> v1.2.0: PDF export now defaults to **Exact Canvas**: direct JPEG 95% capture + jsPDF-compatible `px_scaling` density (1 px = 0.75 pt).

Canvora là Chrome Extension Manifest V3 để nhận diện các trang tài liệu đã được render trong website và gom chúng thành PDF nhiều trang. Extension xử lý **local-first**: ảnh canvas không được upload lên server.

## Cài đặt

1. Giải nén thư mục `canvas-scout-pdf`.
2. Mở `chrome://extensions`.
3. Bật **Developer mode**.
4. Chọn **Load unpacked** và chọn thư mục này.
5. Pin **Canvora** lên toolbar.
6. Mở trang chứa PDF/canvas rồi bấm icon Canvora.

Bạn có thể mở `demo/index.html` để test trực tiếp case giống đoạn HTML `#pdfframe` với 32 canvas 950×734.

## Những case Canvora nhận diện

- Canvas page thông thường, không cần selector cố định.
- `#pdfframe canvas` và viewer có nhiều canvas cùng kích thước.
- PDF.js (`.pdfViewer`, `#viewerContainer`, `.page canvas`).
- React-PDF (`.react-pdf__Page__canvas`).
- Viewer tương tự PSPDFKit / Apryse WebViewer dựa trên heuristic DOM.
- `<embed type="application/pdf">`, `<object type="application/pdf">`, iframe/source URL `.pdf`.
- Canvas nằm trong **open Shadow DOM**.
- Viewer lazy-render / virtualized: **Lazy-page sweep** tự tìm scroll container phù hợp, cuộn từng đoạn, snapshot page rồi khôi phục vị trí cũ.
- Viewer render page bằng `<img>` hoặc SVG lớn: bật **Include image/SVG pages**.
- Page number từ `data-page-number`, `data-page`, `data-index`, `aria-label="Page N"`, id dạng page/trang/slide/sheet.

## Tính năng

- Smart filter loại icon/chart canvas nhỏ.
- Deep Scan: chỉ khi bật mới xin quyền `<all_urls>` để inject vào iframe khác domain.
- Xuất PDF theo kích thước nguồn hoặc A4 fit.
- **Exact Canvas (mặc định):** với canvas và Trim tắt, gọi trực tiếp `canvas.toDataURL("image/jpeg", 0.95)` và dùng mật độ trang 0.75 pt/px — cùng logic chất lượng với snippet jsPDF đã kiểm chứng.
- **Lossless PNG:** nhúng bitmap RGB lossless bằng Flate, vẫn dùng đúng mật độ 0.75 pt/px.
- **JPEG custom:** file nhỏ hơn, quality 80–100%.
- Page range: `1-5, 8, 10-`.
- Reverse order.
- JPEG quality 80–100% (chỉ ảnh hưởng `JPEG custom`; Exact Canvas cố định 95% để khớp snippet console).
- Trim white edges tùy chọn.
- Xuất từng page thành ZIP JPEG/PNG.
- Nếu tìm thấy URL PDF gốc HTTP(S), có nút **Original PDF**.
- Không dùng CDN/runtime dependency; PDF và ZIP được tạo bằng code local trong extension.

## Quyền

- `activeTab`: truy cập tạm thời tab khi bạn bấm extension.
- `scripting`: inject bộ detector/capture vào tab.
- `storage`: nhớ tùy chọn UI.
- `downloads`: lưu PDF/ZIP.
- `<all_urls>` là **optional host permission**, chỉ được hỏi khi bạn bật Deep Scan.

## Giới hạn hợp lý

- Chrome không cho extension inject vào `chrome://...` và trang extension nội bộ khác.
- **Closed Shadow DOM** không thể duyệt sau khi trang đã tạo nó.
- Canvas bị **tainted** bởi ảnh cross-origin không CORS sẽ chặn `toDataURL/getImageData`; Canvora báo và bỏ qua surface đó chứ không bypass bảo mật trình duyệt.
- Viewer DRM/protected content hoặc cơ chế chống capture không được bypass.
- Với virtualized viewer không có page number và tái sử dụng cùng một canvas, Canvora dùng fingerprint ảnh để giảm trùng lặp; hai trang hoàn toàn giống nhau có thể bị gộp trong trường hợp hiếm.

## Dev check

```bash
npm test
npm run check
```

## Logo

Logo kết hợp **tờ giấy gập góc + scan beam**. Dải lime chạy xuyên tài liệu biểu thị việc “đọc bề mặt render” thay vì phụ thuộc vào cấu trúc viewer cụ thể. `icons/logo.svg` là bản vector; PNG 16/32/48/128 dùng cho Chrome toolbar/store preview.


## v1.2.0 — Exact Canvas quality fix

- Default PDF mode is **Exact Canvas**, matching the known-good console pipeline: direct `canvas.toDataURL("image/jpeg", 0.95)` with no intermediate canvas when trim is off.
- Source-size PDF pages now use the same pixel scaling semantics as jsPDF `unit: "px"` + `hotfixes: ["px_scaling"]`: **1 px = 0.75 pt**.
- This prevents PDF viewers from upscaling a 950px canvas to about 1267 CSS px at 100% zoom.
- Lossless PNG mode also uses the corrected pixel density.
- Keep **Trim white edges** off when you want byte/pixel flow closest to the console snippet.
