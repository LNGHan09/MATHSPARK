# MathSpark — Kho chuyên đề patch

## Tính năng
- Student UI có một panel “Kho chuyên đề” riêng, tách khỏi “Kho đề luyện thi”.
- Chuyên đề được dùng chung luồng thi một câu mỗi màn hình, đồng hồ, nộp bài, nộp nhiều ảnh tự luận, chấm AI và lưu lịch sử.
- Admin có biểu mẫu tải PDF riêng và ô “Yêu cầu cho AI” để ghi số lượng trắc nghiệm/tự luận, chủ đề, độ khó, thứ tự câu và cách xử lý khi nguồn không đủ câu.
- AI được yêu cầu ưu tiên lọc/đánh máy từ PDF, gắn nhãn nguồn cho câu từ PDF và gắn nhãn `AI biên soạn` cho câu tự tạo để admin kiểm tra.
- Chuyên đề chỉ hiển thị với học sinh sau khi admin duyệt từng câu, bỏ cờ “Cần duyệt” và bấm “Duyệt và đăng”.

## Cách cập nhật
1. Trong Supabase Dashboard → SQL Editor, chạy `supabase/specialty-bank.sql` trên cơ sở dữ liệu đang chạy. Migration thêm `bank_type` và `ai_request`; các đề hiện hữu mặc định vẫn thuộc Kho đề luyện thi.
2. Đưa các file trong ZIP về đúng vị trí trong repo: `index.html`, `public/index.html`, `admin.html`, `public/admin.html`, `server.js`, `supabase/exam-bank.sql`, `supabase/specialty-bank.sql`.
3. Commit/push và chờ Render deploy hoàn tất.
4. Mở trang Admin, đăng nhập, tới mục “Kho chuyên đề”. Nhập tên, thời gian, PDF và yêu cầu AI rồi tải lên.
5. Trong danh sách chuyên đề, bấm “AI lọc theo yêu cầu”, duyệt/sửa câu hỏi; nhấn “Lưu bản nháp”; chỉ đăng khi đã kiểm tra nguồn, công thức, đáp án và bỏ chọn “Cần duyệt” cho từng câu.

## Ví dụ yêu cầu AI
“Tạo bài 15 câu gồm 12 câu trắc nghiệm A–D và 3 câu tự luận về giải toán bằng cách lập hệ phương trình. Ưu tiên lọc và đánh máy câu trong PDF, giữ nguyên dữ kiện và công thức. Nếu PDF không đủ câu phù hợp, tạo câu bổ sung cùng dạng và ghi rõ câu AI biên soạn. Sắp xếp từ cơ bản đến vận dụng, thời lượng khoảng 60 phút.”

Yêu cầu AI không thay thế bước kiểm duyệt: các câu mới do AI tạo vẫn cần được giáo viên/quản trị viên xem lại trước khi đăng.
