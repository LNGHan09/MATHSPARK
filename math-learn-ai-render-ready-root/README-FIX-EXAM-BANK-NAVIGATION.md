# MathSpark — Fix Exam Bank Navigation

## Lỗi đã sửa

Sau khi làm một chuyên đề và bấm **Quay về kho đề**, code cũ chỉ hiện kho cuối cùng đã mở và thêm `hidden` vào kho còn lại. Khi người dùng đi về Trang chủ rồi trở lại Luyện thi, lớp `hidden` vẫn còn nên Kho đề luyện thi biến mất.

Bản vá đổi `showActiveExamBank()` để khi quay lại danh sách sẽ:
- ẩn màn hình làm bài và kết quả cũ;
- hiện đồng thời **Kho đề luyện thi** và **Kho chuyên đề**;
- render lại cả hai danh sách;
- cuộn về đầu khu vực Kho đề.

Ngoài ra, khi chuyển từ trang khác quay lại **Luyện thi**, nếu không còn bài thi đang chạy, cả hai kho được mở lại. Không thay đổi API, database hay dữ liệu đề.

## Cách áp dụng

1. Giải nén ZIP vào thư mục gốc repository MathSpark.
2. Ghi đè `index.html` và `public/index.html` theo đúng đường dẫn trong ZIP.
3. Commit/push để Render triển khai lại.

Không cần chạy SQL.
