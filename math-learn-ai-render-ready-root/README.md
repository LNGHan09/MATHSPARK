# math.learn.vn — Website ôn thi Toán 9 + Admin

Dự án gồm giao diện học sinh, trang quản trị và máy chủ Node.js/Express.

## Chạy thử trên máy tính

1. Cài Node.js LTS.
2. Mở Terminal tại thư mục dự án và chạy `npm install`.
3. Sao chép `.env.example` thành `.env`.
4. Trong `.env`, đặt `ADMIN_PASSWORD` thành mật khẩu riêng, khó đoán. Không đưa tệp `.env` lên GitHub.
5. Chạy `npm start`.
6. Mở website học sinh tại `http://localhost:3000` và Admin tại `http://localhost:3000/admin.html`.

## Đưa mã nguồn lên GitHub

- Tải ZIP dự án, giải nén và đưa **các nội dung bên trong thư mục `math-learn-ai`** vào repository.
- Giữ lại `.gitignore` và `.env.example`.
- Không commit `.env`, mật khẩu, API key, tài liệu cá nhân của học sinh hoặc tệp đã tải lên ở `uploads/`.

## Lưu ý khi triển khai trực tuyến

GitHub repository dùng để lưu và quản lý mã nguồn. GitHub Pages chỉ phù hợp cho website tĩnh; dự án này có `server.js` dùng Node.js/Express, API Admin và upload tệp nên cần triển khai máy chủ Node.js riêng.

Máy chủ lưu danh sách tại `data/documents.json` và tệp tải lên tại `uploads/` khi chạy cục bộ. Trên hosting hỗ trợ ổ đĩa bền vững, gắn ổ đĩa tại `/var/data` và đặt biến môi trường `STORAGE_DIR=/var/data`. Khi đó cả dữ liệu danh sách lẫn tệp tải lên được lưu dưới `/var/data`. Nếu không cấu hình lưu trữ bền vững, dữ liệu trên ổ đĩa tạm có thể mất khi khởi động lại hoặc deploy.

Thiết lập biến môi trường `ADMIN_PASSWORD` trên hosting. Chỉ thiết lập `GEMINI_API_KEY` nếu cần tích hợp AI, và không bao giờ ghi các bí mật này trực tiếp vào mã nguồn.

## Chức năng trong bản này

- Admin thêm/sửa/xóa tài liệu.
- Danh sách tài liệu nhận thông báo cập nhật trực tiếp qua Server-Sent Events.
- Giao diện học sinh hiển thị khu vực Đề và tài liệu.
- Các endpoint AI trong bản này vẫn là placeholder, chưa thực hiện chấm bài/gọi Gemini thật.
