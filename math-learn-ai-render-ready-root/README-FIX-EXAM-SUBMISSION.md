# MathSpark – Fix lỗi nộp bài tự luận (JSON/LaTeX)

## Lỗi được sửa

Khi AI chấm ảnh tự luận, model đôi lúc trả về JSON chứa LaTeX với dấu `\\` chưa escape đúng, làm `JSON.parse` phát sinh `Bad escaped character`. Phiên bản này sửa parser để khôi phục các dấu gạch chéo ngược của LaTeX và thêm cơ chế dự phòng: nếu phản hồi AI vẫn không phải JSON hợp lệ, hệ thống vẫn nhận và lưu bài, chấm phần trắc nghiệm, đánh dấu các câu tự luận cần chấm lại/giáo viên kiểm tra, thay vì từ chối cả bài và bắt học sinh gửi lại ảnh.

## Cách áp dụng

1. Giải nén ZIP vào thư mục gốc của repository MathSpark.
2. Ghi đè file `server.js` bằng file trong ZIP.
3. Commit/push lên GitHub để Render deploy bản mới.
4. Nếu trang thi đang mở và bài chưa nộp được, **đừng đóng tab hoặc tải lại trang**. Đợi Render deploy xong rồi bấm **Nộp bài** lại trên tab đang mở. Ảnh đã chọn được giữ trong bộ nhớ trang cho đến khi reload/đóng tab.

Không cần chạy SQL migration cho bản vá này. Không có bảng nào bị xóa hay thay đổi.

## Kiểm tra

- `node --check server.js` đã qua.
- Đã thử parser với JSON có LaTeX `\\frac`, `\\sqrt`, `\\(` và `\\begin`.
- Nếu AI vẫn trả dữ liệu không thể đọc, bài vẫn được nhận; câu tự luận được gắn trạng thái cần xem lại thay vì làm mất bài.
