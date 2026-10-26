# MathSpark — Supabase Edition

This project connects MathSpark to Supabase for student accounts, personal learning data, and durable public learning-document storage.

## 1. Create the Supabase resources

1. Create a project at https://supabase.com/.
2. Open **SQL Editor → New query**.
3. Paste all of `supabase/setup.sql` and run it. This creates the profile/state/document tables, per-student RLS policies, new-user trigger, and the public-read `mathspark-documents` storage bucket.
4. In **Authentication → URL Configuration**, set Site URL to `https://mathspark.onrender.com` and add `https://mathspark.onrender.com/` to Redirect URLs. Email confirmation may be enabled; then a student must confirm their email before signing in.
5. In **Project Settings → API Keys** (or the project's Connect/API panel), copy the Project URL, the publishable key (or legacy anon key), and the server secret/service-role key.

## 2. Set Render environment variables

Open Render Dashboard → the MathSpark Web Service → **Environment** and add:

- `SUPABASE_URL` = the Supabase Project URL.
- `SUPABASE_ANON_KEY` = the Supabase publishable key (`sb_publishable_...`) or legacy anon key. This key is public by design and is delivered through `/api/config` for Auth.
- `SUPABASE_SERVICE_ROLE_KEY` = the server-side secret/service_role key. **Never put this value in HTML, commit it to GitHub, or share it in chat.**
- `SUPABASE_STORAGE_BUCKET` = `mathspark-documents`.
- Keep the existing `ADMIN_PASSWORD` environment variable.

Save and redeploy the Render service.

## 3. Publish code to GitHub

The Render Root Directory should remain `math-learn-ai-render-ready-root`, because `package.json` and `server.js` are in that directory. Replace the files in that directory with the files from this project, preserving its directory structure. Commit to `main`; Render should redeploy when auto-deploy is enabled.

Build command: `npm install`
Start command: `npm start`

## 4. Test

- Visit `https://mathspark.onrender.com/api/health`. It should show `supabaseAuthConfigured: true` and `supabaseStorageConfigured: true` after variables are configured.
- Visit `https://mathspark.onrender.com/`, click **Tài khoản**, register a student account, confirm email if required, then log in.
- Change the target score or mark calendar busy slots. The app saves state locally and debounces an upsert to `student_learning_state`. Reopen on another device and sign in to check sync.
- Visit `/admin.html`, log in using `ADMIN_PASSWORD`, upload a small test PDF, and confirm it appears on the student home screen and opens in the in-page reader.

## Data model

- `student_profiles`: display name and profile metadata, tied to `auth.users`.
- `student_learning_state`: JSON payload for schedule, goals, diagnostic result, quiz/progress state. RLS restricts each account to its own row.
- `learning_documents`: Admin-managed document metadata. The server uses a secret key; the browser cannot mutate this table directly.
- Storage bucket `mathspark-documents`: public-read because Admin-uploaded educational materials are intended for all students; writes/deletes are performed by the server only.

## Existing files

The app now stores new Admin files in Supabase Storage rather than Render's temporary filesystem. Existing files on Render are not guaranteed to remain available after redeploy. If old uploads still exist on the running instance, server startup attempts a best-effort migration when the Supabase `learning_documents` table is empty; verify the list after deployment. Re-upload any missing documents through Admin.

## Security notes

- `.env` must remain untracked. Do not commit secrets.
- Browser uses only the publishable/anon key and user sessions; the service key remains in Render's Environment.
- The SQL uses Row Level Security for student data. Do not remove those policies.
- Public bucket means someone with a document URL can access that educational document. Do not put private student work or personal records in this bucket.
- The existing Admin login is still controlled by the server-side `ADMIN_PASSWORD` setting. Set a long unique password in Render.

## Scope note

The account setup saves the current client-side learning state for each signed-in student. OpenAI-backed AI chat, question generation, semantic search, study-plan suggestions, and image-based solution grading use OPENAI_API_KEY (default model: gpt-6-luna). Keep the key in Render Environment; never put it in HTML or GitHub.


## Kho đề luyện thi AI

1. Chạy `supabase/exam-bank.sql` một lần trong Supabase SQL Editor để tạo các bảng `learning_exams` và `exam_attempts`.
2. Mở `/admin.html`, đăng nhập bằng `ADMIN_PASSWORD`, tải PDF ở mục **Kho đề luyện thi · AI tách câu**.
3. Nhấn **AI phân tích PDF**. AI trích câu hỏi, lựa chọn, đáp án đề xuất, lời giải/rubric, số trang và vùng hình dự kiến.
4. Bắt buộc đọc lại và sửa các câu đã đánh dấu **Cần duyệt**. Công thức, đáp án và crop hình AI tạo ra có thể sai; chỉ bấm “Duyệt và đăng đề” sau khi đã kiểm tra.
5. Học sinh mở **Luyện thi → Kho đề luyện thi**, làm từng câu, nộp lựa chọn A–D hoặc ảnh lời giải cho câu tự luận. Trắc nghiệm được chấm bằng answer key phía máy chủ; tự luận được AI chấm riêng từng câu. Nếu đã đăng nhập, kết quả được lưu vào `exam_attempts`.

Việc phân tích PDF và chấm tự luận sử dụng OpenAI API token. Nên tải PDF rõ nét, chia đề dài thành nhiều file nhỏ khi cần. Bản hiện tại nhận PDF (tối đa 20 MB), không tự publish sau khi phân tích; admin phải duyệt trước khi học sinh nhìn thấy.
