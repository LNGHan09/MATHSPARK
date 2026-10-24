# MathSpark OpenAI integration

This update connects the existing front-end `/api/ai/*` calls to OpenAI Responses API.

## Render Environment
- `OPENAI_API_KEY`: key created on OpenAI Platform.
- `OPENAI_MODEL`: optional; defaults to `gpt-6-luna`.

Do not commit API keys. `OPENAI_API_KEY` is only read server-side and is never returned from `/api/health`.

## Endpoints now implemented
- `POST /api/ai/chat`
- `POST /api/ai/search`
- `POST /api/ai/study-plan`
- `POST /api/ai/generate-questions`
- `POST /api/ai/grade-solution` (image uploads; up to 7 MB per image)

## Deploy
Copy `server.js`, `package.json`, `.env.example`, `README.md`, `index.html`, and `public/index.html` into the corresponding paths under `math-learn-ai-render-ready-root`, commit and push. Render runs `npm install` then `npm start`. Ensure Render uses Node 22 or newer.

AI responses are model-generated and need validation. Grading output is a suggested evaluation, not a substitute for the teacher's rubric. Basic per-IP rate limiting is in memory and resets when the server restarts; set OpenAI budget/usage limits as well.
